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

-- Reclamo de propiedad de un club: alguien dice ser el dueño y pide que un
-- admin lo verifique. No es lo mismo que club_requests (que compara "antes"
-- contra "después" de un dato) -- acá lo que se evalúa es una identidad, con
-- fotos de respaldo obligatorias, no un cambio de campo.
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

-- La 3a foto pasó de "las canchas" a una captura de una red social del club
-- (paso de más peso para probar que el reclamante administra esa cuenta).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'club_claims' AND column_name = 'photo_courts_url'
  ) THEN
    ALTER TABLE club_claims RENAME COLUMN photo_courts_url TO photo_social_url;
  END IF;
END $$;

-- Dueño verificado del club (NULL hasta que se aprueba un club_claims) y si
-- ese nombre se muestra públicamente en la ficha del club.
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS owner_id      TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS owner_visible BOOLEAN NOT NULL DEFAULT false;

-- Imagen de cabecera propia del club (antes todas las fichas usaban la misma
-- foto de cancha genérica). Mismo patrón que photo_url/photo_public_id.
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS header_url       TEXT;
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS header_public_id TEXT;

-- ─── Fase 2 de "reservas de cancha": canchas como entidades reales ───────────
-- La disponibilidad semanal sigue siendo la de `clubs.schedule` (un solo
-- horario para todo el club, no por cancha -- decisión explícita de Fabri) y
-- la duración del turno es fija por club (`slot_minutes`), no por cancha ni
-- por franja. Lo único que ahora es una entidad real es la cancha en sí:
-- antes `clubs.courts` era sólo un número ("cuántas canchas tiene"), lo que
-- alcanzaba para mostrarlo en la ficha pero no para reservar UNA cancha en
-- particular. Se deja `clubs.courts` como está (fallback de visualización
-- para un club que todavía no cargó sus canchas una por una) -- pero apenas
-- carga la primera, `syncLegacyCourtsCount()` en routes/clubs.js lo recalcula
-- solo (cuenta de `club_courts` activas) en cada alta/edición/baja, así que
-- deja de ser un número editable a mano (ver ClubFormFields.jsx).
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS slot_minutes INTEGER NOT NULL DEFAULT 90;

CREATE TABLE IF NOT EXISTS club_courts (
  id          TEXT PRIMARY KEY,
  club_id     TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  -- Piso, paredes, techo, iluminación y juego exterior son atributos
  -- independientes entre sí (por ejemplo una cancha de cemento puede estar
  -- techada o no), por eso van en columnas separadas.
  floor_type       TEXT CHECK (floor_type IS NULL OR floor_type IN ('cesped_sintetico', 'cesped_natural', 'cemento')),
  wall_type        TEXT CHECK (wall_type IS NULL OR wall_type IN ('cemento', 'cristal')),
  covered          BOOLEAN,
  lit              BOOLEAN,
  -- "Juego exterior": hay espacio habilitado para seguir jugando la pelota
  -- que sale por la puerta (no es lo habitual en clubes de Argentina).
  external_play    BOOLEAN,
  price       NUMERIC(10,2),
  active      BOOLEAN NOT NULL DEFAULT true,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_club_courts_club ON club_courts(club_id);
-- Reemplaza la columna "surface" (Fase 2 original) por floor_type/wall_type,
-- separados a pedido de Fabri. No había canchas reales cargadas todavía.
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
                  'booking_cancelled'));

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
-- Como con club_claims: una sola solicitud de EDICIÓN pendiente por club a la vez
-- (club_id NULL = alta nueva, esas no colisionan entre sí -- NULL no choca con NULL en un índice único).
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

