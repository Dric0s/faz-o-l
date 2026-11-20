//! Captura do monitor com Windows Graphics Capture (GPU) e envio dos quadros ao LiveKit.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use livekit::webrtc::native::yuv_helper;
use livekit::webrtc::prelude::{I420Buffer, VideoFrame, VideoRotation};
use livekit::webrtc::video_source::native::NativeVideoSource;
use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;
pub type Control = CaptureControl<ScreenHandler, BoxError>;

pub struct Flags {
    pub source: NativeVideoSource,
    pub stop: Arc<AtomicBool>,
    /// Resolução máxima enviada (o quadro é reduzido se o monitor for maior)
    pub max_width: u32,
    pub max_height: u32,
}

pub struct ScreenHandler {
    flags: Flags,
    started: Instant,
}

/// Maior tamanho (par) que cabe em max_w x max_h mantendo a proporção.
fn fit(w: u32, h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    if w <= max_w && h <= max_h {
        return (w & !1, h & !1);
    }
    let scale = f64::min(max_w as f64 / w as f64, max_h as f64 / h as f64);
    (((w as f64 * scale) as u32) & !1, ((h as f64 * scale) as u32) & !1)
}

impl GraphicsCaptureApiHandler for ScreenHandler {
    type Flags = Flags;
    type Error = BoxError;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self { flags: ctx.flags, started: Instant::now() })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if self.flags.stop.load(Ordering::Relaxed) {
            capture_control.stop();
            return Ok(());
        }

        let width = frame.width() & !1;
        let height = frame.height() & !1;
        let mut buffer = frame.buffer()?;
        let pitch = buffer.row_pitch();
        let bgra = buffer.as_raw_buffer();

        // BGRA (que o libyuv chama de "ARGB") -> I420
        let mut i420 = I420Buffer::new(width, height);
        let (stride_y, stride_u, stride_v) = i420.strides();
        let (y, u, v) = i420.data_mut();
        yuv_helper::argb_to_i420(
            bgra, pitch, y, stride_y, u, stride_u, v, stride_v, width as i32, height as i32,
        );

        let (out_w, out_h) = fit(width, height, self.flags.max_width, self.flags.max_height);
        let i420 = if (out_w, out_h) != (width, height) { i420.scale(out_w as i32, out_h as i32) } else { i420 };

        let video_frame = VideoFrame {
            rotation: VideoRotation::VideoRotation0,
            timestamp_us: self.started.elapsed().as_micros() as i64,
            frame_metadata: None,
            buffer: i420,
        };
        self.flags.source.capture_frame(&video_frame);
        Ok(())
    }
}

pub fn start(monitor_index: usize, fps: u32, flags: Flags) -> Result<Control, String> {
    let monitor = if monitor_index == 0 {
        Monitor::primary()
    } else {
        Monitor::from_index(monitor_index)
    }
    .map_err(|e| format!("Monitor não encontrado: {e}"))?;

    let interval = Duration::from_micros(1_000_000 / fps.max(1) as u64);
    let settings = Settings::new(
        monitor,
        CursorCaptureSettings::WithCursor,
        DrawBorderSettings::WithoutBorder,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Custom(interval),
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        flags,
    );
    ScreenHandler::start_free_threaded(settings).map_err(|e| format!("Falha ao iniciar a captura: {e}"))
}

#[derive(serde::Serialize)]
pub struct MonitorInfo {
    pub index: usize,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}

pub fn monitors() -> Result<Vec<MonitorInfo>, String> {
    let primary = Monitor::primary().ok().and_then(|m| m.index().ok());
    let list = Monitor::enumerate().map_err(|e| e.to_string())?;
    Ok(list
        .into_iter()
        .filter_map(|m| {
            let index = m.index().ok()?;
            Some(MonitorInfo {
                index,
                name: m.name().unwrap_or_else(|_| format!("Monitor {index}")),
                width: m.width().unwrap_or(0),
                height: m.height().unwrap_or(0),
                primary: Some(index) == primary,
            })
        })
        .collect())
}
