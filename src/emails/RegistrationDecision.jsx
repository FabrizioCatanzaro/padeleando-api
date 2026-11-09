import { Button, Heading, Text } from 'react-email';
import Layout from './Layout.jsx';

const TITLE = {
  approved: 'Inscripción aprobada',
  waitlist: 'Inscripción en lista de espera',
  rejected: 'Inscripción no aprobada',
};

export default function RegistrationDecision({
  name = 'jugador',
  tournamentName = 'el torneo',
  status = 'approved',
  line = '',
  url = 'https://padeleando.ar',
}) {
  return (
    <Layout preview={`${TITLE[status] ?? 'Inscripción'}: ${tournamentName}`}>
      <Heading style={h1}>{TITLE[status] ?? 'Inscripción'}</Heading>
      <Text style={p}>Hola {name}. Novedades de tu inscripción a <strong>{tournamentName}</strong>.</Text>
      <Text style={p}>{line}</Text>
      <Button href={url} style={button}>Ver el torneo</Button>
    </Layout>
  );
}

const h1 = { color: '#0f172a', fontSize: '22px', fontWeight: 700, margin: '0 0 16px' };
const p = { color: '#334155', fontSize: '16px', lineHeight: '24px', margin: '0 0 20px' };
const button = {
  backgroundColor: '#0f766e', color: '#ffffff', fontSize: '15px', fontWeight: 600,
  padding: '12px 24px', borderRadius: '8px', textDecoration: 'none', display: 'inline-block',
};
