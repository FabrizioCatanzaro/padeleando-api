// Mail al jugador cuando el organizador decide su inscripción.
// Las dependencias se cargan al enviar: así los tests que importan la ruta
// no necesitan Resend ni el transformador de JSX.

export const DECISION_TEXT = {
  approved: { subject: 'Tu inscripción fue aprobada',      line: 'Ya tenés un lugar en el torneo.' },
  waitlist: { subject: 'Tu inscripción quedó en espera',   line: 'El cupo está lleno. Si se libera un lugar, el organizador puede sumarte.' },
  rejected: { subject: 'Tu inscripción no fue aprobada',   line: null },
};

/** Arma el contenido del mail. Sin efectos: se prueba sola. */
/** "Fecha 3 (7ma Caballeros)": el torneo siempre con su categoría. */
export const tournamentLabel = (name, groupName) => (groupName ? `${name} (${groupName})` : name);

export function decisionMailContent({ status, reason, tournamentName, groupName, url }) {
  const meta = DECISION_TEXT[status];
  if (!meta) return null;
  const line = status === 'rejected'
    ? (reason?.trim() || 'Por motivos que definió el organizador.')
    : meta.line;
  const label = tournamentLabel(tournamentName, groupName);
  return { subject: `${meta.subject}: ${label}`, tournamentName: label, status, line, url };
}

export async function sendDecisionMail(sql, { to, status, reason, t }) {
  if (!process.env.RESEND_API_KEY) return;
  const users = await sql`SELECT id, name, email FROM users WHERE id = ANY(${to}) AND email IS NOT NULL`;
  if (!users.length) return;
  const url = `${process.env.FRONTEND_URL ?? ''}/cat/${t.group_id}/torneo/${t.id}`;
  const content = decisionMailContent({ status, reason, tournamentName: t.name, groupName: t.group_name, url });
  if (!content) return;

  const [{ Resend }, { createElement }, { default: Template }] = await Promise.all([
    import('resend'), import('react'), import('../emails/RegistrationDecision.jsx'),
  ]);
  const resend = new Resend(process.env.RESEND_API_KEY);
  const from = process.env.MAIL_FROM || 'Padeleando <onboarding@resend.dev>';
  await Promise.all(users.map((u) => resend.emails.send({
    from, to: u.email, subject: content.subject,
    react: createElement(Template, { ...content, name: u.name }),
  }).catch((e) => console.error('mail de inscripción a', u.id, e))));
}
