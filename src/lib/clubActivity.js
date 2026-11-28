// Doce meses hasta el actual y los años con actividad; los jugadores son personas distintas, no filas
export function activityFrom(today) {
  const [y, m] = today.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 - 11, 1));
  return d.toISOString().slice(0, 10);
}

export function buildActivity(rows, today) {
  const [y, m] = today.split('-').map(Number);
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - 11 + i, 1));
    return { key: d.toISOString().slice(0, 7), torneos: 0, jugadores: 0 };
  });
  const byMonth = new Map(months.map((r) => [r.key, r]));
  const years = new Map();
  let total = 0;
  for (const r of rows) {
    if (r.kind === 'total') { total = r.n; continue; }
    if (r.kind === 'm') {
      const row = byMonth.get(r.key);
      if (row) row[r.serie] = r.n;
    } else if (r.kind === 'y') {
      if (!years.has(r.key)) years.set(r.key, { key: r.key, torneos: 0, jugadores: 0 });
      years.get(r.key)[r.serie] = r.n;
    }
  }
  return { months, years: [...years.values()].sort((a, b) => a.key.localeCompare(b.key)), jugadores_total: total };
}
