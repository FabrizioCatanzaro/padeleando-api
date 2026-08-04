// Middlewares de autorización sobre categorías. Requieren que req.user ya esté
// poblado (encadenar después de requireAuth). Devuelven 403 si no hay permiso,
// 404 si el recurso no existe.
//
// Cada guard resuelve el recurso Y el permiso en UNA sola consulta, y deja el
// resultado en req.accessCtx para que el handler no vuelva a pedir la misma
// fila. Antes eran 2-3 round-trips por mutación (buscar el group_id, leer el
// dueño y, si no lo era, buscar en co-organizadores), y varios handlers
// consultaban después el mismo torneo otra vez.
//
// Las consultas van escritas enteras y no compuestas por fragmentos: el driver
// HTTP de Neon parametriza todo lo que se interpola en el template, así que un
// fragmento anidado viajaría como valor y no como SQL.
import { getDb } from '../db.js';

// runQuery(sql, resourceId, userId) debe devolver como mínimo
// { group_id, is_owner, is_collab }.
function makeManageGuard(getResourceId, runQuery) {
  return async (req, res, next) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'No autenticado' });

      const resourceId = getResourceId(req);
      if (!resourceId) return res.status(404).json({ error: 'Recurso no encontrado' });

      const [ctx] = await runQuery(getDb(), resourceId, userId);
      if (!ctx) return res.status(404).json({ error: 'Recurso no encontrado' });
      if (!ctx.is_owner && !ctx.is_collab) return res.status(403).json({ error: 'Sin permiso' });

      req.accessCtx = ctx;
      next();
    } catch (err) { next(err); }
  };
}

// groupId viene por params (:groupId) o body.groupId.
export const requireGroupManage = makeManageGuard(
  (req) => req.params.groupId ?? req.body?.groupId ?? null,
  (sql, groupId, userId) => sql`
    SELECT g.id AS group_id,
           g.user_id AS owner_id,
           (g.user_id = ${userId}) AS is_owner,
           EXISTS (SELECT 1 FROM group_collaborators gc
                   WHERE gc.group_id = g.id AND gc.user_id = ${userId}) AS is_collab
    FROM groups g
    WHERE g.id = ${groupId}
  `
);

// Resuelve la categoría desde un torneo (:id / :tournamentId / body.tournamentId).
// Expone también format, status y mode, que varios handlers necesitaban y
// volvían a consultar por su cuenta.
export const requireTournamentManage = makeManageGuard(
  (req) => req.params.id ?? req.params.tournamentId ?? req.body?.tournamentId ?? null,
  (sql, tournamentId, userId) => sql`
    SELECT t.id AS tournament_id, t.group_id, t.format, t.status, t.mode,
           (g.user_id = ${userId}) AS is_owner,
           EXISTS (SELECT 1 FROM group_collaborators gc
                   WHERE gc.group_id = g.id AND gc.user_id = ${userId}) AS is_collab
    FROM tournaments t
    JOIN groups g ON g.id = t.group_id
    WHERE t.id = ${tournamentId}
  `
);

// Resuelve la categoría desde un partido (:id).
export const requireMatchManage = makeManageGuard(
  (req) => req.params.id ?? null,
  (sql, matchId, userId) => sql`
    SELECT m.id AS match_id, t.id AS tournament_id, t.group_id, t.format, t.status,
           (g.user_id = ${userId}) AS is_owner,
           EXISTS (SELECT 1 FROM group_collaborators gc
                   WHERE gc.group_id = g.id AND gc.user_id = ${userId}) AS is_collab
    FROM matches m
    JOIN tournaments t ON t.id = m.tournament_id
    JOIN groups g ON g.id = t.group_id
    WHERE m.id = ${matchId}
  `
);

// Resuelve la categoría desde una pareja (:id).
export const requirePairManage = makeManageGuard(
  (req) => req.params.id ?? null,
  (sql, pairId, userId) => sql`
    SELECT p.id AS pair_id, t.id AS tournament_id, t.group_id, t.format, t.status,
           (g.user_id = ${userId}) AS is_owner,
           EXISTS (SELECT 1 FROM group_collaborators gc
                   WHERE gc.group_id = g.id AND gc.user_id = ${userId}) AS is_collab
    FROM pairs p
    JOIN tournaments t ON t.id = p.tournament_id
    JOIN groups g ON g.id = t.group_id
    WHERE p.id = ${pairId}
  `
);
