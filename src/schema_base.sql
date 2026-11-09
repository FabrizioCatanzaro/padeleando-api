-- Esquema base completo de PADELEANDO, generado del esquema real de producción
-- (node scripts/dump-schema.mjs, 2026-11-08). db:init lo aplica ANTES de
-- schema.sql: en una base nueva crea todo; en una existente cada sentencia es
-- un no-op. Para cambios nuevos seguí usando schema.sql; regenerá este archivo
-- con el script cuando quieras volver a sincronizarlo.
--
-- Las claves foráneas van al final, en bloques que no fallan si ya existen:
-- hay referencias cruzadas entre tablas y no existe un orden de creación válido.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TABLE IF NOT EXISTS admin_broadcasts (
  id text NOT NULL,
  admin_id text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  target text NOT NULL,
  target_user_id text,
  channel text NOT NULL,
  recipients integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  target_user_ids jsonb,
  CONSTRAINT admin_broadcasts_pkey PRIMARY KEY (id),
  CONSTRAINT admin_broadcasts_channel_check CHECK ((channel = ANY (ARRAY['app'::text, 'app_email'::text]))),
  CONSTRAINT admin_broadcasts_target_check CHECK ((target = ANY (ARRAY['all'::text, 'free'::text, 'premium'::text, 'user'::text])))
);

CREATE TABLE IF NOT EXISTS bookings (
  id text NOT NULL,
  club_id text NOT NULL,
  court_id text,
  user_id text,
  guest_name text NOT NULL,
  guest_contact text NOT NULL,
  date date NOT NULL,
  start_time time without time zone NOT NULL,
  duration_minutes integer NOT NULL,
  price numeric(10,2),
  status text DEFAULT 'pending'::text NOT NULL,
  decision_reason text,
  decided_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  group_id text NOT NULL,
  payment_status text,
  mp_preference_id text,
  mp_payment_id text,
  CONSTRAINT bookings_pkey PRIMARY KEY (id),
  CONSTRAINT bookings_payment_status_check CHECK (((payment_status IS NULL) OR (payment_status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))),
  CONSTRAINT bookings_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'rejected'::text])))
);

CREATE TABLE IF NOT EXISTS club_claims (
  id text NOT NULL,
  club_id text NOT NULL,
  requested_by text NOT NULL,
  full_name text NOT NULL,
  phone text NOT NULL,
  relationship text NOT NULL,
  note text,
  photo_front_url text NOT NULL,
  photo_proof_url text NOT NULL,
  photo_social_url text NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  rejection_reason text,
  reviewed_by text,
  reviewed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT club_claims_pkey PRIMARY KEY (id),
  CONSTRAINT club_claims_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);

CREATE TABLE IF NOT EXISTS club_courts (
  id text NOT NULL,
  club_id text NOT NULL,
  name text NOT NULL,
  covered boolean,
  price numeric(10,2),
  active boolean DEFAULT true NOT NULL,
  sort_order integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  floor_type text,
  wall_type text,
  lit boolean,
  external_play boolean,
  price_30 numeric(10,2),
  price_60 numeric(10,2),
  CONSTRAINT club_courts_pkey PRIMARY KEY (id),
  CONSTRAINT club_courts_floor_type_check CHECK (((floor_type IS NULL) OR (floor_type = ANY (ARRAY['cesped_sintetico'::text, 'cesped_natural'::text, 'cemento'::text])))),
  CONSTRAINT club_courts_wall_type_check CHECK (((wall_type IS NULL) OR (wall_type = ANY (ARRAY['cemento'::text, 'cristal'::text]))))
);

CREATE TABLE IF NOT EXISTS club_requests (
  id text NOT NULL,
  requested_by text NOT NULL,
  name text NOT NULL,
  proposed_data jsonb DEFAULT '{}'::jsonb NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  reviewed_by text,
  reviewed_at timestamp with time zone,
  created_club_id text,
  created_at timestamp with time zone DEFAULT now(),
  club_id text,
  previous_data jsonb,
  CONSTRAINT club_requests_pkey PRIMARY KEY (id),
  CONSTRAINT club_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);

