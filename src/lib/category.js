// Categorías de juego.
//
// Jugador (users.category): rama C (Caballeros) o D (Damas) + número del 1 al
// 10. El 1 es el nivel más alto. Se escribe y se muestra "C7", "D4".
//
// Torneo (groups.level / tournaments.level), decisión de Fabri 2026-11-09:
//   C7, D5      categoría fija: cada jugador de esa rama y de ese número o menor nivel.
//   M6          mixto de categoría: un caballero y una dama, cada uno 6 o menor nivel.
//   SC11 SD11   suma de caballeros / damas: los números de la pareja suman 11 o más.
//   SM11        suma mixto: un caballero y una dama que suman 11 o más.
// "Menor nivel" = número igual o mayor (C8 puede jugar un torneo C7; C5 no).
// La suma usa la misma regla: C6 + C5 = 11 entra en SUMA 11; C5 + C5 = 10 no.

export const CATEGORY_RE = /^[CD]([1-9]|10)$/;
// SUMA va de 8 a 15: los valores que se juegan (Fabri, 2026-11-09).
export const LEVEL_RE    = /^([CDM]([1-9]|10)|S[CDM]([89]|1[0-5]))$/;

const normalize = (value) =>
  value === null || value === undefined || value === '' ? null : String(value).trim().toUpperCase();

/** Categoría de un jugador: 'c7' → 'C7', vacío → null. */
export function parseCategory(value) {
  const v = normalize(value);
  if (v === null) return null;
  if (!CATEGORY_RE.test(v)) throw new Error('La categoría debe ser C o D seguida de un número del 1 al 10 (por ejemplo, C7)');
  return v;
}

/** Categoría de un torneo: C7, D5, M6, SC11, SD11 o SM11. */
export function parseLevel(value) {
  const v = normalize(value);
  if (v === null) return null;
  if (!LEVEL_RE.test(v)) {
    throw new Error('La categoría del torneo debe ser C, D o M + número (C7, M6) o SUMA: SC, SD o SM + número del 8 al 15 (SC11)');
  }
  return v;
}

/** 'SC11' → { kind: 'sum', branch: 'C', value: 11 }; 'M6' → { kind: 'fixed', branch: 'M', value: 6 }. */
export function describeLevel(level) {
  if (!level || !LEVEL_RE.test(level)) return null;
  const sum = level[0] === 'S';
  return { kind: sum ? 'sum' : 'fixed', branch: sum ? level[1] : level[0], value: Number(level.slice(sum ? 2 : 1)) };
}

const splitCategory = (c) => (c && CATEGORY_RE.test(c) ? { branch: c[0], number: Number(c.slice(1)) } : null);

/**
 * ¿La inscripción cumple la categoría del torneo? `categories` son las de los
 * jugadores con cuenta (la del invitado sin cuenta llega null). Una inscripción
 * individual pasa una sola. Las faltas no bloquean: el organizador decide.
 * @returns {{ issues: string[], unknown: boolean }}
 */
export function checkRegistrationLevel(categories, level, { solo = false } = {}) {
  const lvl = describeLevel(level);
  const players = categories.map(splitCategory);
  const known = players.filter(Boolean);
  const unknown = players.some((p) => !p);
  const issues = [];
  if (!lvl) return { issues, unknown };

  const branchName = { C: 'caballeros', D: 'damas' };
  if (lvl.branch === 'M') {
    if (!solo && known.length === 2 && known[0].branch === known[1].branch) {
      issues.push('Mixto: la pareja tiene que ser un caballero y una dama');
    }
  } else {
    for (const p of known) {
      if (p.branch !== lvl.branch) issues.push(`El torneo es de ${branchName[lvl.branch]}`);
    }
  }

  if (lvl.kind === 'fixed') {
    for (const p of known) {
      if (p.number < lvl.value) issues.push(`${p.branch}${p.number} es de un nivel más alto que el torneo`);
    }
  } else if (!unknown && known.length === 2) {
    const total = known[0].number + known[1].number;
    if (total < lvl.value) issues.push(`Suman ${total}: el torneo pide ${lvl.value} o más`);
  } else if (solo && known.length === 1 && known[0].number + 10 < lvl.value) {
    issues.push(`Con ${known[0].branch}${known[0].number} ninguna pareja llega a sumar ${lvl.value}`);
  }

  return { issues: [...new Set(issues)], unknown };
}
