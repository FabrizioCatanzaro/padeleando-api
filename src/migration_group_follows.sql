-- Seguidores de una categoría: avisa al seguidor cuando se crea una jornada nueva.
CREATE TABLE IF NOT EXISTS group_follows (
  user_id    TEXT NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_group_follows_user  ON group_follows(user_id);
CREATE INDEX IF NOT EXISTS idx_group_follows_group ON group_follows(group_id);

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('follow','invitation','join_request','admin_message','club_request',
                  'collab_invite','ownership_transfer','ownership_received','premium_claim',
                  'player_unlinked','new_tournament'));
