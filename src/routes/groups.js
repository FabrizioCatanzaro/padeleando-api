import { Router } from 'express';
import { getDb }  from '../db.js';
import { uid }    from '../uid.js';
const router = Router();
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import { getActiveSubscription } from './subscriptions.js';
import { ANON_ID } from '../lib/deleteUser.js';
import { parseSignupFields } from '../lib/signup.js';
import { groupQuotaError } from '../lib/plan.js';
import {
  expandBracketMatches, countLeagueTitles, calcStreaks, mergeActivity, mergeFrequentPartners,
  mergeWeekdayAndClub, countBlowouts, countSetStats, bracketStatsByUser, buildFollowRanking, dayKey,
} from '../lib/profileStats.js';

// GET /api/groups — solo los del usuario autenticado
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const groups = await sql`
      SELECT g.*,
        COALESCE(gclub.name, lastclub.name) AS club_name,
        (SELECT COUNT(DISTINCT tp.player_id)::int
         FROM tournament_players tp
         JOIN tournaments t ON t.id = tp.tournament_id
         WHERE t.group_id = g.id) AS player_count,
        (SELECT COUNT(*)::int FROM tournaments t WHERE t.group_id = g.id) AS tournament_count,
        -- Sólo lo consume el checklist de primeros pasos de la portada, que
        -- necesita saber si ya cargó algún resultado. Va acá y no en una
        -- petición aparte para no sumar un round-trip a Neon.
        (SELECT COUNT(*)::int
         FROM   matches m
         JOIN   tournaments t ON t.id = m.tournament_id
         WHERE  t.group_id = g.id) AS match_count
      FROM groups g
      LEFT JOIN clubs gclub ON gclub.id = g.club_id
      LEFT JOIN LATERAL (
        SELECT c2.name
        FROM   tournaments t2
        JOIN   clubs c2 ON c2.id = t2.club_id
        WHERE  t2.group_id = g.id
        ORDER  BY COALESCE(t2.event_date, t2.created_at::date) DESC
        LIMIT  1
      ) lastclub ON g.club_id IS NULL
      WHERE g.user_id = ${req.user.id}
      ORDER BY g.created_at DESC
    `;
    res.json(groups);
  } catch (err) { next(err); }
});

// GET /api/groups/participating — grupos ajenos donde el usuario tiene un player vinculado (invitación aceptada)
router.get('/participating', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const groups = await sql`
      SELECT g.*,
        u.username   AS owner_username,
        u.name       AS owner_name,
        u.avatar_url AS owner_avatar_url,
        (SELECT COUNT(DISTINCT tp.player_id)::int
         FROM tournament_players tp
         JOIN tournaments t ON t.id = tp.tournament_id
         WHERE t.group_id = g.id) AS player_count,
        (SELECT COUNT(*)::int FROM tournaments t WHERE t.group_id = g.id) AS tournament_count,
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
      WHERE g.user_id != ${req.user.id}
        AND EXISTS (
          SELECT 1 FROM group_players ugp
          JOIN players p ON p.id = ugp.player_id AND p.user_id = ${req.user.id}
          WHERE ugp.group_id = g.id
            AND EXISTS (
              SELECT 1 FROM tournament_players tp
              JOIN tournaments t ON t.id = tp.tournament_id AND t.group_id = g.id
              WHERE tp.player_id = p.id
            )
        )
      ORDER BY g.created_at DESC
    `;
    res.json(groups);
  } catch (err) { next(err); }
});

// GET /api/groups/collaborating — categorías donde el usuario es co-organizador
router.get('/collaborating', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const groups = await sql`
      SELECT g.*,
        u.username   AS owner_username,
        u.name       AS owner_name,
        u.avatar_url AS owner_avatar_url,
        (SELECT COUNT(DISTINCT tp.player_id)::int
         FROM tournament_players tp
         JOIN tournaments t ON t.id = tp.tournament_id
         WHERE t.group_id = g.id) AS player_count,
        (SELECT COUNT(*)::int FROM tournaments t WHERE t.group_id = g.id) AS tournament_count,
        COALESCE(gclub.name, lastclub.name) AS club_name
      FROM groups g
      JOIN users u ON u.id = g.user_id
      JOIN group_collaborators gc ON gc.group_id = g.id AND gc.user_id = ${req.user.id}
      LEFT JOIN clubs gclub ON gclub.id = g.club_id
      LEFT JOIN LATERAL (
        SELECT c2.name
        FROM   tournaments t2
        JOIN   clubs c2 ON c2.id = t2.club_id
        WHERE  t2.group_id = g.id
        ORDER  BY COALESCE(t2.event_date, t2.created_at::date) DESC
        LIMIT  1
      ) lastclub ON g.club_id IS NULL
      ORDER BY g.created_at DESC
    `;
    res.json(groups);
  } catch (err) { next(err); }
});

// GET /api/groups/favorites — categorías que el usuario marcó como favoritas
router.get('/favorites', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const groups = await sql`
      SELECT g.*,
        u.username   AS owner_username,
        u.name       AS owner_name,
        u.avatar_url AS owner_avatar_url,
        (SELECT COUNT(DISTINCT tp.player_id)::int
         FROM tournament_players tp
         JOIN tournaments t ON t.id = tp.tournament_id
         WHERE t.group_id = g.id) AS player_count,
        (SELECT COUNT(*)::int FROM tournaments t WHERE t.group_id = g.id) AS tournament_count,
        COALESCE(gclub.name, lastclub.name) AS club_name
      FROM groups g
      JOIN users u ON u.id = g.user_id
      JOIN group_favorites gf ON gf.group_id = g.id AND gf.user_id = ${req.user.id}
      LEFT JOIN clubs gclub ON gclub.id = g.club_id
      LEFT JOIN LATERAL (
        SELECT c2.name
        FROM   tournaments t2
        JOIN   clubs c2 ON c2.id = t2.club_id
        WHERE  t2.group_id = g.id
        ORDER  BY COALESCE(t2.event_date, t2.created_at::date) DESC
        LIMIT  1
      ) lastclub ON g.club_id IS NULL
      ORDER BY gf.created_at DESC
    `;
    res.json(groups);
  } catch (err) { next(err); }
});

