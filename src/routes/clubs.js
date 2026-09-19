import { Router } from 'express';
import { getDb, withTransaction } from '../db.js';
import { uid }    from '../uid.js';
import { requireAuth, requireAdmin, optionalAuth } from '../middleware/auth.js';
import { requireClubManage, requireClubBookingManage } from '../middleware/access.js';
import { uploadClubPhoto, uploadClubHeader, uploadClubClaimPhotos } from '../middleware/upload.js';
import { uploadBuffer, deleteByPublicId } from '../lib/cloudinary.js';
import { countBracketPlayed } from '../lib/profileStats.js';

const router = Router();

// Normaliza los campos editables de un club desde el body (alta o solicitud).
function clubFields(body = {}) {
  const social = Array.isArray(body.social_links) ? body.social_links : [];
  const schedule = Array.isArray(body.schedule) ? body.schedule : [];
  const courts = body.courts == null || body.courts === ''
    ? null
    : Math.max(0, parseInt(body.courts, 10) || 0);
  // Duración del turno (Fase 4): fija en 30 min para TODOS los clubes, ya no
  // la elige el dueño (decisión de Fabri, 2026-09-13) -- lo que mande el body
  // en `slot_minutes` se ignora a propósito, para que nadie pueda cambiarla
  // pegándole directo a la API.
  const slotMinutes = 30;
  return {
    social_links:     social,
    schedule,
    contact_phone:    body.contact_phone?.trim()    || null,
    contact_whatsapp: body.contact_whatsapp?.trim() || null,
    location_name:    body.location_name?.trim()    || null,
    lat:              body.lat ?? null,
    lon:              body.lon ?? null,
    courts,
    slot_minutes:     slotMinutes,
  };
}

// ── GET /api/clubs ───────────────────────────────────────────────────────────
// Listado/búsqueda público. Query params: q (string), limit (default 50, máx 100)
router.get('/', async (req, res, next) => {
  try {
    const sql   = getDb();
    const q     = (req.query.q ?? '').trim();
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? '50', 10) || 50));
    const pat   = q ? `%${q}%` : null;

    const clubs = await sql`
      SELECT id, name, photo_url, social_links, contact_phone, contact_whatsapp,
      location_name, lat, lon, courts, schedule, created_at
      FROM clubs
      WHERE ${pat}::text IS NULL OR name ILIKE ${pat} OR location_name ILIKE ${pat}
      ORDER BY name ASC
      LIMIT ${limit}
    `;
    res.json(clubs);
  } catch (err) { next(err); }
});

// ── GET /api/clubs/requests ──────────────────────────────────────────────────
// Solicitudes de alta de club (solo admin). Query param: status (default 'pending')
router.get('/requests', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const sql    = getDb();
    const status = req.query.status ?? 'pending';
    const rows = await sql`
      SELECT
        r.id, r.name, r.proposed_data, r.previous_data, r.status, r.created_at, r.reviewed_at,
        r.created_club_id, r.club_id, cl.name AS club_name,
        CASE WHEN cl.id IS NOT NULL THEN jsonb_build_object(
          'name',             cl.name,
          'location_name',    cl.location_name,
          'contact_phone',    cl.contact_phone,
          'contact_whatsapp', cl.contact_whatsapp,
          'courts',           cl.courts,
          'social_links',     cl.social_links,
          'schedule',         cl.schedule
        ) END AS current_data,
        u.id AS requester_id, u.name AS requester_name, u.username AS requester_username,
        u.avatar_url AS requester_avatar_url
      FROM club_requests r
      JOIN users u ON u.id = r.requested_by
      LEFT JOIN clubs cl ON cl.id = r.club_id
      WHERE ${status} = 'all' OR r.status = ${status}
      ORDER BY r.created_at DESC
    `;
    res.json(rows);
  } catch (err) { next(err); }
});

// ── POST /api/clubs/requests ─────────────────────────────────────────────────
// Un usuario logueado solicita el alta de un club que no encuentra.
router.post('/requests', requireAuth, async (req, res, next) => {
  try {
    const name = req.body?.name?.trim();
    if (!name)             return res.status(400).json({ error: 'El nombre del club es requerido' });
    if (name.length < 2)   return res.status(400).json({ error: 'El nombre del club debe tener más de 2 caracteres' });
    if (name.length > 80)  return res.status(400).json({ error: 'El nombre del club no puede superar los 80 caracteres' });

    const sql = getDb();
    const clubId = req.body?.club_id ?? null;
    let previous = null;
    if (clubId) {
      const [existing] = await sql`
        SELECT name, location_name, contact_phone, contact_whatsapp, courts, social_links, schedule
        FROM clubs WHERE id = ${clubId}
      `;
      if (!existing) return res.status(404).json({ error: 'Club no encontrado' });
      previous = existing;
    }
    const proposed = clubFields(req.body);
    const [request] = await sql`
      INSERT INTO club_requests (id, requested_by, name, proposed_data, club_id, previous_data)
      VALUES (${uid()}, ${req.user.id}, ${name}, ${JSON.stringify(proposed)}::jsonb, ${clubId},
              ${previous ? JSON.stringify(previous) : null}::jsonb)
      RETURNING id, name, proposed_data, status, created_at, club_id
    `;

    // Notificar a los admins (best-effort: no romper la solicitud si falla).
    try {
      const admins = await sql`SELECT id FROM users WHERE role = 'admin'`;
      const body = clubId
        ? `solicitó cambios para el club "${name}"`
        : `solicitó agregar el club "${name}"`;
      for (const admin of admins) {
        if (admin.id === req.user.id) continue;
        await sql`
          INSERT INTO notifications (id, user_id, type, actor_id, entity_id, body)
          VALUES (${uid()}, ${admin.id}, 'club_request', ${req.user.id}, ${request.id}, ${body})
        `;
      }
    } catch (notifyErr) {
      console.error('No se pudo notificar a los admins de la solicitud de club:', notifyErr.message);
    }

    res.status(201).json(request);
  } catch (err) { next(err); }
});

// ── PATCH /api/clubs/requests/:id ────────────────────────────────────────────
// Admin aprueba (crea el club precargado) o rechaza una solicitud.
// Body: { action: 'approve' | 'reject' }
router.patch('/requests/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const sql    = getDb();
    const action = req.body?.action;
    if (!['approve', 'reject'].includes(action))
      return res.status(400).json({ error: "action debe ser 'approve' o 'reject'" });

    const [request] = await sql`SELECT * FROM club_requests WHERE id = ${req.params.id}`;
    if (!request) return res.status(404).json({ error: 'Solicitud no encontrada' });
    if (request.status !== 'pending')
      return res.status(400).json({ error: 'La solicitud ya fue procesada' });

    if (action === 'reject') {
      const [updated] = await sql`
        UPDATE club_requests
        SET status = 'rejected', reviewed_by = ${req.user.id}, reviewed_at = NOW()
        WHERE id = ${request.id}
        RETURNING id, status
      `;

      // Avisarle a quien pidió el cambio (best-effort: no romper el rechazo si falla).
      try {
        await sql`
          INSERT INTO notifications (id, user_id, type, actor_id, entity_id, body)
          VALUES (${uid()}, ${request.requested_by}, 'club_request', ${req.user.id}, ${request.id},
                  ${`Tu solicitud para "${request.name}" fue rechazada`})
        `;
      } catch (notifyErr) {
        console.error('No se pudo notificar el rechazo de la solicitud de club:', notifyErr.message);
      }

      return res.json(updated);
    }

    // approve → aplicar los datos propuestos
    const f = clubFields(request.proposed_data ?? {});

    // Override de ubicación: si el admin reubicó el pin al aprobar, pisa lat/lon
    // (y la dirección) de la solicitud con las coordenadas verificadas.
    const ovLat = Number(req.body?.lat);
    const ovLon = Number(req.body?.lon);
    if (Number.isFinite(ovLat) && Number.isFinite(ovLon)) {
      f.lat = ovLat;
      f.lon = ovLon;
      if (typeof req.body?.location_name === 'string' && req.body.location_name.trim())
        f.location_name = req.body.location_name.trim();
    }
    let club;
    if (request.club_id) {
      // Solicitud de edición: actualizar el club existente.
      [club] = await sql`
        UPDATE clubs SET
          name             = ${request.name},
          social_links     = ${JSON.stringify(f.social_links)}::jsonb,
          contact_phone    = ${f.contact_phone},
          contact_whatsapp = ${f.contact_whatsapp},
          location_name    = ${f.location_name},
          lat              = ${f.lat},
          lon              = ${f.lon},
          courts           = ${f.courts},
          slot_minutes     = ${f.slot_minutes},
          schedule         = ${JSON.stringify(f.schedule)}::jsonb
        WHERE id = ${request.club_id}
        RETURNING id, name, photo_url, social_links, contact_phone, contact_whatsapp,
        location_name, lat, lon, courts, slot_minutes, schedule, created_at
      `;
      if (!club) return res.status(404).json({ error: 'El club a editar ya no existe' });
    } else {
      // Solicitud de alta: crear un club nuevo.
      [club] = await sql`
        INSERT INTO clubs (
          id, name, social_links, contact_phone, contact_whatsapp,
          location_name, lat, lon, courts, schedule, slot_minutes
        ) VALUES (
          ${uid()}, ${request.name},
          ${JSON.stringify(f.social_links)}::jsonb, ${f.contact_phone}, ${f.contact_whatsapp},
          ${f.location_name}, ${f.lat}, ${f.lon}, ${f.courts}, ${JSON.stringify(f.schedule)}::jsonb, ${f.slot_minutes}
        )
        RETURNING id, name, photo_url, social_links, contact_phone, contact_whatsapp,
        location_name, lat, lon, courts, slot_minutes, schedule, created_at
      `;
      // Backfill: categorías y torneos que esperaban este club quedan vinculados.
      await sql`
        UPDATE groups SET club_id = ${club.id}, pending_club_request_id = NULL
        WHERE pending_club_request_id = ${request.id}
      `;
      await sql`
        UPDATE tournaments SET club_id = ${club.id}, pending_club_request_id = NULL
        WHERE pending_club_request_id = ${request.id}
      `;
    }
    await sql`
      UPDATE club_requests
      SET status = 'approved', reviewed_by = ${req.user.id}, reviewed_at = NOW(),
          created_club_id = ${club.id}
      WHERE id = ${request.id}
    `;

    // Avisarle a quien pidió el cambio (best-effort: no romper la aprobación si falla).
    try {
      const body = request.club_id
        ? `Tus cambios para "${club.name}" fueron aprobados`
        : `Tu club "${club.name}" fue aprobado y ya está en Padeleando`;
      await sql`
        INSERT INTO notifications (id, user_id, type, actor_id, entity_id, body)
        VALUES (${uid()}, ${request.requested_by}, 'club_request', ${req.user.id}, ${request.id}, ${body})
      `;
    } catch (notifyErr) {
      console.error('No se pudo notificar la aprobación de la solicitud de club:', notifyErr.message);
    }

    res.json({ status: 'approved', club });
  } catch (err) { next(err); }
});

