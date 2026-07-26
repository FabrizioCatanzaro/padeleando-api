-- Índices de rendimiento (auditoría jul 2026 — hallazgo B3).
-- Cubren los patrones de acceso que hoy resuelven con seq scan.
-- Idempotente: se puede aplicar varias veces sin efecto.

-- ── 1. Vínculo jugador ↔ usuario ────────────────────────────────────────────
-- Usado por las 7 consultas de GET /groups/user/:username (WHERE p.user_id = …)
-- y por cada `LEFT JOIN users u ON u.id = p.user_id` del patrón linked_name.
CREATE INDEX IF NOT EXISTS idx_players_user ON players(user_id);

-- ── 2. Categorías por dueño ─────────────────────────────────────────────────
-- GET /groups, /groups/participating, /groups/collaborating y canManageGroup()
-- —este último corre en CADA mutación vía los guards de middleware/access.js.
CREATE INDEX IF NOT EXISTS idx_groups_user ON groups(user_id);

-- ── 3. Lados inversos de las tablas puente ──────────────────────────────────
-- Ya existen los índices por (tournament_id) y (group_id); falta el sentido
-- "¿en qué jornadas/categorías está este jugador?", que usan el perfil público,
-- POST /tournaments y la resolución de invitaciones.
CREATE INDEX IF NOT EXISTS idx_tp_player ON tournament_players(player_id);
CREATE INDEX IF NOT EXISTS idx_gp_player ON group_players(player_id);

-- ── 4. Las cuatro columnas de jugador de matches ────────────────────────────
-- Las consultas de estadísticas filtran con
--   JOIN matches m ON (m.team1_p1 = p.id OR m.team1_p2 = p.id
--                   OR m.team2_p1 = p.id OR m.team2_p2 = p.id)
-- Un OR sobre cuatro columnas no puede usar un único B-tree, pero con un índice
-- por columna el planner puede resolverlo con BitmapOr en lugar de recorrer
-- matches entera. Es una mitigación, no la solución definitiva: lo correcto a
-- futuro es una tabla puente match_players(match_id, player_id, team).
CREATE INDEX IF NOT EXISTS idx_matches_t1p1 ON matches(team1_p1);
CREATE INDEX IF NOT EXISTS idx_matches_t1p2 ON matches(team1_p2);
CREATE INDEX IF NOT EXISTS idx_matches_t2p1 ON matches(team2_p1);
CREATE INDEX IF NOT EXISTS idx_matches_t2p2 ON matches(team2_p2);

-- Nota: notifications(user_id) WHERE read = false ya existe en
-- migration_notifications.sql y es el índice óptimo para /notifications/count.

ANALYZE players;
ANALYZE groups;
ANALYZE matches;
ANALYZE tournament_players;
ANALYZE group_players;
