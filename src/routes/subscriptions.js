import { Router } from 'express';
import { Resend }  from 'resend';
import { getDb }   from '../db.js';
import { uid }     from '../uid.js';
import { requireAuth } from '../middleware/auth.js';
import { MercadoPagoConfig, PreApproval, Payment } from 'mercadopago';

const mp        = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
const resend    = new Resend(process.env.RESEND_API_KEY);
const MAIL_FROM = process.env.MAIL_FROM || 'Padeleando <onboarding@resend.dev>';

const MP_PLAN_IDS = {
  monthly: () => process.env.MP_PLAN_ID_MONTHLY,
  annual:  () => process.env.MP_PLAN_ID_ANNUAL,
};

// Mapa inverso: preapproval_plan_id de MP → billing_period de la app.
const PLAN_BILLING = () => ({
  [process.env.MP_PLAN_ID_MONTHLY]: 'monthly',
  [process.env.MP_PLAN_ID_ANNUAL]:  'annual',
});

const router = Router();

// Duraciones por tipo de billing
const BILLING_DURATIONS = {
  monthly:   30,
  annual:    365,
  trial:     7,
};

const PERIOD_DAYS = { monthly: 30, annual: 365 };
// Días de gracia SOLO para la validez interna (cubrir la ventana en que se
// procesa la renovación). NO se suma a la fecha guardada/mostrada, para que
// coincida con la próxima fecha de cobro que muestra Mercado Pago.
const GRACE_DAYS = 3;

