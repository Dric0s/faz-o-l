//! Codificação H.264 na placa de vídeo via Media Foundation.
//!
//! O Windows expõe os codificadores de hardware de cada fabricante (NVIDIA NVENC,
//! AMD AMF, Intel QuickSync) como "MFTs". Aqui achamos o primeiro disponível,
//! configuramos pra baixa latência e entregamos o H.264 pronto ao LiveKit
//! (modo pass-through). O WebRTC continua mandando pedidos de quadro-chave e de
//! bitrate, que repassamos ao codificador em tempo real.

use std::mem::ManuallyDrop;
use std::ptr::null_mut;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender, TryRecvError};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use livekit::webrtc::video_frame::{EncodedFrameType, EncodedVideoCodec, EncodedVideoFrame};
use livekit::webrtc::video_source::native::NativeVideoSource;
use livekit::webrtc::video_source::VideoResolution;
use windows::core::{Interface, Result as WinResult, PWSTR};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_MULTITHREADED};
use windows::Win32::System::Variant::VARIANT;

/// Quadro já convertido pra NV12 (formato que os codificadores de hardware aceitam).
pub struct Nv12Frame {
    pub data: Vec<u8>,
    pub timestamp_us: i64,
}

fn pack(hi: u32, lo: u32) -> u64 {
    ((hi as u64) << 32) | lo as u64
}

fn start_mf() -> WinResult<()> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        MFStartup(MF_VERSION, MFSTARTUP_FULL)
    }
}

/// Lista os codificadores H.264 de hardware (o primeiro é o preferido pelo Windows).
unsafe fn enumerate() -> WinResult<Vec<IMFActivate>> {
    let input = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_NV12 };
    let output = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_H264 };
    let mut activates: *mut Option<IMFActivate> = null_mut();
    let mut count = 0u32;
    MFTEnumEx(
        MFT_CATEGORY_VIDEO_ENCODER,
        MFT_ENUM_FLAG(MFT_ENUM_FLAG_HARDWARE.0 | MFT_ENUM_FLAG_SORTANDFILTER.0),
        Some(&input),
        Some(&output),
        &mut activates,
        &mut count,
    )?;
    let mut list = Vec::new();
    if !activates.is_null() {
        for item in std::slice::from_raw_parts_mut(activates, count as usize) {
            if let Some(activate) = item.take() {
                list.push(activate);
            }
        }
        CoTaskMemFree(Some(activates as *const _));
    }
    Ok(list)
}

unsafe fn friendly_name(activate: &IMFActivate) -> String {
    let mut name = PWSTR::null();
    let mut len = 0u32;
    if activate.GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut name, &mut len).is_ok() && !name.is_null() {
        let text = name.to_string().unwrap_or_default();
        CoTaskMemFree(Some(name.0 as *const _));
        return text;
    }
    "Codificador de hardware".into()
}

/// Nome do codificador de hardware disponível (ex.: "NVIDIA H.264 Encoder MFT"), ou None.
pub fn probe() -> Option<String> {
    start_mf().ok()?;
    let name = unsafe { enumerate().ok()?.first().map(|a| friendly_name(a)) };
    unsafe {
        let _ = MFShutdown();
    }
    name
}

struct Encoded {
    data: Vec<u8>,
    key: bool,
    timestamp_us: i64,
}

struct HwEncoder {
    mft: IMFTransform,
    events: IMFMediaEventGenerator,
    codec: Option<ICodecAPI>,
    name: String,
    fps: u32,
    provides_samples: bool,
    out_size: u32,
    need_input: u32,
    /// SPS/PPS mais recentes (Annex-B), repetidos em todo quadro-chave
    param_sets: Vec<u8>,
}

impl HwEncoder {
    unsafe fn new(width: u32, height: u32, fps: u32, bitrate: u32) -> WinResult<Self> {
        start_mf()?;
        let mut last_err = windows::core::Error::from_hresult(MF_E_NOT_FOUND);
        for activate in enumerate()? {
            let name = friendly_name(&activate);
            match Self::open(&activate, name, width, height, fps, bitrate) {
                Ok(encoder) => return Ok(encoder),
                Err(e) => {
                    log::warn!("codificador de hardware recusou a configuração: {e}");
                    last_err = e;
                }
            }
        }
        Err(last_err)
    }

