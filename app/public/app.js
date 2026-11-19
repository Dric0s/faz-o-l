import {
  AudioPresets,
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  VideoPreset,
  VideoQuality,
} from '/vendor/livekit/livekit-client.esm.mjs';

// Perfis de transmissão. "layer" é a versão menor enviada junto (simulcast)
// para quem escolher "Economia" ou estiver com internet fraca.
const QUALITY = {
  '1080p60': { width: 1920, height: 1080, fps: 60, bitrate: 8_000_000, layer: [1280, 720, 2_500_000, 30] },
  '1080p30': { width: 1920, height: 1080, fps: 30, bitrate: 5_000_000, layer: [1280, 720, 1_800_000, 30] },
  '720p60': { width: 1280, height: 720, fps: 60, bitrate: 4_000_000, layer: [854, 480, 1_000_000, 30] },
  '720p30': { width: 1280, height: 720, fps: 30, bitrate: 2_500_000, layer: [854, 480, 800_000, 30] },
};

const $ = (sel) => document.querySelector(sel);
const state = {
  me: null,
  limits: { maxStreamers: 2, maxViewers: 15 },
  room: null,
  tiles: new Map(), // identity -> tile
  focus: null,
  local: null, // { video, audio } MediaStreamTracks enquanto transmite
  busy: false,
  leaving: false,
};

// ---------------- utilidades ----------------

const store = {
  get(key, fallback) {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* sem storage */ }
  },
};

function toast(message, isError = false) {
  const el = document.createElement('div');
  el.className = `toast${isError ? ' err' : ''}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 5000);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

function show(view) {
  for (const id of ['view-login', 'view-join', 'view-room']) $(`#${id}`).hidden = id !== view;
}

function avatarOf(participant) {
  try { return JSON.parse(participant.metadata || '{}').avatar || ''; } catch { return ''; }
}

function livekitUrl(fromServer) {
  if (fromServer) return fromServer;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
}

// ---------------- login ----------------

async function init() {
  const params = new URLSearchParams(location.search);
  const erro = params.get('erro');
  if (erro) history.replaceState(null, '', '/');

  const me = await api('/api/me');
  state.limits = me.limits;

  if (!me.user) {
    show('view-login');
    $('#btn-discord').hidden = me.authMode !== 'discord';
    $('#form-guest').hidden = me.authMode !== 'guest';
    if (erro) {
      const msg = erro === 'servidor'
        ? 'Você precisa ser membro do servidor do Discord para entrar.'
        : 'Não foi possível fazer login. Tente de novo.';
      $('#login-error').textContent = msg;
      $('#login-error').hidden = false;
    }
    return;
  }

  state.me = me.user;
  show('view-join');
  $('#join-name').textContent = me.user.name;
  if (me.user.avatar) {
    $('#join-avatar').src = me.user.avatar;
    $('#join-avatar').hidden = false;
  }
  refreshJoinStatus();
}

async function refreshJoinStatus() {
  try {
    const s = await api('/api/status');
    const live = s.streamers.filter((x) => x.live);
    $('#join-status').textContent = live.length
      ? `🔴 Ao vivo: ${live.map((x) => x.name).join(' e ')} • ${s.viewers} assistindo`
      : `Ninguém ao vivo agora • ${s.total} na sala`;
  } catch {
    $('#join-status').textContent = '';
  }
}

$('#form-guest').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/guest', { method: 'POST', body: { name: $('#guest-name').value } });
    init();
  } catch (err) {
    toast(err.message, true);
  }
});

async function logout() {
  await leave();
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  location.reload();
}
$('#btn-logout-join').addEventListener('click', logout);

// ---------------- sala ----------------

$('#btn-join').addEventListener('click', join);
$('#btn-leave').addEventListener('click', async () => {
  await leave();
  show('view-join');
  refreshJoinStatus();
});
$('#btn-sidebar').addEventListener('click', () => $('#sidebar').classList.toggle('collapsed'));

async function join() {
  const btn = $('#btn-join');
  btn.disabled = true;
  btn.textContent = 'Entrando…';
  try {
    const { token, url } = await api('/api/token', { method: 'POST' });

    const room = new Room({
      adaptiveStream: false, // a qualidade é escolhida pelo espectador
      dynacast: true, // o streamer só envia as camadas que alguém está assistindo
      disconnectOnPageLeave: true,
    });
    state.room = room;
    state.leaving = false;
    wireRoom(room);

    await room.connect(livekitUrl(url), token);
    await room.startAudio().catch(() => {});

    show('view-room');
    renderPresence();
  } catch (err) {
    toast(err.message || 'Não foi possível entrar na sala.', true);
    state.room = null;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Entrar na sala';
  }
}

