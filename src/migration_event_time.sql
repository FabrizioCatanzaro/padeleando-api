-- Hora de comienzo de la jornada. TIME, no timestamptz: no depende de la zona.
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS event_time TIME;
