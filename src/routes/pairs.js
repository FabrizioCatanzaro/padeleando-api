import { Router } from 'express';
import { getDb, withTransaction } from '../db.js';
import { uid }    from '../uid.js';
import { requireAuth } from '../middleware/auth.js';
import { requireTournamentManage, requirePairManage } from '../middleware/access.js';
import { walkoverMatchesFor, applyBracketWalkovers } from '../lib/tournamentLogic.js';

const router = Router();

/** Partidos jugados donde uno de los equipos es exactamente esta pareja. */
async function countPairMatches(sql, pair) {
  const [{ count }] = await sql`
    SELECT COUNT(*)::int AS count FROM matches
    WHERE tournament_id = ${pair.tournament_id}
      AND ((team1_p1 = ${pair.p1_id} AND team1_p2 = ${pair.p2_id}) OR (team1_p1 = ${pair.p2_id} AND team1_p2 = ${pair.p1_id})
        OR (team2_p1 = ${pair.p1_id} AND team2_p2 = ${pair.p2_id}) OR (team2_p1 = ${pair.p2_id} AND team2_p2 = ${pair.p1_id}))
  `;
  return count;
}

/**
 * Los dos jugadores de una pareja nueva o editada: distintos, del torneo y sin
 * otra pareja activa. Antes sólo lo validaba el front.
 * @returns {string|null} mensaje de error
 */
async function validatePairPlayers(sql, tournamentId, p1Id, p2Id, excludePairId = null) {
  if (p1Id === p2Id) return 'Los dos jugadores de la pareja tienen que ser distintos';
  const [inTournament, taken] = await Promise.all([
    sql`SELECT player_id FROM tournament_players
        WHERE tournament_id = ${tournamentId} AND player_id = ANY(${[p1Id, p2Id]})`,
    sql`SELECT id FROM pairs
        WHERE tournament_id = ${tournamentId} AND status = 'active'
          AND id <> ${excludePairId ?? ''}
          AND (p1_id = ANY(${[p1Id, p2Id]}) OR p2_id = ANY(${[p1Id, p2Id]}))
        LIMIT 1`,
  ]);
  if (inTournament.length !== 2) return 'Los dos jugadores tienen que estar en el torneo';
  if (taken.length) return 'Uno de los jugadores ya está en otra pareja';
  return null;
}

