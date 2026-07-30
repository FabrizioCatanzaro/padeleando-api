// Helpers del perfil público (GET /groups/user/:username). Los partidos de la
// fase eliminatoria viven en tournaments.bracket (JSONB), no en la tabla
// matches: acá se expanden para que el perfil mida lo mismo que el torneo.

const ROUNDS = ['octavos', 'cuartos', 'semis'];

/** Día comparable (YYYY-MM-DD): Neon devuelve las columnas DATE como Date. */
export function dayKey(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/**
 * Expande los partidos jugados del cuadro en los que participó el usuario, con
 * la misma forma que recent_matches.
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
      if (m.winner_id == null || m.pair1_id == null || m.pair2_id == null) continue;
      if (m.score1 == null || m.score2 == null) continue;

      const p1 = pairById[String(m.pair1_id)];
      const p2 = pairById[String(m.pair2_id)];
      if (!p1 || !p2) continue;

      const isMine1 = !!p1.mine;
      const isMine2 = !!p2.mine;
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
        bracket_round:    m.round,
      });
    }
  }

  return out;
}

/**
 * Títulos de liga/parejas: gana quien tiene más victorias y, a igualdad, mejor
 * diferencia de games. Un empate en la cima cuenta como título para todos.
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

/** Racha actual y máxima, sobre resultados ordenados del más reciente al más viejo. */
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
 * Suma los partidos del cuadro a los compañeros frecuentes, agrupando por
 * partner_key igual que la consulta SQL (por nombre fusionaría homónimos).
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
      // Sólo aparece en el cuadro: no tenemos su avatar ni username.
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

const PERFECT_SET = 6;

/** Un set 6-0 a favor de quien lo ganó. */
function isPerfectSet(set) {
  if (!set) return false;
  const hi = Math.max(set.s1, set.s2), lo = Math.min(set.s1, set.s2);
  return hi === PERFECT_SET && lo === 0;
}

/**
 * Paliza: 6-0 si el partido es a un set, o todos los sets 6-0 si es a tres.
 * @param {Array} rows { my_score, opp_score, sets, sets_format, won }
 */
export function countBlowouts(rows) {
  let ganadas = 0, sufridas = 0;
  for (const r of rows) {
    const sets = Array.isArray(r.sets) ? r.sets.filter((s) => s && (s.s1 > 0 || s.s2 > 0)) : [];
    const perfect = r.sets_format === 3 && sets.length > 0
      ? sets.every(isPerfectSet)
      : Math.max(r.my_score, r.opp_score) === PERFECT_SET && Math.min(r.my_score, r.opp_score) === 0;
    if (!perfect) continue;
    if (r.my_score > r.opp_score) ganadas++;
    else sufridas++;
  }
  return { palizas_ganadas: ganadas, palizas_sufridas: sufridas };
}

/**
 * Sets, sólo sobre partidos al mejor de tres. `disponible: false` mientras no
 * exista ninguno: con un set, "sets ganados" es igual a "partidos ganados".
 */
export function countSetStats(rows) {
  const threeSet = rows.filter((r) => r.sets_format === 3 && Array.isArray(r.sets) && r.sets.length > 0);
  if (threeSet.length === 0) return { disponible: false, partidos: 0, sets_favor: 0, sets_contra: 0, remontadas: 0 };

  let favor = 0, contra = 0, remontadas = 0;
  for (const r of threeSet) {
    const jugados = r.sets.filter((s) => s && s.s1 !== s.s2);
    let perdioPrimero = false;
    jugados.forEach((s, i) => {
      const mio = r.is_team1 ? s.s1 : s.s2;
      const suyo = r.is_team1 ? s.s2 : s.s1;
      if (mio > suyo) favor++;
      else {
        contra++;
        if (i === 0) perdioPrimero = true;
      }
    });
    if (perdioPrimero && r.won) remontadas++;
  }
  return { disponible: true, partidos: threeSet.length, sets_favor: favor, sets_contra: contra, remontadas };
}

/**
 * Suma los partidos del cuadro a las series por día de la semana y por club.
 * @param {Array} weekdays { dow, partidos, victorias } — DOW de Postgres, 0 = domingo
 */
export function mergeWeekdayAndClub(weekdays, clubs, bracketMatches) {
  const byDow = new Map((weekdays ?? []).map((w) => [w.dow, { ...w }]));
  const byClub = new Map((clubs ?? []).map((c) => [String(c.id), { ...c }]));

  for (const m of bracketMatches) {
    if (m.played_at) {
      // Mediodía para que el desplazamiento horario no corra el día.
      const dow = new Date(`${m.played_at}T12:00:00`).getDay();
      const row = byDow.get(dow) ?? { dow, partidos: 0, victorias: 0 };
      row.partidos++;
      if (m.result === 'win') row.victorias++;
      byDow.set(dow, row);
    }
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

/** Partidos y victorias del cuadro por usuario, para el ranking entre seguidos. */
export function bracketStatsByUser(rows) {
  const out = new Map();
  const add = (uid, won) => {
    if (!uid) return;
    const row = out.get(String(uid)) ?? { partidos: 0, victorias: 0 };
    row.partidos++;
    if (won) row.victorias++;
    out.set(String(uid), row);
  };

  for (const row of rows) {
    if (!row.bracket) continue;
    const pairById = Object.fromEntries((row.pairs ?? []).map((p) => [String(p.id), p]));
    const matches = [
      ...ROUNDS.flatMap((r) => row.bracket[r] ?? []),
      ...(row.bracket.final ? [row.bracket.final] : []),
    ];
    for (const m of matches) {
      if (m.winner_id == null || m.pair1_id == null || m.pair2_id == null) continue;
      for (const pairId of [m.pair1_id, m.pair2_id]) {
        const pair = pairById[String(pairId)];
        if (!pair) continue;
        const won = String(m.winner_id) === String(pairId);
        (pair.user_ids ?? []).forEach((uid) => add(uid, won));
      }
    }
  }
  return out;
}

/** Ranking entre el usuario y la gente que sigue, ordenado por victorias. */
export function buildFollowRanking(rows, bracketByUser, ownerId) {
  return rows
    .map((r) => {
      const extra = bracketByUser.get(String(r.id)) ?? { partidos: 0, victorias: 0 };
      const partidos = r.partidos + extra.partidos;
      const victorias = r.victorias + extra.victorias;
      return {
        id: r.id,
        name: r.name,
        username: r.username,
        avatar_url: r.avatar_url,
        is_premium: !!r.is_premium,
        is_me: String(r.id) === String(ownerId),
        partidos,
        victorias,
        win_rate: partidos > 0 ? Math.round((victorias / partidos) * 100) : 0,
      };
    })
    .filter((r) => r.partidos > 0)
    .sort((a, b) => b.victorias - a.victorias || b.win_rate - a.win_rate || b.partidos - a.partidos);
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
