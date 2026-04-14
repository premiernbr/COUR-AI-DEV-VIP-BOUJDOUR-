# JD Boujdour - Delivery Readiness

## Stack
- `web`: Nginx serves frontend and proxies `/api/*` to backend.
- `api`: Node.js + TypeScript + Fastify.
- `db`: PostgreSQL with persistent Docker volume.

## Environment separation
- `.env.dev`
- `.env.staging`
- `.env.prod`

Select environment at runtime with `--env-file`.

## Run
```powershell
docker compose --env-file ./.env.dev up --build -d
```

Staging:
```powershell
docker compose --env-file ./.env.staging up --build -d
```

Production:
```powershell
docker compose --env-file ./.env.prod up --build -d
```

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

## Captcha
In env file:
- `TURNSTILE_ENABLED=true|false`
- `TURNSTILE_SITE_KEY=...`
- `TURNSTILE_SECRET_KEY=...`

If enabled, the form auto-loads captcha from `/api/v1/public-config`.

## Stop
```powershell
docker compose down
```

## Reset all DB data
```powershell
docker compose down -v
```
