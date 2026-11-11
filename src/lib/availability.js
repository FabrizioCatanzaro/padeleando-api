// Disponibilidad horaria de una inscripción a una liga en varios días.
// { slots: [{ day: 0..6 (0 = domingo), from: 'HH:MM', to: 'HH:MM' }], note }
export const MAX_SLOTS_PER_DAY = 2;
export const MAX_NOTE = 200;

const HORA = /^([01]\d|2[0-3]):(00|30)$|^24:00$/;
const minutos = (h) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3));

class AvailabilityError extends Error {}

/** Valida y normaliza; null si no hay nada cargado. */
export function parseAvailability(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new AvailabilityError('La disponibilidad no es válida');
  const slots = v.slots ?? [];
  if (!Array.isArray(slots)) throw new AvailabilityError('La disponibilidad no es válida');
  const clean = slots.map((s) => {
    const day = Number(s?.day);
    const from = String(s?.from ?? '');
    const to = String(s?.to ?? '');
    if (!Number.isInteger(day) || day < 0 || day > 6) throw new AvailabilityError('Día inválido');
    if (!HORA.test(from) || !HORA.test(to)) throw new AvailabilityError('Las horas van en pasos de 30 minutos');
    if (minutos(from) >= minutos(to)) throw new AvailabilityError('La hora de inicio tiene que ser anterior a la de fin');
    return { day, from, to };
  });
  for (let d = 0; d < 7; d++) {
    const delDia = clean.filter((s) => s.day === d).sort((a, b) => minutos(a.from) - minutos(b.from));
    if (delDia.length > MAX_SLOTS_PER_DAY) throw new AvailabilityError(`Hasta ${MAX_SLOTS_PER_DAY} rangos por día`);
    for (let i = 1; i < delDia.length; i++) {
      if (minutos(delDia[i].from) < minutos(delDia[i - 1].to)) throw new AvailabilityError('Dos rangos del mismo día se superponen');
    }
  }
  const note = String(v.note ?? '').trim();
  if (note.length > MAX_NOTE) throw new AvailabilityError(`La nota no puede superar los ${MAX_NOTE} caracteres`);
  if (clean.length === 0 && !note) return null;
  clean.sort((a, b) => a.day - b.day || minutos(a.from) - minutos(b.from));
  return { slots: clean, note: note || null };
}

/** Disponibilidades de las inscripciones aprobadas de cada pareja, por id de pareja. */
export function availabilityByPair(pairs, registrations) {
  const out = {};
  for (const p of pairs) {
    const regs = registrations.filter((r) => [r.p1_player_id, r.p2_player_id].some((id) => id && (id === p.p1_id || id === p.p2_id)));
    out[p.id] = [...new Map(regs.map((r) => [r.id, r.availability])).values()];
  }
  return out;
}

export { AvailabilityError };
