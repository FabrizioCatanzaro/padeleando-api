// Cupos del plan free. Se evalúan siempre contra el DUEÑO de la categoría, nunca
// contra quien ejecuta la acción (un co-organizador premium no evade el límite).
//
// Al caer de premium a free NO se toca nada de lo ya creado: las categorías y las
// jornadas de más siguen funcionando enteras. El cupo sólo frena la creación de
// algo nuevo, así que se compara contra el total actual y no contra un excedente.
import { getActiveSubscription } from '../routes/subscriptions.js';

export const FREE_MAX_GROUPS             = 2;
export const FREE_TOURNAMENTS_PER_MONTH  = 2;

export async function isPremium(sql, userId) {
  const sub = await getActiveSubscription(sql, userId);
  return sub.plan === 'premium';
}

// null si puede crear; el mensaje de error si el cupo está lleno.
export async function groupQuotaError(sql, userId) {
  const [premium, [{ count }]] = await Promise.all([
    isPremium(sql, userId),
    sql`SELECT COUNT(*)::int AS count FROM groups WHERE user_id = ${userId}`,
  ]);
  if (premium || count < FREE_MAX_GROUPS) return null;
  return `El plan Básico permite ${FREE_MAX_GROUPS} categorías. Tenés ${count}: hacete Premium para crear más.`;
}

// Cupo mensual de jornadas, contado por categoría y por mes calendario de
// created_at — la misma cuenta que ya hacía la UI.
export async function tournamentQuotaError(sql, groupId, ownerId) {
  const [premium, [{ count }]] = await Promise.all([
    isPremium(sql, ownerId),
    sql`
      SELECT COUNT(*)::int AS count
      FROM   tournaments
      WHERE  group_id = ${groupId}
        AND  created_at >= date_trunc('month', now())
    `,
  ]);
  if (premium || count < FREE_TOURNAMENTS_PER_MONTH) return null;
  return `El plan Básico permite ${FREE_TOURNAMENTS_PER_MONTH} torneos por mes en cada categoría. Hacete Premium para crear más.`;
}
