// Clipes: os últimos 30 s / 1 min / 2 min de uma live, gerados pelo serviço "recorder".
//
// O recorder fica gravando cada live em pedaços de ~4 s (sem recodificar) e, quando
// alguém clipa, junta os pedaços num MP4/WebM dentro do volume compartilhado.
// Aqui ficam os metadados, as permissões e a limpeza: clipe não salvo some em 24 h.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { requireUser } from './auth.js';
import { getRoomState, liveEvents } from './livekit.js';

const CLIPS_DIR = process.env.CLIPS_DIR || '/data/clips';
const DB_FILE = path.join(CLIPS_DIR, 'clips.json');
const RECORDER_URL = process.env.RECORDER_URL || 'http://recorder:8090';
const UNSAVED_TTL_MS = 24 * 60 * 60 * 1000;
const ALLOWED_SECONDS = [30, 60, 120];

let clips = [];
let writing = Promise.resolve();

async function load() {
  try {
    clips = JSON.parse(await fs.readFile(DB_FILE, 'utf8'));
  } catch {
    clips = [];
  }
}

// Escrita atômica e em fila (evita corromper o arquivo com duas gravações ao mesmo tempo)
function persist() {
  writing = writing.then(async () => {
    const tmp = `${DB_FILE}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(clips, null, 1));
    await fs.rename(tmp, DB_FILE);
  });
  return writing;
}

function publicClip(clip, user) {
  return {
    id: clip.id,
    url: `/clips/${clip.file}`,
    page: `/clip/${clip.id}`,
    mime: clip.mime,
    size: clip.size,
    seconds: clip.seconds,
    duration: clip.duration,
    streamer: clip.streamerName,
    creator: clip.creatorName,
    createdAt: clip.createdAt,
    saved: clip.saved,
    expiresAt: clip.saved ? null : clip.createdAt + UNSAVED_TTL_MS,
    mine: !!user && clip.creatorId === user.id,
  };
}

async function removeClip(clip) {
  await fs.rm(path.join(CLIPS_DIR, clip.file), { force: true });
  clips = clips.filter((c) => c.id !== clip.id);
}

async function cleanup() {
  const now = Date.now();
  const expired = clips.filter((c) => !c.saved && now - c.createdAt > UNSAVED_TTL_MS);
  for (const clip of expired) await removeClip(clip);
  if (expired.length) {
    await persist();
    console.log(`[clips] ${expired.length} clipe(s) não salvo(s) apagado(s) (mais de 24 h)`);
  }
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function clipsRouter() {
  await fs.mkdir(CLIPS_DIR, { recursive: true });
  await load();
  await cleanup();
  setInterval(() => cleanup().catch((e) => console.error('[clips] limpeza:', e.message)), 10 * 60 * 1000).unref();

  const router = express.Router();

  // Arquivos dos clipes: link "não listado" (id aleatório), pra abrir direto no Discord
  router.use(
    '/clips',
    express.static(CLIPS_DIR, {
      index: false,
      dotfiles: 'deny',
      setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=86400'),
    }),
  );

  router.get('/api/clips', requireUser, (req, res) => {
    const list = [...clips].sort((a, b) => b.createdAt - a.createdAt).map((c) => publicClip(c, req.user));
    res.json({ clips: list, ttlHours: UNSAVED_TTL_MS / 3600000 });
  });

  router.post('/api/clips', requireUser, express.json(), async (req, res) => {
    const seconds = Number(req.body?.seconds);
    const identity = String(req.body?.streamer || '');
    if (!ALLOWED_SECONDS.includes(seconds)) return res.status(400).json({ error: 'Duração inválida.' });

    const state = await getRoomState();
    const streamer = state.streamers.find((s) => s.identity === identity && s.live);
    if (!streamer) return res.status(404).json({ error: 'Essa live não está no ar.' });

    const id = crypto.randomBytes(9).toString('base64url');
    let made;
    try {
      const r = await fetch(`${RECORDER_URL}/clip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity, seconds, id }),
        signal: AbortSignal.timeout(60_000),
      });
      made = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(made.error || `recorder respondeu ${r.status}`);
    } catch (err) {
      console.error('[clips] falha ao clipar:', err.message);
      return res.status(502).json({ error: 'Não consegui gerar o clipe. Tente de novo em alguns segundos.' });
    }

    const clip = {
      id,
      file: made.file,
      mime: made.mime,
      size: made.size,
      duration: made.duration,
      seconds,
      streamerIdentity: identity,
      streamerName: streamer.name,
      creatorId: req.user.id,
      creatorName: req.user.name,
      createdAt: Date.now(),
      saved: false,
    };
    clips.push(clip);
    await persist();
    liveEvents.emit('clip:created', clip);
    res.json(publicClip(clip, req.user));
  });

  router.post('/api/clips/:id/save', requireUser, async (req, res) => {
    const clip = clips.find((c) => c.id === req.params.id);
    if (!clip) return res.status(404).json({ error: 'Clipe não encontrado (talvez já tenha expirado).' });
    if (clip.creatorId !== req.user.id) return res.status(403).json({ error: 'Só quem criou pode salvar.' });
    clip.saved = req.body?.saved !== false;
    await persist();
    res.json(publicClip(clip, req.user));
  });

  router.delete('/api/clips/:id', requireUser, async (req, res) => {
    const clip = clips.find((c) => c.id === req.params.id);
    if (!clip) return res.status(404).json({ error: 'Clipe não encontrado.' });
    if (clip.creatorId !== req.user.id) return res.status(403).json({ error: 'Só quem criou pode excluir.' });
    await removeClip(clip);
    await persist();
    res.json({ ok: true });
  });

  // Página do clipe, com metatags pro Discord mostrar o vídeo embutido
  router.get('/clip/:id', (req, res) => {
    const clip = clips.find((c) => c.id === req.params.id);
    if (!clip) return res.status(404).send('Clipe não encontrado (clipes não salvos expiram em 24 h).');
    const video = `${config.publicUrl}/clips/${clip.file}`;
    const title = `${clip.streamerName} • clipe de ${clip.seconds >= 60 ? `${clip.seconds / 60} min` : `${clip.seconds} s`}`;
    res.setHeader('Cache-Control', 'no-cache');
    res.send(`<!doctype html>
<html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Faz o L</title>
<meta property="og:site_name" content="Faz o L">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="Clipado por ${escapeHtml(clip.creatorName)}">
<meta property="og:type" content="video.other">
<meta property="og:video" content="${escapeHtml(video)}">
<meta property="og:video:secure_url" content="${escapeHtml(video)}">
<meta property="og:video:type" content="${escapeHtml(clip.mime)}">
<meta property="og:video:width" content="1280"><meta property="og:video:height" content="720">
<meta name="theme-color" content="#ed4245">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111214;color:#f2f3f5;font:15px system-ui,"Segoe UI",sans-serif;padding:16px;box-sizing:border-box}
main{width:min(1100px,100%)}video{width:100%;border-radius:14px;background:#000}h1{font-size:20px;margin:12px 0 4px}p{margin:0;color:#949ba4}a{color:#8ea1e1}</style>
</head><body><main>
<video src="${escapeHtml(video)}" controls autoplay playsinline></video>
<h1>${escapeHtml(title)}</h1>
<p>Clipado por ${escapeHtml(clip.creatorName)} • <a href="${escapeHtml(video)}" download>baixar</a> • <a href="/">abrir o Faz o L</a></p>
</main></body></html>`);
  });

  return router;
}
