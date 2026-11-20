//! Sessão de transmissão: conecta no LiveKit com o token do servidor e publica
//! a tela (vídeo) e o áudio do sistema.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use livekit::options::{TrackPublishOptions, VideoCodec, VideoEncoding};
use livekit::prelude::*;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use livekit::webrtc::audio_source::{AudioSourceOptions, RtcAudioSource};
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::{RtcVideoSource, VideoResolution};
use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc::UnboundedReceiver;
use tokio::sync::Mutex;

#[derive(Deserialize, Clone)]
pub struct StartArgs {
    pub url: String,
    pub token: String,
    pub monitor: usize,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate: u64,
    pub codec: String,
    pub audio: bool,
}

pub struct Session {
    pub room: Arc<Room>,
    pub video_track: LocalVideoTrack,
    stop: Arc<AtomicBool>,
    #[cfg(windows)]
    capture: Option<crate::capture::Control>,
    audio_thread: Option<JoinHandle<()>>,
}

#[derive(Default)]
pub struct StreamState(Mutex<Option<Session>>);

fn emit_state(app: &AppHandle, state: &str, message: Option<String>, encoder: Option<String>) {
    let _ = app.emit("stream-state", json!({ "state": state, "message": message, "encoder": encoder }));
}

fn codec_of(name: &str) -> (VideoCodec, &'static str) {
    match name {
        "av1" => (VideoCodec::AV1, "AV1"),
        "vp9" => (VideoCodec::VP9, "VP9"),
        "h264" => (VideoCodec::H264, "H.264"),
        // Padrão: VP8 (libvpx usa vários núcleos; o OpenH264 empaca em 1080p60)
        _ => (VideoCodec::VP8, "VP8"),
    }
}

pub async fn teardown(session: Session) {
    session.stop.store(true, Ordering::Relaxed);
    #[cfg(windows)]
    if let Some(control) = session.capture {
        let _ = control.stop();
    }
    if let Some(handle) = session.audio_thread {
        let _ = tauri::async_runtime::spawn_blocking(move || handle.join()).await;
    }
    let _ = session.room.close().await;
}

/// Conecta, publica tela (+ áudio) e inicia a captura. Usado pelo app e pelo modo de teste.
pub async fn open_session(args: &StartArgs) -> Result<(Session, UnboundedReceiver<RoomEvent>, String), String> {
    let (room, events) = Room::connect(&args.url, &args.token, RoomOptions::default())
        .await
        .map_err(|e| format!("Não consegui conectar no servidor de vídeo: {e}"))?;
    let room = Arc::new(room);
    let stop = Arc::new(AtomicBool::new(false));

    // ---- vídeo ----
    let video_source = NativeVideoSource::new(VideoResolution { width: args.width, height: args.height }, true);
    let video_track = LocalVideoTrack::create_video_track("screen", RtcVideoSource::Native(video_source.clone()));
    let (codec, codec_name) = codec_of(&args.codec);
    let publish = room
        .local_participant()
        .publish_track(
            LocalTrack::Video(video_track.clone()),
            TrackPublishOptions {
                source: TrackSource::Screenshare,
                video_codec: codec,
                video_encoding: Some(VideoEncoding { max_bitrate: args.bitrate, max_framerate: args.fps as f64 }),
                // Codificação por software: uma camada só (simulcast dobraria o uso de CPU)
                simulcast: false,
                stream: "screen".into(),
                ..Default::default()
            },
        )
        .await;
    if let Err(e) = publish {
        let _ = room.close().await;
        return Err(format!("Falha ao publicar a tela: {e}"));
    }

    #[cfg(windows)]
    let capture = match crate::capture::start(
        args.monitor,
        args.fps,
        crate::capture::Flags {
            source: video_source,
            stop: stop.clone(),
            max_width: args.width,
            max_height: args.height,
        },
    ) {
        Ok(control) => Some(control),
        Err(e) => {
            let _ = room.close().await;
            return Err(e);
        }
    };

    // ---- áudio ----
    let mut audio_thread = None;
    #[cfg(windows)]
    if args.audio {
        let audio_source = NativeAudioSource::new(
            AudioSourceOptions { echo_cancellation: false, noise_suppression: false, auto_gain_control: false },
            crate::audio::SAMPLE_RATE,
            crate::audio::CHANNELS,
            100,
        );
        let audio_track = LocalAudioTrack::create_audio_track("screen-audio", RtcAudioSource::Native(audio_source.clone()));
        let published = room
            .local_participant()
            .publish_track(
                LocalTrack::Audio(audio_track),
                TrackPublishOptions {
                    source: TrackSource::ScreenshareAudio,
                    dtx: false, // não corta silêncio (música e jogo)
                    red: false,
                    stream: "screen".into(),
                    ..Default::default()
                },
            )
            .await;
        match published {
            Ok(_) => audio_thread = Some(crate::audio::spawn(audio_source, stop.clone())),
            Err(e) => log::warn!("sem áudio: {e}"),
        }
    }

    let label = format!("{codec_name} • {}x{} {} fps", args.width, args.height, args.fps);
    let session = Session {
        room,
        video_track,
        stop,
        #[cfg(windows)]
        capture,
        audio_thread,
    };
    Ok((session, events, label))
}

#[tauri::command]
pub fn list_monitors() -> Result<serde_json::Value, String> {
    #[cfg(windows)]
    {
        return crate::capture::monitors().map(|m| json!(m));
    }
    #[allow(unreachable_code)]
    Err("Captura nativa disponível só no Windows por enquanto.".into())
}

#[tauri::command]
pub async fn start_stream(app: AppHandle, state: State<'_, StreamState>, args: StartArgs) -> Result<(), String> {
    let mut guard = state.0.lock().await;
    if guard.is_some() {
        return Err("Já existe uma transmissão em andamento.".into());
    }

    let (session, mut events, label) = open_session(&args).await?;
    *guard = Some(session);
    drop(guard);

    emit_state(&app, "live", None, Some(label));

    // Se o servidor derrubar a conexão (ex.: vaga revogada), encerra tudo
    let app_events = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            if let RoomEvent::Disconnected { reason } = event {
                let state = app_events.state::<StreamState>();
                if let Some(session) = state.0.lock().await.take() {
                    teardown(session).await;
                    emit_state(&app_events, "error", Some(format!("desconectado ({reason:?})")), None);
                }
                break;
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_stream(app: AppHandle, state: State<'_, StreamState>) -> Result<(), String> {
    if let Some(session) = state.0.lock().await.take() {
        teardown(session).await;
        emit_state(&app, "stopped", None, None);
    }
    Ok(())
}
