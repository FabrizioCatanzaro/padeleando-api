import { Button, Heading, Link, Section, Text } from 'react-email';
import { color, font, text } from './theme.js';

export function Eyebrow({ children, tone = color.brand }) {
  return (
    <Text style={{ ...eyebrow, color: tone }}>
      <span style={{ ...dot, backgroundColor: tone }} />
      {children}
    </Text>
  );
}

export function Title({ children }) {
  return <Heading as="h1" className="pl-h1" style={text.h1}>{children}</Heading>;
}

export function Cta({ href, children, style }) {
  return (
    <Section style={{ ...ctaWrap, ...style }}>
      <Button href={href} className="pl-cta" style={cta}>{children}</Button>
    </Section>
  );
}

export function Callout({ children, style }) {
  return <Section className="pl-callout" style={{ ...callout, ...style }}>{children}</Section>;
}

export function LinkFallback({ href }) {
  return (
    <Callout style={{ padding: '14px 16px', margin: '0 0 20px' }}>
      <Text style={{ ...text.small, margin: '0 0 6px' }}>¿El botón no funciona? Copiá este enlace:</Text>
      <Link href={href} style={fallbackLink}>{href}</Link>
    </Callout>
  );
}

export function Note({ children }) {
  return <Text style={text.small}>{children}</Text>;
}

const eyebrow = {
  fontFamily: font.display,
  fontSize: '11px',
  lineHeight: '16px',
  fontWeight: 700,
  letterSpacing: '2px',
  textTransform: 'uppercase',
  margin: '0 0 14px',
};

const dot = {
  display: 'inline-block',
  width: '8px',
  height: '8px',
  borderRadius: '8px',
  marginRight: '8px',
  verticalAlign: '1px',
};

const ctaWrap = {
  margin: '0 0 24px',
};

const cta = {
  backgroundColor: color.brand,
  color: color.brandInk,
  fontFamily: font.display,
  fontSize: '13px',
  lineHeight: '16px',
  fontWeight: 700,
  letterSpacing: '1px',
  textTransform: 'uppercase',
  textDecoration: 'none',
  padding: '16px 28px',
  borderRadius: '12px',
  display: 'inline-block',
};

const callout = {
  backgroundColor: color.surfaceAlt,
  border: `1px solid ${color.border}`,
  borderRadius: '14px',
  padding: '24px',
  margin: '0 0 24px',
};

const fallbackLink = {
  color: color.brand,
  fontFamily: font.body,
  fontSize: '12px',
  lineHeight: '18px',
  wordBreak: 'break-all',
  textDecoration: 'underline',
};
