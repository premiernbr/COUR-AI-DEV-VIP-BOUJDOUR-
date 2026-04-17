# JD Boujdour - Delivery Readiness

## Stack
- `web`: Nginx serves frontend and proxies `/api/*` to backend.
- `api`: Node.js + TypeScript + Fastify.
- `db`: PostgreSQL with persistent Docker volume.

## Environment
- `.env.example` (قائمة المتغيرات)
- `.env.compose.example` للتشغيل المحلي السريع (انسخه إلى `.env.compose`)
- استخدم `--env-file` لاختيار بيئة أخرى عند الحاجة.

## Endpoints
- Website: `http://localhost:8080`
- Admin: `http://localhost:8080/admin`
- API health (internal via mapped web): `http://localhost:8080/api/v1/public-config`

## Security hardening done
- Secrets moved out of `docker-compose.yml` into environment files.
- DB/API host ports are no longer exposed publicly.
- Admin password sync-on-start is disabled by default.
- Nginx security headers enabled:
  - `CSP`
  - `X-Frame-Options`
  - `X-Content-Type-Options`
  - `Referrer-Policy`
  - `Permissions-Policy`
  - `HSTS`
- Lead endpoint protection:
  - Rate limit by IP
  - Optional Turnstile captcha validation
- Admin endpoints rate limit via `ADMIN_RATE_LIMIT_MAX` / `ADMIN_RATE_LIMIT_WINDOW_MS`
- CORS قابل للضبط عبر `CORS_ORIGIN` (قائمة origins مفصولة بفواصل، اضبطه على نطاق GitHub Pages عند النشر العام).

## Captcha
In env file:
- `TURNSTILE_ENABLED=true|false`
- `TURNSTILE_SITE_KEY=...`
- `TURNSTILE_SECRET_KEY=...`

If enabled, the form auto-loads captcha from `/api/v1/public-config`.

## Quick start (Docker Compose)
```bash
cp .env.compose.example .env.compose
docker compose --env-file .env.compose up -d db
docker compose --env-file .env.compose run --rm -v ${PWD}/backend/src:/app/src -v ${PWD}/database:/database api npm run seed
docker compose --env-file .env.compose up -d api web
```
Health: `http://localhost:3000/health` — Front: `http://localhost:8080`

## Testing
```bash
cd backend
npm ci
npm test -- --runInBand
```
CI pipeline: gitleaks → npm audit (high) → OSV Scanner → tests → build → buildx/SBOM/Provenance.

## Stop
```powershell
docker compose down
```

## Reset all DB data
```powershell
docker compose down -v
```