CREATE TABLE IF NOT EXISTS clubs (
  id text NOT NULL,
  name text NOT NULL,
  photo_url text,
  photo_public_id text,
  social_links jsonb DEFAULT '[]'::jsonb NOT NULL,
  contact_phone text,
  contact_whatsapp text,
  location_name text,
  lat double precision,
  lon double precision,
  courts integer,
  schedule jsonb DEFAULT '[]'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  owner_id text,
  owner_visible boolean DEFAULT false NOT NULL,
  header_url text,
  header_public_id text,
  slot_minutes integer DEFAULT 30 NOT NULL,
  mp_user_id text,
  mp_access_token text,
  mp_refresh_token text,
  mp_public_key text,
  mp_connected_at timestamp with time zone,
  CONSTRAINT clubs_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS collaborator_invitations (
  id text NOT NULL,
  group_id text NOT NULL,
  invited_by text NOT NULL,
  invited_identifier text,
  invited_user_id text,
  status text DEFAULT 'pending'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  token_hash text,
  CONSTRAINT collaborator_invitations_pkey PRIMARY KEY (id),
  CONSTRAINT collaborator_invitations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text, 'cancelled'::text])))
);

CREATE TABLE IF NOT EXISTS email_verifications (
  id text NOT NULL,
  user_id text NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  used boolean DEFAULT false NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT email_verifications_token_hash_key UNIQUE (token_hash),
  CONSTRAINT email_verifications_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS group_collaborators (
  group_id text NOT NULL,
  user_id text NOT NULL,
  added_by text,
  added_at timestamp with time zone DEFAULT now(),
  CONSTRAINT group_collaborators_pkey PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS group_favorites (
  user_id text NOT NULL,
  group_id text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT group_follows_pkey PRIMARY KEY (user_id, group_id)
);

CREATE TABLE IF NOT EXISTS group_players (
  group_id text NOT NULL,
  player_id text NOT NULL,
  added_at timestamp with time zone DEFAULT now(),
  CONSTRAINT group_players_pkey PRIMARY KEY (group_id, player_id)
);

CREATE TABLE IF NOT EXISTS groups (
  id text NOT NULL,
  name text NOT NULL,
  description text,
  created_at timestamp with time zone DEFAULT now(),
  user_id text,
  is_public boolean DEFAULT true,
  emojis text[] DEFAULT '{}'::text[],
  location_name text,
  place_id text,
  lat double precision,
  lon double precision,
  club_id text,
  pending_club_request_id text,
  signup_open boolean,
  signup_price integer,
  signup_price_unit text,
  signup_contacts jsonb,
  CONSTRAINT groups_pkey PRIMARY KEY (id),
  CONSTRAINT groups_signup_price_unit_check CHECK (((signup_price_unit IS NULL) OR (signup_price_unit = ANY (ARRAY['player'::text, 'pair'::text]))))
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id text NOT NULL,
  identifier text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  ip text,
  CONSTRAINT login_attempts_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS matches (
  id text NOT NULL,
  tournament_id text NOT NULL,
  team1_p1 text NOT NULL,
  team1_p2 text NOT NULL,
  team2_p1 text NOT NULL,
  team2_p2 text NOT NULL,
  score1 integer NOT NULL,
  score2 integer NOT NULL,
  played_at date NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  duration_seconds integer,
  sets_format smallint,
  sets jsonb,
  court integer,
  CONSTRAINT matches_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id text NOT NULL,
  user_id text NOT NULL,
  type text NOT NULL,
  actor_id text,
  entity_id text,
  read boolean DEFAULT false NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  title text,
  body text,
  CONSTRAINT notifications_pkey PRIMARY KEY (id),
  CONSTRAINT notifications_type_check CHECK ((type = ANY (ARRAY['follow'::text, 'invitation'::text, 'join_request'::text, 'admin_message'::text, 'club_request'::text, 'collab_invite'::text, 'ownership_transfer'::text, 'ownership_received'::text, 'premium_claim'::text, 'player_unlinked'::text, 'new_tournament'::text, 'club_claim'::text, 'booking_decided'::text, 'booking_requested'::text, 'booking_cancelled'::text])))
);

CREATE TABLE IF NOT EXISTS ownership_transfers (
  id text NOT NULL,
  group_id text NOT NULL,
  from_user_id text NOT NULL,
  to_user_id text,
  status text DEFAULT 'pending'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  token_hash text,
  CONSTRAINT ownership_transfers_pkey PRIMARY KEY (id),
  CONSTRAINT ownership_transfers_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text, 'cancelled'::text])))
);