async function leave() {
  if (!state.room) return;
  state.leaving = true;
  await stopStream();
  await state.room.disconnect();
  state.room = null;
  for (const id of [...state.tiles.keys()]) removeTile(id);
}

function wireRoom(room) {
  room
    .on(RoomEvent.TrackSubscribed, onTrackSubscribed)
    .on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed)
    .on(RoomEvent.ParticipantConnected, renderPresence)
    .on(RoomEvent.ParticipantDisconnected, (p) => {
      removeTile(p.identity);
      renderPresence();
    })
    .on(RoomEvent.TrackPublished, renderPresence)
    .on(RoomEvent.TrackUnpublished, renderPresence)
    .on(RoomEvent.ParticipantMetadataChanged, renderPresence)
    .on(RoomEvent.LocalTrackUnpublished, (pub) => {
      // Tela parada pelo navegador ou pelo servidor
      if (pub.source === Track.Source.ScreenShare) stopStream();
    })
    .on(RoomEvent.AudioPlaybackStatusChanged, () => {
      if (!room.canPlaybackAudio) toast('Clique em qualquer lugar da página para liberar o som.');
    })
    .on(RoomEvent.Reconnecting, () => toast('Conexão instável, reconectando…'))
    .on(RoomEvent.Reconnected, () => toast('Reconectado!'))
    .on(RoomEvent.Disconnected, (reason) => {
      if (state.leaving) return;
      state.room = null;
      cleanupLocal();
      for (const id of [...state.tiles.keys()]) removeTile(id);
      const msg = reason === DisconnectReason.DUPLICATE_IDENTITY
        ? 'Você entrou em outra aba/dispositivo.'
        : 'Você foi desconectado da sala.';
      toast(msg, true);
      show('view-join');
      refreshJoinStatus();
    });
}

// Desbloqueia áudio no primeiro clique, se o navegador bloqueou
document.addEventListener('click', () => {
  if (state.room && !state.room.canPlaybackAudio) state.room.startAudio().catch(() => {});
});

function onTrackSubscribed(track, publication, participant) {
  if (track.source === Track.Source.ScreenShare && track.kind === Track.Kind.Video) {
    const tile = ensureTile(participant.identity, participant.name || participant.identity);
    tile.publication = publication;
    track.attach(tile.video);
    tile.el.classList.add('has-video');
    applyQuality(tile);
    updateResolution(tile, track);
  } else if (track.source === Track.Source.ScreenShareAudio && track.kind === Track.Kind.Audio) {
    const tile = ensureTile(participant.identity, participant.name || participant.identity);
    tile.audioTrack = track;
    const el = track.attach();
    $('#audio-sink').append(el);
    applyVolume(tile);
  }
  renderPresence();
}

function onTrackUnsubscribed(track, publication, participant) {
  const els = track.detach();
  for (const el of els) if (el.tagName === 'AUDIO') el.remove();
  const tile = state.tiles.get(participant.identity);
  if (!tile) return;
  if (track.kind === Track.Kind.Video) {
    removeTile(participant.identity);
  } else {
    tile.audioTrack = null;
  }
  renderPresence();
}

// ---------------- tiles ----------------

function ensureTile(id, name, isLocal = false) {
  let tile = state.tiles.get(id);
  if (tile) return tile;

  const el = $('#tpl-tile').content.firstElementChild.cloneNode(true);
  tile = {
    id,
    el,
    isLocal,
    video: el.querySelector('video'),
    publication: null,
    audioTrack: null,
    volume: Number(store.get(`vol:${id}`, '1')),
    muted: false,
    quality: store.get('quality', 'high'),
  };
  el.querySelector('.tile-name').textContent = isLocal ? `${name} (você)` : name;
  if (isLocal) el.classList.add('local');

  const volume = el.querySelector('.ctl-volume');
  const mute = el.querySelector('.ctl-mute');
  const quality = el.querySelector('.ctl-quality');
  volume.value = String(tile.volume);
  quality.value = tile.quality;

  if (isLocal) {
    // No próprio preview não toca o seu áudio (evita eco)
    volume.hidden = true;
    mute.hidden = true;
    quality.hidden = true;
    const stop = el.querySelector('.ctl-stop');
    stop.hidden = false;
    stop.addEventListener('click', stopStream);
  }

  volume.addEventListener('input', () => {
    tile.volume = Number(volume.value);
    tile.muted = tile.volume === 0;
    store.set(`vol:${id}`, String(tile.volume));
    applyVolume(tile);
  });
  mute.addEventListener('click', () => {
    tile.muted = !tile.muted;
    applyVolume(tile);
  });
  quality.addEventListener('change', () => {
    tile.quality = quality.value;
    store.set('quality', tile.quality);
    applyQuality(tile);
  });
  el.querySelector('.ctl-focus').addEventListener('click', () => {
    state.focus = state.focus === id ? null : id;
    layout();
  });
  el.querySelector('.ctl-full').addEventListener('click', () => toggleFullscreen(el));
  el.addEventListener('dblclick', () => toggleFullscreen(el));
  el.addEventListener('touchstart', () => {
    el.classList.add('touch');
    clearTimeout(tile.touchTimer);
    tile.touchTimer = setTimeout(() => el.classList.remove('touch'), 3500);
  }, { passive: true });

  state.tiles.set(id, tile);
  $('#stage').append(el);
  layout();
  return tile;
}