// ── GET /api/clubs/claims ────────────────────────────────────────────────────
// Reclamos de propiedad de club (solo admin). Query param: status (default 'pending')
router.get('/claims', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const sql    = getDb();
    const status = req.query.status ?? 'pending';
    const rows = await sql`
      SELECT
        c.id, c.club_id, c.full_name, c.phone, c.relationship, c.note,
        c.photo_front_url, c.photo_proof_url, c.photo_social_url,
        c.status, c.rejection_reason, c.created_at, c.reviewed_at,
        cl.name AS club_name,
        u.id AS requester_id, u.name AS requester_name, u.username AS requester_username,
        u.avatar_url AS requester_avatar_url
      FROM club_claims c
      JOIN users u  ON u.id  = c.requested_by
      JOIN clubs cl ON cl.id = c.club_id
      WHERE ${status} = 'all' OR c.status = ${status}
      ORDER BY c.created_at DESC
    `;
    res.json(rows);
  } catch (err) { next(err); }
});

// ── PATCH /api/clubs/claims/:id ──────────────────────────────────────────────
// Admin aprueba (setea clubs.owner_id) o rechaza -- con motivo obligatorio -- un reclamo.
// Body: { action: 'approve' | 'reject', rejection_reason?: string }
router.patch('/claims/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const sql    = getDb();
    const action = req.body?.action;
    if (!['approve', 'reject'].includes(action))
      return res.status(400).json({ error: "action debe ser 'approve' o 'reject'" });

    const [claim] = await sql`SELECT * FROM club_claims WHERE id = ${req.params.id}`;
    if (!claim) return res.status(404).json({ error: 'Reclamo no encontrado' });
    if (claim.status !== 'pending')
      return res.status(400).json({ error: 'El reclamo ya fue procesado' });

    if (action === 'reject') {
      const reason = req.body?.rejection_reason?.trim();
      if (!reason) return res.status(400).json({ error: 'Contale al reclamante por qué se rechaza' });

      const [updated] = await sql`
        UPDATE club_claims
        SET status = 'rejected', rejection_reason = ${reason},
            reviewed_by = ${req.user.id}, reviewed_at = NOW()
        WHERE id = ${claim.id}
        RETURNING id, status, rejection_reason
      `;

      const [club] = await sql`SELECT name FROM clubs WHERE id = ${claim.club_id}`;
      await sql`
        INSERT INTO notifications (id, user_id, type, actor_id, entity_id, body)
        VALUES (${uid()}, ${claim.requested_by}, 'club_claim', ${req.user.id}, ${claim.id},
                ${`Tu reclamo del club "${club?.name ?? ''}" fue rechazado: ${reason}`})
      `;

      return res.json(updated);
    }

    // approve → este usuario pasa a ser el dueño verificado del club. El WHERE
    // owner_id IS NULL evita pisar un dueño si dos reclamos del mismo club se
    // aprobaran en carrera (el índice único ya bloquea el segundo pendiente,
    // esto es la segunda red de seguridad).
    const [club] = await sql`
      UPDATE clubs SET owner_id = ${claim.requested_by}
      WHERE id = ${claim.club_id} AND owner_id IS NULL
      RETURNING id, name
    `;
    if (!club) return res.status(400).json({ error: 'El club ya tiene un dueño verificado' });

    await sql`
      UPDATE club_claims
      SET status = 'approved', reviewed_by = ${req.user.id}, reviewed_at = NOW()
      WHERE id = ${claim.id}
    `;

    await sql`
      INSERT INTO notifications (id, user_id, type, actor_id, entity_id, body)
      VALUES (${uid()}, ${claim.requested_by}, 'club_claim', ${req.user.id}, ${claim.id},
              ${`Ya sos el dueño verificado de "${club.name}"`})
    `;

    res.json({ status: 'approved', club });
  } catch (err) { next(err); }
});

// ── GET /api/clubs/nearby?lat=&lon=&radius= ──────────────────────────────────
// Clubes con ubicación cercana (Haversine, radio en km, máx 100).
router.get('/nearby', async (req, res, next) => {
  try {
    const lat    = parseFloat(req.query.lat);
    const lon    = parseFloat(req.query.lon);
    const radius = Math.min(parseFloat(req.query.radius) || 20, 100);
    if (isNaN(lat) || isNaN(lon)) return res.status(400).json({ error: 'lat y lon requeridos' });

    const sql = getDb();
    const clubs = await sql`
      SELECT c.id, c.name, c.photo_url, c.location_name, c.lat, c.lon, c.courts,
             ROUND(
               (6371 * acos(
                 LEAST(1, cos(radians(${lat})) * cos(radians(c.lat)) *
                 cos(radians(c.lon) - radians(${lon})) +
                 sin(radians(${lat})) * sin(radians(c.lat)))
               ))::numeric, 1
             ) AS distance_km
      FROM clubs c
      WHERE c.lat IS NOT NULL
        AND c.lon IS NOT NULL
        AND (6371 * acos(
          LEAST(1, cos(radians(${lat})) * cos(radians(c.lat)) *
          cos(radians(c.lon) - radians(${lon})) +
          sin(radians(${lat})) * sin(radians(c.lat)))
        )) <= ${radius}
      ORDER BY distance_km ASC
      LIMIT 20
    `;
    res.json(clubs);
  } catch (err) { next(err); }
});

