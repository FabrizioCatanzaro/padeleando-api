-- Categorías favoritas: avisa al usuario cuando se crea una jornada nueva.
-- Nació como group_follows; el rename conserva las filas ya marcadas.
DO $$
BEGIN
  IF to_regclass('public.group_follows') IS NOT NULL
     AND to_regclass('public.group_favorites') IS NULL THEN
    ALTER TABLE group_follows RENAME TO group_favorites;
    ALTER INDEX IF EXISTS idx_group_follows_user  RENAME TO idx_group_favorites_user;
    ALTER INDEX IF EXISTS idx_group_follows_group RENAME TO idx_group_favorites_group;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS group_favorites (
  user_id    TEXT NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, group_id)
);

CREATE INDEX IF NOT EXISTS idx_group_favorites_user  ON group_favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_group_favorites_group ON group_favorites(group_id);

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('follow','invitation','join_request','admin_message','club_request',
                  'collab_invite','ownership_transfer','ownership_received','premium_claim',
                  'player_unlinked','new_tournament'));