-- ─── Fase 3 de "reservas de cancha": reserva pública de un turno ────────────
-- Horizonte fijo de 7 días. Un turno "pending" NO bloquea el horario --
-- varias personas pueden pedir el mismo turno a la vez, decisión cerrada con
-- Fabri, 2026-09-06: bloquear al instante le hacía perder clientes al dueño
-- si alguien spameaba pedidos sin confirmar nunca. Sólo "confirmed" bloquea
-- (ver los índices únicos más abajo). Cuando el dueño confirma una reserva,
-- cualquier otra "pending" que compartía ese mismo horario se rechaza sola
-- (routes/clubs.js, cancelOverlappingPending) y se le avisa a quien la hizo.
-- Si el club no cargó canchas reales todavía,
-- `court_id` queda NULL -- se reserva sólo día/horario, sin elegir cancha en
-- particular. Quién reservó nunca es público (decisión cerrada): las rutas
-- de lectura pública de reservas (routes/clubs.js) nunca devuelven
-- guest_name/guest_contact, sólo lo necesario para pintar la grilla.
CREATE TABLE IF NOT EXISTS bookings (
  id                TEXT PRIMARY KEY,
  -- Varios turnos consecutivos reservados juntos (ej. 08:00 y 09:00 para
  -- completar 2 horas con turnos de 60 min) se guardan como una fila por
  -- turno base, todas con el mismo group_id -- así el índice único de abajo
  -- (que sigue siendo por turno individual) no necesita saber nada de rangos,
  -- y Fase 4 puede agruparlas para aprobar/rechazar el conjunto de una vez.
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
-- Si `bookings` ya existía de una corrida anterior de este mismo schema.sql
-- (creada antes de sumar `group_id`), el CREATE TABLE de arriba no la tocó --
-- hay que agregarle la columna a mano. Las filas viejas (todas de un solo
-- turno, de antes de que existiera la reserva de varios turnos seguidos) se
-- backfillean con su propio `id` como `group_id` -- son, cada una, un grupo
-- de un solo turno.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS group_id TEXT;
UPDATE bookings SET group_id = id WHERE group_id IS NULL;
ALTER TABLE bookings ALTER COLUMN group_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bookings_club_date ON bookings(club_id, date);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bookings_group ON bookings(group_id);

-- Dos índices únicos parciales en vez de uno solo: un UNIQUE normal no evita
-- dos filas con el mismo (club_id, date, start_time) si court_id es NULL en
-- ambas, porque Postgres trata cada NULL como distinto entre sí. Sólo
-- "confirmed" entra en el índice (antes también "pending" -- decisión
-- revertida el 2026-09-06, ver comentario de la tabla arriba): hay que
-- borrar y recrear los índices porque un CREATE ... IF NOT EXISTS no
-- actualiza el WHERE de uno que ya existe con la definición vieja.
DROP INDEX IF EXISTS uq_bookings_slot_with_court;
DROP INDEX IF EXISTS uq_bookings_slot_no_court;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_slot_with_court
  ON bookings(club_id, court_id, date, start_time)
  WHERE status = 'confirmed' AND court_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_slot_no_court
  ON bookings(club_id, date, start_time)
  WHERE status = 'confirmed' AND court_id IS NULL;

-- ─── Fase 4: turnos de 30 min, precio por 30/60 min ──────────────────────────
-- Decisión de Fabri (2026-09-13): antes el dueño elegía UNA duración de turno
-- para todo el club (60/90/120 min) y eso limitaba lo que un usuario podía
-- reservar (con turnos de 90 no se podía armar una reserva de 60, por ej.).
-- Ahora `slot_minutes` deja de ser editable por el dueño y queda fijo en 30
-- para TODOS los clubes (el mínimo posible) -- así el usuario arma la
-- duración que quiera sumando turnos de a uno (30, 60, 90, 120...) con el
-- selector +/- de siempre. Se deja la columna (y su lectura en el resto del
-- código) para no tener que tocar cada lugar que la lee, simplemente ahora
-- SIEMPRE vale 30.
ALTER TABLE clubs ALTER COLUMN slot_minutes SET DEFAULT 30;
UPDATE clubs SET slot_minutes = 30 WHERE slot_minutes <> 30;

-- El dueño pasa a cargar DOS precios por cancha -- uno para un turno de 30
-- min y otro para uno de 60 -- porque en la práctica el de 60 no siempre es
-- el doble del de 30 (puede haber un combo). Para una reserva más larga se
-- arma de a bloques de 60 y, si sobra un turno de 30 suelto, se suma aparte
-- (ver computeTotalPrice() acá abajo y en el frontend). Se agregan columnas
-- nuevas sin tocar `price` (queda deprecada, no se borra por si tiene datos
-- reales -- mismo criterio que el resto de este archivo).
ALTER TABLE club_courts ADD COLUMN IF NOT EXISTS price_30 NUMERIC(10,2);
ALTER TABLE club_courts ADD COLUMN IF NOT EXISTS price_60 NUMERIC(10,2);
-- Backfill único e idempotente: a partir del precio viejo (un solo precio,
-- para el turno de la duración que tuviera el club en ese momento) se estima
-- un precio de 60 min IGUAL al viejo y uno de 30 min como la mitad -- son
-- sólo un punto de partida, el dueño tiene que revisarlos/corregirlos a mano
-- desde "Gestionar canchas" (sobre todo si su turno viejo no era de 60 min).
UPDATE club_courts SET price_60 = price, price_30 = ROUND(price / 2, 2)
WHERE price_60 IS NULL AND price IS NOT NULL;
