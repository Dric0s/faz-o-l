import { EventEmitter } from 'node:events';
import express from 'express';
import { AccessToken, RoomServiceClient, TrackSource, WebhookReceiver } from 'livekit-server-sdk';
import { config } from './config.js';
import { requireUser } from './auth.js';

const { host, apiKey, apiSecret } = config.livekit;
const roomService = new RoomServiceClient(host, apiKey, apiSecret);
const webhookReceiver = new WebhookReceiver(apiKey, apiSecret);

/**
 * Eventos emitidos para o bot do Discord:
 *  - 'stream:start' { identity, name }
 *  - 'stream:end'   { identity, name }
 *  - 'room:update'
 */
export const liveEvents = new EventEmitter();

// Quem está transmitindo agora (preenchido pelos webhooks do LiveKit)
const activeStreams = new Map(); // identity -> name
// Quem recebeu vaga e ainda não publicou a tela (para liberar vagas "presas")
const pendingGrants = new Map(); // identity -> timestamp
const PENDING_TIMEOUT_MS = 20_000;

const VIEWER_PERMISSION = {
  canSubscribe: true,
  canPublish: false,
  canPublishData: true,
  canPublishSources: [],
};

const STREAMER_PERMISSION = {
  canSubscribe: true,
  canPublish: true,
  canPublishData: true,
  canPublishSources: [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
};

// Mutex simples: evita que 2 pessoas peguem a última vaga ao mesmo tempo
let lock = Promise.resolve();
function withLock(fn) {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

// O gravador de clipes entra na sala escondido: não conta como pessoa
export const RECORDER_IDENTITY = 'fazol-recorder';

async function listParticipants() {
  try {
    const all = await roomService.listParticipants(config.room);
    return all.filter((p) => p.identity !== RECORDER_IDENTITY);
  } catch {
    return []; // sala ainda não existe
  }
}

function isScreenTrack(track) {
  return track?.source === TrackSource.SCREEN_SHARE;
}

function hasScreenShare(p) {
  return (p.tracks || []).some(isScreenTrack);
}

async function setPermission(identity, permission) {
  await roomService.updateParticipant(config.room, identity, undefined, permission);
}

// O app desktop transmite como um participante separado: "<id do usuário>:tela"
const DESKTOP_SUFFIX = ':tela';
const isDesktop = (identity) => identity.endsWith(DESKTOP_SUFFIX);

// Tokens do app desktop já emitidos, mas cujo participante ainda não entrou na sala
const pendingDesktop = new Map(); // identity -> timestamp

/** Quem ocupa vaga de transmissão: publicando, com permissão, ou desktop prestes a entrar. */
function streamerIdentities(participants) {
  const ids = new Set(
    participants.filter((p) => p.permission?.canPublish || hasScreenShare(p)).map((p) => p.identity),
  );
  const now = Date.now();
  for (const [identity, since] of pendingDesktop) {
    if (now - since > PENDING_TIMEOUT_MS) pendingDesktop.delete(identity);
    else ids.add(identity);
  }
  return ids;
}

/** Retorna o erro 409 se as vagas de transmissão acabaram, ou null. */
function slotsFull(participants) {
  const ids = streamerIdentities(participants);
  if (ids.size < config.maxStreamers) return null;
  const names = [...ids].map((id) => participants.find((p) => p.identity === id)?.name || 'alguém').join(' e ');
  return { status: 409, error: `Já tem ${config.maxStreamers} pessoas transmitindo (${names}). Espere uma vaga.` };
}

async function removeParticipant(identity) {
  await roomService.removeParticipant(config.room, identity).catch(() => {});
}

/** Estado atual da sala (usado pela API e pelo bot). */
export async function getRoomState() {
  const participants = await listParticipants();
  const streamers = participants
    .filter((p) => p.permission?.canPublish || hasScreenShare(p))
    .map((p) => ({ identity: p.identity, name: p.name || p.identity, live: hasScreenShare(p) }));
  return {
    streamers,
    viewers: participants.length - streamers.length,
    total: participants.length,
    maxStreamers: config.maxStreamers,
    maxViewers: config.maxViewers,
  };
}

/** Libera vagas de quem pediu pra transmitir mas nunca publicou a tela. */
async function sweepStuckGrants() {
  const participants = await listParticipants();
  const now = Date.now();
  for (const p of participants) {
    if (!p.permission?.canPublish) continue;
    if (hasScreenShare(p)) {
      pendingGrants.delete(p.identity);
      continue;
    }
    const since = pendingGrants.get(p.identity) ?? 0;
    if (now - since > PENDING_TIMEOUT_MS) {
      pendingGrants.delete(p.identity);
      if (isDesktop(p.identity)) await removeParticipant(p.identity);
      else await setPermission(p.identity, VIEWER_PERMISSION).catch(() => {});
      liveEvents.emit('room:update');
    }
  }
}
setInterval(() => sweepStuckGrants().catch(() => {}), 10_000).unref();

function endStream(identity) {
  const name = activeStreams.get(identity);
  if (name === undefined) return;
  activeStreams.delete(identity);
  liveEvents.emit('stream:end', { identity, name });
}

export function livekitRouter() {
  const router = express.Router();

  // Webhooks do LiveKit (corpo cru é necessário para validar a assinatura)
  router.post('/api/livekit/webhook', express.raw({ type: '*/*' }), async (req, res) => {
    let event;
    try {
      event = await webhookReceiver.receive(req.body.toString('utf8'), req.get('Authorization'));
    } catch {
      return res.status(401).end();
    }
    res.status(200).end();

    if (event.room && event.room.name !== config.room) return;
    const p = event.participant;

    switch (event.event) {
      case 'track_published':
        if (p && isScreenTrack(event.track) && !activeStreams.has(p.identity)) {
          pendingGrants.delete(p.identity);
          pendingDesktop.delete(p.identity);
          activeStreams.set(p.identity, p.name || p.identity);
          liveEvents.emit('stream:start', { identity: p.identity, name: p.name || p.identity });
        }
        break;
      case 'track_unpublished':
        if (p && isScreenTrack(event.track)) {
          endStream(p.identity);
          // Parou de transmitir: devolve a vaga (o participante do app desktop sai da sala)
          if (isDesktop(p.identity)) removeParticipant(p.identity);
          else setPermission(p.identity, VIEWER_PERMISSION).catch(() => {});
        }
        break;
      case 'participant_left':
        if (p) {
          pendingGrants.delete(p.identity);
          pendingDesktop.delete(p.identity);
          endStream(p.identity);
        }
        break;
      case 'room_finished':
        for (const identity of [...activeStreams.keys()]) endStream(identity);
        pendingGrants.clear();
        break;
    }
    liveEvents.emit('room:update');
  });

  router.get('/api/status', async (_req, res) => {
    res.json(await getRoomState());
  });

  // Token para entrar na sala (todo mundo entra como espectador)
  router.post('/api/token', requireUser, async (req, res) => {
    const user = req.user;
    const participants = await listParticipants();
    const others = participants.filter((p) => p.identity !== user.id);
    const capacity = config.maxViewers + config.maxStreamers;
    if (others.length >= capacity) {
      return res.status(409).json({ error: `Sala cheia (${capacity} pessoas). Tente daqui a pouco.` });
    }

    try {
      await roomService.createRoom({ name: config.room, emptyTimeout: 300, maxParticipants: capacity });
    } catch (err) {
      console.error('[livekit] Não consegui criar/verificar a sala:', err.message);
      return res.status(503).json({ error: 'Servidor de vídeo indisponível. Tente novamente.' });
    }

    const at = new AccessToken(apiKey, apiSecret, {
      identity: user.id,
      name: user.name,
      metadata: JSON.stringify({ avatar: user.avatar || '' }),
      ttl: '12h',
    });
    at.addGrant({
      roomJoin: true,
      room: config.room,
      canSubscribe: true,
      canPublish: false,
      canPublishData: true,
      canUpdateOwnMetadata: false,
    });

    res.json({ token: await at.toJwt(), url: config.livekit.publicUrl || null });
  });

  // Pede uma vaga para transmitir
  router.post('/api/stream/start', requireUser, async (req, res) => {
    const identity = req.user.id;
    try {
      const result = await withLock(async () => {
        const participants = await listParticipants();
        const me = participants.find((p) => p.identity === identity);
        if (!me) return { status: 409, error: 'Entre na sala antes de transmitir.' };
        if (me.permission?.canPublish) return { status: 200 };

        const full = slotsFull(participants);
        if (full) return full;

        pendingGrants.set(identity, Date.now());
        await setPermission(identity, STREAMER_PERMISSION);
        return { status: 200 };
      });
      if (result.status !== 200) return res.status(result.status).json({ error: result.error });
      liveEvents.emit('room:update');
      res.json({ ok: true });
    } catch (err) {
      console.error('[livekit] stream/start:', err.message);
      res.status(500).json({ error: 'Não foi possível liberar a transmissão.' });
    }
  });

  // App desktop: token próprio de transmissão (participante "<id>:tela", só publica a tela)
  router.post('/api/desktop/token', requireUser, async (req, res) => {
    const user = req.user;
    const identity = `${user.id}${DESKTOP_SUFFIX}`;
    try {
      const result = await withLock(async () => {
        const participants = await listParticipants();
        const ids = streamerIdentities(participants);
        if (ids.has(user.id)) return { status: 409, error: 'Você já está transmitindo pelo navegador.' };
        if (!ids.has(identity)) {
          const full = slotsFull(participants);
          if (full) return full;
        }
        pendingDesktop.set(identity, Date.now());
        return { status: 200 };
      });
      if (result.status !== 200) return res.status(result.status).json({ error: result.error });

      await roomService.createRoom({
        name: config.room,
        emptyTimeout: 300,
        maxParticipants: config.maxViewers + config.maxStreamers,
      });

      const at = new AccessToken(apiKey, apiSecret, {
        identity,
        name: user.name,
        metadata: JSON.stringify({ avatar: user.avatar || '', desktop: true, owner: user.id }),
        ttl: '12h',
      });
      at.addGrant({
        roomJoin: true,
        room: config.room,
        canSubscribe: false, // só envia: não gasta banda recebendo as outras lives
        canPublish: true,
        canPublishData: false,
        canPublishSources: [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO],
        canUpdateOwnMetadata: false,
      });
      liveEvents.emit('room:update');
      res.json({
        token: await at.toJwt(),
        url: config.livekit.publicUrl || config.publicUrl.replace(/^http/, 'ws'),
        identity,
      });
    } catch (err) {
      console.error('[livekit] desktop/token:', err.message);
      res.status(500).json({ error: 'Não foi possível liberar a transmissão.' });
    }
  });

  // Encerra a transmissão do app desktop (tira o participante "<id>:tela" da sala)
  router.post('/api/desktop/stop', requireUser, async (req, res) => {
    const identity = `${req.user.id}${DESKTOP_SUFFIX}`;
    pendingDesktop.delete(identity);
    await removeParticipant(identity);
    liveEvents.emit('room:update');
    res.json({ ok: true });
  });

  // Encerra a transmissão e devolve a vaga
  router.post('/api/stream/stop', requireUser, async (req, res) => {
    pendingGrants.delete(req.user.id);
    await setPermission(req.user.id, VIEWER_PERMISSION).catch(() => {});
    liveEvents.emit('room:update');
    res.json({ ok: true });
  });

  return router;
}
