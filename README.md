# ALLIVER Backend API

Node.js + Express + SQLite backend for allivermarketing.in.

## Setup
```bash
npm install
cp .env.example .env     # then edit JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD, SMTP_*
npm start                # http://localhost:4000
```
An admin account is created automatically on first run from `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

## Public endpoints
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/leads` | Contact form (`name`, `email`, optional `phone`, `company`, `service`, `budget`, `message`, `source`). Add a hidden `website` field as a spam honeypot. |
| POST | `/api/newsletter` | `{ "email": "..." }` |
| GET | `/api/services`, `/api/services/:slug` | Services |
| GET | `/api/projects`, `/api/projects/:slug` | Portfolio / case studies |
| GET | `/api/posts`, `/api/posts/:slug` | Published blog posts |
| GET | `/api/testimonials` | Testimonials |
| GET | `/api/health` | Health check |

## Admin endpoints (header `Authorization: Bearer <token>`)
- `POST /api/auth/login` returns `{ token }`
- `POST /api/admin/change-password`
- `GET /api/admin/stats`
- `GET /api/admin/leads?status=&q=&page=&limit=`, `PATCH /api/admin/leads/:id` (`status`: new|contacted|qualified|won|lost, `notes`), `DELETE`, `GET /api/admin/leads/export.csv`
- `GET /api/admin/subscribers`, `DELETE /api/admin/subscribers/:id`
- Full CRUD (`GET`, `POST`, `PUT /:id`, `DELETE /:id`) on `/api/admin/{services,projects,posts,testimonials}`

## Frontend example
```js
await fetch('https://api.allivermarketing.in/api/leads', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name, email, phone, service, message })
});
```

## Deploy
Run on a VPS / Render / Railway with a persistent disk for `DB_PATH`, behind HTTPS (e.g. `api.allivermarketing.in`), and set `CORS_ORIGINS` to your site's domains.