// ── GET /api/clubs/:id ───────────────────────────────────────────────────────
router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const sql      = getDb();
    const viewerId = req.user?.id ?? null;
    // Los agregados del riel viajan junto al club: cada await es un viaje propio
    // a la base, y para un id inexistente las dos consultas extra dan vacío, así
    // que el 404 se resuelve igual después. Se cuentan sólo las categorías
    // públicas, igual que la lista de eventos: si no, el riel delataría cuánto
    // se juega en una categoría privada.
    // Las canchas reales (Fase 2) viajan junto al club en la misma tanda:
    // sólo las activas para quien no puede gestionar el club (el dueño/admin
    // ve también las deshabilitadas temporalmente, para poder reactivarlas).
    // Filtrar por gestión exacta requiere saber owner_id, que recién se sabe
    // con `club` resuelto -- se filtra en JS un poco más abajo.
    const [[club], [agg], brackets, courtsList, [pendingBookings]] = await Promise.all([
      sql`
        SELECT c.id, c.name, c.photo_url, c.header_url, c.social_links,
        c.contact_phone, c.contact_whatsapp,
        c.location_name, c.lat, c.lon, c.courts, c.slot_minutes, c.schedule, c.created_at,
        (c.owner_id IS NOT NULL)          AS has_owner,
        COALESCE(c.owner_id = ${viewerId}, false) AS is_owner,
        c.owner_visible,
        CASE WHEN c.owner_visible THEN ou.name        ELSE NULL END AS owner_display_name,
        CASE WHEN c.owner_visible THEN ou.username     ELSE NULL END AS owner_username,
        CASE WHEN c.owner_visible THEN ou.avatar_url    ELSE NULL END AS owner_avatar_url
        FROM clubs c
        LEFT JOIN users ou ON ou.id = c.owner_id
        WHERE c.id = ${req.params.id}
      `,
      sql`
        SELECT
          COUNT(DISTINCT t.id)::int       AS torneos,
          COUNT(DISTINCT t.group_id)::int AS categorias,
          (SELECT COUNT(*)::int
             FROM matches m
             JOIN tournaments mt ON mt.id = m.tournament_id
             JOIN groups mg ON mg.id = mt.group_id AND mg.is_public = true
            WHERE mt.club_id = ${req.params.id})                AS partidos,
          (SELECT COUNT(DISTINCT tp.player_id)::int
             FROM tournament_players tp
             JOIN tournaments pt ON pt.id = tp.tournament_id
             JOIN groups pg ON pg.id = pt.group_id AND pg.is_public = true
            WHERE pt.club_id = ${req.params.id})                AS jugadores
        FROM tournaments t
        JOIN groups g ON g.id = t.group_id AND g.is_public = true
        WHERE t.club_id = ${req.params.id}
      `,
      // El cuadro del americano no vive en `matches`: se cuenta aparte.
      sql`
        SELECT t.bracket
        FROM tournaments t
        JOIN groups g ON g.id = t.group_id AND g.is_public = true
        WHERE t.club_id = ${req.params.id}
          AND t.format = 'americano'
          AND t.bracket IS NOT NULL
      `,
      // Trae TODAS las canchas acá (activas e inactivas): se filtran abajo.
      sql`
        SELECT id, name, floor_type, wall_type, covered, lit, external_play, price_30, price_60, active, sort_order
        FROM club_courts WHERE club_id = ${req.params.id}
        ORDER BY sort_order ASC, created_at ASC
      `,
      // Para el badge de la solapa RESERVAS -- se calcula siempre (es barato,
      // hay índice por club_id+status) y se expone en la respuesta sólo si
      // el que mira puede gestionar reservas de este club (ver más abajo).
      // OJO: cuenta GRUPOS (reservas lógicas), no filas -- una reserva de
      // varios turnos seguidos son varias filas con el mismo group_id, y
      // contar filas hacía que el badge mostrara de más (ej. "3" cuando en
      // realidad había 1 sola reserva pendiente de 3 turnos).
      sql`SELECT COUNT(DISTINCT group_id)::int AS n FROM bookings WHERE club_id = ${req.params.id} AND status = 'pending'`,
    ]);

    if (!club) return res.status(404).json({ error: 'Club no encontrado' });

    const bracketPlayed = brackets.reduce((n, r) => n + countBracketPlayed(r.bracket), 0);
    const isManager = req.user?.role === 'admin' || club.is_owner === true;
    const courts_list = isManager ? courtsList : courtsList.filter((c) => c.active);
    // Más estricto que `isManager` a propósito (ver requireClubBookingManage
    // en access.js): un admin sólo gestiona reservas de un club que TODAVÍA
    // no tiene dueño verificado -- si ya lo tiene, esto es sólo para él.
    const canManageBookings = club.is_owner === true || (req.user?.role === 'admin' && !club.has_owner);

    res.json({
      ...club,
      courts_list,
      can_manage_bookings: canManageBookings,
      pending_bookings_count: canManageBookings ? (pendingBookings?.n ?? 0) : undefined,
      stats: {
        torneos:    agg?.torneos    ?? 0,
        categorias: agg?.categorias ?? 0,
        jugadores:  agg?.jugadores  ?? 0,
        partidos:   (agg?.partidos  ?? 0) + bracketPlayed,
      },
    });
  } catch (err) { next(err); }
});

// ── GET /api/clubs/:id/events ────────────────────────────────────────────────
// Torneos jugados en el club (solo de categorías públicas), agrupados por estado.
router.get('/:id/events', async (req, res, next) => {
  try {
    const sql = getDb();
    const [club] = await sql`SELECT id FROM clubs WHERE id = ${req.params.id}`;
    if (!club) return res.status(404).json({ error: 'Club no encontrado' });

    const rows = await sql`
      SELECT
        t.id, t.name, t.format, t.mode, t.status, t.event_date, t.created_at,
        -- No alcanza con IS NOT NULL: live_match queda en un array vacío cuando
        -- se cierra el último partido, y una jornada terminada conserva el
        -- payload viejo. Misma condición que la consulta live de GET /api/home.
        (t.status <> 'finished'
         AND jsonb_typeof(t.live_match) = 'array'
         AND jsonb_array_length(t.live_match) > 0) AS has_live,
        g.id AS group_id, g.name AS group_name, g.emojis AS group_emojis,
        u.username AS owner_username, u.name AS owner_name, u.avatar_url AS owner_avatar_url,
        (SELECT COUNT(*)::int FROM tournament_players tp WHERE tp.tournament_id = t.id) AS players_count,
        (SELECT COUNT(*)::int FROM matches m WHERE m.tournament_id = t.id) AS match_count
      FROM tournaments t
      JOIN groups g ON g.id = t.group_id
      LEFT JOIN users u ON u.id = g.user_id
      WHERE t.club_id = ${req.params.id} AND g.is_public = true
      ORDER BY COALESCE(t.event_date, t.created_at::date) DESC
    `;

    const events = { upcoming: [], ongoing: [], past: [] };
    for (const t of rows) {
      // Estados: finished / ongoing ('en curso') / upcoming ('próximamente').
      // 'en curso' si hay un partido EN VIVO o ya se jugó algún partido (la fecha no importa).
      if (t.status === 'finished') events.past.push(t);
      else if (t.has_live || (t.match_count ?? 0) > 0) events.ongoing.push(t);
      else events.upcoming.push(t);
    }
    // upcoming en orden cronológico ascendente (lo más próximo primero)
    events.upcoming.reverse();
    res.json(events);
  } catch (err) { next(err); }
});

// ── POST /api/clubs/:id/claim ────────────────────────────────────────────────
// Un usuario logueado reclama ser el dueño de un club sin dueño verificado.
// No es una solicitud de cambio de dato (eso es club_requests): es un reclamo
// de identidad, con 3 fotos obligatorias, que sólo un admin puede resolver.
router.post('/:id/claim', requireAuth, uploadClubClaimPhotos, async (req, res, next) => {
  try {
    const sql = getDb();
    const [club] = await sql`SELECT id, name, owner_id FROM clubs WHERE id = ${req.params.id}`;
    if (!club) return res.status(404).json({ error: 'Club no encontrado' });
    if (club.owner_id) return res.status(400).json({ error: 'Este club ya tiene un dueño verificado' });

    const fullName     = req.body?.full_name?.trim();
    const phone        = req.body?.phone?.trim();
    const relationship = req.body?.relationship?.trim();
    const note          = req.body?.note?.trim() || null;
    if (!fullName)     return res.status(400).json({ error: 'Tu nombre completo es requerido' });
    if (!phone)        return res.status(400).json({ error: 'Un teléfono de contacto es requerido' });
    if (!relationship) return res.status(400).json({ error: 'Contanos tu relación con el club' });

    const files  = req.files ?? {};
    const front  = files.photo_front?.[0];
    const proof  = files.photo_proof?.[0];
    const social = files.photo_social?.[0];
    if (!front || !proof || !social)
      return res.status(400).json({ error: 'Las 3 fotos son obligatorias: frente del club, algo que te vincule a él, y una red social del club' });

    const [existingPending] = await sql`
      SELECT id FROM club_claims WHERE club_id = ${club.id} AND status = 'pending'
    `;
    if (existingPending) return res.status(400).json({ error: 'Ya hay un reclamo pendiente de revisión para este club' });

    const folder = `padeliando/clubs/${club.id}/claims`;
    const [frontUp, proofUp, socialUp] = await Promise.all([
      uploadBuffer(front.buffer,  { folder }),
      uploadBuffer(proof.buffer,  { folder }),
      uploadBuffer(social.buffer, { folder }),
    ]);

    const [claim] = await sql`
      INSERT INTO club_claims (
        id, club_id, requested_by, full_name, phone, relationship, note,
        photo_front_url, photo_proof_url, photo_social_url
      ) VALUES (
        ${uid()}, ${club.id}, ${req.user.id}, ${fullName}, ${phone}, ${relationship}, ${note},
        ${frontUp.secure_url}, ${proofUp.secure_url}, ${socialUp.secure_url}
      )
      RETURNING id, club_id, status, created_at
    `;

    // Notificar a los admins (best-effort: no romper el reclamo si falla).
    try {
      const admins = await sql`SELECT id FROM users WHERE role = 'admin'`;
      for (const admin of admins) {
        if (admin.id === req.user.id) continue;
        await sql`
          INSERT INTO notifications (id, user_id, type, actor_id, entity_id, body)
          VALUES (${uid()}, ${admin.id}, 'club_claim', ${req.user.id}, ${claim.id}, ${`reclamó ser dueño del club "${club.name}"`})
        `;
      }
    } catch (notifyErr) {
      console.error('No se pudo notificar a los admins del reclamo de club:', notifyErr.message);
    }

    res.status(201).json(claim);
  } catch (err) {
    // La unicidad "un solo pendiente por club" puede perderse en carrera con el
    // chequeo de arriba; el índice único la corta igual, sólo hay que traducirla.
    if (err?.code === '23505') return res.status(400).json({ error: 'Ya hay un reclamo pendiente de revisión para este club' });
    next(err);
  }
});

