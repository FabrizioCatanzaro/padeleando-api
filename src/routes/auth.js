import { Router }        from 'express';
import bcrypt            from 'bcrypt';
import jwt               from 'jsonwebtoken';
import crypto            from 'crypto';
import { OAuth2Client }  from 'google-auth-library';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { Resend } from 'resend';
import { createElement } from 'react';
import VerifyEmailTemplate  from '../emails/VerifyEmail.jsx';
import ResetPasswordTemplate from '../emails/ResetPassword.jsx';
import WelcomeTemplate       from '../emails/Welcome.jsx';
import GoodbyeTemplate       from '../emails/Goodbye.jsx';
import { getDb }         from '../db.js';
import { uid }           from '../uid.js';
import { requireAuth } from '../middleware/auth.js';
import { uploadAvatar } from '../middleware/upload.js';
import { uploadBuffer, deleteByPublicId } from '../lib/cloudinary.js';
import { deleteUserAccount, ANON_ID } from '../lib/deleteUser.js';
import { getActiveSubscription } from './subscriptions.js';

const router       = Router();
const SECRET       = process.env.JWT_SECRET;
const IS_PROD      = process.env.NODE_ENV === 'production';
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ── Mailer ────────────────────────────────────────────────────────────────────
const resend     = new Resend(process.env.RESEND_API_KEY);
const MAIL_FROM  = process.env.MAIL_FROM || 'Padeleando <onboarding@resend.dev>';

// ── Rate limiting — máx 10 intentos por IP cada 15 min ────────────────────────
const loginLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             10,
  standardHeaders: true,
  legacyHeaders:   false,
  // Misma forma de respuesta que el bloqueo por email (con los segundos que
  // faltan de verdad), así el cliente tiene un solo caso que atender.
  handler: (req, res) => {
    const reset = req.rateLimit?.resetTime;
    const retryAfter = reset
      ? Math.max(1, Math.ceil((new Date(reset).getTime() - Date.now()) / 1000))
      : 15 * 60;
    return sendLocked(res, retryAfter, 'Demasiados intentos desde esta conexión.');
  },
});

const resendVerificationLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             5,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Demasiados pedidos. Esperá 15 minutos.' },
});

// Chequeo de username — endpoints públicos llamados en vivo al tipear, tope generoso
const usernameLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             60,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Demasiados pedidos. Esperá unos minutos.' },
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function cookieOpts(maxAge) {
  return {
    httpOnly: true,
    secure:   IS_PROD,
    sameSite: IS_PROD ? 'none' : 'lax',
    maxAge,
  };
}

function setAuthCookies(res, user) {
  // Access token: corta duración (15 min)
  const accessToken = jwt.sign(
    { id: user.id, email: user.email, name: user.name, username: user.username },
    SECRET,
    { expiresIn: '1h' }
  );
  // Refresh token: 3 horas, opaco
  const refreshToken = crypto.randomBytes(40).toString('hex');

  res.cookie('access_token',  accessToken,  cookieOpts(60 * 60 * 1000));
  res.cookie('refresh_token', refreshToken, cookieOpts(3 * 60 * 60 * 1000));

  return refreshToken;
}

async function saveRefreshToken(sql, userId, rawToken) {
  const hash      = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 3 * 60 * 60 * 1000);
  await sql`
    INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
    VALUES (${uid()}, ${userId}, ${hash}, ${expiresAt})
  `;
}

async function generateUsername(sql, name, excludeId = null) {
  // El nombre admite hasta NAME_MAX pero el username tope 20, así que hay que
  // recortar la base. Se reservan 4 chars para el sufijo `_2`, `_10`… que se
  // agrega cuando el candidato ya está tomado.
  const base = name.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
    .slice(0, 16).replace(/_+$/, '');
  let candidate = base || 'user';
  let i = 2;
  while (true) {
    // Un @username ocupado por una cuenta fantasma cuenta como libre: el registro
    // la va a reclamar. Si no, se sugeriría `fabri_2` teniendo `fabri` muerto.
    const [ex] = excludeId
      ? await sql.query(
          `SELECT u.id FROM users u WHERE u.username = $1 AND u.id != $2 AND ${ACCOUNT_REACHABLE}`,
          [candidate, excludeId])
      : await sql.query(
          `SELECT u.id FROM users u WHERE u.username = $1 AND ${ACCOUNT_REACHABLE}`,
          [candidate]);
    if (!ex) return candidate;
    candidate = `${base}_${i++}`;
  }
}

