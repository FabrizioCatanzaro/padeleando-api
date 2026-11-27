import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { bracketStatsByUser, countLeagueTitles } from '../lib/profileStats.js';
import { championCountsQuery, leagueTitleRowsQuery } from '../lib/profileQueries.js';
import { parseAgendaRange, buildAgenda } from '../lib/agenda.js';
import { arNow } from '../lib/friendlies.js';
import { FREE_MAX_GROUPS, FREE_TOURNAMENTS_PER_MONTH, FREE_COPAS_PER_MONTH } from '../lib/plan.js';
import { ORGANIZER_PLANS } from '../lib/planCatalog.js';

const router = Router();

// Inscripciones pendientes de los torneos no finalizados que el usuario gestiona, agrupadas por torneo.
function pendingRegistrationsQuery(sql, me) {
  return sql`
    SELECT t.id, t.name, t.group_id, COUNT(*)::int AS count
    FROM tournament_registrations r
    JOIN tournaments t ON t.id = r.tournament_id
    JOIN groups g ON g.id = t.group_id
    WHERE r.status = 'pending' AND t.status <> 'finished'
      AND (g.user_id = ${me}
        OR EXISTS (SELECT 1 FROM group_collaborators gc WHERE gc.group_id = g.id AND gc.user_id = ${me}))
    GROUP BY t.id, t.name, t.group_id
    ORDER BY MIN(r.created_at)
  `;
}

// Resumen del usuario logueado: números del perfil y contadores de la navegación, en una sola tanda.
router.get('/summary', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const me = req.user.id;
    const [[base], bracketRows, [champ], leagueRows, [friendly], [counts]] = await Promise.all([
      sql`
        SELECT
          COUNT(m.id)::int AS partidos,
          COALESCE(SUM(CASE
            WHEN m.score1 > m.score2 AND (m.team1_p1 = p.id OR m.team1_p2 = p.id) THEN 1
            WHEN m.score2 > m.score1 AND (m.team2_p1 = p.id OR m.team2_p2 = p.id) THEN 1
            ELSE 0 END), 0)::int AS victorias
        FROM players p
        JOIN tournament_players tp ON tp.player_id = p.id
        LEFT JOIN matches m ON m.tournament_id = tp.tournament_id
          AND m.score1 <> m.score2 AND NOT m.walkover
          AND (m.team1_p1 = p.id OR m.team1_p2 = p.id
            OR m.team2_p1 = p.id OR m.team2_p2 = p.id)
        WHERE p.user_id = ${me}
      `,
      sql`
        SELECT
          t.bracket,
          t.bracket_plata,
          (SELECT json_agg(json_build_object(
              'id',       pr.id,
              'user_ids', json_build_array(p1.user_id, p2.user_id)))
           FROM pairs pr
           JOIN players p1 ON p1.id = pr.p1_id
           JOIN players p2 ON p2.id = pr.p2_id
           WHERE pr.tournament_id = t.id) AS pairs
        FROM tournaments t
        WHERE t.bracket IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM pairs pr
            JOIN players p ON p.id = pr.p1_id OR p.id = pr.p2_id
            WHERE pr.tournament_id = t.id AND p.user_id = ${me}
          )
      `,
      championCountsQuery(sql, me),
      leagueTitleRowsQuery(sql, me),
      sql`
        SELECT
          COUNT(*)::int AS partidos,
          COUNT(*) FILTER (WHERE (p.team = 1 AND fm.score1 > fm.score2) OR (p.team = 2 AND fm.score2 > fm.score1))::int AS victorias
        FROM friendly_matches fm
        JOIN friendly_match_players p ON p.match_id = fm.id
        WHERE fm.status = 'confirmado' AND p.user_id = ${me}
      `,
      // Misma regla que needsAction: falta el resultado, o el otro equipo propuso uno. Sin vencidos (30 días).
      sql`
        WITH ar AS (SELECT (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires') AS ts)
        SELECT
          (SELECT COUNT(*)::int
           FROM friendly_match_players p
           JOIN friendly_matches fm ON fm.id = p.match_id
           LEFT JOIN friendly_match_proposals pr ON pr.match_id = fm.id AND pr.status = 'pendiente'
           CROSS JOIN ar
           WHERE p.user_id = ${me}
             AND fm.date + 30 >= ar.ts::date
             AND ((fm.status = 'programado'
                   AND fm.date + fm.start_time + fm.duration_minutes * INTERVAL '1 minute' <= ar.ts)
               OR (fm.status = 'por_confirmar' AND pr.team IS NOT NULL AND pr.team <> p.team))
          ) AS friendlies,
          (SELECT COUNT(*)::int
           FROM tournament_registrations r
           JOIN tournaments t ON t.id = r.tournament_id
           JOIN groups g ON g.id = t.group_id
           WHERE r.status = 'pending' AND t.status <> 'finished'
             AND (g.user_id = ${me}
               OR EXISTS (SELECT 1 FROM group_collaborators gc WHERE gc.group_id = g.id AND gc.user_id = ${me}))
          ) AS registrations,
          (SELECT COUNT(*)::int
           FROM tournaments t
           JOIN groups g ON g.id = t.group_id
           WHERE t.status = 'active'
             AND (g.user_id = ${me}
               OR EXISTS (SELECT 1 FROM group_collaborators gc WHERE gc.group_id = g.id AND gc.user_id = ${me})
               OR EXISTS (SELECT 1 FROM tournament_players tp JOIN players p ON p.id = tp.player_id
                          WHERE tp.tournament_id = t.id AND p.user_id = ${me}))
          ) AS tournaments_active
      `,
    ]);

    const bracket = bracketStatsByUser(bracketRows).get(String(me)) ?? { partidos: 0, victorias: 0 };
    const partidos = base.partidos + bracket.partidos + friendly.partidos;
    const victorias = base.victorias + bracket.victorias + friendly.victorias;
    const titulos = countLeagueTitles(leagueRows) + champ.campeon_playoffs + champ.campeon_americano + champ.campeon_copa;

    res.json({
      stats: { partidos, victorias, win_pct: partidos > 0 ? Math.round((victorias / partidos) * 100) : null, titulos },
      pending: { friendlies: counts.friendlies, registrations: counts.registrations },
      tournaments_active: counts.tournaments_active,
    });
  } catch (err) { next(err); }
});