// ── POST /api/clubs ──────────────────────────────────────────────────────────
// Alta de club (solo admin). La foto se sube aparte en POST /:id/photo.
router.post('/', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const name = req.body?.name?.trim();
    if (!name)            return res.status(400).json({ error: 'El nombre del club es requerido' });
    if (name.length < 2)  return res.status(400).json({ error: 'El nombre del club debe tener más de 2 caracteres' });
    if (name.length > 80) return res.status(400).json({ error: 'El nombre del club no puede superar los 80 caracteres' });

    const sql = getDb();
    const f = clubFields(req.body);
    const [club] = await sql`
      INSERT INTO clubs (
        id, name, social_links, contact_phone, contact_whatsapp,
        location_name, lat, lon, courts, schedule, slot_minutes
      ) VALUES (
        ${uid()}, ${name},
        ${JSON.stringify(f.social_links)}::jsonb, ${f.contact_phone}, ${f.contact_whatsapp},
        ${f.location_name}, ${f.lat}, ${f.lon}, ${f.courts}, ${JSON.stringify(f.schedule)}::jsonb, ${f.slot_minutes}
      )
      RETURNING id, name, photo_url, social_links, contact_phone, contact_whatsapp,
      location_name, lat, lon, courts, schedule, slot_minutes, created_at
    `;
    res.status(201).json(club);
  } catch (err) { next(err); }
});

// ── PUT /api/clubs/:id ───────────────────────────────────────────────────────
// El dueño verificado o un admin pueden editar los mismos campos, con una
// excepción: si el que edita NO es admin y toca nombre o ubicación (terreno
// fértil para fraude -- mover el pin, robar el nombre de otro club), ese
// cambio puntual no se aplica al toque -- se manda a la misma cola de
// revisión que ya existe para "solicitar cambios" (club_requests), con el
// resto de los campos (fotos, contacto, horario, canchas, redes) aplicados
// de inmediato como siempre. El admin lo aprueba o rechaza desde la misma
// bandeja de AdminClubRequests, sin pantalla nueva.
router.put('/:id', requireAuth, requireClubManage, async (req, res, next) => {
  try {
    const sql     = getDb();
    const isAdmin = req.accessCtx.is_admin;

    const name = req.body?.name?.trim();
    if (name !== undefined) {
      if (name.length < 2)  return res.status(400).json({ error: 'El nombre del club debe tener más de 2 caracteres' });
      if (name.length > 80) return res.status(400).json({ error: 'El nombre del club no puede superar los 80 caracteres' });
    }

    const f = clubFields(req.body);
    const ownerVisible = typeof req.body?.owner_visible === 'boolean' ? req.body.owner_visible : null;

    const [current] = await sql`
      SELECT name, location_name, lat, lon FROM clubs WHERE id = ${req.params.id}
    `;
    if (!current) return res.status(404).json({ error: 'Club no encontrado' });

    const wantsIdentityChange = !isAdmin && (
      (name !== undefined && name !== current.name) ||
      f.location_name !== current.location_name ||
      f.lat !== current.lat ||
      f.lon !== current.lon
    );

    const [club] = await sql`
      UPDATE clubs SET
        name             = CASE WHEN ${isAdmin}::boolean THEN COALESCE(${name ?? null}, name) ELSE name END,
        social_links     = ${JSON.stringify(f.social_links)}::jsonb,
        schedule         = ${JSON.stringify(f.schedule)}::jsonb,
        contact_phone    = ${f.contact_phone},
        contact_whatsapp = ${f.contact_whatsapp},
        location_name    = CASE WHEN ${isAdmin}::boolean THEN ${f.location_name} ELSE location_name END,
        lat              = CASE WHEN ${isAdmin}::boolean THEN ${f.lat} ELSE lat END,
        lon              = CASE WHEN ${isAdmin}::boolean THEN ${f.lon} ELSE lon END,
        courts           = ${f.courts},
        slot_minutes     = ${f.slot_minutes},
        owner_visible    = COALESCE(${ownerVisible}::boolean, owner_visible)
      WHERE id = ${req.params.id}
      RETURNING id, name, photo_url, header_url, social_links, contact_phone, contact_whatsapp,
      location_name, lat, lon, courts, slot_minutes, schedule, owner_visible, created_at
    `;

    let pendingIdentityRequestId = null;
    if (wantsIdentityChange) {
      // proposed_data es un snapshot COMPLETO, no sólo nombre/ubicación: si
      // sólo mandara los dos campos que cambian, aprobar la solicitud (que
      // aplica proposed_data entero, ver PATCH /requests/:id) borraría el
      // resto de los datos del club. El resto sale del club recién
      // actualizado (`club`, ya con contacto/horario/canchas/redes al día).
      const proposed = {
        social_links:     club.social_links,
        schedule:         club.schedule,
        contact_phone:    club.contact_phone,
        contact_whatsapp: club.contact_whatsapp,
        location_name:    f.location_name,
        lat:              f.lat,
        lon:              f.lon,
        courts:           club.courts,
        slot_minutes:     club.slot_minutes,
      };
      const previous = {
        name:             current.name,
        location_name:    current.location_name,
        contact_phone:    club.contact_phone,
        contact_whatsapp: club.contact_whatsapp,
        courts:           club.courts,
        slot_minutes:     club.slot_minutes,
        social_links:     club.social_links,
        schedule:         club.schedule,
      };
      const requestedName = name !== undefined ? name : club.name;

      // Si ya había una solicitud de identidad pendiente para este club, se
      // actualiza en vez de crear otra -- si no, cada guardado del dueño
      // (mientras la anterior seguía sin revisar) dejaba una fila "pendiente"
      // nueva; el admin sólo veía/aprobaba una y las demás quedaban
      // huérfanas, pendientes para siempre (esto es lo que reportó Fabri: la
      // solicitud "seguía pendiente" después de aprobar/rechazar -- en
      // realidad había otra fila pendiente distinta para el mismo club). El
      // índice único uq_club_requests_one_pending_edit en schema.sql blinda
      // lo mismo a nivel DB por si dos guardados pisan esto en simultáneo.
      // previous_data NO se toca en el update: sigue siendo el estado de
      // ANTES de la primera solicitud de esta tanda, no de la última edición.
      const [existing] = await sql`
        SELECT id FROM club_requests WHERE club_id = ${club.id} AND status = 'pending'
      `;

      let requestId = null;
      let isNewRequest = false;
      if (existing) {
        await sql`
          UPDATE club_requests
          SET name = ${requestedName}, proposed_data = ${JSON.stringify(proposed)}::jsonb, created_at = NOW()
          WHERE id = ${existing.id}
        `;
        requestId = existing.id;
      } else {
        try {
          const [request] = await sql`
            INSERT INTO club_requests (id, requested_by, name, proposed_data, club_id, previous_data)
            VALUES (${uid()}, ${req.user.id}, ${requestedName}, ${JSON.stringify(proposed)}::jsonb, ${club.id},
                    ${JSON.stringify(previous)}::jsonb)
            RETURNING id
          `;
          requestId = request.id;
          isNewRequest = true;
        } catch (insertErr) {
          if (insertErr.code === '23505') {
            // Carrera: otro guardado insertó la pendiente entre el SELECT y el INSERT -- se reusa esa.
            const [raced] = await sql`
              UPDATE club_requests
              SET name = ${requestedName}, proposed_data = ${JSON.stringify(proposed)}::jsonb, created_at = NOW()
              WHERE club_id = ${club.id} AND status = 'pending'
              RETURNING id
            `;
            requestId = raced?.id ?? null;
          } else {
            throw insertErr;
          }
        }
      }
      pendingIdentityRequestId = requestId;

      // Sólo se notifica a los admins cuando es una solicitud nueva -- si el
      // dueño guarda varias veces mientras sigue pendiente, no hace falta
      // mandarles una notificación por cada guardado.
      if (isNewRequest && requestId) {
        try {
          const admins = await sql`SELECT id FROM users WHERE role = 'admin'`;
          const body = `pidió cambiar el nombre o la ubicación de "${club.name}"`;
          for (const admin of admins) {
            if (admin.id === req.user.id) continue;
            await sql`
              INSERT INTO notifications (id, user_id, type, actor_id, entity_id, body)
              VALUES (${uid()}, ${admin.id}, 'club_request', ${req.user.id}, ${requestId}, ${body})
            `;
          }
        } catch (notifyErr) {
          console.error('No se pudo notificar a los admins del pedido de cambio de identidad:', notifyErr.message);
        }
      }
    }

    res.json({ ...club, pending_identity_request: !!pendingIdentityRequestId });
  } catch (err) { next(err); }
});

// ── POST /api/clubs/:id/photo ────────────────────────────────────────────────
router.post('/:id/photo', requireAuth, requireClubManage, uploadClubPhoto, async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se envió imagen' });
    const sql = getDb();
    const [club] = await sql`SELECT id, photo_public_id FROM clubs WHERE id = ${req.params.id}`;
    if (!club) return res.status(404).json({ error: 'Club no encontrado' });

    const result = await uploadBuffer(req.file.buffer, { folder: `padeliando/clubs/${club.id}` });
    if (club.photo_public_id) await deleteByPublicId(club.photo_public_id);

    const [updated] = await sql`
      UPDATE clubs SET photo_url = ${result.secure_url}, photo_public_id = ${result.public_id}
      WHERE id = ${club.id}
      RETURNING id, name, photo_url, social_links, contact_phone, contact_whatsapp,
      location_name, lat, lon, courts, schedule, created_at
    `;
    res.json(updated);
  } catch (err) { next(err); }
});

