import { Text } from 'react-email';
import Layout from './Layout.jsx';
import { Callout, Cta, Eyebrow, Title } from './parts.jsx';
import { color, font, text } from './theme.js';

const STATUS = {
  approved: { title: 'Inscripción aprobada', label: 'Aprobada', tone: color.green },
  waitlist: { title: 'Estás en lista de espera', label: 'Lista de espera', tone: color.amber },
  rejected: { title: 'Inscripción no aprobada', label: 'No aprobada', tone: color.danger },
};

export default function RegistrationDecision({
  name = 'Alex',
  tournamentName = 'Fecha 3 (7ma Caballeros)',
  status = 'approved',
  line = 'Ya tenés un lugar en el torneo.',
  url = 'https://padeleando.ar',
}) {
  const s = STATUS[status] ?? { title: 'Inscripción', label: 'Inscripción', tone: color.brand };
  return (
    <Layout preview={`${s.title}: ${tournamentName}`}>
      <Eyebrow tone={s.tone}>{s.label}</Eyebrow>
      <Title>{s.title}</Title>
      <Text style={text.p}>Hola, {name}. Hay novedades sobre tu inscripción.</Text>

      <Callout style={{ borderLeft: `4px solid ${s.tone}` }}>
        <Text style={kicker}>Torneo</Text>
        <Text style={tournament}>{tournamentName}</Text>
        {line ? <Text style={detail}>{line}</Text> : null}
      </Callout>

      <Cta href={url} style={{ margin: 0 }}>Ver el torneo</Cta>
    </Layout>
  );
}

const kicker = {
  color: color.muted,
  fontFamily: font.display,
  fontSize: '10px',
  lineHeight: '14px',
  fontWeight: 700,
  letterSpacing: '2px',
  textTransform: 'uppercase',
  margin: '0 0 6px',
};

const tournament = {
  color: color.white,
  fontFamily: font.display,
  fontSize: '17px',
  lineHeight: '24px',
  fontWeight: 700,
  margin: 0,
};

const detail = {
  color: color.content,
  fontFamily: font.body,
  fontSize: '15px',
  lineHeight: '22px',
  margin: '10px 0 0',
};
