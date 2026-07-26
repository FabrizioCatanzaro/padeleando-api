import 'dotenv/config';
import express     from 'express';
import cors        from 'cors';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import morgan      from 'morgan';

import groupsRouter         from './routes/groups.js';
import clubsRouter          from './routes/clubs.js';
import followsRouter        from './routes/follows.js';
import notificationsRouter  from './routes/notifications.js';
import playersRouter     from './routes/players.js';
import tournamentsRouter from './routes/tournaments.js';
import matchesRouter     from './routes/matches.js';
import pairsRouter       from './routes/pairs.js';
import readonlyRouter    from './routes/readonly.js';
import authRouter        from './routes/auth.js';
import invitationsRouter    from './routes/invitations.js';
import joinRequestsRouter   from './routes/join-requests.js';
import collaboratorsRouter  from './routes/collaborators.js';
import subscriptionsRouter  from './routes/subscriptions.js';
import photosRouter         from './routes/photos.js';
import adminRouter          from './routes/admin.js';
import inboundRouter        from './routes/inbound.js';
import { getDb } from './db.js';

const app  = express();
const PORT = process.env.PORT ?? 3001;
const IS_PROD = process.env.NODE_ENV === 'production';

// Render sirve detrás de un proxy: sin esto req.ip devuelve la IP del proxy y
// los rate limiters de /auth agrupan a todos los usuarios en un mismo cubo.
// El 1 (en vez de true) confía sólo en el primer salto: la IP no se puede falsear
// agregando X-Forwarded-For desde el cliente.
app.set('trust proxy', 1);

const ORIGINS = (process.env.CORS_ORIGIN ?? 'http://localhost:3000').split(',');

app.use(cors({
  origin: (origin, cb) => {
    // Permitir requests sin origin (Postman, curl) en dev
    if (!origin || ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,   // ← necesario para enviar/recibir cookies cross-origin
  // Los GET ya no disparan preflight (el cliente no manda Content-Type sin
  // cuerpo), pero las mutaciones sí. Sin maxAge el navegador sólo cachea la
  // respuesta 5 s y vuelve a preguntar en cada tanda de escrituras.
  maxAge: 86400,
}));

// Comprime las respuestas JSON antes de los routers. Los payloads de esta API
// (filas de matches/players/pairs con claves repetidas) comprimen ~6:1.
app.use(compression());

// 'dev' emite colores ANSI pensados para terminal: en el log agregado de Render
// ensucian la salida y no son parseables.
app.use(morgan(IS_PROD ? 'combined' : 'dev'));
app.use(cookieParser());

// El webhook de Resend (inbound email) necesita el body crudo para verificar la
// firma svix, así que su parser raw va ANTES del express.json() global.
app.use('/api/emails/webhook', express.raw({ type: 'application/json' }));

app.use(express.json());

// Las mutaciones sin cuerpo (DELETE /matches/:id, POST /follows/:username y
// otras 25) ya no mandan Content-Type, para no arrastrar un preflight CORS.
// Sin ese encabezado express.json() no parsea y en Express 5 req.body queda
// undefined, así que un `const { x } = req.body` tiraría TypeError. Se
// normaliza acá en vez de en cada ruta.
app.use((req, _res, next) => { if (req.body === undefined) req.body = {}; next(); });

// ── Política de caché ────────────────────────────────────────────────────────
// Antes todo respondía `no-store`, que es la directiva más agresiva del
// estándar: prohíbe la caché privada, la compartida y también la revalidación
// condicional, anulando el ETag que Express ya calcula. Consecuencia: el
// polling de la vista de espectador no podía resolverse nunca con un 304.
//
// Ahora se distingue por naturaleza del recurso. `private, no-cache` sigue
// garantizando frescura —el navegador revalida siempre— pero permite el 304.

// Contenido público de lectura: tolera unos segundos de desfase.
const PUBLIC_CACHEABLE = [
  '/api/readonly',
  '/api/groups/featured',
  '/api/groups/search',
  '/api/groups/nearby',
  '/api/clubs',
];

// Datos sensibles o de sesión: nunca se guardan, ni siquiera en disco.
const NEVER_STORE = [
  '/api/auth',
  '/api/subscriptions',
  '/api/admin',
  '/api/notifications',
  '/api/invitations',
  '/api/emails',
];

app.use((req, res, next) => {
  if (req.method !== 'GET') {
    res.set('Cache-Control', 'no-store');
  } else if (NEVER_STORE.some((p) => req.path.startsWith(p))) {
    res.set('Cache-Control', 'no-store');
  } else if (PUBLIC_CACHEABLE.some((p) => req.path.startsWith(p))) {
    res.set('Cache-Control', 'public, max-age=10, stale-while-revalidate=60');
  } else {
    res.set('Cache-Control', 'private, no-cache');
  }
  next();
});

app.use('/api/auth',        authRouter);
app.use('/api/groups',      groupsRouter);
app.use('/api/clubs',       clubsRouter);
app.use('/api/players',     playersRouter);
app.use('/api/tournaments', tournamentsRouter);
app.use('/api/tournaments/:tournamentId/photos', photosRouter);
app.use('/api/matches',     matchesRouter);
app.use('/api/pairs',       pairsRouter);
app.use('/api/readonly',    readonlyRouter);
app.use('/api/invitations',    invitationsRouter);
app.use('/api/join-requests',  joinRequestsRouter);
app.use('/api/follows',        followsRouter);
app.use('/api/notifications',  notificationsRouter);
app.use('/api/subscriptions', subscriptionsRouter);
app.use('/api/admin',         adminRouter);
app.use('/api/emails',        inboundRouter);
// Rutas de co-organizadores y transferencia (paths absolutos: /groups/:id/..., /invites/...)
app.use('/api',               collaboratorsRouter);

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message ?? 'Error interno' });
});

app.listen(PORT, async () => {
  console.log(`Padeleando API en puerto ${PORT}`);
    try {
      const sql = getDb();
      await sql`SELECT 1`;
      console.log('DB conectada');
    } catch (err) {
      console.error('Error conectando a DB:', err.message);
    }
});