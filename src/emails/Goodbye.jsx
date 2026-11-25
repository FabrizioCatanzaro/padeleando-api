import { Link, Text } from 'react-email';
import Layout from './Layout.jsx';
import { Callout, Cta, Eyebrow, Note, Title } from './parts.jsx';
import { color, font, text } from './theme.js';

export default function Goodbye({
  name = 'Alex',
  appUrl = 'https://padeleando.ar',
  surveyUrl = 'https://padeleando.ar',
}) {
  return (
    <Layout preview="Tu cuenta de Padeleando fue eliminada. Gracias por jugar con nosotros">
      <Eyebrow tone={color.secondary}>Cuenta eliminada</Eyebrow>
      <Title>Te vamos a extrañar, {name}</Title>

      <Text style={text.p}>
        Tu cuenta de Padeleando fue eliminada y con ella tus datos personales. Gracias por haber
        sido parte de la comunidad.
      </Text>
      <Text style={text.p}>
        Las canchas siguen abiertas y <strong style={text.strong}>siempre hay lugar para volver</strong>.
        El día que quieras armar otro torneo, te esperamos con la red puesta. 🎾
      </Text>

      <Callout>
        <Text style={calloutTitle}>¿Nos regalás un minuto?</Text>
        <Text style={{ ...text.p, fontSize: '15px', lineHeight: '22px', margin: '0 0 20px' }}>
          Contanos por qué te vas y qué podríamos mejorar. Tu opinión nos ayuda a hacer un
          Padeleando mejor para todos.
        </Text>
        <Cta href={surveyUrl} style={{ margin: 0 }}>Responder encuesta</Cta>
      </Callout>

      <Note>
        Si cambiás de opinión, creá una cuenta nueva cuando quieras en{' '}
        <Link href={appUrl} style={text.link}>padeleando.ar</Link>. ¡Nos vemos en la cancha!
      </Note>
    </Layout>
  );
}

const calloutTitle = {
  color: color.white,
  fontFamily: font.display,
  fontSize: '15px',
  lineHeight: '22px',
  fontWeight: 700,
  margin: '0 0 8px',
};
