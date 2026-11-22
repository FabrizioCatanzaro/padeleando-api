// Consultas que comparten el perfil público y el resumen de /api/me.

// Campeón por cuadro = ganó la final (winner_id es un pair_id): americano, copa y liga con playoffs.
export function championCountsQuery(sql, userId) {
  return sql`
    WITH user_players AS (
      SELECT id FROM players WHERE user_id = ${userId}
    )
    SELECT COUNT(*) FILTER (WHERE t.format = 'americano')::int AS campeon_americano,
           COUNT(*) FILTER (WHERE t.format = 'copa')::int AS campeon_copa,
           COUNT(*) FILTER (WHERE t.format = 'liga')::int AS campeon_playoffs
    FROM tournaments t
    JOIN pairs pr
      ON pr.tournament_id = t.id
      AND pr.id = (t.bracket->'final'->>'winner_id')
    WHERE t.status = 'finished'
      AND t.bracket->'final'->>'winner_id' IS NOT NULL
      AND (
        pr.p1_id IN (SELECT id FROM user_players)
        OR pr.p2_id IN (SELECT id FROM user_players)
      )
  `;
}

// Agregados por jugador de cada liga terminada; el campeón lo resuelve countLeagueTitles.
export function leagueTitleRowsQuery(sql, userId) {
  return sql`
    SELECT
      t.id                         AS tournament_id,
      (pl.user_id = ${userId})   AS mine,
      COUNT(m.id)::int             AS pj,
      COALESCE(SUM(CASE
        WHEN (m.team1_p1 = pl.id OR m.team1_p2 = pl.id) AND m.score1 > m.score2 THEN 1
        WHEN (m.team2_p1 = pl.id OR m.team2_p2 = pl.id) AND m.score2 > m.score1 THEN 1
        ELSE 0 END), 0)::int       AS pg,
      COALESCE(SUM(CASE
        WHEN (m.team1_p1 = pl.id OR m.team1_p2 = pl.id) THEN m.score1 - m.score2
        ELSE m.score2 - m.score1 END), 0)::int AS diff,
      COALESCE(SUM(CASE
        WHEN (m.team1_p1 = pl.id OR m.team1_p2 = pl.id) THEN m.score1
        ELSE m.score2 END), 0)::int AS gf,
      -- Puntos de la tabla: la derrota por W.O. no suma.
      COALESCE(SUM(CASE
        WHEN (m.team1_p1 = pl.id OR m.team1_p2 = pl.id) AND m.score1 > m.score2 THEN t.points_win
        WHEN (m.team2_p1 = pl.id OR m.team2_p2 = pl.id) AND m.score2 > m.score1 THEN t.points_win
        WHEN m.id IS NOT NULL AND NOT m.walkover THEN t.points_loss
        ELSE 0 END), 0)::int AS pts
    FROM tournaments t
    JOIN tournament_players tp ON tp.tournament_id = t.id
    JOIN players pl            ON pl.id = tp.player_id
    LEFT JOIN matches m ON m.tournament_id = t.id
      AND m.score1 <> m.score2
      AND (m.team1_p1 = pl.id OR m.team1_p2 = pl.id
        OR m.team2_p1 = pl.id OR m.team2_p2 = pl.id)
    WHERE t.status = 'finished'
      AND t.format = 'liga'
      AND t.bracket IS NULL
      AND EXISTS (
        SELECT 1 FROM tournament_players tp2
        JOIN players p2 ON p2.id = tp2.player_id
        WHERE tp2.tournament_id = t.id AND p2.user_id = ${userId}
      )
    GROUP BY t.id, pl.id
  `;
}
