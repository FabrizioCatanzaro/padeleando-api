import { Router }  from 'express';
import { Resend }   from 'resend';
import { createElement } from 'react';
import { getDb }    from '../db.js';
import { uid }      from '../uid.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { deleteUserAccount } from '../lib/deleteUser.js';
import { linkPreapprovalToUser } from './subscriptions.js';
import { mdToHtml, personalize } from '../lib/richText.js';
import AdminBroadcastTemplate from '../emails/AdminBroadcast.jsx';

const resend    = new Resend(process.env.RESEND_API_KEY);
const MAIL_FROM = process.env.MAIL_FROM || 'Padeleando <onboarding@resend.dev>';

const router = Router();

// Todas las rutas de este router requieren ser admin
router.use(requireAuth, requireAdmin);

// ── GET /api/admin/stats ─────────────────────────────────────────────────────
router.get('/stats', async (_req, res, next) => {
  try {
    const sql = getDb();
    const [row] = await sql`
      SELECT
        (SELECT COUNT(*) FROM users)::int                                                                AS total_users,
        (SELECT COUNT(*) FROM users WHERE email_verified_at IS NOT NULL)::int                            AS verified_users,
        (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '7 days')::int                   AS new_users_7d,
        (SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '30 days')::int                  AS new_users_30d,
        (SELECT COUNT(*) FROM groups)::int                                                               AS total_groups,
        (SELECT COUNT(*) FROM groups WHERE created_at > NOW() - INTERVAL '30 days')::int                 AS groups_30d,
        (SELECT COUNT(*) FROM tournaments)::int                                                          AS total_tournaments,
        (SELECT COUNT(*) FROM tournaments WHERE status = 'active')::int                                  AS active_tournaments,
        (SELECT COUNT(*) FROM tournaments WHERE created_at > NOW() - INTERVAL '7 days')::int             AS tournaments_7d,
        (SELECT COUNT(*) FROM tournaments WHERE created_at > NOW() - INTERVAL '30 days')::int            AS tournaments_30d,
        (SELECT COUNT(*) FROM matches)::int                                                              AS total_matches,
        (SELECT COUNT(*) FROM matches WHERE created_at > NOW() - INTERVAL '7 days')::int                 AS matches_7d,
        (SELECT COUNT(*) FROM matches WHERE created_at > NOW() - INTERVAL '30 days')::int                AS matches_30d,
        (SELECT COUNT(*) FROM players)::int                                                              AS total_players,
        (SELECT COUNT(*) FROM subscriptions
           WHERE plan = 'premium' AND status = 'active'
             AND (ends_at IS NULL OR ends_at > NOW()))::int                                              AS premium_users,
        (SELECT COUNT(*) FROM tournament_photos)::int                                                    AS total_photos
    `;
    res.json(row);
  } catch (err) { next(err); }
});

