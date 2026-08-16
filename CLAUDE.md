# CLAUDE.md — PADELEANDO API

## Project Overview

Express REST API backing PADELEANDO, a padel tournament platform. It serves categories (`groups`) and jornadas (`tournaments`) in two formats (Liga/Americano) and two modes (free players / fixed pairs), plus players, pairs, matches, knockout bracket, photo galleries, invitations, co-organizers, clubs, follows, notifications, public profiles, subscriptions and an admin dashboard.

The **React frontend lives in a separate repo** (`c:\Users\Fabry\Programacion\padeliando`) — not a monorepo. That repo's `CLAUDE.md` documents the product and the client-side conventions; read it whenever a change crosses the wire.

---

## Tech Stack

- Node + **Express 5**, ESM (`"type": "module"`), run through **`tsx`** (no build step, no TypeScript in `src/`)
- **Neon serverless PostgreSQL** — HTTP driver for most queries, WebSocket `Pool` for transactions
- **JWT** access token + opaque refresh token, both in `httpOnly` cookies; **bcrypt** for passwords
- **Google OAuth** (`google-auth-library`) as an alternative login
- **Cloudinary** for avatars, tournament photos and club photos (`multer` memory storage)
- **Resend** for transactional email, with **React Email** templates in `src/emails/`
- **Mercado Pago** preapprovals for the Premium subscription
- `express-rate-limit`, `compression`, `morgan`, `cors`, `cookie-parser`

---

## Dev Commands

```bash
npm run dev                              # tsx watch src/index.js → http://localhost:3001
npm start                                # same, no watch (what Render runs)
npm run db:init                          # apply src/schema.sql (idempotent) — runs on every deploy
npm run db:migrate -- src/migration_x.sql  # apply a single loose .sql file
npm run email                            # React Email preview server (also port 3001 — stop the API first)
```

There is **no test suite and no linter** in this repo. Verify changes by running the API and driving the real frontend (the `run-app` skill in the frontend repo boots both).

---

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Neon connection string. **In production this is a least-privilege role with DML only.** |
| `DATABASE_URL_ADMIN` | Owner role with DDL rights. `db:init` / `db:migrate` prefer it and fall back to `DATABASE_URL`. |
| `PORT` | Default 3001 |
| `CORS_ORIGIN` | Allowed origins, comma-separated |
| `FRONTEND_URL` | Base for links inside emails (verification, reset, invites) |
| `JWT_SECRET` | Signs access tokens |
| `GOOGLE_CLIENT_ID` | Verifies Google OAuth id tokens |
| `RESEND_API_KEY` / `MAIL_FROM` | Outbound email |
| `RESEND_WEBHOOK_SECRET` / `INBOUND_FORWARD_TO` / `INBOUND_FORWARD_FROM` | Inbound email webhook (`/api/emails/webhook`) |
| `SURVEY_URL` | Link in the account-deletion goodbye email (falls back to `FRONTEND_URL`) |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | Image uploads |
| `MP_ACCESS_TOKEN` | Mercado Pago |
| `NODE_ENV` | `production` toggles secure cookies, `sameSite: 'none'` and the `combined` log format |

---

## Layout

```
src/
  index.js          app wiring: CORS, compression, cache policy, router mounts, error handler
  db.js             getDb() HTTP driver · getPool() WebSocket · withTransaction()
  uid.js            uid() — 7-char base36 id used as PK everywhere (ids are TEXT, not serial)
  schema.sql        full idempotent schema, applied on every deploy
  migration_*.sql   loose migrations (historical; most are already folded into schema.sql)
  routes/           one router per resource, mounted under /api/<name>
  middleware/       auth.js · access.js · requirePremium.js · upload.js
  lib/              access.js · plan.js · profileStats.js · signup.js · richText.js
                    cloudinary.js · deleteUser.js
  emails/           React Email templates (Layout, Welcome, VerifyEmail, ResetPassword,
                    Goodbye, AdminBroadcast)
```

Route sizes are uneven on purpose: `groups.js` (~1.2k lines) and `tournaments.js` (~1.2k) carry the bulk of the domain. Everything else is under 550.

---

## Key Conventions

### Code style

- **No multi-line comments.** Comment only when the context is impossible to grasp otherwise, and in a single short line.
- The long reasoning — why a criterion was chosen, what measurement backs it, what bug motivated the change — goes in the commit message or in this file, never in the source.

### Database access

- **`getDb()` is the default.** Every `sql\`…\`` tagged template is one independent HTTPS round-trip to São Paulo (sa-east-1). This is the dominant cost of any endpoint.
- **Never chain `await`s on queries that don't feed each other** — batch them with `Promise.all`. This was the single biggest finding of the July 2026 performance audit: the public profile went from ~11 serial round-trips to 2, `GET /groups/:id` from 7 to 3. Regressing this is invisible locally and expensive in production.
- **`getPool()` / `withTransaction()` only where atomicity actually matters.** The HTTP driver can't do multi-statement transactions. Today the only user is `POST /tournaments` (creating a jornada writes to five tables). Don't promote it to a general replacement — the WebSocket pool is capped at 4 connections.
- **Ids are `TEXT`, generated by `uid()`** in the app, not by the database.
- **Interpolation into a tagged template is always parameterized**, so a nested SQL fragment travels as a *value*, not as SQL. Guards in `middleware/access.js` are written out in full for this reason. When a query genuinely needs dynamic SQL, use `sql.query(text, params)`.
- **Neon returns `DATE` as a plain string** — `db.js` installs a type parser for OID 1082 to stop the driver from shifting the day by the process timezone. Don't remove it.