function validatePassword(password) {
  if (!password || password.length < 8)  return 'La contraseña debe tener al menos 8 caracteres';
  if (!/[A-Z]/.test(password))           return 'La contraseña debe tener al menos una mayúscula';
  if (!/[a-z]/.test(password))           return 'La contraseña debe tener al menos una minúscula';
  if (!/[0-9]/.test(password))           return 'La contraseña debe tener al menos un número';
  return null;
}

// El nombre visible es el nombre real de la persona, no un handle: tiene que
// entrar "María Fernanda Rodríguez" (24) o "Fernando Belasteguín" (20). El
// límite del username sigue siendo 20 y es otra cosa.
//
// El mínimo es 3 y no 2 aunque existan nombres de dos letras ("Li"): el
// username se deriva del nombre en generateUsername() y tiene un mínimo propio
// de 3, así que un nombre más corto haría que el sistema genere un username que
// él mismo rechazaría si lo escribieras a mano. 3 también es el umbral desde el
// que AuthView pide la sugerencia de username, con lo cual todo nombre válido
// recibe una.
const NAME_MIN = 3;
const NAME_MAX = 50;

function validateUser(user) {
  // Se valida sobre el nombre recortado porque es lo que termina guardado
  // (el INSERT hace name.trim()): los espacios de los bordes no cuentan ni
  // para el mínimo ni para el máximo.
  const name = (user || '').trim();
  if (name.length < NAME_MIN) return `El nombre debe tener al menos ${NAME_MIN} caracteres`;
  if (name.length > NAME_MAX) return `El nombre tiene un límite de ${NAME_MAX} caracteres`;
  return null;
}

function validateUsername(username) {
  if (!username)                       return 'El nombre de usuario no puede estar vacío';
  if (username.length < 3)             return 'El nombre de usuario debe tener al menos 3 caracteres';
  if (username.length > 20)            return 'El nombre de usuario tiene un límite de 20 caracteres';
  if (!/^[a-z0-9_]+$/.test(username))  return 'El nombre de usuario solo puede contener letras, números y guiones bajos';
  return null;
}

// ── Cuentas fantasma ─────────────────────────────────────────────────────────
// Una cuenta sin verificar cuyo enlace de verificación ya venció es inalcanzable:
// el login la rechaza (exige `email_verified_at`) y nadie puede completarla, pero
// su email y su @username quedan tomados para siempre. El caso típico es un typo
// en el mail al registrarse: el enlace se fue a una casilla ajena.
//
// Esas cuentas no bloquean nada — un registro nuevo las reclama y las borra.
// Se espera al vencimiento del enlace en vez de reclamarlas apenas se crean
// porque mientras el enlace sigue vivo el dueño legítimo puede estar por
// clickearlo, y pisarle la cuenta le rompería el alta. Una vez vencido no se
// pierde nada: esa fila ya no la puede verificar nadie.
//
// Va como texto y no dentro de un tagged template porque las tres queries que
// preguntan "¿está tomado?" (register, username-available y generateUsername)
// tienen que compartir exactamente la misma definición; interpolar un fragmento
// en un tagged template lo mandaría como valor, no como SQL. Requiere que la
// tabla users esté aliasada `u`.
const ACCOUNT_REACHABLE = `(
    u.email_verified_at IS NOT NULL
    OR EXISTS (SELECT 1 FROM email_verifications ev
                WHERE ev.user_id = u.id AND ev.used = false AND ev.expires_at > NOW())
  )`;

// ── Bloqueo por intentos fallidos ────────────────────────────────────────────
// Se bloquea a los 5 fallos dentro de una ventana deslizante de 15 min,
// contados por email + IP de origen.
//
// Por qué también la IP: contando sólo por email, cualquiera que supiera tu
// dirección te dejaba fuera de tu propia cuenta 15 min mandando 5 requests con
// una contraseña cualquiera. El contador es de quien intenta, no de la víctima.
// A cambio, un ataque repartido entre muchas IPs contra una misma cuenta ya no
// choca contra este tope: lo único que lo frena es el loginLimiter por IP de
// arriba (10 requests / 15 min cada una). Si alguna vez aparece tráfico así, el
// siguiente paso es un captcha tras el segundo fallo, no volver al tope global
// por email — eso reabre el bloqueo de cuentas ajenas.
//
// La espera que se le informa al usuario es la real, no la ventana entera: como
// la ventana desliza, el bloqueo cae en cuanto el 5º intento más reciente sale
// de los 15 min, que casi siempre es bastante antes. Decir "15 minutos" cuando
// faltan 3 hace que la gente se vaya de la app.
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS    = 15 * 60 * 1000;

