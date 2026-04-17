## نشر سريع عبر GitHub Pages + GHCR + Supabase

### المتطلبات (تُضبط كـ GitHub Secrets)
- `SUPABASE_DB_URL` : سلسلة اتصال Postgres من Supabase (تبدأ بـ `postgresql://`).
- `JWT_SECRET` : مفتاح التوقيع للـAPI.

### بناء/نشر الواجهة (GitHub Pages)
تم تجهيز workflow: `.github/workflows/frontend-pages.yml`
- عند الـ push على `main` يُرفع `index.html`, `admin.html`, `style.css`, `admin.css`, `script.js`, `sw.js`, `manifest.json` إلى Pages.
- العنوان يكون `https://<username>.github.io/<repo>/` أو حسب إعداد Pages.

### بناء/نشر الـAPI (GHCR)
workflow: `.github/workflows/backend-ghcr.yml`
- يبني `backend/Dockerfile` ويضع الصورة في GHCR: `ghcr.io/<org>/<repo>/jd-boujdour-api:latest`.
- للنشر على أي منصة تدعم Docker استخدم هذه الصورة وحدد المتغيرات:
  - `PORT=3000`
  - `DATABASE_URL` = `SUPABASE_DB_URL`
  - `JWT_SECRET` = قيمة السر
  - بقية الإعدادات من `.env.dev` حسب الحاجة.

### Seed البيانات إلى Supabase
1) عدّل `database/seed-products.json` بروابط صورك.
2) محلياً (أو في CI) شغّل:
   ```bash
   cd backend
   DATABASE_URL=$SUPABASE_DB_URL npm install
   DATABASE_URL=$SUPABASE_DB_URL npm run seed
   ```
   (يمكن تشغيلها من جهازك أو من بيئة CI مع المتغيرات السرية).

### ملاحظات
- الواجهة تستخدم `/api/v1/...`، فضع `API_BASE` خلف reverse proxy أو حدّث `script.js` إذا لزم.
- Service Worker v4 يوفّر كاش للمنتجات والصور وفولباك.
- صور PNG أزيلت من المجلد؛ الروابط حالياً إلى Unsplash مؤقتة.

## التحكم بـ Supabase من VS Code

هذا البديل مفيد إذا كنت تعتمد على Supabase كـ Postgres (وأيضًا Edge Functions إن احتجت) بدل إدارة قاعدة البيانات يدويًا.

### إعداد سريع (مرة واحدة)
1) أنشئ ملف `.env.supabase` من `.env.supabase.example` (لا يتم رفعه للـgit).
2) ضع:
   - `SUPABASE_ACCESS_TOKEN` (لتشغيل أوامر CLI بدون تسجيل دخول تفاعلي).
   - `SUPABASE_PROJECT_REF`
   - (اختياري) `SUPABASE_DB_PASSWORD` لتجنب prompt في `supabase link`.
3) ملاحظة: `scripts/supabase.ps1` يشغّل Supabase CLI عبر `npx supabase` تلقائيًا إذا لم تكن مثبّتة كنظام (يتطلب Node.js 20+ واتصال إنترنت لأول مرة).
3) شغّل من VS Code: `Terminal -> Run Task...`
   - `Supabase: Projects List`
   - `Supabase: Link Project`
   - `Supabase: DB Push (migrations)` (يدفع `supabase/migrations/*`).
   - (اختياري) `Supabase: Functions Deploy` إذا استعملت Edge Functions.

## تشغيل الـAPI على Supabase Edge Functions (بدل سيرفر Node)

تمت إضافة Edge Function باسم `api` داخل `supabase/functions/api/index.ts` لتنفيذ:
- `GET /api/v1/public-config`
- `GET /api/v1/products?limit=...`
- `POST /api/v1/leads`
 - (Admin) `POST /api/v1/admin/auth/login`
 - (Admin) `POST /api/v1/admin/auth/refresh`
 - (Admin) `POST /api/v1/admin/auth/logout`
 - (Admin) `GET /api/v1/admin/auth/me`
 - (Admin) `GET /api/v1/admin/leads?status=...`
 - (Admin) `PATCH /api/v1/admin/leads/:id/status`
 - (Admin) `GET /api/v1/admin/audit-logs?limit=...`
 - (Admin 2FA) `GET /api/v1/admin/auth/2fa/setup`
 - (Admin 2FA) `POST /api/v1/admin/auth/2fa/enable`
 - (Admin 2FA) `POST /api/v1/admin/auth/2fa/disable`

### ضبط Secrets (مرة واحدة داخل Supabase)
داخل Supabase Dashboard -> Project Settings -> Functions -> Secrets (أو عبر CLI إذا رغبت) ضع:
- `SUPABASE_URL` = `https://<project-ref>.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY` = Service Role Key
- `ADMIN_JWT_SECRET` (أو `JWT_SECRET`) = مفتاح قوي (≥ 12 حرف) لتوقيع توكنات لوحة الإدارة
- `ADMIN_USERNAME`, `ADMIN_PASSWORD` = بيانات الدخول للوحة الإدارة (سيتم إنشاء المستخدم تلقائياً إذا لم يوجد أي Admin)
- `CORS_ORIGIN` = رابط GitHub Pages (مثال: `https://<username>.github.io`) أو `*` للتجربة
- (اختياري) `TURNSTILE_ENABLED`, `TURNSTILE_SITE_KEY`

### نشر الوظيفة
- من VS Code: شغّل `Supabase: Functions Deploy`

### ربط الفرونت بالـAPI على Supabase
- عدّل `config.js` واجعل:
  - `window.JD_API_BASE = "https://<project-ref>.supabase.co/functions/v1";`
- ثم ادفع التغييرات ليُعاد نشر GitHub Pages.
