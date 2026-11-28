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

-- Fixture: partidos con equipos, cancha y hora, todavia sin resultado.
-- Tabla aparte y no filas de `matches` sin score: nada de lo que cuenta
-- partidos jugados debe tomarlos por jugados. Ver migration_scheduled_matches.sql.
CREATE TABLE IF NOT EXISTS scheduled_matches (
  id            TEXT PRIMARY KEY,
  tournament_id TEXT    NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  team1_p1      TEXT    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team1_p2      TEXT    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team2_p1      TEXT    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  team2_p2      TEXT    NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  court         INTEGER,
  scheduled_at  TIME,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_matches_tournament
  ON scheduled_matches(tournament_id);
 
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

-- Reclamo de propiedad de un club: se evalúa una identidad, no un cambio de campo
CREATE TABLE IF NOT EXISTS club_claims (
  id                TEXT PRIMARY KEY,
  club_id           TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  requested_by      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  full_name         TEXT NOT NULL,
  phone             TEXT NOT NULL,
  relationship      TEXT NOT NULL,
  note              TEXT,
  photo_front_url   TEXT NOT NULL,
  photo_proof_url   TEXT NOT NULL,
  photo_social_url  TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  rejection_reason  TEXT,
  reviewed_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- La 3a foto pasó de "las canchas" a una captura de red social del club
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'club_claims' AND column_name = 'photo_courts_url'
  ) THEN
    ALTER TABLE club_claims RENAME COLUMN photo_courts_url TO photo_social_url;
  END IF;
END $$;

-- Dueño verificado (NULL hasta aprobar un club_claims) y si se muestra públicamente
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS owner_id      TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS owner_visible BOOLEAN NOT NULL DEFAULT false;

-- Imagen de cabecera propia del club
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS header_url       TEXT;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS header_public_id TEXT;

-- ─── Fase 2 de reservas: canchas como entidades reales ───
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS slot_minutes INTEGER NOT NULL DEFAULT 90;

CREATE TABLE IF NOT EXISTS club_courts (
  id          TEXT PRIMARY KEY,
  club_id     TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  -- Piso, paredes, techo, luz y juego exterior son columnas independientes
  floor_type       TEXT CHECK (floor_type IS NULL OR floor_type IN ('cesped_sintetico', 'cesped_natural', 'cemento')),
  wall_type        TEXT CHECK (wall_type IS NULL OR wall_type IN ('cemento', 'cristal')),
  covered          BOOLEAN,
  lit              BOOLEAN,
  -- Juego exterior: espacio para seguir jugando la pelota que sale por la puerta
  external_play    BOOLEAN,
  price       NUMERIC(10,2),
  active      BOOLEAN NOT NULL DEFAULT true,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_club_courts_club ON club_courts(club_id);
-- floor_type y wall_type reemplazan a "surface"
ALTER TABLE club_courts DROP COLUMN IF EXISTS surface;
ALTER TABLE club_courts ADD COLUMN IF NOT EXISTS floor_type    TEXT CHECK (floor_type IS NULL OR floor_type IN ('cesped_sintetico', 'cesped_natural', 'cemento'));
ALTER TABLE club_courts ADD COLUMN IF NOT EXISTS wall_type     TEXT CHECK (wall_type IS NULL OR wall_type IN ('cemento', 'cristal'));
ALTER TABLE club_courts ADD COLUMN IF NOT EXISTS lit           BOOLEAN;
ALTER TABLE club_courts ADD COLUMN IF NOT EXISTS external_play BOOLEAN;

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
-- booking_cancelled (2026-09-13): el jugador cancela su propia reserva
-- (PATCH /api/bookings/mine/:groupId) y se le avisa al dueño/admins -- es la
-- dirección inversa de booking_decided (que va del dueño hacia el jugador).
ALTER TABLE IF EXISTS notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE IF EXISTS notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('follow','invitation','join_request','admin_message','club_request',
                  'collab_invite','ownership_transfer','ownership_received','premium_claim',
                  'player_unlinked','new_tournament','club_claim','booking_decided','booking_requested',
                  'booking_cancelled','registration_received','registration_decided','registration_partner',
                  'friendly_added','friendly_joined','friendly_left','friendly_removed','friendly_full',
                  'friendly_updated','friendly_proposal','friendly_confirmed','friendly_cancelled','friendly_reminder',
                  'registration_refund_failed','commission_due'));

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
CREATE INDEX IF NOT EXISTS idx_club_claims_status    ON club_claims(status);
CREATE INDEX IF NOT EXISTS idx_club_claims_club      ON club_claims(club_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_club_claims_one_pending ON club_claims(club_id) WHERE status = 'pending';
-- Una sola solicitud de edición pendiente por club (club_id NULL = alta nueva)
CREATE UNIQUE INDEX IF NOT EXISTS uq_club_requests_one_pending_edit ON club_requests(club_id) WHERE status = 'pending' AND club_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clubs_owner           ON clubs(owner_id);
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

-- ─── Fase 3 de reservas: reserva pública de un turno ───
CREATE TABLE IF NOT EXISTS bookings (
  id                TEXT PRIMARY KEY,
  -- Turnos consecutivos reservados juntos: una fila por turno con el mismo group_id
  group_id          TEXT NOT NULL,
  club_id           TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  court_id          TEXT REFERENCES club_courts(id) ON DELETE SET NULL,
  user_id           TEXT REFERENCES users(id) ON DELETE SET NULL,
  guest_name        TEXT NOT NULL,
  guest_contact     TEXT NOT NULL,
  date              DATE NOT NULL,
  start_time        TIME NOT NULL,
  duration_minutes  INTEGER NOT NULL,
  price             NUMERIC(10,2),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
  decision_reason   TEXT,
  decided_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Si bookings ya existía sin group_id, se agrega y las filas viejas se backfillean con su id
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS group_id TEXT;
UPDATE bookings SET group_id = id WHERE group_id IS NULL;
ALTER TABLE bookings ALTER COLUMN group_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bookings_club_date ON bookings(club_id, date);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_group ON bookings(group_id);

-- Dos índices únicos parciales porque un court_id NULL no colisiona; solo "confirmed" bloquea
DROP INDEX IF EXISTS uq_bookings_slot_with_court;
DROP INDEX IF EXISTS uq_bookings_slot_no_court;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_slot_with_court
  ON bookings(club_id, court_id, date, start_time)
  WHERE status = 'confirmed' AND court_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_slot_no_court
  ON bookings(club_id, date, start_time)
  WHERE status = 'confirmed' AND court_id IS NULL;

-- ─── Fase 4: turnos de 30 min, precio por 30/60 min ───
ALTER TABLE clubs ALTER COLUMN slot_minutes SET DEFAULT 30;
UPDATE clubs SET slot_minutes = 30 WHERE slot_minutes <> 30;

-- Dos precios por cancha (30 y 60 min); "price" queda deprecada
ALTER TABLE club_courts ADD COLUMN IF NOT EXISTS price_30 NUMERIC(10,2);
ALTER TABLE club_courts ADD COLUMN IF NOT EXISTS price_60 NUMERIC(10,2);
-- Backfill idempotente: precio de 60 igual al viejo y el de 30 la mitad; el dueño lo corrige
UPDATE club_courts SET price_60 = price, price_30 = ROUND(price / 2, 2)
WHERE price_60 IS NULL AND price IS NOT NULL;

-- Mercado Pago Connect por club (Premium): el dueño vincula su propia cuenta
-- para cobrar reservas desde la app. Tokens de la cuenta del CLUB, no de la
-- plataforma (eso es MP_ACCESS_TOKEN, para las suscripciones).
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS mp_user_id       TEXT;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS mp_access_token  TEXT;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS mp_refresh_token TEXT;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS mp_public_key    TEXT;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS mp_connected_at  TIMESTAMPTZ;

-- Estado del cobro de una reserva cuando el club tiene Mercado Pago vinculado.
-- NULL = el club no cobra online (flujo manual de siempre).
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_status TEXT
  CHECK (payment_status IS NULL OR payment_status IN ('pending', 'approved', 'rejected'));
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS mp_preference_id TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS mp_payment_id    TEXT;

-- Ronda del calendario de la previa (americano). POST /tournaments/:id/schedule
-- guarda el calendario generado como partidos programados con su ronda, para
-- que los jugadores lo vean. NULL = programado a mano, sin ronda.
ALTER TABLE scheduled_matches ADD COLUMN IF NOT EXISTS round INTEGER;

-- Bajas de parejas (2026-11-08). Una pareja retirada no se borra: su historia
-- cuenta en la tabla. Sus partidos programados pasan a W.O. 6-0 para el rival
-- (matches.walkover) y en el cuadro sus cruces se resuelven solos por W.O.
ALTER TABLE pairs ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'withdrawn'));
ALTER TABLE pairs ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS walkover BOOLEAN NOT NULL DEFAULT false;

-- Categoría de juego (2026-11-09): rama C (Caballeros) o D (Damas) + número
-- del 1 (nivel más alto) al 10. users.category = la que declara el jugador;
-- groups.level / tournaments.level = la del torneo (NULL en la jornada =
-- hereda la de la categoría del organizador). La inscripción la usa para
-- marcar a los jugadores excedidos de nivel.
ALTER TABLE users       ADD COLUMN IF NOT EXISTS category TEXT CHECK (category IS NULL OR category ~ '^[CD]([1-9]|10)$');
ALTER TABLE groups      ADD COLUMN IF NOT EXISTS level    TEXT;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS level    TEXT;
-- Categoría del torneo: C7 / D5 (fija), M6 (mixto de categoría) o SUMA:
-- SC11 / SD11 / SM11 (caballeros, damas, mixto). Ver lib/category.js.
ALTER TABLE groups      DROP CONSTRAINT IF EXISTS groups_level_check;
ALTER TABLE groups      ADD  CONSTRAINT groups_level_check
  CHECK (level IS NULL OR level ~ '^([CDM]([1-9]|10)|S[CDM]([89]|1[0-5]))$');
ALTER TABLE tournaments DROP CONSTRAINT IF EXISTS tournaments_level_check;
ALTER TABLE tournaments ADD  CONSTRAINT tournaments_level_check
  CHECK (level IS NULL OR level ~ '^([CDM]([1-9]|10)|S[CDM]([89]|1[0-5]))$');

-- Puntaje del cuestionario de nivel (1.0 a 8.0). Se guarda junto con la
-- categoría que el jugador confirmó; NULL si la eligió directo.
ALTER TABLE users ADD COLUMN IF NOT EXISTS level_score NUMERIC(2,1) CHECK (level_score IS NULL OR level_score BETWEEN 1.0 AND 8.0);

-- Inscripción a torneos (2026-11-09). Ver el documento "Diseño: inscripción a
-- torneos". Una fila por inscripción: individual (solo) o con pareja (pair).
-- Al aprobarla se crean o reutilizan los jugadores y, si corresponde, la pareja.
ALTER TABLE groups      ADD COLUMN IF NOT EXISTS signup_capacity      INTEGER CHECK (signup_capacity IS NULL OR signup_capacity > 0);
ALTER TABLE groups      ADD COLUMN IF NOT EXISTS signup_capacity_unit TEXT    CHECK (signup_capacity_unit IS NULL OR signup_capacity_unit IN ('pair', 'player'));
ALTER TABLE groups      ADD COLUMN IF NOT EXISTS signup_closes_at     TIMESTAMPTZ;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS signup_capacity      INTEGER CHECK (signup_capacity IS NULL OR signup_capacity > 0);
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS signup_capacity_unit TEXT    CHECK (signup_capacity_unit IS NULL OR signup_capacity_unit IN ('pair', 'player'));
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS signup_closes_at     TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS tournament_registrations (
  id            TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('pair', 'solo')),
  status        TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'waitlist', 'cancelled')),
  created_by    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Jugador 1: siempre el que se inscribe.
  p1_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Compañero: con cuenta (p2_user_id) o sin cuenta (nombre y teléfono).
  p2_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  p2_name       TEXT,
  p2_phone      TEXT,
  -- Lo que se creó al aprobar.
  p1_player_id  TEXT REFERENCES players(id) ON DELETE SET NULL,
  p2_player_id  TEXT REFERENCES players(id) ON DELETE SET NULL,
  pair_id       TEXT REFERENCES pairs(id)   ON DELETE SET NULL,
  paid          BOOLEAN NOT NULL DEFAULT false,
  reject_reason TEXT,
  decided_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT registrations_partner_check CHECK (
    kind = 'solo' OR p2_user_id IS NOT NULL OR (p2_name IS NOT NULL AND p2_phone IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_registrations_tournament ON tournament_registrations(tournament_id, created_at);
CREATE INDEX IF NOT EXISTS idx_registrations_p1         ON tournament_registrations(p1_user_id);
CREATE INDEX IF NOT EXISTS idx_registrations_p2         ON tournament_registrations(p2_user_id);
-- Una sola inscripción activa por usuario y torneo como titular (la de
-- compañero se controla en la ruta, porque cruza dos columnas).
CREATE UNIQUE INDEX IF NOT EXISTS uq_registrations_active_p1
  ON tournament_registrations(tournament_id, p1_user_id)
  WHERE status IN ('pending', 'approved', 'waitlist');

-- Posts de Instagram en la galería del torneo (2026-11-09). El organizador
-- pega el link de un post público y la app lo muestra embebido. Premium del
-- dueño de la categoría, como las fotos. Ver lib/instagram.js.
CREATE TABLE IF NOT EXISTS tournament_instagram_posts (
  id            TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('p', 'reel', 'tv')),
  shortcode     TEXT NOT NULL,
  url           TEXT NOT NULL,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tournament_id, shortcode)
);
CREATE INDEX IF NOT EXISTS idx_instagram_posts_tournament ON tournament_instagram_posts(tournament_id, created_at);