// GET /api/groups/user/:username — perfil público de otro usuario
router.get('/user/:username', optionalAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const [owner] = await sql`
      SELECT u.id, u.name, u.username, u.avatar_url, u.created_at, u.social_links, u.bio,
             u.advanced_stats_public,
             EXISTS (
               SELECT 1 FROM subscriptions s
               WHERE s.user_id = u.id AND s.status = 'active' AND s.plan = 'premium'
             ) AS has_premium_row
      FROM users u
      WHERE u.username = ${req.params.username}
    `;
    if (!owner) return res.status(404).json({ error: 'Usuario no encontrado' });
    // La cuenta anónima que hereda torneos huérfanos no tiene perfil público.
    if (owner.id === ANON_ID) return res.status(404).json({ error: 'Usuario no encontrado' });

    const isOwner  = req.user?.id === owner.id;
    const viewerId = req.user?.id ?? null;
    // Sólo tiene sentido preguntar por el seguimiento si mira otra persona.
    const followerId = isOwner ? null : viewerId;

    // Las avanzadas son del dueño, o de cualquiera si el premium las publicó.
    // `has_premium_row` sale de la consulta de arriba y sólo decide si vale la
    // pena traerlas: el veredicto final lo da `showAdvanced` con la suscripción
    // ya resuelta (getActiveSubscription puede expirarla contra Mercado Pago).
    // Preguntarle a getActiveSubscription acá costaría un round-trip en serie.
    const wantAdvanced = isOwner || (owner.advanced_stats_public === true && owner.has_premium_row === true);

    // A partir de acá todo depende únicamente de owner.id (y del espectador),
    // nada de una consulta alimenta a la siguiente. Con el driver HTTP de Neon
    // cada `sql` es un round-trip propio a São Paulo, así que encadenarlas
    // costaba ~10 viajes en serie: 1,4-2,0 s medidos en producción. Van todas
    // en una sola tanda, y las tres de seguidores colapsadas en una consulta.
    const [
      [follows],
      groups,
      [playerStats],
      dailyActivity,
      monthlyStats,
      matchResults,
      [americanoChamp],
      recentMatches,
      frequentPartners,
      bracketRows,
      leagueRows,
      weekdayStats,
      clubStats,
      followRows,
      followBracketRows,
      sub,
    ] = await Promise.all([
    sql`
      SELECT
        (SELECT COUNT(*)::int FROM user_follows WHERE following_id = ${owner.id}) AS followers_count,
        (SELECT COUNT(*)::int FROM user_follows WHERE follower_id  = ${owner.id}) AS following_count,
        EXISTS (
          SELECT 1 FROM user_follows
          WHERE follower_id = ${followerId}::text AND following_id = ${owner.id}
        ) AS is_following
    `,

    sql`
      SELECT g.*,
        (SELECT COUNT(DISTINCT tp.player_id)::int
         FROM tournament_players tp
         JOIN tournaments t ON t.id = tp.tournament_id
         WHERE t.group_id = g.id) AS player_count,
        (SELECT COUNT(*)::int FROM tournaments t WHERE t.group_id = g.id) AS tournament_count,
        COALESCE(gclub.name, lastclub.name) AS club_name
      FROM groups g
      LEFT JOIN clubs gclub ON gclub.id = g.club_id
      LEFT JOIN LATERAL (
        SELECT c2.name
        FROM   tournaments t2
        JOIN   clubs c2 ON c2.id = t2.club_id
        WHERE  t2.group_id = g.id
        ORDER  BY COALESCE(t2.event_date, t2.created_at::date) DESC
        LIMIT  1
      ) lastclub ON g.club_id IS NULL
      WHERE g.user_id = ${owner.id}
        AND (${isOwner} OR g.is_public = true)
      ORDER BY g.created_at DESC
    `,

    sql`
      SELECT
        COUNT(DISTINCT tp.tournament_id)::int AS torneos,
        COUNT(m.id)::int                      AS partidos,
        COALESCE(SUM(CASE
          WHEN m.score1 > m.score2 AND (m.team1_p1 = p.id OR m.team1_p2 = p.id) THEN 1
          WHEN m.score2 > m.score1 AND (m.team2_p1 = p.id OR m.team2_p2 = p.id) THEN 1
          ELSE 0 END), 0)::int                AS victorias,
        COUNT(DISTINCT CASE WHEN t.format = 'americano' THEN tp.tournament_id END)::int AS torneos_americanos,
        COALESCE(SUM(CASE
          WHEN m.team1_p1 = p.id OR m.team1_p2 = p.id THEN m.score1
          WHEN m.team2_p1 = p.id OR m.team2_p2 = p.id THEN m.score2
          ELSE 0 END), 0)::int AS games_favor,
        COALESCE(SUM(CASE
          WHEN m.team1_p1 = p.id OR m.team1_p2 = p.id THEN m.score2
          WHEN m.team2_p1 = p.id OR m.team2_p2 = p.id THEN m.score1
          ELSE 0 END), 0)::int AS games_contra,
        -- La duración no está en todos los partidos: se cuentan los que sí la tienen.
        COALESCE(SUM(m.duration_seconds), 0)::int AS segundos_jugados,
        COUNT(m.id) FILTER (WHERE m.duration_seconds > 0)::int AS partidos_con_duracion,
        -- Partidos definidos por un solo game.
        COUNT(DISTINCT CASE WHEN m.played_at >= DATE_TRUNC('month', CURRENT_DATE)
                            THEN tp.tournament_id END)::int AS torneos_este_mes,
        COUNT(m.id) FILTER (WHERE ABS(m.score1 - m.score2) = 1)::int AS ajustados,
        COUNT(m.id) FILTER (WHERE ABS(m.score1 - m.score2) = 1 AND (
          (m.score1 > m.score2 AND (m.team1_p1 = p.id OR m.team1_p2 = p.id)) OR
          (m.score2 > m.score1 AND (m.team2_p1 = p.id OR m.team2_p2 = p.id))
        ))::int AS ajustados_ganados
      FROM players p
      JOIN tournament_players tp ON tp.player_id = p.id
      JOIN tournaments t ON t.id = tp.tournament_id
      LEFT JOIN matches m ON m.tournament_id = tp.tournament_id
        AND m.score1 <> m.score2
        AND (m.team1_p1 = p.id OR m.team1_p2 = p.id
          OR m.team2_p1 = p.id OR m.team2_p2 = p.id)
      WHERE p.user_id = ${owner.id}
    `,

    // Actividad diaria para heatmap (últimos 365 días)
    wantAdvanced ? sql`
      SELECT
        m.played_at::date::text AS day,
        COUNT(m.id)::int        AS partidos
      FROM players p
      JOIN matches m ON m.score1 <> m.score2
        AND (m.team1_p1 = p.id OR m.team1_p2 = p.id
          OR m.team2_p1 = p.id OR m.team2_p2 = p.id)
      WHERE p.user_id = ${owner.id}
        AND m.played_at IS NOT NULL
        AND m.played_at >= CURRENT_DATE - INTERVAL '364 days'
      GROUP BY m.played_at::date
      ORDER BY m.played_at::date ASC
    ` : [],

    // Estadísticas mensuales (últimos 12 meses)
    wantAdvanced ? sql`
      SELECT
        TO_CHAR(DATE_TRUNC('month', m.played_at), 'YYYY-MM') AS month,
        COUNT(m.id)::int AS partidos,
        COALESCE(SUM(CASE
          WHEN m.score1 > m.score2 AND (m.team1_p1 = p.id OR m.team1_p2 = p.id) THEN 1
          WHEN m.score2 > m.score1 AND (m.team2_p1 = p.id OR m.team2_p2 = p.id) THEN 1
          ELSE 0 END), 0)::int AS victorias
      FROM players p
      JOIN matches m ON m.score1 <> m.score2
        AND (m.team1_p1 = p.id OR m.team1_p2 = p.id
          OR m.team2_p1 = p.id OR m.team2_p2 = p.id)
      WHERE p.user_id = ${owner.id}
        AND m.played_at >= DATE_TRUNC('month', NOW()) - INTERVAL '11 months'
      GROUP BY DATE_TRUNC('month', m.played_at)
      ORDER BY DATE_TRUNC('month', m.played_at) ASC
    ` : [],

    sql`
      SELECT
        m.played_at,
        m.sets,
        m.sets_format,
        CASE WHEN m.team1_p1 = p.id OR m.team1_p2 = p.id THEN m.score1 ELSE m.score2 END AS my_score,
        CASE WHEN m.team1_p1 = p.id OR m.team1_p2 = p.id THEN m.score2 ELSE m.score1 END AS opp_score,
        (m.team1_p1 = p.id OR m.team1_p2 = p.id) AS is_team1,
        CASE
          WHEN m.score1 > m.score2 AND (m.team1_p1 = p.id OR m.team1_p2 = p.id) THEN true
          WHEN m.score2 > m.score1 AND (m.team2_p1 = p.id OR m.team2_p2 = p.id) THEN true
          ELSE false
        END AS won
      FROM players p
      JOIN matches m ON m.score1 <> m.score2
        AND (m.team1_p1 = p.id OR m.team1_p2 = p.id
          OR m.team2_p1 = p.id OR m.team2_p2 = p.id)
      WHERE p.user_id = ${owner.id}
      ORDER BY m.played_at DESC, m.created_at DESC
    `,

    // Campeón americano = ganó la final del bracket (winner_id es un pair_id)
    sql`
      WITH user_players AS (
        SELECT id FROM players WHERE user_id = ${owner.id}
      )
      SELECT COUNT(*)::int AS campeon_americano
      FROM tournaments t
      JOIN pairs pr
        ON pr.tournament_id = t.id
        AND pr.id = (t.bracket->'final'->>'winner_id')
      WHERE t.format = 'americano'
        AND t.status = 'finished'
        AND t.bracket->'final'->>'winner_id' IS NOT NULL
        AND (
          pr.p1_id IN (SELECT id FROM user_players)
          OR pr.p2_id IN (SELECT id FROM user_players)
        )
    `,

    sql`
      SELECT
        m.id,
        m.played_at,
        m.score1,
        m.score2,
        t.id   AS tournament_id,
        t.group_id,
        t.name AS tournament_name,
        -- Una categoría privada no publica el nombre ni el enlace de sus jornadas.
        COALESCE(
          g.is_public
          OR ${isOwner}::boolean
          OR g.user_id = ${viewerId}::text
          OR EXISTS (SELECT 1 FROM group_collaborators gc
                     WHERE gc.group_id = g.id AND gc.user_id = ${viewerId}::text)
          OR EXISTS (SELECT 1 FROM players vp
                     JOIN tournament_players vtp ON vtp.player_id = vp.id
                     WHERE vp.user_id = ${viewerId}::text AND vtp.tournament_id = t.id),
          false
        ) AS visible,
        CASE
          WHEN m.score1 > m.score2 AND (m.team1_p1 = p.id OR m.team1_p2 = p.id) THEN 'win'
          WHEN m.score2 > m.score1 AND (m.team2_p1 = p.id OR m.team2_p2 = p.id) THEN 'win'
          WHEN m.score1 = m.score2 THEN 'draw'
          ELSE 'loss'
        END AS result,
        CASE
          WHEN m.team1_p1 = p.id OR m.team1_p2 = p.id THEN m.score1
          ELSE m.score2
        END AS my_score,
        CASE
          WHEN m.team1_p1 = p.id OR m.team1_p2 = p.id THEN m.score2
          ELSE m.score1
        END AS opp_score,
        CASE
          WHEN m.team1_p1 = p.id THEN COALESCE(u1b.name, pb.name)
          WHEN m.team1_p2 = p.id THEN COALESCE(u1a.name, pa.name)
          WHEN m.team2_p1 = p.id THEN COALESCE(u2b.name, pd.name)
          WHEN m.team2_p2 = p.id THEN COALESCE(u2a.name, pc.name)
        END AS partner_name,
        CASE
          WHEN m.team1_p1 = p.id OR m.team1_p2 = p.id THEN COALESCE(u2a.name, pc.name)
          ELSE COALESCE(u1a.name, pa.name)
        END AS opp1_name,
        CASE
          WHEN m.team1_p1 = p.id OR m.team1_p2 = p.id THEN COALESCE(u2b.name, pd.name)
          ELSE COALESCE(u1b.name, pb.name)
        END AS opp2_name
      FROM players p
      JOIN matches m ON m.score1 <> m.score2
        AND (m.team1_p1 = p.id OR m.team1_p2 = p.id
          OR m.team2_p1 = p.id OR m.team2_p2 = p.id)
      JOIN tournaments t ON t.id = m.tournament_id
      JOIN groups g ON g.id = t.group_id
      JOIN players pa ON pa.id = m.team1_p1 LEFT JOIN users u1a ON u1a.id = pa.user_id
      JOIN players pb ON pb.id = m.team1_p2 LEFT JOIN users u1b ON u1b.id = pb.user_id
      JOIN players pc ON pc.id = m.team2_p1 LEFT JOIN users u2a ON u2a.id = pc.user_id
      JOIN players pd ON pd.id = m.team2_p2 LEFT JOIN users u2b ON u2b.id = pd.user_id
      WHERE p.user_id = ${owner.id}
      ORDER BY m.played_at DESC, m.created_at DESC
      LIMIT 20
    `,

    sql`
      SELECT
        COALESCE(partner.user_id, partner.id) AS partner_key,
        COALESCE(u.name, partner.name)     AS name,
        u.username,
        u.avatar_url,
        (s.id IS NOT NULL)                 AS is_premium,
        COUNT(*)::int                      AS partidos_juntos
      FROM players p
      JOIN matches m ON m.score1 <> m.score2
        AND (m.team1_p1 = p.id OR m.team1_p2 = p.id
          OR m.team2_p1 = p.id OR m.team2_p2 = p.id)
      JOIN players partner ON partner.id = (
        CASE
          WHEN m.team1_p1 = p.id THEN m.team1_p2
          WHEN m.team1_p2 = p.id THEN m.team1_p1
          WHEN m.team2_p1 = p.id THEN m.team2_p2
          WHEN m.team2_p2 = p.id THEN m.team2_p1
        END
      )
      LEFT JOIN users u ON u.id = partner.user_id
      LEFT JOIN subscriptions s ON s.user_id = u.id AND s.status = 'active' AND s.plan = 'premium'
      WHERE p.user_id = ${owner.id}
      GROUP BY COALESCE(partner.user_id, partner.id),
               COALESCE(u.name, partner.name), u.username, u.avatar_url, s.id
      ORDER BY partidos_juntos DESC
      LIMIT 12
    `,

    // Fase eliminatoria: vive en tournaments.bracket, no en la tabla matches.
    sql`
      SELECT
        t.id        AS tournament_id,
        t.group_id,
        t.name      AS tournament_name,
        t.club_id,
        COALESCE(t.event_date, t.created_at::date)::text AS day,
        t.bracket,
        COALESCE(
          g.is_public
          OR ${isOwner}::boolean
          OR g.user_id = ${viewerId}::text
          OR EXISTS (SELECT 1 FROM group_collaborators gc
                     WHERE gc.group_id = g.id AND gc.user_id = ${viewerId}::text)
          OR EXISTS (SELECT 1 FROM players vp
                     JOIN tournament_players vtp ON vtp.player_id = vp.id
                     WHERE vp.user_id = ${viewerId}::text AND vtp.tournament_id = t.id),
          false
        ) AS visible,
        (SELECT json_agg(json_build_object(
            'id',       pr.id,
            'mine',     COALESCE(p1.user_id = ${owner.id} OR p2.user_id = ${owner.id}, false),
            'my_index', CASE WHEN p1.user_id = ${owner.id} THEN 0
                             WHEN p2.user_id = ${owner.id} THEN 1 END,
            'names',    json_build_array(COALESCE(u1.name, p1.name), COALESCE(u2.name, p2.name)),
            'keys',     json_build_array(COALESCE(p1.user_id, p1.id), COALESCE(p2.user_id, p2.id))
          ))
         FROM pairs pr
         JOIN players p1 ON p1.id = pr.p1_id LEFT JOIN users u1 ON u1.id = p1.user_id
         JOIN players p2 ON p2.id = pr.p2_id LEFT JOIN users u2 ON u2.id = p2.user_id
         WHERE pr.tournament_id = t.id) AS pairs
      FROM tournaments t
      JOIN groups g ON g.id = t.group_id
      WHERE t.format = 'americano'
        AND t.bracket IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM pairs pr
          JOIN players p ON p.id = pr.p1_id OR p.id = pr.p2_id
          WHERE pr.tournament_id = t.id AND p.user_id = ${owner.id}
        )
    `,

    // Agregados por jugador de cada torneo terminado: el campeón lo resuelve
    // countLeagueTitles con la misma lógica que la tabla de posiciones.
    sql`
      SELECT
        t.id                         AS tournament_id,
        (pl.user_id = ${owner.id})   AS mine,
        COUNT(m.id)::int             AS pj,
        COALESCE(SUM(CASE
          WHEN (m.team1_p1 = pl.id OR m.team1_p2 = pl.id) AND m.score1 > m.score2 THEN 1
          WHEN (m.team2_p1 = pl.id OR m.team2_p2 = pl.id) AND m.score2 > m.score1 THEN 1
          ELSE 0 END), 0)::int       AS pg,
        COALESCE(SUM(CASE
          WHEN (m.team1_p1 = pl.id OR m.team1_p2 = pl.id) THEN m.score1 - m.score2
          ELSE m.score2 - m.score1 END), 0)::int AS diff
      FROM tournaments t
      JOIN tournament_players tp ON tp.tournament_id = t.id
      JOIN players pl            ON pl.id = tp.player_id
      LEFT JOIN matches m ON m.tournament_id = t.id
        AND m.score1 <> m.score2
        AND (m.team1_p1 = pl.id OR m.team1_p2 = pl.id
          OR m.team2_p1 = pl.id OR m.team2_p2 = pl.id)
      WHERE t.status = 'finished'
        AND t.format <> 'americano'
        AND EXISTS (
          SELECT 1 FROM tournament_players tp2
          JOIN players p2 ON p2.id = tp2.player_id
          WHERE tp2.tournament_id = t.id AND p2.user_id = ${owner.id}
        )
      GROUP BY t.id, pl.id
    `,

    // Rendimiento por día de la semana (DOW de Postgres: 0 = domingo).
    wantAdvanced ? sql`
      SELECT
        EXTRACT(DOW FROM m.played_at)::int AS dow,
        COUNT(m.id)::int AS partidos,
        COALESCE(SUM(CASE
          WHEN m.score1 > m.score2 AND (m.team1_p1 = p.id OR m.team1_p2 = p.id) THEN 1
          WHEN m.score2 > m.score1 AND (m.team2_p1 = p.id OR m.team2_p2 = p.id) THEN 1
          ELSE 0 END), 0)::int AS victorias
      FROM players p
      JOIN matches m ON m.score1 <> m.score2
        AND (m.team1_p1 = p.id OR m.team1_p2 = p.id
          OR m.team2_p1 = p.id OR m.team2_p2 = p.id)
      WHERE p.user_id = ${owner.id}
        AND m.played_at IS NOT NULL
      GROUP BY EXTRACT(DOW FROM m.played_at)
    ` : [],

    // Clubes donde jugó; los torneos sin club quedan afuera.
    sql`
      SELECT
        c.id, c.name, c.location_name, c.photo_url,
        COUNT(m.id)::int AS partidos,
        COALESCE(SUM(CASE
          WHEN m.score1 > m.score2 AND (m.team1_p1 = p.id OR m.team1_p2 = p.id) THEN 1
          WHEN m.score2 > m.score1 AND (m.team2_p1 = p.id OR m.team2_p2 = p.id) THEN 1
          ELSE 0 END), 0)::int AS victorias,
        COUNT(DISTINCT t.id)::int AS torneos
      FROM players p
      JOIN matches m ON m.score1 <> m.score2
        AND (m.team1_p1 = p.id OR m.team1_p2 = p.id
          OR m.team2_p1 = p.id OR m.team2_p2 = p.id)
      JOIN tournaments t ON t.id = m.tournament_id
      JOIN clubs c ON c.id = t.club_id
      WHERE p.user_id = ${owner.id}
      GROUP BY c.id, c.name, c.location_name, c.photo_url
      ORDER BY partidos DESC
      LIMIT 5
    `,

    // Ranking del usuario contra la gente que sigue. Sólo lo ve él.
    isOwner ? sql`
      WITH circle AS (
        SELECT following_id AS uid FROM user_follows WHERE follower_id = ${owner.id}
        UNION SELECT ${owner.id}
      )
      SELECT
        u.id, u.name, u.username, u.avatar_url,
        (s.id IS NOT NULL) AS is_premium,
        COUNT(m.id)::int   AS partidos,
        COALESCE(SUM(CASE
          WHEN m.score1 > m.score2 AND (m.team1_p1 = p.id OR m.team1_p2 = p.id) THEN 1
          WHEN m.score2 > m.score1 AND (m.team2_p1 = p.id OR m.team2_p2 = p.id) THEN 1
          ELSE 0 END), 0)::int AS victorias
      FROM circle
      JOIN users u ON u.id = circle.uid
      LEFT JOIN subscriptions s ON s.user_id = u.id AND s.status = 'active' AND s.plan = 'premium'
      LEFT JOIN players p ON p.user_id = u.id
      LEFT JOIN matches m ON m.score1 <> m.score2
        AND (m.team1_p1 = p.id OR m.team1_p2 = p.id
          OR m.team2_p1 = p.id OR m.team2_p2 = p.id)
      GROUP BY u.id, u.name, u.username, u.avatar_url, s.id
    ` : [],

    // Cuadros de ese círculo, para que el ranking cuente lo mismo que el perfil.
    isOwner ? sql`
      WITH circle AS (
        SELECT following_id AS uid FROM user_follows WHERE follower_id = ${owner.id}
        UNION SELECT ${owner.id}
      )
      SELECT
        t.bracket,
        (SELECT json_agg(json_build_object(
            'id',       pr.id,
            'user_ids', json_build_array(p1.user_id, p2.user_id)))
         FROM pairs pr
         JOIN players p1 ON p1.id = pr.p1_id
         JOIN players p2 ON p2.id = pr.p2_id
         WHERE pr.tournament_id = t.id) AS pairs
      FROM tournaments t
      WHERE t.format = 'americano'
        AND t.bracket IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM pairs pr
          JOIN players p ON p.id = pr.p1_id OR p.id = pr.p2_id
          WHERE pr.tournament_id = t.id
            AND p.user_id IN (SELECT uid FROM circle)
        )
    ` : [],

    getActiveSubscription(sql, owner.id),
    ]);

    // Los partidos del cuadro se suman a todo lo calculado en SQL.
    const bracketMatches = expandBracketMatches(bracketRows);
    const bracketWins    = bracketMatches.filter((m) => m.result === 'win').length;
    const bracketGf      = bracketMatches.reduce((acc, m) => acc + m.my_score, 0);
    const bracketGc      = bracketMatches.reduce((acc, m) => acc + m.opp_score, 0);

    // Dentro de una misma fecha el cuadro va primero: se juega al cierre.
    const streakRows = [
      ...matchResults.map((r) => ({ won: r.won, day: dayKey(r.played_at), bracket: false })),
      ...bracketMatches.map((m) => ({ won: m.result === 'win', day: dayKey(m.played_at), bracket: true })),
    ].sort((a, b) => (a.day === b.day ? (b.bracket ? 1 : 0) - (a.bracket ? 1 : 0) : (a.day > b.day ? -1 : 1)));
    const { racha, racha_max: rachaMax } = calcStreaks(streakRows);

    // Se intercalan por fecha y se recorta al mismo tope de 20.
    const allRecent = [...recentMatches, ...bracketMatches]
      .sort((a, b) => {
        const da = dayKey(a.played_at), db = dayKey(b.played_at);
        if (da !== db) return da > db ? -1 : 1;
        return (b.bracket_round ? 1 : 0) - (a.bracket_round ? 1 : 0);
      })
      .slice(0, 20);

    // El partido de una categoría privada cuenta en las estadísticas, pero no
    // publica de qué jornada salió: sin nombre y sin ids con los que abrirla.
    const publicRecent = allRecent.map(({ visible, ...m }) =>
      visible === false
        ? { ...m, tournament_id: null, group_id: null, tournament_name: null, private_group: true }
        : m,
    );

    // Con las mismas ventanas que las consultas de arriba.
    const dayLimit   = new Date(Date.now() - 364 * 86400000).toISOString().slice(0, 10);
    const monthLimit = (() => {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - 11);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    })();
    const merged = wantAdvanced
      ? mergeActivity(
          dailyActivity,
          monthlyStats,
          bracketMatches.filter((m) => m.played_at && m.played_at >= dayLimit),
        )
      : { dailyActivity, monthlyStats };
    if (wantAdvanced) {
      merged.monthlyStats = merged.monthlyStats.filter((m) => m.month >= monthLimit);
    }

    const { weekdayStats: weekdays, clubStats: clubs } =
      mergeWeekdayAndClub(weekdayStats, clubStats, bracketMatches);

    const bracketSeconds = bracketMatches.reduce((acc, m) => acc + (m.duration_seconds ?? 0), 0);
    const bracketTimed   = bracketMatches.filter((m) => (m.duration_seconds ?? 0) > 0).length;
    const bracketTight   = bracketMatches.filter((m) => Math.abs(m.my_score - m.opp_score) === 1);

    // El cuadro no guarda sets, así que sólo aporta al criterio de 6-0.
    const blowouts = countBlowouts([...matchResults, ...bracketMatches]);
    const setStats = countSetStats(matchResults);
    const followRanking = buildFollowRanking(followRows, bracketStatsByUser(followBracketRows), owner.id);

    const base = playerStats ?? {
      torneos: 0, partidos: 0, victorias: 0, torneos_americanos: 0, games_favor: 0, games_contra: 0,
      segundos_jugados: 0, partidos_con_duracion: 0,
      ajustados: 0, ajustados_ganados: 0, torneos_este_mes: 0,
    };
    const titulosLiga      = countLeagueTitles(leagueRows);
    const titulosAmericano = americanoChamp?.campeon_americano ?? 0;
    const baseStats = {
      ...base,
      partidos:     base.partidos     + bracketMatches.length,
      victorias:    base.victorias    + bracketWins,
      games_favor:  base.games_favor  + bracketGf,
      games_contra: base.games_contra + bracketGc,
      segundos_jugados:      base.segundos_jugados      + bracketSeconds,
      partidos_con_duracion: base.partidos_con_duracion + bracketTimed,
      ajustados:         base.ajustados         + bracketTight.length,
      ajustados_ganados: base.ajustados_ganados + bracketTight.filter((m) => m.result === 'win').length,
    };

    // Veredicto final sobre las avanzadas, ya con la suscripción resuelta: si
    // wantAdvanced las trajo pero la suscripción resultó vencida, no salen.
    const isPremium    = sub.plan === 'premium';
    const showAdvanced = isOwner || (owner.advanced_stats_public === true && isPremium);

    // `has_premium_row` es un detalle interno de la decisión de arriba.
    const { has_premium_row: _hasPremiumRow, ...ownerFields } = owner;

    // Lo que queda fuera del perfil cuando las avanzadas son privadas. El resto
    // de baseStats (torneos, partidos, victorias, torneos_este_mes...) es lo que
    // el perfil muestra a cualquiera.
    const {
      games_favor, games_contra, segundos_jugados, partidos_con_duracion,
      ajustados, ajustados_ganados, ...basicStats
    } = baseStats;
    const advancedStats = showAdvanced
      ? {
          games_favor, games_contra, segundos_jugados, partidos_con_duracion,
          ajustados, ajustados_ganados,
          racha_max: rachaMax,
          ...blowouts,
          sets: setStats,
        }
      : {};

    res.json({
      owner: {
        ...ownerFields,
        is_premium:      isPremium,
        followers_count: follows.followers_count,
        following_count: follows.following_count,
      },
      is_following: follows.is_following,
      groups,
      stats: {
        ...basicStats,
        racha,
        campeon_americano: titulosAmericano,
        titulos_liga:      titulosLiga,
        titulos:           titulosLiga + titulosAmericano,
        ...advancedStats,
      },
      monthly_stats:  showAdvanced ? merged.monthlyStats  : [],
      daily_activity: showAdvanced ? merged.dailyActivity : [],
      weekday_stats:  showAdvanced ? weekdays : [],
      club_stats:     clubs,
      follow_ranking: followRanking,
      recent_matches: publicRecent,
      frequent_partners: mergeFrequentPartners(frequentPartners, bracketMatches),
    });
  } catch (err) { next(err); }
});

