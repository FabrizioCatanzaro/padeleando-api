// Liquidación de comisiones: sin split de Mercado Pago, la inscripción entra entera al organizador
// y la comisión se le cobra después, una liquidación por torneo al cerrar la inscripción.
import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import { uid } from '../uid.js';

export const SETTLEMENT_DUE_DAYS = 7;

export const settlementRef = (id) => `set:${id}`;

/** Lo que queda por pagar: el bruto menos el saldo a favor aplicado. */
export const amountDue = (s) => Math.max(0, Number(s.amount) - Number(s.credit_applied ?? 0));

/** ¿Vencida y con saldo? Bloquea crear torneos y activar el cobro por la app. */
export const isOverdue = (s, now = new Date()) =>
  s.status === 'pending' && amountDue(s) > 0 && new Date(s.due_at) <= now;

/** Saldo a favor que se aplica a una liquidación nueva, sin pasarse de su bruto. */
export const creditToApply = (gross, available) => Math.max(0, Math.min(Number(gross), Number(available)));

const SIGNUP_CLOSED_SQL = `(t.status = 'finished' OR t.bracket IS NOT NULL
  OR NOT COALESCE(t.signup_open, g.signup_open, false)
  OR COALESCE(t.signup_closes_at, g.signup_closes_at) <= NOW())`;

/**
 * Genera las liquidaciones de los torneos del dueño con la inscripción cerrada y recalcula las pendientes
 * (un reintegro antes de pagar baja el monto; si queda en cero, se cancela). Se llama en lectura: no hay job.
 */
export async function ensureSettlements(sql, ownerId) {
  const [fresh, , [credit]] = await Promise.all([
    sql.query(`
      SELECT t.id AS tournament_id, t.name, SUM(r.fee_amount)::numeric AS amount, COUNT(*)::int AS n
      FROM tournaments t
      JOIN groups g ON g.id = t.group_id
      JOIN tournament_registrations r ON r.tournament_id = t.id AND r.payment_status = 'approved' AND r.fee_amount > 0
      WHERE g.user_id = $1 AND ${SIGNUP_CLOSED_SQL}
        AND NOT EXISTS (SELECT 1 FROM commission_settlements s WHERE s.tournament_id = t.id)
      GROUP BY t.id, t.name`, [ownerId]),
    sql.query(`
      UPDATE commission_settlements s
      SET amount = x.amount, registrations_count = x.n,
          credit_applied = LEAST(s.credit_applied, x.amount),
          status = CASE WHEN x.amount > 0 THEN 'pending' ELSE 'cancelled' END
      FROM (
        SELECT s2.id, COALESCE(SUM(r.fee_amount) FILTER (WHERE r.payment_status = 'approved'), 0)::numeric AS amount,
               COUNT(r.id) FILTER (WHERE r.payment_status = 'approved')::int AS n
        FROM commission_settlements s2
        LEFT JOIN tournament_registrations r ON r.tournament_id = s2.tournament_id AND r.fee_amount > 0
        WHERE s2.owner_id = $1 AND s2.status = 'pending'
        GROUP BY s2.id
      ) x
      WHERE s.id = x.id`, [ownerId]),
    sql.query(`SELECT ${CREDIT_SQL} AS credit`, [ownerId]),
  ]);
  if (!fresh.length) return [];

  let available = Number(credit?.credit ?? 0);
  const rows = fresh.map((f) => {
    const applied = creditToApply(f.amount, available);
    available -= applied;
    return { ...f, id: uid(), applied };
  });
  const created = await sql.query(`
    INSERT INTO commission_settlements (id, tournament_id, owner_id, amount, credit_applied, registrations_count, due_at)
    SELECT x.id, x.tid, $1, x.amount, x.applied, x.n, NOW() + make_interval(days => $2)
    FROM UNNEST($3::text[], $4::text[], $5::numeric[], $6::numeric[], $7::int[]) AS x(id, tid, amount, applied, n)
    ON CONFLICT (tournament_id) DO NOTHING
    RETURNING *`,
  [ownerId, SETTLEMENT_DUE_DAYS, rows.map((r) => r.id), rows.map((r) => r.tournament_id),
    rows.map((r) => r.amount), rows.map((r) => r.applied), rows.map((r) => r.n)]);
  const names = new Map(rows.map((r) => [r.id, r.name]));
  const due = created.filter((s) => amountDue(s) > 0);
  if (due.length) {
    await sql.query(`
      INSERT INTO notifications (id, user_id, type, entity_id, body)
      SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])`,
    [due.map(() => uid()), due.map(() => ownerId), due.map(() => 'commission_due'), due.map((s) => s.id),
      due.map((s) => names.get(s.id))]);
  }
  return created;
}