// Calcula ends_at a partir de un preapproval: la próxima fecha de cobro de MP
// (next_payment_date). Si MP no la da, cae al período del plan.
function endsAtFromPreapproval(pre, billing) {
  const npd = pre?.next_payment_date ? new Date(pre.next_payment_date) : null;
  if (npd && !Number.isNaN(npd.getTime())) return npd;
  const days = PERIOD_DAYS[billing] ?? 30;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

// ── Helper: obtener la suscripción activa de un usuario ───────────────────────
// Retorna { plan, billing_period, status, starts_at, ends_at } o plan free por defecto.
// Incluye self-heal de renovaciones: para suscripciones vinculadas a MP que están
// por vencer, consulta el preapproval y empuja ends_at hasta la próxima fecha de
// cobro mientras siga authorized. Así el premium se renueva solo, sin depender de
// atrapar cada webhook de cobro (inmune a webhooks perdidos por 503).
export async function getActiveSubscription(sql, userId) {
  let [sub] = await sql`
    SELECT id, plan, billing_period, status, mp_preapproval_id, cancel_at_period_end,
           starts_at, ends_at AS plan_ends_at
    FROM subscriptions
    WHERE user_id = ${userId} AND status = 'active'
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (sub?.mp_preapproval_id) {
    // Re-chequear MP solo cerca del vencimiento (renovación) para no pegar en
    // cada request. Ventana chica: ~6h antes de ends_at o ya vencida.
    const buffer = new Date(Date.now() + 6 * 60 * 60 * 1000);
    const nearExpiry = !sub.plan_ends_at || new Date(sub.plan_ends_at) <= buffer;
    if (nearExpiry) {
      try {
        const pre = await new PreApproval(mp).get({ id: sub.mp_preapproval_id });
        if (pre?.status === 'authorized' && !sub.cancel_at_period_end) {
          // Renovación: empujar ends_at a la próxima fecha de cobro.
          const newEnds = endsAtFromPreapproval(pre, sub.billing_period);
          if (!sub.plan_ends_at || newEnds > new Date(sub.plan_ends_at)) {
            await sql`UPDATE subscriptions SET ends_at = ${newEnds} WHERE id = ${sub.id}`;
            sub.plan_ends_at = newEnds;
          }
        } else if (pre?.status === 'cancelled' || pre?.status === 'paused') {
          // Cancelada/pausada desde MP: marcar que no renueva (sigue premium
          // hasta ends_at). Así también nos enteramos si canceló desde MP.
          if (!sub.cancel_at_period_end) {
            await sql`UPDATE subscriptions SET cancel_at_period_end = true WHERE id = ${sub.id}`;
            sub.cancel_at_period_end = true;
          }
        }
      } catch (_) { /* MP no disponible: mantener estado actual */ }
    }
  }

  // Vencida (con gracia interna) => expirar y devolver free.
  const graceMs = GRACE_DAYS * 24 * 60 * 60 * 1000;
  if (sub && sub.plan_ends_at && new Date(sub.plan_ends_at).getTime() + graceMs <= Date.now()) {
    await sql`UPDATE subscriptions SET status = 'expired' WHERE id = ${sub.id} AND status = 'active'`;
    sub = null;
  }

  if (!sub) return { plan: 'free', billing_period: null, status: 'active', cancel_at_period_end: false, starts_at: null, plan_ends_at: null };
  return {
    id: sub.id, plan: sub.plan, billing_period: sub.billing_period, status: 'active',
    cancel_at_period_end: sub.cancel_at_period_end, starts_at: sub.starts_at, plan_ends_at: sub.plan_ends_at,
  };
}

// ── Helper: activar la suscripción pendiente de un usuario ────────────────────
// Expira cualquier activa previa y activa la pendiente con el preapproval dado.
async function activatePendingSubscription(sql, userId, pendingSubId, preId, billing, endsAt) {
  const ends_at = endsAt ?? new Date(Date.now() + (PERIOD_DAYS[billing] ?? 30) * 24 * 60 * 60 * 1000);

  await sql`
    UPDATE subscriptions
    SET status = 'expired'
    WHERE user_id = ${userId} AND status = 'active' AND id != ${pendingSubId}
  `;
  await sql`
    UPDATE subscriptions
    SET status = 'active', mp_preapproval_id = ${preId},
        billing_period = ${billing}, ends_at = ${ends_at}
    WHERE id = ${pendingSubId}
  `;
}

// ── Helper: payer_id de MP a partir del email con el que se pagó ──────────────
// El preapproval NO expone el email del pagador, pero el PAGO sí (payer.email +
// payer.id). Escaneamos los pagos de suscripción recientes y buscamos ese email.
async function findPayerIdByEmail(mpEmail) {
  const email = mpEmail.trim().toLowerCase();
  try {
    const search = await new Payment(mp).search({
      options: { sort: 'date_created', criteria: 'desc', limit: 100 },
    });
    const match = (search.results ?? []).find(
      (p) => p.payer?.email?.toLowerCase() === email
        && p.point_of_interaction?.type === 'SUBSCRIPTIONS'
        && (p.status === 'approved' || p.status === 'authorized'),
    );
    return match?.payer?.id ?? null;
  } catch (_) { return null; }
}

// ── Helper: preapproval authorized de nuestros planes para un payer_id ────────
async function findAuthorizedPreapprovalId(payerId) {
  try {
    const search = await new PreApproval(mp).search({
      options: { payer_id: payerId, status: 'authorized' },
    });
    const ours = new Set(Object.keys(PLAN_BILLING()));
    const matches = (search.results ?? [])
      .filter((p) => p.status === 'authorized' && ours.has(p.preapproval_plan_id))
      .sort((a, b) => new Date(b.date_created ?? 0) - new Date(a.date_created ?? 0));
    return matches[0]?.id ?? null;
  } catch (_) { return null; }
}

// ── Helper: vincular un preapproval de MP a un usuario (usado por admin) ───────
// Verifica en MP que el preapproval esté authorized y sea de uno de nuestros
// planes, y crea una suscripción activa VINCULADA (con mp_preapproval_id), que
// luego se auto-renueva vía el self-heal de getActiveSubscription.
// Retorna { ok, error?, billing? }.
export async function linkPreapprovalToUser(sql, userId, preapprovalId) {
  let pre;
  try { pre = await new PreApproval(mp).get({ id: preapprovalId }); }
  catch (_) { return { ok: false, error: 'No se encontró ese preapproval en Mercado Pago' }; }

  const billing = PLAN_BILLING()[pre?.preapproval_plan_id];
  if (pre?.status !== 'authorized' || !billing)
    return { ok: false, error: 'El preapproval no está autorizado o no es de un plan de Padeleando' };

  const [taken] = await sql`
    SELECT user_id FROM subscriptions WHERE mp_preapproval_id = ${pre.id}
  `;
  if (taken && taken.user_id !== userId)
    return { ok: false, error: 'Ese preapproval ya está vinculado a otro usuario' };

  await sql`
    UPDATE subscriptions SET status = 'expired'
    WHERE user_id = ${userId} AND status = 'active'
  `;
  await sql`
    INSERT INTO subscriptions (id, user_id, plan, billing_period, status, mp_preapproval_id, ends_at)
    VALUES (${uid()}, ${userId}, 'premium', ${billing}, 'active', ${pre.id}, ${endsAtFromPreapproval(pre, billing)})
  `;
  return { ok: true, billing };
}

// ── GET /api/subscriptions/me ─────────────────────────────────────────────────
// `usage` viaja acá para que la página del plan no necesite una segunda vuelta:
// categorías creadas, torneos del mes y el pico de torneos en una sola categoría,
// que es contra lo que se compara el cupo (2 por mes EN CADA categoría).
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const [subscription, [groups], [months]] = await Promise.all([
      getActiveSubscription(sql, req.user.id),
      sql`SELECT COUNT(*)::int AS count FROM groups WHERE user_id = ${req.user.id}`,
      sql`
        SELECT COALESCE(MAX(c), 0)::int AS peak, COALESCE(SUM(c), 0)::int AS total
        FROM (
          SELECT COUNT(*) AS c
          FROM   tournaments t
          JOIN   groups g ON g.id = t.group_id
          WHERE  g.user_id = ${req.user.id}
            AND  t.created_at >= date_trunc('month', now())
          GROUP BY t.group_id
        ) x
      `,
    ]);

    res.json({
      ...subscription,
      usage: {
        groups:            groups.count,
        tournaments_month: months.total,
        tournaments_peak:  months.peak,
      },
    });
  } catch (err) { next(err); }
});

// ── POST /api/subscriptions/grant ────────────────────────────────────────────
// Endpoint admin: otorga un plan premium o período de prueba a un usuario.
// Requiere header x-admin-secret igual a la variable de entorno ADMIN_SECRET.
router.post('/grant', async (req, res, next) => {
  try {
    const adminSecret = process.env.ADMIN_SECRET;
    if (!adminSecret || req.headers['x-admin-secret'] !== adminSecret)
      return res.status(403).json({ error: 'No autorizado' });

    const { user_id, plan, billing_period } = req.body;

    if (!user_id)
      return res.status(400).json({ error: 'user_id es requerido' });

    if (!['free', 'premium'].includes(plan))
      return res.status(400).json({ error: 'plan debe ser "free" o "premium"' });

    // Para premium se requiere billing_period; para free no aplica
    if (plan === 'premium' && !BILLING_DURATIONS[billing_period])
      return res.status(400).json({ error: 'billing_period debe ser monthly, quarterly, annual o trial' });

    const sql = getDb();

    const [user] = await sql`SELECT id FROM users WHERE id = ${user_id}`;
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    // Expirar la suscripción activa anterior
    await sql`
      UPDATE subscriptions
      SET status = 'expired'
      WHERE user_id = ${user_id} AND status = 'active'
    `;

    const days     = plan === 'free' ? null : BILLING_DURATIONS[billing_period];
    const ends_at  = days ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : null;
    const bp       = plan === 'free' ? null : billing_period;

    const [created] = await sql`
      INSERT INTO subscriptions (id, user_id, plan, billing_period, status, ends_at)
      VALUES (${uid()}, ${user_id}, ${plan}, ${bp}, 'active', ${ends_at})
      RETURNING id, plan, billing_period, status, starts_at, ends_at
    `;

    res.status(201).json(created);
  } catch (err) { next(err); }
});

// ── POST /api/subscriptions/checkout ─────────────────────────────────────────
// Devuelve el link genérico de suscripción del plan de MP. NO pide el email de
// MP: el usuario paga con la cuenta que quiera. La suscripción se identifica al
// volver del pago vía el preapproval_id que MP agrega al back_url (ver /sync).
router.post('/checkout', requireAuth, async (req, res, next) => {
  try {
    const { billing_period } = req.body;
    const planId = MP_PLAN_IDS[billing_period]?.();
    if (!planId)
      return res.status(400).json({ error: 'billing_period debe ser monthly o annual' });

    const sql = getDb();

    // Guardar suscripción pendiente (sin email). Al volver del pago la activamos
    // con el preapproval_id real. Limpiamos pendientes viejas del usuario.
    await sql`
      DELETE FROM subscriptions
      WHERE user_id = ${req.user.id} AND status = 'pending'
    `;
    await sql`
      INSERT INTO subscriptions (id, user_id, plan, billing_period, status)
      VALUES (${uid()}, ${req.user.id}, 'premium', ${billing_period}, 'pending')
    `;

    const init_point = `https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_plan_id=${planId}`;
    res.json({ init_point });
  } catch (err) { next(err); }
});

// ── POST /api/subscriptions/webhook ──────────────────────────────────────────
// Recibe notificaciones de MP. Activa o cancela la suscripción según el estado.
router.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.type === 'subscription_preapproval') {
      const preapproval = await new PreApproval(mp).get({ id: body.data.id });
      const sql = getDb();

      // Determinar billing_period según el plan asociado al preapproval.
      const billing_period = PLAN_BILLING()[preapproval.preapproval_plan_id];

      // Matcheo por preapproval_id (lo guarda /sync al volver del pago). MP no
      // expone el payer_email en las suscripciones, así que no hay forma de
      // vincular un pago a un usuario desde el webhook: la vinculación la hace
      // el redirect + /sync. Acá cubrimos el ciclo de vida (cancelación, pausa,
      // renovación) de suscripciones ya vinculadas.
      const [sub] = await sql`
        SELECT id, user_id, billing_period FROM subscriptions
        WHERE mp_preapproval_id = ${preapproval.id}
      `;

      if (sub) {
        if (preapproval.status === 'authorized') {
          // Alta o renovación: vale hasta la próxima fecha de cobro de MP.
          const ends_at = endsAtFromPreapproval(preapproval, sub.billing_period ?? billing_period);

          await sql`
            UPDATE subscriptions
            SET status = 'expired'
            WHERE user_id = ${sub.user_id}
              AND status  = 'active'
              AND id     != ${sub.id}
          `;
          await sql`
            UPDATE subscriptions
            SET status = 'active', ends_at = ${ends_at}, cancel_at_period_end = false
            WHERE id = ${sub.id}
          `;
        } else if (preapproval.status === 'cancelled' || preapproval.status === 'paused') {
          // Canceló/pausó desde MP: NO cortamos el premium. Marcamos que no
          // renueva; sigue activa hasta ends_at (fin del ciclo ya pagado).
          await sql`
            UPDATE subscriptions SET cancel_at_period_end = true
            WHERE id = ${sub.id}
          `;
        }
      }
    }

    // Cobro de suscripción (alta o renovación). El PAGO sí trae payer.email, así
    // que si el usuario pagó con el mismo email de su cuenta de la app, lo
    // activamos/vinculamos automáticamente aunque no haya vuelto por el redirect.
    if (body.type === 'payment' && body.data?.id) {
      const sql = getDb();
      const payment = await new Payment(mp).get({ id: body.data.id });
      const email   = payment?.payer?.email?.toLowerCase();
      const isSub    = payment?.point_of_interaction?.type === 'SUBSCRIPTIONS';
      const approved = payment?.status === 'approved' || payment?.status === 'authorized';

      if (email && isSub && approved) {
        const [u] = await sql`SELECT id FROM users WHERE LOWER(email) = ${email} LIMIT 1`;
        if (u) {
          // ¿Ya está vinculado a una suscripción activa? Si no, vincular.
          const [active] = await sql`
            SELECT id FROM subscriptions
            WHERE user_id = ${u.id} AND status = 'active' AND mp_preapproval_id IS NOT NULL
          `;
          if (!active && payment.payer?.id) {
            const preId = await findAuthorizedPreapprovalId(payment.payer.id);
            if (preId) await linkPreapprovalToUser(sql, u.id, preId);
          }
        }
      }
    }
  } catch (_) {
    // Nunca fallar: MP necesita siempre 200 para no reintentar
  }

  res.sendStatus(200);
});

// ── GET /api/subscriptions/sync?preapproval_id=XXX ───────────────────────────
// Activa la suscripción del usuario logueado a partir del preapproval_id que MP
// agrega al back_url tras el pago. Verifica contra MP que esté autorizado y que
// pertenezca a uno de nuestros planes. La identidad la da la sesión de la app,
// así que el usuario pudo pagar con cualquier cuenta de Mercado Pago.
router.get('/sync', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const preapprovalId = req.query.preapproval_id || null;

    const [pendingSub] = await sql`
      SELECT id, billing_period FROM subscriptions
      WHERE user_id = ${req.user.id} AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (!pendingSub) return res.json({ synced: false });

    // Sin preapproval_id no hay forma de identificar el pago con la cuenta.
    if (!preapprovalId) return res.json({ synced: false });

    // Verificar el preapproval en MP.
    let pre;
    try { pre = await new PreApproval(mp).get({ id: preapprovalId }); }
    catch (_) { return res.json({ synced: false }); }

    // Debe estar autorizado y ser de uno de nuestros planes.
    const billing = PLAN_BILLING()[pre?.preapproval_plan_id];
    if (pre?.status !== 'authorized' || !billing)
      return res.json({ synced: false });

    // No permitir reclamar un preapproval ya vinculado a otro usuario.
    const [taken] = await sql`
      SELECT user_id FROM subscriptions WHERE mp_preapproval_id = ${pre.id}
    `;
    if (taken && taken.user_id !== req.user.id)
      return res.json({ synced: false });

    await activatePendingSubscription(
      sql, req.user.id, pendingSub.id, pre.id, billing, endsAtFromPreapproval(pre, billing),
    );
    res.json({ synced: true });
  } catch (err) { next(err); }
});

