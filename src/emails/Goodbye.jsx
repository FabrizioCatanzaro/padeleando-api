import { Button, Heading, Section, Text } from 'react-email';
import Layout from './Layout.jsx';

export default function Goodbye({
  name = 'jugador',
  appUrl = 'https://padeleando.ar',
  surveyUrl = 'https://padeleando.ar',
}) {
  return (
    <Layout preview="Te vamos a extrañar 💚 Tu cuenta de Padeleando fue eliminada">
      <Heading style={h1}>Te vamos a extrañar, {name} 💚</Heading>

      <Text style={p}>
        Tu cuenta de Padeleando fue eliminada y con ella tus datos personales.
        Nos pone un poco tristes verte partir, pero queríamos despedirnos como
        corresponde: gracias por haber sido parte de la comunidad.
      </Text>

      <Text style={p}>
        Las canchas siempre están abiertas y <strong>siempre hay lugar para
        volver</strong>. El día que quieras armar otro torneo, acá te vamos a
        estar esperando con la red puesta. 🎾
      </Text>

      <Section style={surveyBox}>
        <Text style={surveyLead}>
          ¿Nos regalás un minuto? Contanos por qué te vas y qué podríamos hacer
          mejor. Tu opinión nos ayuda a mejorar Padeleando para todos.
        </Text>
        <Button href={surveyUrl} style={button}>
          Responder la encuesta
        </Button>
      </Section>

      <Text style={pMuted}>
        Si cambiás de opinión, podés crear una cuenta nueva cuando quieras en{' '}
        <a href={appUrl} style={link}>padeleando.ar</a>. ¡Nos vemos en la cancha!
      </Text>
    </Layout>
  );
}

const h1 = {
  color: '#0f172a',
  fontSize: '22px',
  fontWeight: 700,
  margin: '0 0 16px',
};

const p = {
  color: '#334155',
  fontSize: '16px',
  lineHeight: '24px',
  margin: '0 0 20px',
};

const surveyBox = {
  backgroundColor: '#f0fdf4',
  border: '1px solid #bbf7d0',
  borderRadius: '12px',
  padding: '24px',
  margin: '4px 0 8px',
  textAlign: 'center',
};

const surveyLead = {
  color: '#334155',
  fontSize: '15px',
  lineHeight: '22px',
  margin: '0 0 20px',
};

const button = {
  backgroundColor: '#0f766e',
  color: '#ffffff',
  fontSize: '15px',
  fontWeight: 600,
  padding: '12px 24px',
  borderRadius: '8px',
  textDecoration: 'none',
  display: 'inline-block',
};

const link = {
  color: '#0f766e',
  fontWeight: 600,
  textDecoration: 'none',
};

const pMuted = {
  color: '#94a3b8',
  fontSize: '12px',
  margin: '24px 0 0',
  lineHeight: '18px',
};