// GET /api/groups/search?q= — busca grupos públicos por nombre
router.get('/search', async (req, res, next) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json([]);
    const sql = getDb();
    const groups = await sql`
      SELECT g.id, g.name, g.description, g.emojis, g.created_at,
             u.username AS owner_username, u.name AS owner_name, u.avatar_url AS owner_avatar_url,
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
        AND g.name ILIKE ${'%' + q + '%'}
      ORDER BY g.created_at DESC
      LIMIT 10
    `;
    res.json(groups);
  } catch (err) { next(err); }
});

// GET /api/groups/nearby?lat=&lon=&radius= — grupos públicos con ubicación cercana (Haversine, radio en km)
router.get('/nearby', async (req, res, next) => {
  try {
    const lat    = parseFloat(req.query.lat);
    const lon    = parseFloat(req.query.lon);
    const radius = Math.min(parseFloat(req.query.radius) || 20, 100);
    if (isNaN(lat) || isNaN(lon)) return res.status(400).json({ error: 'lat y lon requeridos' });

    const sql = getDb();
    const groups = await sql`
      SELECT g.id, g.name, g.description, g.emojis, g.location_name, g.lat, g.lon,
             u.username AS owner_username, u.name AS owner_name,
             ROUND(
               (6371 * acos(
                 LEAST(1, cos(radians(${lat})) * cos(radians(g.lat)) *
                 cos(radians(g.lon) - radians(${lon})) +
                 sin(radians(${lat})) * sin(radians(g.lat)))
               ))::numeric, 1
             ) AS distance_km
      FROM groups g
      JOIN users u ON u.id = g.user_id
      WHERE g.is_public = true
        AND g.lat IS NOT NULL
        AND g.lon IS NOT NULL
        AND (6371 * acos(
          LEAST(1, cos(radians(${lat})) * cos(radians(g.lat)) *
          cos(radians(g.lon) - radians(${lon})) +
          sin(radians(${lat})) * sin(radians(g.lat)))
        )) <= ${radius}
      ORDER BY distance_km ASC
      LIMIT 20
    `;
    res.json(groups);
  } catch (err) { next(err); }
});

