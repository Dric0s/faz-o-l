import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { authRouter, sessionMiddleware } from './auth.js';
import { livekitRouter } from './livekit.js';
import { startBot } from './bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const livekitClientDist = path.dirname(require.resolve('livekit-client'));

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

app.get('/healthz', (_req, res) => res.send('ok'));

app.use(sessionMiddleware);
app.use(authRouter());
app.use(livekitRouter());

app.get('/api/me', (req, res) => {
  res.json({
    user: req.user,
    authMode: config.authMode,
    limits: { maxStreamers: config.maxStreamers, maxViewers: config.maxViewers },
  });
});

// SDK do LiveKit servido localmente (sem depender de CDN)
// "no-cache" = sempre revalida com o servidor (ETag): depois de atualizar o servidor,
// o site e o app desktop pegam o código novo na hora, sem esperar o cache expirar.
const revalidate = (res) => res.setHeader('Cache-Control', 'no-cache');

app.use(
  '/vendor/livekit',
  express.static(livekitClientDist, {
    setHeaders: (res, file) => {
      revalidate(res);
      if (file.endsWith('.mjs')) res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    },
  }),
);

app.use(express.static(path.join(__dirname, '..', 'public'), { setHeaders: revalidate }));

app.listen(config.port, () => {
  console.log(`[app] Faz o L rodando em ${config.publicUrl} (porta ${config.port}, login: ${config.authMode})`);
});

startBot().catch((err) => console.error('[bot] Não foi possível iniciar o bot:', err.message));