-- Liga por fechas (2026-11-09). Una liga puede jugarse en un solo día (como
-- hasta ahora) o en varios días, con la temporada dividida en fechas. El
-- organizador elige al crearla si se permiten cruces repetidos y cómo se
-- define el campeón. Ver lib/ligaFechas.js y el doc "Diseño: liga por fechas".
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS liga_mode     TEXT    NOT NULL DEFAULT 'jornada';
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS allow_rematch BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS winner_format TEXT    NOT NULL DEFAULT 'tabla';
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS playoff_size  INTEGER;
ALTER TABLE tournaments DROP CONSTRAINT IF EXISTS tournaments_liga_mode_check;
ALTER TABLE tournaments ADD  CONSTRAINT tournaments_liga_mode_check
  CHECK (liga_mode IN ('jornada', 'temporada'));
ALTER TABLE tournaments DROP CONSTRAINT IF EXISTS tournaments_winner_format_check;
ALTER TABLE tournaments ADD  CONSTRAINT tournaments_winner_format_check
  CHECK (winner_format IN ('tabla', 'playoffs'));
ALTER TABLE tournaments DROP CONSTRAINT IF EXISTS tournaments_playoff_size_check;
ALTER TABLE tournaments ADD  CONSTRAINT tournaments_playoff_size_check
  CHECK (playoff_size IS NULL OR playoff_size >= 2);