// Saldo a favor: comisiones de inscripciones reintegradas después de pagar su liquidación, menos lo ya aplicado.
const CREDIT_SQL = `(
  COALESCE((SELECT SUM(r.fee_amount) FROM tournament_registrations r
            JOIN commission_settlements s ON s.tournament_id = r.tournament_id AND s.status = 'paid'
            WHERE s.owner_id = $1 AND r.payment_status = 'refunded' AND r.refunded_at > s.paid_at), 0)
  - COALESCE((SELECT SUM(credit_applied) FROM commission_settlements WHERE owner_id = $1 AND status <> 'cancelled'), 0)
)`;

/** Liquidaciones del dueño, más recientes primero, con el saldo a favor disponible. */
export async function listSettlements(sql, ownerId) {
  await ensureSettlements(sql, ownerId);
  const [rows, [credit]] = await Promise.all([
    sql.query(`
      SELECT s.*, t.name AS tournament_name, t.group_id
      FROM commission_settlements s JOIN tournaments t ON t.id = s.tournament_id
      WHERE s.owner_id = $1 AND s.status <> 'cancelled'
      ORDER BY (s.status = 'pending') DESC, s.created_at DESC
      LIMIT 50`, [ownerId]),
    sql.query(`SELECT ${CREDIT_SQL} AS credit`, [ownerId]),
  ]);
  return {
    settlements: rows.map((s) => ({ ...s, amount_due: amountDue(s), overdue: isOverdue(s) })),
    credit: Math.max(0, Number(credit?.credit ?? 0)),
  };
}

/** null si puede; el motivo si tiene una liquidación vencida. */
export async function settlementBlockError(sql, ownerId) {
  await ensureSettlements(sql, ownerId);
  const [row] = await sql.query(`
    SELECT 1 FROM commission_settlements
    WHERE owner_id = $1 AND status = 'pending' AND due_at <= NOW() AND amount > credit_applied LIMIT 1`, [ownerId]);
  return row ? 'Hay comisiones vencidas sin pagar. Pagalas en Torneos › Organizar para crear torneos o cobrar por la app.' : null;
}

const platformMp = () => new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

export function settlementPreferenceBody({ id, amount, tournamentName, apiUrl, frontendUrl }) {
  const back = `${frontendUrl}/torneos/organizar`;
  return {
    items: [{ id, title: `Comisiones Padeleando · ${tournamentName}`.slice(0, 250), quantity: 1, unit_price: amount, currency_id: 'ARS' }],
    external_reference: settlementRef(id),
    notification_url: `${apiUrl}/api/payments/settlements/webhook?set=${id}`,
    back_urls: { success: `${back}?liquidacion=ok`, pending: `${back}?liquidacion=pendiente`, failure: `${back}?liquidacion=error` },
    ...(frontendUrl.startsWith('https://') && { auto_return: 'approved' }),
    statement_descriptor: 'PADELEANDO',
  };
}

export async function createSettlementCheckout(s) {
  const pref = await new Preference(platformMp()).create({
    body: settlementPreferenceBody({
      id: s.id, amount: amountDue(s), tournamentName: s.tournament_name,
      apiUrl: process.env.API_PUBLIC_URL, frontendUrl: process.env.FRONTEND_URL,
    }),
  });
  return { preference_id: pref.id, init_point: pref.init_point };
}

export const fetchPlatformPayment = (id) => new Payment(platformMp()).get({ id });
