import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { connectState, authorizeUrl } from '../lib/mpAccount.js';

const router = Router();

// GET /api/payments/mp: estado de la cuenta de Mercado Pago del organizador.
router.get('/mp', requireAuth, async (req, res, next) => {
  try {
    const [u] = await getDb()`SELECT mp_connected_at FROM users WHERE id = ${req.user.id}`;
    res.json({ connected: !!u?.mp_connected_at, connected_at: u?.mp_connected_at ?? null });
  } catch (err) { next(err); }
});

// GET /api/payments/mp/connect: URL de autorización. El callback es el de clubes (redirect_uri registrada).
router.get('/mp/connect', requireAuth, (req, res) => {
  res.json({ authorize_url: authorizeUrl(connectState(req.user.id)) });
});

// DELETE /api/payments/mp/connect: desvincula y apaga el cobro online de sus torneos sin terminar.
router.delete('/mp/connect', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    await Promise.all([
      sql`UPDATE users SET mp_user_id = NULL, mp_access_token = NULL, mp_refresh_token = NULL,
                           mp_public_key = NULL, mp_connected_at = NULL
          WHERE id = ${req.user.id}`,
      sql`UPDATE tournaments t SET signup_online = false
          FROM groups g
          WHERE g.id = t.group_id AND g.user_id = ${req.user.id} AND t.signup_online AND t.status <> 'finished'`,
    ]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

export default router;
