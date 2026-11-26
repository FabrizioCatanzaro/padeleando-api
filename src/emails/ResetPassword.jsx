import { Text } from 'react-email';
import Layout from './Layout.jsx';
import { Cta, Eyebrow, LinkFallback, Note, Title } from './parts.jsx';
import { text } from './theme.js';

export default function ResetPassword({
  name = 'Alex',
  resetUrl = 'https://padeleando.ar/reset-password/preview-token',
}) {
  return (
    <Layout preview="Recuperá el acceso a tu cuenta de Padeleando">
      <Eyebrow>Recuperar acceso</Eyebrow>
      <Title>Hola, {name}</Title>
      <Text style={text.p}>
        Recibimos un pedido para cambiar la contraseña de tu cuenta. Tocá el botón y elegí una nueva.
      </Text>
      <Cta href={resetUrl}>Elegir contraseña</Cta>
      <LinkFallback href={resetUrl} />
      <Note>
        El enlace vence en 1 hora. Si no lo pediste vos, ignorá este correo: tu contraseña no cambia.
      </Note>
    </Layout>
  );
}
