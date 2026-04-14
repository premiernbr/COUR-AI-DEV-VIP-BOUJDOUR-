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
- للنشر على منصة (Render/Fly/Docker server) استخدم هذه الصورة وحدد المتغيرات:
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
