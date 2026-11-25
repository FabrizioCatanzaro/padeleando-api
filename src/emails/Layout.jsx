import { Body, Container, Head, Html, Img, Link, Preview, Section, Text } from 'react-email';
import { ASSETS_URL, SITE_URL, SUPPORT_EMAIL, color, font } from './theme.js';

const HEAD_CSS = `
  :root { color-scheme: dark; supported-color-schemes: dark; }
  @font-face { font-family: 'Albert Sans'; font-style: normal; font-weight: 400 900; src: url(${ASSETS_URL}/fonts/albert-sans-latin.woff2) format('woff2'); }
  @font-face { font-family: 'Unbounded'; font-style: normal; font-weight: 400 900; src: url(${ASSETS_URL}/fonts/unbounded-latin.woff2) format('woff2'); }
  .pl-rich strong { color: ${color.white}; }
  @media (max-width: 600px) {
    .pl-card { padding: 28px 20px !important; }
    .pl-callout { padding: 18px !important; }
    .pl-h1 { font-size: 21px !important; line-height: 28px !important; }
    .pl-cta { padding: 14px 20px !important; }
  }
`;

export default function Layout({ preview, children }) {
  return (
    <Html lang="es">
      <Head>
        <meta name="color-scheme" content="dark" />
        <meta name="supported-color-schemes" content="dark" />
        <style dangerouslySetInnerHTML={{ __html: HEAD_CSS }} />
      </Head>
      {preview ? <Preview>{preview}</Preview> : null}
      <Body style={body}>
        <Container style={container}>
          <Section style={header}>
            <Link href={SITE_URL}>
              <Img src={`${ASSETS_URL}/logo-wordmark.png`} alt="Padeleando" width="200" height="31" style={wordmark} />
            </Link>
          </Section>

          <Section style={accent} />
          <Section className="pl-card" style={card}>{children}</Section>

          <Section style={footer}>
            <Img src={`${ASSETS_URL}/logo-mark.png`} alt="" width="40" height="40" style={mark} />
            <Text style={tagline}>Tu compañero de pádel</Text>
            <Text style={footerLinks}>
              <Link href={SITE_URL} style={footerLink}>padeleando.ar</Link>
              <span style={sep}>·</span>
              <Link href={`mailto:${SUPPORT_EMAIL}`} style={footerLink}>{SUPPORT_EMAIL}</Link>
            </Text>
            <Text style={footerSmall}>Si no esperabas este correo, podés ignorarlo.</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

const body = {
  backgroundColor: color.base,
  fontFamily: font.body,
  margin: 0,
  padding: '32px 0',
};

const container = {
  maxWidth: '560px',
  margin: '0 auto',
  padding: '0 16px',
};

const header = {
  textAlign: 'center',
  padding: '0 0 28px',
};

const wordmark = {
  display: 'block',
  margin: '0 auto',
  border: 0,
};

const accent = {
  backgroundColor: color.brand,
  height: '4px',
  lineHeight: '4px',
  fontSize: '4px',
  borderRadius: '16px 16px 0 0',
};

const card = {
  backgroundColor: color.surface,
  border: `1px solid ${color.border}`,
  borderTop: 0,
  borderRadius: '0 0 16px 16px',
  padding: '36px 32px',
};

const footer = {
  textAlign: 'center',
  padding: '32px 0 0',
};

const mark = {
  display: 'block',
  margin: '0 auto 12px',
  border: 0,
};

const tagline = {
  color: color.secondary,
  fontFamily: font.display,
  fontSize: '10px',
  lineHeight: '14px',
  fontWeight: 700,
  letterSpacing: '2px',
  textTransform: 'uppercase',
  margin: '0 0 12px',
};

const footerLinks = {
  color: color.muted,
  fontFamily: font.body,
  fontSize: '13px',
  lineHeight: '20px',
  margin: '0 0 8px',
};

const footerLink = {
  color: color.content,
  textDecoration: 'none',
};

const sep = {
  color: color.muted,
  padding: '0 8px',
};

const footerSmall = {
  color: color.muted,
  fontFamily: font.body,
  fontSize: '12px',
  lineHeight: '18px',
  margin: 0,
};
