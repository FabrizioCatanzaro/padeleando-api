import { Router } from 'express';
import { getDb } from '../db.js';
import { uid }   from '../uid.js';
import { requireAuth }              from '../middleware/auth.js';
import { uploadTournamentPhoto }    from '../middleware/upload.js';
import { uploadBuffer, deleteByPublicId } from '../lib/cloudinary.js';
import { canManageGroup }           from '../lib/access.js';
import { getActiveSubscription }    from './subscriptions.js';

const router = Router({ mergeParams: true });

const MAX_PHOTOS_PER_TOURNAMENT = 12;

async function getTournamentOwnership(sql, tournamentId) {
  const [row] = await sql`
    SELECT g.id AS group_id, g.user_id FROM tournaments t
    JOIN   groups g ON g.id = t.group_id
    WHERE  t.id = ${tournamentId}
  `;
  return row;
}

// GET /api/tournaments/:tournamentId/photos — público (cualquiera puede ver)
router.get('/', async (req, res, next) => {
  try {
    const sql = getDb();
    const photos = await sql`
      SELECT id, tournament_id, uploaded_by, url, caption, created_at, is_cover
      FROM   tournament_photos
      WHERE  tournament_id = ${req.params.tournamentId}
      ORDER  BY is_cover DESC, created_at DESC
    `;
    res.json(photos);
  } catch (err) { next(err); }
});

// POST /api/tournaments/:tournamentId/photos — dueño o co-organizador; premium del DUEÑO
router.post('/', requireAuth, uploadTournamentPhoto, async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se envió imagen' });
    const { tournamentId } = req.params;
    const sql = getDb();

    const owner = await getTournamentOwnership(sql, tournamentId);
    if (!owner) return res.status(404).json({ error: 'Torneo no encontrado' });
    if (!(await canManageGroup(sql, req.user.id, owner.group_id)))
      return res.status(403).json({ error: 'Sin permiso' });

    // La compuerta premium se evalúa contra el DUEÑO de la categoría, no contra quien sube.
    const ownerSub = await getActiveSubscription(sql, owner.user_id);
    if (ownerSub.plan !== 'premium')
      return res.status(403).json({ error: 'Las fotos son una función Premium del dueño de la categoría' });

    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count
      FROM   tournament_photos
      WHERE  tournament_id = ${tournamentId}
    `;
    if (count >= MAX_PHOTOS_PER_TOURNAMENT) {
      return res.status(400).json({
        error: `Límite de ${MAX_PHOTOS_PER_TOURNAMENT} fotos por torneo alcanzado`,
      });
    }

    const result = await uploadBuffer(req.file.buffer, {
      folder: `padeliando/tournaments/${tournamentId}`,
    });

    const caption = req.body?.caption?.trim() || null;

    const [photo] = await sql`
      INSERT INTO tournament_photos (id, tournament_id, uploaded_by, url, public_id, caption)
      VALUES (${uid()}, ${tournamentId}, ${req.user.id}, ${result.secure_url}, ${result.public_id}, ${caption})
      RETURNING id, tournament_id, uploaded_by, url, caption, created_at, is_cover
    `;

    res.status(201).json(photo);
  } catch (err) { next(err); }
});

// PATCH /api/tournaments/:tournamentId/photos/:photoId — editar caption (solo dueño)
router.patch('/:photoId', requireAuth, async (req, res, next) => {
  try {
    const { tournamentId, photoId } = req.params;
    const sql = getDb();

    const [photo] = await sql`
      SELECT p.id, t.group_id
      FROM   tournament_photos p
      JOIN   tournaments t ON t.id = p.tournament_id
      WHERE  p.id = ${photoId} AND p.tournament_id = ${tournamentId}
    `;
    if (!photo) return res.status(404).json({ error: 'Foto no encontrada' });
    if (!(await canManageGroup(sql, req.user.id, photo.group_id)))
      return res.status(403).json({ error: 'Sin permiso' });

    const raw = typeof req.body?.caption === 'string' ? req.body.caption.trim() : '';
    const newCaption = raw.length > 0 ? raw.slice(0, 200) : null;

    const [updated] = await sql`
      UPDATE tournament_photos
      SET    caption = ${newCaption}
      WHERE  id = ${photoId}
      RETURNING id, tournament_id, uploaded_by, url, caption, created_at, is_cover
    `;
    res.json(updated);
  } catch (err) { next(err); }
});

// PATCH /api/tournaments/:tournamentId/photos/:photoId/cover — establecer portada (solo dueño)
router.patch('/:photoId/cover', requireAuth, async (req, res, next) => {
  try {
    const { tournamentId, photoId } = req.params;
    const sql = getDb();

    const [photo] = await sql`
      SELECT p.id, t.group_id
      FROM   tournament_photos p
      JOIN   tournaments t ON t.id = p.tournament_id
      WHERE  p.id = ${photoId} AND p.tournament_id = ${tournamentId}
    `;
    if (!photo) return res.status(404).json({ error: 'Foto no encontrada' });
    if (!(await canManageGroup(sql, req.user.id, photo.group_id)))
      return res.status(403).json({ error: 'Sin permiso' });

    await sql`
      UPDATE tournament_photos
      SET    is_cover = (id = ${photoId})
      WHERE  tournament_id = ${tournamentId}
    `;

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/tournaments/:tournamentId/photos/:photoId — solo dueño del grupo
router.delete('/:photoId', requireAuth, async (req, res, next) => {
  try {
    const { tournamentId, photoId } = req.params;
    const sql = getDb();

    const [photo] = await sql`
      SELECT p.id, p.public_id, t.group_id
      FROM   tournament_photos p
      JOIN   tournaments t ON t.id = p.tournament_id
      WHERE  p.id = ${photoId} AND p.tournament_id = ${tournamentId}
    `;
    if (!photo) return res.status(404).json({ error: 'Foto no encontrada' });
    if (!(await canManageGroup(sql, req.user.id, photo.group_id)))
      return res.status(403).json({ error: 'Sin permiso' });

    await deleteByPublicId(photo.public_id);
    await sql`DELETE FROM tournament_photos WHERE id = ${photoId}`;

    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