// GET /api/groups/:groupId/meta — metadata mínima de la categoría.
// GET /:groupId devuelve ~10 consultas (torneos, ganadores, estadísticas,
// co-organizadores), pero la vista de jornada y la de espectador sólo necesitan
// el nombre, los emojis y un par de flags: las llamaban en cada mutación y en
// cada ciclo de refresco. Esto es una sola consulta.
router.get('/:groupId/meta', optionalAuth, async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const sql = getDb();
    // El cast explícito es necesario: sin sesión el parámetro viaja como NULL y
    // Postgres no puede inferir su tipo.
    const viewerId = req.user?.id ?? null;
    const [group] = await sql`
      SELECT g.id, g.name, g.emojis, g.is_public, g.user_id,
             u.username AS owner_username, u.name AS owner_name, u.avatar_url AS owner_avatar_url,
             (EXISTS (
               SELECT 1 FROM subscriptions s
               WHERE s.user_id = g.user_id AND s.plan = 'premium' AND s.status = 'active'
             )) AS owner_is_premium,
             (g.user_id = ${viewerId}::text) AS is_owner,
             EXISTS (SELECT 1 FROM group_collaborators gc
                     WHERE gc.group_id = g.id AND gc.user_id = ${viewerId}::text) AS is_collab
      FROM groups g
      JOIN users u ON u.id = g.user_id
      WHERE g.id = ${groupId}
    `;
    if (!group) return res.status(404).json({ error: 'Grupo no encontrado' });

    const { user_id, is_owner, is_collab, ...rest } = group;
    res.json({
      ...rest,
      is_owner:   is_owner === true,
      can_manage: is_owner === true || is_collab === true,
    });
  } catch (err) { next(err); }
});

