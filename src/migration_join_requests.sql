CREATE TABLE IF NOT EXISTS tournament_join_requests (
  id            TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  player_id     TEXT REFERENCES players(id),
  requested_player_id TEXT REFERENCES players(id),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tournament_id, user_id)
);

-- Para bases que ya tenían la tabla sin la columna del jugador solicitado.
ALTER TABLE tournament_join_requests ADD COLUMN IF NOT EXISTS requested_player_id TEXT REFERENCES players(id);

CREATE INDEX IF NOT EXISTS idx_join_requests_tournament ON tournament_join_requests(tournament_id);
CREATE INDEX IF NOT EXISTS idx_join_requests_user       ON tournament_join_requests(user_id);

-- Extender el CHECK constraint del tipo de notificación para incluir join_request
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('follow', 'invitation', 'join_request'));
