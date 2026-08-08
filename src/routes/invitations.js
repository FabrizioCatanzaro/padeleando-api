import { Router } from 'express';
import { randomBytes, createHash } from 'crypto';
import { getDb }  from '../db.js';
import { uid }    from '../uid.js';
import { requireAuth } from '../middleware/auth.js';
import { canManageGroup } from '../lib/access.js';

const router = Router();

const genToken  = () => randomBytes(24).toString('hex');
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const linkUrl   = (token) => `${process.env.FRONTEND_URL ?? ''}/invitacion/${token}`;

// POST /api/invitations
// Invita a alguien a reclamar un slot de jugador de la categoría.
// Body: { playerId, groupId, identifier } — @username o email
//    o: { playerId, groupId, link: true } — devuelve una URL para compartir,
//       pensada para quien todavía no tiene cuenta.
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { playerId, groupId, identifier, link } = req.body;
    if (!playerId)    return res.status(400).json({ error: 'playerId requerido' });
    if (!groupId)     return res.status(400).json({ error: 'groupId requerido' });
    if (!link && !identifier?.trim()) return res.status(400).json({ error: 'identifier requerido' });

    const sql = getDb();

    // Este endpoint sólo tenía requireAuth: cualquier usuario logueado podía
    // invitar a un slot de una categoría ajena. Además, ahora que responde si la
    // cuenta existe, sin este control sería un buscador de usuarios y mails.
    if (!(await canManageGroup(sql, req.user.id, groupId))) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    // Verificar que el jugador existe en el grupo
    const [gp] = await sql`
      SELECT * FROM group_players WHERE group_id = ${groupId} AND player_id = ${playerId}
    `;
    if (!gp) return res.status(404).json({ error: 'Jugador no encontrado en este grupo' });

    // Verificar que el jugador no tiene ya un user_id vinculado
    const [player] = await sql`SELECT * FROM players WHERE id = ${playerId}`;
    if (player?.user_id) {
      return res.status(409).json({ error: 'Este jugador ya está vinculado a una cuenta' });
    }

    // ── Invitación por link: no hay a quién buscar ──────────────────────────
    // Es el camino para quien todavía no tiene cuenta. El token plano se
    // devuelve una sola vez; en la base queda sólo el hash.
    if (link) {
      const [existingLink] = await sql`
        SELECT id FROM player_invitations WHERE player_id = ${playerId} AND status = 'pending'
      `;
      if (existingLink) return res.status(409).json({ error: 'Ya hay una invitación pendiente para este jugador' });

      const token = genToken();
      const [invitation] = await sql`
        INSERT INTO player_invitations (id, player_id, group_id, invited_by, token_hash)
        VALUES (${uid()}, ${playerId}, ${groupId}, ${req.user.id}, ${hashToken(token)})
        RETURNING id
      `;
      return res.status(201).json({ invitation, url: linkUrl(token) });
    }

    // ── Invitación directa por @usuario o email ─────────────────────────────
    // Se acepta sin arroba porque olvidarla es lo normal: si no parece un mail,
    // se busca como nombre de usuario.
    const raw = identifier.trim();
    const lookup = raw.replace(/^@/, '');
    const pareceEmail = lookup.includes('@');

    let [invitedUser] = pareceEmail
      ? await sql`SELECT id, name, username FROM users WHERE LOWER(email) = LOWER(${lookup})`
      : await sql`SELECT id, name, username FROM users WHERE LOWER(username) = LOWER(${lookup})`;

    // Antes se guardaba igual sin decir si existía, para no filtrar quién tiene
    // cuenta. La invitación quedaba muerta: nadie la recibía nunca. Ahora se
    // rechaza, y el filtrado no importa porque sólo llega hasta acá quien puede
    // gestionar la categoría.
    if (!invitedUser) {
      return res.status(404).json({
        error: pareceEmail
          ? 'No hay ninguna cuenta con ese mail. Si todavía no se registró, generá un link de invitación.'
          : `No existe el usuario @${lookup}. Revisá cómo se escribe, o generá un link de invitación.`,
      });
    }

    // Una cuenta no puede tener dos slots en la misma categoría.
    if (invitedUser?.id) {
      const [linked] = await sql`
        SELECT p.name
        FROM   players p
        JOIN   group_players gp ON gp.player_id = p.id
        WHERE  gp.group_id = ${groupId} AND p.user_id = ${invitedUser.id}
        LIMIT  1
      `;
      if (linked) {
        return res.status(409).json({
          error: `@${invitedUser.username} ya juega en esta categoría como "${linked.name}"`,
        });
      }
    }

    // Verificar que no hay invitación pendiente duplicada
    const [existing] = await sql`
      SELECT id FROM player_invitations
      WHERE player_id = ${playerId} AND status = 'pending'
    `;
    if (existing) {
      return res.status(409).json({ error: 'Ya hay una invitación pendiente para este jugador' });
    }

    // Auto-aceptar: si el usuario ya aceptó antes una invitación en esta misma categoría,
    // significa que ya jugó con este organizador acá → no hace falta que confirme de nuevo.
    const [prior] = await sql`
      SELECT 1 FROM player_invitations
      WHERE group_id = ${groupId} AND invited_user_id = ${invitedUser.id} AND status = 'accepted'
      LIMIT 1
    `;
    const autoAccept = !!prior;

    const [invitation] = await sql`
      INSERT INTO player_invitations
        (id, player_id, group_id, invited_by, invited_identifier, invited_user_id, status)
      VALUES
        (${uid()}, ${playerId}, ${groupId}, ${req.user.id}, ${raw}, ${invitedUser.id},
         ${autoAccept ? 'accepted' : 'pending'})
      RETURNING *
    `;

    // Si se auto-acepta, vincular el slot de jugador a la cuenta al instante
    if (autoAccept) {
      await sql`
        UPDATE players SET user_id = ${invitedUser.id}, name = ${invitedUser.name},
               original_name = COALESCE(original_name, name)
        WHERE id = ${invitation.player_id}
      `;
    }

    await sql`
      INSERT INTO notifications (id, user_id, type, actor_id, entity_id)
      VALUES (${uid()}, ${invitedUser.id}, 'invitation', ${req.user.id}, ${invitation.id})
    `;

    res.status(201).json({
      invitation,
      found: true,
      autoAccepted: autoAccept,
      invited: { name: invitedUser.name, username: invitedUser.username },
    });
  } catch (err) { next(err); }
});