// ── POST /api/subscriptions/claim/start ──────────────────────────────────────
// Paso 1 del reclamo: el usuario ingresa el email de MP con el que pagó.
// Buscamos el pago→preapproval; si existe, enviamos un código de verificación A
// ESE EMAIL. Solo quien controla ese inbox (el verdadero pagador) puede activar,
// evitando que alguien reclame el pago de otra persona. Si no hay pago, avisamos
// al admin como fallback (email mal escrito o pago aún no acreditado).
router.post('/claim/start', requireAuth, async (req, res, next) => {
  try {
    const { mp_email } = req.body;
    if (!mp_email || !mp_email.trim())
      return res.status(400).json({ error: 'mp_email es requerido' });

    const sql   = getDb();
    const email = mp_email.trim().toLowerCase();

    // Verificar que exista un pago con ese email y un preapproval reclamable.
    const payerId = await findPayerIdByEmail(email);
    const preId   = payerId ? await findAuthorizedPreapprovalId(payerId) : null;

    if (preId) {
      // No permitir reclamar uno ya vinculado a otro usuario.
      const [taken] = await sql`
        SELECT user_id FROM subscriptions WHERE mp_preapproval_id = ${preId}
      `;
      if (!taken || taken.user_id === req.user.id) {
        const code       = String(Math.floor(100000 + Math.random() * 900000));
        const expires_at = new Date(Date.now() + 15 * 60 * 1000);
        await sql`
          INSERT INTO premium_claim_codes (user_id, mp_email, preapproval_id, code, expires_at)
          VALUES (${req.user.id}, ${email}, ${preId}, ${code}, ${expires_at})
          ON CONFLICT (user_id) DO UPDATE
            SET mp_email = ${email}, preapproval_id = ${preId}, code = ${code},
                expires_at = ${expires_at}, created_at = NOW()
        `;
        try {
          await resend.emails.send({
            from:    MAIL_FROM,
            to:      email,
            subject: `Tu código para activar Premium: ${code}`,
            html: `<div style="font-family:sans-serif;max-width:480px;margin:auto">
              <h2>Activá tu Premium en Padeleando</h2>
              <p>Usá este código para confirmar que sos el titular de esta cuenta de Mercado Pago:</p>
              <p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p>
              <p style="color:#666;font-size:13px">Vence en 15 minutos. Si no pediste esto, ignorá este mail.</p>
            </div>`,
          });
        } catch (mailErr) {
          return res.status(502).json({ error: 'No pudimos enviar el email. Intentá de nuevo.' });
        }
        return res.json({ sent: true });
      }
    }

    // Fallback: no encontramos un pago reclamable → avisar a los admins.
    const body   = `reclama su Premium. Pagó en Mercado Pago con el email: ${email}`;
    const admins = await sql`SELECT id FROM users WHERE role = 'admin'`;
    for (const admin of admins) {
      if (admin.id === req.user.id) continue;
      await sql`
        DELETE FROM notifications
        WHERE user_id = ${admin.id} AND type = 'premium_claim' AND actor_id = ${req.user.id}
      `;
      await sql`
        INSERT INTO notifications (id, user_id, type, actor_id, body)
        VALUES (${uid()}, ${admin.id}, 'premium_claim', ${req.user.id}, ${body})
      `;
    }

    res.json({ sent: false, notified: true });
  } catch (err) { next(err); }
});