// ── DELETE /api/clubs/:id/photo ──────────────────────────────────────────────
router.delete('/:id/photo', requireAuth, requireClubManage, async (req, res, next) => {
  try {
    const sql = getDb();
    const [club] = await sql`SELECT id, photo_public_id FROM clubs WHERE id = ${req.params.id}`;
    if (!club) return res.status(404).json({ error: 'Club no encontrado' });

    if (club.photo_public_id) await deleteByPublicId(club.photo_public_id);
    const [updated] = await sql`
      UPDATE clubs SET photo_url = NULL, photo_public_id = NULL
      WHERE id = ${club.id}
      RETURNING id, name, photo_url, social_links, contact_phone, contact_whatsapp,
      location_name, lat, lon, courts, schedule, created_at
    `;
    res.json(updated);
  } catch (err) { next(err); }
});

// ── POST /api/clubs/:id/header ───────────────────────────────────────────────
// Imagen de cabecera propia del club (antes la ficha pública usaba siempre la
// misma foto de cancha genérica). Mismo dueño/admin que la foto de perfil.
router.post('/:id/header', requireAuth, requireClubManage, uploadClubHeader, async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se envió imagen' });
    const sql = getDb();
    const [club] = await sql`SELECT id, header_public_id FROM clubs WHERE id = ${req.params.id}`;
    if (!club) return res.status(404).json({ error: 'Club no encontrado' });

    const result = await uploadBuffer(req.file.buffer, { folder: `padeliando/clubs/${club.id}/header` });
    if (club.header_public_id) await deleteByPublicId(club.header_public_id);

    const [updated] = await sql`
      UPDATE clubs SET header_url = ${result.secure_url}, header_public_id = ${result.public_id}
      WHERE id = ${club.id}
      RETURNING id, name, photo_url, header_url, social_links, contact_phone, contact_whatsapp,
      location_name, lat, lon, courts, schedule, owner_visible, created_at
    `;
    res.json(updated);
  } catch (err) { next(err); }
});

// ── DELETE /api/clubs/:id/header ─────────────────────────────────────────────
router.delete('/:id/header', requireAuth, requireClubManage, async (req, res, next) => {
  try {
    const sql = getDb();
    const [club] = await sql`SELECT id, header_public_id FROM clubs WHERE id = ${req.params.id}`;
    if (!club) return res.status(404).json({ error: 'Club no encontrado' });

    if (club.header_public_id) await deleteByPublicId(club.header_public_id);
    const [updated] = await sql`
      UPDATE clubs SET header_url = NULL, header_public_id = NULL
      WHERE id = ${club.id}
      RETURNING id, name, photo_url, header_url, social_links, contact_phone, contact_whatsapp,
      location_name, lat, lon, courts, schedule, owner_visible, created_at
    `;
    res.json(updated);
  } catch (err) { next(err); }
});

// ── Canchas del club (Fase 2 de "reservas de cancha") ────────────────────────
// Entidades reales, una por cancha física -- antes `clubs.courts` era sólo un
// número. La disponibilidad semanal sigue siendo la del club entero
// (`clubs.schedule`) y la duración del turno (`clubs.slot_minutes`) también
// es una sola para todo el club, no por cancha (decisiones cerradas con
// Fabri): estas rutas sólo gestionan el ABM de las canchas en sí.
const COURT_FLOOR_TYPES = ['cesped_sintetico', 'cesped_natural', 'cemento'];
const COURT_WALL_TYPES  = ['cemento', 'cristal'];

// Precio de una cancha: ya no es un solo número por turno (Fase 4) sino dos --
// uno para un turno de 30 min y otro para uno de 60 -- porque el de 60 no
// necesariamente es el doble del de 30 (el dueño puede tener un combo). Cada
// uno se valida y se guarda por separado; cualquiera de los dos puede quedar
// en null ("a consultar" para esa duración puntual).
function parsePrice(v) {
  return v === '' || v == null || Number.isNaN(Number(v)) ? null : Math.max(0, Number(v));
}

function courtFields(body = {}) {
  const floor_type = COURT_FLOOR_TYPES.includes(body.floor_type) ? body.floor_type : null;
  const wall_type  = COURT_WALL_TYPES.includes(body.wall_type) ? body.wall_type : null;
  const covered      = typeof body.covered === 'boolean' ? body.covered : null;
  const lit          = typeof body.lit === 'boolean' ? body.lit : null;
  const external_play = typeof body.external_play === 'boolean' ? body.external_play : null;
  const price_30 = parsePrice(body.price_30);
  const price_60 = parsePrice(body.price_60);
  return { floor_type, wall_type, covered, lit, external_play, price_30, price_60 };
}

// Precio total de `slotCount` turnos de 30 min SEGUIDOS, a partir de los dos
// precios de la cancha (30 y 60 min, ver courtFields() arriba). Se arma de a
// bloques de 60 min y, si sobra un turno de 30 suelto (cantidad impar), se
// suma aparte con el precio de 30 -- así una reserva de 90 min cobra
// (1 × precio_60) + (1 × precio_30), no un precio_30 × 3 que ignoraría el
// combo de 60 que haya cargado el dueño. Si al dueño le falta uno de los dos
// precios, se lo estima a partir del otro (mitad/doble) para no dejar turnos
// sin precio de la nada; si no cargó ninguno, sigue siendo null ("a
// consultar"), igual que antes.
function computeTotalPrice(price30, price60, slotCount) {
  const p30 = price30 != null ? Number(price30) : null;
  const p60 = price60 != null ? Number(price60) : null;
  if (p30 == null && p60 == null) return null;
  const unit30 = p30 ?? p60 / 2;
  const unit60 = p60 ?? p30 * 2;
  const blocks60 = Math.floor(slotCount / 2);
  const extra30  = slotCount % 2;
  return blocks60 * unit60 + extra30 * unit30;
}

// Una vez que el club tiene al menos una cancha real cargada, el viejo
// "cantidad de canchas" (`clubs.courts`, ver clubFields() más arriba) deja de
// ser un número suelto que carga el dueño a mano y pasa a reflejar las
// canchas reales activas -- así las tarjetas de club en Discover/HomeView
// (que siguen mostrando ese número suelto, no `courts_list`) no quedan
// desactualizadas apenas alguien empieza a usar la gestión de canchas. Se
// cuentan sólo las activas porque es lo que ve un visitante público.
async function syncLegacyCourtsCount(sql, clubId) {
  await sql`
    UPDATE clubs SET courts = (
      SELECT COUNT(*)::int FROM club_courts WHERE club_id = ${clubId} AND active = true
    )
    WHERE id = ${clubId}
  `;
}

// GET /api/clubs/:id/courts -- público, pero sólo activas para quien no
// gestiona el club (el dueño/admin también ve las deshabilitadas).
router.get('/:id/courts', optionalAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const [club] = await sql`SELECT owner_id FROM clubs WHERE id = ${req.params.id}`;
    if (!club) return res.status(404).json({ error: 'Club no encontrado' });
    const isManager = req.user?.role === 'admin' || (!!req.user && req.user.id === club.owner_id);
    const courts = await sql`
      SELECT id, name, floor_type, wall_type, covered, lit, external_play, price_30, price_60, active, sort_order
      FROM club_courts
      WHERE club_id = ${req.params.id} AND (${isManager}::boolean OR active = true)
      ORDER BY sort_order ASC, created_at ASC
    `;
    res.json(courts);
  } catch (err) { next(err); }
});

// POST /api/clubs/:id/courts
router.post('/:id/courts', requireAuth, requireClubManage, async (req, res, next) => {
  try {
    const name = req.body?.name?.trim();
    if (!name)            return res.status(400).json({ error: 'El nombre de la cancha es requerido' });
    if (name.length > 40) return res.status(400).json({ error: 'El nombre de la cancha no puede superar los 40 caracteres' });

    const sql = getDb();
    const c = courtFields(req.body);
    const [{ next_order }] = await sql`
      SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM club_courts WHERE club_id = ${req.params.id}
    `;
    const [court] = await sql`
      INSERT INTO club_courts (id, club_id, name, floor_type, wall_type, covered, lit, external_play, price_30, price_60, sort_order)
      VALUES (${uid()}, ${req.params.id}, ${name}, ${c.floor_type}, ${c.wall_type}, ${c.covered}, ${c.lit}, ${c.external_play}, ${c.price_30}, ${c.price_60}, ${next_order})
      RETURNING id, name, floor_type, wall_type, covered, lit, external_play, price_30, price_60, active, sort_order
    `;
    await syncLegacyCourtsCount(sql, req.params.id);
    res.status(201).json(court);
  } catch (err) { next(err); }
});