function removeTile(id) {
  const tile = state.tiles.get(id);
  if (!tile) return;
  tile.el.remove();
  state.tiles.delete(id);
  if (state.focus === id) state.focus = null;
  layout();
}

function layout() {
  const stage = $('#stage');
  const count = state.tiles.size;
  stage.className = `stage count-${Math.min(count, 2)}`;
  if (state.focus && count > 1) stage.classList.add('focused');
  for (const tile of state.tiles.values()) {
    tile.el.classList.toggle('is-focus', state.focus === tile.id);
    applyQuality(tile);
  }
}

function applyVolume(tile) {
  const mute = tile.el.querySelector('.ctl-mute');
  mute.textContent = tile.muted || tile.volume === 0 ? '🔇' : '🔊';
  tile.audioTrack?.setVolume(tile.muted ? 0 : tile.volume);
}

function applyQuality(tile) {
  if (!tile.publication) return;
  // No modo destaque, a live pequena vai em qualidade menor para economizar banda
  const minimized = state.focus && state.focus !== tile.id && state.tiles.size > 1;
  const q = minimized || tile.quality === 'low' ? VideoQuality.LOW : VideoQuality.HIGH;
  tile.publication.setVideoQuality(q);
}

function updateResolution(tile, track) {
  const label = tile.el.querySelector('.tile-res');
  const update = () => {
    const h = tile.video.videoHeight;
    label.textContent = h ? `${h}p` : '';
  };
  tile.video.addEventListener('resize', update);
  tile.video.addEventListener('loadedmetadata', update);
}

function toggleFullscreen(el) {
  if (document.fullscreenElement) document.exitFullscreen();
  else el.requestFullscreen?.().catch(() => {});
}

// ---------------- presença / contadores ----------------

function participants() {
  if (!state.room) return [];
  return [state.room.localParticipant, ...state.room.remoteParticipants.values()];
}

function isStreaming(p) {
  if (p === state.room?.localParticipant) return !!state.local;
  for (const pub of p.trackPublications.values()) if (pub.source === Track.Source.ScreenShare) return true;
  return false;
}

function renderPresence() {
  if (!state.room) return;
  const all = participants();
  const streamers = all.filter(isStreaming);
  const viewers = all.length - streamers.length;
  const { maxStreamers, maxViewers } = state.limits;

  $('#live-count').textContent = `${streamers.length}/${maxStreamers} ao vivo`;
  $('#pill-live').classList.toggle('on', streamers.length > 0);
  $('#viewer-count').textContent = `${viewers}/${maxViewers}`;
  $('#people-count').textContent = `(${all.length})`;

  const free = maxStreamers - streamers.length;
  const btn = $('#btn-stream');
  if (state.local) {
    btn.textContent = 'Parar transmissão';
    btn.classList.add('streaming');
    btn.disabled = false;
    $('#slots').textContent = 'Você está ao vivo 🔴';
  } else {
    btn.textContent = 'Transmitir minha tela';
    btn.classList.remove('streaming');
    btn.disabled = state.busy || free <= 0;
    $('#slots').textContent = free > 0
      ? `${free} vaga${free > 1 ? 's' : ''} para transmitir`
      : `Sem vagas: já tem ${maxStreamers} pessoas ao vivo`;
  }

  const list = $('#people');
  list.replaceChildren(
    ...all
      .sort((a, b) => Number(isStreaming(b)) - Number(isStreaming(a)))
      .map((p) => {
        const li = document.createElement('li');
        const avatar = avatarOf(p);
        const name = p.name || p.identity;
        if (avatar) {
          const img = document.createElement('img');
          img.src = avatar;
          img.alt = '';
          img.loading = 'lazy';
          li.append(img);
        } else {
          const span = document.createElement('span');
          span.className = 'avatar';
          span.textContent = name.slice(0, 1).toUpperCase();
          li.append(span);
        }
        const label = document.createElement('span');
        label.textContent = p === state.room.localParticipant ? `${name} (você)` : name;
        li.append(label);
        if (isStreaming(p)) {
          const tag = document.createElement('span');
          tag.className = 'tag';
          tag.textContent = 'AO VIVO';
          li.append(tag);
        }
        return li;
      }),
  );
}