// ── GET /api/admin/users ─────────────────────────────────────────────────────
// Lista paginada de usuarios con buscador por email/username/name.
// Query params: q (string), page (1-indexed, default 1), limit (default 25, max 100)
router.get('/users', async (req, res, next) => {
  try {
    const sql    = getDb();
    const q      = (req.query.q ?? '').trim();
    const page   = Math.max(1, parseInt(req.query.page ?? '1', 10) || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit ?? '25', 10) || 25));
    const offset = (page - 1) * limit;
    const pat    = q ? `%${q}%` : null;

    const users = await sql`
      SELECT
        u.id, u.email, u.name, u.username, u.avatar_url, u.role,
        u.email_verified_at, u.created_at,
        sub.plan           AS plan,
        sub.billing_period AS billing_period,
        sub.ends_at        AS plan_ends_at,
        (SELECT COUNT(*)::int FROM groups g WHERE g.user_id = u.id)                                     AS groups_count,
        (SELECT COUNT(*)::int FROM tournaments t
           INNER JOIN groups g ON g.id = t.group_id
           WHERE g.user_id = u.id)                                                                      AS tournaments_count
      FROM users u
      LEFT JOIN LATERAL (
        SELECT plan, billing_period, ends_at FROM subscriptions
        WHERE user_id = u.id AND status = 'active' AND (ends_at IS NULL OR ends_at > NOW())
        ORDER BY created_at DESC LIMIT 1
      ) sub ON TRUE
      WHERE ${pat}::text IS NULL
         OR u.email    ILIKE ${pat}
         OR u.username ILIKE ${pat}
         OR u.name     ILIKE ${pat}
      ORDER BY u.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const [{ total }] = await sql`
      SELECT COUNT(*)::int AS total FROM users u
      WHERE ${pat}::text IS NULL
         OR u.email    ILIKE ${pat}
         OR u.username ILIKE ${pat}
         OR u.name     ILIKE ${pat}
    `;

    res.json({ users, total, page, limit });
  } catch (err) { next(err); }
});

// ── GET /api/admin/timeseries ────────────────────────────────────────────────
// Serie diaria de registros, torneos y partidos creados en los últimos N días.
// Query params: days (default 30, máx 180)
router.get('/timeseries', async (req, res, next) => {
  try {
    const sql  = getDb();
    const days = Math.min(180, Math.max(1, parseInt(req.query.days ?? '30', 10) || 30));

    const rows = await sql`
      SELECT
        s.day::date AS date,
        (SELECT COUNT(*)::int FROM users       WHERE created_at::date = s.day) AS users,
        (SELECT COUNT(*)::int FROM tournaments WHERE created_at::date = s.day) AS tournaments,
        (SELECT COUNT(*)::int FROM matches     WHERE created_at::date = s.day) AS matches
      FROM generate_series(
        (NOW() AT TIME ZONE 'UTC')::date - ((${days} - 1) || ' days')::interval,
        (NOW() AT TIME ZONE 'UTC')::date,
        '1 day'
      ) AS s(day)
      ORDER BY s.day
    `;

    res.json({ days, points: rows });
  } catch (err) { next(err); }
});

// ── GET /api/admin/tournaments ───────────────────────────────────────────────
// Lista paginada de torneos con buscador y filtro por estado.
// Query params: q (string), status ('all'|'active'|'finished'|'live'), page, limit
router.get('/tournaments', async (req, res, next) => {
  try {
    const sql    = getDb();
    const q      = (req.query.q ?? '').trim();
    const status = req.query.status ?? 'all';
    const page   = Math.max(1, parseInt(req.query.page ?? '1', 10) || 1);
    const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit ?? '25', 10) || 25));
    const offset = (page - 1) * limit;
    const pat    = q ? `%${q}%` : null;

    const tournaments = await sql`
      SELECT
        t.id, t.name, t.format, t.mode, t.status, t.created_at,
        (t.live_match IS NOT NULL) AS has_live,
        g.id        AS group_id,
        g.name      AS group_name,
        u.id        AS owner_id,
        u.username  AS owner_username,
        u.name      AS owner_name,
        u.avatar_url AS owner_avatar_url,
        (SELECT COUNT(*)::int FROM tournament_players tp WHERE tp.tournament_id = t.id) AS players_count,
        (SELECT COUNT(*)::int FROM matches m            WHERE m.tournament_id = t.id) AS matches_count
      FROM tournaments t
      INNER JOIN groups g ON g.id = t.group_id
      LEFT  JOIN users  u ON u.id = g.user_id
      WHERE (${pat}::text IS NULL
             OR t.name      ILIKE ${pat}
             OR g.name      ILIKE ${pat}
             OR u.username  ILIKE ${pat})
        AND (${status} = 'all'
             OR (${status} = 'live'     AND t.live_match IS NOT NULL)
             OR (${status} = 'active'   AND t.status = 'active')
             OR (${status} = 'finished' AND t.status = 'finished'))
      ORDER BY t.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const [{ total }] = await sql`
      SELECT COUNT(*)::int AS total
      FROM tournaments t
      INNER JOIN groups g ON g.id = t.group_id
      LEFT  JOIN users  u ON u.id = g.user_id
      WHERE (${pat}::text IS NULL
             OR t.name      ILIKE ${pat}
             OR g.name      ILIKE ${pat}
             OR u.username  ILIKE ${pat})
        AND (${status} = 'all'
             OR (${status} = 'live'     AND t.live_match IS NOT NULL)
             OR (${status} = 'active'   AND t.status = 'active')
             OR (${status} = 'finished' AND t.status = 'finished'))
    `;

    res.json({ tournaments, total, page, limit, status });
  } catch (err) { next(err); }
});

