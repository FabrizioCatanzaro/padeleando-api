// Campeones de la portada: la pareja que ganó la final del cuadro, con sus fotos y la portada del torneo.

const dayOf = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);

/** Marcador de la final leído desde la pareja campeona: '6-4' o '6-3 6-4'. */
export function finalScore(final) {
  if (!final?.winner_id) return null;
  const firstWon = final.winner_id === final.pair1_id;
  const sets = Array.isArray(final.sets) ? final.sets.filter((s) => s && s.s1 != null && s.s2 != null) : [];
  if (sets.length > 1) return sets.map((s) => (firstWon ? `${s.s1}-${s.s2}` : `${s.s2}-${s.s1}`)).join(' ');
  const { score1, score2 } = final;
  if (score1 == null || score2 == null || score1 === score2) return null;
  return firstWon ? `${score1}-${score2}` : `${score2}-${score1}`;
}

const player = (name, avatar, username) => ({ name: name ?? null, avatar_url: avatar ?? null, username: username ?? null });

export function championCard(row) {
  return {
    tournament_id: row.id,
    tournament_name: row.name,
    format: row.format,
    level: row.level ?? null,
    date: dayOf(row.played_on),
    group_id: row.group_id,
    group_name: row.group_name,
    club_name: row.club_name ?? null,
    cover_url: row.cover_url ?? null,
    organizer: { name: row.owner_name ?? null, username: row.owner_username ?? null },
    players: [
      player(row.p1_name, row.p1_avatar, row.p1_username),
      player(row.p2_name, row.p2_avatar, row.p2_username),
    ],
    score: finalScore(row.final),
  };
}
