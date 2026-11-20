//! Captura do monitor com Windows Graphics Capture (GPU) e envio dos quadros ao LiveKit.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::Arc;

use crate::hwenc::Nv12Frame;
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

/// Para onde vão os quadros capturados.
pub enum Sink {
    /// Codificação por software no libwebrtc (VP8/VP9/H.264/AV1)
    Raw(NativeVideoSource),
    /// Codificação na placa de vídeo (NV12 -> Media Foundation), num tamanho fixo
    Hardware { sender: SyncSender<Nv12Frame>, width: u32, height: u32 },
}

/// Tamanho final dos quadros pra um monitor, respeitando o limite pedido.
pub fn output_size(monitor_index: usize, max_width: u32, max_height: u32) -> (u32, u32) {
    let monitor = if monitor_index == 0 { Monitor::primary() } else { Monitor::from_index(monitor_index) };
    match monitor {
        Ok(m) => fit(m.width().unwrap_or(max_width), m.height().unwrap_or(max_height), max_width, max_height),
        Err(_) => (max_width & !1, max_height & !1),
    }
}

pub struct Flags {
    pub sink: Sink,
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
        let (out_w, out_h) = fit(width, height, self.flags.max_width, self.flags.max_height);
        let timestamp_us = self.started.elapsed().as_micros() as i64;
        let mut buffer = frame.buffer()?;
        let pitch = buffer.row_pitch();
        let bgra = buffer.as_raw_buffer();

        // O codificador de hardware foi aberto num tamanho fixo: se a resolução do
        // monitor mudou no meio da live, descarta em vez de mandar quadro quebrado
        if let Sink::Hardware { width: hw_w, height: hw_h, .. } = &self.flags.sink {
            if (out_w, out_h) != (*hw_w, *hw_h) {
                return Ok(());
            }
        }

        // Placa de vídeo sem redimensionar: BGRA -> NV12 direto, uma conversão só
        if let Sink::Hardware { sender, .. } = &self.flags.sink {
            if (out_w, out_h) == (width, height) {
                let mut data = vec![0u8; (width * height * 3 / 2) as usize];
                let (y, uv) = data.split_at_mut((width * height) as usize);
                yuv_helper::argb_to_nv12(bgra, pitch, y, width, uv, width, width as i32, height as i32);
                let _ = sender.try_send(Nv12Frame { data, timestamp_us }); // cheio = codificador ocupado: descarta
                return Ok(());
            }
        }

        // BGRA (que o libyuv chama de "ARGB") -> I420 (+ redução, se o monitor for maior)
        let mut i420 = I420Buffer::new(width, height);
        let (stride_y, stride_u, stride_v) = i420.strides();
        let (y, u, v) = i420.data_mut();
        yuv_helper::argb_to_i420(
            bgra, pitch, y, stride_y, u, stride_u, v, stride_v, width as i32, height as i32,
        );
        let mut i420 = if (out_w, out_h) != (width, height) { i420.scale(out_w as i32, out_h as i32) } else { i420 };

        match &self.flags.sink {
            Sink::Raw(source) => {
                let video_frame = VideoFrame {
                    rotation: VideoRotation::VideoRotation0,
                    timestamp_us,
                    frame_metadata: None,
                    buffer: i420,
                };
                source.capture_frame(&video_frame);
            }
            Sink::Hardware { sender, .. } => {
                let (sy, su, sv) = i420.strides();
                let (y, u, v) = i420.data_mut();
                let mut data = vec![0u8; (out_w * out_h * 3 / 2) as usize];
                let (dy, duv) = data.split_at_mut((out_w * out_h) as usize);
                yuv_helper::i420_to_nv12(y, sy, u, su, v, sv, dy, out_w, duv, out_w, out_w as i32, out_h as i32);
                let _ = sender.try_send(Nv12Frame { data, timestamp_us });
            }
        }
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