// Con IPv6 una sola persona tiene un /64 entero para rotar, así que contar por
// dirección exacta no cuenta nada: ipKeyGenerator colapsa el prefijo a /56,
// igual que hacen los rate limiters de este archivo. El fallback 'unknown' evita
// que un req.ip vacío deje la columna en NULL y desactive el bloqueo sin ruido
// (en SQL, `ip = NULL` no matchea nunca).
function clientIpKey(req) {
  return req.ip ? ipKeyGenerator(req.ip) : 'unknown';
}

// Segundos que faltan para que ese intento salga de la ventana. 0 = ya no bloquea.
function retryAfterFrom(blockingAt) {
  if (!blockingAt) return 0;
  const ms = new Date(blockingAt).getTime() + LOGIN_WINDOW_MS - Date.now();
  return ms > 0 ? Math.ceil(ms / 1000) : 0;
}

// { count, retryAfter } — count = fallos de ese email desde esa IP en la ventana.
async function checkLoginAttempts(sql, email, ip) {
  const since = new Date(Date.now() - LOGIN_WINDOW_MS);
  const [row] = await sql`
    WITH recent AS (
      SELECT created_at, ROW_NUMBER() OVER (ORDER BY created_at DESC) AS rn
      FROM login_attempts
      WHERE identifier = LOWER(${email}) AND ip = ${ip} AND created_at > ${since}
    )
    SELECT (SELECT COUNT(*)::int FROM recent) AS count,
           (SELECT created_at FROM recent WHERE rn = ${MAX_LOGIN_ATTEMPTS}) AS blocking_at
  `;
  return { count: row.count, retryAfter: retryAfterFrom(row.blocking_at) };
}

// Registra el fallo y devuelve { count, retryAfter } ya contando este intento.
// Va en una sola sentencia para no gastar dos round-trips a Neon en el camino
// de error. Ojo con la semántica: los CTE que modifican datos no son visibles
// para los demás CTE del mismo statement, así que `recent` NO ve la fila recién
// insertada — por eso el count la suma aparte, y por eso la fila que marca el
// desbloqueo es la rn = MAX-1 de `recent` (la nueva es siempre la más nueva, así
// que al agregarla todas corren un lugar).
async function recordFailedAttempt(sql, email, ip) {
  const since = new Date(Date.now() - LOGIN_WINDOW_MS);
  const [row] = await sql`
    WITH ins AS (
      INSERT INTO login_attempts (id, identifier, ip) VALUES (${uid()}, LOWER(${email}), ${ip})
      RETURNING 1
    ), recent AS (
      SELECT created_at, ROW_NUMBER() OVER (ORDER BY created_at DESC) AS rn
      FROM login_attempts
      WHERE identifier = LOWER(${email}) AND ip = ${ip} AND created_at > ${since}
    )
    SELECT (SELECT COUNT(*)::int FROM recent) + (SELECT COUNT(*)::int FROM ins) AS count,
           (SELECT created_at FROM recent WHERE rn = ${MAX_LOGIN_ATTEMPTS - 1}) AS blocking_at
  `;
  return { count: row.count, retryAfter: retryAfterFrom(row.blocking_at) };
}

function waitLabel(seconds) {
  if (seconds <= 60) return 'un minuto';
  return `${Math.ceil(seconds / 60)} minutos`;
}

// 429 de cuenta bloqueada. Lleva los segundos exactos para que el cliente pueda
// mostrar la cuenta regresiva en vivo en lugar de un texto fijo.
function sendLocked(res, retryAfter, prefix = 'Demasiados intentos fallidos.') {
  res.set('Retry-After', String(Math.max(1, retryAfter)));
  return res.status(429).json({
    error: `${prefix} Probá de nuevo en ${waitLabel(retryAfter)}, o restablecé tu contraseña.`,
    code: 'account_locked',
    retry_after_seconds: Math.max(1, retryAfter),
  });
}

// Credenciales incorrectas. Avisa cuántos intentos quedan para que el bloqueo no
// aparezca de la nada, y bloquea acá mismo cuando este fallo llega al tope, en
// lugar de dejar que el usuario lo descubra en el intento siguiente.
//
// `attempts_left` no filtra si la cuenta existe: el contador también corre para
// emails que no están registrados, así que la respuesta es idéntica en los dos
// casos (y el texto sigue siendo el genérico "email o contraseña").
async function failedLogin(sql, res, email, ip) {
  const { count, retryAfter } = await recordFailedAttempt(sql, email, ip);
  if (count >= MAX_LOGIN_ATTEMPTS) return sendLocked(res, retryAfter);

  const left = MAX_LOGIN_ATTEMPTS - count;
  return res.status(401).json({
    error: left === 1
      ? 'Email o contraseña incorrectos. Te queda 1 intento antes de que la cuenta se bloquee temporalmente.'
      : 'Email o contraseña incorrectos',
    attempts_left: left,
  });
}

