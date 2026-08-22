import { Router } from 'express';
import { getDb }  from '../db.js';
import { uid }    from '../uid.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTournamentManage, requireMatchManage } from '../middleware/access.js';

const router = Router();

/**
 * Valida el marcador. En padel no existe el empate: el formulario ya no deja
 * guardarlo (canSave en MatchForm), pero sin este chequeo la API lo aceptaba y
 * quedaba un partido sin ganador que ninguna tabla de posiciones puede
 * interpretar. La fase eliminatoria ya lo rechazaba.
 * @returns {string|null} mensaje de error, o null si el marcador es válido
 */
function validateScore(score1, score2) {
  if (score1 == null || score2 == null) return 'score1 y score2 requeridos';
  if (!Number.isInteger(score1) || !Number.isInteger(score2)) return 'Los scores deben ser números enteros';
  if (score1 < 0 || score2 < 0) return 'Los scores no pueden ser negativos';
  if (score1 === score2) return 'No puede haber empate: un partido siempre tiene ganador';
  return null;
}

// POST /api/matches
router.post('/', requireAuth, requireTournamentManage, async (req, res, next) => {
  try {
    const { tournamentId, team1, team2, score1, score2, playedAt, duration_seconds, sets, sets_format, court, scheduledId } = req.body;

    if (!tournamentId || !team1?.[0] || !team1?.[1] || !team2?.[0] || !team2?.[1]) {
      return res.status(400).json({ error: 'Datos incompletos' });
    }
    if (new Set([...team1, ...team2]).size !== 4) {
      return res.status(400).json({ error: 'Los 4 jugadores deben ser distintos' });
    }
    const scoreError = validateScore(score1, score2);
    if (scoreError) return res.status(400).json({ error: scoreError });

    const sql = getDb();

    // Un americano en borrador (menos de 8 parejas) todavía no se puede jugar.
    // El format ya viene resuelto por requireTournamentManage: no hace falta
    // volver a consultar la misma fila.
    if (req.accessCtx.format === 'americano') {
      const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM pairs WHERE tournament_id = ${tournamentId}`;
      if (count < 8) {
        return res.status(400).json({ error: 'El americano necesita al menos 8 parejas para cargar partidos' });
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const setsJson = sets?.length ? JSON.stringify(sets) : null;

    const [match] = await sql`
      INSERT INTO matches
        (id, tournament_id, team1_p1, team1_p2, team2_p1, team2_p2,
         score1, score2, played_at, duration_seconds, sets_format, sets, court)
      VALUES
        (${uid()}, ${tournamentId},
         ${team1[0]}, ${team1[1]}, ${team2[0]}, ${team2[1]},
         ${score1}, ${score2}, ${playedAt ?? today}, ${duration_seconds},
         ${sets_format ?? null}, ${setsJson}, ${court ?? null})
      RETURNING *
    `;

    // Venía del fixture: ya se jugó, así que deja de estar programado.
    if (scheduledId) {
      await sql`
        DELETE FROM scheduled_matches
        WHERE id = ${scheduledId} AND tournament_id = ${tournamentId}
      `;
    }
    res.status(201).json(match);
  } catch (err) { next(err); }
});
 
// PUT /api/matches/:id
router.put('/:id', requireAuth, requireMatchManage, async (req, res, next) => {
  try {
    const { team1, team2, score1, score2, playedAt, duration_seconds, sets, sets_format, court } = req.body;
    const scoreError = validateScore(score1, score2);
    if (scoreError) return res.status(400).json({ error: scoreError });

    const sql = getDb();
    const setsJson = sets?.length ? JSON.stringify(sets) : null;
    const [match] = await sql`
      UPDATE matches SET
        team1_p1  = ${team1[0]}, team1_p2 = ${team1[1]},
        team2_p1  = ${team2[0]}, team2_p2 = ${team2[1]},
        score1    = ${score1},   score2   = ${score2},
        played_at = ${playedAt},
        duration_seconds = ${duration_seconds},
        sets_format = ${sets_format ?? null},
        sets        = ${setsJson},
        court       = ${court ?? null}
      WHERE id = ${req.params.id} RETURNING *
    `;
    if (!match) return res.status(404).json({ error: 'Partido no encontrado' });
    res.json(match);
  } catch (err) { next(err); }
});
 
// DELETE /api/matches/:id
router.delete('/:id', requireAuth, requireMatchManage, async (req, res, next) => {
  try {
    const sql = getDb();
    await sql`DELETE FROM matches WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (err) { next(err); }
});
 
export default router;