// Agenda del usuario: partidos de torneo programados, partidos del cuadro con día, amistosos por jugar y torneos
// con fecha donde juega. Suma lo pendiente que se resuelve desde Inicio. Una sola tanda.
router.get('/agenda', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const me = req.user.id;
    const { from, to } = parseAgendaRange(req.query, arNow().date);
    const [scheduled, brackets, friendlies, tournaments, pendingFriendlies, pendingRegistrations] = await Promise.all([
      sql`
        SELECT sm.id, sm.court, to_char(sm.scheduled_at, 'HH24:MI') AS time,
               COALESCE(sm.scheduled_date, t.event_date)::text AS day,
               t.id AS tournament_id, t.name AS tournament_name, t.format, t.group_id, g.name AS group_name,
               c.name AS club_name,
               COALESCE(${me} IN (p1.user_id, p2.user_id), false) AS mine_is_team1,
               COALESCE(u1.name, p1.name) AS n1, COALESCE(u2.name, p2.name) AS n2,
               COALESCE(u3.name, p3.name) AS n3, COALESCE(u4.name, p4.name) AS n4
        FROM scheduled_matches sm
        JOIN tournaments t ON t.id = sm.tournament_id
        JOIN groups g ON g.id = t.group_id
        LEFT JOIN clubs c ON c.id = t.club_id
        JOIN players p1 ON p1.id = sm.team1_p1 LEFT JOIN users u1 ON u1.id = p1.user_id
        JOIN players p2 ON p2.id = sm.team1_p2 LEFT JOIN users u2 ON u2.id = p2.user_id
        JOIN players p3 ON p3.id = sm.team2_p1 LEFT JOIN users u3 ON u3.id = p3.user_id
        JOIN players p4 ON p4.id = sm.team2_p2 LEFT JOIN users u4 ON u4.id = p4.user_id
        WHERE t.status = 'active' AND NOT sm.postponed
          AND ${me} IN (p1.user_id, p2.user_id, p3.user_id, p4.user_id)
          AND COALESCE(sm.scheduled_date, t.event_date) BETWEEN ${from}::date AND ${to}::date
      `,
      sql`
        SELECT t.id, t.name, t.format, t.group_id, g.name AS group_name, c.name AS club_name,
               t.bracket, t.bracket_plata,
               (SELECT json_agg(json_build_object(
                   'id',   pr.id,
                   'mine', COALESCE(p1.user_id = ${me} OR p2.user_id = ${me}, false),
                   'name', COALESCE(u1.name, p1.name) || ' / ' || COALESCE(u2.name, p2.name)))
                FROM pairs pr
                JOIN players p1 ON p1.id = pr.p1_id LEFT JOIN users u1 ON u1.id = p1.user_id
                JOIN players p2 ON p2.id = pr.p2_id LEFT JOIN users u2 ON u2.id = p2.user_id
                WHERE pr.tournament_id = t.id) AS pairs
        FROM tournaments t
        JOIN groups g ON g.id = t.group_id
        LEFT JOIN clubs c ON c.id = t.club_id
        WHERE t.status = 'active' AND t.bracket IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM pairs pr
            JOIN players p ON p.id = pr.p1_id OR p.id = pr.p2_id
            WHERE pr.tournament_id = t.id AND p.user_id = ${me}
          )
      `,
      sql`
        WITH ar AS (SELECT (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires') AS ts)
        SELECT fm.id, fm.date::text AS day, to_char(fm.start_time, 'HH24:MI') AS time, c.name AS club_name,
               (SELECT COUNT(*)::int FROM friendly_match_players x
                WHERE x.match_id = fm.id AND (x.user_id IS NOT NULL OR x.guest_name IS NOT NULL)) AS filled
        FROM friendly_matches fm
        JOIN friendly_match_players p ON p.match_id = fm.id AND p.user_id = ${me}
        LEFT JOIN clubs c ON c.id = fm.club_id
        CROSS JOIN ar
        WHERE fm.status = 'programado'
          AND fm.date BETWEEN ${from}::date AND ${to}::date
          AND fm.date + fm.start_time + fm.duration_minutes * INTERVAL '1 minute' > ar.ts
      `,
      sql`
        SELECT t.id, t.name, t.format, t.group_id, g.name AS group_name, c.name AS club_name,
               t.event_date::text AS day, to_char(t.event_time, 'HH24:MI') AS time
        FROM tournaments t
        JOIN groups g ON g.id = t.group_id
        LEFT JOIN clubs c ON c.id = t.club_id
        WHERE t.status = 'active'
          AND t.event_date BETWEEN ${from}::date AND ${to}::date
          AND EXISTS (SELECT 1 FROM tournament_players tp JOIN players p ON p.id = tp.player_id
                      WHERE tp.tournament_id = t.id AND p.user_id = ${me})
      `,
      // Misma regla que el contador de /summary.
      sql`
        WITH ar AS (SELECT (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires') AS ts)
        SELECT fm.id, fm.date::text AS day, to_char(fm.start_time, 'HH24:MI') AS time, c.name AS club_name,
               CASE WHEN fm.status = 'programado' THEN 'cargar' ELSE 'confirmar' END AS kind,
               pr.sets AS proposed_sets
        FROM friendly_match_players p
        JOIN friendly_matches fm ON fm.id = p.match_id
        LEFT JOIN clubs c ON c.id = fm.club_id
        LEFT JOIN friendly_match_proposals pr ON pr.match_id = fm.id AND pr.status = 'pendiente'
        CROSS JOIN ar
        WHERE p.user_id = ${me}
          AND fm.date + 30 >= ar.ts::date
          AND ((fm.status = 'programado'
                AND fm.date + fm.start_time + fm.duration_minutes * INTERVAL '1 minute' <= ar.ts)
            OR (fm.status = 'por_confirmar' AND pr.team IS NOT NULL AND pr.team <> p.team))
        ORDER BY fm.date, fm.start_time
      `,
      pendingRegistrationsQuery(sql, me),
    ]);

    res.json({
      from, to,
      items: buildAgenda({ scheduled, brackets, friendlies, tournaments, from, to }),
      pending: { friendlies: pendingFriendlies, registrations: pendingRegistrations },
    });
  } catch (err) { next(err); }
});