// ---------------- transmitir ----------------

$('#btn-stream').addEventListener('click', () => (state.local ? stopStream() : startStream()));
$('#opt-quality').value = store.get('stream-quality', '1080p30');
$('#opt-content').value = store.get('stream-content', 'motion');
$('#opt-quality').addEventListener('change', (e) => store.set('stream-quality', e.target.value));
$('#opt-content').addEventListener('change', (e) => store.set('stream-content', e.target.value));

function waitForPublishPermission(timeoutMs = 6000) {
  const lp = state.room.localParticipant;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (lp.permissions?.canPublish) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('O servidor demorou para liberar a transmissão.'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

async function startStream() {
  if (state.busy || state.local || !state.room) return;
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast('Seu navegador não suporta transmitir a tela. Use Chrome, Edge ou Firefox no computador.', true);
    return;
  }

  const q = QUALITY[$('#opt-quality').value] || QUALITY['1080p30'];
  const content = $('#opt-content').value;
  const withAudio = $('#opt-audio').checked;

  state.busy = true;
  renderPresence();

  // 1) Captura primeiro (o navegador exige que seja logo após o clique)
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: q.width },
        height: { ideal: q.height },
        frameRate: { ideal: q.fps, max: q.fps },
      },
      audio: withAudio
        ? {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 2,
            sampleRate: 48000,
            suppressLocalAudioPlayback: false,
            restrictOwnAudio: true, // não captura o som das outras lives tocando nesta aba
          }
        : false,
      systemAudio: withAudio ? 'include' : 'exclude',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include',
    });
  } catch {
    state.busy = false;
    renderPresence();
    return; // usuário cancelou
  }

  const video = stream.getVideoTracks()[0];
  const audio = stream.getAudioTracks()[0] || null;
  video.contentHint = content === 'detail' ? 'detail' : 'motion';

  try {
    // 2) Pede uma vaga ao servidor
    await api('/api/stream/start', { method: 'POST' });
    await waitForPublishPermission();

    // 3) Publica
    const lp = state.room.localParticipant;
    const encoding = { maxBitrate: q.bitrate, maxFramerate: q.fps };
    const layers = [new VideoPreset(...q.layer)];
    await lp.publishTrack(video, {
      source: Track.Source.ScreenShare,
      name: 'screen',
      stream: 'screen',
      videoCodec: 'h264', // codificação por hardware na maioria das GPUs = menos atraso
      simulcast: true,
      videoEncoding: encoding,
      screenShareEncoding: encoding,
      videoSimulcastLayers: layers,
      screenShareSimulcastLayers: layers,
      degradationPreference: content === 'detail' ? 'maintain-resolution' : 'maintain-framerate',
    });
    if (audio) {
      await lp.publishTrack(audio, {
        source: Track.Source.ScreenShareAudio,
        name: 'screen-audio',
        stream: 'screen',
        audioPreset: AudioPresets.musicHighQualityStereo,
        forceStereo: true,
        dtx: false,
        red: false,
      });
    } else if (withAudio) {
      toast('Transmitindo sem som: marque "Compartilhar áudio" na janela do navegador.');
    }

    state.local = { video, audio };
    video.addEventListener('ended', stopStream);

    const tile = ensureTile('__local__', state.me.name, true);
    tile.video.srcObject = new MediaStream([video]);
    tile.el.classList.add('has-video');
    updateResolution(tile);
    toast('Você está ao vivo! 🔴');
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    await unpublishScreen();
    await api('/api/stream/stop', { method: 'POST' }).catch(() => {});
    toast(err.message || 'Não foi possível transmitir.', true);
  } finally {
    state.busy = false;
    renderPresence();
  }
}

async function unpublishScreen() {
  const lp = state.room?.localParticipant;
  if (!lp) return;
  for (const pub of [...lp.trackPublications.values()]) {
    if (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio) {
      if (pub.track) await lp.unpublishTrack(pub.track, true).catch(() => {});
    }
  }
}

function cleanupLocal() {
  if (!state.local) return false;
  state.local.video.stop();
  state.local.audio?.stop();
  state.local = null;
  removeTile('__local__');
  return true;
}

async function stopStream() {
  if (!cleanupLocal()) return;
  await unpublishScreen();
  if (state.room) await api('/api/stream/stop', { method: 'POST' }).catch(() => {});
  renderPresence();
}

init().catch((err) => toast(err.message, true));