// ── POST /api/admin/users/:id/grant-premium ──────────────────────────────────
// Otorga premium "comp" al usuario. duration_days opcional (default 30).
router.post('/users/:id/grant-premium', async (req, res, next) => {
  try {
    const sql = getDb();
    const { id } = req.params;
    const preapprovalId = req.body?.preapproval_id?.trim();

    const [user] = await sql`SELECT id FROM users WHERE id = ${id}`;
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    // Si se pasa un preapproval_id, VINCULAR la suscripción real de MP: queda
    // activa y se auto-renueva cada mes (no hay que volver a otorgar a mano).
    if (preapprovalId) {
      const r = await linkPreapprovalToUser(sql, id, preapprovalId);
      if (!r.ok) return res.status(400).json({ error: r.error });
      const [linked] = await sql`
        SELECT id, plan, billing_period, status, starts_at, ends_at
        FROM subscriptions WHERE user_id = ${id} AND status = 'active'
        ORDER BY created_at DESC LIMIT 1
      `;
      return res.status(201).json(linked);
    }

    // Sin preapproval_id: cortesía por N días (comp, no se renueva).
    const days = Math.max(1, Math.min(365, parseInt(req.body?.duration_days ?? '30', 10) || 30));

    await sql`
      UPDATE subscriptions SET status = 'expired'
      WHERE user_id = ${id} AND status = 'active'
    `;

    const ends_at = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    const [created] = await sql`
      INSERT INTO subscriptions (id, user_id, plan, billing_period, status, ends_at)
      VALUES (${uid()}, ${id}, 'premium', 'trial', 'active', ${ends_at})
      RETURNING id, plan, billing_period, status, starts_at, ends_at
    `;

    res.status(201).json(created);
  } catch (err) { next(err); }
});

// ── POST /api/admin/users/:id/revoke-premium ─────────────────────────────────
// Cancela cualquier suscripción premium activa del usuario.
router.post('/users/:id/revoke-premium', async (req, res, next) => {
  try {
    const sql = getDb();
    const { id } = req.params;

    const result = await sql`
      UPDATE subscriptions
      SET status = 'cancelled', ends_at = NOW()
      WHERE user_id = ${id} AND status = 'active' AND plan = 'premium'
    `;

    res.json({ ok: true, cancelled: result.length ?? result.count ?? 0 });
  } catch (err) { next(err); }
});