// PUT /api/clubs/:id/courts/:courtId
router.put('/:id/courts/:courtId', requireAuth, requireClubManage, async (req, res, next) => {
  try {
    const name = req.body?.name?.trim();
    if (!name)            return res.status(400).json({ error: 'El nombre de la cancha es requerido' });
    if (name.length > 40) return res.status(400).json({ error: 'El nombre de la cancha no puede superar los 40 caracteres' });

    const sql = getDb();
    const c = courtFields(req.body);
    const active = typeof req.body?.active === 'boolean' ? req.body.active : true;
    const [court] = await sql`
      UPDATE club_courts SET
        name = ${name}, floor_type = ${c.floor_type}, wall_type = ${c.wall_type},
        covered = ${c.covered}, lit = ${c.lit}, external_play = ${c.external_play},
        price_30 = ${c.price_30}, price_60 = ${c.price_60}, active = ${active}
      WHERE id = ${req.params.courtId} AND club_id = ${req.params.id}
      RETURNING id, name, floor_type, wall_type, covered, lit, external_play, price_30, price_60, active, sort_order
    `;
    if (!court) return res.status(404).json({ error: 'Cancha no encontrada' });
    await syncLegacyCourtsCount(sql, req.params.id);
    res.json(court);
  } catch (err) { next(err); }
});