    unsafe fn open(activate: &IMFActivate, name: String, width: u32, height: u32, fps: u32, bitrate: u32) -> WinResult<Self> {
        let mft: IMFTransform = activate.ActivateObject()?;

        // MFTs de hardware são assíncronos: precisam ser "destravados"
        let attributes = mft.GetAttributes()?;
        attributes.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)?;
        let _ = attributes.SetUINT32(&MF_LOW_LATENCY, 1);

        // Saída primeiro (exigência dos codificadores): H.264 Constrained Baseline,
        // o perfil que o pass-through do LiveKit anuncia e que todo navegador decodifica
        let output = MFCreateMediaType()?;
        output.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        output.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
        output.SetUINT32(&MF_MT_AVG_BITRATE, bitrate)?;
        output.SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height))?;
        output.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1))?;
        output.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
        output.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        output.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_ConstrainedBase.0 as u32)?;
        if mft.SetOutputType(0, &output, 0).is_err() {
            output.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Base.0 as u32)?;
            mft.SetOutputType(0, &output, 0)?;
        }

        let input = MFCreateMediaType()?;
        input.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        input.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
        input.SetUINT64(&MF_MT_FRAME_SIZE, pack(width, height))?;
        input.SetUINT64(&MF_MT_FRAME_RATE, pack(fps, 1))?;
        input.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1))?;
        input.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        mft.SetInputType(0, &input, 0)?;

        // Baixa latência: sem B-frames, CBR, GOP de 4 s (quadro-chave extra sob demanda)
        let codec = mft.cast::<ICodecAPI>().ok();
        if let Some(api) = &codec {
            let _ = api.SetValue(&CODECAPI_AVLowLatencyMode, &VARIANT::from(true));
            let _ = api.SetValue(&CODECAPI_AVEncCommonRateControlMode, &VARIANT::from(eAVEncCommonRateControlMode_CBR.0 as u32));
            let _ = api.SetValue(&CODECAPI_AVEncCommonMeanBitRate, &VARIANT::from(bitrate));
            let _ = api.SetValue(&CODECAPI_AVEncMPVGOPSize, &VARIANT::from(fps * 4));
            let _ = api.SetValue(&CODECAPI_AVEncMPVDefaultBPictureCount, &VARIANT::from(0u32));
        }

        let info = mft.GetOutputStreamInfo(0)?;
        let provides_samples = info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32) != 0;
        let out_size = info.cbSize.max(width * height * 3 / 2);
        let events: IMFMediaEventGenerator = mft.cast()?;

        mft.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0)?;
        mft.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
        mft.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;

        Ok(Self { mft, events, codec, name, fps, provides_samples, out_size, need_input: 0, param_sets: Vec::new() })
    }

    fn request_keyframe(&self) {
        if let Some(api) = &self.codec {
            unsafe {
                let _ = api.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &VARIANT::from(1u32));
            }
        }
    }

    fn set_bitrate(&self, bps: u32) {
        if let Some(api) = &self.codec {
            unsafe {
                let _ = api.SetValue(&CODECAPI_AVEncCommonMeanBitRate, &VARIANT::from(bps));
            }
        }
    }

    /// Processa os eventos pendentes do MFT sem bloquear.
    unsafe fn poll(&mut self, out: &mut Vec<Encoded>) -> WinResult<()> {
        while let Ok(event) = self.events.GetEvent(MF_EVENT_FLAG_NO_WAIT) {
            let kind = event.GetType()? as i32;
            if kind == METransformNeedInput.0 {
                self.need_input += 1;
            } else if kind == METransformHaveOutput.0 {
                if let Some(frame) = self.take_output()? {
                    out.push(frame);
                }
            }
        }
        Ok(())
    }

    unsafe fn encode(&mut self, frame: &Nv12Frame) -> WinResult<()> {
        let len = frame.data.len() as u32;
        let buffer = MFCreateMemoryBuffer(len)?;
        let mut ptr: *mut u8 = null_mut();
        buffer.Lock(&mut ptr, None, None)?;
        std::ptr::copy_nonoverlapping(frame.data.as_ptr(), ptr, frame.data.len());
        buffer.Unlock()?;
        buffer.SetCurrentLength(len)?;

        let sample = MFCreateSample()?;
        sample.AddBuffer(&buffer)?;
        sample.SetSampleTime(frame.timestamp_us * 10)?; // unidades de 100 ns
        sample.SetSampleDuration(10_000_000 / self.fps.max(1) as i64)?;
        self.mft.ProcessInput(0, &sample, 0)?;
        self.need_input -= 1;
        Ok(())
    }

    unsafe fn take_output(&mut self) -> WinResult<Option<Encoded>> {
        let provided = if self.provides_samples {
            None
        } else {
            let sample = MFCreateSample()?;
            sample.AddBuffer(&MFCreateMemoryBuffer(self.out_size)?)?;
            Some(sample)
        };
        let mut buffers = [MFT_OUTPUT_DATA_BUFFER {
            dwStreamID: 0,
            pSample: ManuallyDrop::new(provided),
            dwStatus: 0,
            pEvents: ManuallyDrop::new(None),
        }];
        let mut status = 0u32;
        let result = self.mft.ProcessOutput(0, &mut buffers, &mut status);
        let sample = ManuallyDrop::take(&mut buffers[0].pSample);
        let _events = ManuallyDrop::take(&mut buffers[0].pEvents);

        if let Err(e) = result {
            if e.code() == MF_E_TRANSFORM_STREAM_CHANGE {
                let available = self.mft.GetOutputAvailableType(0, 0)?;
                self.mft.SetOutputType(0, &available, 0)?;
                return Ok(None);
            }
            if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT {
                return Ok(None);
            }
            return Err(e);
        }
        let Some(sample) = sample else { return Ok(None) };

        let key = sample.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(0) == 1;
        let timestamp_us = sample.GetSampleTime().unwrap_or(0) / 10;
        let buffer = sample.ConvertToContiguousBuffer()?;
        let mut ptr: *mut u8 = null_mut();
        let mut size = 0u32;
        buffer.Lock(&mut ptr, None, Some(&mut size))?;
        let data = std::slice::from_raw_parts(ptr, size as usize).to_vec();
        buffer.Unlock()?;

        let (data, key) = self.with_param_sets(data, key);
        Ok(Some(Encoded { data, key, timestamp_us }))
    }

    /// Guarda SPS/PPS quando aparecem e os coloca na frente de quadros-chave que vierem sem.
    fn with_param_sets(&mut self, data: Vec<u8>, key: bool) -> (Vec<u8>, bool) {
        let nals = annexb_nals(&data);
        let has_sps = nals.iter().any(|(t, _)| *t == 7);
        let is_idr = key || nals.iter().any(|(t, _)| *t == 5);
        if has_sps {
            self.param_sets.clear();
            for (t, range) in &nals {
                if *t == 7 || *t == 8 {
                    self.param_sets.extend_from_slice(&[0, 0, 0, 1]);
                    self.param_sets.extend_from_slice(&data[range.clone()]);
                }
            }
        }
        if is_idr && !has_sps && !self.param_sets.is_empty() {
            let mut joined = self.param_sets.clone();
            joined.extend_from_slice(&data);
            return (joined, true);
        }
        (data, is_idr)
    }
}

