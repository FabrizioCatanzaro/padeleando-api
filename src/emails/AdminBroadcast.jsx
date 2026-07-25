import { Heading, Section } from 'react-email';
import Layout from './Layout.jsx';

// Mensaje enviado por el equipo/admin de Padeleando. El cuerpo llega ya renderizado
// a HTML (desde lib/richText.js#mdToHtml), con negrita, itálica y enlaces.
export default function AdminBroadcast({
  title = 'Novedades de Padeleando',
  bodyHtml = '',
}) {
  return (
    <Layout preview={title}>
      <Heading style={h1}>{title}</Heading>
      <Section style={bodyWrap}>
        <div style={bodyText} dangerouslySetInnerHTML={{ __html: bodyHtml }} />
      </Section>
    </Layout>
  );
}

const h1 = {
  color: '#0f172a',
  fontSize: '22px',
  fontWeight: 700,
  margin: '0 0 16px',
};

const bodyWrap = {
  margin: '0 0 8px',
};

const bodyText = {
  color: '#334155',
  fontSize: '16px',
  lineHeight: '24px',
};
