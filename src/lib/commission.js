// Comisión del cobro online de inscripciones. Espejo en padeliando/src/utils/commission.js.
export const RATES = {
  free:        { pct: 0.06, min: 500 },
  organizador: { pct: 0.03, min: 300 },
};

export const FEE_PAYERS = ['player', 'organizer'];

export const rateFor = (organizerPlan) => (organizerPlan ? RATES.organizador : RATES.free);

/** Comisión por jugador: porcentaje del precio por jugador, con mínimo, en pesos enteros. */
export function feePerPlayer(pricePerPlayer, organizerPlan = false) {
  const { pct, min } = rateFor(organizerPlan);
  return Math.round(Math.max(pricePerPlayer * pct, min));
}

/**
 * Montos de una inscripción. `price` es el que cargó el organizador, por jugador o por pareja.
 * @returns {{ players, base, fee, total, net }}
 */
export function quote({ price, unit = 'player', kind = 'solo', payer = 'player', organizerPlan = false, waived = false }) {
  const players = kind === 'pair' ? 2 : 1;
  const perPlayer = unit === 'pair' ? price / 2 : price;
  const base = Math.round(perPlayer * players);
  const fee = waived ? 0 : feePerPlayer(perPlayer, organizerPlan) * players;
  if (payer === 'organizer') return { players, base, fee, total: base, net: base - fee };
  return { players, base, fee, total: base + fee, net: base };
}

/** null si se puede cobrar online; el motivo si no. */
export function onlinePriceError({ price, unit = 'player', payer = 'player', organizerPlan = false }) {
  if (!Number.isInteger(price) || price <= 0) return 'Para cobrar online, cargá un precio mayor a 0';
  const { net } = quote({ price, unit, kind: unit === 'pair' ? 'pair' : 'solo', payer, organizerPlan });
  if (net <= 0) return 'Con ese precio la comisión supera lo que cobrás. Subí el precio o que la pague el jugador';
  return null;
}
