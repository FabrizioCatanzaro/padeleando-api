-- Agregar columnas title y body a notifications (para admin_message)
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS body  TEXT;

-- Ampliar el CHECK de type para incluir admin_message
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('follow', 'invitation', 'join_request', 'admin_message'));

-- Historial de broadcasts enviados por admins
CREATE TABLE IF NOT EXISTS admin_broadcasts (
  id             TEXT        PRIMARY KEY,
  admin_id       TEXT        NOT NULL REFERENCES users(id),
  title          TEXT        NOT NULL,
  body           TEXT        NOT NULL,
  target         TEXT        NOT NULL CHECK (target IN ('all', 'free', 'premium', 'user')),
  target_user_id TEXT        REFERENCES users(id),
  channel        TEXT        NOT NULL CHECK (channel IN ('app', 'app_email')),
  recipients     INT         NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Lista de destinatarios cuando target = 'user' (permite elegir varios usuarios).
ALTER TABLE admin_broadcasts
  ADD COLUMN IF NOT EXISTS target_user_ids JSONB;