CREATE TABLE IF NOT EXISTS pairs (
  id text NOT NULL,
  tournament_id text NOT NULL,
  p1_id text NOT NULL,
  p2_id text NOT NULL,
  CONSTRAINT pairs_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS password_resets (
  id text NOT NULL,
  user_id text NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  used boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT password_resets_token_hash_key UNIQUE (token_hash),
  CONSTRAINT password_resets_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS player_invitations (
  id text NOT NULL,
  player_id text NOT NULL,
  group_id text NOT NULL,
  invited_by text NOT NULL,
  invited_identifier text,
  invited_user_id text,
  status text DEFAULT 'pending'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  token_hash text,
  CONSTRAINT player_invitations_token_hash_key UNIQUE (token_hash),
  CONSTRAINT player_invitations_pkey PRIMARY KEY (id),
  CONSTRAINT player_invitations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text])))
);

CREATE TABLE IF NOT EXISTS players (
  id text NOT NULL,
  name text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  user_id text,
  original_name text,
  CONSTRAINT players_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS premium_claim_codes (
  user_id text NOT NULL,
  mp_email text NOT NULL,
  preapproval_id text NOT NULL,
  code text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT premium_claim_codes_pkey PRIMARY KEY (user_id)
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id text NOT NULL,
  user_id text NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT refresh_tokens_token_hash_key UNIQUE (token_hash),
  CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS scheduled_matches (
  id text NOT NULL,
  tournament_id text NOT NULL,
  team1_p1 text NOT NULL,
  team1_p2 text NOT NULL,
  team2_p1 text NOT NULL,
  team2_p2 text NOT NULL,
  court integer,
  scheduled_at time without time zone,
  position integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT scheduled_matches_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id text NOT NULL,
  user_id text NOT NULL,
  plan text DEFAULT 'free'::text NOT NULL,
  billing_period text,
  status text DEFAULT 'active'::text NOT NULL,
  starts_at timestamp with time zone DEFAULT now() NOT NULL,
  ends_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  mp_preapproval_id text,
  mp_email text,
  cancel_at_period_end boolean DEFAULT false NOT NULL,
  CONSTRAINT subscriptions_mp_preapproval_id_key UNIQUE (mp_preapproval_id),
  CONSTRAINT subscriptions_pkey PRIMARY KEY (id),
  CONSTRAINT subscriptions_billing_period_check CHECK ((billing_period = ANY (ARRAY['monthly'::text, 'quarterly'::text, 'annual'::text, 'trial'::text]))),
  CONSTRAINT subscriptions_plan_check CHECK ((plan = ANY (ARRAY['free'::text, 'premium'::text]))),
  CONSTRAINT subscriptions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'cancelled'::text, 'expired'::text, 'pending'::text])))
);

CREATE TABLE IF NOT EXISTS tournament_join_requests (
  id text NOT NULL,
  tournament_id text NOT NULL,
  user_id text NOT NULL,
  status text DEFAULT 'pending'::text NOT NULL,
  player_id text,
  created_at timestamp with time zone DEFAULT now(),
  requested_player_id text,
  CONSTRAINT tournament_join_requests_tournament_id_user_id_key UNIQUE (tournament_id, user_id),
  CONSTRAINT tournament_join_requests_pkey PRIMARY KEY (id),
  CONSTRAINT tournament_join_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text])))
);

