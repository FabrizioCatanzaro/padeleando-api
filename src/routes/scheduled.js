import { Router } from 'express';
import { getDb }  from '../db.js';
import { uid }    from '../uid.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTournamentManage, requireScheduledManage } from '../middleware/access.js';
import { MAX_PREVIA_MATCHES, countPairAppearances, pairKey, withdrawnTeamError, buildFacedMap } from '../lib/fixture.js';
import { isIsoDate } from '../lib/ligaFechas.js';

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

// Día suelto: 'YYYY-MM-DD'. Null es válido (partido sin día fijo).
function normalizarDia(v) {
  if (v == null || v === '') return null;
  return isIsoDate(v) ? v : undefined;
}

const esTemporada = (ctx) => ctx.format === 'liga' && ctx.liga_mode === 'temporada';

/**
 * En una liga por fechas, el programado pertenece a una fecha que existe y,
 * si la liga no permite cruces repetidos, no repite un cruce jugado o
 * programado.
 * @returns {Promise<string|null>} mensaje de error, o null si está bien
 */
async function chequearTemporada(sql, ctx, { team1, team2, round, excluirId = null }) {
  if (round !== undefined) {
    if (!Number.isInteger(round)) return 'Elegí la fecha del partido';
    const [fecha] = await sql`
      SELECT 1 FROM tournament_fechas WHERE tournament_id = ${ctx.tournament_id} AND number = ${round}
    `;
    if (!fecha) return 'Esa fecha no existe';
  }
  if (team1 && !ctx.allow_rematch) {
    const [jugados, programados] = await Promise.all([
      sql`SELECT team1_p1, team1_p2, team2_p1, team2_p2 FROM matches WHERE tournament_id = ${ctx.tournament_id}`,
      sql`SELECT id, team1_p1, team1_p2, team2_p1, team2_p2 FROM scheduled_matches WHERE tournament_id = ${ctx.tournament_id}`,
    ]);
    const cruces = buildFacedMap([...jugados, ...programados.filter((r) => r.id !== excluirId)]);
    if (cruces.get(pairKey(team1))?.has(pairKey(team2))) return 'Ese cruce ya se jugó o ya está programado';
  }
  return null;
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
    const { tournamentId, team1, team2, court, scheduled_at, position, round, scheduled_date } = req.body;

    const errEquipos = validarEquipos(team1, team2);
    if (errEquipos) return res.status(400).json({ error: errEquipos });

    const hora = normalizarHora(scheduled_at);
    if (hora === undefined) return res.status(400).json({ error: 'Hora inválida' });
    const dia = normalizarDia(scheduled_date);
    if (dia === undefined) return res.status(400).json({ error: 'Día inválido' });

    if (req.accessCtx.status === 'finished') {
      return res.status(400).json({ error: 'El torneo está finalizado' });
    }

    const sql = getDb();
    const retirada = await withdrawnTeamError(sql, tournamentId, team1, team2);
    if (retirada) return res.status(400).json({ error: retirada });
    if (req.accessCtx.format === 'americano') {
      const errTope = await chequearTopePrevia(sql, tournamentId, team1, team2);
      if (errTope) return res.status(400).json({ error: errTope });
    }
    // En la liga por fechas todo programado es de una fecha.
    const temporada = esTemporada(req.accessCtx);
    if (temporada) {
      if (round === undefined) return res.status(400).json({ error: 'Elegí la fecha del partido' });
      const errFecha = await chequearTemporada(sql, req.accessCtx, { team1, team2, round });
      if (errFecha) return res.status(400).json({ error: errFecha });
    }

    const [row] = await sql`
      INSERT INTO scheduled_matches
        (id, tournament_id, team1_p1, team1_p2, team2_p1, team2_p2, court, scheduled_at, position,
         round, scheduled_date)
      VALUES
        (${uid()}, ${tournamentId}, ${team1[0]}, ${team1[1]}, ${team2[0]}, ${team2[1]},
         ${court ?? null}, ${hora}, ${Number.isInteger(position) ? position : 0},
         ${temporada ? round : null}, ${dia}::date)
      RETURNING *, scheduled_date::text AS scheduled_date
    `;
    res.status(201).json(row);
  } catch (err) { next(err); }
});

// PATCH /api/scheduled/:id — mover de cancha, día u hora, cambiar los equipos,
// postergarlo (postponed) o, en la liga por fechas, pasarlo a otra fecha (round).
router.patch('/:id', requireAuth, requireScheduledManage, async (req, res, next) => {
  try {
    const { team1, team2, court, scheduled_at, position, scheduled_date, postponed, round } = req.body;
    const cambiaEquipos = team1 != null || team2 != null;
    if (cambiaEquipos) {
      const errEquipos = validarEquipos(team1, team2);
      if (errEquipos) return res.status(400).json({ error: errEquipos });
    }
    const hora = normalizarHora(scheduled_at);
    if (hora === undefined) return res.status(400).json({ error: 'Hora inválida' });
    const dia = normalizarDia(scheduled_date);
    if (dia === undefined) return res.status(400).json({ error: 'Día inválido' });
    if (postponed !== undefined && typeof postponed !== 'boolean') {
      return res.status(400).json({ error: 'postponed debe ser true o false' });
    }
    const temporada = esTemporada(req.accessCtx);
    if (round !== undefined && !temporada) {
      return res.status(400).json({ error: 'Solo las ligas en varios días tienen fechas' });
    }

    const sql = getDb();
    if (temporada && (cambiaEquipos || round !== undefined)) {
      const errFecha = await chequearTemporada(sql, req.accessCtx, {
        team1: cambiaEquipos ? team1 : null, team2, round, excluirId: req.params.id,
      });
      if (errFecha) return res.status(400).json({ error: errFecha });
    }
    if (cambiaEquipos) {
      const retirada = await withdrawnTeamError(sql, req.accessCtx.tournament_id, team1, team2);
      if (retirada) return res.status(400).json({ error: retirada });
    }
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
    const tocaDia    = Object.hasOwn(req.body, 'scheduled_date');
    const [row] = await sql`
      UPDATE scheduled_matches SET
        team1_p1 = COALESCE(${cambiaEquipos ? team1[0] : null}, team1_p1),
        team1_p2 = COALESCE(${cambiaEquipos ? team1[1] : null}, team1_p2),
        team2_p1 = COALESCE(${cambiaEquipos ? team2[0] : null}, team2_p1),
        team2_p2 = COALESCE(${cambiaEquipos ? team2[1] : null}, team2_p2),
        court        = CASE WHEN ${tocaCancha}::boolean THEN ${court ?? null}::int  ELSE court        END,
        scheduled_at = CASE WHEN ${tocaHora}::boolean   THEN ${hora ?? null}::time  ELSE scheduled_at END,
        scheduled_date = CASE WHEN ${tocaDia}::boolean THEN ${dia ?? null}::date ELSE scheduled_date END,
        postponed    = COALESCE(${postponed ?? null}::boolean, postponed),
        round        = COALESCE(${round ?? null}::int, round),
        position     = COALESCE(${Number.isInteger(position) ? position : null}, position)
      WHERE id = ${req.params.id}
      RETURNING *, scheduled_date::text AS scheduled_date
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
