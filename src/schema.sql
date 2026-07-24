CREATE EXTENSION IF NOT EXISTS unaccent;

-- Grupos de amigos
CREATE TABLE IF NOT EXISTS groups (
  id          TEXT        PRIMARY KEY,
  name        TEXT        NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
 
-- Registro global de jugadores
-- name ya NO es UNIQUE globalmente: dos grupos distintos pueden tener su propio "Pepe"
-- user_id vincula el slot a un usuario registrado (se llena cuando acepta una invitación)
CREATE TABLE IF NOT EXISTS players (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
 
-- Qué jugadores pertenecen a qué grupo
CREATE TABLE IF NOT EXISTS group_players (
  group_id   TEXT REFERENCES groups(id)  ON DELETE CASCADE,
  player_id  TEXT REFERENCES players(id) ON DELETE CASCADE,
  added_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (group_id, player_id)
);

-- Torneos (una sesión = un torneo)
CREATE TABLE IF NOT EXISTS tournaments (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  mode       TEXT NOT NULL DEFAULT 'free',
  status     TEXT NOT NULL DEFAULT 'active',
  live_match JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS live_match JSONB;
 
-- Parejas fijas (solo modo pairs)
CREATE TABLE IF NOT EXISTS pairs (
  id            TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  p1_id         TEXT NOT NULL REFERENCES players(id),
  p2_id         TEXT NOT NULL REFERENCES players(id)
);
 
-- Partidos
CREATE TABLE IF NOT EXISTS matches (
  id            TEXT    PRIMARY KEY,
  tournament_id TEXT    NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  team1_p1      TEXT    NOT NULL REFERENCES players(id),
  team1_p2      TEXT    NOT NULL REFERENCES players(id),
  team2_p1      TEXT    NOT NULL REFERENCES players(id),
  team2_p2      TEXT    NOT NULL REFERENCES players(id),
  score1        INTEGER NOT NULL,
  score2        INTEGER NOT NULL,
  played_at     DATE    NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
 
-- Invitaciones: el dueño del grupo invita a un usuario registrado a reclamar un slot de jugador
CREATE TABLE IF NOT EXISTS player_invitations (
  id                 TEXT PRIMARY KEY,
  player_id          TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  group_id           TEXT NOT NULL REFERENCES groups(id)  ON DELETE CASCADE,
  invited_by         TEXT NOT NULL REFERENCES users(id),
  invited_identifier TEXT NOT NULL,          -- el @username o email que se ingresó
  invited_user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  status             TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

-- Jugadores por jornada (torneo)
CREATE TABLE IF NOT EXISTS tournament_players (
  tournament_id TEXT REFERENCES tournaments(id) ON DELETE CASCADE,
  player_id     TEXT REFERENCES players(id)     ON DELETE CASCADE,
  added_at      TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (tournament_id, player_id)
);

-- Soporte para formato Americano
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS format  TEXT NOT NULL DEFAULT 'liga';
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS bracket JSONB;

-- Suscripciones: historial de planes de cada usuario
-- billing_period es NULL para plan free (sin vencimiento)
-- ends_at es NULL para plan free (sin vencimiento)
CREATE TABLE IF NOT EXISTS subscriptions (
  id             TEXT        PRIMARY KEY,
  user_id        TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan           TEXT        NOT NULL DEFAULT 'free'
    CHECK (plan IN ('free', 'premium')),
  billing_period TEXT
    CHECK (billing_period IN ('monthly', 'quarterly', 'annual', 'trial')),
  status         TEXT        NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'cancelled', 'expired')),
  starts_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Avatar de usuario (cualquier plan)
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url       TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_public_id TEXT;

-- Bio libre del usuario (hasta 200 chars)
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;

-- Confirmación de email (registro con email/password)
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

-- Rol de usuario (acceso a dashboard de administración)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'
    CHECK (role IN ('user', 'admin'));

CREATE TABLE IF NOT EXISTS email_verifications (
  id         TEXT        PRIMARY KEY,
  user_id    TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT        NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Fotos de jornada (solo usuarios premium pueden subirlas)
CREATE TABLE IF NOT EXISTS tournament_photos (
  id            TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  uploaded_by   TEXT NOT NULL REFERENCES users(id),
  url           TEXT NOT NULL,
  public_id     TEXT NOT NULL,
  caption       TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Clubes: lugares donde se juegan los torneos. Solo el admin los gestiona.
CREATE TABLE IF NOT EXISTS clubs (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  photo_url        TEXT,
  photo_public_id  TEXT,
  social_links     JSONB NOT NULL DEFAULT '[]',
  contact_phone    TEXT,
  contact_whatsapp TEXT,
  location_name    TEXT,
  lat              DOUBLE PRECISION,
  lon              DOUBLE PRECISION,
  courts           INTEGER,
  schedule         JSONB NOT NULL DEFAULT '[]',
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Solicitudes de alta de club hechas por usuarios (el admin las revisa).
CREATE TABLE IF NOT EXISTS club_requests (
  id              TEXT PRIMARY KEY,
  requested_by    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  proposed_data   JSONB NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at     TIMESTAMPTZ,
  created_club_id TEXT REFERENCES clubs(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Solicitud de edición: apunta a un club existente (NULL = alta de club nuevo).
ALTER TABLE club_requests ADD COLUMN IF NOT EXISTS club_id TEXT REFERENCES clubs(id) ON DELETE CASCADE;
-- Snapshot de los datos del club al momento de crear la solicitud (para el diff "antes → después").
ALTER TABLE club_requests ADD COLUMN IF NOT EXISTS previous_data JSONB;

-- Cada torneo se juega (opcionalmente) en un club, con fecha programada del evento.
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS club_id    TEXT REFERENCES clubs(id) ON DELETE SET NULL;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS event_date DATE;

-- Club por defecto de la categoría (se hereda a los torneos que se crean dentro).
ALTER TABLE groups ADD COLUMN IF NOT EXISTS club_id TEXT REFERENCES clubs(id) ON DELETE SET NULL;
-- Referencia a una solicitud de club pendiente: al aprobarse, se backfillea club_id.
ALTER TABLE groups      ADD COLUMN IF NOT EXISTS pending_club_request_id TEXT REFERENCES club_requests(id) ON DELETE SET NULL;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS pending_club_request_id TEXT REFERENCES club_requests(id) ON DELETE SET NULL;

-- ─── Co-organizadores y transferencia de propiedad de categorías ───────────────
-- Co-organizadores de una categoría: pueden gestionar sus jornadas (igual que el dueño),
-- pero NO editar/borrar la categoría, transferir ni gestionar co-organizadores.
CREATE TABLE IF NOT EXISTS group_collaborators (
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  added_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  added_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
);

-- Invitaciones a co-organizar (por @username/email → invited_user_id, o por link → token).
CREATE TABLE IF NOT EXISTS collaborator_invitations (
  id                 TEXT PRIMARY KEY,
  group_id           TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  invited_by         TEXT NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  invited_identifier TEXT,                 -- el @username/email ingresado (NULL si es link)
  invited_user_id    TEXT REFERENCES users(id) ON DELETE CASCADE, -- NULL si es link
  token_hash         TEXT UNIQUE,          -- hash SHA-256 del token de link (NULL si es directa)
  status             TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','rejected','cancelled')),
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

-- Transferencias de propiedad de una categoría (irreversibles, requieren aceptación).
CREATE TABLE IF NOT EXISTS ownership_transfers (
  id            TEXT PRIMARY KEY,
  group_id      TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  from_user_id  TEXT NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  to_user_id    TEXT REFERENCES users(id) ON DELETE CASCADE, -- NULL si es link
  token_hash    TEXT UNIQUE,              -- hash SHA-256 del token de link
  status        TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','rejected','cancelled')),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Ampliar el CHECK de notifications.type con los tipos nuevos (la tabla vive en
-- migration_notifications.sql; el IF EXISTS evita fallar si aún no se creó).
ALTER TABLE IF EXISTS notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE IF EXISTS notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('follow','invitation','join_request','admin_message','club_request',
                  'collab_invite','ownership_transfer','ownership_received'));

-- Índices
CREATE INDEX IF NOT EXISTS idx_group_collab_user     ON group_collaborators(user_id);
CREATE INDEX IF NOT EXISTS idx_group_collab_group    ON group_collaborators(group_id);
CREATE INDEX IF NOT EXISTS idx_collab_inv_user       ON collaborator_invitations(invited_user_id);
CREATE INDEX IF NOT EXISTS idx_collab_inv_group      ON collaborator_invitations(group_id);
CREATE INDEX IF NOT EXISTS idx_ownership_transfers_group ON ownership_transfers(group_id);
CREATE INDEX IF NOT EXISTS idx_tp_tournament         ON tournament_players(tournament_id);
CREATE INDEX IF NOT EXISTS idx_clubs_name            ON clubs(name);
CREATE INDEX IF NOT EXISTS idx_tournaments_club      ON tournaments(club_id);
CREATE INDEX IF NOT EXISTS idx_club_requests_status  ON club_requests(status);
CREATE INDEX IF NOT EXISTS idx_club_requests_club    ON club_requests(club_id);
CREATE INDEX IF NOT EXISTS idx_groups_club           ON groups(club_id);
CREATE INDEX IF NOT EXISTS idx_groups_pending_club       ON groups(pending_club_request_id);
CREATE INDEX IF NOT EXISTS idx_tournaments_pending_club  ON tournaments(pending_club_request_id);
CREATE INDEX IF NOT EXISTS idx_tournaments_group     ON tournaments(group_id);
CREATE INDEX IF NOT EXISTS idx_matches_tournament    ON matches(tournament_id);
CREATE INDEX IF NOT EXISTS idx_pairs_tournament      ON pairs(tournament_id);
CREATE INDEX IF NOT EXISTS idx_gp_group              ON group_players(group_id);
CREATE INDEX IF NOT EXISTS idx_invitations_user      ON player_invitations(invited_user_id);
CREATE INDEX IF NOT EXISTS idx_invitations_player    ON player_invitations(player_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user    ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_tournament_photos_tournament ON tournament_photos(tournament_id);
CREATE INDEX IF NOT EXISTS idx_email_verifications_user    ON email_verifications(user_id);
