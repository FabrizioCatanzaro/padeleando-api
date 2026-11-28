const DAY = 1440;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function addDaysStr(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Turnos en el orden del cliente; un horario menor al anterior cae en el día siguiente
export function expandBookingSlots(date, slots, slotMinutes, max) {
  if (!Array.isArray(slots) || !slots.length || slots.length > max || !slots.every((s) => typeof s === 'string' && TIME_RE.test(s))) {
    return { error: 'Horario inválido' };
  }
  const items = [];
  let day = date;
  let prev = null;
  for (const time of slots) {
    const m = timeToMinutes(time);
    if (prev != null) {
      if ((m - prev + DAY) % DAY !== slotMinutes) return { error: 'Los turnos elegidos tienen que ser consecutivos' };
      if (m < prev) day = addDaysStr(day, 1);
    }
    items.push({ date: day, start_time: time });
    prev = m;
  }
  return { items };
}

// Primer turno dentro del horizonte; el día siguiente al último solo vale de madrugada
export function withinHorizon(date, firstTime, today, horizonDays) {
  const last = addDaysStr(today, horizonDays - 1);
  if (date < today) return false;
  if (date <= last) return true;
  return date === addDaysStr(last, 1) && timeToMinutes(firstTime) < 12 * 60;
}
