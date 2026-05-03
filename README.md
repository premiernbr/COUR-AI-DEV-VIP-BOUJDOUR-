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
- `GET /api/v1/products?limit=...` (homepage media/products, now returns `images` and `variants`)
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
- Optional catalog storage:
  - `CATALOG_BUCKET` (default: `catalog`)
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

## Vendored library
- `vendor/qrcode.min.js`
- License: `vendor/qrcodejs.LICENSE.txt` (MIT)
- Used by `admin.html` to render the 2FA QR code locally without a CDN dependency.

## Catalog model
- Current public API supports:
  - `products.main_image_path` / `products.main_image_url`
  - `product_images.storage_path`
  - `variants[]`
  - `variant.images[]`
- Recommended storage layout in Supabase Storage bucket `catalog`:
  - `products/<product-slug>/cover.webp`
  - `products/<product-slug>/gallery/01.webp`
  - `products/<product-slug>/variants/<variant-slug>/cover.webp`
  - `products/<product-slug>/variants/<variant-slug>/gallery/01.webp`


---

## Search Visibility / SEO / Google Search Readiness

This project can be connected to Google Search Console and prepared for better visibility in search engines.

The repository may include a Google site verification file, such as:

- `googlef9932d09b67957dc.html`

The frontend can also be improved for search visibility through:

- Clear Arabic page title
- Strong meta description
- Open Graph tags for social sharing
- Descriptive content on the homepage
- Search-friendly public URL
- Sitemap support in future versions
- Structured data support in future versions

This does not guarantee first-page ranking, but it helps search engines understand the website and display it more clearly when users search for it.

Recommended production steps:

- Verify the site in Google Search Console.
- Submit the live GitHub Pages URL.
- Add a `sitemap.xml` if the project grows beyond one page.
- Keep page titles and descriptions accurate.
- Avoid fake or exaggerated marketing claims.
- Use structured data only when it truly matches the page content.


---

## Open Source License

This project is published under the MIT License.

Developers may use, modify, distribute, and adapt the project for other local or commercial activities, provided that the license notice is preserved.

Before production use, developers should review `SECURITY.md` and configure their own Supabase and GitHub secrets.


---

## QR Library: Local instead of CDN

For final production, it is recommended to keep the QR library local inside the project instead of loading it from an external CDN.

This project can use:

- `vendor/qrcode.min.js`
- `vendor/qrcodejs.LICENSE.txt`

Why local QR is recommended:

- Better privacy
- Less dependency on external services
- Lower risk if a CDN becomes unavailable
- Better self-contained production delivery

When using a local QR library, keep its license file inside `vendor/`.

