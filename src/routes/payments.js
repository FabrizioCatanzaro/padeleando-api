import { Router } from 'express';
import { getDb } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { connectState, authorizeUrl } from '../lib/mpAccount.js';
import {
  listSettlements, ensureSettlements, amountDue, createSettlementCheckout, fetchPlatformPayment, settlementRef,
} from '../lib/settlements.js';

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

// GET /api/payments/settlements: liquidaciones de comisiones del organizador y su saldo a favor.
router.get('/settlements', requireAuth, async (req, res, next) => {
  try { res.json(await listSettlements(getDb(), req.user.id)); }
  catch (err) { next(err); }
});

// POST /api/payments/settlements/:id/checkout: link de pago con la cuenta de la plataforma.
router.post('/settlements/:id/checkout', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    await ensureSettlements(sql, req.user.id);
    const [s] = await sql`
      SELECT s.*, t.name AS tournament_name FROM commission_settlements s
      JOIN tournaments t ON t.id = s.tournament_id
      WHERE s.id = ${req.params.id} AND s.owner_id = ${req.user.id}`;
    if (!s) return res.status(404).json({ error: 'Liquidación no encontrada' });
    if (s.status !== 'pending' || amountDue(s) <= 0) return res.status(409).json({ error: 'Esta liquidación no tiene saldo por pagar' });
    const checkout = await createSettlementCheckout(s);
    await sql`UPDATE commission_settlements SET mp_preference_id = ${checkout.preference_id}, mp_init_point = ${checkout.init_point}
              WHERE id = ${s.id}`;
    res.json({ checkout_url: checkout.init_point });
  } catch (err) { next(err); }
});

// POST /api/payments/settlements/webhook?set=ID: aviso del pago. Responde siempre 200.
router.post('/settlements/webhook', async (req, res) => {
  try {
    const id = req.query.set;
    const type = req.body?.type ?? req.query.type ?? req.query.topic;
    const paymentId = req.body?.data?.id ?? req.query['data.id'] ?? req.query.id;
    if (id && type === 'payment' && paymentId) {
      const payment = await fetchPlatformPayment(paymentId);
      if (payment?.external_reference === settlementRef(id) && payment.status === 'approved') {
        await getDb()`
          UPDATE commission_settlements
          SET status = 'paid', paid_at = NOW(), mp_payment_id = ${String(payment.id)}
          WHERE id = ${id} AND status = 'pending'`;
      }
    }
  } catch (err) {
    console.error('Webhook de liquidación:', err?.message ?? err);
  }
  res.sendStatus(200);
});

export default router;
