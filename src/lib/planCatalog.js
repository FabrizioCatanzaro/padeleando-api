export const PLANS = ['jugador_plus', 'organizador', 'combo', 'club'];
export const BILLINGS = ['monthly', 'annual'];

// premium es el plan único anterior a los planes por rol: vale como combo.
const ROLES = {
  premium:      ['jugador', 'organizador'],
  jugador_plus: ['jugador'],
  organizador:  ['organizador'],
  combo:        ['jugador', 'organizador'],
  club:         ['jugador', 'organizador', 'club'],
};

export const PAID_PLANS = Object.keys(ROLES);
export const rolesOf = (plan) => ROLES[plan] ?? [];
export const hasRole = (plan, role) => rolesOf(plan).includes(role);
export const plansWith = (role) => PAID_PLANS.filter((p) => ROLES[p].includes(role));

export const PLAYER_PLANS    = plansWith('jugador');
export const ORGANIZER_PLANS = plansWith('organizador');

export const CLUB_PLAN_ENABLED = false;
export const CLUB_MIN_PRICE    = 30000;

export function isPurchasable(plan) {
  if (!PLANS.includes(plan)) return false;
  return plan !== 'club' || CLUB_PLAN_ENABLED;
}

export function mpPlanEnvKey(plan, billing) {
  if (!PAID_PLANS.includes(plan) || !BILLINGS.includes(billing)) return null;
  if (plan === 'premium') return `MP_PLAN_ID_${billing.toUpperCase()}`;
  return `MP_PLAN_ID_${plan.toUpperCase()}_${billing.toUpperCase()}`;
}

/** preapproval_plan_id de Mercado Pago → { plan, billing }. */
export function mpPlanIndex(env = process.env) {
  const out = {};
  for (const plan of PAID_PLANS) {
    for (const billing of BILLINGS) {
      const id = env[mpPlanEnvKey(plan, billing)];
      if (id) out[id] = { plan, billing };
    }
  }
  return out;
}

/** Abono del club: canchas activas × promedio del turno de 1 h, con piso. */
export function clubMonthlyPrice(courts = []) {
  const active = courts.filter((c) => c.active !== false);
  const priced = active.map((c) => Number(c.price_60)).filter((p) => Number.isFinite(p) && p > 0);
  if (!active.length || !priced.length) return CLUB_MIN_PRICE;
  const avg = priced.reduce((a, b) => a + b, 0) / priced.length;
  return Math.max(CLUB_MIN_PRICE, Math.round(active.length * avg));
}