// POST /api/pairs
router.post('/', requireAuth, requireTournamentManage, async (req, res, next) => {
  try {
    const { tournamentId, p1Id, p2Id } = req.body;
    if (!tournamentId || !p1Id || !p2Id) {
      return res.status(400).json({ error: 'tournamentId, p1Id y p2Id son requeridos' });
    }
    const sql = getDb();

    // Tope del formato americano: 16 parejas.
    const [tournament] = await sql`SELECT format, bracket FROM tournaments WHERE id = ${tournamentId}`;
    if (!tournament) return res.status(404).json({ error: 'Torneo no encontrado' });
    if (tournament.format === 'americano') {
      if (tournament.bracket) {
        return res.status(400).json({ error: 'El cuadro ya fue generado: no se pueden sumar parejas' });
      }
      const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM pairs WHERE tournament_id = ${tournamentId}`;
      if (count >= 16) {
        return res.status(400).json({ error: 'El modo Americano admite hasta 16 parejas' });
      }
    }

    const invalid = await validatePairPlayers(sql, tournamentId, p1Id, p2Id);
    if (invalid) return res.status(400).json({ error: invalid });

    const [pair] = await sql`
      INSERT INTO pairs (id, tournament_id, p1_id, p2_id)
      VALUES (${uid()}, ${tournamentId}, ${p1Id}, ${p2Id}) RETURNING *
    `;
    res.status(201).json(pair);
  } catch (err) { next(err); }
});

// PUT /api/pairs/:id
// Americano: cambiar los jugadores de una pareja que ya jugó le reescribía la
// historia (la tabla y el cuadro son por pareja). Con partidos jugados, el
// reemplazo es retirarla y armar una nueva. En Liga las parejas cambian en
// medio del torneo y la tabla es por jugador: se editan siempre.
router.put('/:id', requireAuth, requirePairManage, async (req, res, next) => {
  try {
    const { p1Id, p2Id } = req.body;
    if (!p1Id || !p2Id) return res.status(400).json({ error: 'p1Id y p2Id son requeridos' });
    const sql = getDb();
    const [current] = await sql`SELECT * FROM pairs WHERE id = ${req.params.id}`;
    if (!current) return res.status(404).json({ error: 'Pareja no encontrada' });
    if (current.status === 'withdrawn') return res.status(400).json({ error: 'La pareja está retirada' });

    const changed = [p1Id, p2Id].sort().join('|') !== [current.p1_id, current.p2_id].sort().join('|');
    if (changed && req.accessCtx.format === 'americano' && await countPairMatches(sql, current) > 0) {
      return res.status(409).json({
        error: 'Esta pareja ya jugó partidos. Para reemplazar a un jugador, retirá la pareja y armá una nueva.',
        code: 'pair_has_matches',
      });
    }

    const invalid = await validatePairPlayers(sql, current.tournament_id, p1Id, p2Id, current.id);
    if (invalid) return res.status(400).json({ error: invalid });

    const [pair] = await sql`
      UPDATE pairs SET p1_id = ${p1Id}, p2_id = ${p2Id}
      WHERE id = ${req.params.id} RETURNING *
    `;
    res.json(pair);
  } catch (err) { next(err); }
});

// DELETE /api/pairs/:id
// Americano: sólo para parejas que no jugaron. Borrar una con partidos dejaba a
// sus rivales con partidos que el calendario ya no contaba y desarmaba el
// cuadro; con partidos jugados se retira (POST /:id/withdraw). En Liga se
// borra siempre: sus partidos quedan, porque la tabla es por jugador.
router.delete('/:id', requireAuth, requirePairManage, async (req, res, next) => {
  try {
    const sql = getDb();
    const [pair] = await sql`
      SELECT p.*, t.bracket FROM pairs p JOIN tournaments t ON t.id = p.tournament_id
      WHERE p.id = ${req.params.id}
    `;
    if (!pair) return res.status(404).json({ error: 'Pareja no encontrada' });
    if (req.accessCtx.format === 'americano' && (pair.bracket || await countPairMatches(sql, pair) > 0)) {
      return res.status(409).json({
        error: 'Esta pareja ya jugó en el torneo. Retirala en lugar de eliminarla: pierde 6-0 lo que le queda.',
        code: 'pair_has_matches',
      });
    }
    // Sus partidos programados ya no se van a jugar.
    await sql`
      DELETE FROM scheduled_matches
      WHERE tournament_id = ${pair.tournament_id}
        AND (team1_p1 = ANY(${[pair.p1_id, pair.p2_id]}) OR team1_p2 = ANY(${[pair.p1_id, pair.p2_id]})
          OR team2_p1 = ANY(${[pair.p1_id, pair.p2_id]}) OR team2_p2 = ANY(${[pair.p1_id, pair.p2_id]}))
    `;
    await sql`DELETE FROM pairs WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/pairs/:id/withdraw — baja de una pareja con el torneo en juego.
// La pareja queda en el torneo como retirada: su historia sigue en la tabla.
// Sus partidos programados pasan a W.O. 6-0 para el rival y, si hay cuadro,
// sus cruces se resuelven solos por W.O. y el rival avanza. No se deshace.
// Sólo en Americano: en Liga las parejas se editan o se borran libremente.
router.post('/:id/withdraw', requireAuth, requirePairManage, async (req, res, next) => {
  try {
    if (req.accessCtx.format !== 'americano') {
      return res.status(400).json({ error: 'Retirar una pareja sólo existe en el formato Americano' });
    }
    const result = await withTransaction(async (client) => {
      const { rows: [pair] } = await client.query('SELECT * FROM pairs WHERE id = $1', [req.params.id]);
      if (!pair) return { status: 404, error: 'Pareja no encontrada' };
      const { rows: [tournament] } = await client.query(
        'SELECT id, status, bracket FROM tournaments WHERE id = $1 FOR UPDATE', [pair.tournament_id]
      );
      if (tournament.status === 'finished') return { status: 400, error: 'El torneo está finalizado' };
      if (pair.status === 'withdrawn') return { status: 409, error: 'La pareja ya está retirada' };

      await client.query(
        `UPDATE pairs SET status = 'withdrawn', withdrawn_at = NOW() WHERE id = $1`, [pair.id]
      );

      const { rows: scheduled } = await client.query(
        'SELECT * FROM scheduled_matches WHERE tournament_id = $1', [pair.tournament_id]
      );
      const walkovers = walkoverMatchesFor(pair, scheduled);
      const today = new Date().toISOString().slice(0, 10);
      for (const w of walkovers) {
        await client.query(
          `INSERT INTO matches
             (id, tournament_id, team1_p1, team1_p2, team2_p1, team2_p2, score1, score2, played_at, court, walkover)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)`,
          [uid(), pair.tournament_id, w.team1[0], w.team1[1], w.team2[0], w.team2[1],
           w.score1, w.score2, today, w.court]
        );
        await client.query('DELETE FROM scheduled_matches WHERE id = $1', [w.scheduled_id]);
      }

      if (tournament.bracket) {
        const withdrawn = [...new Set([...(tournament.bracket.withdrawn_pair_ids ?? []), pair.id])];
        const bracket = applyBracketWalkovers({ ...tournament.bracket, withdrawn_pair_ids: withdrawn });
        await client.query('UPDATE tournaments SET bracket = $1::jsonb WHERE id = $2',
          [JSON.stringify(bracket), tournament.id]);
      }
      return { walkovers: walkovers.length };
    });

    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true, walkovers: result.walkovers });
  } catch (err) { next(err); }
});

export default router;