// GET /api/invitations — invitaciones pendientes del usuario autenticado
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const invitations = await sql`
      SELECT
        pi.id,
        pi.status,
        pi.invited_identifier,
        pi.created_at,
        p.id   AS player_id,
        p.name AS player_name,
        g.id   AS group_id,
        g.name AS group_name,
        u.name AS invited_by_name,
        u.username AS invited_by_username
      FROM player_invitations pi
      JOIN players p ON p.id = pi.player_id
      JOIN groups  g ON g.id = pi.group_id
      JOIN users   u ON u.id = pi.invited_by
      WHERE pi.invited_user_id = ${req.user.id}
        AND pi.status = 'pending'
      ORDER BY pi.created_at DESC
    `;
    res.json(invitations);
  } catch (err) { next(err); }
});

// GET /api/invitations/count — cantidad de invitaciones pendientes (para el badge del header)
router.get('/count', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count
      FROM player_invitations
      WHERE invited_user_id = ${req.user.id} AND status = 'pending'
    `;
    res.json({ count });
  } catch (err) { next(err); }
});

// PATCH /api/invitations/:id — aceptar o rechazar
// Body: { action: 'accept' | 'reject' }
router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { action } = req.body;
    if (!['accept', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'action debe ser accept o reject' });
    }

    const sql = getDb();

    // Verificar que la invitación pertenece al usuario
    const [invitation] = await sql`
      SELECT * FROM player_invitations WHERE id = ${id}
    `;
    if (!invitation) return res.status(404).json({ error: 'Invitación no encontrada' });
    if (invitation.invited_user_id !== req.user.id) {
      return res.status(403).json({ error: 'No autorizado' });
    }
    if (invitation.status !== 'pending') {
      return res.status(409).json({ error: 'La invitación ya fue procesada' });
    }

    if (action === 'accept') {
      // Una cuenta no puede tener dos slots en la misma categoría: la invitación
      // pudo crearse antes de que el usuario se vinculara a otro slot.
      const [linked] = await sql`
        SELECT p.name
        FROM   players p
        JOIN   group_players gp ON gp.player_id = p.id
        WHERE  gp.group_id = ${invitation.group_id}
          AND  p.user_id = ${req.user.id}
          AND  p.id != ${invitation.player_id}
        LIMIT  1
      `;
      if (linked) {
        return res.status(409).json({
          error: `Ya jugás en esta categoría como "${linked.name}"`,
        });
      }

      await sql`
        UPDATE players SET user_id = ${req.user.id}, name = ${req.user.name},
               original_name = COALESCE(original_name, name)
        WHERE id = ${invitation.player_id}
      `;
    }

    const [updated] = await sql`
      UPDATE player_invitations
      SET status = ${action === 'accept' ? 'accepted' : 'rejected'}
      WHERE id = ${id}
      RETURNING *
    `;

    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /api/invitations/:id — cancelar invitación (solo el que la envió)
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const [invitation] = await sql`SELECT * FROM player_invitations WHERE id = ${req.params.id}`;
    if (!invitation) return res.status(404).json({ error: 'Invitación no encontrada' });
    // Cualquiera que gestione la categoría puede cancelarla, no sólo quien la
    // mandó: si no, un co-organizador no podía deshacer el error del dueño.
    if (invitation.invited_by !== req.user.id
        && !(await canManageGroup(sql, req.user.id, invitation.group_id))) {
      return res.status(403).json({ error: 'No autorizado' });
    }
    await sql`DELETE FROM player_invitations WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