-- Las fechas de una temporada: número y días que define el organizador.
-- end_date NULL = la fecha se juega en un solo día.
CREATE TABLE IF NOT EXISTS tournament_fechas (
  id            TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  number        INTEGER NOT NULL CHECK (number >= 1),
  start_date    DATE NOT NULL,
  end_date      DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tournament_id, number),
  CHECK (end_date IS NULL OR end_date >= start_date)
);

-- En una liga por fechas, scheduled_matches.round y matches.round son el
-- número de fecha. Un partido postergado sigue en su fecha y se juega otro
-- día; si nunca se juega, queda sin jugar y no suma puntos.
ALTER TABLE scheduled_matches ADD COLUMN IF NOT EXISTS scheduled_date DATE;
ALTER TABLE scheduled_matches ADD COLUMN IF NOT EXISTS postponed      BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE matches           ADD COLUMN IF NOT EXISTS round          INTEGER;
CREATE INDEX IF NOT EXISTS idx_matches_tournament_round ON matches(tournament_id, round);

-- Reglamento del torneo (2026-11-10). NULL en el torneo = hereda el de la
-- categoría. La inscripción guarda cuándo el jugador lo aceptó.
ALTER TABLE groups      ADD COLUMN IF NOT EXISTS rules TEXT;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS rules TEXT;
ALTER TABLE tournament_registrations ADD COLUMN IF NOT EXISTS rules_accepted_at TIMESTAMPTZ;

