import { Column, Row, Section, Text } from 'react-email';
import Layout from './Layout.jsx';
import { Cta, Eyebrow, Note, Title } from './parts.jsx';
import { color, font, text } from './theme.js';

const FEATURES = [
  { emoji: '🏆', title: 'Torneos a tu medida', desc: 'Liga, Americano o Copa, con parejas fijas o jugadores libres.' },
  { emoji: '🤝', title: 'Amistosos que suman', desc: 'Armá un 2 vs 2, cargá el resultado y sumalo a tu perfil.' },
  { emoji: '⚡', title: 'Resultados en vivo', desc: 'Cargá partidos y mirá las posiciones al instante.' },
  { emoji: '🔗', title: 'Compartí con un link', desc: 'Cualquiera puede seguir tu torneo, sin crear cuenta.' },
  { emoji: '📈', title: 'Tu perfil y tus números', desc: 'Win %, rachas, compañeros frecuentes y títulos.' },
];

export default function Welcome({
  name = 'Alex',
  appUrl = 'https://padeleando.ar',
}) {
  return (
    <Layout preview="Te damos la bienvenida a Padeleando. Tu cuenta ya está activa">
      <Eyebrow tone={color.green}>Cuenta activa</Eyebrow>
      <Title>¡Ya sos parte, {name}! 🎾</Title>
      <Text style={text.p}>Confirmaste tu email. Esto es lo que podés hacer desde hoy:</Text>

      <Section style={list}>
        {FEATURES.map((f) => (
          <Row key={f.title} style={row}>
            <Column style={iconCell}>
              <Text style={icon}>{f.emoji}</Text>
            </Column>
            <Column style={copyCell}>
              <Text style={featureTitle}>{f.title}</Text>
              <Text style={featureDesc}>{f.desc}</Text>
            </Column>
          </Row>
        ))}
      </Section>

      <Cta href={appUrl}>Empezar a jugar</Cta>
      <Note>¿Dudas o ideas? Respondé este correo y te leemos. ¡Nos vemos en la cancha!</Note>
    </Layout>
  );
}

const list = {
  margin: '0 0 28px',
};

const row = {
  marginBottom: '14px',
};

const iconCell = {
  width: '44px',
  verticalAlign: 'top',
};

const icon = {
  width: '44px',
  height: '44px',
  lineHeight: '44px',
  fontSize: '20px',
  textAlign: 'center',
  backgroundColor: color.surfaceAlt,
  border: `1px solid ${color.border}`,
  borderRadius: '12px',
  margin: 0,
};

const copyCell = {
  paddingLeft: '14px',
  verticalAlign: 'top',
};

const featureTitle = {
  color: color.white,
  fontFamily: font.body,
  fontSize: '15px',
  lineHeight: '22px',
  fontWeight: 700,
  margin: '2px 0 0',
};

const featureDesc = {
  color: color.secondary,
  fontFamily: font.body,
  fontSize: '14px',
  lineHeight: '20px',
  margin: 0,
};
