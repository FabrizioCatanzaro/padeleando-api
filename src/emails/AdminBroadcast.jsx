import { Section } from 'react-email';
import Layout from './Layout.jsx';
import { Eyebrow, Title } from './parts.jsx';
import { text } from './theme.js';

export default function AdminBroadcast({
  title = 'Novedades de Padeleando',
  bodyHtml = 'Hola <strong>Alex</strong>, sumamos la Copa: grupos, playoffs y copa de plata.<br />Mirá cómo funciona en <a href="https://padeleando.ar" style="color:#e8f04a;text-decoration:underline">padeleando.ar</a>.',
}) {
  return (
    <Layout preview={title}>
      <Eyebrow>Novedades</Eyebrow>
      <Title>{title}</Title>
      <Section>
        <div className="pl-rich" style={{ ...text.p, margin: 0 }} dangerouslySetInnerHTML={{ __html: bodyHtml }} />
      </Section>
    </Layout>
  );
}