CREATE TABLE IF NOT EXISTS tournament_photos (
  id text NOT NULL,
  tournament_id text NOT NULL,
  uploaded_by text NOT NULL,
  url text NOT NULL,
  public_id text NOT NULL,
  caption text,
  created_at timestamp with time zone DEFAULT now(),
  is_cover boolean DEFAULT false NOT NULL,
  CONSTRAINT tournament_photos_pkey PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS tournament_players (
  tournament_id text NOT NULL,
  player_id text NOT NULL,
  added_at timestamp with time zone DEFAULT now(),
  CONSTRAINT tournament_players_pkey PRIMARY KEY (tournament_id, player_id)
);

CREATE TABLE IF NOT EXISTS tournaments (
  id text NOT NULL,
  group_id text NOT NULL,
  name text NOT NULL,
  mode text DEFAULT 'free'::text NOT NULL,
  status text DEFAULT 'active'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  live_match jsonb,
  format text DEFAULT 'liga'::text NOT NULL,
  bracket jsonb,
  number_of_courts integer DEFAULT 1 NOT NULL,
  club_id text,
  event_date date,
  pending_club_request_id text,
  signup_open boolean,
  signup_price integer,
  signup_price_unit text,
  signup_contacts jsonb,
  event_time time without time zone,
  CONSTRAINT tournaments_pkey PRIMARY KEY (id),
  CONSTRAINT tournaments_signup_price_unit_check CHECK (((signup_price_unit IS NULL) OR (signup_price_unit = ANY (ARRAY['player'::text, 'pair'::text]))))
);

CREATE TABLE IF NOT EXISTS user_follows (
  follower_id text NOT NULL,
  following_id text NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT user_follows_pkey PRIMARY KEY (follower_id, following_id)
);

CREATE TABLE IF NOT EXISTS users (
  id text NOT NULL,
  email text NOT NULL,
  password_hash text,
  name text NOT NULL,
  username text NOT NULL,
  google_id text,
  created_at timestamp with time zone DEFAULT now(),
  avatar_url text,
  avatar_public_id text,
  email_verified_at timestamp with time zone,
  role text DEFAULT 'user'::text NOT NULL,
  social_links jsonb DEFAULT '[]'::jsonb,
  bio text,
  advanced_stats_public boolean DEFAULT false NOT NULL,
  onboarding_role text,
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_google_id_key UNIQUE (google_id),
  CONSTRAINT users_username_key UNIQUE (username),
  CONSTRAINT users_pkey PRIMARY KEY (id),
  CONSTRAINT users_onboarding_role_check CHECK ((onboarding_role = ANY (ARRAY['organizer'::text, 'player'::text]))),
  CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['user'::text, 'admin'::text])))
);

