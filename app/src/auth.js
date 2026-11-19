import crypto from 'node:crypto';
import express from 'express';
import { config } from './config.js';

const SESSION_COOKIE = 'fol_session';
const STATE_COOKIE = 'fol_state';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DISCORD_API = 'https://discord.com/api/v10';

// ---------- cookies assinados ----------

function sign(data) {
  return crypto.createHmac('sha256', config.sessionSecret).update(data).digest('base64url');
}

function encodeSession(user) {
  const data = Buffer.from(JSON.stringify({ ...user, exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  return `${data}.${sign(data)}`;
}

function decodeSession(value) {
  if (!value) return null;
  const [data, sig] = value.split('.');
  if (!data || !sig) return null;
  const expected = sign(data);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const session = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!session.exp || session.exp < Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieOptions(maxAge) {
  return { httpOnly: true, secure: config.secureCookies, sameSite: 'lax', maxAge, path: '/' };
}

function setSession(res, user) {
  res.cookie(SESSION_COOKIE, encodeSession(user), cookieOptions(SESSION_TTL_MS));
}

/** Middleware: popula req.user a partir do cookie. */
export function sessionMiddleware(req, _res, next) {
  req.cookies = parseCookies(req.headers.cookie);
  const session = decodeSession(req.cookies[SESSION_COOKIE]);
  req.user = session ? { id: session.id, name: session.name, avatar: session.avatar } : null;
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Faça login primeiro.' });
  next();
}

// ---------- helpers ----------

function cleanName(name) {
  return String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 32);
}

function discordAvatar(user) {
  if (user.avatar) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`;
  const index = Number((BigInt(user.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

async function discordFetch(path, accessToken) {
  const res = await fetch(`${DISCORD_API}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Discord ${path} respondeu ${res.status}`);
  return res.json();
}

// ---------- rotas ----------

export function authRouter() {
  const router = express.Router();
  const redirectUri = `${config.publicUrl}/auth/callback`;

  router.get('/auth/login', (req, res) => {
    if (config.authMode !== 'discord') return res.redirect('/');
    const state = crypto.randomBytes(16).toString('hex');
    res.cookie(STATE_COOKIE, state, cookieOptions(10 * 60 * 1000));
    const params = new URLSearchParams({
      client_id: config.discord.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: config.discord.guildId ? 'identify guilds' : 'identify',
      state,
      prompt: 'none',
    });
    res.redirect(`https://discord.com/oauth2/authorize?${params}`);
  });

  router.get('/auth/callback', async (req, res) => {
    const { code, state } = req.query;
    const expectedState = req.cookies[STATE_COOKIE];
    res.clearCookie(STATE_COOKIE, { path: '/' });
    if (!code || !state || state !== expectedState) return res.redirect('/?erro=login');

    try {
      const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.discord.clientId,
          client_secret: config.discord.clientSecret,
          grant_type: 'authorization_code',
          code: String(code),
          redirect_uri: redirectUri,
        }),
      });
      if (!tokenRes.ok) throw new Error(`token ${tokenRes.status}`);
      const { access_token: accessToken } = await tokenRes.json();

      const user = await discordFetch('/users/@me', accessToken);

      if (config.discord.guildId) {
        const guilds = await discordFetch('/users/@me/guilds', accessToken);
        if (!guilds.some((g) => g.id === config.discord.guildId)) return res.redirect('/?erro=servidor');
      }

      setSession(res, {
        id: `d${user.id}`,
        name: cleanName(user.global_name || user.username) || 'Sem nome',
        avatar: discordAvatar(user),
      });
      res.redirect('/');
    } catch (err) {
      console.error('[auth] Falha no login do Discord:', err.message);
      res.redirect('/?erro=login');
    }
  });

  router.post('/api/guest', express.json(), (req, res) => {
    if (config.authMode !== 'guest') return res.status(403).json({ error: 'Use o login do Discord.' });
    const name = cleanName(req.body?.name);
    if (name.length < 2) return res.status(400).json({ error: 'Escolha um apelido com pelo menos 2 letras.' });
    setSession(res, { id: `g${crypto.randomBytes(6).toString('hex')}`, name, avatar: '' });
    res.json({ ok: true });
  });

  router.post('/auth/logout', (req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  return router;
}
