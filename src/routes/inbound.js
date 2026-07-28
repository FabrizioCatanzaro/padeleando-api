import { Router } from 'express';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

// Casilla a la que se reenvían los mails entrantes y remitente del reenvío.
// El remitente DEBE ser una dirección de un dominio verificado en Resend.
const FORWARD_TO   = process.env.INBOUND_FORWARD_TO   || 'fabricando.dev@gmail.com';
const FORWARD_FROM = process.env.INBOUND_FORWARD_FROM || 'Padeleando <hola@padeleando.ar>';

const WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET;

const router = Router();

// El header From del reenvío debe ser una dirección de un dominio verificado en
// Resend — no se puede poner la del remitente original. Lo que sí se puede es
// mostrarlo en el display name, que es lo que se ve en la bandeja de entrada.
// `original` viene como `"Nombre" <mail@x.com>` o como `mail@x.com` a secas.
// Devuelve solo la dirección de un `Nombre <mail@x.com>` (o el string tal cual
// si ya viene pelado).
function addressOf(value) {
  if (!value) return '';
  return (/<([^>]+)>/.exec(value)?.[1] ?? value).trim();
}

function buildForwardFrom(original) {
  if (!original) return FORWARD_FROM;

  const parsed = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(original);
  const name   = parsed ? parsed[1].replace(/^"|"$/g, '').trim() : '';
  const email  = parsed ? parsed[2].trim() : original.trim();

  // Se quita todo lo que pueda romper el header (comillas, <>, comas, saltos).
  const label = (name ? `${name} (${email})` : email)
    .replace(/["<>,\r\n]/g, '')
    .slice(0, 70);
  if (!label) return FORWARD_FROM;

  return `"${label}" <${addressOf(FORWARD_FROM)}>`;
}

// ── POST /api/emails/webhook ─────────────────────────────────────────────────
// Webhook de Resend para inbound email (evento email.received). Reenvía cada
// correo recibido en hola@padeleando.ar a la casilla configurada.
// Requiere que esta ruta reciba el body CRUDO (express.raw) para poder verificar
// la firma svix — se monta el parser raw en index.js antes de express.json().
router.post('/webhook', async (req, res) => {
  // req.body es un Buffer (express.raw). Lo pasamos como string a verify.
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);

  let event;
  if (WEBHOOK_SECRET) {
    try {
      event = resend.webhooks.verify({
        payload: raw,
        headers: {
          id:        req.headers['svix-id'],
          timestamp: req.headers['svix-timestamp'],
          signature: req.headers['svix-signature'],
        },
        webhookSecret: WEBHOOK_SECRET,
      });
    } catch (err) {
      console.error('Webhook Resend: firma inválida —', err.message);
      return res.sendStatus(401);
    }
  } else {
    // Sin secret configurado: no se puede verificar. Se procesa igual para
    // facilitar el setup inicial, pero conviene setear RESEND_WEBHOOK_SECRET.
    console.warn('Webhook Resend: RESEND_WEBHOOK_SECRET no configurado — firma no verificada');
    try { event = JSON.parse(raw); } catch { return res.sendStatus(400); }
  }

  if (event?.type !== 'email.received') {
    return res.sendStatus(200);
  }

  // Corta el bucle: si el que escribe es la propia casilla de destino, reenviar
  // le devolvería su mismo mensaje (pasa al responder a soporte@ en vez de al
  // remitente real). Se acusa 200 para que Resend no reintente.
  if (addressOf(event.data?.from).toLowerCase() === addressOf(FORWARD_TO).toLowerCase()) {
    console.warn('Webhook Resend: mail originado en la casilla de destino — no se reenvía');
    return res.sendStatus(200);
  }

  try {
    // `receiving.forward()` no permite fijar Reply-To, así que la respuesta
    // volvía a soporte@ y reentraba por el inbound. Se trae el mail y se reenvía
    // con emails.send(), que sí acepta replyTo → apunta al remitente real.
    const { data: mail, error: fetchError } = await resend.emails.receiving.get(event.data.email_id);

    if (fetchError || !mail) {
      console.error('Webhook Resend: fallo al leer el mail entrante —', fetchError);
      return res.sendStatus(500);   // 5xx → Resend reintenta
    }

    const replyTo = mail.reply_to?.length ? mail.reply_to : mail.from;

    const { error } = await resend.emails.send({
      from:    buildForwardFrom(mail.from),
      to:      FORWARD_TO,
      replyTo,
      subject: mail.subject || '(sin asunto)',
      // send exige html o text; si el original no trae ninguno se manda un texto mínimo.
      ...(mail.html ? { html: mail.html } : {}),
      ...(mail.text || !mail.html ? { text: mail.text || '(mensaje sin cuerpo)' } : {}),
    });

    if (error) {
      console.error('Webhook Resend: fallo al reenviar —', error);
      return res.sendStatus(500);
    }

    // Los adjuntos no viajan: habría que descargarlos uno a uno y re-subirlos.
    if (mail.attachments?.length) {
      console.warn(`Webhook Resend: ${mail.attachments.length} adjunto(s) no reenviado(s) — ver el mail en Resend`);
    }
  } catch (err) {
    console.error('Webhook Resend: excepción al reenviar —', err.message);
    return res.sendStatus(500);
  }

  res.sendStatus(200);
});

export default router;
