import { Router }        from 'express';
import bcrypt            from 'bcrypt';
import jwt               from 'jsonwebtoken';
import crypto            from 'crypto';
import { OAuth2Client }  from 'google-auth-library';
import rateLimit         from 'express-rate-limit';
import { Resend } from 'resend';
import { createElement } from 'react';
import VerifyEmailTemplate  from '../emails/VerifyEmail.jsx';
import ResetPasswordTemplate from '../emails/ResetPassword.jsx';
import WelcomeTemplate       from '../emails/Welcome.jsx';
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
  message:         { error: 'Demasiados intentos. Esperá 15 minutos.' },
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
  const base = name.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  let candidate = base || 'user';
  let i = 2;
  while (true) {
    const [ex] = excludeId
      ? await sql.query('SELECT id FROM users WHERE username = $1 AND id != $2', [candidate, excludeId])
      : await sql`SELECT id FROM users WHERE username = ${candidate}`;
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

function validateUser(user) {
  if (!user || user.length < 6)  return 'El nombre debe tener al menos 6 caracteres';
  if (user.length >= 20) return 'El nombre tiene un límite de 20 caracteres';
  return null;
}

function validateUsername(username) {
  if (!username)                       return 'El nombre de usuario no puede estar vacío';
  if (username.length < 3)             return 'El nombre de usuario debe tener al menos 3 caracteres';
  if (username.length > 20)            return 'El nombre de usuario tiene un límite de 20 caracteres';
  if (!/^[a-z0-9_]+$/.test(username))  return 'El nombre de usuario solo puede contener letras, números y guiones bajos';
  return null;
}

// Bloquea si hay 5+ intentos fallidos del mismo email en los últimos 15 min
async function checkLoginAttempts(sql, email) {
  const since = new Date(Date.now() - 15 * 60 * 1000);
  const [{ count }] = await sql`
    SELECT COUNT(*)::int AS count FROM login_attempts
    WHERE identifier = LOWER(${email}) AND created_at > ${since}
  `;
  return count >= 5;
}

async function recordFailedAttempt(sql, email) {
  await sql`INSERT INTO login_attempts (id, identifier) VALUES (${uid()}, LOWER(${email}))`;
}

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

// ── POST /api/auth/register ───────────────────────────────────────────────────
router.post('/register', async (req, res, next) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name)
      return res.status(400).json({ error: 'Email, Contraseña y Nombre son requeridos' });

    const pwError = validatePassword(password);
    if (pwError) return res.status(400).json({ error: pwError });
    
    const sql = getDb();
    const [existing] = await sql`SELECT id FROM users WHERE email = LOWER(${email})`;
    if (existing) return res.status(409).json({ error: 'Ya existe una cuenta con ese email. Intente recuperar la contraseña si no la recuerda.' });
    
    const password_hash = await bcrypt.hash(password, 10);
    const userError = validateUser(name);
    if (userError) return res.status(400).json({ error: userError });

    // Username: usar el elegido por el usuario (si lo envió) o generar uno libre
    let username;
    if (req.body.username !== undefined && req.body.username !== '') {
      const trimmed = String(req.body.username).trim().toLowerCase();
      const unameError = validateUsername(trimmed);
      if (unameError) return res.status(400).json({ error: unameError });
      const [taken] = await sql`SELECT id FROM users WHERE username = ${trimmed}`;
      if (taken) return res.status(409).json({ error: 'Ese nombre de usuario ya está en uso' });
      username = trimmed;
    } else {
      username = await generateUsername(sql, name);
    }

    const [user] = await sql`
      INSERT INTO users (id, email, password_hash, name, username)
      VALUES (${uid()}, LOWER(${email}), ${password_hash}, ${name.trim()}, ${username})
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
    const sql = getDb();

    const blocked = await checkLoginAttempts(sql, email);
    if (blocked)
      return res.status(429).json({ error: 'Cuenta bloqueada temporalmente. Esperá 15 minutos.' });

    const [user] = await sql`SELECT * FROM users WHERE email = LOWER(${email})`;

    if (!user || !user.password_hash) {
      await recordFailedAttempt(sql, email);
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      await recordFailedAttempt(sql, email);
      return res.status(401).json({ error: 'Email o contraseña incorrectos' });
    }

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
      SELECT id, email, name, username, avatar_url, role, created_at, social_links FROM users WHERE id = ${id}
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
      WHERE username ILIKE ${'%' + q + '%'} OR name ILIKE ${'%' + q + '%'}
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
    const [taken] = await sql`SELECT id FROM users WHERE username = ${username}`;
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
      SELECT id, email, name, username, avatar_url, created_at
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

    await sql`UPDATE users SET password_hash = ${password_hash} WHERE id = ${reset.user_id}`;
    await sql`UPDATE password_resets SET used = true WHERE id = ${reset.id}`;
    // Invalidar todas las sesiones activas del usuario
    await sql`DELETE FROM refresh_tokens WHERE user_id = ${reset.user_id}`;

    res.clearCookie('access_token',  cookieOpts(0));
    res.clearCookie('refresh_token', cookieOpts(0));

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── PATCH /api/auth/me ────────────────────────────────────────────
router.patch('/me', requireAuth, async (req, res, next) => {
  try {
    const { name, username, current_password, new_password, social_links, bio } = req.body;
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
      const [existing] = await sql`SELECT id FROM users WHERE username = ${trimmed} AND id != ${req.user.id}`;
      if (existing) return res.status(409).json({ error: 'Ese nombre de usuario ya está en uso' });
      updates.username = trimmed;
    }

    // Bio
    if (bio !== undefined) {
      updates.bio = bio.trim().slice(0, 200) || null;
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
      `UPDATE users SET ${setClauses} WHERE id = $${keys.length + 1} RETURNING id, name, username, avatar_url, social_links, bio`,
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
    const [user] = await sql`SELECT id, password_hash FROM users WHERE id = ${req.user.id}`;
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    if (user.password_hash) {
      const { password } = req.body ?? {};
      if (!password) return res.status(400).json({ error: 'Ingresá tu contraseña para confirmar' });
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid)  return res.status(400).json({ error: 'La contraseña es incorrecta' });
    }

    await deleteUserAccount(user.id);

    res.clearCookie('access_token',  cookieOpts(0));
    res.clearCookie('refresh_token', cookieOpts(0));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;