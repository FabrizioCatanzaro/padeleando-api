// Cobro online de una inscripción: preferencia de Checkout Pro con la cuenta del dueño y reintegros.
import { MercadoPagoConfig, Preference, Payment, PaymentRefund } from 'mercadopago';
import { userMpToken } from './mpAccount.js';
import { uid } from '../uid.js';

export const externalRef = (registrationId) => `reg:${registrationId}`;

/** Cuerpo de la preferencia. Sin efectivo ni cajero: tienen que acreditarse en la reserva de 30 min. */
export function preferenceBody({ registrationId, groupId, tournamentId, tournamentName, total, fee, kind, expiresAt, apiUrl, frontendUrl }) {
  const back = `${frontendUrl}/cat/${groupId}/torneo/${tournamentId}`;
  return {
    items: [{
      id: registrationId,
      title: `Inscripción ${kind === 'pair' ? 'de pareja' : 'individual'} · ${tournamentName}`.slice(0, 250),
      quantity: 1,
      unit_price: total,
      currency_id: 'ARS',
    }],
    marketplace_fee: fee,
    external_reference: externalRef(registrationId),
    notification_url: `${apiUrl}/api/registrations/mercadopago/webhook?reg=${registrationId}`,
    back_urls: { success: `${back}?pago=ok`, pending: `${back}?pago=pendiente`, failure: `${back}?pago=error` },
    ...(frontendUrl.startsWith('https://') && { auto_return: 'approved' }),
    payment_methods: { excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }] },
    expires: true,
    expiration_date_to: new Date(expiresAt).toISOString(),
    statement_descriptor: 'PADELEANDO',
  };
}

async function ownerConfig(sql, ownerId) {
  const token = await userMpToken(sql, ownerId);
  if (!token) throw new Error('El organizador no tiene Mercado Pago vinculado');
  return new MercadoPagoConfig({ accessToken: token });
}

export async function createCheckout(sql, ownerId, data) {
  const cfg = await ownerConfig(sql, ownerId);
  const pref = await new Preference(cfg).create({
    body: preferenceBody({ ...data, apiUrl: process.env.API_PUBLIC_URL, frontendUrl: process.env.FRONTEND_URL }),
  });
  return { preference_id: pref.id, init_point: pref.init_point };
}

export async function fetchPayment(sql, ownerId, paymentId) {
  return new Payment(await ownerConfig(sql, ownerId)).get({ id: paymentId });
}

/**
 * Reintegro total de una inscripción pagada online. Nunca lanza: deja el resultado en la fila
 * y, si falla (sin saldo en la cuenta del organizador, por ejemplo), avisa a quienes la gestionan.
 */
export async function refundRegistration(sql, registration, managerIds = []) {
  if (registration.payment_status !== 'approved' || !registration.mp_payment_id) return null;
  try {
    const [owner] = await sql`
      SELECT g.user_id FROM tournaments t JOIN groups g ON g.id = t.group_id WHERE t.id = ${registration.tournament_id}`;
    const cfg = await ownerConfig(sql, owner.user_id);
    await new PaymentRefund(cfg).total({ payment_id: registration.mp_payment_id });
    await sql`
      UPDATE tournament_registrations
      SET payment_status = 'refunded', refunded_at = NOW(), refund_error = NULL
      WHERE id = ${registration.id}`;
    return 'refunded';
  } catch (e) {
    const reason = String(e?.message ?? e).slice(0, 300);
    console.error('Reintegro de inscripción fallido:', registration.id, reason);
    const ids = [...new Set(managerIds.filter(Boolean))];
    await Promise.all([
      sql`UPDATE tournament_registrations SET payment_status = 'refund_failed', refund_error = ${reason}
          WHERE id = ${registration.id}`,
      ids.length ? sql`
        INSERT INTO notifications (id, user_id, type, entity_id)
        SELECT * FROM UNNEST(${ids.map(() => uid())}::text[], ${ids}::text[],
                             ${ids.map(() => 'registration_refund_failed')}::text[], ${ids.map(() => registration.id)}::text[])` : null,
    ]);
    return 'refund_failed';
  }
}
