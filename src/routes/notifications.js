import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// GET /api/notifications — lista paginada con datos enriquecidos
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const sql    = getDb();
    const limit  = Math.min(parseInt(req.query.limit  ?? '30'), 100);
    const offset = parseInt(req.query.offset ?? '0');

    const notifications = await sql`
      SELECT
        n.id, n.type, n.read, n.created_at, n.entity_id,
        n.title, n.body,
        a.id         AS actor_id,
        a.name       AS actor_name,
        a.username   AS actor_username,
        a.avatar_url AS actor_avatar_url,
        CASE WHEN a.id IS NOT NULL THEN EXISTS(
          SELECT 1 FROM subscriptions s
          WHERE s.user_id = a.id AND s.plan = 'premium' AND s.status = 'active'
            AND (s.ends_at IS NULL OR s.ends_at > NOW())
        ) ELSE false END AS actor_is_premium,
        CASE WHEN n.type = 'follow' THEN
          EXISTS(SELECT 1 FROM user_follows WHERE follower_id = ${req.user.id} AND following_id = a.id)
        ELSE false END AS is_following_back,
        pi.status  AS invitation_status,
        COALESCE(g.id, gci.id, got.id, gor.id, gpu.id, gnt.id)     AS group_id,
        COALESCE(g.name, gci.name, got.name, gor.name, gpu.name, gnt.name) AS group_name,
        p.name     AS player_name,
        tjr.status        AS request_status,
        rp.name           AS requested_player_name,
        COALESCE(tour.id, tnt.id)     AS tournament_id,
        COALESCE(tour.name, tnt.name) AS tournament_name,
        ci.status  AS collab_status,
        ot.status  AS transfer_status
      FROM notifications n
      LEFT JOIN users a ON a.id = n.actor_id
      LEFT JOIN player_invitations pi ON n.type = 'invitation' AND pi.id = n.entity_id
      LEFT JOIN groups g ON g.id = pi.group_id
      LEFT JOIN players p ON p.id = pi.player_id
      LEFT JOIN tournament_join_requests tjr ON n.type = 'join_request' AND tjr.id = n.entity_id
      LEFT JOIN players rp ON rp.id = tjr.requested_player_id
      LEFT JOIN tournaments tour ON tour.id = tjr.tournament_id
      LEFT JOIN collaborator_invitations ci ON n.type = 'collab_invite' AND ci.id = n.entity_id
      LEFT JOIN groups gci ON gci.id = ci.group_id
      LEFT JOIN ownership_transfers ot ON n.type = 'ownership_transfer' AND ot.id = n.entity_id
      LEFT JOIN groups got ON got.id = ot.group_id
      LEFT JOIN groups gor ON n.type = 'ownership_received' AND gor.id = n.entity_id
      LEFT JOIN groups gpu ON n.type = 'player_unlinked'    AND gpu.id = n.entity_id
      LEFT JOIN tournaments tnt ON n.type = 'new_tournament' AND tnt.id = n.entity_id
      LEFT JOIN groups gnt ON gnt.id = tnt.group_id
      WHERE n.user_id = ${req.user.id}
      ORDER BY n.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;
    res.json(notifications);
  } catch (err) { next(err); }
});

// GET /api/notifications/count — cantidad no leídas + la última, para el aviso
// flotante. Va en una sola consulta (LATERAL) porque el header la pide cada 45s.
router.get('/count', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const [row] = await sql`
      SELECT c.count,
             l.id, l.type, l.title, l.body, l.created_at,
             l.actor_username, l.actor_name, l.group_name, l.tournament_name, l.player_name
      FROM (
        SELECT COUNT(*)::int AS count FROM notifications
        WHERE user_id = ${req.user.id} AND read = false
      ) c
      LEFT JOIN LATERAL (
        SELECT n.id, n.type, n.title, n.body, n.created_at,
               a.username AS actor_username, a.name AS actor_name,
               COALESCE(gi.name, gci.name, got.name, gor.name, gnt.name) AS group_name,
               COALESCE(tj.name, tnt.name) AS tournament_name,
               p.name AS player_name
        FROM   notifications n
        LEFT   JOIN users a ON a.id = n.actor_id
        LEFT   JOIN player_invitations pi ON n.type = 'invitation' AND pi.id = n.entity_id
        LEFT   JOIN groups gi  ON gi.id  = pi.group_id
        LEFT   JOIN players p  ON p.id   = pi.player_id
        LEFT   JOIN collaborator_invitations ci ON n.type = 'collab_invite' AND ci.id = n.entity_id
        LEFT   JOIN groups gci ON gci.id = ci.group_id
        LEFT   JOIN ownership_transfers ot ON n.type = 'ownership_transfer' AND ot.id = n.entity_id
        LEFT   JOIN groups got ON got.id = ot.group_id
        LEFT   JOIN groups gor ON n.type = 'ownership_received' AND gor.id = n.entity_id
        LEFT   JOIN tournament_join_requests tjr ON n.type = 'join_request' AND tjr.id = n.entity_id
        LEFT   JOIN tournaments tj ON tj.id = tjr.tournament_id
        LEFT   JOIN tournaments tnt ON n.type = 'new_tournament' AND tnt.id = n.entity_id
        LEFT   JOIN groups gnt ON gnt.id = tnt.group_id
        WHERE  n.user_id = ${req.user.id} AND n.read = false
        ORDER  BY n.created_at DESC
        LIMIT  1
      ) l ON true
    `;
    const { count, ...latest } = row;
    res.json({ count, latest: latest.id ? latest : null });
  } catch (err) { next(err); }
});

// PATCH /api/notifications/read-all — marcar todas como leídas
router.patch('/read-all', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    await sql`UPDATE notifications SET read = true WHERE user_id = ${req.user.id} AND read = false`;
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// PATCH /api/notifications/:id/read — marcar una como leída
router.patch('/:id/read', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    await sql`
      UPDATE notifications SET read = true
      WHERE id = ${req.params.id} AND user_id = ${req.user.id}
    `;
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