// GET /api/groups/:groupId/history — estadísticas históricas de todas las jornadas
router.get('/:groupId/history', async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const sql = getDb();

    const tournaments = await sql`
      SELECT t.id, t.name, t.created_at, t.status, t.mode, t.format, t.bracket,
             t.event_date, t.club_id, c.name AS club_name, c.photo_url AS club_photo_url
      FROM   tournaments t
      LEFT   JOIN clubs c ON c.id = t.club_id
      WHERE  t.group_id = ${groupId}
      ORDER  BY t.created_at ASC
    `;

    if (tournaments.length === 0) return res.json([]);

    // Un lote por tabla en vez de tres consultas por jornada. Sobre el driver
    // HTTP de Neon cada sentencia es un round-trip, así que el N+1 costaba
    // 1+3N peticiones de red (91 para 30 jornadas) resueltas en serie.
    const ids = tournaments.map((t) => t.id);

    const [allPlayers, allMatches, allPairs] = await Promise.all([
      sql`
        SELECT tp.tournament_id,
               p.id, p.name, u.name AS linked_name, u.username AS linked_username,
               u.avatar_url AS linked_avatar_url
        FROM   tournament_players tp
        JOIN   players p ON p.id = tp.player_id
        LEFT   JOIN users u ON u.id = p.user_id
        WHERE  tp.tournament_id = ANY(${ids})
      `,
      sql`SELECT * FROM matches WHERE tournament_id = ANY(${ids}) ORDER BY created_at DESC`,
      sql`SELECT * FROM pairs   WHERE tournament_id = ANY(${ids})`,
    ]);

    const groupBy = (rows) => {
      const by = new Map(ids.map((id) => [id, []]));
      for (const row of rows) by.get(row.tournament_id)?.push(row);
      return by;
    };
    const playersBy = groupBy(allPlayers);
    const matchesBy = groupBy(allMatches);
    const pairsBy   = groupBy(allPairs);

    // tournament_id se agregó sólo para agrupar: no formaba parte del payload
    // que devolvía la versión anterior.
    const result = tournaments.map((t) => ({
      ...t,
      players: (playersBy.get(t.id) ?? []).map(({ tournament_id, ...p }) => p),
      matches: matchesBy.get(t.id) ?? [],
      pairs:   pairsBy.get(t.id)   ?? [],
    }));

    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/groups/:groupId
router.get('/:groupId', optionalAuth, async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const sql = getDb();

    // Tanda 1: el grupo, sus jornadas y los co-organizadores sólo dependen de
    // groupId, así que no hay motivo para encadenarlas. Con el driver HTTP de
    // Neon cada await en serie es un round-trip más a São Paulo.
    const [[group], tournaments, collaborators] = await Promise.all([
    sql`
      SELECT g.*, u.username AS owner_username, u.name AS owner_name, u.avatar_url AS owner_avatar_url,
             u.social_links AS owner_social_links,
             c.name AS club_name, c.location_name AS club_location_name, c.photo_url AS club_photo_url,
             c.courts AS club_courts,
             cr.name AS pending_club_name,
             (EXISTS (
               SELECT 1 FROM subscriptions s
               WHERE s.user_id = g.user_id AND s.plan = 'premium' AND s.status = 'active'
             )) AS owner_is_premium
      FROM groups g
      JOIN users u ON u.id = g.user_id
      LEFT JOIN clubs c ON c.id = g.club_id
      LEFT JOIN club_requests cr ON cr.id = g.pending_club_request_id
      WHERE g.id = ${groupId}
    `,

    sql`
      SELECT t.*,
             c.name AS club_name, c.location_name AS club_location_name,
             c.courts AS club_courts, c.photo_url AS club_photo_url,
             COUNT(DISTINCT m.id)::int  AS match_count,
             COUNT(DISTINCT tp.player_id)::int AS player_count,
             COUNT(DISTINCT pr.id)::int AS pair_count
      FROM   tournaments t
      LEFT JOIN clubs              c  ON c.id = t.club_id
      LEFT JOIN matches           m  ON m.tournament_id  = t.id
      LEFT JOIN tournament_players tp ON tp.tournament_id = t.id
      LEFT JOIN pairs             pr ON pr.tournament_id = t.id
      WHERE  t.group_id = ${groupId}
      GROUP  BY t.id, c.id
      ORDER  BY t.created_at DESC
    `,

    sql`
      SELECT u.id AS user_id, u.name, u.username, u.avatar_url
      FROM   group_collaborators gc
      JOIN   users u ON u.id = gc.user_id
      WHERE  gc.group_id = ${groupId}
      ORDER  BY gc.added_at ASC
    `,
    ]);

    if (!group) return res.status(404).json({ error: 'Grupo no encontrado' });

    const viewerId = req.user?.id ?? null;
    const is_owner = !!viewerId && group.user_id === viewerId;

    // ── Ganador por jornada finalizada ──────────────────────────────────────
    const finishedIds  = tournaments.filter((t) => t.status === 'finished').map((t) => t.id);
    const pairsModeIds = tournaments
      .filter((t) => t.status === 'finished' && t.mode === 'pairs')
      .map((t) => t.id);
    // Americano: resolver ganador desde pares actuales (no desde el string guardado en el bracket)
    const americanoFinished = tournaments.filter(
      (t) => t.status === 'finished' && t.format === 'americano' && t.bracket?.final?.winner_id
    );
    const americanoPairIds = americanoFinished.map((t) => t.bracket.final.winner_id);

    // Tanda 2: los tres agregados derivan de `tournaments`, no unos de otros, y
    // la transferencia pendiente sólo necesitaba saber si mira el dueño.
    const [wins, allPairs, americanoPairs, transferRows, invitationRows, myPlayerRows, favRows,
           claimableRows] = await Promise.all([
      finishedIds.length ? sql`
        SELECT tournament_id, player_id,
               SUM(won)::int AS wins, SUM(diff)::int AS gdiff
        FROM (
          SELECT tournament_id, team1_p1 AS player_id,
                 (CASE WHEN score1 > score2 THEN 1 ELSE 0 END) AS won, score1 - score2 AS diff
          FROM matches WHERE tournament_id = ANY(${finishedIds})
          UNION ALL
          SELECT tournament_id, team1_p2,
                 (CASE WHEN score1 > score2 THEN 1 ELSE 0 END), score1 - score2
          FROM matches WHERE tournament_id = ANY(${finishedIds}) AND team1_p2 IS NOT NULL
          UNION ALL
          SELECT tournament_id, team2_p1,
                 (CASE WHEN score2 > score1 THEN 1 ELSE 0 END), score2 - score1
          FROM matches WHERE tournament_id = ANY(${finishedIds})
          UNION ALL
          SELECT tournament_id, team2_p2,
                 (CASE WHEN score2 > score1 THEN 1 ELSE 0 END), score2 - score1
          FROM matches WHERE tournament_id = ANY(${finishedIds}) AND team2_p2 IS NOT NULL
        ) sub WHERE player_id IS NOT NULL
        GROUP BY tournament_id, player_id
      ` : [],

      pairsModeIds.length
        ? sql`SELECT * FROM pairs WHERE tournament_id = ANY(${pairsModeIds})`
        : [],

      americanoPairIds.length ? sql`
        SELECT pr.id,
          COALESCE(u1.name, p1.name) AS p1_name,
          COALESCE(u2.name, p2.name) AS p2_name
        FROM pairs pr
        JOIN players p1 ON p1.id = pr.p1_id LEFT JOIN users u1 ON u1.id = p1.user_id
        JOIN players p2 ON p2.id = pr.p2_id LEFT JOIN users u2 ON u2.id = p2.user_id
        WHERE pr.id = ANY(${americanoPairIds})
      ` : [],

      // Transferencia de propiedad pendiente (sólo la ve el dueño)
      is_owner ? sql`
        SELECT ot.id, ot.created_at,
               u.name AS to_name, u.username AS to_username
        FROM   ownership_transfers ot
        LEFT   JOIN users u ON u.id = ot.to_user_id
        WHERE  ot.group_id = ${groupId} AND ot.status = 'pending'
        ORDER  BY ot.created_at DESC
        LIMIT  1
      ` : [],

      // Invitación de jugador pendiente para quien mira: sin esto la única forma
      // de aceptarla era la campana de notificaciones.
      viewerId ? sql`
        SELECT pi.id, pi.player_id, pi.created_at,
               p.name AS player_name,
               u.name AS invited_by_name, u.username AS invited_by_username
        FROM   player_invitations pi
        JOIN   players p ON p.id = pi.player_id
        JOIN   users   u ON u.id = pi.invited_by
        WHERE  pi.group_id = ${groupId}
          AND  pi.invited_user_id = ${viewerId}
          AND  pi.status = 'pending'
        ORDER  BY pi.created_at DESC
        LIMIT  1
      ` : [],

      // Slot de jugador de quien mira, si aceptó una invitación en esta
      // categoría: habilita el botón de desvincularse. Exige participación real
      // en alguna jornada — un slot vinculado pero sin jornadas no es jugar.
      viewerId ? sql`
        SELECT p.id, p.name
        FROM   players p
        JOIN   group_players gp ON gp.player_id = p.id AND gp.group_id = ${groupId}
        WHERE  p.user_id = ${viewerId}
          AND  EXISTS (
            SELECT 1
            FROM   tournament_players tp
            JOIN   tournaments t ON t.id = tp.tournament_id AND t.group_id = ${groupId}
            WHERE  tp.player_id = p.id
          )
        ORDER  BY p.name ASC
        LIMIT  1
      ` : [],

      sql`
        SELECT COUNT(*)::int AS favorites_count,
               COALESCE(BOOL_OR(gf.user_id = ${viewerId}), false) AS is_favorite
        FROM   group_favorites gf
        WHERE  gf.group_id = ${groupId}
      `,

      // Slots libres que quien mira podría reclamar: jugadores de la categoría
      // sin cuenta vinculada. Cada uno viaja con una jornada suya porque la
      // solicitud de unión se pide contra una jornada concreta, aunque el
      // vínculo que resulta sea de toda la categoría.
      //
      // Se omite si ya tiene un slot vinculado acá: una cuenta ocupa uno solo
      // por categoría, así que no habría nada que reclamar.
      viewerId ? sql`
        SELECT p.id, p.name,
               (SELECT t.id
                FROM   tournament_players tp
                JOIN   tournaments t ON t.id = tp.tournament_id AND t.group_id = ${groupId}
                WHERE  tp.player_id = p.id
                ORDER  BY COALESCE(t.event_date, t.created_at::date) DESC
                LIMIT  1) AS tournament_id
        FROM   players p
        JOIN   group_players gp ON gp.player_id = p.id AND gp.group_id = ${groupId}
        WHERE  p.user_id IS NULL
          AND  NOT EXISTS (
            SELECT 1 FROM players mine
            JOIN   group_players mgp ON mgp.player_id = mine.id AND mgp.group_id = ${groupId}
            WHERE  mine.user_id = ${viewerId}
          )
          AND  EXISTS (
            SELECT 1
            FROM   tournament_players tp
            JOIN   tournaments t ON t.id = tp.tournament_id AND t.group_id = ${groupId}
            WHERE  tp.player_id = p.id
          )
        ORDER  BY p.name ASC
      ` : [],
    ]);

    // Tanda 3: los nombres son lo único que depende de un resultado anterior.
    const playerIds = [...new Set(wins.map((w) => w.player_id))];
    const pNames = playerIds.length
      ? await sql`
          SELECT p.id, COALESCE(u.name, p.name) AS name
          FROM players p LEFT JOIN users u ON u.id = p.user_id
          WHERE p.id = ANY(${playerIds})
        `
      : [];
    const nameById = Object.fromEntries(pNames.map((p) => [p.id, p.name]));

    if (finishedIds.length > 0) {
      const winsByT = {};
      wins.forEach((w) => { (winsByT[w.tournament_id] ??= []).push(w); });

      if (americanoFinished.length > 0) {
        const americanoWinnerByPair = Object.fromEntries(
          americanoPairs.map((p) => [p.id, `${p.p1_name} & ${p.p2_name}`])
        );
        for (const t of americanoFinished) {
          t.winner_label = americanoWinnerByPair[t.bracket.final.winner_id] ?? t.bracket.final.winner_name;
        }
      }

      for (const t of tournaments) {
        if (t.status !== 'finished' || t.format === 'americano') continue;

        const tWins = winsByT[t.id] ?? [];
        if (!tWins.length) continue;
        const maxW    = Math.max(...tWins.map((w) => w.wins));
        const topByW  = tWins.filter((w) => w.wins === maxW);
        const maxD    = Math.max(...topByW.map((w) => w.gdiff));
        const topList = topByW.filter((w) => w.gdiff === maxD);
        const topIds  = new Set(topList.map((w) => w.player_id));

        if (t.mode === 'pairs') {
          const tPairs      = allPairs.filter((p) => p.tournament_id === t.id);
          const winnerPairs = tPairs.filter((p) => topIds.has(p.p1_id) && topIds.has(p.p2_id));
          t.winner_label = winnerPairs.length
            ? winnerPairs.map((p) => `${nameById[p.p1_id] ?? '?'} & ${nameById[p.p2_id] ?? '?'}`).join(' / ')
            : topList.map((w) => nameById[w.player_id] ?? '?').join(' / ');
        } else {
          t.winner_label = topList.map((w) => nameById[w.player_id] ?? '?').join(' / ');
        }
      }
    }

    // Nota: acá se calculaban dos agregados pesados más, `playerStats` (con un
    // JOIN a tournaments sin correlacionar, o sea un producto cartesiano
    // jugadores × jornadas) y `tournamentWinners` (RANK() sobre todos los
    // partidos de la categoría). Se devolvían bajo `stats` y ningún componente
    // del frontend los consumía. Eliminados: si alguna vista los necesita en el
    // futuro, van en su propio endpoint y se piden bajo demanda.
    // El total de jornadas por categoría sigue viniendo en `tournament_count`
    // de los listados de grupos, y el ganador de cada jornada en `winner_label`.

    const can_manage = is_owner || (!!viewerId && collaborators.some((c) => c.user_id === viewerId));
    const pending_transfer = transferRows[0] ?? null;

    res.json({
      ...group, tournaments,
      collaborators, is_owner, can_manage, pending_transfer,
      my_invitation: invitationRows[0] ?? null,
      my_player: myPlayerRows[0] ?? null,
      favorites_count: favRows[0]?.favorites_count ?? 0,
      is_favorite: favRows[0]?.is_favorite ?? false,
      // Quien ya gestiona la categoría no reclama ningún lugar.
      claimable_players: can_manage ? [] : claimableRows.filter((p) => p.tournament_id),
    });
  } catch (err) { next(err); }
});

