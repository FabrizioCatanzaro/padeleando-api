import { Router } from 'express';
import { getDb } from '../db.js';
import { uid } from '../uid.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// POST /api/join-requests — usuario solicita unirse a un torneo
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { tournamentId, playerId } = req.body;
    if (!tournamentId) return res.status(400).json({ error: 'tournamentId requerido' });

    const sql = getDb();

    const [tournament] = await sql`
      SELECT t.id, t.name, t.status, g.user_id AS owner_id
      FROM tournaments t
      JOIN groups g ON g.id = t.group_id
      WHERE t.id = ${tournamentId}
    `;
    if (!tournament) return res.status(404).json({ error: 'Torneo no encontrado' });
    if (tournament.owner_id === req.user.id) {
      return res.status(409).json({ error: 'Sos el organizador de este torneo' });
    }

    const [alreadyPlayer] = await sql`
      SELECT p.id FROM players p
      INNER JOIN tournament_players tp ON tp.player_id = p.id AND tp.tournament_id = ${tournamentId}
      WHERE p.user_id = ${req.user.id}
    `;
    if (alreadyPlayer) return res.status(409).json({ error: 'Ya estás en este torneo' });

    // Jugador específico que el solicitante quiere reclamar (opcional). Debe estar
    // en el torneo y no tener cuenta vinculada todavía.
    if (playerId) {
      const [target] = await sql`
        SELECT p.id, p.user_id FROM players p
        INNER JOIN tournament_players tp ON tp.player_id = p.id AND tp.tournament_id = ${tournamentId}
        WHERE p.id = ${playerId}
      `;
      if (!target) return res.status(404).json({ error: 'Jugador no encontrado en el torneo' });
      if (target.user_id) return res.status(409).json({ error: 'Ese jugador ya está vinculado a una cuenta' });
    }

    const [existing] = await sql`
      SELECT id, status FROM tournament_join_requests
      WHERE tournament_id = ${tournamentId} AND user_id = ${req.user.id}
    `;
    if (existing) {
      if (existing.status === 'pending') {
        return res.status(409).json({ error: 'Ya tenés una solicitud pendiente para este torneo' });
      }
      if (existing.status === 'accepted') {
        return res.status(409).json({ error: 'Tu solicitud ya fue aceptada' });
      }
      // rejected → permitir nueva solicitud
      await sql`DELETE FROM tournament_join_requests WHERE id = ${existing.id}`;
    }

    const [joinRequest] = await sql`
      INSERT INTO tournament_join_requests (id, tournament_id, user_id, requested_player_id)
      VALUES (${uid()}, ${tournamentId}, ${req.user.id}, ${playerId ?? null})
      RETURNING *
    `;

    await sql`
      INSERT INTO notifications (id, user_id, type, actor_id, entity_id)
      VALUES (${uid()}, ${tournament.owner_id}, 'join_request', ${req.user.id}, ${joinRequest.id})
    `;

    res.status(201).json(joinRequest);
  } catch (err) { next(err); }
});

// GET /api/join-requests/my-status/:tournamentId — estado de la solicitud del usuario actual
// IMPORTANTE: debe estar antes de /:id para que Express no lo trate como un ID
router.get('/my-status/:tournamentId', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const { tournamentId } = req.params;

    // Ninguna de las cuatro depende del resultado de otra: un solo round-trip.
    const [[tournament], [alreadyPlayer], [request], [invitation]] = await Promise.all([
      sql`
        SELECT g.user_id AS owner_id FROM tournaments t
        JOIN groups g ON g.id = t.group_id
        WHERE t.id = ${tournamentId}
      `,

      sql`
        SELECT p.id FROM players p
        INNER JOIN tournament_players tp ON tp.player_id = p.id AND tp.tournament_id = ${tournamentId}
        WHERE p.user_id = ${req.user.id}
      `,

      sql`
        SELECT tjr.id, tjr.status, tjr.created_at, tjr.requested_player_id,
               rp.name AS requested_player_name
        FROM tournament_join_requests tjr
        LEFT JOIN players rp ON rp.id = tjr.requested_player_id
        WHERE tjr.tournament_id = ${tournamentId} AND tjr.user_id = ${req.user.id}
      `,

      // Invitación pendiente a un jugador de este torneo. Sin esto la vista
      // ofrecía "solicitar unirse" a alguien que ya estaba invitado.
      sql`
        SELECT pi.id, pi.player_id, pi.created_at,
               p.name AS player_name,
               u.name AS invited_by_name, u.username AS invited_by_username
        FROM player_invitations pi
        JOIN players p ON p.id = pi.player_id
        JOIN tournament_players tp ON tp.player_id = pi.player_id AND tp.tournament_id = ${tournamentId}
        JOIN users u ON u.id = pi.invited_by
        WHERE pi.invited_user_id = ${req.user.id} AND pi.status = 'pending'
        ORDER BY pi.created_at DESC
        LIMIT 1
      `,
    ]);

    res.json({
      is_player: !!alreadyPlayer,
      is_owner: tournament?.owner_id === req.user.id,
      request: request ?? null,
      invitation: invitation ?? null
    });
  } catch (err) { next(err); }
});

