export const SITE_URL = 'https://padeleando.ar';
export const ASSETS_URL = `${SITE_URL}/email`;
export const SUPPORT_EMAIL = 'soporte@padeleando.ar';

export const color = {
  base: '#000000',
  surface: '#0d0d0d',
  surfaceAlt: '#141414',
  border: '#222222',
  borderStrong: '#2e2e2e',
  brand: '#e8f04a',
  brandInk: '#000000',
  cyan: '#4af0c8',
  green: '#4af07a',
  amber: '#f59e0b',
  danger: '#f04a4a',
  white: '#ffffff',
  content: '#cccccc',
  secondary: '#9e9e9e',
  muted: '#8c8c8c',
};

export const font = {
  display: "'Unbounded', 'Arial Black', Arial, Helvetica, sans-serif",
  body: "'Albert Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif",
};

export const text = {
  h1: {
    color: color.white,
    fontFamily: font.display,
    fontSize: '24px',
    lineHeight: '32px',
    fontWeight: 700,
    letterSpacing: '-0.2px',
    margin: '0 0 16px',
  },
  p: {
    color: color.content,
    fontFamily: font.body,
    fontSize: '16px',
    lineHeight: '26px',
    margin: '0 0 24px',
  },
  small: {
    color: color.muted,
    fontFamily: font.body,
    fontSize: '13px',
    lineHeight: '20px',
    margin: '0',
  },
  strong: {
    color: color.white,
    fontWeight: 700,
  },
  link: {
    color: color.brand,
    textDecoration: 'underline',
  },
};
