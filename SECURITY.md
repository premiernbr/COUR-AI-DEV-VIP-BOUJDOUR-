# Security Policy

## Production Security Notes

This repository is an open-source web project built with GitHub Pages and Supabase Edge Functions.

Before using it in production, developers should review and apply the following security rules:

- Do not commit real secrets to the repository.
- Keep `.env.supabase` local only.
- Store Supabase secrets inside Supabase Function Secrets.
- Store GitHub deployment values inside GitHub Actions Secrets.
- Change ADMIN_USERNAME and ADMIN_PASSWORD before production.
- Use a strong ADMIN_JWT_SECRET or JWT_SECRET.
- Enable two-factor authentication for the admin account.
- Set CORS_ORIGIN to the real production origin instead of `*`.
- Enable Turnstile or another anti-spam protection for public forms.
- Review GitHub Code Scanning, Secret Scanning, Dependabot alerts, and vulnerability reports before publishing.
- Never expose SUPABASE_SERVICE_ROLE_KEY in frontend files.

## Secret Management

Frontend files such as `index.html`, `script.js`, `admin.js`, and `config.js` must never contain private secrets.

Allowed in frontend:

- Public site URL
- Public API base URL
- Public configuration flags

Not allowed in frontend:

- SUPABASE_SERVICE_ROLE_KEY
- ADMIN_PASSWORD
- JWT_SECRET
- ADMIN_JWT_SECRET
- SUPABASE_ACCESS_TOKEN
- GitHub tokens
- Private API keys

## QR Library

For final production, it is recommended to keep the QR library local inside `vendor/` instead of loading it from an external CDN.

Benefits:

- Better privacy
- Less dependency on third-party networks
- More stable production behavior
- Better self-contained delivery
- Lower risk if a CDN becomes unavailable or changes behavior

If a local QR library is used, keep its license file inside the repository.

## Reporting a Vulnerability

Please do not publish sensitive security details publicly.

To report a vulnerability:

1. Open a responsible GitHub issue without including secrets.
2. Describe the affected file, route, or behavior.
3. Do not include real tokens, passwords, or private keys.
4. If the issue contains sensitive information, contact the repository owner directly instead of posting it publicly.

## Supported Version

The public `main` branch is the supported version.

Older forks or modified copies are the responsibility of their maintainers.
