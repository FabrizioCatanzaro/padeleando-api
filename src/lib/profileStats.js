// Helpers del perfil público (GET /groups/user/:username).
//
// Los partidos de la fase eliminatoria de un americano NO viven en la tabla
// `matches`: están dentro de `tournaments.bracket` (JSONB). Todas las stats del
// perfil se calculaban en SQL contra `matches`, así que un usuario veía
// "campeón americano: 1" pero los partidos con los que ganó ese título no
// contaban en sus partidos, victorias, racha, games ni actividad. Estas
// funciones expanden el bracket para que el perfil mida lo mismo que la vista
// del torneo (ver getAllMatches en src/components/Stats/Stats.jsx).

const ROUNDS = ['octavos', 'cuartos', 'semis'];

/**
 * Día comparable (YYYY-MM-DD) de un played_at. El driver de Neon devuelve las
 * columnas DATE como objetos Date, y `String(date).slice(0, 10)` da "Tue Jul
 * 28": ordenar por eso es ordenar por día de la semana. Los partidos del cuadro
 * ya vienen como texto porque los castea la consulta.
 */
export function dayKey(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/**
 * Expande los partidos jugados del bracket en los que participó el usuario.
 * @param {Array} rows filas de la consulta de brackets: { tournament_id, group_id,
 *   tournament_name, day, bracket, pairs: [{ id, mine, my_index, names: [n1, n2] }] }
 * @returns {Array} partidos normalizados con la misma forma que recent_matches
 */
export function expandBracketMatches(rows) {
  const out = [];

  for (const row of rows) {
    const bracket = row.bracket;
    if (!bracket) continue;

    const pairById = Object.fromEntries((row.pairs ?? []).map((p) => [String(p.id), p]));

    const matches = [
      ...ROUNDS.flatMap((r) => (bracket[r] ?? []).map((m) => ({ ...m, round: r }))),
      ...(bracket.final ? [{ ...bracket.final, round: 'final' }] : []),
    ];

    for (const m of matches) {
      // Sin winner_id el partido no se jugó todavía.
      if (m.winner_id == null || m.pair1_id == null || m.pair2_id == null) continue;
      if (m.score1 == null || m.score2 == null) continue;

      const p1 = pairById[String(m.pair1_id)];
      const p2 = pairById[String(m.pair2_id)];
      if (!p1 || !p2) continue;

      const isMine1 = !!p1.mine;
      const isMine2 = !!p2.mine;
      // Una pareja del usuario contra otra pareja del usuario es imposible
      // (un jugador está en una sola pareja), pero si pasara se contaría una vez.
      if (!isMine1 && !isMine2) continue;

      const mine  = isMine1 ? p1 : p2;
      const other = isMine1 ? p2 : p1;
      const myScore  = isMine1 ? m.score1 : m.score2;
      const oppScore = isMine1 ? m.score2 : m.score1;

      const partnerIdx  = mine.my_index === 0 ? 1 : 0;
      const partnerName = mine.names?.[partnerIdx];
      const partnerKey  = mine.keys?.[partnerIdx];

      out.push({
        id:               `bracket:${row.tournament_id}:${m.id}`,
        played_at:        row.day,
        score1:           myScore,
        score2:           oppScore,
        tournament_id:    row.tournament_id,
        group_id:         row.group_id,
        tournament_name:  row.tournament_name,
        result:           myScore > oppScore ? 'win' : myScore < oppScore ? 'loss' : 'draw',
        my_score:         myScore,
        opp_score:        oppScore,
        partner_name:     partnerName ?? null,
        partner_key:      partnerKey ?? null,
        duration_seconds: m.duration_seconds ?? null,
        club_id:          row.club_id ?? null,
        opp1_name:        other.names?.[0] ?? null,
        opp2_name:        other.names?.[1] ?? null,
        // Marca para la UI: no es un partido de la tabla `matches`.
        bracket_round:    m.round,
      });
    }
  }

  return out;
}

/**
 * Cuenta los títulos de liga/parejas del usuario a partir de las filas
 * agregadas por (torneo, jugador). Replica la lógica cliente de
 * getTournamentWinnerLabel: gana quien tiene más victorias y, a igualdad,
 * mejor diferencia de games; los empates en la cima cuentan como título para
 * todos los involucrados.
 * @param {Array} rows { tournament_id, mine, pj, pg, diff }
 */
export function countLeagueTitles(rows) {
  const byTournament = {};
  for (const r of rows) {
    if (r.pj <= 0) continue;
    (byTournament[r.tournament_id] ??= []).push(r);
  }

  let titles = 0;
  for (const players of Object.values(byTournament)) {
    const topPg   = Math.max(...players.map((p) => p.pg));
    if (topPg <= 0) continue;
    const topDiff = Math.max(...players.filter((p) => p.pg === topPg).map((p) => p.diff));
    const won = players.some((p) => p.mine && p.pg === topPg && p.diff === topDiff);
    if (won) titles++;
  }
  return titles;
}

/**
 * Deriva la racha actual y la máxima de una lista de resultados ordenada de
 * más reciente a más antiguo.
 * @param {Array<{won: boolean}>} results
 */
export function calcStreaks(results) {
  let racha = 0, rachaMax = 0, streak = 0, currentDone = false;
  for (const row of results) {
    if (row.won) {
      streak++;
      rachaMax = Math.max(rachaMax, streak);
      if (!currentDone) racha = streak;
    } else {
      currentDone = true;
      streak = 0;
    }
  }
  return { racha, racha_max: rachaMax };
}

/**
 * Suma los partidos del bracket al conteo de compañeros frecuentes. Se agrupa
 * por partner_key (user_id del compañero, o su player_id si no tiene cuenta),
 * la misma clave que usa la consulta SQL: agrupar por nombre fusionaría
 * homónimos.
 * @param {Array} partners filas de la consulta, ya ordenadas desc
 * @param {Array} bracketMatches salida de expandBracketMatches
 * @param {number} limit cuántos devolver
 */
export function mergeFrequentPartners(partners, bracketMatches, limit = 5) {
  const byKey = new Map();
  for (const p of partners) byKey.set(String(p.partner_key), { ...p });

  for (const m of bracketMatches) {
    if (m.partner_key == null) continue;
    const key = String(m.partner_key);
    const row = byKey.get(key);
    if (row) {
      row.partidos_juntos++;
    } else {
      // Compañero que sólo aparece en la fase eliminatoria: no tenemos su
      // avatar ni username porque la consulta de arriba no lo trajo.
      byKey.set(key, {
        partner_key:     m.partner_key,
        name:            m.partner_name,
        username:        null,
        avatar_url:      null,
        is_premium:      false,
        partidos_juntos: 1,
      });
    }
  }

  return [...byKey.values()]
    .sort((a, b) => b.partidos_juntos - a.partidos_juntos)
    .slice(0, limit);
}

/**
 * Suma los partidos del cuadro a las series por día de la semana y por club.
 * Sin esto el americano quedaría fuera justo de las dos dimensiones donde más
 * se nota (la final se juega el mismo día y en el mismo club que la previa).
 * @param {Array} weekdays filas { dow, partidos, victorias } — DOW de Postgres, 0 = domingo
 * @param {Array} clubs filas { id, name, location_name, partidos, victorias, torneos }
 */
export function mergeWeekdayAndClub(weekdays, clubs, bracketMatches) {
  const byDow = new Map((weekdays ?? []).map((w) => [w.dow, { ...w }]));
  const byClub = new Map((clubs ?? []).map((c) => [String(c.id), { ...c }]));

  for (const m of bracketMatches) {
    if (m.played_at) {
      // played_at viene como YYYY-MM-DD: se parsea a mediodía para que el
      // desplazamiento horario no corra el día.
      const dow = new Date(`${m.played_at}T12:00:00`).getDay();
      const row = byDow.get(dow) ?? { dow, partidos: 0, victorias: 0 };
      row.partidos++;
      if (m.result === 'win') row.victorias++;
      byDow.set(dow, row);
    }
    // Un club que sólo aparece en el cuadro es imposible (la previa del mismo
    // torneo ya lo trajo), así que sólo se incrementa lo que ya existe.
    const club = m.club_id != null ? byClub.get(String(m.club_id)) : null;
    if (club) {
      club.partidos++;
      if (m.result === 'win') club.victorias++;
    }
  }

  return {
    weekdayStats: [...byDow.values()].sort((a, b) => a.dow - b.dow),
    clubStats: [...byClub.values()].sort((a, b) => b.partidos - a.partidos),
  };
}

/** Suma los partidos del bracket a las series diaria y mensual. */
export function mergeActivity(dailyActivity, monthlyStats, bracketMatches) {
  const daily = Object.fromEntries((dailyActivity ?? []).map((d) => [d.day, d.partidos]));
  const monthly = Object.fromEntries(
    (monthlyStats ?? []).map((m) => [m.month, { partidos: m.partidos, victorias: m.victorias }])
  );

  for (const m of bracketMatches) {
    if (!m.played_at) continue;
    daily[m.played_at] = (daily[m.played_at] ?? 0) + 1;

    const month = m.played_at.slice(0, 7);
    const row = (monthly[month] ??= { partidos: 0, victorias: 0 });
    row.partidos++;
    if (m.result === 'win') row.victorias++;
  }

  return {
    dailyActivity: Object.entries(daily)
      .map(([day, partidos]) => ({ day, partidos }))
      .sort((a, b) => (a.day < b.day ? -1 : 1)),
    monthlyStats: Object.entries(monthly)
      .map(([month, v]) => ({ month, ...v }))
      .sort((a, b) => (a.month < b.month ? -1 : 1)),
  };
}
