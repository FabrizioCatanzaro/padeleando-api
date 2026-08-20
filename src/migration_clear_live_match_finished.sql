-- Migración: limpiar live_match de las jornadas ya finalizadas
-- Ejecutar una sola vez en bases de datos existentes.
--
-- Finalizar una jornada nunca limpió live_match, así que las terminadas
-- conservan el último payload de partidos en curso y se leían como "en vivo".
-- El PATCH de /api/tournaments/:id ya lo limpia de ahora en más; esto arregla
-- las filas viejas.

UPDATE tournaments
SET    live_match = NULL
WHERE  status = 'finished'
  AND  live_match IS NOT NULL;