impl Drop for HwEncoder {
    fn drop(&mut self) {
        unsafe {
            let _ = self.mft.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            let _ = self.mft.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
            let _ = MFShutdown();
        }
    }
}

/// Unidades NAL de um fluxo Annex-B: (tipo, intervalo do payload sem o start code).
fn annexb_nals(data: &[u8]) -> Vec<(u8, std::ops::Range<usize>)> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut nals = Vec::new();
    for (n, &start) in starts.iter().enumerate() {
        let mut end = starts.get(n + 1).map(|&next| next - 3).unwrap_or(data.len());
        while end > start && data[end - 1] == 0 {
            end -= 1; // zeros do próximo start code de 4 bytes
        }
        if start < end {
            nals.push((data[start] & 0x1f, start..end));
        }
    }
    nals
}

pub struct EncoderHandle {
    pub sender: SyncSender<Nv12Frame>,
    pub thread: JoinHandle<()>,
    pub name: String,
}

/// Cria o codificador numa thread própria. Retorna erro se não houver hardware disponível.
pub fn spawn(
    source: NativeVideoSource,
    width: u32,
    height: u32,
    fps: u32,
    max_bitrate: u32,
    stop: Arc<AtomicBool>,
) -> Result<EncoderHandle, String> {
    let (frame_tx, frame_rx) = sync_channel::<Nv12Frame>(2);
    let (ready_tx, ready_rx) = sync_channel::<Result<String, String>>(1);

    let thread = std::thread::Builder::new()
        .name("fazol-hwenc".into())
        .spawn(move || run(source, frame_rx, ready_tx, width, height, fps, max_bitrate, stop))
        .map_err(|e| e.to_string())?;

    match ready_rx.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(name)) => Ok(EncoderHandle { sender: frame_tx, thread, name }),
        Ok(Err(e)) => Err(e),
        Err(_) => Err("o codificador de hardware não respondeu".into()),
    }
}

