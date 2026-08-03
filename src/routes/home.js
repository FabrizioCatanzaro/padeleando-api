import { Router } from 'express';
import { getDb }  from '../db.js';
import { resolveSignup } from '../lib/signup.js';

const router = Router();

const LIMIT_LIVE     = 6;
const LIMIT_UPCOMING = 8;
const LIMIT_SIGNUP   = 8;
const LIMIT_FEATURED = 8;

// Presentación de una jornada pública: categoría, dueño y club.
function card(t) {
  return {
    id: t.id, name: t.name, status: t.status, format: t.format, mode: t.mode,
    event_date: t.event_date ?? null, event_time: t.event_time ?? null,
    group_id: t.group_id, group_name: t.group_name, group_emojis: t.group_emojis ?? [],
    owner_username: t.owner_username, owner_name: t.owner_name ?? null, owner_avatar_url: t.owner_avatar_url ?? null,
    club_id: t.club_id ?? null, club_name: t.club_name ?? null,
    club_photo_url: t.club_photo_url ?? null, club_location_name: t.club_location_name ?? null,
  };
}

// GET /api/home — todo lo que la portada del visitante necesita, en una sola petición.
router.get('/', async (req, res, next) => {
  try {
    const sql = getDb();
    const [live, upcoming, signup, featured, [totals]] = await Promise.all([
      sql`
        SELECT t.id, t.name, t.status, t.format, t.mode, t.event_date, t.event_time, t.live_match,
               g.id AS group_id, g.name AS group_name, g.emojis AS group_emojis,
               u.username AS owner_username, u.name AS owner_name, u.avatar_url AS owner_avatar_url,
               c.id AS club_id, c.name AS club_name, c.photo_url AS club_photo_url, c.location_name AS club_location_name
        FROM   tournaments t
        JOIN   groups g ON g.id = t.group_id
        JOIN   users  u ON u.id = g.user_id
        LEFT   JOIN clubs c ON c.id = t.club_id
        WHERE  g.is_public = true
          AND  t.status <> 'finished'
          AND  jsonb_typeof(t.live_match) = 'array'
          AND  jsonb_array_length(t.live_match) > 0
        ORDER  BY COALESCE(t.event_date, t.created_at::date) DESC
        LIMIT  ${LIMIT_LIVE}
      `,
      sql`
        SELECT t.id, t.name, t.status, t.format, t.mode, t.event_date, t.event_time,
               g.id AS group_id, g.name AS group_name, g.emojis AS group_emojis,
               u.username AS owner_username, u.name AS owner_name, u.avatar_url AS owner_avatar_url,
               c.id AS club_id, c.name AS club_name, c.photo_url AS club_photo_url, c.location_name AS club_location_name,
               (SELECT COUNT(*)::int FROM tournament_players tp WHERE tp.tournament_id = t.id) AS player_count
        FROM   tournaments t
        JOIN   groups g ON g.id = t.group_id
        JOIN   users  u ON u.id = g.user_id
        LEFT   JOIN clubs c ON c.id = t.club_id
        WHERE  g.is_public = true
          AND  t.status <> 'finished'
          AND  t.event_date >= CURRENT_DATE
        ORDER  BY t.event_date ASC, t.event_time ASC NULLS LAST
        LIMIT  ${LIMIT_UPCOMING}
      `,
      sql`
        SELECT t.id, t.name, t.status, t.format, t.mode, t.event_date, t.event_time,
               g.id AS group_id, g.name AS group_name, g.emojis AS group_emojis,
               u.username AS owner_username, u.name AS owner_name, u.avatar_url AS owner_avatar_url,
               u.social_links AS owner_social_links,
               c.id AS club_id, c.name AS club_name, c.photo_url AS club_photo_url, c.location_name AS club_location_name,
               t.signup_price, t.signup_price_unit, t.signup_contacts,
               g.signup_price      AS group_signup_price,
               g.signup_price_unit AS group_signup_price_unit,
               g.signup_contacts   AS group_signup_contacts
        FROM   tournaments t
        JOIN   groups g ON g.id = t.group_id
        JOIN   users  u ON u.id = g.user_id
        LEFT   JOIN clubs c ON c.id = t.club_id
        WHERE  g.is_public = true
          AND  t.status <> 'finished'
          AND  COALESCE(t.signup_open, g.signup_open, false) = true
          AND  (t.event_date IS NULL OR t.event_date >= CURRENT_DATE)
        ORDER  BY t.event_date ASC NULLS LAST, t.created_at DESC
        LIMIT  ${LIMIT_SIGNUP}
      `,
      // Reserva: categorías públicas con actividad, para que la portada nunca quede vacía.
      sql`
        SELECT g.id, g.name, g.description, g.emojis, g.location_name, g.is_public,
               u.username AS owner_username, u.name AS owner_name, u.avatar_url AS owner_avatar_url,
               (SELECT COUNT(DISTINCT tp.player_id)::int
                FROM tournament_players tp
                JOIN tournaments t ON t.id = tp.tournament_id
                WHERE t.group_id = g.id) AS player_count,
               (SELECT COUNT(*)::int FROM tournaments t WHERE t.group_id = g.id) AS tournament_count,
               (SELECT MAX(t.created_at) FROM tournaments t WHERE t.group_id = g.id) AS last_activity,
               COALESCE(gclub.name, lastclub.name) AS club_name
        FROM groups g
        JOIN users u ON u.id = g.user_id
        LEFT JOIN clubs gclub ON gclub.id = g.club_id
        LEFT JOIN LATERAL (
          SELECT c2.name
          FROM   tournaments t2
          JOIN   clubs c2 ON c2.id = t2.club_id
          WHERE  t2.group_id = g.id
          ORDER  BY COALESCE(t2.event_date, t2.created_at::date) DESC
          LIMIT  1
        ) lastclub ON g.club_id IS NULL
        WHERE g.is_public = true
          AND EXISTS (SELECT 1 FROM tournaments t WHERE t.group_id = g.id)
        ORDER BY last_activity DESC NULLS LAST
        LIMIT ${LIMIT_FEATURED}
      `,
      sql`
        SELECT (SELECT COUNT(*)::int FROM tournaments)                               AS tournaments,
               (SELECT COUNT(*)::int FROM matches)                                   AS matches,
               (SELECT COUNT(DISTINCT tp.player_id)::int FROM tournament_players tp) AS players,
               (SELECT COUNT(*)::int FROM clubs)                                     AS clubs
      `,
    ]);

    res.json({
      live: live.map((t) => ({
        ...card(t),
        // Sólo los rótulos: la portada no muestra marcador ni cronómetro.
        live_matches: (Array.isArray(t.live_match) ? t.live_match : []).map((m) => ({
          team1Label: m.team1Label ?? null,
          team2Label: m.team2Label ?? null,
          court:      m.court ?? null,
        })),
      })),
      upcoming: upcoming.map((t) => ({ ...card(t), player_count: t.player_count ?? 0 })),
      signup: signup.map((t) => ({
        ...card(t),
        signup: resolveSignup(
          { signup_open: true, signup_price: t.signup_price, signup_price_unit: t.signup_price_unit, signup_contacts: t.signup_contacts },
          { signup_price: t.group_signup_price, signup_price_unit: t.group_signup_price_unit, signup_contacts: t.group_signup_contacts },
          t.owner_social_links,
        ),
      })),
      featured,
      totals,
    });
  } catch (err) { next(err); }
});

export default router;