// POST /api/groups/:groupId/favorite — marcar una categoría pública como favorita
router.post('/:groupId/favorite', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const { groupId } = req.params;

    const [group] = await sql`SELECT id, user_id, is_public FROM groups WHERE id = ${groupId}`;
    if (!group) return res.status(404).json({ error: 'Categoría no encontrada' });
    if (!group.is_public) return res.status(403).json({ error: 'Esta categoría es privada' });
    if (group.user_id === req.user.id) return res.status(400).json({ error: 'Ya sos el dueño de esta categoría' });

    const [collab] = await sql`
      SELECT 1 FROM group_collaborators WHERE group_id = ${groupId} AND user_id = ${req.user.id}
    `;
    if (collab) return res.status(400).json({ error: 'Ya co-organizás esta categoría' });

    await sql`
      INSERT INTO group_favorites (user_id, group_id) VALUES (${req.user.id}, ${groupId})
      ON CONFLICT DO NOTHING
    `;
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/groups/:groupId/favorite — sacar de favoritas
router.delete('/:groupId/favorite', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    await sql`
      DELETE FROM group_favorites WHERE user_id = ${req.user.id} AND group_id = ${req.params.groupId}
    `;
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/groups — requiere auth
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { name, description, is_public = true, emojis = [], location_name, place_id, lat, lon,
            club_id = null, pending_club_request_id = null } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name requerido' });
    if (name.trim().length > 30) return res.status(400).json({ error: 'El nombre del torneo no puede superar los 30 caracteres' });
    if (name.trim().length < 2) return res.status(400).json({ error: 'El nombre del torneo debe tener mas de 2 caracteres' });
    if (description && description.trim().length > 50) return res.status(400).json({ error: 'La descripción no puede superar los 50 caracteres' });

    // La inscripción ahora se puede cargar en el alta, no sólo al editar. Las
    // claves ausentes quedan en NULL, que es el valor que ya tenía una categoría
    // recién creada.
    let signup;
    try { signup = parseSignupFields(req.body); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const sql = getDb();
    const [quotaError, clubRows] = await Promise.all([
      groupQuotaError(sql, req.user.id),
      club_id ? sql`SELECT id FROM clubs WHERE id = ${club_id}` : Promise.resolve([]),
    ]);
    if (quotaError) return res.status(403).json({ error: quotaError, code: 'plan_limit' });
    if (club_id && clubRows.length === 0) return res.status(404).json({ error: 'Club no encontrado' });
    const [group] = await sql`
      INSERT INTO groups (id, name, description, user_id, is_public, emojis, location_name, place_id, lat, lon,
                          club_id, pending_club_request_id,
                          signup_open, signup_price, signup_price_unit, signup_contacts)
      VALUES (${uid()}, ${name.trim()}, ${description ?? null}, ${req.user.id}, ${is_public}, ${emojis},
              ${location_name ?? null}, ${place_id ?? null}, ${lat ?? null}, ${lon ?? null},
              ${club_id ?? null}, ${pending_club_request_id ?? null},
              ${signup.signup_open ?? null}, ${signup.signup_price ?? null},
              ${signup.signup_price_unit ?? null},
              ${signup.signup_contacts ? JSON.stringify(signup.signup_contacts) : null}::jsonb)
      RETURNING *
    `;
    res.status(201).json(group);
  } catch (err) { next(err); }
});

