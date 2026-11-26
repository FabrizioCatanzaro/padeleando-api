import { Text } from 'react-email';
import Layout from './Layout.jsx';
import { Cta, Eyebrow, LinkFallback, Note, Title } from './parts.jsx';
import { text } from './theme.js';

export default function VerifyEmail({
  name = 'Alex',
  verifyUrl = 'https://padeleando.ar/verify-email/preview-token',
}) {
  return (
    <Layout preview="Confirmá tu email para empezar a usar Padeleando">
      <Eyebrow>Confirmá tu email</Eyebrow>
      <Title>¡Hola, {name}! 👋</Title>
      <Text style={text.p}>
        Estás a un paso de empezar a usar Padeleando. Confirmá tu email y armá tu primer torneo,
        sumate a un amistoso o seguí tus estadísticas.
      </Text>
      <Cta href={verifyUrl}>Confirmar email</Cta>
      <LinkFallback href={verifyUrl} />
      <Note>El enlace vence en 24 horas. Si no creaste una cuenta, ignorá este correo.</Note>
    </Layout>
  );
}
