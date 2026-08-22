import { Router } from 'express';
import { getDb }  from '../db.js';
import { uid }    from '../uid.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTournamentManage, requireScheduledManage } from '../middleware/access.js';
import { MAX_PREVIA_MATCHES, countPairAppearances, pairKey } from '../lib/fixture.js';

const router = Router();

function validarEquipos(team1, team2) {
  if (!team1?.[0] || !team1?.[1] || !team2?.[0] || !team2?.[1]) return 'Datos incompletos';
  if (new Set([...team1, ...team2]).size !== 4) return 'Los 4 jugadores deben ser distintos';
  return null;
}

// Hora suelta: 'HH:MM' o 'HH:MM:SS'. Null es válido (partido sin hora fija).
function normalizarHora(v) {
  if (v == null || v === '') return null;
  const m = /^(\d{2}):(\d{2})(:\d{2})?$/.exec(String(v));
  if (!m) return undefined; // undefined = inválido, para distinguirlo de "sin hora"
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return undefined;
  return `${m[1]}:${m[2]}:00`;
}

/**
 * En la fase previa de un americano cada pareja juega como mucho dos partidos.
 * Un partido PROGRAMADO ya ocupa uno de esos dos: si no contara, se podrían
 * programar tres y la fase quedaría rota antes de empezar a jugarse.
 * @returns {string|null} mensaje de error, o null si se puede programar
 */
async function chequearTopePrevia(sql, tournamentId, team1, team2, excluirId = null) {
  const [jugados, programados] = await Promise.all([
    sql`SELECT team1_p1, team1_p2, team2_p1, team2_p2
        FROM matches WHERE tournament_id = ${tournamentId}`,
    sql`SELECT id, team1_p1, team1_p2, team2_p1, team2_p2
        FROM scheduled_matches WHERE tournament_id = ${tournamentId}`,
  ]);
  const filas = [...jugados, ...programados.filter((r) => r.id !== excluirId)];
  const cuenta = countPairAppearances(filas);
  for (const equipo of [team1, team2]) {
    const n = cuenta.get(pairKey(equipo)) ?? 0;
    if (n >= MAX_PREVIA_MATCHES) {
      return `Esa pareja ya tiene sus ${MAX_PREVIA_MATCHES} partidos de la fase previa`;
    }
  }
  return null;
}

// POST /api/scheduled — programar un partido
router.post('/', requireAuth, requireTournamentManage, async (req, res, next) => {
  try {
    const { tournamentId, team1, team2, court, scheduled_at, position } = req.body;

    const errEquipos = validarEquipos(team1, team2);
    if (errEquipos) return res.status(400).json({ error: errEquipos });

    const hora = normalizarHora(scheduled_at);
    if (hora === undefined) return res.status(400).json({ error: 'Hora inválida' });

    if (req.accessCtx.status === 'finished') {
      return res.status(400).json({ error: 'El torneo está finalizado' });
    }

    const sql = getDb();
    if (req.accessCtx.format === 'americano') {
      const errTope = await chequearTopePrevia(sql, tournamentId, team1, team2);
      if (errTope) return res.status(400).json({ error: errTope });
    }

    const [row] = await sql`
      INSERT INTO scheduled_matches
        (id, tournament_id, team1_p1, team1_p2, team2_p1, team2_p2, court, scheduled_at, position)
      VALUES
        (${uid()}, ${tournamentId}, ${team1[0]}, ${team1[1]}, ${team2[0]}, ${team2[1]},
         ${court ?? null}, ${hora}, ${Number.isInteger(position) ? position : 0})
      RETURNING *
    `;
    res.status(201).json(row);
  } catch (err) { next(err); }
});

// PATCH /api/scheduled/:id — mover de cancha u hora, o cambiar los equipos
router.patch('/:id', requireAuth, requireScheduledManage, async (req, res, next) => {
  try {
    const { team1, team2, court, scheduled_at, position } = req.body;
    const cambiaEquipos = team1 != null || team2 != null;
    if (cambiaEquipos) {
      const errEquipos = validarEquipos(team1, team2);
      if (errEquipos) return res.status(400).json({ error: errEquipos });
    }
    const hora = normalizarHora(scheduled_at);
    if (hora === undefined) return res.status(400).json({ error: 'Hora inválida' });

    const sql = getDb();
    if (cambiaEquipos && req.accessCtx.format === 'americano') {
      const errTope = await chequearTopePrevia(
        sql, req.accessCtx.tournament_id, team1, team2, req.params.id,
      );
      if (errTope) return res.status(400).json({ error: errTope });
    }

    // La cancha y la hora se pueden BORRAR mandando null, así que no alcanza con
    // COALESCE: hay que distinguir "no vino en el body" de "vino en null".
    const tocaCancha = Object.hasOwn(req.body, 'court');
    const tocaHora   = Object.hasOwn(req.body, 'scheduled_at');
    const [row] = await sql`
      UPDATE scheduled_matches SET
        team1_p1 = COALESCE(${cambiaEquipos ? team1[0] : null}, team1_p1),
        team1_p2 = COALESCE(${cambiaEquipos ? team1[1] : null}, team1_p2),
        team2_p1 = COALESCE(${cambiaEquipos ? team2[0] : null}, team2_p1),
        team2_p2 = COALESCE(${cambiaEquipos ? team2[1] : null}, team2_p2),
        court        = CASE WHEN ${tocaCancha}::boolean THEN ${court ?? null}::int  ELSE court        END,
        scheduled_at = CASE WHEN ${tocaHora}::boolean   THEN ${hora ?? null}::time  ELSE scheduled_at END,
        position     = COALESCE(${Number.isInteger(position) ? position : null}, position)
      WHERE id = ${req.params.id}
      RETURNING *
    `;
    if (!row) return res.status(404).json({ error: 'Partido programado no encontrado' });
    res.json(row);
  } catch (err) { next(err); }
});

// DELETE /api/scheduled/:id — sacarlo del fixture
router.delete('/:id', requireAuth, requireScheduledManage, async (req, res, next) => {
  try {
    const sql = getDb();
    await sql`DELETE FROM scheduled_matches WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