// PUT /api/groups/:groupId — solo el dueño
router.put('/:groupId', requireAuth, async (req, res, next) => {
  try {
    const { name, description, is_public, emojis, location_name, place_id, lat, lon, club_id, pending_club_request_id } = req.body;
    let signup;
    try { signup = parseSignupFields(req.body); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    if (name !== undefined && name.trim().length > 30) return res.status(400).json({ error: 'El nombre del torneo no puede superar los 30 caracteres' });
    if (name !== undefined && name.trim().length < 2) return res.status(400).json({ error: 'El nombre del torneo debe tener mas de 2 caracteres' });
    if (description !== undefined && description !== null && description.trim().length > 50) return res.status(400).json({ error: 'La descripción no puede superar los 50 caracteres' });
    const sql = getDb();
    const [group] = await sql`SELECT user_id FROM groups WHERE id = ${req.params.groupId}`;
    if (!group) return res.status(404).json({ error: 'Grupo no encontrado' });
    if (group.user_id !== req.user.id) return res.status(403).json({ error: 'Sin permiso' });
    if (club_id) {
      const [club] = await sql`SELECT id FROM clubs WHERE id = ${club_id}`;
      if (!club) return res.status(404).json({ error: 'Club no encontrado' });
    }

    const [updated] = await sql`
      UPDATE groups
      SET name = COALESCE(${name ?? null}, name),
          description = COALESCE(${description ?? null}, description),
          is_public = COALESCE(${is_public ?? null}, is_public),
          emojis = COALESCE(${emojis ?? null}, emojis),
          location_name = COALESCE(${location_name ?? null}, location_name),
          place_id = COALESCE(${place_id ?? null}, place_id),
          lat = COALESCE(${lat ?? null}, lat),
          lon = COALESCE(${lon ?? null}, lon),
          club_id = CASE WHEN ${club_id !== undefined}::boolean THEN ${club_id ?? null} ELSE club_id END,
          pending_club_request_id = CASE WHEN ${pending_club_request_id !== undefined}::boolean THEN ${pending_club_request_id ?? null} ELSE pending_club_request_id END,
          signup_open       = CASE WHEN ${'signup_open'       in signup}::boolean THEN ${signup.signup_open       ?? null} ELSE signup_open END,
          signup_price      = CASE WHEN ${'signup_price'      in signup}::boolean THEN ${signup.signup_price      ?? null} ELSE signup_price END,
          signup_price_unit = CASE WHEN ${'signup_price_unit' in signup}::boolean THEN ${signup.signup_price_unit ?? null} ELSE signup_price_unit END,
          signup_contacts   = CASE WHEN ${'signup_contacts'   in signup}::boolean THEN ${signup.signup_contacts ? JSON.stringify(signup.signup_contacts) : null}::jsonb ELSE signup_contacts END
      WHERE id = ${req.params.groupId} RETURNING *
    `;
    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /api/groups/:groupId — solo el dueño
router.delete('/:groupId', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const [group] = await sql`SELECT user_id FROM groups WHERE id = ${req.params.groupId}`;
    if (!group) return res.status(404).json({ error: 'Grupo no encontrado' });
    if (group.user_id !== req.user.id) return res.status(403).json({ error: 'Sin permiso' });
    await sql`DELETE FROM groups WHERE id = ${req.params.groupId}`;
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;