#[allow(clippy::too_many_arguments)]
fn run(
    source: NativeVideoSource,
    frames: Receiver<Nv12Frame>,
    ready: SyncSender<Result<String, String>>,
    width: u32,
    height: u32,
    fps: u32,
    max_bitrate: u32,
    stop: Arc<AtomicBool>,
) {
    let mut encoder = match unsafe { HwEncoder::new(width, height, fps, max_bitrate) } {
        Ok(encoder) => {
            let _ = ready.send(Ok(encoder.name.clone()));
            encoder
        }
        Err(e) => {
            let _ = ready.send(Err(format!("sem codificador de hardware: {e}")));
            return;
        }
    };
    log::info!("codificando na placa de vídeo: {}", encoder.name);

    let resolution = VideoResolution { width, height };
    let mut pending: Option<Nv12Frame> = None;
    let mut out = Vec::new();

    let push = |frames: &mut Vec<Encoded>| {
        for frame in frames.drain(..) {
            source.capture_encoded_frame(&EncodedVideoFrame {
                codec: EncodedVideoCodec::H264,
                payload: &frame.data,
                timestamp_us: frame.timestamp_us,
                frame_type: if frame.key { EncodedFrameType::Key } else { EncodedFrameType::Delta },
                resolution: resolution.clone(),
                frame_metadata: None,
            });
        }
    };

    while !stop.load(Ordering::Relaxed) {
        // Pedidos do WebRTC: quadro-chave (alguém entrou / perda) e bitrate (rede)
        if source.take_keyframe_request() {
            encoder.request_keyframe();
        }
        if let Some(rate) = source.take_rate_control_request() {
            let target = rate.target_bitrate_bps.clamp(300_000, max_bitrate as u64) as u32;
            encoder.set_bitrate(target);
        }

        if let Err(e) = unsafe { encoder.poll(&mut out) } {
            log::error!("codificador de hardware falhou: {e}");
            break;
        }
        push(&mut out);

        // Pega sempre o quadro mais novo (descarta os atrasados)
        match frames.recv_timeout(Duration::from_millis(1)) {
            Ok(frame) => pending = Some(frame),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        loop {
            match frames.try_recv() {
                Ok(frame) => pending = Some(frame),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => break,
            }
        }

        if encoder.need_input > 0 {
            if let Some(frame) = pending.take() {
                if let Err(e) = unsafe { encoder.encode(&frame) } {
                    log::error!("falha ao enviar quadro ao codificador: {e}");
                    break;
                }
            }
        }
    }
}