// Mis torneos: lista plana de los torneos donde el usuario juega, gestiona o tiene una inscripción viva.
router.get('/tournaments', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const me = req.user.id;
    const rows = await sql`
      WITH mine AS (
        SELECT t.id,
          EXISTS (SELECT 1 FROM tournament_players tp JOIN players p ON p.id = tp.player_id
                  WHERE tp.tournament_id = t.id AND p.user_id = ${me}) AS plays,
          (g.user_id = ${me} OR EXISTS (SELECT 1 FROM group_collaborators gc
                                        WHERE gc.group_id = g.id AND gc.user_id = ${me})) AS manages,
          (SELECT r.status FROM tournament_registrations r
           WHERE r.tournament_id = t.id AND ${me} IN (r.p1_user_id, r.p2_user_id)
             AND r.status IN ('pending', 'approved', 'waitlist')
           ORDER BY r.created_at DESC LIMIT 1) AS my_registration
        FROM tournaments t
        JOIN groups g ON g.id = t.group_id
      )
      SELECT t.id, t.name, t.format, t.status, t.event_date::text AS event_date,
             to_char(t.event_time, 'HH24:MI') AS event_time, t.created_at,
             t.group_id, g.name AS group_name, g.emojis AS group_emojis, c.name AS club_name,
             mine.plays, mine.manages, mine.my_registration,
             COALESCE(jsonb_typeof(t.live_match) = 'array' AND jsonb_array_length(t.live_match) > 0, false) AS live,
             (SELECT COUNT(*)::int FROM tournament_players tp WHERE tp.tournament_id = t.id) AS player_count,
             (SELECT COUNT(*)::int FROM matches m WHERE m.tournament_id = t.id) AS match_count,
             EXISTS (
               SELECT 1 FROM pairs pr
               JOIN players p1 ON p1.id = pr.p1_id
               JOIN players p2 ON p2.id = pr.p2_id
               WHERE pr.tournament_id = t.id AND pr.id = (t.bracket->'final'->>'winner_id')
                 AND ${me} IN (p1.user_id, p2.user_id)
             ) AS won_final
      FROM mine
      JOIN tournaments t ON t.id = mine.id
      JOIN groups g ON g.id = t.group_id
      LEFT JOIN clubs c ON c.id = t.club_id
      WHERE mine.plays OR mine.manages OR mine.my_registration IS NOT NULL
      ORDER BY COALESCE(t.event_date, t.created_at::date) DESC, t.created_at DESC
      LIMIT 200
    `;
    res.json(rows);
  } catch (err) { next(err); }
});