-- Puntos de la tabla de una liga (2026-11-10). La tabla ordena por puntos y
-- después por victorias. La derrota por W.O. no suma los puntos de derrota.
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS points_win  INTEGER NOT NULL DEFAULT 3;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS points_loss INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tournaments DROP CONSTRAINT IF EXISTS tournaments_points_check;
ALTER TABLE tournaments ADD  CONSTRAINT tournaments_points_check
  CHECK (points_win BETWEEN 0 AND 10 AND points_loss BETWEEN 0 AND 10 AND points_loss <= points_win);

-- Flyer del torneo (2026-11-10): imagen para promocionarlo, se muestra en 9:16.
-- Gratis para todos. Ver POST /tournaments/:id/flyer.
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS flyer_url       TEXT;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS flyer_public_id TEXT;

-- Disponibilidad horaria de la inscripción a una liga en varios días
-- (2026-11-10): rangos por día de la semana y una nota. Ver lib/availability.js.
ALTER TABLE tournament_registrations ADD COLUMN IF NOT EXISTS availability JSONB;

-- Copa (2026-11-16): grupos (zonas) + playoffs, o cuadro directo. Ver lib/copa.js.
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS copa_config   JSONB;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS bracket_plata JSONB;
ALTER TABLE pairs ADD COLUMN IF NOT EXISTS zona         SMALLINT CHECK (zona IS NULL OR zona BETWEEN 1 AND 8);
ALTER TABLE pairs ADD COLUMN IF NOT EXISTS cabeza_serie SMALLINT CHECK (cabeza_serie IS NULL OR cabeza_serie >= 1);

