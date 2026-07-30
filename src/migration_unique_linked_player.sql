-- Una cuenta no puede tener dos slots de jugador en la misma categoría.
-- Los duplicados nacían de que POST /players/resolve y POST /tournaments buscaban
-- el slot existente sólo por nombre: si el nombre de la cuenta no coincidía con el
-- del slot ya vinculado, se creaba un segundo.
--
-- No se puede expresar con un índice único porque la restricción cruza dos tablas
-- (group_players.group_id + players.user_id), así que va como trigger. Valida sólo
-- lo que se escribe de acá en adelante; los duplicados históricos no lo disparan.
-- Para detectarlos:
--
--   SELECT gp.group_id, p.user_id, count(*), string_agg(p.id || ':' || p.name, ', ')
--   FROM players p
--   JOIN group_players gp ON gp.player_id = p.id
--   WHERE p.user_id IS NOT NULL
--   GROUP BY gp.group_id, p.user_id
--   HAVING count(*) > 1;

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