// Borra los intentos de todas las IPs, no sólo la de quien acertó: quien demuestra
// que la cuenta es suya no tiene por qué arrastrar el contador de otro.
async function clearLoginAttempts(sql, email) {
  await sql`DELETE FROM login_attempts WHERE identifier = LOWER(${email})`;
}

async function sendVerificationEmail(sql, user) {
  await sql`DELETE FROM email_verifications WHERE user_id = ${user.id}`;

  const rawToken  = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await sql`
    INSERT INTO email_verifications (id, user_id, token_hash, expires_at)
    VALUES (${uid()}, ${user.id}, ${tokenHash}, ${expiresAt})
  `;

  const verifyUrl = `${process.env.FRONTEND_URL}/verify-email/${rawToken}`;

  await resend.emails.send({
    from:    MAIL_FROM,
    to:      user.email,
    subject: 'Confirmá tu email',
    react:   createElement(VerifyEmailTemplate, { name: user.name, verifyUrl }),
  });
}

// Mail de bienvenida tras verificar. No-bloqueante: nunca debe hacer fallar la verificación.
async function sendWelcomeEmail(user) {
  try {
    await resend.emails.send({
      from:    MAIL_FROM,
      to:      user.email,
      subject: '¡Bienvenido a Padeleando! 🎾',
      react:   createElement(WelcomeTemplate, { name: user.name, appUrl: process.env.FRONTEND_URL }),
    });
  } catch (err) {
    console.error('No se pudo enviar el mail de bienvenida:', err);
  }
}

// Mail de despedida al borrar la cuenta. No-bloqueante: el borrado ya ocurrió,
// un fallo del mail nunca debe hacer fallar la respuesta al usuario.
async function sendGoodbyeEmail(user) {
  try {
    await resend.emails.send({
      from:    MAIL_FROM,
      to:      user.email,
      subject: 'Te vamos a extrañar 💚',
      react:   createElement(GoodbyeTemplate, {
        name:      user.name,
        appUrl:    process.env.FRONTEND_URL,
        surveyUrl: process.env.SURVEY_URL || process.env.FRONTEND_URL,
      }),
    });
  } catch (err) {
    console.error('No se pudo enviar el mail de despedida:', err);
  }
}

// ── POST /api/auth/register ───────────────────────────────────────────────────
router.post('/register', async (req, res, next) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name)
      return res.status(400).json({ error: 'Email, Contraseña y Nombre son requeridos' });

    // Todas las validaciones sincrónicas van antes de tocar la base: más abajo el
    // alta puede borrar una cuenta fantasma, y eso no debe pasar si el registro
    // iba a fallar igual por un campo inválido.
    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });

    const userError = validateUser(name);
    if (userError) return res.status(400).json({ error: userError });

    // Username: el elegido por el usuario (si lo envió) o uno generado del nombre
    let wantedUsername = null;
    if (req.body.username !== undefined && req.body.username !== '') {
      wantedUsername = String(req.body.username).trim().toLowerCase();
      const unameError = validateUsername(wantedUsername);
      if (unameError) return res.status(400).json({ error: unameError });
    }

    const sql     = getDb();
    const emailLc = String(email).trim().toLowerCase();

    // Email y @username se consultan juntos: son independientes y cada tagged
    // template es una ida a São Paulo.
    const conflicts = await sql.query(
      `SELECT u.id, u.email, u.username, ${ACCOUNT_REACHABLE} AS reachable
         FROM users u
        WHERE u.email = $1 OR u.username = $2`,
      [emailLc, wantedUsername ?? '']
    );

    const byEmail = conflicts.find(u => u.email === emailLc);
    const byName  = wantedUsername ? conflicts.find(u => u.username === wantedUsername) : null;

    if (byEmail?.reachable)
      return res.status(409).json({ error: 'Ya existe una cuenta con ese email. Intente recuperar la contraseña si no la recuerda.' });
    if (byName?.reachable)
      return res.status(409).json({ error: 'Ese nombre de usuario ya está en uso' });

    const password_hash = await bcrypt.hash(password, 10);

    // Lo que sobrevive al chequeo son cuentas fantasma: se borran para liberar el
    // email y el @username. deleteUserAccount es más de lo que hace falta (una
    // cuenta sin verificar no puede tener nada colgando, el login la rechaza),
    // pero es el único lugar que conoce todas las FKs hacia users, así que esto
    // no se rompe si mañana aparece una nueva.
    const stale = [...new Set([byEmail, byName].filter(Boolean).map(u => u.id))];
    if (stale.length) await Promise.all(stale.map(id => deleteUserAccount(id)));

    // Después del borrado: si el fantasma ocupaba el username derivado del nombre,
    // recién ahora está libre y generateUsername lo puede devolver limpio.
    const username = wantedUsername ?? await generateUsername(sql, name);

    const [user] = await sql`
      INSERT INTO users (id, email, password_hash, name, username)
      VALUES (${uid()}, ${emailLc}, ${password_hash}, ${name.trim()}, ${username})
      RETURNING id, email, name, username, avatar_url, created_at
    `;

    await sendVerificationEmail(sql, user);

    res.status(201).json({ pending_verification: true, email: user.email });
  } catch (err) { next(err); }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body;
    // Sin email no hay contador que llevar: el identifier de login_attempts es
    // NOT NULL y el INSERT reventaría en un 500.
    if (!email || !password)
      return res.status(400).json({ error: 'Email o contraseña incorrectos' });

    const sql = getDb();
    const ip  = clientIpKey(req);

    const { count, retryAfter } = await checkLoginAttempts(sql, email, ip);
    if (count >= MAX_LOGIN_ATTEMPTS) return sendLocked(res, retryAfter);

    const [user] = await sql`SELECT * FROM users WHERE email = LOWER(${email})`;

    if (!user || !user.password_hash) return failedLogin(sql, res, email, ip);

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return failedLogin(sql, res, email, ip);

    if (!user.email_verified_at) {
      await clearLoginAttempts(sql, email);
      return res.status(403).json({
        error: 'Tenés que confirmar tu email antes de iniciar sesión. Revisá tu bandeja de entrada o la casilla de Spam.',
        needs_verification: true,
      });
    }

    await clearLoginAttempts(sql, email);

    const { password_hash, ...safeUser } = user;
    const refreshToken = setAuthCookies(res, safeUser);
    await saveRefreshToken(sql, user.id, refreshToken);

    const subscription = await getActiveSubscription(sql, user.id);
    res.json({ user: { ...safeUser, subscription } });
  } catch (err) { next(err); }
});