// DELETE /api/clubs/:id/courts/:courtId
router.delete('/:id/courts/:courtId', requireAuth, requireClubManage, async (req, res, next) => {
  try {
    const sql = getDb();
    const [deleted] = await sql`
      DELETE FROM club_courts WHERE id = ${req.params.courtId} AND club_id = ${req.params.id} RETURNING id
    `;
    if (!deleted) return res.status(404).json({ error: 'Cancha no encontrada' });
    await syncLegacyCourtsCount(sql, req.params.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// PATCH /api/clubs/:id/courts/:courtId/move -- reordena moviendo una cancha
// un lugar arriba o abajo (swap de sort_order con la vecina). Devuelve la
// lista completa ya reordenada para no tener que recalcular nada en el front.
router.patch('/:id/courts/:courtId/move', requireAuth, requireClubManage, async (req, res, next) => {
  try {
    const direction = req.body?.direction;
    if (!['up', 'down'].includes(direction))
      return res.status(400).json({ error: "direction debe ser 'up' o 'down'" });

    const sql = getDb();
    const courts = await sql`
      SELECT id, sort_order FROM club_courts WHERE club_id = ${req.params.id} ORDER BY sort_order ASC, created_at ASC
    `;
    const idx = courts.findIndex((c) => c.id === req.params.courtId);
    if (idx === -1) return res.status(404).json({ error: 'Cancha no encontrada' });
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;

    if (swapIdx >= 0 && swapIdx < courts.length) {
      const a = courts[idx], b = courts[swapIdx];
      await sql`UPDATE club_courts SET sort_order = ${b.sort_order} WHERE id = ${a.id}`;
      await sql`UPDATE club_courts SET sort_order = ${a.sort_order} WHERE id = ${b.id}`;
    } // si ya está en la punta, no-op -- se devuelve la lista tal cual está.

    const updated = await sql`
      SELECT id, name, floor_type, wall_type, covered, lit, external_play, price_30, price_60, active, sort_order
      FROM club_courts WHERE club_id = ${req.params.id} ORDER BY sort_order ASC, created_at ASC
    `;
    res.json(updated);
  } catch (err) { next(err); }
});

// ── Reservas (Fase 3 de "reservas de cancha") ────────────────────────────────
// Horizonte fijo de 7 días. Una reserva "pending" NO bloquea el turno --
// decisión revertida el 2026-09-06 (Fabri): bloquear apenas alguien pide un
// turno le hacía perder clientes al dueño si alguien spameaba pedidos sin
// confirmar nunca y el dueño tardaba en decidir. Ahora sólo "confirmed"
// bloquea (ver los índices únicos en schema.sql); pueden convivir varias
// "pending" para el mismo horario, y cuando el dueño confirma una, las demás
// se rechazan solas (ver cancelOverlappingPending más abajo) y se les avisa
// a quienes reservaron. La duración de cada reserva SIEMPRE se toma de
// `clubs.slot_minutes` en el momento de crearla (nunca de lo que mande el
// body) para que nadie pueda mandar una duración distinta y romper el
// cálculo de choques con otras reservas.
const BOOKING_HORIZON_DAYS = 7;

function isValidDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function addDaysStr(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// GET /api/clubs/:id/bookings?from=YYYY-MM-DD&to=YYYY-MM-DD -- público. Sólo
// lo mínimo para pintar la grilla de turnos tomados -- nunca el nombre ni el
// contacto de quien reservó (decisión cerrada: "quién reservó nunca es
// público"). Sin ?from/?to, devuelve el horizonte completo de 7 días.
router.get('/:id/bookings', optionalAuth, async (req, res, next) => {
  try {
    const from = isValidDateStr(req.query.from) ? req.query.from : todayStr();
    const to   = isValidDateStr(req.query.to)   ? req.query.to   : addDaysStr(todayStr(), BOOKING_HORIZON_DAYS - 1);
    const sql = getDb();
    // `status` viaja para que el front pueda pintar "confirmed" como tomado
    // (bloquea) y "pending" como "muy solicitado" (no bloquea, es sólo un
    // aviso de demanda -- ver ClubBooking.jsx). Sigue sin viajar nunca quién
    // reservó.
    const bookings = await sql`
      SELECT group_id, court_id, date, start_time, duration_minutes, status
      FROM bookings
      WHERE club_id = ${req.params.id} AND status IN ('pending', 'confirmed')
        AND date >= ${from} AND date <= ${to}
    `;
    res.json(bookings);
  } catch (err) { next(err); }
});

// GET /api/clubs/:id/bookings/manage?from=&to= -- sólo el dueño (o admin). A
// diferencia de la pública, acá SÍ viaja todo lo que el dueño necesita para
// decidir: nombre/contacto de quien reservó, motivo y fecha de decisión, y
// las tres reservas (pendiente/confirmada/rechazada), no sólo las que
// bloquean turnos. El horizonte por default es más amplio que los 7 días de
// la reserva pública (incluye una semana hacia atrás, por si quedó algo sin
// decidir) porque esta pantalla es de gestión, no de disponibilidad.
router.get('/:id/bookings/manage', requireAuth, requireClubBookingManage, async (req, res, next) => {
  try {
    const from = isValidDateStr(req.query.from) ? req.query.from : addDaysStr(todayStr(), -7);
    const to   = isValidDateStr(req.query.to)   ? req.query.to   : addDaysStr(todayStr(), 60);
    const sql = getDb();
    const bookings = await sql`
      SELECT b.id, b.group_id, b.court_id, c.name AS court_name, b.date, b.start_time,
             b.duration_minutes, b.price, b.status, b.guest_name, b.guest_contact, b.user_id,
             u.username AS user_username,
             b.decision_reason, b.decided_at, b.created_at
      FROM bookings b
      LEFT JOIN club_courts c ON c.id = b.court_id
      LEFT JOIN users u ON u.id = b.user_id
      WHERE b.club_id = ${req.params.id} AND b.date >= ${from} AND b.date <= ${to}
      ORDER BY b.date, b.start_time
    `;
    // Para cada reserva pendiente, cuántas OTRAS reservas pendientes (de
    // otros group_id) comparten exactamente el mismo turno -- así el dueño
    // ve, antes de decidir, que confirmar ésta va a rechazar automáticamente
    // las demás (ver cancelOverlappingPending). No hace falta para
    // confirmed/rejected: una vez decidida, no hay nada más que avisar.
    const overlaps = await sql`
      SELECT b.group_id AS group_id, COUNT(DISTINCT b2.group_id)::int AS other_pending_count
      FROM bookings b
      JOIN bookings b2
        ON b2.club_id = b.club_id
       AND b2.date = b.date
       AND b2.start_time = b.start_time
       AND b2.court_id IS NOT DISTINCT FROM b.court_id
       AND b2.status = 'pending'
       AND b2.group_id <> b.group_id
      WHERE b.club_id = ${req.params.id} AND b.status = 'pending'
        AND b.date >= ${from} AND b.date <= ${to}
      GROUP BY b.group_id
    `;
    const overlapMap = new Map(overlaps.map((r) => [r.group_id, r.other_pending_count]));
    res.json(bookings.map((b) => ({ ...b, other_pending_count: overlapMap.get(b.group_id) ?? 0 })));
  } catch (err) { next(err); }
});

const MAX_SLOTS_PER_BOOKING = 8; // tope de turnos consecutivos en una sola reserva

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function minutesToTime(mins) {
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Inserta un grupo de N filas de bookings (una por turno consecutivo,
// compartiendo el mismo group_id) de forma atomica -- lo usan tanto la
// reserva publica (POST /:id/bookings) como el bloqueo manual del dueño
// (POST /:id/bookings/manual). Lo unico que cambia entre una y otra es quien
// puede llamarla, que campos son obligatorios antes de llegar aca, y en que
// `status` arranca la reserva (pending para la publica, confirmed para el
// bloqueo del dueño, que no tiene sentido que se autoapruebe).
async function insertBookingGroup({ clubId, slotMinutes, date, sorted, court_id, price, userId, guestName, guestContact, status }) {
  const groupId = uid();
  return withTransaction(async (client) => {
    const rows = [];
    for (const start_time of sorted) {
      const { rows: [row] } = await client.query(
        `INSERT INTO bookings
           (id, group_id, club_id, court_id, user_id, guest_name, guest_contact, date, start_time, duration_minutes, price, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id, group_id, club_id, court_id, date, start_time, duration_minutes, price, status, created_at`,
        [uid(), groupId, clubId, court_id, userId, guestName, guestContact, date, start_time, slotMinutes, price, status],
      );
      rows.push(row);
    }
    return rows;
  });
}

// Cuando un turno pasa a "confirmed" (aprobación del dueño o bloqueo manual),
// cualquier OTRA reserva "pending" que compartía exactamente ese mismo
// horario (mismo club/cancha/fecha/hora) ya no tiene sentido -- el cupo se lo
// llevó la que se confirmó. Se rechazan automáticamente, con un motivo fijo
// (no el que haya tipeado el dueño, que es sobre SU decisión, no sobre este
// efecto colateral), y si tenían cuenta se les avisa in-app. Devuelve los
// group_id rechazados, para que quien llamó pueda avisarle también al dueño
// cuántas se vieron afectadas. Nunca rompe la operación principal: todo el
// bloque es best-effort (igual que el resto de las notificaciones de esta
// pantalla).
async function cancelOverlappingPending({ sql, clubId, confirmedRows, excludeGroupId, actorId, clubName }) {
  try {
    const affected = new Map(); // group_id -> { user_id, date, start_time }
    for (const r of confirmedRows) {
      const others = await sql`
        SELECT group_id, user_id, date, start_time
        FROM bookings
        WHERE club_id = ${clubId} AND status = 'pending' AND group_id <> ${excludeGroupId}
          AND date = ${r.date} AND start_time = ${r.start_time}
          AND court_id IS NOT DISTINCT FROM ${r.court_id}
      `;
      for (const o of others) if (!affected.has(o.group_id)) affected.set(o.group_id, o);
    }
    if (!affected.size) return [];

    const groupIds = [...affected.keys()];
    const reason = 'El club confirmó otra reserva para este mismo horario.';
    await sql`
      UPDATE bookings
      SET status = 'rejected', decision_reason = ${reason}, decided_at = NOW()
      WHERE club_id = ${clubId} AND group_id = ANY(${groupIds}) AND status = 'pending'
    `;

    for (const info of affected.values()) {
      if (!info.user_id) continue;
      try {
        const when = `${info.date} a las ${String(info.start_time).slice(0, 5)} hs`;
        const body = `"${clubName}" canceló tu solicitud de turno del ${when} porque confirmó otra reserva para ese mismo horario.`;
        await sql`
          INSERT INTO notifications (id, user_id, type, actor_id, entity_id, body)
          VALUES (${uid()}, ${info.user_id}, 'booking_decided', ${actorId}, ${clubId}, ${body})
        `;
      } catch (notifyErr) {
        console.error('No se pudo notificar la cancelación en cascada:', notifyErr.message);
      }
    }
    return groupIds;
  } catch (err) {
    console.error('No se pudo cancelar reservas superpuestas:', err.message);
    return [];
  }
}

// POST /api/clubs/:id/bookings -- invitado (nombre + contacto) o logueado
// (queda linkeado con user_id además, para una futura pantalla de "mis
// reservas"); en los dos casos se piden nombre y contacto igual, porque el
// perfil de usuario no guarda teléfono.
//
// `slots` es un array de uno o más horarios de inicio ("HH:MM") CONSECUTIVOS
// -- ej. ["08:00", "09:00"] para reservar dos turnos seguidos de 60 min y
// juntar 2 horas -- porque un usuario puede querer más de un turno seguido y
// un solo `start_time` no alcanzaba para eso. Se guarda una fila por turno
// base (mismo `group_id` en todas), nunca una fila con una duración más
// larga: así el índice único de un solo turno (uq_bookings_slot_*) sigue
// alcanzando para evitar choques, sin necesitar lógica de rangos/overlap.
// El insert de todas las filas es atómico (withTransaction, ver db.js) --
// si CUALQUIER turno de la lista ya está tomado, se cae toda la reserva
// junta, nunca queda la mitad reservada.
router.post('/:id/bookings', optionalAuth, async (req, res, next) => {
  try {
    const guest_name    = req.body?.guest_name?.trim();
    const guest_contact = req.body?.guest_contact?.trim();
    if (!guest_name)    return res.status(400).json({ error: 'Tu nombre es requerido' });
    if (!guest_contact) return res.status(400).json({ error: 'Un teléfono o WhatsApp de contacto es requerido' });
    if (!isValidDateStr(req.body?.date)) return res.status(400).json({ error: 'Fecha inválida' });

    const slots = Array.isArray(req.body?.slots) ? [...req.body.slots] : [];
    if (!slots.length || slots.length > MAX_SLOTS_PER_BOOKING || !slots.every((s) => /^\d{2}:\d{2}$/.test(s))) {
      return res.status(400).json({ error: 'Horario inválido' });
    }

    const min = todayStr();
    const max = addDaysStr(min, BOOKING_HORIZON_DAYS - 1);
    if (req.body.date < min || req.body.date > max) {
      return res.status(400).json({ error: `Sólo se puede reservar dentro de los próximos ${BOOKING_HORIZON_DAYS} días` });
    }

    const sql = getDb();
    const [club] = await sql`SELECT id, name, owner_id, slot_minutes FROM clubs WHERE id = ${req.params.id}`;
    if (!club) return res.status(404).json({ error: 'Club no encontrado' });

    // Los turnos tienen que venir consecutivos y sin repetir -- si no, no
    // representan una única reserva continua sino horarios sueltos, que ya
    // tienen su propio endpoint (mandar `slots` con un solo elemento).
    const sorted = [...slots].sort();
    for (let i = 1; i < sorted.length; i++) {
      if (timeToMinutes(sorted[i]) - timeToMinutes(sorted[i - 1]) !== club.slot_minutes) {
        return res.status(400).json({ error: 'Los turnos elegidos tienen que ser consecutivos' });
      }
    }

    let court_id = null;
    let court_name = null;
    let price = null;
    if (req.body?.court_id) {
      const [court] = await sql`
        SELECT id, name, price_30, price_60 FROM club_courts WHERE id = ${req.body.court_id} AND club_id = ${req.params.id} AND active = true
      `;
      if (!court) return res.status(400).json({ error: 'Cancha no válida' });
      court_id = court.id;
      court_name = court.name;
      // El precio total (Fase 4: turnos de 30 min, no necesariamente lineal
      // con el de 60) se reparte en partes iguales entre las filas del grupo
      // -- no hay una forma "correcta" de asignarlo turno por turno cuando el
      // precio viene combinado en bloques de 60 min, y esto es sólo
      // informativo (todavía no hay cobro real acá).
      const totalPrice = computeTotalPrice(court.price_30, court.price_60, sorted.length);
      price = totalPrice != null ? Math.round((totalPrice / sorted.length) * 100) / 100 : null;
    }

    try {
      const bookings = await insertBookingGroup({
        clubId: req.params.id,
        slotMinutes: club.slot_minutes,
        date: req.body.date,
        sorted,
        court_id,
        price,
        userId: req.user?.id ?? null,
        guestName: guest_name,
        guestContact: guest_contact,
        status: 'pending',
      });
      // Avisar de la solicitud nueva a quien la tiene que decidir: el dueño
      // verificado, o -- si el club todavía no tiene uno -- a todos los
      // admins (mismo fan-out que ya usa POST /:id/claim para avisar de un
      // reclamo nuevo). Best-effort: no romper la reserva ya creada si falla.
      try {
        const endTime = minutesToTime(timeToMinutes(sorted[sorted.length - 1]) + club.slot_minutes);
        const courtLabel = court_name ? ` en ${court_name}` : '';
        const body = `${guest_name} pidió un turno${courtLabel} para el ${req.body.date} de ${sorted[0]} a ${endTime} hs.`;
        const actorId = req.user?.id ?? null;
        // entity_id = el club (no el group_id de la reserva): el front sólo
        // necesita poder llevar a quien la lee directo a la ficha del club
        // (Fabri, 2026-09-06) -- no hay pantalla de "ver esta reserva puntual".
        if (club.owner_id) {
          await sql`
            INSERT INTO notifications (id, user_id, type, actor_id, entity_id, body)
            VALUES (${uid()}, ${club.owner_id}, 'booking_requested', ${actorId}, ${req.params.id}, ${body})
          `;
        } else {
          const admins = await sql`SELECT id FROM users WHERE role = 'admin'`;
          for (const admin of admins) {
            if (admin.id === actorId) continue;
            await sql`
              INSERT INTO notifications (id, user_id, type, actor_id, entity_id, body)
              VALUES (${uid()}, ${admin.id}, 'booking_requested', ${actorId}, ${req.params.id}, ${body})
            `;
          }
        }
      } catch (notifyErr) {
        console.error('No se pudo notificar la solicitud de turno nueva:', notifyErr.message);
      }

      res.status(201).json(bookings);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Ese horario ya no está completamente disponible -- alguien tomó uno de esos turnos justo antes que vos.' });
      throw e;
    }
  } catch (err) { next(err); }
});

// POST /api/clubs/:id/bookings/manual -- el dueño (o un admin) marca un turno
// (o varios seguidos) como reservado por fuera de la app: alguien lo llamó,
// le escribió o vino en persona a preguntar. A diferencia de la reserva
// pública: nombre y contacto son OPCIONALES (el dueño puede no saber o no
// querer cargar quién fue), no hay límite de 7 días (el dueño puede bloquear
// una cancha por mantenimiento más adelante en el calendario), y la fila
// queda `confirmed` directamente -- no tiene sentido pedirle al dueño que se
// autoapruebe algo que él mismo está cargando.
router.post('/:id/bookings/manual', requireAuth, requireClubBookingManage, async (req, res, next) => {
  try {
    const guest_name    = req.body?.guest_name?.trim() || 'Reservado por el club';
    const guest_contact = req.body?.guest_contact?.trim() || '';
    if (!isValidDateStr(req.body?.date)) return res.status(400).json({ error: 'Fecha inválida' });
    if (req.body.date < todayStr()) return res.status(400).json({ error: 'No se puede bloquear una fecha pasada' });

    const slots = Array.isArray(req.body?.slots) ? [...req.body.slots] : [];
    if (!slots.length || slots.length > MAX_SLOTS_PER_BOOKING || !slots.every((s) => /^\d{2}:\d{2}$/.test(s))) {
      return res.status(400).json({ error: 'Horario inválido' });
    }

    const sql = getDb();
    const [club] = await sql`SELECT id, name, slot_minutes FROM clubs WHERE id = ${req.params.id}`;
    if (!club) return res.status(404).json({ error: 'Club no encontrado' });

    const sorted = [...slots].sort();
    for (let i = 1; i < sorted.length; i++) {
      if (timeToMinutes(sorted[i]) - timeToMinutes(sorted[i - 1]) !== club.slot_minutes) {
        return res.status(400).json({ error: 'Los turnos elegidos tienen que ser consecutivos' });
      }
    }

    let court_id = null;
    let price = null;
    if (req.body?.court_id) {
      const [court] = await sql`
        SELECT id, price_30, price_60 FROM club_courts WHERE id = ${req.body.court_id} AND club_id = ${req.params.id} AND active = true
      `;
      if (!court) return res.status(400).json({ error: 'Cancha no válida' });
      court_id = court.id;
      const totalPrice = computeTotalPrice(court.price_30, court.price_60, sorted.length);
      price = totalPrice != null ? Math.round((totalPrice / sorted.length) * 100) / 100 : null;
    }

    try {
      const bookings = await insertBookingGroup({
        clubId: req.params.id,
        slotMinutes: club.slot_minutes,
        date: req.body.date,
        sorted,
        court_id,
        price,
        userId: null,
        guestName: guest_name,
        guestContact: guest_contact,
        status: 'confirmed',
      });
      // El bloqueo manual también "gana" el horario -- si había pedidos
      // públicos pendientes para el mismo turno, se rechazan solos y se les
      // avisa (mismo mecanismo que al confirmar desde la pantalla de
      // gestión, ver cancelOverlappingPending).
      await cancelOverlappingPending({
        sql, clubId: req.params.id, confirmedRows: bookings,
        excludeGroupId: bookings[0].group_id, actorId: req.user.id,
        clubName: club.name,
      });
      res.status(201).json(bookings);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Ese turno ya está ocupado.' });
      throw e;
    }
  } catch (err) { next(err); }
});

// PATCH /api/clubs/:id/bookings/:groupId -- el dueño (o admin) aprueba o
// rechaza una reserva pendiente, O libera una reserva ya confirmada (mismo
// endpoint para las dos cosas: "liberar" es, ni más ni menos, marcarla
// `rejected` con un motivo -- el índice único sólo bloquea turnos
// `confirmed`, así que rechazar/liberar deja el horario libre de nuevo
// automáticamente, sin lógica extra). El motivo es obligatorio para
// rechazar/liberar (mismo criterio que el rechazo de un club_claim/
// club_request), opcional para confirmar. Una vez `rejected` la reserva
// queda cerrada -- no se puede volver a mover de ahí. Confirmar puede además
// rechazar en cascada otras reservas pendientes que compartían el mismo
// horario (ver cancelOverlappingPending) -- `bumped_group_ids` en la
// respuesta le dice al front cuáles, para actualizar su estado local sin
// tener que refetchear toda la pantalla.
router.patch('/:id/bookings/:groupId', requireAuth, requireClubBookingManage, async (req, res, next) => {
  try {
    const status = req.body?.status;
    if (!['confirmed', 'rejected'].includes(status)) {
      return res.status(400).json({ error: "status debe ser 'confirmed' o 'rejected'" });
    }
    const decision_reason = req.body?.decision_reason?.trim() || null;
    if (status === 'rejected' && !decision_reason) {
      return res.status(400).json({ error: 'El motivo es obligatorio para rechazar o liberar un turno' });
    }

    const sql = getDb();
    const rows = await sql`
      SELECT b.id, b.status, b.date, b.start_time, b.duration_minutes, b.user_id, b.court_id,
             c.name AS court_name
      FROM bookings b
      LEFT JOIN club_courts c ON c.id = b.court_id
      WHERE b.club_id = ${req.params.id} AND b.group_id = ${req.params.groupId}
      ORDER BY b.start_time
    `;
    if (!rows.length) return res.status(404).json({ error: 'Reserva no encontrada' });

    const currentStatus = rows[0].status;
    if (currentStatus === 'rejected') {
      return res.status(400).json({ error: 'Esta reserva ya fue rechazada' });
    }
    if (currentStatus === status) {
      return res.status(400).json({ error: `Esta reserva ya está ${status === 'confirmed' ? 'confirmada' : 'rechazada'}` });
    }

    const [club] = await sql`SELECT name FROM clubs WHERE id = ${req.params.id}`;

    try {
      await sql`
        UPDATE bookings
        SET status = ${status}, decision_reason = ${decision_reason}, decided_at = NOW()
        WHERE club_id = ${req.params.id} AND group_id = ${req.params.groupId}
      `;
    } catch (e) {
      // Carrera rarísima: otra reserva confirmada se coló para este mismo
      // horario entre el GET de la pantalla y este click.
      if (e.code === '23505') return res.status(409).json({ error: 'Ese horario ya quedó confirmado con otra reserva.' });
      throw e;
    }

    // Si se confirmó, cualquier otra reserva pendiente para el mismo
    // horario deja de tener sentido -- se rechaza sola y se le avisa a quien
    // la hizo (ver cancelOverlappingPending). El dueño ya vio, antes de
    // decidir, cuántas reservas se iban a ver afectadas (other_pending_count
    // en GET /bookings/manage).
    const bumpedGroupIds = status === 'confirmed'
      ? await cancelOverlappingPending({
          sql, clubId: req.params.id, confirmedRows: rows,
          excludeGroupId: req.params.groupId, actorId: req.user.id,
          clubName: club?.name ?? 'El club',
        })
      : [];

    // Avisarle a quien reservó, sólo si tenía cuenta (un invitado no tiene a
    // dónde mandarle una notificación in-app -- el dueño ya tiene su
    // guest_contact a mano para escribirle directo si hace falta). Best-effort.
    const userId = rows[0].user_id;
    if (userId) {
      try {
        const lastRow = rows[rows.length - 1];
        const startTime = rows[0].start_time.slice(0, 5);
        const endTime = minutesToTime(timeToMinutes(lastRow.start_time.slice(0, 5)) + lastRow.duration_minutes);
        const courtLabel = rows[0].court_name ? ` en ${rows[0].court_name}` : '';
        const when = `${rows[0].date} de ${startTime} a ${endTime} hs`;
        const reasonSuffix = decision_reason ? ` Motivo: "${decision_reason}"` : '';
        const body = status === 'confirmed'
          ? `El club "${club?.name ?? ''}" confirmó tu turno${courtLabel} del ${when}.`
          : currentStatus === 'confirmed'
            ? `El club "${club?.name ?? ''}" canceló tu turno${courtLabel} del ${when}.${reasonSuffix}`
            : `El club "${club?.name ?? ''}" rechazó tu solicitud de turno${courtLabel} del ${when}.${reasonSuffix}`;
        // entity_id = el club, mismo criterio que booking_requested (arriba).
        await sql`
          INSERT INTO notifications (id, user_id, type, actor_id, entity_id, body)
          VALUES (${uid()}, ${userId}, 'booking_decided', ${req.user.id}, ${req.params.id}, ${body})
        `;
      } catch (notifyErr) {
        console.error('No se pudo notificar la decisión de la reserva:', notifyErr.message);
      }
    }

    res.json({ group_id: req.params.groupId, status, decision_reason, bumped_group_ids: bumpedGroupIds });
  } catch (err) { next(err); }
});

// ── DELETE /api/clubs/:id ────────────────────────────────────────────────────
router.delete('/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const sql = getDb();
    const [club] = await sql`SELECT id, photo_public_id FROM clubs WHERE id = ${req.params.id}`;
    if (!club) return res.status(404).json({ error: 'Club no encontrado' });

    if (club.photo_public_id) await deleteByPublicId(club.photo_public_id);
    await sql`DELETE FROM clubs WHERE id = ${club.id}`;   // tournaments.club_id → SET NULL
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
