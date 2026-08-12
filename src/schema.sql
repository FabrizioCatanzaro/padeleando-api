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
 
-- Cómo lo había anotado el organizador antes de que se vinculara una cuenta.
-- Al vincular, `name` pasa a ser el nombre de la cuenta, y sin esto el apodo con
-- el que el organizador lo reconoce ("Juancito", "el flaco") se perdía: si la
-- persona se registró como "J. P.", no había forma de saber quién era.
-- Se escribe una sola vez, la primera; después queda fijo.
ALTER TABLE players ADD COLUMN IF NOT EXISTS original_name TEXT;

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

-- Invitación de jugador por link, para quien todavía no tiene cuenta. Mismo
-- patrón que collaborator_invitations: se guarda el hash, el token plano sólo
-- viaja en la URL. `invited_identifier` e `invited_user_id` quedan NULL.
ALTER TABLE player_invitations ADD COLUMN IF NOT EXISTS token_hash TEXT UNIQUE;
ALTER TABLE player_invitations ALTER COLUMN invited_identifier DROP NOT NULL;

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

-- Cancelación al fin del período: la suscripción sigue 'active' (el usuario
-- conserva premium) hasta ends_at, pero no se renueva. Se setea al cancelar
-- (desde la app o desde MP) y evita cortar el premium al instante.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT false;

-- Códigos de verificación para reclamar un pago por email de MP. El código se
-- envía al email de MP con el que se pagó: solo quien controla ese inbox puede
-- activar, evitando que un usuario reclame el pago de otro. Uno por usuario.
CREATE TABLE IF NOT EXISTS premium_claim_codes (
  user_id        TEXT        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mp_email       TEXT        NOT NULL,
  preapproval_id TEXT        NOT NULL,
  code           TEXT        NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Avatar de usuario (cualquier plan)
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url       TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_public_id TEXT;

-- Bio libre del usuario (hasta 200 chars)
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;

-- Confirmación de email (registro con email/password)
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

-- Visibilidad de las estadísticas avanzadas del perfil. Sólo la puede activar
-- una cuenta premium; en false (el default) el endpoint del perfil no las
-- devuelve a nadie más que al dueño.
ALTER TABLE users ADD COLUMN IF NOT EXISTS advanced_stats_public BOOLEAN NOT NULL DEFAULT FALSE;

-- Rol de usuario (acceso a dashboard de administración)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user'
    CHECK (role IN ('user', 'admin'));

-- A qué vino el usuario, preguntado una sola vez después del registro. Decide
-- qué le muestra la portada: crear su primera categoría, o buscar el torneo en
-- el que ya juega. NULL = todavía no contestó (las cuentas previas al cambio).
-- No es un permiso: se puede cambiar de idea y hacer las dos cosas.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS onboarding_role TEXT
    CHECK (onboarding_role IN ('organizer', 'player'));

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
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS event_time TIME;

-- Club por defecto de la categoría (se hereda a los torneos que se crean dentro).
ALTER TABLE groups ADD COLUMN IF NOT EXISTS club_id TEXT REFERENCES clubs(id) ON DELETE SET NULL;
-- Referencia a una solicitud de club pendiente: al aprobarse, se backfillea club_id.
ALTER TABLE groups      ADD COLUMN IF NOT EXISTS pending_club_request_id TEXT REFERENCES club_requests(id) ON DELETE SET NULL;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS pending_club_request_id TEXT REFERENCES club_requests(id) ON DELETE SET NULL;

-- ─── Inscripción: precio y medios de contacto ─────────────────────────────────
-- NULL significa "heredar de la categoría", por eso signup_open es nullable.
ALTER TABLE groups      ADD COLUMN IF NOT EXISTS signup_open       BOOLEAN;
ALTER TABLE groups      ADD COLUMN IF NOT EXISTS signup_price      INTEGER;
ALTER TABLE groups      ADD COLUMN IF NOT EXISTS signup_price_unit TEXT;
ALTER TABLE groups      ADD COLUMN IF NOT EXISTS signup_contacts   JSONB;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS signup_open       BOOLEAN;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS signup_price      INTEGER;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS signup_price_unit TEXT;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS signup_contacts   JSONB;

ALTER TABLE groups      DROP CONSTRAINT IF EXISTS groups_signup_price_unit_check;
ALTER TABLE groups      ADD  CONSTRAINT groups_signup_price_unit_check
  CHECK (signup_price_unit IS NULL OR signup_price_unit IN ('player','pair'));
ALTER TABLE tournaments DROP CONSTRAINT IF EXISTS tournaments_signup_price_unit_check;
ALTER TABLE tournaments ADD  CONSTRAINT tournaments_signup_price_unit_check
  CHECK (signup_price_unit IS NULL OR signup_price_unit IN ('player','pair'));

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

-- ─── Categorías favoritas ─────────────────────────────────────────────────────
-- Independiente de user_follows (seguir a una persona).
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

-- Ampliar el CHECK de notifications.type con los tipos nuevos (la tabla vive en
-- migration_notifications.sql; el IF EXISTS evita fallar si aún no se creó).
ALTER TABLE IF EXISTS notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE IF EXISTS notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('follow','invitation','join_request','admin_message','club_request',
                  'collab_invite','ownership_transfer','ownership_received','premium_claim',
                  'player_unlinked','new_tournament'));

