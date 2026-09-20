import { Router } from 'express';
import { getDb } from '../db.js';
import { uid } from '../uid.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// "Mis reservas" cruza todos los clubes: router propio en /api/bookings

// Duplicados de routes/clubs.js: son helpers de 2 líneas
function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function minutesToTime(mins) {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// GET /api/bookings/mine: todas las reservas del usuario, sin límite de fecha
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const bookings = await sql`
      SELECT b.id, b.group_id, b.club_id, c.name AS club_name, c.photo_url AS club_photo_url,
             b.court_id, cc.name AS court_name, b.date, b.start_time, b.duration_minutes,
             b.price, b.status, b.guest_name, b.guest_contact,
             b.decision_reason, b.decided_at, b.created_at
      FROM bookings b
      JOIN clubs c ON c.id = b.club_id
      LEFT JOIN club_courts cc ON cc.id = b.court_id
      WHERE b.user_id = ${req.user.id}
      ORDER BY b.date DESC, b.start_time DESC
    `;
    res.json(bookings);
  } catch (err) { next(err); }
});

// PATCH /api/bookings/mine/:groupId: el jugador cancela la suya; el motivo es opcional
router.patch('/mine/:groupId', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const rows = await sql`
      SELECT b.id, b.status, b.club_id, b.court_id, b.date, b.start_time, b.duration_minutes, b.user_id,
             c.owner_id, cc.name AS court_name
      FROM bookings b
      JOIN clubs c ON c.id = b.club_id
      LEFT JOIN club_courts cc ON cc.id = b.court_id
      WHERE b.group_id = ${req.params.groupId}
      ORDER BY b.start_time
    `;
    if (!rows.length) return res.status(404).json({ error: 'Reserva no encontrada' });
    if (rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Sin permiso' });
    if (rows[0].status === 'rejected') return res.status(400).json({ error: 'Esta reserva ya está cancelada' });

    const decision_reason = req.body?.decision_reason?.trim() || 'Cancelada por quien reservó.';

    await sql`
      UPDATE bookings
      SET status = 'rejected', decision_reason = ${decision_reason}, decided_at = NOW()
      WHERE group_id = ${req.params.groupId}
    `;

    // Avisar al dueño, o a los admins si no hay dueño; best-effort
    try {
      const lastRow = rows[rows.length - 1];
      const endTime = minutesToTime(timeToMinutes(lastRow.start_time.slice(0, 5)) + lastRow.duration_minutes);
      const courtLabel = rows[0].court_name ? ` en ${rows[0].court_name}` : '';
      const when = `${rows[0].date} de ${rows[0].start_time.slice(0, 5)} a ${endTime} hs`;
      const body = `Se canceló una reserva${courtLabel} del ${when}.`;
      const clubId = rows[0].club_id;
      if (rows[0].owner_id) {
        await sql`
          INSERT INTO notifications (id, user_id, type, actor_id, entity_id, body)
          VALUES (${uid()}, ${rows[0].owner_id}, 'booking_cancelled', ${req.user.id}, ${clubId}, ${body})
        `;
      } else {
        const admins = await sql`SELECT id FROM users WHERE role = 'admin'`;
        for (const admin of admins) {
          if (admin.id === req.user.id) continue;
          await sql`
            INSERT INTO notifications (id, user_id, type, actor_id, entity_id, body)
            VALUES (${uid()}, ${admin.id}, 'booking_cancelled', ${req.user.id}, ${clubId}, ${body})
          `;
        }
      }
    } catch (notifyErr) {
      console.error('No se pudo notificar la cancelación del jugador:', notifyErr.message);
    }

    res.json({ group_id: req.params.groupId, status: 'rejected', decision_reason });
  } catch (err) { next(err); }
});

export default router;