// GET /api/join-requests/:id — detalles para que el organizador resuelva la solicitud
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();

    const [request] = await sql`
      SELECT tjr.*,
        u.name AS requester_name, u.username AS requester_username,
        rp.name AS requested_player_name,
        t.name AS tournament_name, t.id AS tournament_id, g.user_id AS owner_id
      FROM tournament_join_requests tjr
      JOIN users u ON u.id = tjr.user_id
      LEFT JOIN players rp ON rp.id = tjr.requested_player_id
      JOIN tournaments t ON t.id = tjr.tournament_id
      JOIN groups g ON g.id = t.group_id
      WHERE tjr.id = ${req.params.id}
    `;
    if (!request) return res.status(404).json({ error: 'Solicitud no encontrada' });
    if (request.owner_id !== req.user.id) return res.status(403).json({ error: 'No autorizado' });

    const unlinkedPlayers = await sql`
      SELECT p.id, p.name
      FROM players p
      INNER JOIN tournament_players tp ON tp.player_id = p.id AND tp.tournament_id = ${request.tournament_id}
      WHERE p.user_id IS NULL
      ORDER BY p.name
    `;

    res.json({ ...request, unlinked_players: unlinkedPlayers });
  } catch (err) { next(err); }
});

// PATCH /api/join-requests/:id — organizador acepta o rechaza
// Body: { action: 'accept' | 'reject', playerId? }
router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const { action } = req.body;
    if (!['accept', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'action debe ser accept o reject' });
    }

    const sql = getDb();

    const [request] = await sql`
      SELECT tjr.*, g.user_id AS owner_id
      FROM tournament_join_requests tjr
      JOIN tournaments t ON t.id = tjr.tournament_id
      JOIN groups g ON g.id = t.group_id
      WHERE tjr.id = ${req.params.id}
    `;
    if (!request) return res.status(404).json({ error: 'Solicitud no encontrada' });
    if (request.status !== 'pending') return res.status(409).json({ error: 'La solicitud ya fue procesada' });
    if (request.owner_id !== req.user.id) return res.status(403).json({ error: 'No autorizado' });

    // El jugador a vincular: el que el organizador elija, o el que pidió el solicitante.
    const playerId = req.body.playerId ?? request.requested_player_id;
    if (action === 'accept' && !playerId) {
      return res.status(400).json({ error: 'playerId requerido para aceptar' });
    }

    if (action === 'accept') {
      const [player] = await sql`
        SELECT p.id, p.user_id FROM players p
        INNER JOIN tournament_players tp ON tp.player_id = p.id AND tp.tournament_id = ${request.tournament_id}
        WHERE p.id = ${playerId}
      `;
      if (!player) return res.status(404).json({ error: 'Jugador no encontrado en el torneo' });
      if (player.user_id) return res.status(409).json({ error: 'El jugador ya está vinculado a una cuenta' });

      // Una cuenta no puede tener dos slots en la misma categoría.
      const [linked] = await sql`
        SELECT p.name
        FROM   players p
        JOIN   group_players gp ON gp.player_id = p.id
        JOIN   tournaments t ON t.group_id = gp.group_id AND t.id = ${request.tournament_id}
        WHERE  p.user_id = ${request.user_id} AND p.id != ${playerId}
        LIMIT  1
      `;
      if (linked) {
        return res.status(409).json({
          error: `Este usuario ya juega en la categoría como "${linked.name}"`,
        });
      }

      const [user] = await sql`SELECT name FROM users WHERE id = ${request.user_id}`;

      await sql`
        UPDATE players SET user_id = ${request.user_id}, name = ${user.name},
               original_name = COALESCE(original_name, name)
        WHERE id = ${playerId}
      `;
    }

    const [updated] = await sql`
      UPDATE tournament_join_requests
      SET status   = ${action === 'accept' ? 'accepted' : 'rejected'},
          player_id = ${action === 'accept' ? playerId : null}
      WHERE id = ${req.params.id}
      RETURNING *
    `;

    res.json(updated);
  } catch (err) { next(err); }
});

export default router;
