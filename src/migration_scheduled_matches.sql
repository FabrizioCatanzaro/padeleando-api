-- Partidos programados: el fixture de una jornada. Equipos, cancha y hora, pero
-- todavía sin resultado.
--
-- Va en su propia tabla y NO como filas de `matches` sin score por dos razones:
--   1. matches.score1/score2 son INTEGER NOT NULL, y aflojar eso toca la tabla
--      que guarda todo el historial jugado.
--   2. Hay quince criterios distintos de "¿este partido está jugado?" repartidos
--      por la app, y cinco no distinguen un partido sin resultado bajo ninguna
--      representación (`t.matches.length` a secas, `match_count > 0` que el
--      backend devuelve sin filtrar). Un fixture guardado en `matches` inflaría
--      las estadísticas del club, los contadores del admin y el total de la
--      portada, y marcaría la jornada como EN CURSO apenas se programe.
-- Con tabla aparte, nada de lo que ya funciona cambia de comportamiento.
CREATE TABLE IF NOT EXISTS scheduled_matches (
  id            TEXT PRIMARY KEY,
  tournament_id TEXT    NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  -- ON DELETE CASCADE y no RESTRICT como en `matches`: un partido que todavía no
  -- se jugó y perdió a uno de sus jugadores no es historia que haya que
  -- proteger, es una programación que dejó de tener sentido.
  team1_p1      TEXT    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team1_p2      TEXT    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team2_p1      TEXT    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team2_p2      TEXT    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  court         INTEGER,
  -- Sólo la hora: la fecha es la de la jornada (tournaments.event_date).
  scheduled_at  TIME,
  -- Orden manual dentro del fixture, para los que no tienen hora cargada.
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_matches_tournament
  ON scheduled_matches(tournament_id);