// ── DELETE /api/admin/users/:id ──────────────────────────────────────────────
// Borra por completo la cuenta de un usuario (mismo efecto que el auto-borrado):
// sus grupos/torneos/fotos pasan a una cuenta anónima, el resto cae en cascada.
router.delete('/users/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (id === req.user.id)
      return res.status(400).json({ error: 'No podés borrar tu propia cuenta desde acá' });

    const deleted = await deleteUserAccount(id);
    if (!deleted) return res.status(404).json({ error: 'Usuario no encontrado' });

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /api/admin/broadcast ────────────────────────────────────────────────
// Envía una notificación de admin a un grupo de usuarios.
// Body: { title, body, target: 'all'|'free'|'premium'|'user',
//         target_user_ids?: string[] (o target_user_id legacy),
//         channel: 'app'|'app_email' }
// El body admite un subconjunto de Markdown (**negrita**, *itálica*, [texto](url)).
router.post('/broadcast', async (req, res, next) => {
  try {
    const sql = getDb();
    const { title, body, target, target_user_id, target_user_ids, channel } = req.body;

    if (!title?.trim() || !body?.trim())
      return res.status(400).json({ error: 'Título y cuerpo son requeridos' });
    if (!['all', 'free', 'premium', 'user'].includes(target))
      return res.status(400).json({ error: 'Target inválido' });
    if (!['app', 'app_email'].includes(channel))
      return res.status(400).json({ error: 'Canal inválido' });

    // Aceptar el array nuevo (target_user_ids) o el id único legacy (target_user_id).
    const targetIds = [...new Set(
      (Array.isArray(target_user_ids) ? target_user_ids : [])
        .concat(target_user_id ? [target_user_id] : [])
        .filter(Boolean),
    )];
    if (target === 'user' && targetIds.length === 0)
      return res.status(400).json({ error: 'Seleccioná al menos un usuario' });

    let users;
    if (target === 'all') {
      users = await sql`SELECT id, email, name FROM users WHERE email_verified_at IS NOT NULL`;
    } else if (target === 'free') {
      users = await sql`
        SELECT u.id, u.email, u.name FROM users u
        WHERE u.email_verified_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM subscriptions s
            WHERE s.user_id = u.id AND s.plan = 'premium' AND s.status = 'active'
              AND (s.ends_at IS NULL OR s.ends_at > NOW())
          )
      `;
    } else if (target === 'premium') {
      users = await sql`
        SELECT u.id, u.email, u.name FROM users u
        WHERE u.email_verified_at IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM subscriptions s
            WHERE s.user_id = u.id AND s.plan = 'premium' AND s.status = 'active'
              AND (s.ends_at IS NULL OR s.ends_at > NOW())
          )
      `;
    } else {
      users = await sql`SELECT id, email, name FROM users WHERE id = ANY(${targetIds})`;
      if (!users.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    if (!users.length)
      return res.status(400).json({ error: 'No hay usuarios destino para ese segmento' });

    const t = title.trim();
    const b = body.trim();

    // Insertar notificaciones en app. El cuerpo se personaliza por usuario
    // (reemplaza {nombre} por el nombre del destinatario).
    for (const u of users) {
      await sql`
        INSERT INTO notifications (id, user_id, type, title, body)
        VALUES (${uid()}, ${u.id}, 'admin_message', ${t}, ${personalize(b, u)})
      `;
    }

    // Enviar emails si corresponde. El cuerpo se renderiza por usuario (para
    // resolver {nombre}) desde el subconjunto de Markdown a HTML con estilos inline.
    if (channel === 'app_email') {
      const batchSize = 50;
      for (let i = 0; i < users.length; i += batchSize) {
        const batch = users.slice(i, i + batchSize);
        await Promise.allSettled(batch.map(u =>
          resend.emails.send({
            from:    MAIL_FROM,
            to:      u.email,
            subject: t,
            react:   createElement(AdminBroadcastTemplate, {
              title:    t,
              bodyHtml: mdToHtml(personalize(b, u)),
            }),
          })
        ));
      }
    }

    // Guardar en historial. target_user_id se conserva para el caso de 1 solo
    // destinatario (compatibilidad con el join del historial); la lista completa
    // va en target_user_ids.
    const singleTargetId = target === 'user' && targetIds.length === 1 ? targetIds[0] : null;
    const [broadcast] = await sql`
      INSERT INTO admin_broadcasts
        (id, admin_id, title, body, target, target_user_id, target_user_ids, channel, recipients)
      VALUES (
        ${uid()}, ${req.user.id}, ${t}, ${b}, ${target}, ${singleTargetId},
        ${target === 'user' ? JSON.stringify(targetIds) : null}::jsonb,
        ${channel}, ${users.length}
      )
      RETURNING *
    `;

    res.status(201).json({ ok: true, recipients: users.length, broadcast });
  } catch (err) { next(err); }
});

// ── GET /api/admin/broadcasts ────────────────────────────────────────────────
// Historial de broadcasts enviados. Query params: page, limit
router.get('/broadcasts', async (req, res, next) => {
  try {
    const sql    = getDb();
    const page   = Math.max(1, parseInt(req.query.page ?? '1', 10) || 1);
    const limit  = Math.min(50, Math.max(1, parseInt(req.query.limit ?? '20', 10) || 20));
    const offset = (page - 1) * limit;

    const broadcasts = await sql`
      SELECT
        b.*,
        u.name     AS admin_name,
        u.username AS admin_username,
        tu.name     AS target_user_name,
        tu.username AS target_user_username
      FROM admin_broadcasts b
      JOIN  users u  ON u.id  = b.admin_id
      LEFT JOIN users tu ON tu.id = b.target_user_id
      ORDER BY b.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const [{ total }] = await sql`SELECT COUNT(*)::int AS total FROM admin_broadcasts`;

    res.json({ broadcasts, total, page, limit });
  } catch (err) { next(err); }
});

export default router;
