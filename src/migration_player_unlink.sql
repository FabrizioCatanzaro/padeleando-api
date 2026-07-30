-- Desvinculación de un slot de jugador respecto de una cuenta.
--
-- El slot conserva su nombre y todos sus partidos; sólo pierde el `user_id`, así
-- que deja de contar en las estadísticas del perfil de esa cuenta. La operación
-- la puede hacer tanto el propio jugador como quien gestione la categoría, y en
-- ambos casos se notifica al otro lado — de ahí el tipo nuevo.
ALTER TABLE IF EXISTS notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE IF EXISTS notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('follow','invitation','join_request','admin_message','club_request',
                  'collab_invite','ownership_transfer','ownership_received','premium_claim',
                  'player_unlinked'));