-- Disponibilidad y WhatsApp por jugador y torneo: `players` es una fila por categoría.
ALTER TABLE tournament_players ADD COLUMN IF NOT EXISTS availability     JSONB;
ALTER TABLE tournament_players ADD COLUMN IF NOT EXISTS whatsapp         TEXT;
ALTER TABLE tournament_players ADD COLUMN IF NOT EXISTS whatsapp_visible BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tournament_registrations ADD COLUMN IF NOT EXISTS p2_availability     JSONB;
ALTER TABLE tournament_registrations ADD COLUMN IF NOT EXISTS p1_whatsapp         TEXT;
ALTER TABLE tournament_registrations ADD COLUMN IF NOT EXISTS p1_whatsapp_visible BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tournament_registrations ADD COLUMN IF NOT EXISTS p2_whatsapp_visible BOOLEAN NOT NULL DEFAULT false;

-- La disponibilidad por inscripción pasa a sus dos jugadores. Solo completa vacíos.
UPDATE tournament_registrations SET p2_availability = availability
WHERE kind = 'pair' AND availability IS NOT NULL AND p2_availability IS NULL;
UPDATE tournament_players tp SET availability = r.availability
FROM tournament_registrations r
WHERE r.status = 'approved' AND r.availability IS NOT NULL AND tp.availability IS NULL
  AND tp.tournament_id = r.tournament_id AND tp.player_id = r.p1_player_id;
UPDATE tournament_players tp SET availability = r.p2_availability
FROM tournament_registrations r
WHERE r.status = 'approved' AND r.p2_availability IS NOT NULL AND tp.availability IS NULL
  AND tp.tournament_id = r.tournament_id AND tp.player_id = r.p2_player_id;

-- Cancha con nombre: referencia a la cancha del club. `court` sigue para el número.
ALTER TABLE scheduled_matches ADD COLUMN IF NOT EXISTS court_id TEXT REFERENCES club_courts(id) ON DELETE SET NULL;
ALTER TABLE matches           ADD COLUMN IF NOT EXISTS court_id TEXT REFERENCES club_courts(id) ON DELETE SET NULL;

