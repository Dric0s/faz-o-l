//! Áudio do sistema (WASAPI loopback) SEM o som do próprio app.
//!
//! Usa o loopback por processo em modo "excluir": captura tudo o que toca no PC,
//! menos o Faz o L (e os processos filhos, como o WebView2). Assim quem transmite
//! pode assistir a outra live no app sem que o som dela volte pra transmissão.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use livekit::webrtc::audio_frame::AudioFrame;
use livekit::webrtc::audio_source::native::NativeAudioSource;
use wasapi::{AudioClient, Direction, SampleType, StreamMode, WaveFormat};

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u32 = 2;
const SAMPLES_PER_CHANNEL: usize = (SAMPLE_RATE / 100) as usize; // 10 ms
const BYTES_PER_FRAME: usize = SAMPLES_PER_CHANNEL * CHANNELS as usize * 4; // f32

pub fn spawn(source: NativeAudioSource, stop: Arc<AtomicBool>) -> JoinHandle<()> {
    std::thread::Builder::new()
        .name("fazol-audio".into())
        .spawn(move || {
            if let Err(err) = run(source, stop) {
                log::error!("captura de áudio falhou: {err}");
            }
        })
        .expect("não consegui criar a thread de áudio")
}

fn run(source: NativeAudioSource, stop: Arc<AtomicBool>) -> Result<(), Box<dyn std::error::Error>> {
    wasapi::initialize_mta().ok()?;

    // include_tree = false -> modo EXCLUIR o nosso processo (e filhos)
    let mut client = AudioClient::new_application_loopback_client(std::process::id(), false)?;
    let format = WaveFormat::new(32, 32, SampleType::Float, SAMPLE_RATE as usize, CHANNELS as usize, None);
    let mode = StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 200_000 };
    client.initialize_client(&format, Direction::Capture, mode, None)?;
    let event = client.set_get_eventhandle()?;
    let capture = client.get_audiocaptureclient()?;
    client.start_stream()?;

    let mut queue: VecDeque<u8> = VecDeque::with_capacity(BYTES_PER_FRAME * 20);
    let mut bytes = vec![0u8; BYTES_PER_FRAME];

    while !stop.load(Ordering::Relaxed) {
        if event.wait_for_event(100).is_err() {
            continue; // sem som tocando: nada chega, só checa o stop de novo
        }
        capture.read_from_device_to_deque(&mut queue)?;

        while queue.len() >= BYTES_PER_FRAME {
            for (dst, src) in bytes.iter_mut().zip(queue.drain(..BYTES_PER_FRAME)) {
                *dst = src;
            }
            let samples: Vec<i16> = bytes
                .chunks_exact(4)
                .map(|b| {
                    let s = f32::from_le_bytes([b[0], b[1], b[2], b[3]]);
                    (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
                })
                .collect();
            let frame = AudioFrame {
                data: samples.into(),
                sample_rate: SAMPLE_RATE,
                num_channels: CHANNELS,
                samples_per_channel: SAMPLES_PER_CHANNEL as u32,
            };
            let _ = tauri::async_runtime::block_on(source.capture_frame(&frame));
        }
    }

    client.stop_stream().ok();
    Ok(())
}