-- Claves foráneas
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admin_broadcasts_admin_id_fkey') THEN
    ALTER TABLE admin_broadcasts ADD CONSTRAINT admin_broadcasts_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES users(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admin_broadcasts_target_user_id_fkey') THEN
    ALTER TABLE admin_broadcasts ADD CONSTRAINT admin_broadcasts_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES users(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_club_id_fkey') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_club_id_fkey FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_court_id_fkey') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_court_id_fkey FOREIGN KEY (court_id) REFERENCES club_courts(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_user_id_fkey') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'club_claims_club_id_fkey') THEN
    ALTER TABLE club_claims ADD CONSTRAINT club_claims_club_id_fkey FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'club_claims_requested_by_fkey') THEN
    ALTER TABLE club_claims ADD CONSTRAINT club_claims_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'club_claims_reviewed_by_fkey') THEN
    ALTER TABLE club_claims ADD CONSTRAINT club_claims_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'club_courts_club_id_fkey') THEN
    ALTER TABLE club_courts ADD CONSTRAINT club_courts_club_id_fkey FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'club_requests_club_id_fkey') THEN
    ALTER TABLE club_requests ADD CONSTRAINT club_requests_club_id_fkey FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'club_requests_created_club_id_fkey') THEN
    ALTER TABLE club_requests ADD CONSTRAINT club_requests_created_club_id_fkey FOREIGN KEY (created_club_id) REFERENCES clubs(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'club_requests_requested_by_fkey') THEN
    ALTER TABLE club_requests ADD CONSTRAINT club_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'club_requests_reviewed_by_fkey') THEN
    ALTER TABLE club_requests ADD CONSTRAINT club_requests_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clubs_owner_id_fkey') THEN
    ALTER TABLE clubs ADD CONSTRAINT clubs_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collaborator_invitations_group_id_fkey') THEN
    ALTER TABLE collaborator_invitations ADD CONSTRAINT collaborator_invitations_group_id_fkey FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collaborator_invitations_invited_by_fkey') THEN
    ALTER TABLE collaborator_invitations ADD CONSTRAINT collaborator_invitations_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collaborator_invitations_invited_user_id_fkey') THEN
    ALTER TABLE collaborator_invitations ADD CONSTRAINT collaborator_invitations_invited_user_id_fkey FOREIGN KEY (invited_user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'email_verifications_user_id_fkey') THEN
    ALTER TABLE email_verifications ADD CONSTRAINT email_verifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'group_collaborators_added_by_fkey') THEN
    ALTER TABLE group_collaborators ADD CONSTRAINT group_collaborators_added_by_fkey FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'group_collaborators_group_id_fkey') THEN
    ALTER TABLE group_collaborators ADD CONSTRAINT group_collaborators_group_id_fkey FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'group_collaborators_user_id_fkey') THEN
    ALTER TABLE group_collaborators ADD CONSTRAINT group_collaborators_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'group_follows_group_id_fkey') THEN
    ALTER TABLE group_favorites ADD CONSTRAINT group_follows_group_id_fkey FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'group_follows_user_id_fkey') THEN
    ALTER TABLE group_favorites ADD CONSTRAINT group_follows_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'group_players_group_id_fkey') THEN
    ALTER TABLE group_players ADD CONSTRAINT group_players_group_id_fkey FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'group_players_player_id_fkey') THEN
    ALTER TABLE group_players ADD CONSTRAINT group_players_player_id_fkey FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'groups_club_id_fkey') THEN
    ALTER TABLE groups ADD CONSTRAINT groups_club_id_fkey FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'groups_pending_club_request_id_fkey') THEN
    ALTER TABLE groups ADD CONSTRAINT groups_pending_club_request_id_fkey FOREIGN KEY (pending_club_request_id) REFERENCES club_requests(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'groups_user_id_fkey') THEN
    ALTER TABLE groups ADD CONSTRAINT groups_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'matches_team1_p1_fkey') THEN
    ALTER TABLE matches ADD CONSTRAINT matches_team1_p1_fkey FOREIGN KEY (team1_p1) REFERENCES players(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'matches_team1_p2_fkey') THEN
    ALTER TABLE matches ADD CONSTRAINT matches_team1_p2_fkey FOREIGN KEY (team1_p2) REFERENCES players(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'matches_team2_p1_fkey') THEN
    ALTER TABLE matches ADD CONSTRAINT matches_team2_p1_fkey FOREIGN KEY (team2_p1) REFERENCES players(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'matches_team2_p2_fkey') THEN
    ALTER TABLE matches ADD CONSTRAINT matches_team2_p2_fkey FOREIGN KEY (team2_p2) REFERENCES players(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'matches_tournament_id_fkey') THEN
    ALTER TABLE matches ADD CONSTRAINT matches_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notifications_actor_id_fkey') THEN
    ALTER TABLE notifications ADD CONSTRAINT notifications_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notifications_user_id_fkey') THEN
    ALTER TABLE notifications ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ownership_transfers_from_user_id_fkey') THEN
    ALTER TABLE ownership_transfers ADD CONSTRAINT ownership_transfers_from_user_id_fkey FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ownership_transfers_group_id_fkey') THEN
    ALTER TABLE ownership_transfers ADD CONSTRAINT ownership_transfers_group_id_fkey FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ownership_transfers_to_user_id_fkey') THEN
    ALTER TABLE ownership_transfers ADD CONSTRAINT ownership_transfers_to_user_id_fkey FOREIGN KEY (to_user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pairs_p1_id_fkey') THEN
    ALTER TABLE pairs ADD CONSTRAINT pairs_p1_id_fkey FOREIGN KEY (p1_id) REFERENCES players(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pairs_p2_id_fkey') THEN
    ALTER TABLE pairs ADD CONSTRAINT pairs_p2_id_fkey FOREIGN KEY (p2_id) REFERENCES players(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pairs_tournament_id_fkey') THEN
    ALTER TABLE pairs ADD CONSTRAINT pairs_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'password_resets_user_id_fkey') THEN
    ALTER TABLE password_resets ADD CONSTRAINT password_resets_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'player_invitations_group_id_fkey') THEN
    ALTER TABLE player_invitations ADD CONSTRAINT player_invitations_group_id_fkey FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'player_invitations_invited_by_fkey') THEN
    ALTER TABLE player_invitations ADD CONSTRAINT player_invitations_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES users(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'player_invitations_invited_user_id_fkey') THEN
    ALTER TABLE player_invitations ADD CONSTRAINT player_invitations_invited_user_id_fkey FOREIGN KEY (invited_user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'player_invitations_player_id_fkey') THEN
    ALTER TABLE player_invitations ADD CONSTRAINT player_invitations_player_id_fkey FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'players_user_id_fkey') THEN
    ALTER TABLE players ADD CONSTRAINT players_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'premium_claim_codes_user_id_fkey') THEN
    ALTER TABLE premium_claim_codes ADD CONSTRAINT premium_claim_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refresh_tokens_user_id_fkey') THEN
    ALTER TABLE refresh_tokens ADD CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_matches_team1_p1_fkey') THEN
    ALTER TABLE scheduled_matches ADD CONSTRAINT scheduled_matches_team1_p1_fkey FOREIGN KEY (team1_p1) REFERENCES players(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_matches_team1_p2_fkey') THEN
    ALTER TABLE scheduled_matches ADD CONSTRAINT scheduled_matches_team1_p2_fkey FOREIGN KEY (team1_p2) REFERENCES players(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_matches_team2_p1_fkey') THEN
    ALTER TABLE scheduled_matches ADD CONSTRAINT scheduled_matches_team2_p1_fkey FOREIGN KEY (team2_p1) REFERENCES players(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_matches_team2_p2_fkey') THEN
    ALTER TABLE scheduled_matches ADD CONSTRAINT scheduled_matches_team2_p2_fkey FOREIGN KEY (team2_p2) REFERENCES players(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_matches_tournament_id_fkey') THEN
    ALTER TABLE scheduled_matches ADD CONSTRAINT scheduled_matches_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'subscriptions_user_id_fkey') THEN
    ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournament_join_requests_player_id_fkey') THEN
    ALTER TABLE tournament_join_requests ADD CONSTRAINT tournament_join_requests_player_id_fkey FOREIGN KEY (player_id) REFERENCES players(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournament_join_requests_requested_player_id_fkey') THEN
    ALTER TABLE tournament_join_requests ADD CONSTRAINT tournament_join_requests_requested_player_id_fkey FOREIGN KEY (requested_player_id) REFERENCES players(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournament_join_requests_tournament_id_fkey') THEN
    ALTER TABLE tournament_join_requests ADD CONSTRAINT tournament_join_requests_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournament_join_requests_user_id_fkey') THEN
    ALTER TABLE tournament_join_requests ADD CONSTRAINT tournament_join_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournament_photos_tournament_id_fkey') THEN
    ALTER TABLE tournament_photos ADD CONSTRAINT tournament_photos_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournament_photos_uploaded_by_fkey') THEN
    ALTER TABLE tournament_photos ADD CONSTRAINT tournament_photos_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES users(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournament_players_player_id_fkey') THEN
    ALTER TABLE tournament_players ADD CONSTRAINT tournament_players_player_id_fkey FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournament_players_tournament_id_fkey') THEN
    ALTER TABLE tournament_players ADD CONSTRAINT tournament_players_tournament_id_fkey FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournaments_club_id_fkey') THEN
    ALTER TABLE tournaments ADD CONSTRAINT tournaments_club_id_fkey FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournaments_group_id_fkey') THEN
    ALTER TABLE tournaments ADD CONSTRAINT tournaments_group_id_fkey FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tournaments_pending_club_request_id_fkey') THEN
    ALTER TABLE tournaments ADD CONSTRAINT tournaments_pending_club_request_id_fkey FOREIGN KEY (pending_club_request_id) REFERENCES club_requests(id) ON DELETE SET NULL;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_follows_follower_id_fkey') THEN
    ALTER TABLE user_follows ADD CONSTRAINT user_follows_follower_id_fkey FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_follows_following_id_fkey') THEN
    ALTER TABLE user_follows ADD CONSTRAINT user_follows_following_id_fkey FOREIGN KEY (following_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Índices
CREATE INDEX IF NOT EXISTS idx_bookings_club_date ON public.bookings USING btree (club_id, date);
CREATE INDEX IF NOT EXISTS idx_bookings_group ON public.bookings USING btree (group_id);
CREATE INDEX IF NOT EXISTS idx_bookings_user ON public.bookings USING btree (user_id) WHERE (user_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_slot_no_court ON public.bookings USING btree (club_id, date, start_time) WHERE ((status = 'confirmed'::text) AND (court_id IS NULL));
CREATE UNIQUE INDEX IF NOT EXISTS uq_bookings_slot_with_court ON public.bookings USING btree (club_id, court_id, date, start_time) WHERE ((status = 'confirmed'::text) AND (court_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_club_claims_club ON public.club_claims USING btree (club_id);
CREATE INDEX IF NOT EXISTS idx_club_claims_status ON public.club_claims USING btree (status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_club_claims_one_pending ON public.club_claims USING btree (club_id) WHERE (status = 'pending'::text);
CREATE INDEX IF NOT EXISTS idx_club_courts_club ON public.club_courts USING btree (club_id);
CREATE INDEX IF NOT EXISTS idx_club_requests_club ON public.club_requests USING btree (club_id);
CREATE INDEX IF NOT EXISTS idx_club_requests_status ON public.club_requests USING btree (status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_club_requests_one_pending_edit ON public.club_requests USING btree (club_id) WHERE ((status = 'pending'::text) AND (club_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS idx_clubs_name ON public.clubs USING btree (name);
CREATE INDEX IF NOT EXISTS idx_clubs_owner ON public.clubs USING btree (owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS collaborator_invitations_token_hash_key ON public.collaborator_invitations USING btree (token_hash);
CREATE INDEX IF NOT EXISTS idx_collab_inv_group ON public.collaborator_invitations USING btree (group_id);
CREATE INDEX IF NOT EXISTS idx_collab_inv_user ON public.collaborator_invitations USING btree (invited_user_id);
CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON public.email_verifications USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_group_collab_group ON public.group_collaborators USING btree (group_id);
CREATE INDEX IF NOT EXISTS idx_group_collab_user ON public.group_collaborators USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_group_favorites_group ON public.group_favorites USING btree (group_id);
CREATE INDEX IF NOT EXISTS idx_group_favorites_user ON public.group_favorites USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_gp_group ON public.group_players USING btree (group_id);
CREATE INDEX IF NOT EXISTS idx_gp_player ON public.group_players USING btree (player_id);
CREATE INDEX IF NOT EXISTS idx_groups_club ON public.groups USING btree (club_id);
CREATE INDEX IF NOT EXISTS idx_groups_pending_club ON public.groups USING btree (pending_club_request_id);
CREATE INDEX IF NOT EXISTS idx_groups_user ON public.groups USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ident ON public.login_attempts USING btree (identifier);
CREATE INDEX IF NOT EXISTS idx_login_attempts_key ON public.login_attempts USING btree (identifier, ip, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_t1p1 ON public.matches USING btree (team1_p1);
CREATE INDEX IF NOT EXISTS idx_matches_t1p2 ON public.matches USING btree (team1_p2);
CREATE INDEX IF NOT EXISTS idx_matches_t2p1 ON public.matches USING btree (team2_p1);
CREATE INDEX IF NOT EXISTS idx_matches_t2p2 ON public.matches USING btree (team2_p2);
CREATE INDEX IF NOT EXISTS idx_matches_tournament ON public.matches USING btree (tournament_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON public.notifications USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON public.notifications USING btree (user_id) WHERE (read = false);
CREATE INDEX IF NOT EXISTS idx_ownership_transfers_group ON public.ownership_transfers USING btree (group_id);
CREATE UNIQUE INDEX IF NOT EXISTS ownership_transfers_token_hash_key ON public.ownership_transfers USING btree (token_hash);
CREATE INDEX IF NOT EXISTS idx_pairs_tournament ON public.pairs USING btree (tournament_id);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON public.password_resets USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_invitations_player ON public.player_invitations USING btree (player_id);
CREATE INDEX IF NOT EXISTS idx_invitations_user ON public.player_invitations USING btree (invited_user_id);
CREATE INDEX IF NOT EXISTS idx_players_user ON public.players USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON public.refresh_tokens USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_matches_tournament ON public.scheduled_matches USING btree (tournament_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_mp ON public.subscriptions USING btree (mp_preapproval_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON public.subscriptions USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_join_requests_tournament ON public.tournament_join_requests USING btree (tournament_id);
CREATE INDEX IF NOT EXISTS idx_join_requests_user ON public.tournament_join_requests USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_tournament_photos_tournament ON public.tournament_photos USING btree (tournament_id);
CREATE INDEX IF NOT EXISTS idx_tp_player ON public.tournament_players USING btree (player_id);
CREATE INDEX IF NOT EXISTS idx_tp_tournament ON public.tournament_players USING btree (tournament_id);
CREATE INDEX IF NOT EXISTS idx_tournaments_club ON public.tournaments USING btree (club_id);
CREATE INDEX IF NOT EXISTS idx_tournaments_group ON public.tournaments USING btree (group_id);
CREATE INDEX IF NOT EXISTS idx_tournaments_pending_club ON public.tournaments USING btree (pending_club_request_id);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON public.user_follows USING btree (follower_id);
CREATE INDEX IF NOT EXISTS idx_follows_following ON public.user_follows USING btree (following_id);
CREATE INDEX IF NOT EXISTS idx_users_username ON public.users USING btree (username);
