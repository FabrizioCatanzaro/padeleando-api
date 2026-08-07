<div align="center">

# 🎾 Padeleando — API

**API REST que respalda [Padeleando](https://padeleando.ar), la plataforma para organizar torneos de pádel.**

[![Express](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)](https://expressjs.com)
[![Node](https://img.shields.io/badge/Node-22-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![PostgreSQL](https://img.shields.io/badge/Neon_Postgres-336791?logo=postgresql&logoColor=white)](https://neon.tech)
[![Render](https://img.shields.io/badge/Render-46E3B7?logo=render&logoColor=black)](https://render.com)

</div>

---

Este es el backend. El **frontend React vive en [`padeliando`](https://github.com/FabrizioCatanzaro/padeliando)**, y ahí está la descripción completa del producto, las capturas y las decisiones de arquitectura.

## Qué resuelve

Categorías y jornadas de pádel, en formato Liga o Americano: jugadores, parejas, partidos, bracket eliminatorio, fotos, invitaciones, co-organizadores, clubes, notificaciones y suscripciones. Todo sobre Postgres serverless, desplegado en Render.

## Stack

Node + **Express 5** · **Neon serverless PostgreSQL** (driver HTTP y WebSocket) · **JWT** + Bcrypt · **Cloudinary** (avatares y fotos) · **Resend** con plantillas React Email · **Mercado Pago** (preapprovals) · Google OAuth · `tsx` como runtime

## Superficie

```
/api/home            portada pública en una sola consulta
/api/auth            registro, login, Google OAuth, refresh, reset, verificación, avatar
/api/groups          categorías, búsqueda, cercanía y perfiles públicos (/user/:username)
/api/tournaments     jornadas, bracket, fixture, partido en vivo
/api/matches         · /api/pairs · /api/players
/api/clubs           clubes y solicitudes de alta
/api/readonly        acceso público a una jornada, sin auth
/api/photos          galería por jornada (Premium)
/api/invitations     · /api/join-requests · /api/follows · /api/notifications
/api/subscriptions   checkout, webhook y sincronización con Mercado Pago
/api/admin           métricas y gestión (rol admin)
```

## Cómo está construido

- **Auth en dos tokens**: access JWT de 1 h y refresh de 30 días en cookie `httpOnly`. Ningún token viaja a `localStorage`.
- **Autorización centralizada**: los guards de `middleware/access.js` (`requireTournamentManage`, `requireGroupManage`) se apoyan en `lib/access.js#canManageGroup`, que resuelve dueño y co-organizadores. El frontend replica la regla para la UI, pero la decisión es siempre del servidor.
- **Cupos del plan contra el dueño de la categoría**, nunca contra quien ejecuta la acción: un co-organizador Premium no le levanta el límite a un dueño Free. Viven en `lib/plan.js`.
- **Round-trips agrupados**: con el driver HTTP de Neon cada `sql` es un viaje a São Paulo. Las consultas que no dependen entre sí van en un único `Promise.all` — el perfil público pasó de ~11 viajes serializados a 2.
- **Las posiciones no se calculan acá**: se derivan en el cliente. La API sirve datos, no tablas.
- **El esquema es idempotente**: `schema.sql` corre en cada deploy vía `npm run db:init`, así que un cambio de esquema se agrega ahí y se aplica solo.

## Licencia

© 2026 Fabrizio Catanzaro. Todos los derechos reservados.

El código es público para consulta y evaluación. No se otorga permiso para usarlo, copiarlo, modificarlo ni redistribuirlo, total o parcialmente, sin autorización escrita.

Padeleando es un producto en producción, no una plantilla: el repositorio está abierto para mostrar cómo está construido.

---

**Fabrizio Catanzaro** — [GitHub](https://github.com/FabrizioCatanzaro) · [padeleando.ar](https://padeleando.ar)
