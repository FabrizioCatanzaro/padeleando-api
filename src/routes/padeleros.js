import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { bracketStatsByUser, addFriendlyStatsByUser } from '../lib/profileStats.js';
import { bracketCompanions, mergeCompanions, SUGGESTED_LIMIT } from '../lib/padeleros.js';
import { ANON_ID } from '../lib/deleteUser.js';

const router = Router();

const ORGANIZERS_LIMIT = 30;
const ACTIVE_DAYS = 90;
const HOME_CLUB_DAYS = 183;

// Usuarios que jugaron tus mismos torneos públicos y todavía no seguís. Se repite en cada consulta de la tanda.
const SUGGESTED_CTE = `
  WITH sug AS (
    SELECT p.user_id AS uid, COUNT(DISTINCT t.id)::int AS shared,
           MAX(COALESCE(t.event_date, t.created_at::date)) AS last_day
    FROM players mp
    JOIN tournament_players mtp ON mtp.player_id = mp.id
    JOIN tournaments t ON t.id = mtp.tournament_id
    JOIN groups g ON g.id = t.group_id AND g.is_public
    JOIN tournament_players tp ON tp.tournament_id = t.id
    JOIN players p ON p.id = tp.player_id AND p.user_id IS NOT NULL AND p.user_id <> $1
    WHERE mp.user_id = $1
      AND NOT EXISTS (SELECT 1 FROM user_follows f WHERE f.follower_id = $1 AND f.following_id = p.user_id)
    GROUP BY p.user_id
    ORDER BY shared DESC, last_day DESC, p.user_id
    LIMIT ${SUGGESTED_LIMIT}
  )`;

function organizersQuery(sql, { me, lat, lon, limit }) {
  const near = lat != null && lon != null;
  return sql`
    SELECT u.id, u.name, u.username, u.avatar_url,
           COUNT(DISTINCT g.id)::int AS categories,
           COUNT(DISTINCT t.id)::int AS tournaments,
           MAX(COALESCE(t.event_date, t.created_at::date))::text AS last_day,
           (array_agg(DISTINCT c.name) FILTER (WHERE c.name IS NOT NULL))[1:2] AS clubs,
           (array_agg(g.name ORDER BY t.created_at DESC))[1] AS group_name,
           CASE WHEN ${near} THEN ROUND(MIN(6371 * acos(LEAST(1,
             cos(radians(${lat}::float8)) * cos(radians(c.lat)) * cos(radians(c.lon) - radians(${lon}::float8)) +
             sin(radians(${lat}::float8)) * sin(radians(c.lat)))))::numeric, 1) END AS distance_km,
           EXISTS (SELECT 1 FROM user_follows f WHERE f.follower_id = ${me}::text AND f.following_id = u.id) AS is_following
    FROM groups g
    JOIN users u ON u.id = g.user_id
    JOIN tournaments t ON t.group_id = g.id
      AND COALESCE(t.event_date, t.created_at::date) >= CURRENT_DATE - ${ACTIVE_DAYS}::int
    LEFT JOIN clubs c ON c.id = COALESCE(t.club_id, g.club_id)
    WHERE g.is_public AND u.id <> ${ANON_ID} AND u.id IS DISTINCT FROM ${me}::text
    GROUP BY u.id, u.name, u.username, u.avatar_url
    ORDER BY distance_km ASC NULLS LAST, last_day DESC, u.id
    LIMIT ${limit}
  `;
}

function parseCoord(value, max) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && Math.abs(n) <= max ? n : null;
}