### Authentication

- Two cookies, both `httpOnly`: `access_token` (JWT, **1 h**) and `refresh_token` (**3 h**, opaque 40 random bytes). The refresh token is stored **hashed** (`sha256`) in `refresh_tokens` and rotated on every use — the plaintext never touches the database.
- `secure` and `sameSite: 'none'` only in production; `lax` in dev.
- `requireAuth` populates `req.user` from the access token; `optionalAuth` does the same but never rejects — use it on public endpoints that show extra data to a logged-in viewer.
- `requireAdmin` **re-reads `role` from the database** instead of trusting the JWT, so old tokens issued before the field existed don't grant access.
- Auth endpoints are rate-limited per IP: login 10/15 min, resend-verification 5/15 min, username checks 60/15 min. `app.set('trust proxy', 1)` is required for this to work behind Render — without it every user lands in the same bucket.

### Authorization

- A category has one **owner** (`groups.user_id`) plus zero or more **co-organizers** (`group_collaborators`). A jornada has no owner of its own; it inherits from its category.
- Two levels, both computed server-side and returned on `GET /groups/:id` and `GET /tournaments/:id`:
  - **`is_owner`** — edit/delete the category, transfer ownership, manage co-organizers.
  - **`can_manage`** — owner *or* co-organizer; everything about jornadas (players, pairs, matches, bracket, photos).
- Mutating endpoints chain `requireAuth` + a guard from `middleware/access.js`: `requireGroupManage`, `requireTournamentManage`, `requireMatchManage`, `requirePairManage`. Each guard resolves the resource **and** the permission in **one** query and leaves it in `req.accessCtx` (with useful extras like `format`, `status`, `mode`) — the handler must read from there instead of re-querying.
- `lib/access.js#canManageGroup` / `isGroupOwner` are the same rule for code paths that aren't middleware. They return `null` when the group doesn't exist, so distinguish `null` from `false`.
- The frontend mirrors these rules for the UI only. **Authorization decisions belong here.**

### Plans and quotas

- `lib/plan.js`: free allows **2 categories** and **2 jornadas per category per calendar month** (counted on `created_at`). `POST /groups` and `POST /tournaments` answer `403 { code: 'plan_limit' }`.
- **Quotas and premium gates always evaluate the category OWNER**, never the acting user — a premium co-organizer must not lift a free owner's limit.
- **A downgrade never touches what already exists.** Quotas compare against the current total, so a premium user who created 5 categories keeps all 5 working on free; only creating a new one is blocked. Same for jornadas and for already-uploaded photos. Never make a downgrade archive, hide or freeze anything.
- `requirePremium` middleware gates premium-only features (galleries, avatar upload); `getActiveSubscription` re-checks Mercado Pago only within ~6 h of `ends_at`, not on every request.

### Domain rules

- **Standings are never computed here.** They are derived client-side (`calcStandings` in the frontend). This API serves rows, not tables.
- **A match never ends in a draw.** `score1 === score2` is rejected by `POST/PUT /matches` and by the bracket endpoints. Padel has no draws — this is invalid data, not a result.
- **Americano knockout matches are not rows in `matches`** — they live inside `tournaments.bracket` (JSONB). Anything that counts matches must expand them; `lib/profileStats.js#expandBracketMatches` does it for the public profile. Forgetting this is why a profile once showed a championship whose matches didn't exist.
- **`linked_name` pattern**: when a user accepts an invitation, their player slot gains `players.user_id`. Every query that fetches players must `LEFT JOIN users u ON u.id = p.user_id` and return `u.name AS linked_name` — the frontend's `adaptTournament` resolves `linked_name ?? name`, so a missing join silently shows stale names.
- **One account = one player slot per category**, enforced by the `assert_one_linked_player_per_group()` trigger in `schema.sql`.
- **Signup info (`signup_*`) is inherited field by field** from category to jornada: `NULL` means inherit, a value overrides. `lib/signup.js#parseSignupFields` only touches keys present in the body, so `undefined` leaves the field alone while `null` restores inheritance.
- **Deleting a user reassigns, it doesn't cascade.** `lib/deleteUser.js` moves their groups to the `deleted-account` ghost user so tournaments, matches and photos survive and the `INNER JOIN users` in group queries keeps working.
- **Advanced profile stats are gated server-side.** `GET /groups/user/:username` returns them only to the owner, or to anyone when a premium user set `users.advanced_stats_public`. The queries that feed only that block are skipped entirely when it won't render — don't put those fields back into the public payload.

