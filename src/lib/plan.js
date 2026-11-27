// Cupos del plan Gratis: siempre contra el DUEÑO de la categoría.
import { getActiveSubscription } from '../routes/subscriptions.js';
import { hasRole } from './planCatalog.js';

export * from './planCatalog.js';

export const FREE_MAX_GROUPS             = 2;
export const FREE_TOURNAMENTS_PER_MONTH  = 2;
export const FREE_COPAS_PER_MONTH        = 1;

export async function hasPlanRole(sql, userId, role) {
  const sub = await getActiveSubscription(sql, userId);
  return hasRole(sub.plan, role);
}

export const isOrganizerPlan = (sql, userId) => hasPlanRole(sql, userId, 'organizador');

// null si puede crear; el mensaje de error si el cupo está lleno.
export async function groupQuotaError(sql, userId) {
  const [organizer, [{ count }]] = await Promise.all([
    isOrganizerPlan(sql, userId),
    sql`SELECT COUNT(*)::int AS count FROM groups WHERE user_id = ${userId}`,
  ]);
  if (organizer || count < FREE_MAX_GROUPS) return null;
  return `El plan Gratis permite ${FREE_MAX_GROUPS} categorías. Tenés ${count}: pasate al plan Organizador para crear más.`;
}

export async function tournamentQuotaError(sql, groupId, ownerId, { format = 'liga' } = {}) {
  const [organizer, [{ count, copas }]] = await Promise.all([
    isOrganizerPlan(sql, ownerId),
    sql`
      SELECT COUNT(*)::int AS count,
             COUNT(*) FILTER (WHERE format = 'copa')::int AS copas
      FROM   tournaments
      WHERE  group_id = ${groupId}
        AND  created_at >= date_trunc('month', now())
    `,
  ]);
  return quotaMessage({ organizer, count, copas, format });
}

/** Mensaje del cupo mensual, o null si se puede crear. */
export function quotaMessage({ organizer, count, copas, format }) {
  if (organizer) return null;
  if (format === 'copa' && copas >= FREE_COPAS_PER_MONTH) {
    return `El plan Gratis permite ${FREE_COPAS_PER_MONTH} copa por mes en cada categoría. Pasate al plan Organizador para crear más.`;
  }
  if (count < FREE_TOURNAMENTS_PER_MONTH) return null;
  return `El plan Gratis permite ${FREE_TOURNAMENTS_PER_MONTH} torneos por mes en cada categoría. Pasate al plan Organizador para crear más.`;
}
