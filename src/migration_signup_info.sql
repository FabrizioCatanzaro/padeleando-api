-- Precio y medios de contacto para inscribirse. Se cargan en la categoría y las
-- jornadas los heredan; NULL significa "heredar", por eso signup_open es nullable.
-- signup_contacts: [{ "type": "whatsapp|phone|email|instagram", "value": "..." }]
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