// ── POST /api/auth/google ─────────────────────────────────────────────────────
router.post('/google', async (req, res, next) => {
  try {
    const { credential } = req.body;
    const ticket = await googleClient.verifyIdToken({
      idToken:  credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const { sub: google_id, email, name } = ticket.getPayload();

    const sql = getDb();
    let [user] = await sql`SELECT * FROM users WHERE google_id = ${google_id}`;
    let isNewUser = false;

    if (!user) {
      const [byEmail] = await sql`SELECT * FROM users WHERE email = LOWER(${email})`;
      if (byEmail) {
        [user] = await sql`
          UPDATE users
          SET google_id = ${google_id},
              email_verified_at = COALESCE(email_verified_at, NOW())
          WHERE id = ${byEmail.id}
          RETURNING id, email, name, username, avatar_url, created_at
        `;
      } else {
        const username = await generateUsername(sql, name);
        [user] = await sql`
          INSERT INTO users (id, email, google_id, name, username, email_verified_at)
          VALUES (${uid()}, LOWER(${email}), ${google_id}, ${name}, ${username}, NOW())
          RETURNING id, email, name, username, avatar_url, created_at
        `;
        isNewUser = true;
      }
    }

    const { password_hash, ...safeUser } = user;
    const refreshToken = setAuthCookies(res, safeUser);
    await saveRefreshToken(sql, user.id, refreshToken);

    if (isNewUser) await sendWelcomeEmail(user);

    const subscription = await getActiveSubscription(sql, user.id);
    res.json({ user: { ...safeUser, subscription } });
  } catch (err) { next(err); }
});

// ── POST /api/auth/refresh ────────────────────────────────────────────────────
router.post('/refresh', async (req, res, next) => {
  try {
    const rawToken = req.cookies?.refresh_token;
    if (!rawToken) return res.status(401).json({ error: 'No hay refresh token' });

    const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const sql  = getDb();

    const [stored] = await sql`
      SELECT * FROM refresh_tokens
      WHERE token_hash = ${hash} AND expires_at > NOW()
    `;
    if (!stored) return res.status(401).json({ error: 'Refresh token inválido o expirado' });

    // Rotar — borrar el viejo, crear uno nuevo
    await sql`DELETE FROM refresh_tokens WHERE id = ${stored.id}`;

    const [user] = await sql`
      SELECT id, email, name, username, avatar_url, role FROM users WHERE id = ${stored.user_id}
    `;
    if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });

    const newRefreshToken = setAuthCookies(res, user);
    await saveRefreshToken(sql, user.id, newRefreshToken);

    const subscription = await getActiveSubscription(sql, user.id);
    res.json({ user: { ...user, subscription } });
  } catch (err) { next(err); }
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
router.post('/logout', async (req, res, next) => {
  try {
    const rawToken = req.cookies?.refresh_token;
    if (rawToken) {
      const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const sql  = getDb();
      await sql`DELETE FROM refresh_tokens WHERE token_hash = ${hash}`;
    }
    res.clearCookie('access_token',  cookieOpts(0));
    res.clearCookie('refresh_token', cookieOpts(0));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
router.get('/me', async (req, res, next) => {
  try {
    const token = req.cookies?.access_token;
    if (!token) return res.status(401).json({ error: 'No autenticado' });
    const { id } = jwt.verify(token, SECRET);
    const sql = getDb();
    const [user] = await sql`
      SELECT id, email, name, username, avatar_url, role, created_at, social_links, bio, onboarding_role
      FROM users WHERE id = ${id}
    `;
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    const subscription = await getActiveSubscription(sql, id);
    res.json({ ...user, subscription });
  } catch { res.status(401).json({ error: 'Token inválido' }); }
});

// ── GET /api/auth/search?q= ───────────────────────────────────────────────────
router.get('/search', async (req, res, next) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json([]);
    const sql = getDb();
    const users = await sql`
      SELECT id, name, username, avatar_url, created_at FROM users
      WHERE id != ${ANON_ID}
        AND (username ILIKE ${'%' + q + '%'} OR name ILIKE ${'%' + q + '%'})
      LIMIT 10
    `;
    res.json(users);
  } catch (err) { next(err); }
});

// ── GET /api/auth/suggest-username?name= ─────────────────────────────────────
// Devuelve un nombre de usuario libre derivado del nombre dado.
router.get('/suggest-username', usernameLimiter, async (req, res, next) => {
  try {
    const name = (req.query.name || '').toString();
    const sql  = getDb();
    const username = await generateUsername(sql, name);
    res.json({ username });
  } catch (err) { next(err); }
});

// ── GET /api/auth/username-available?username= ───────────────────────────────
// Valida formato y verifica que el nombre de usuario no esté en uso.
router.get('/username-available', usernameLimiter, async (req, res, next) => {
  try {
    const username = (req.query.username || '').toString().trim().toLowerCase();
    const error = validateUsername(username);
    if (error) return res.json({ available: false, error });
    const sql = getDb();
    // Mismo criterio que el registro: si lo ocupa una cuenta fantasma está libre,
    // porque el alta la va a reclamar. Si no, el formulario marcaría "ya está en
    // uso" un username que el registro sí acepta.
    const [taken] = await sql.query(
      `SELECT u.id FROM users u WHERE u.username = $1 AND ${ACCOUNT_REACHABLE}`, [username]);
    res.json({ available: !taken, error: taken ? 'Ese nombre de usuario ya está en uso' : null });
  } catch (err) { next(err); }
});

// ── POST /api/auth/verify-email ──────────────────────────────────────────────
router.post('/verify-email', async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token requerido' });

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const sql       = getDb();

    const [verification] = await sql`
      SELECT * FROM email_verifications
      WHERE token_hash = ${tokenHash} AND used = false AND expires_at > NOW()
    `;
    if (!verification)
      return res.status(400).json({ error: 'El enlace es inválido o ya expiró' });

    await sql`UPDATE users SET email_verified_at = NOW() WHERE id = ${verification.user_id}`;
    await sql`UPDATE email_verifications SET used = true WHERE id = ${verification.id}`;

    const [user] = await sql`
      SELECT id, email, name, username, avatar_url, created_at, onboarding_role
      FROM users WHERE id = ${verification.user_id}
    `;
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const refreshToken = setAuthCookies(res, user);
    await saveRefreshToken(sql, user.id, refreshToken);

    await sendWelcomeEmail(user);

    res.json({ user });
  } catch (err) { next(err); }
});

// ── POST /api/auth/resend-verification ───────────────────────────────────────
router.post('/resend-verification', resendVerificationLimiter, async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.json({ ok: true });

    const sql = getDb();
    const [user] = await sql`
      SELECT id, email, name, email_verified_at FROM users WHERE email = LOWER(${email})
    `;

    if (user && !user.email_verified_at) {
      await sendVerificationEmail(sql, user);
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /api/auth/forgot-password ───────────────────────────────────────────
router.post('/forgot-password', async (req, res, next) => {
  try {
    const { email } = req.body;
    const sql = getDb();
    const [user] = await sql`SELECT id, name FROM users WHERE email = LOWER(${email})`;

    // Siempre responder igual para no revelar si el email existe
    if (!user) return res.json({ ok: true });

    // Invalidar tokens anteriores
    await sql`DELETE FROM password_resets WHERE user_id = ${user.id}`;

    const rawToken  = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hora

    await sql`
      INSERT INTO password_resets (id, user_id, token_hash, expires_at)
      VALUES (${uid()}, ${user.id}, ${tokenHash}, ${expiresAt})
    `;

    const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${rawToken}`;

    await resend.emails.send({
      from:    MAIL_FROM,
      to:      email,
      subject: 'Recuperá tu contraseña',
      react:   createElement(ResetPasswordTemplate, { name: user.name, resetUrl }),
    });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /api/auth/reset-password ────────────────────────────────────────────
router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, password } = req.body;
    if (!token || !password)
      return res.status(400).json({ error: 'token y password son requeridos' });

    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const sql       = getDb();

    const [reset] = await sql`
      SELECT * FROM password_resets
      WHERE token_hash = ${tokenHash} AND used = false AND expires_at > NOW()
    `;
    if (!reset) return res.status(400).json({ error: 'El enlace es inválido o ya expiró' });

    const password_hash = await bcrypt.hash(password, 10);

    // Ninguna de las cuatro depende del resultado de las otras: en serie eran
    // cuatro viajes a São Paulo sobre el driver HTTP de Neon.
    await Promise.all([
      sql`UPDATE users SET password_hash = ${password_hash} WHERE id = ${reset.user_id}`,
      sql`UPDATE password_resets SET used = true WHERE id = ${reset.id}`,
      // Invalidar todas las sesiones activas del usuario
      sql`DELETE FROM refresh_tokens WHERE user_id = ${reset.user_id}`,
      // Levantar el bloqueo por intentos fallidos. Sin esto el consejo de
      // "restablecé tu contraseña" era una salida falsa: el reset no deja la
      // sesión iniciada, así que la persona volvía al login y se comía el
      // bloqueo igual, ahora con una contraseña nueva. Quien probó que controla
      // el email ya no es sospechoso.
      sql`DELETE FROM login_attempts
          WHERE identifier = (SELECT LOWER(email) FROM users WHERE id = ${reset.user_id})`,
    ]);

    res.clearCookie('access_token',  cookieOpts(0));
    res.clearCookie('refresh_token', cookieOpts(0));

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── PATCH /api/auth/me ────────────────────────────────────────────
router.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const { name, username, current_password, new_password, social_links, bio, advanced_stats_public, onboarding_role } = req.body;
    const sql = getDb();

    const [user] = await sql`SELECT * FROM users WHERE id = ${req.user.id}`;
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    const updates = {};

    // Cambio de nombre (no regenera el username)
    if (name !== undefined) {
      const trimmed = name.trim();
      const userError = validateUser(trimmed);
      if (userError) return res.status(400).json({ error: userError });
      if (!trimmed) return res.status(400).json({ error: 'El nombre no puede estar vacío' });
      updates.name = trimmed;
    }

    // Cambio de username independiente
    if (username !== undefined) {
      const trimmed = username.trim().toLowerCase();
      if (!trimmed) return res.status(400).json({ error: 'El nombre de usuario no puede estar vacío' });
      if (trimmed.length < 3) return res.status(400).json({ error: 'El nombre de usuario debe tener al menos 3 caracteres' });
      if (trimmed.length > 20) return res.status(400).json({ error: 'El nombre de usuario tiene un límite de 20 caracteres' });
      if (!/^[a-z0-9_]+$/.test(trimmed)) return res.status(400).json({ error: 'El nombre de usuario solo puede contener letras, números y guiones bajos' });
      // Mismo criterio que el registro y que /username-available: una cuenta
      // fantasma no bloquea el @username, se la reclama. Hay que borrarla igual
      // aunque no bloquee, o el UPDATE choca contra el UNIQUE de username.
      const [existing] = await sql.query(
        `SELECT u.id, ${ACCOUNT_REACHABLE} AS reachable
           FROM users u WHERE u.username = $1 AND u.id != $2`,
        [trimmed, req.user.id]);
      if (existing?.reachable) return res.status(409).json({ error: 'Ese nombre de usuario ya está en uso' });
      if (existing) await deleteUserAccount(existing.id);
      updates.username = trimmed;
    }

    // Bio
    if (bio !== undefined) {
      updates.bio = bio.trim().slice(0, 200) || null;
    }

    // Visibilidad de las estadísticas avanzadas del perfil (sólo premium).
    // Apagarlo siempre se permite: si la cuenta dejó de ser premium igual tiene
    // que poder volver a privado.
    if (advanced_stats_public !== undefined) {
      if (typeof advanced_stats_public !== 'boolean')
        return res.status(400).json({ error: 'advanced_stats_public debe ser booleano' });
      if (advanced_stats_public) {
        const [premium] = await sql`
          SELECT 1 FROM subscriptions
          WHERE user_id = ${req.user.id} AND status = 'active' AND plan = 'premium'
        `;
        if (!premium)
          return res.status(403).json({ error: 'Publicar las estadísticas avanzadas es una función premium' });
      }
      updates.advanced_stats_public = advanced_stats_public;
    }

    // A qué vino: sólo decide qué le muestra la portada, así que no hay nada que
    // proteger. Se puede cambiar las veces que quiera.
    if (onboarding_role !== undefined) {
      if (onboarding_role !== 'organizer' && onboarding_role !== 'player')
        return res.status(400).json({ error: 'onboarding_role debe ser organizer o player' });
      updates.onboarding_role = onboarding_role;
    }

    // Redes sociales
    if (social_links !== undefined) {
      if (!Array.isArray(social_links)) return res.status(400).json({ error: 'social_links debe ser un arreglo' });
      updates.social_links = JSON.stringify(social_links.filter(l => l.url?.trim()));
    }

    // Cambio de contraseña
    if (new_password !== undefined) {
      if (!current_password)
        return res.status(400).json({ error: 'Ingresá tu contraseña actual' });

      const valid = await bcrypt.compare(current_password, user.password_hash);
      if (!valid)
        return res.status(400).json({ error: 'La contraseña actual es incorrecta' });

      const pwError = validatePassword(new_password);
      if (pwError) return res.status(400).json({ error: pwError });

      updates.password_hash = await bcrypt.hash(new_password, 10);
    }

    if (Object.keys(updates).length === 0)
      return res.json({ id: user.id, name: user.name, username: user.username });

    const keys = Object.keys(updates);
    const values = Object.values(updates);
    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const [updated] = await sql.query(
      `UPDATE users SET ${setClauses} WHERE id = $${keys.length + 1} RETURNING id, name, username, avatar_url, social_links, bio, advanced_stats_public, onboarding_role`,
      [...values, req.user.id]
    );

    res.json(updated);
  } catch (err) { next(err); }
});

// ── POST /api/auth/me/avatar ─────────────────────────────────────────────────
// Sube/reemplaza el avatar del usuario autenticado (cualquier plan).
router.post('/me/avatar', requireAuth, uploadAvatar, async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se envió imagen' });
    const sql = getDb();

    const [current] = await sql`
      SELECT avatar_public_id FROM users WHERE id = ${req.user.id}
    `;

    const result = await uploadBuffer(req.file.buffer, {
      folder: 'padeliando/avatars',
    });

    if (current?.avatar_public_id) {
      await deleteByPublicId(current.avatar_public_id);
    }

    const [updated] = await sql`
      UPDATE users
      SET    avatar_url       = ${result.secure_url},
             avatar_public_id = ${result.public_id}
      WHERE  id = ${req.user.id}
      RETURNING id, name, username, avatar_url
    `;

    res.json(updated);
  } catch (err) { next(err); }
});

// ── DELETE /api/auth/me/avatar ───────────────────────────────────────────────
router.delete('/me/avatar', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const [current] = await sql`
      SELECT avatar_public_id FROM users WHERE id = ${req.user.id}
    `;
    if (current?.avatar_public_id) {
      await deleteByPublicId(current.avatar_public_id);
    }
    await sql`
      UPDATE users
      SET    avatar_url = NULL, avatar_public_id = NULL
      WHERE  id = ${req.user.id}
    `;
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── DELETE /api/auth/me ──────────────────────────────────────────────────────
// El usuario borra su propia cuenta. Si tiene contraseña, la exige como confirmación.
// (Los usuarios de solo-Google no tienen password_hash y confirman desde el modal.)
router.delete('/me', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const [user] = await sql`SELECT id, email, name, password_hash FROM users WHERE id = ${req.user.id}`;
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    if (user.password_hash) {
      const { password } = req.body ?? {};
      if (!password) return res.status(400).json({ error: 'Ingresá tu contraseña para confirmar' });
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid)  return res.status(400).json({ error: 'La contraseña es incorrecta' });
    }

    await deleteUserAccount(user.id);

    // Despedida (no-bloqueante). Capturamos email/name antes del borrado.
    await sendGoodbyeEmail(user);

    res.clearCookie('access_token',  cookieOpts(0));
    res.clearCookie('refresh_token', cookieOpts(0));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;