### HTTP behavior

- **Cache policy is centralized in `index.js`**, not per route. Public read surfaces (`/api/home`, `/api/readonly`, `/api/groups/search`, `/api/groups/nearby`, `/api/clubs`) get `public, max-age=10, stale-while-revalidate=60`; session/sensitive surfaces (`/api/auth`, `/api/subscriptions`, `/api/admin`, `/api/notifications`, `/api/invitations`, `/api/emails`) get `no-store`; everything else gets `private, no-cache` so Express's ETag can still answer 304 (the spectator view polls). Non-GET is always `no-store`. Adding a route means checking which list it belongs in.
- **Bodiless mutations send no `Content-Type`** to avoid a CORS preflight, so `express.json()` skips them and Express 5 leaves `req.body === undefined`. A global middleware normalizes it to `{}` — don't add per-route guards for this.
- The Resend inbound webhook needs the raw body for its svix signature, so its `express.raw()` parser is mounted **before** the global `express.json()`.
- The error handler at the bottom of `index.js` logs and returns `500 { error }`. Route handlers should `next(err)` rather than swallowing.

### Notifications

In-app notifications are plain `INSERT INTO notifications (id, user_id, type, actor_id, entity_id, …)` at the point of the event — there is no helper module. Follow the shape used by the nearest existing case (`collaborators.js`, `join-requests.js`, `follows.js`). Admin broadcasts carry a Markdown subset rendered identically in the bell and in the email (`lib/richText.js`).

---

## Database Migrations

- **`src/schema.sql` is the source of truth.** It is fully idempotent (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`) and **runs on every Render deploy via `npm run db:init`**. Any schema change must land there, or it won't reach production.
- The `migration_*.sql` files are historical. Most are already folded into `schema.sql`; a few tables (`users`, `notifications`, `follows`, `refresh_tokens`) still live only in their migration or were created directly in Neon, so `schema.sql` references `users` without creating it. **Do not run `schema.sql` against an empty database** and expect it to work end to end.
- `db:init` and `db:migrate` need DDL rights: they use `DATABASE_URL_ADMIN` when present. The runtime `DATABASE_URL` is DML-only in production and will fail on DDL — that's intentional.

---

## Performance

Every change must be evaluated for performance impact before it's considered done. The recurring offenders, in order of how often they showed up in the audit:

1. **Serial `await`s on independent queries** — see above. Batch with `Promise.all`.
2. **Making the client do a second, dependent request.** Prefer returning the extra fields in the first response; it saves a round-trip *and* stops late data from injecting content into an already-painted page. `/api/readonly/:id` carries the category's name, emojis and visibility for this reason.
3. **Guards or handlers re-reading a row already resolved.** `req.accessCtx` exists precisely so the second read doesn't happen.
4. **Dropping cacheability.** Setting `no-store` on a GET that could revalidate kills the 304 path for polling clients.

When touching an endpoint, **diff the response against the previous code with keys normalized — byte-identical output is the bar.** Don't claim an improvement without measuring it.

---

## What NOT to Do

- **Don't write multi-line comments** — one short line at most, and only if it's indispensable; the reasoning belongs in the commit message.
- **Don't chain `await`ed queries that don't depend on each other** — one Neon HTTP round-trip each.
- **Don't build SQL by interpolating fragments into a tagged template** — it parameterizes them into values. Use `sql.query(text, params)` for dynamic SQL.
- **Don't compute standings server-side** — the client does it.
- **Don't allow or model draws** — `score1 === score2` is rejected everywhere.
- **Don't count matches without expanding the americano bracket** — knockout matches aren't rows in `matches`.
- **Don't fetch players without `LEFT JOIN users … AS linked_name`** — the client resolves display names from it.
- **Don't gate plan limits on the acting user** — always the category owner.
- **Don't let co-organizers edit/delete a category, transfer it, or manage co-organizers** — those are `is_owner` only.
- **Don't trust the JWT for `role`** — `requireAdmin` re-reads it from the database.
- **Don't add a schema change only as a loose `migration_*.sql`** — it must be in `schema.sql` or it never reaches production.
- **Don't remove `app.set('trust proxy', 1)`** — the auth rate limiters collapse into a single bucket without it.
- **Don't drop the `DATE` type parser in `db.js`** — calendar days shift by the process timezone.
- **Don't expose the advanced profile stats in the public payload** — the gate is server-side by design.
- **Don't re-enable subscription UI on the frontend** — the Mercado Pago flow works here but the client routes are intentionally disabled.

---

## Deployment

| Layer | Platform | Notes |
|-------|----------|-------|
| API | Render.com | `https://padeleando-api.onrender.com`; runs `npm run db:init` then `npm start` on each deploy |
| Database | Neon | Region sa-east-1 (São Paulo) |
| Images | Cloudinary | `avatars/`, `tournament-photos/` |
| Email | Resend | Outbound + inbound webhook at `/api/emails/webhook` |

`GET /health` returns `{ ok: true }`.