-- Broadcasts de admin: lista de destinatarios cuando target = 'user' (varios usuarios).
-- La tabla vive en migration_admin_broadcasts.sql; el IF EXISTS evita fallar si aún no se creó.
ALTER TABLE IF EXISTS admin_broadcasts ADD COLUMN IF NOT EXISTS target_user_ids JSONB;

-- Solicitud de unión: jugador específico que el solicitante pide reclamar (opcional).
-- La tabla vive en migration_join_requests.sql; el IF EXISTS evita fallar si aún no se creó.
ALTER TABLE IF EXISTS tournament_join_requests ADD COLUMN IF NOT EXISTS requested_player_id TEXT REFERENCES players(id);

-- Índices
CREATE INDEX IF NOT EXISTS idx_group_collab_user     ON group_collaborators(user_id);
CREATE INDEX IF NOT EXISTS idx_group_collab_group    ON group_collaborators(group_id);
CREATE INDEX IF NOT EXISTS idx_collab_inv_user       ON collaborator_invitations(invited_user_id);
CREATE INDEX IF NOT EXISTS idx_collab_inv_group      ON collaborator_invitations(group_id);
CREATE INDEX IF NOT EXISTS idx_ownership_transfers_group ON ownership_transfers(group_id);
CREATE INDEX IF NOT EXISTS idx_group_favorites_user  ON group_favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_group_favorites_group ON group_favorites(group_id);
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

-- Intentos fallidos de login (bloqueo temporal por email en routes/auth.js).
-- La tabla se había creado a mano en Neon y nunca estuvo acá: en una base nueva
-- el login rompía. El índice cubre el único acceso que tiene — filtrar por
-- identifier y ordenar por fecha dentro de la ventana de 15 min.
CREATE TABLE IF NOT EXISTS login_attempts (
  id         TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- El bloqueo se cuenta por email + IP: contarlo sólo por email dejaba que
-- cualquiera que supiera tu dirección te dejara afuera 15 min con 5 requests.
ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS ip TEXT;
DROP INDEX IF EXISTS idx_login_attempts_identifier;
CREATE INDEX IF NOT EXISTS idx_login_attempts_key ON login_attempts(identifier, ip, created_at DESC);

-- Índices de rendimiento (auditoría jul 2026). Detalle y justificación en
-- migration_perf_indexes.sql.
CREATE INDEX IF NOT EXISTS idx_players_user          ON players(user_id);
CREATE INDEX IF NOT EXISTS idx_groups_user           ON groups(user_id);
CREATE INDEX IF NOT EXISTS idx_tp_player             ON tournament_players(player_id);
CREATE INDEX IF NOT EXISTS idx_gp_player             ON group_players(player_id);
-- Permiten resolver con BitmapOr el `OR` de cuatro columnas de las consultas de
-- estadísticas, en vez de recorrer matches entera.
CREATE INDEX IF NOT EXISTS idx_matches_t1p1          ON matches(team1_p1);
CREATE INDEX IF NOT EXISTS idx_matches_t1p2          ON matches(team1_p2);
CREATE INDEX IF NOT EXISTS idx_matches_t2p1          ON matches(team2_p1);
CREATE INDEX IF NOT EXISTS idx_matches_t2p2          ON matches(team2_p2);

-- Una cuenta no puede tener dos slots de jugador en la misma categoría.
-- Cruza dos tablas, así que no se puede expresar con un índice único.
-- Detalle en migration_unique_linked_player.sql.
CREATE OR REPLACE FUNCTION assert_one_linked_player_per_group() RETURNS trigger AS $$
DECLARE
  v_user_id   text;
  v_player_id text;
  v_other     text;
BEGIN
  IF TG_TABLE_NAME = 'players' THEN
    v_user_id   := NEW.user_id;
    v_player_id := NEW.id;

    SELECT p.name INTO v_other
    FROM   players p
    JOIN   group_players gp ON gp.player_id = p.id
    WHERE  p.user_id = v_user_id
      AND  p.id <> v_player_id
      AND  gp.group_id IN (SELECT group_id FROM group_players WHERE player_id = v_player_id)
    LIMIT  1;
  ELSE
    v_player_id := NEW.player_id;
    SELECT p.user_id INTO v_user_id FROM players p WHERE p.id = v_player_id;
    IF v_user_id IS NULL THEN RETURN NEW; END IF;

    SELECT p.name INTO v_other
    FROM   players p
    JOIN   group_players gp ON gp.player_id = p.id AND gp.group_id = NEW.group_id
    WHERE  p.user_id = v_user_id
      AND  p.id <> v_player_id
    LIMIT  1;
  END IF;

  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION 'La cuenta ya juega en esta categoría como "%"', v_other
      USING ERRCODE = 'unique_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_players_one_link_per_group ON players;
CREATE TRIGGER trg_players_one_link_per_group
  BEFORE UPDATE OF user_id ON players
  FOR EACH ROW
  WHEN (NEW.user_id IS NOT NULL AND NEW.user_id IS DISTINCT FROM OLD.user_id)
  EXECUTE FUNCTION assert_one_linked_player_per_group();

DROP TRIGGER IF EXISTS trg_group_players_one_link_per_group ON group_players;
CREATE TRIGGER trg_group_players_one_link_per_group
  BEFORE INSERT ON group_players
  FOR EACH ROW
  EXECUTE FUNCTION assert_one_linked_player_per_group();
