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
import scheduledRouter   from './routes/scheduled.js';
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
import homeRouter           from './routes/home.js';
import bookingsRouter       from './routes/bookings.js';
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
  '/api/home',
  '/api/readonly',
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
  // "Mis reservas" del jugador: cruza todos los clubes en los que reservó,
  // dato tan privado como /api/auth -- nunca debe quedar en una caché
  // compartida (a diferencia de /api/clubs, que es mayormente lectura pública).
  '/api/bookings',
  // Sub-rutas sólo-admin de /api/clubs (solicitudes y reclamos pendientes):
  // van ANTES que '/api/clubs' en PUBLIC_CACHEABLE se evalúe, así que sin
  // esto quedaban agarradas por el "public, max-age=10, swr=60" de ahí abajo
  // (pensado para /api/clubs en general, que sí es lectura pública). Eso
  // hacía que el navegador sirviera la lista de "pendientes" desde caché
  // hasta 70s después de aprobar/rechazar una -- Fabri lo veía como "la
  // solicitud queda en pendiente hasta que refresco la página".
  '/api/clubs/requests',
  '/api/clubs/claims',
];

// Igual que arriba, pero para una sub-ruta que no empieza con un prefijo fijo
// (el id del club va en el medio): GET /api/clubs/:id/bookings/manage es la
// pantalla de gestión de reservas del dueño -- trae nombre/contacto de quien
// reservó, no es apta para el caché público de 10s de '/api/clubs' en
// general (mismo bug que requests/claims: los cambios tardaban en reflejarse
// al volver a la solapa).
const NEVER_STORE_PATTERNS = [/\/bookings\/manage$/];

// GET /api/clubs/:id y GET /api/clubs/:id/courts devuelven campos que
// dependen de QUIÉN mira (is_owner, can_manage_bookings, pending_bookings_count,
// y en /courts las canchas inactivas sólo para el dueño/admin) -- no pueden
// caer en la caché pública de PUBLIC_CACHEABLE de más abajo, que es
// "public" (compartida, sin Vary por cookie) y no distingue una respuesta
// calculada para el dueño de una calculada para cualquier otro. Bug real que
// reportó Fabri: iniciaba sesión con otra cuenta (no dueña del club) y
// seguía viendo la solapa RESERVAS del dueño hasta que expiraba la caché
// (hasta 60s de stale-while-revalidate) -- el navegador ni siquiera volvía
// a preguntarle al server. Van con la política default de acá abajo
// (private, no-cache): revalida siempre, y el ETag ya se ocupa de ahorrar
// ancho de banda cuando la respuesta no cambió. El negative lookahead deja
// afuera a /api/clubs/nearby, que tiene la misma forma de URL (un solo
// segmento tras /clubs/) pero sí es público y sin estado por usuario.
const VIEWER_DEPENDENT_PATTERNS = [
  /^\/api\/clubs\/(?!nearby$)[^/]+$/,
  /^\/api\/clubs\/[^/]+\/courts$/,
];

app.use((req, res, next) => {
  if (req.method !== 'GET') {
    res.set('Cache-Control', 'no-store');
  } else if (NEVER_STORE.some((p) => req.path.startsWith(p)) || NEVER_STORE_PATTERNS.some((r) => r.test(req.path))) {
    res.set('Cache-Control', 'no-store');
  } else if (VIEWER_DEPENDENT_PATTERNS.some((r) => r.test(req.path))) {
    res.set('Cache-Control', 'private, no-cache');
  } else if (PUBLIC_CACHEABLE.some((p) => req.path.startsWith(p))) {
    res.set('Cache-Control', 'public, max-age=10, stale-while-revalidate=60');
  } else {
    res.set('Cache-Control', 'private, no-cache');
  }
  next();
});

app.use('/api/home',        homeRouter);
app.use('/api/auth',        authRouter);
app.use('/api/groups',      groupsRouter);
app.use('/api/clubs',       clubsRouter);
app.use('/api/players',     playersRouter);
app.use('/api/tournaments', tournamentsRouter);
app.use('/api/tournaments/:tournamentId/photos', photosRouter);
app.use('/api/matches',     matchesRouter);
app.use('/api/scheduled',   scheduledRouter);
app.use('/api/pairs',       pairsRouter);
app.use('/api/readonly',    readonlyRouter);
app.use('/api/invitations',    invitationsRouter);
app.use('/api/join-requests',  joinRequestsRouter);
app.use('/api/follows',        followsRouter);
app.use('/api/notifications',  notificationsRouter);
app.use('/api/subscriptions', subscriptionsRouter);
app.use('/api/admin',         adminRouter);
app.use('/api/emails',        inboundRouter);
app.use('/api/bookings',      bookingsRouter);
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