// Organizar: categorías que el usuario gestiona con su cupo del mes, inscripciones por aprobar y su plan.
router.get('/organize', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const me = req.user.id;
    const [categories, registrations, [plan]] = await Promise.all([
      sql`
        SELECT g.id, g.name, g.emojis, g.is_public, (g.user_id = ${me}) AS is_owner,
               ou.username AS owner_username, ou.name AS owner_name,
               gclub.name AS club_name, gclub.photo_url AS club_photo_url,
               EXISTS (SELECT 1 FROM subscriptions s
                       WHERE s.user_id = g.user_id AND s.status = 'active' AND s.plan = ANY(${ORGANIZER_PLANS})) AS owner_is_premium,
               (SELECT COUNT(DISTINCT tp.player_id)::int FROM tournament_players tp
                JOIN tournaments t ON t.id = tp.tournament_id WHERE t.group_id = g.id) AS player_count,
               (SELECT COUNT(*)::int FROM tournaments t WHERE t.group_id = g.id) AS tournament_count,
               (SELECT COUNT(*)::int FROM tournaments t
                WHERE t.group_id = g.id AND t.created_at >= date_trunc('month', now())) AS month_count,
               (SELECT COUNT(*)::int FROM tournaments t
                WHERE t.group_id = g.id AND t.format = 'copa' AND t.created_at >= date_trunc('month', now())) AS month_copas,
               (SELECT COUNT(*)::int FROM group_collaborators gc WHERE gc.group_id = g.id) AS collaborator_count,
               (SELECT json_build_object('id', t.id, 'name', t.name) FROM tournaments t
                WHERE t.group_id = g.id AND t.status = 'active'
                  AND jsonb_typeof(t.live_match) = 'array' AND jsonb_array_length(t.live_match) > 0
                LIMIT 1) AS live,
               (SELECT json_build_object('id', t.id, 'name', t.name, 'event_date', t.event_date) FROM tournaments t
                WHERE t.group_id = g.id AND t.status = 'active'
                ORDER BY t.event_date ASC NULLS LAST, t.created_at DESC
                LIMIT 1) AS next
        FROM groups g
        JOIN users ou ON ou.id = g.user_id
        LEFT JOIN clubs gclub ON gclub.id = g.club_id
        WHERE g.user_id = ${me}
           OR EXISTS (SELECT 1 FROM group_collaborators gc WHERE gc.group_id = g.id AND gc.user_id = ${me})
        ORDER BY (g.user_id = ${me}) DESC, g.created_at DESC
      `,
      pendingRegistrationsQuery(sql, me),
      sql`
        SELECT EXISTS (SELECT 1 FROM subscriptions s
                       WHERE s.user_id = ${me} AND s.status = 'active' AND s.plan = ANY(${ORGANIZER_PLANS})) AS premium,
               (SELECT COUNT(*)::int FROM groups WHERE user_id = ${me}) AS groups_owned
      `,
    ]);
    res.json({
      categories,
      registrations,
      plan: {
        ...plan,
        max_groups: FREE_MAX_GROUPS,
        tournaments_per_month: FREE_TOURNAMENTS_PER_MONTH,
        copas_per_month: FREE_COPAS_PER_MONTH,
      },
    });
  } catch (err) { next(err); }
});

export default router;