// ── POST /api/subscriptions/claim/verify ─────────────────────────────────────
// Paso 2: el usuario ingresa el código que recibió en el email de MP. Si es
// correcto y no venció, vinculamos el preapproval y activamos el Premium.
router.post('/claim/verify', requireAuth, async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code || !String(code).trim())
      return res.status(400).json({ error: 'Ingresá el código' });

    const sql = getDb();
    const [row] = await sql`
      SELECT preapproval_id, code, expires_at FROM premium_claim_codes
      WHERE user_id = ${req.user.id}
    `;
    if (!row) return res.status(400).json({ error: 'No hay un reclamo en curso. Empezá de nuevo.' });
    if (new Date(row.expires_at) <= new Date())
      return res.status(400).json({ error: 'El código venció. Pedí uno nuevo.' });
    if (String(code).trim() !== row.code)
      return res.status(400).json({ error: 'Código incorrecto.' });

    const r = await linkPreapprovalToUser(sql, req.user.id, row.preapproval_id);
    if (!r.ok) return res.status(400).json({ error: r.error });

    await sql`DELETE FROM premium_claim_codes WHERE user_id = ${req.user.id}`;
    res.json({ activated: true });
  } catch (err) { next(err); }
});

// ── POST /api/subscriptions/cancel ───────────────────────────────────────────
// Cancela la suscripción activa del usuario en MP y en la DB.
router.post('/cancel', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();

    const [sub] = await sql`
      SELECT id, mp_preapproval_id FROM subscriptions
      WHERE user_id          = ${req.user.id}
        AND status           = 'active'
        AND mp_preapproval_id IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1
    `;

    if (!sub) return res.status(404).json({ error: 'No hay suscripción activa de Mercado Pago' });

    try {
      await new PreApproval(mp).update({ id: sub.mp_preapproval_id, body: { status: 'cancelled' } });
    } catch (_) {
      // Si MP ya canceló el preapproval (ej: el usuario canceló desde su cuenta de MP),
      // ignoramos el error y actualizamos la DB de todas formas.
    }

    // No cortamos el premium: la suscripción sigue 'active' hasta ends_at, pero
    // marcada para no renovar. El usuario conserva sus beneficios hasta esa fecha.
    await sql`
      UPDATE subscriptions SET cancel_at_period_end = true
      WHERE id = ${sub.id}
    `;

    res.json({ message: 'Suscripción cancelada' });
  } catch (err) { next(err); }
});

export default router;
