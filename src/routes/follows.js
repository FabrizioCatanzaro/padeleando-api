import { Router } from 'express';
import { getDb } from '../db.js';
import { uid } from '../uid.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { PLAYER_PLANS } from '../lib/planCatalog.js';

const router = Router();

// GET /api/follows/contacts — seguidores + seguidos del usuario autenticado (para autocompletado)
router.get('/contacts', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const contacts = await sql`
      SELECT DISTINCT u.id, u.name, u.username, u.avatar_url
      FROM users u
      WHERE u.id IN (
        SELECT following_id FROM user_follows WHERE follower_id = ${req.user.id}
        UNION
        SELECT follower_id  FROM user_follows WHERE following_id = ${req.user.id}
      )
      ORDER BY u.name ASC
      LIMIT 50
    `;
    res.json(contacts);
  } catch (err) { next(err); }
});

// POST /api/follows/:username — seguir a un usuario
router.post('/:username', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const [target] = await sql`SELECT id FROM users WHERE username = ${req.params.username}`;
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (target.id === req.user.id) return res.status(400).json({ error: 'No podés seguirte a vos mismo' });

    const [existing] = await sql`
      SELECT 1 FROM user_follows
      WHERE follower_id = ${req.user.id} AND following_id = ${target.id}
    `;
    if (existing) return res.status(409).json({ error: 'Ya seguís a este usuario' });

    await sql`INSERT INTO user_follows (follower_id, following_id) VALUES (${req.user.id}, ${target.id})`;

    // Reemplazar notificación previa de follow del mismo actor (si la había)
    await sql`
      DELETE FROM notifications
      WHERE user_id = ${target.id} AND type = 'follow' AND actor_id = ${req.user.id}
    `;
    await sql`
      INSERT INTO notifications (id, user_id, type, actor_id)
      VALUES (${uid()}, ${target.id}, 'follow', ${req.user.id})
    `;

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/follows/:username — dejar de seguir
router.delete('/:username', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const [target] = await sql`SELECT id FROM users WHERE username = ${req.params.username}`;
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });

    await sql`DELETE FROM user_follows WHERE follower_id = ${req.user.id} AND following_id = ${target.id}`;
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// GET /api/follows/:username/followers
router.get('/:username/followers', optionalAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const [target] = await sql`SELECT id FROM users WHERE username = ${req.params.username}`;
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });

    const viewerId = req.user?.id ?? null;
    const followers = await sql`
      SELECT
        u.id, u.name, u.username, u.avatar_url,
        EXISTS(
          SELECT 1 FROM subscriptions s
          WHERE s.user_id = u.id AND s.plan = ANY(${PLAYER_PLANS}) AND s.status = 'active'
            AND (s.ends_at IS NULL OR s.ends_at > NOW())
        ) AS is_premium,
        EXISTS(
          SELECT 1 FROM user_follows vf
          WHERE vf.follower_id = ${viewerId} AND vf.following_id = u.id
        ) AS is_following
      FROM user_follows f
      JOIN users u ON u.id = f.follower_id
      WHERE f.following_id = ${target.id}
      ORDER BY f.created_at DESC
    `;
    res.json(followers);
  } catch (err) { next(err); }
});

// GET /api/follows/:username/following
router.get('/:username/following', optionalAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const [target] = await sql`SELECT id FROM users WHERE username = ${req.params.username}`;
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });

    const viewerId = req.user?.id ?? null;
    const following = await sql`
      SELECT
        u.id, u.name, u.username, u.avatar_url,
        EXISTS(
          SELECT 1 FROM subscriptions s
          WHERE s.user_id = u.id AND s.plan = ANY(${PLAYER_PLANS}) AND s.status = 'active'
            AND (s.ends_at IS NULL OR s.ends_at > NOW())
        ) AS is_premium,
        EXISTS(
          SELECT 1 FROM user_follows vf
          WHERE vf.follower_id = ${viewerId} AND vf.following_id = u.id
        ) AS is_following
      FROM user_follows f
      JOIN users u ON u.id = f.following_id
      WHERE f.follower_id = ${target.id}
      ORDER BY f.created_at DESC
    `;
    res.json(following);
  } catch (err) { next(err); }
});

export default router;