-- Premios del torneo. Los de puesto toman el ganador del cuadro; los especiales lo guardan.
CREATE TABLE IF NOT EXISTS tournament_prizes (
  id               TEXT PRIMARY KEY,
  tournament_id    TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('puesto', 'especial')),
  cup              TEXT NOT NULL DEFAULT 'oro' CHECK (cup IN ('oro', 'plata')),
  place            SMALLINT CHECK (place IS NULL OR place BETWEEN 1 AND 4),
  title            TEXT,
  description      TEXT NOT NULL,
  winner_pair_id   TEXT REFERENCES pairs(id)   ON DELETE SET NULL,
  winner_player_id TEXT REFERENCES players(id) ON DELETE SET NULL,
  position         INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((kind = 'puesto') = (place IS NOT NULL)),
  CHECK (kind = 'puesto' OR title IS NOT NULL),
  CHECK (winner_pair_id IS NULL OR winner_player_id IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_prizes_tournament ON tournament_prizes(tournament_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS uq_prizes_place ON tournament_prizes(tournament_id, cup, place) WHERE kind = 'puesto';

-- Amistosos (2026-11-17): partidos 2 vs 2 fuera de torneo. Ver lib/friendlies.js.
CREATE TABLE IF NOT EXISTS friendly_matches (
  id               TEXT PRIMARY KEY,
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'programado'
                   CHECK (status IN ('programado', 'por_confirmar', 'confirmado', 'cancelado')),
  visibility       TEXT NOT NULL DEFAULT 'publico' CHECK (visibility IN ('publico', 'link')),
  share_token      TEXT NOT NULL,
  club_id          TEXT NOT NULL REFERENCES clubs(id),
  court_label      TEXT,
  date             DATE NOT NULL,
  start_time       TIME NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 30 AND 300),
  level            TEXT,
  sets_format      SMALLINT NOT NULL CHECK (sets_format IN (1, 3)),
  court_price      NUMERIC(10,2) CHECK (court_price IS NULL OR court_price >= 0),
  style            TEXT CHECK (style IS NULL OR style IN ('caballeros', 'damas', 'mixto')),
  score1           INTEGER,
  score2           INTEGER,
  sets             JSONB,
  confirmed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (score1 IS NULL OR score1 <> score2),
  CHECK ((status = 'confirmado') = (score1 IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_friendly_open ON friendly_matches(date) WHERE status = 'programado' AND visibility = 'publico';
CREATE INDEX IF NOT EXISTS idx_friendly_club ON friendly_matches(club_id, date);

CREATE TABLE IF NOT EXISTS friendly_match_players (
  match_id     TEXT NOT NULL REFERENCES friendly_matches(id) ON DELETE CASCADE,
  team         SMALLINT NOT NULL CHECK (team IN (1, 2)),
  position     SMALLINT NOT NULL CHECK (position IN (1, 2)),
  user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  guest_name   TEXT,
  side         TEXT CHECK (side IS NULL OR side IN ('drive', 'reves', 'cualquiera')),
  hand         TEXT CHECK (hand IS NULL OR hand IN ('diestro', 'zurdo', 'ambidiestro')),
  whatsapp     TEXT,
  invite_token TEXT,
  joined_at    TIMESTAMPTZ,
  PRIMARY KEY (match_id, team, position),
  CHECK (user_id IS NULL OR guest_name IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_friendly_player_user ON friendly_match_players(match_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_friendly_player_user ON friendly_match_players(user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_friendly_invite_token ON friendly_match_players(invite_token) WHERE invite_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS friendly_match_proposals (
  id          TEXT PRIMARY KEY,
  match_id    TEXT NOT NULL REFERENCES friendly_matches(id) ON DELETE CASCADE,
  proposed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  team        SMALLINT NOT NULL CHECK (team IN (1, 2)),
  score1      INTEGER NOT NULL,
  score2      INTEGER NOT NULL,
  sets        JSONB NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'aceptada', 'rechazada')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at  TIMESTAMPTZ,
  CHECK (score1 <> score2)
);
CREATE INDEX IF NOT EXISTS idx_friendly_proposals_match ON friendly_match_proposals(match_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_friendly_pending ON friendly_match_proposals(match_id) WHERE status = 'pendiente';
CREATE UNIQUE INDEX IF NOT EXISTS uq_friendly_reminder ON notifications(user_id, entity_id, body) WHERE type = 'friendly_reminder';

-- Perfil (2026-11): nombre y apellido separados, datos personales, redes fijas y WhatsApp aparte.
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name  TEXT NOT NULL DEFAULT '';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'users'
                AND column_name = 'name' AND is_generated = 'NEVER') THEN
    UPDATE users SET
      first_name = split_part(btrim(regexp_replace(name, '\s+', ' ', 'g')), ' ', 1),
      last_name  = btrim(substr(btrim(regexp_replace(name, '\s+', ' ', 'g')),
                                length(split_part(btrim(regexp_replace(name, '\s+', ' ', 'g')), ' ', 1)) + 1))
    WHERE first_name IS NULL;
    ALTER TABLE users DROP COLUMN name;
    ALTER TABLE users ADD COLUMN name TEXT GENERATED ALWAYS AS (btrim(first_name || ' ' || last_name)) STORED NOT NULL;
  END IF;
END $$;
ALTER TABLE users ALTER COLUMN first_name SET NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS username_changed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS nationality TEXT CHECK (nationality IS NULL OR nationality ~ '^[A-Z]{2}$');
ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_date  DATE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS gender      TEXT CHECK (gender IS NULL OR gender IN ('masculino', 'femenino', 'no_decir'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS doc_type    TEXT CHECK (doc_type IS NULL OR doc_type IN ('dni', 'pasaporte', 'otro'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS doc_number  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp        TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_public BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS instagram TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS twitter   TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS facebook  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS website   TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS hand TEXT CHECK (hand IS NULL OR hand IN ('diestro', 'zurdo', 'ambidiestro'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS side TEXT CHECK (side IS NULL OR side IN ('drive', 'reves', 'cualquiera'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS country       TEXT CHECK (country IS NULL OR country ~ '^[A-Z]{2}$');
ALTER TABLE users ADD COLUMN IF NOT EXISTS province      TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locality      TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS street        TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS street_number TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS postal_code   TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_contacts JSONB NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(emergency_contacts) = 'array');

CREATE OR REPLACE FUNCTION pg_temp.legacy_link(links jsonb, net text) RETURNS text LANGUAGE sql AS $f$
  SELECT btrim(e.l->>'url')
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(links) = 'array' THEN links ELSE '[]'::jsonb END)
         WITH ORDINALITY AS e(l, ord)
   WHERE e.l->>'network' = net AND btrim(COALESCE(e.l->>'url', '')) <> ''
   ORDER BY e.ord LIMIT 1
$f$;
CREATE OR REPLACE FUNCTION pg_temp.legacy_handle(url text, host text, pat text) RETURNS text LANGUAGE sql AS $f$
  SELECT CASE WHEN h ~ pat THEN h END
    FROM (SELECT regexp_replace(
                   regexp_replace(url, '^(https?://)?(www\.|m\.|mobile\.|web\.)?(' || host || ')/', '', 'i'),
                   '^@+|[/?#].*$', '', 'g') AS h) x
$f$;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'social_links') THEN
    UPDATE users SET
      instagram = COALESCE(instagram, pg_temp.legacy_handle(pg_temp.legacy_link(social_links, 'instagram'), 'instagram\.com', '^[A-Za-z0-9._]{1,30}$')),
      twitter   = COALESCE(twitter,   pg_temp.legacy_handle(pg_temp.legacy_link(social_links, 'twitter'), 'x\.com|twitter\.com', '^[A-Za-z0-9_]{1,15}$')),
      facebook  = COALESCE(facebook,  pg_temp.legacy_handle(pg_temp.legacy_link(social_links, 'facebook'), 'facebook\.com|fb\.com', '^[A-Za-z0-9.]{5,50}$')),
      website   = COALESCE(website, (SELECT CASE WHEN o ~* '^https?://' THEN o ELSE 'https://' || o END
                                       FROM (SELECT pg_temp.legacy_link(social_links, 'other') AS o) x WHERE o IS NOT NULL)),
      whatsapp  = COALESCE(whatsapp, (SELECT '+' || d FROM (SELECT regexp_replace(COALESCE(pg_temp.legacy_link(social_links, 'whatsapp'), ''), '\D', '', 'g') AS d) x
                                       WHERE length(d) BETWEEN 8 AND 15));
    ALTER TABLE users DROP COLUMN social_links;
  END IF;
END $$;
ALTER TABLE users DROP COLUMN IF EXISTS bio;

-- Email de la cuenta de Google conectada; las vinculadas antes se conectaron por coincidencia de email.
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_email TEXT;
UPDATE users SET google_email = email WHERE google_id IS NOT NULL AND google_email IS NULL;

-- Un @username dejado queda reservado 90 días para su dueño y redirige al nuevo.
CREATE TABLE IF NOT EXISTS username_history (
  username    TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  released_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_username_history_user ON username_history(user_id);

ALTER TABLE friendly_match_players DROP CONSTRAINT IF EXISTS friendly_match_players_hand_check;
ALTER TABLE friendly_match_players ADD CONSTRAINT friendly_match_players_hand_check
  CHECK (hand IS NULL OR hand IN ('diestro', 'zurdo', 'ambidiestro'));

-- Planes por rol: premium queda como plan anterior y vale como combo.
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_plan_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_plan_check
  CHECK (plan IN ('free', 'premium', 'jugador_plus', 'organizador', 'combo', 'club'));
-- Monto que cobra Mercado Pago: el precio promocional se mantiene aunque cambie la lista.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS amount NUMERIC(12, 2);

-- Cobro online de inscripciones (2026-11-27). Ver lib/commission.js y lib/mpAccount.js.
-- Cuenta de Mercado Pago del dueño de la categoría, vinculada por OAuth. Nunca sale en la sesión.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mp_user_id       TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mp_access_token  TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mp_refresh_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mp_public_key    TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mp_connected_at  TIMESTAMPTZ;

-- Se configura por torneo, sin herencia de la categoría.
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS signup_online       BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS signup_fee_payer    TEXT    NOT NULL DEFAULT 'player';
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS signup_payment_note TEXT;
ALTER TABLE tournaments DROP CONSTRAINT IF EXISTS tournaments_signup_fee_payer_check;
ALTER TABLE tournaments ADD  CONSTRAINT tournaments_signup_fee_payer_check
  CHECK (signup_fee_payer IN ('player', 'organizer'));

-- awaiting_payment: inscripción creada que espera el pago (30 min); al acreditarse pasa a pending.
ALTER TABLE tournament_registrations DROP CONSTRAINT IF EXISTS tournament_registrations_status_check;
ALTER TABLE tournament_registrations ADD  CONSTRAINT tournament_registrations_status_check
  CHECK (status IN ('awaiting_payment', 'pending', 'approved', 'rejected', 'waitlist', 'cancelled'));
ALTER TABLE tournament_registrations ADD COLUMN IF NOT EXISTS payment_status     TEXT;
ALTER TABLE tournament_registrations ADD COLUMN IF NOT EXISTS price_amount       NUMERIC(12, 2);
ALTER TABLE tournament_registrations ADD COLUMN IF NOT EXISTS fee_amount         NUMERIC(12, 2);
ALTER TABLE tournament_registrations ADD COLUMN IF NOT EXISTS total_amount       NUMERIC(12, 2);
ALTER TABLE tournament_registrations ADD COLUMN IF NOT EXISTS mp_preference_id   TEXT;
ALTER TABLE tournament_registrations ADD COLUMN IF NOT EXISTS mp_init_point      TEXT;
ALTER TABLE tournament_registrations ADD COLUMN IF NOT EXISTS mp_payment_id      TEXT;
ALTER TABLE tournament_registrations ADD COLUMN IF NOT EXISTS payment_expires_at TIMESTAMPTZ;
ALTER TABLE tournament_registrations ADD COLUMN IF NOT EXISTS refunded_at        TIMESTAMPTZ;
ALTER TABLE tournament_registrations ADD COLUMN IF NOT EXISTS refund_error       TEXT;
ALTER TABLE tournament_registrations DROP CONSTRAINT IF EXISTS tournament_registrations_payment_status_check;
ALTER TABLE tournament_registrations ADD  CONSTRAINT tournament_registrations_payment_status_check
  CHECK (payment_status IS NULL OR payment_status IN ('pending', 'approved', 'refunded', 'refund_failed'));
DROP INDEX IF EXISTS uq_registrations_active_p1;
CREATE UNIQUE INDEX IF NOT EXISTS uq_registrations_active_p1
  ON tournament_registrations(tournament_id, p1_user_id)
  WHERE status IN ('awaiting_payment', 'pending', 'approved', 'waitlist');
CREATE UNIQUE INDEX IF NOT EXISTS uq_registrations_mp_payment
  ON tournament_registrations(mp_payment_id) WHERE mp_payment_id IS NOT NULL;

-- Liquidación de comisiones (2026-11-27): sin split de Mercado Pago la inscripción entra entera al
-- organizador y la comisión se paga después, una por torneo al cerrar la inscripción. Ver lib/settlements.js.
CREATE TABLE IF NOT EXISTS commission_settlements (
  id                  TEXT PRIMARY KEY,
  tournament_id       TEXT NOT NULL UNIQUE REFERENCES tournaments(id) ON DELETE CASCADE,
  owner_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount              NUMERIC(12, 2) NOT NULL,
  credit_applied      NUMERIC(12, 2) NOT NULL DEFAULT 0,
  registrations_count INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled')),
  due_at              TIMESTAMPTZ NOT NULL,
  mp_preference_id    TEXT,
  mp_init_point       TEXT,
  mp_payment_id       TEXT UNIQUE,
  paid_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (credit_applied >= 0 AND credit_applied <= amount)
);
CREATE INDEX IF NOT EXISTS idx_settlements_owner ON commission_settlements(owner_id, status);

-- Perfil de club: servicios, email, color y descripción de cada cancha
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS amenities       TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS amenities_other TEXT;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS contact_email   TEXT;
ALTER TABLE club_courts ADD COLUMN IF NOT EXISTS floor_color TEXT;
ALTER TABLE club_courts ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE club_courts DROP CONSTRAINT IF EXISTS club_courts_wall_type_check;
ALTER TABLE club_courts ADD CONSTRAINT club_courts_wall_type_check
  CHECK (wall_type IS NULL OR wall_type IN ('cemento', 'cristal', 'cristal_panoramico'));

-- Perfil de club: galería y seguidores
CREATE TABLE IF NOT EXISTS club_photos (
  id         TEXT PRIMARY KEY,
  club_id    TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  public_id  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_club_photos_club ON club_photos(club_id, created_at);
CREATE TABLE IF NOT EXISTS club_follows (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  club_id    TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, club_id)
);
CREATE INDEX IF NOT EXISTS idx_club_follows_club ON club_follows(club_id);
ALTER TABLE IF EXISTS notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE IF EXISTS notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('follow','invitation','join_request','admin_message','club_request',
                  'collab_invite','ownership_transfer','ownership_received','premium_claim',
                  'player_unlinked','new_tournament','club_claim','booking_decided','booking_requested',
                  'booking_cancelled','registration_received','registration_decided','registration_partner',
                  'friendly_added','friendly_joined','friendly_left','friendly_removed','friendly_full',
                  'friendly_updated','friendly_proposal','friendly_confirmed','friendly_cancelled','friendly_reminder',
                  'registration_refund_failed','commission_due','club_tournament_signup'));