router.get('/players', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const me = req.user.id;
    const [network, matchRows, bracketRows, friendlyRows, sugRows, sugBracketRows, sugFriendlyRows, organizers, followRows] = await Promise.all([
      sql`
        SELECT (SELECT COUNT(*)::int FROM user_follows WHERE follower_id  = ${me}) AS following,
               (SELECT COUNT(*)::int FROM user_follows WHERE following_id = ${me}) AS followers
      `,
      sql`
        SELECT CASE WHEN (s.team = 1) = (mp.id IN (m.team1_p1, m.team1_p2)) THEN 'partner' ELSE 'rival' END AS role,
               op.user_id, COALESCE(u.name, op.name) AS name, u.username, u.avatar_url
        FROM players mp
        JOIN matches m ON m.score1 <> m.score2 AND NOT m.walkover
          AND mp.id IN (m.team1_p1, m.team1_p2, m.team2_p1, m.team2_p2)
        CROSS JOIN LATERAL (VALUES (1, m.team1_p1), (1, m.team1_p2), (2, m.team2_p1), (2, m.team2_p2)) AS s(team, pid)
        JOIN players op ON op.id = s.pid AND op.id <> mp.id
        LEFT JOIN users u ON u.id = op.user_id
        WHERE mp.user_id = ${me} AND op.user_id IS DISTINCT FROM ${me}
      `,
      sql`
        SELECT t.bracket, t.bracket_plata,
          (SELECT json_agg(json_build_object(
              'id', pr.id,
              'mine', COALESCE(p1.user_id = ${me} OR p2.user_id = ${me}, false),
              'members', json_build_array(
                json_build_object('me', COALESCE(p1.user_id = ${me}, false), 'user_id', p1.user_id, 'name', COALESCE(u1.name, p1.name), 'username', u1.username, 'avatar_url', u1.avatar_url),
                json_build_object('me', COALESCE(p2.user_id = ${me}, false), 'user_id', p2.user_id, 'name', COALESCE(u2.name, p2.name), 'username', u2.username, 'avatar_url', u2.avatar_url))))
           FROM pairs pr
           JOIN players p1 ON p1.id = pr.p1_id LEFT JOIN users u1 ON u1.id = p1.user_id
           JOIN players p2 ON p2.id = pr.p2_id LEFT JOIN users u2 ON u2.id = p2.user_id
           WHERE pr.tournament_id = t.id) AS pairs
        FROM tournaments t
        WHERE t.bracket IS NOT NULL
          AND EXISTS (SELECT 1 FROM pairs pr JOIN players p ON p.id IN (pr.p1_id, pr.p2_id)
                      WHERE pr.tournament_id = t.id AND p.user_id = ${me})
      `,
      sql`
        SELECT CASE WHEN o.team = mine.team THEN 'partner' ELSE 'rival' END AS role,
               o.user_id, COALESCE(u.name, o.guest_name) AS name, u.username, u.avatar_url
        FROM friendly_match_players mine
        JOIN friendly_matches fm ON fm.id = mine.match_id AND fm.status = 'confirmado'
        JOIN friendly_match_players o ON o.match_id = fm.id AND NOT (o.team = mine.team AND o.position = mine.position)
        LEFT JOIN users u ON u.id = o.user_id
        WHERE mine.user_id = ${me} AND (o.user_id IS NOT NULL OR o.guest_name IS NOT NULL)
      `,
      sql.query(`${SUGGESTED_CTE}
        SELECT u.id, u.name, u.username, u.avatar_url, u.category, sug.shared,
               COALESCE(st.partidos, 0)::int AS partidos, COALESCE(st.victorias, 0)::int AS victorias,
               home.name AS club_name
        FROM sug
        JOIN users u ON u.id = sug.uid
        LEFT JOIN LATERAL (
          SELECT COUNT(m.id) AS partidos,
                 SUM(CASE WHEN (m.score1 > m.score2) = (p.id IN (m.team1_p1, m.team1_p2)) THEN 1 ELSE 0 END) AS victorias
          FROM players p
          JOIN matches m ON m.score1 <> m.score2 AND NOT m.walkover
            AND p.id IN (m.team1_p1, m.team1_p2, m.team2_p1, m.team2_p2)
          WHERE p.user_id = u.id
        ) st ON true
        LEFT JOIN LATERAL (
          SELECT c.name FROM (
            SELECT t.club_id FROM players p
            JOIN tournament_players tp ON tp.player_id = p.id
            JOIN tournaments t ON t.id = tp.tournament_id
            WHERE p.user_id = u.id AND COALESCE(t.event_date, t.created_at::date) >= CURRENT_DATE - ${HOME_CLUB_DAYS}
            UNION ALL
            SELECT fm.club_id FROM friendly_match_players fp
            JOIN friendly_matches fm ON fm.id = fp.match_id
            WHERE fp.user_id = u.id AND fm.status <> 'cancelado' AND fm.date >= CURRENT_DATE - ${HOME_CLUB_DAYS}
          ) x
          JOIN clubs c ON c.id = x.club_id
          GROUP BY c.id, c.name
          ORDER BY COUNT(*) DESC, c.name
          LIMIT 1
        ) home ON true
        ORDER BY sug.shared DESC, sug.last_day DESC, u.id`, [me]),
      sql.query(`${SUGGESTED_CTE}
        SELECT t.bracket, t.bracket_plata,
          (SELECT json_agg(json_build_object('id', pr.id, 'user_ids', json_build_array(p1.user_id, p2.user_id)))
           FROM pairs pr
           JOIN players p1 ON p1.id = pr.p1_id
           JOIN players p2 ON p2.id = pr.p2_id
           WHERE pr.tournament_id = t.id) AS pairs
        FROM tournaments t
        WHERE t.bracket IS NOT NULL
          AND EXISTS (SELECT 1 FROM pairs pr JOIN players p ON p.id IN (pr.p1_id, pr.p2_id)
                      WHERE pr.tournament_id = t.id AND p.user_id IN (SELECT uid FROM sug))`, [me]),
      sql.query(`${SUGGESTED_CTE}
        SELECT p.user_id AS id, COUNT(*)::int AS partidos,
               COUNT(*) FILTER (WHERE (p.team = 1 AND fm.score1 > fm.score2) OR (p.team = 2 AND fm.score2 > fm.score1))::int AS victorias
        FROM friendly_matches fm
        JOIN friendly_match_players p ON p.match_id = fm.id
        WHERE fm.status = 'confirmado' AND p.user_id IN (SELECT uid FROM sug)
        GROUP BY p.user_id`, [me]),
      organizersQuery(sql, { me, lat: null, lon: null, limit: 3 }),
      sql`SELECT following_id FROM user_follows WHERE follower_id = ${me}`,
    ]);

    const following = new Set(followRows.map((r) => r.following_id));
    const extra = addFriendlyStatsByUser(bracketStatsByUser(sugBracketRows), sugFriendlyRows);
    const suggested = sugRows.map((r) => {
      const add = extra.get(String(r.id)) ?? { partidos: 0, victorias: 0 };
      const partidos = r.partidos + add.partidos;
      const victorias = r.victorias + add.victorias;
      return {
        id: r.id, name: r.name, username: r.username, avatar_url: r.avatar_url, category: r.category,
        shared: r.shared, club_name: r.club_name, partidos,
        win_pct: partidos > 0 ? Math.round((victorias / partidos) * 100) : null,
      };
    });

    res.json({
      network: network[0],
      companions: mergeCompanions([...matchRows, ...bracketCompanions(bracketRows), ...friendlyRows])
        .map((c) => ({ ...c, is_following: c.key.startsWith('u:') && following.has(c.key.slice(2)) })),
      suggested,
      organizers,
    });
  } catch (err) { next(err); }
});

router.get('/organizers', optionalAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const lat = parseCoord(req.query.lat, 90);
    const lon = parseCoord(req.query.lon, 180);
    const rows = await organizersQuery(sql, { me: req.user?.id ?? null, lat, lon: lat == null ? null : lon, limit: ORGANIZERS_LIMIT });
    res.json(rows.map((r) => ({ ...r, distance_km: r.distance_km == null ? null : Number(r.distance_km) })));
  } catch (err) { next(err); }
});

export default router;
