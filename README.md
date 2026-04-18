# JD Boujdour (GitHub Pages + Supabase)

Static website (GitHub Pages) + backend on Supabase Edge Functions.

## Frontend
- Live site: `https://<username>.github.io/<repo>/`
- Admin: `https://<username>.github.io/<repo>/admin`

Runtime API config is in `config.js`:
- `window.JD_API_BASE = "https://<project-ref>.supabase.co/functions/v1/api"`

## Backend (Supabase Edge Function)
Source: `supabase/functions/api/index.ts`

### Routes used by the website
- `GET /api/v1/public-config` (captcha config)
- `GET /api/v1/products?limit=...` (homepage media/products)
- `POST /api/v1/leads` (order form)

### Admin routes
- `POST /api/v1/admin/auth/login`
- `GET /api/v1/admin/auth/me`
- `GET /api/v1/admin/leads?status=...`
- `PATCH /api/v1/admin/leads/:id/status`
- `GET /api/v1/admin/audit-logs?limit=...`
- `GET /api/v1/admin/auth/2fa/setup`
- `POST /api/v1/admin/auth/2fa/enable`
- `POST /api/v1/admin/auth/2fa/disable`

### Required Supabase Secrets (Dashboard → Functions → Secrets)
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ADMIN_JWT_SECRET` (or `JWT_SECRET`) (≥ 12 chars)
- `ADMIN_USERNAME`, `ADMIN_PASSWORD`
- `CORS_ORIGIN` (your GitHub Pages origin, or `*` for testing)
- Optional Turnstile:
  - `TURNSTILE_ENABLED=true|false`
  - `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`

### IMPORTANT: Edge Function settings
- Edge Functions → `api` → Settings → **Verify JWT: OFF**
  - Otherwise public endpoints like `/api/v1/leads` will return 401 without an auth header.

## GitHub Actions
- `frontend-pages`: deploys static files + `PNG/` to GitHub Pages.
- `supabase-edge-deploy`: deploys the `api` Edge Function (requires repo secrets below).

### Repo secrets for `supabase-edge-deploy`
GitHub repo → Settings → Secrets and variables → Actions:
- `SUPABASE_ACCESS_TOKEN`
- `SUPABASE_PROJECT_REF`

## Smoke test (local)
Runs a few requests against the configured `JD_API_BASE`:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/smoke.ps1
```

