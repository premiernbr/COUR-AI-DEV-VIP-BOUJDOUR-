import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import Fastify, { FastifyReply, FastifyRequest } from "fastify";
import formbody from "@fastify/formbody";
import jwt from "jsonwebtoken";
import { authenticator } from "otplib";
import { Pool, PoolClient } from "pg";
import { z } from "zod";
import { pool, withTransaction } from "./db.js";
import { createLeadSchema } from "./validation.js";

type AdminJwtPayload = {
  sub: string;
  username: string;
  role: string;
};

type AdminRequest = FastifyRequest & {
  admin: AdminJwtPayload;
};

const app = Fastify({
  logger: true
});

// Accept classic HTML form submissions (application/x-www-form-urlencoded)
await app.register(formbody);

const jwtSecretEnv = process.env.JWT_SECRET;
if (!jwtSecretEnv) {
  throw new Error("JWT_SECRET is required");
}
const jwtSecret: jwt.Secret = jwtSecretEnv;
const accessTokenTtlSeconds = Number(process.env.ACCESS_TOKEN_TTL_SECONDS ?? "900");
const refreshTokenDays = Number(process.env.REFRESH_TOKEN_DAYS ?? "7");
const adminSeedUsername = process.env.ADMIN_USERNAME ?? "admin";
const adminSeedPassword = process.env.ADMIN_PASSWORD ?? "ChangeMe123!";
const adminSyncPasswordOnStart = (process.env.ADMIN_SYNC_PASSWORD_ON_START ?? "true").toLowerCase() === "true";
const lockoutMaxAttempts = Number(process.env.ADMIN_LOCKOUT_MAX_ATTEMPTS ?? "5");
const lockoutMinutes = Number(process.env.ADMIN_LOCKOUT_MINUTES ?? "15");
const leadsRateLimitWindowMs = Number(process.env.LEADS_RATE_LIMIT_WINDOW_MS ?? "60000");
const leadsRateLimitMax = Number(process.env.LEADS_RATE_LIMIT_MAX ?? "5");
const turnstileEnabled = (process.env.TURNSTILE_ENABLED ?? "false").toLowerCase() === "true";
const turnstileSiteKey = process.env.TURNSTILE_SITE_KEY ?? "";
const turnstileSecretKey = process.env.TURNSTILE_SECRET_KEY ?? "";
const allowedStatuses = new Set(["new", "contacted", "closed"]);
const leadRateLimitStore = new Map<string, { count: number; resetAt: number }>();

const productInputSchema = z.object({
  name: z.string().trim().min(2).max(200),
  slug: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).optional(),
  price: z.coerce.number().min(0),
  currency: z.string().trim().min(3).max(8).default("MAD"),
  popularity: z.coerce.number().int().min(0).default(0).optional(),
  categorySlug: z.string().trim().min(2).max(120).optional(),
  categoryName: z.string().trim().min(2).max(120).optional(),
  mainImageUrl: z.string().trim().url().optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  attributes: z.record(z.string(), z.any()).optional(),
  isActive: z.boolean().optional(),
  images: z
    .array(
      z.object({
        url: z.string().trim().url(),
        alt: z.string().trim().max(240).optional(),
        position: z.number().int().min(1).optional()
      })
    )
    .max(50)
    .optional()
});

authenticator.options = {
  step: 30,
  window: 1
};

function parseBearerToken(request: FastifyRequest): string | null {
  const auth = request.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return null;
  }
  return auth.slice("Bearer ".length).trim();
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createRefreshToken(): string {
  return crypto.randomBytes(48).toString("base64url");
}

function signAccessToken(payload: AdminJwtPayload): string {
  return jwt.sign(payload, jwtSecret, {
    expiresIn: accessTokenTtlSeconds,
    issuer: "jd-boujdour-api",
    audience: "jd-boujdour-admin"
  });
}

function getRequestMeta(request: FastifyRequest): { ip: string; userAgent: string } {
  return {
    ip: request.ip.slice(0, 80),
    userAgent: (request.headers["user-agent"] ?? "").toString().slice(0, 300)
  };
}

function enforceLeadRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = leadRateLimitStore.get(ip);

  if (!entry || now > entry.resetAt) {
    leadRateLimitStore.set(ip, {
      count: 1,
      resetAt: now + leadsRateLimitWindowMs
    });
    return true;
  }

  if (entry.count >= leadsRateLimitMax) {
    return false;
  }

  entry.count += 1;
  return true;
}

async function verifyTurnstileToken(token: string, ip: string): Promise<boolean> {
  if (!turnstileEnabled) {
    return true;
  }

  if (!turnstileSecretKey || !token) {
    return false;
  }

  const body = new URLSearchParams();
  body.set("secret", turnstileSecretKey);
  body.set("response", token);
  body.set("remoteip", ip);

  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });

    if (!response.ok) {
      return false;
    }

    const data = (await response.json()) as { success?: boolean };
    return Boolean(data.success);
  } catch {
    return false;
  }
}

async function writeAuditLog(params: {
  userId?: number | null;
  action: string;
  details?: Record<string, unknown>;
  request: FastifyRequest;
}): Promise<void> {
  const meta = getRequestMeta(params.request);
  await pool.query(
    `
      INSERT INTO admin_audit_logs (user_id, action, details, ip_address, user_agent)
      VALUES ($1, $2, $3::jsonb, $4, $5)
    `,
    [params.userId ?? null, params.action, JSON.stringify(params.details ?? {}), meta.ip, meta.userAgent]
  );
}

async function authenticateAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = parseBearerToken(request);
  if (!token) {
    await reply.code(401).send({ error: "UNAUTHORIZED" });
    return;
  }

  try {
    const decoded = jwt.verify(token, jwtSecret, {
      issuer: "jd-boujdour-api",
      audience: "jd-boujdour-admin"
    }) as jwt.JwtPayload | string;

    if (typeof decoded !== "object" || decoded === null) {
      throw new Error("invalid token payload");
    }

    const maybeUsername = (decoded as jwt.JwtPayload).username;
    const maybeRole = (decoded as jwt.JwtPayload).role;
    const maybeSub = (decoded as jwt.JwtPayload).sub;

    if (typeof maybeUsername !== "string" || typeof maybeRole !== "string" || typeof maybeSub !== "string") {
      throw new Error("invalid token payload");
    }

    (request as AdminRequest).admin = {
      sub: maybeSub,
      username: maybeUsername,
      role: maybeRole
    };
  } catch {
    await reply.code(401).send({ error: "UNAUTHORIZED" });
  }
}

async function ensureAdminSchemaAndSeed(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      is_active BOOLEAN NOT NULL DEFAULT true,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ,
      two_factor_enabled BOOLEAN NOT NULL DEFAULT false,
      two_factor_secret TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at TIMESTAMPTZ
    );
  `);
  await pool.query(`ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS failed_attempts INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS two_factor_secret TEXT;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      refresh_token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      user_agent TEXT,
      ip_address TEXT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES admin_users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      details JSONB,
      ip_address TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_sessions_user_id ON admin_sessions(user_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at ON admin_sessions(expires_at);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_audit_created_at ON admin_audit_logs(created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_audit_user_id ON admin_audit_logs(user_id);`);

  const existing = await pool.query<{ id: number }>(
    `SELECT id FROM admin_users WHERE username = $1 LIMIT 1`,
    [adminSeedUsername]
  );

  if (existing.rowCount === 0) {
    const passwordHash = await bcrypt.hash(adminSeedPassword, 12);
    await pool.query(
      `
        INSERT INTO admin_users (username, password_hash, role, is_active)
        VALUES ($1, $2, 'admin', true)
      `,
      [adminSeedUsername, passwordHash]
    );
    app.log.warn(`Seeded admin user "${adminSeedUsername}". Change ADMIN_PASSWORD in production.`);
    return;
  }

  if (adminSyncPasswordOnStart) {
    const passwordHash = await bcrypt.hash(adminSeedPassword, 12);
    await pool.query(
      `
        UPDATE admin_users
        SET password_hash = $1,
            failed_attempts = 0,
            locked_until = NULL
        WHERE username = $2
      `,
      [passwordHash, adminSeedUsername]
    );
    app.log.info(`Synchronized admin password from environment for "${adminSeedUsername}".`);
  }
}

async function ensureCatalogSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT,
      price NUMERIC(12, 2) NOT NULL,
      currency TEXT NOT NULL DEFAULT 'MAD',
      popularity INT NOT NULL DEFAULT 0,
      category_id BIGINT REFERENCES categories(id) ON DELETE SET NULL,
      main_image_url TEXT,
      tags TEXT[],
      attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_images (
      id BIGSERIAL PRIMARY KEY,
      product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      alt TEXT,
      position INT NOT NULL DEFAULT 1
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_price ON products(price);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_tags ON products USING GIN (tags);`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS popularity INT NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`);
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_popularity ON products(popularity DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_products_created_at ON products(created_at DESC);`);
}

async function resolveCategoryId(
  input: { slug?: string; name?: string },
  client: Pool | PoolClient = pool
): Promise<number | null> {
  const slug = (input.slug ?? "").trim();
  const name = (input.name ?? slug).trim();
  if (!slug) return null;

    const existing = await client.query<{ id: number }>(
      `SELECT id FROM categories WHERE slug = $1 LIMIT 1`,
      [slug]
    );
  if ((existing.rowCount ?? 0) > 0) return existing.rows[0].id;

  const inserted = await client.query<{ id: number }>(
    `
      INSERT INTO categories (name, slug)
      VALUES ($1, $2)
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `,
    [name || slug, slug]
  );
  return inserted.rows[0].id;
}

async function createAdminSession(input: {
  userId: number;
  username: string;
  role: string;
  request: FastifyRequest;
}): Promise<{ accessToken: string; refreshToken: string }> {
  const accessToken = signAccessToken({
    sub: String(input.userId),
    username: input.username,
    role: input.role
  });

  const refreshToken = createRefreshToken();
  const refreshTokenHash = hashToken(refreshToken);
  const meta = getRequestMeta(input.request);

  await pool.query(
    `
      INSERT INTO admin_sessions (user_id, refresh_token_hash, expires_at, user_agent, ip_address)
      VALUES ($1, $2, NOW() + ($3 || ' days')::interval, $4, $5)
    `,
    [input.userId, refreshTokenHash, refreshTokenDays, meta.userAgent, meta.ip]
  );

  return { accessToken, refreshToken };
}

app.get("/health", async () => ({ ok: true, service: "api", timestamp: new Date().toISOString() }));
app.get("/", async () => ({
  ok: true,
  service: "api",
  message: "JD Boujdour API is running",
  health: "/health"
}));
app.get("/api/v1/public-config", async () => ({
  ok: true,
  captcha: {
    enabled: turnstileEnabled,
    provider: "turnstile",
    siteKey: turnstileEnabled ? turnstileSiteKey : ""
  }
}));

app.get("/api/v1/products", async (request, reply) => {
  const query = (request.query ?? {}) as Record<string, unknown>;
  const categorySlug = typeof query.category === "string" ? query.category.trim() : "";
  const search = typeof query.search === "string" ? query.search.trim() : "";
  const maxPrice = Number(query.max_price);
  const limitRaw = Number(query.limit);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;

  const params: unknown[] = [];
  const conditions: string[] = ["p.is_active = true"];

  if (categorySlug) {
    params.push(categorySlug);
    conditions.push(`c.slug = $${params.length}`);
  }

  if (Number.isFinite(maxPrice)) {
    params.push(maxPrice);
    conditions.push(`p.price <= $${params.length}`);
  }

  if (search) {
    params.push(`%${search}%`);
    params.push(`%${search}%`);
    conditions.push(`(p.name ILIKE $${params.length - 1} OR p.description ILIKE $${params.length})`);
  }

  params.push(limit);
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const productsResult = await pool.query<{
    id: number;
    name: string;
    slug: string;
    description: string | null;
    price: string;
    currency: string;
    popularity: number;
    category_id: number | null;
    category_name: string | null;
    main_image_url: string | null;
    tags: string[] | null;
    attributes: Record<string, unknown>;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
  }>(
    `
      SELECT
        p.id,
        p.name,
        p.slug,
        p.description,
        p.price,
        p.currency,
        p.popularity,
        p.category_id,
        c.name AS category_name,
        p.main_image_url,
        p.tags,
        p.attributes,
        p.is_active,
        p.created_at,
        p.updated_at
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      ${whereClause}
      ORDER BY p.created_at DESC
      LIMIT $${params.length}
    `,
    params
  );

  const ids = productsResult.rows.map((r) => r.id);
  let imagesByProduct = new Map<number, { url: string; alt: string | null; position: number }[]>();
  if (ids.length) {
    const imagesResult = await pool.query<{
      product_id: number;
      url: string;
      alt: string | null;
      position: number;
    }>(
      `
        SELECT product_id, url, alt, position
        FROM product_images
        WHERE product_id = ANY($1)
        ORDER BY product_id, position ASC
      `,
      [ids]
    );

    imagesByProduct = imagesResult.rows.reduce((map, row) => {
      const list = map.get(row.product_id) ?? [];
      list.push({ url: row.url, alt: row.alt, position: row.position });
      map.set(row.product_id, list);
      return map;
    }, new Map<number, { url: string; alt: string | null; position: number }[]>());
  }

  return reply.send({
    ok: true,
    count: productsResult.rowCount,
    items: productsResult.rows.map((row) => ({
      ...row,
      price: Number(row.price),
      popularity: Number(row.popularity ?? 0),
      images: imagesByProduct.get(row.id) ?? []
    }))
  });
});

app.get("/api/v1/products/:id", async (request, reply) => {
  const params = request.params as { id?: string };
  const productId = Number(params.id);
  if (!Number.isInteger(productId) || productId <= 0) {
    return reply.code(400).send({ error: "INVALID_PRODUCT_ID" });
  }

  const productResult = await pool.query<{
    id: number;
    name: string;
    slug: string;
    description: string | null;
    price: string;
    currency: string;
    popularity: number;
    category_id: number | null;
    category_name: string | null;
    main_image_url: string | null;
    tags: string[] | null;
    attributes: Record<string, unknown>;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
  }>(
    `
      SELECT
        p.id,
        p.name,
        p.slug,
        p.description,
        p.price,
        p.currency,
        p.popularity,
        p.category_id,
        c.name AS category_name,
        p.main_image_url,
        p.tags,
        p.attributes,
        p.is_active,
        p.created_at,
        p.updated_at
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.id = $1 AND p.is_active = true
      LIMIT 1
    `,
    [productId]
  );

  if (productResult.rowCount === 0) {
    return reply.code(404).send({ error: "PRODUCT_NOT_FOUND" });
  }

  const imagesResult = await pool.query<{
    url: string;
    alt: string | null;
    position: number;
  }>(
    `
      SELECT url, alt, position
      FROM product_images
      WHERE product_id = $1
      ORDER BY position ASC
    `,
    [productId]
  );

  const product = productResult.rows[0];
  return reply.send({
    ok: true,
    product: {
      ...product,
      price: Number(product.price),
      popularity: Number(product.popularity ?? 0),
      images: imagesResult.rows
    }
  });
});

// خريطة العلاقات للمنتجات المكملة
const relatedMap: Record<string, string[]> = {
  salon: ["table", "carpet", "lamp"],
  table: ["chair", "carpet"],
  chair: ["table"],
  carpet: ["table", "salon"],
  sofa: ["table", "carpet"]
};

app.get("/api/v1/products/:id/recommendations", async (request, reply) => {
  const params = request.params as { id?: string };
  const productId = Number(params.id);
  if (!Number.isInteger(productId) || productId <= 0) {
    return reply.code(400).send({ error: "INVALID_PRODUCT_ID" });
  }

  const productResult = await pool.query<{
    id: number;
    category_id: number | null;
    price: string;
    category_slug: string | null;
  }>(
    `
      SELECT p.id, p.category_id, p.price, c.slug AS category_slug
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.id = $1 AND p.is_active = true
      LIMIT 1
    `,
    [productId]
  );

  if (productResult.rowCount === 0) {
    return reply.code(404).send({ error: "PRODUCT_NOT_FOUND" });
  }

  const current = productResult.rows[0];
  const relatedCategories = relatedMap[current.category_slug ?? ""] ?? [];

  const similar = await pool.query(
    `
      SELECT id, name, price, main_image_url
      FROM products
      WHERE category_id = $1 AND id != $2 AND is_active = true
      ORDER BY price ASC
      LIMIT 3
    `,
    [current.category_id, productId]
  );

  let complementaryRows: { id: number; name: string; price: string; main_image_url: string | null }[] = [];
  if (relatedCategories.length > 0) {
    const comp = await pool.query(
      `
        SELECT p.id, p.name, p.price, p.main_image_url
        FROM products p
        JOIN categories c ON p.category_id = c.id
        WHERE c.slug = ANY($1) AND p.is_active = true
        LIMIT 3
      `,
      [relatedCategories]
    );
    complementaryRows = comp.rows;
  }

  const upgrade = await pool.query(
    `
      SELECT id, name, price, main_image_url
      FROM products
      WHERE price > $1 AND is_active = true
      ORDER BY price ASC
      LIMIT 1
    `,
    [current.price]
  );

  return reply.send({
    ok: true,
    productId,
    similar: similar.rows.map((r) => ({ ...r, price: Number(r.price) })),
    complementary: complementaryRows.map((r) => ({ ...r, price: Number(r.price) })),
    upgrade: upgrade.rows[0] ? { ...upgrade.rows[0], price: Number(upgrade.rows[0].price) } : null
  });
});

type UserPrefs = {
  style?: string;
  max_price?: number;
  boostPromo?: boolean;
};

function computeScore(
  product: { price: number; popularity?: number | null; attributes?: Record<string, unknown>; created_at?: Date; tags?: string[] | null },
  prefs: UserPrefs
): number {
  const priceWeight = prefs.max_price && prefs.max_price < 3000 ? 0.7 : 0.5;
  const popularityWeight = 0.2;
  const styleWeight = 0.2;
  const recencyWeight = 0.1;

  const priceScore = 1 / (Number(product.price) + 1);
  const popularityScore = (product.popularity ?? 0) / 100;

  let styleScore = 0;
  const stylePref = (prefs.style ?? "").toLowerCase();
  const productStyle = String(product.attributes?.style ?? "").toLowerCase();
  if (stylePref && productStyle && stylePref === productStyle) {
    styleScore = 1;
  }

  const daysOld = product.created_at
    ? (Date.now() - product.created_at.getTime()) / (1000 * 60 * 60 * 24)
    : 365;
  const recencyScore = 1 / (daysOld + 1);

  const promoBoost = prefs.boostPromo && (product.tags ?? []).includes("promo") ? 0.2 : 0;

  return priceScore * priceWeight + popularityScore * popularityWeight + styleScore * styleWeight + recencyScore * recencyWeight + promoBoost;
}

app.post("/agent/search", async (request, reply) => {
  const body = (request.body ?? {}) as { category?: string; search?: string; max_price?: number; style?: string; limit?: number };
  const categorySlug = typeof body.category === "string" ? body.category.trim() : "";
  const search = typeof body.search === "string" ? body.search.trim() : "";
  const maxPrice = Number(body.max_price);
  const limitRaw = Number(body.limit);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 20;

  const params: unknown[] = [];
  const conditions: string[] = ["p.is_active = true"];

  if (categorySlug) {
    params.push(categorySlug);
    conditions.push(`c.slug = $${params.length}`);
  }

  if (Number.isFinite(maxPrice)) {
    params.push(maxPrice);
    conditions.push(`p.price <= $${params.length}`);
  }

  if (search) {
    params.push(`%${search}%`);
    params.push(`%${search}%`);
    conditions.push(`(p.name ILIKE $${params.length - 1} OR p.description ILIKE $${params.length})`);
  }

  params.push(limit);
  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const productsResult = await pool.query<{
    id: number;
    name: string;
    slug: string;
    description: string | null;
    price: string;
    currency: string;
    popularity: number;
    category_id: number | null;
    category_name: string | null;
    main_image_url: string | null;
    tags: string[] | null;
    attributes: Record<string, unknown>;
    created_at: Date;
  }>(
    `
      SELECT
        p.id,
        p.name,
        p.slug,
        p.description,
        p.price,
        p.currency,
        p.popularity,
        p.category_id,
        c.name AS category_name,
        p.main_image_url,
        p.tags,
        p.attributes,
        p.created_at
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      ${whereClause}
      ORDER BY p.created_at DESC
      LIMIT $${params.length}
    `,
    params
  );

  const prefs: UserPrefs = {
    style: body.style,
    max_price: Number.isFinite(maxPrice) ? maxPrice : undefined
  };

  const ranked = productsResult.rows
    .map((p) => ({
      ...p,
      price: Number(p.price),
      score: computeScore({ price: Number(p.price), popularity: p.popularity, attributes: p.attributes, created_at: p.created_at, tags: p.tags }, prefs)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const decorated = ranked.map((item, idx) => ({
    ...item,
    badge: idx === 0 ? "أفضل اختيار" : idx === ranked.length - 1 ? "الأرخص" : "الأكثر طلباً"
  }));

  return reply.send({
    ok: true,
    count: decorated.length,
    results: decorated
  });
});

app.post("/api/v1/admin/products", { preHandler: authenticateAdmin }, async (request, reply) => {
  const parsed = productInputSchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({
      error: "INVALID_PRODUCT_INPUT",
      details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }))
    });
  }

  const payload = parsed.data;

  const result = await withTransaction(async (client) => {
    const categoryId = await resolveCategoryId({ slug: payload.categorySlug, name: payload.categoryName }, client);

    const productInsert = await client.query<{ id: number }>(
      `
        INSERT INTO products (name, slug, description, price, currency, popularity, category_id, main_image_url, tags, attributes, is_active)
        VALUES ($1, $2, $3, $4, $5, COALESCE($6, 0), $7, $8, $9, COALESCE($10, '{}'::jsonb), COALESCE($11, true))
        RETURNING id
      `,
      [
        payload.name,
        payload.slug,
        payload.description ?? null,
        payload.price,
        payload.currency,
        payload.popularity ?? 0,
        categoryId,
        payload.mainImageUrl ?? null,
        payload.tags ?? null,
        payload.attributes ?? null,
        payload.isActive ?? true
      ]
    );

    const productId = productInsert.rows[0].id;

    if (payload.images && payload.images.length) {
      const values = payload.images.map((img, idx) => [
        productId,
        img.url,
        img.alt ?? null,
        img.position ?? idx + 1
      ]);
      await client.query(
        `
          INSERT INTO product_images (product_id, url, alt, position)
          SELECT * FROM UNNEST($1::bigint[], $2::text[], $3::text[], $4::int[])
        `,
        [
          values.map((v) => v[0]),
          values.map((v) => v[1]),
          values.map((v) => v[2]),
          values.map((v) => v[3])
        ]
      );
    }

    return productId;
  });

  return reply.code(201).send({ ok: true, id: result });
});

app.patch("/api/v1/admin/products/:id", { preHandler: authenticateAdmin }, async (request, reply) => {
  const params = request.params as { id?: string };
  const productId = Number(params.id);
  if (!Number.isInteger(productId) || productId <= 0) {
    return reply.code(400).send({ error: "INVALID_PRODUCT_ID" });
  }

  const parsed = productInputSchema.partial({ slug: true, name: true }).safeParse(request.body ?? {});
  if (!parsed.success) {
    return reply.code(400).send({
      error: "INVALID_PRODUCT_INPUT",
      details: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }))
    });
  }
  const payload = parsed.data;

  const updated = await withTransaction(async (client) => {
    const categoryId = await resolveCategoryId({ slug: payload.categorySlug, name: payload.categoryName }, client);

    const updateResult = await client.query(
      `
        UPDATE products
        SET
          name = COALESCE($1, name),
          slug = COALESCE($2, slug),
          description = COALESCE($3, description),
          price = COALESCE($4, price),
          currency = COALESCE($5, currency),
          popularity = COALESCE($6, popularity),
          category_id = COALESCE($7, category_id),
          main_image_url = COALESCE($8, main_image_url),
          tags = COALESCE($9, tags),
          attributes = COALESCE($10, attributes),
          is_active = COALESCE($11, is_active),
          updated_at = NOW()
        WHERE id = $12
        RETURNING id
      `,
      [
        payload.name ?? null,
        payload.slug ?? null,
        payload.description ?? null,
        payload.price ?? null,
        payload.currency ?? null,
        payload.popularity ?? null,
        categoryId,
        payload.mainImageUrl ?? null,
        payload.tags ?? null,
        payload.attributes ?? null,
        payload.isActive ?? null,
        productId
      ]
    );

    if (updateResult.rowCount === 0) return false;

    if (payload.images) {
      await client.query(`DELETE FROM product_images WHERE product_id = $1`, [productId]);
      if (payload.images.length) {
        const values = payload.images.map((img, idx) => [
          productId,
          img.url,
          img.alt ?? null,
          img.position ?? idx + 1
        ]);
        await client.query(
          `
            INSERT INTO product_images (product_id, url, alt, position)
            SELECT * FROM UNNEST($1::bigint[], $2::text[], $3::text[], $4::int[])
          `,
          [
            values.map((v) => v[0]),
            values.map((v) => v[1]),
            values.map((v) => v[2]),
            values.map((v) => v[3])
          ]
        );
      }
    }

    return true;
  });

  if (!updated) {
    return reply.code(404).send({ error: "PRODUCT_NOT_FOUND" });
  }

  return reply.send({ ok: true, id: productId });
});

app.delete("/api/v1/admin/products/:id", { preHandler: authenticateAdmin }, async (request, reply) => {
  const params = request.params as { id?: string };
  const productId = Number(params.id);
  if (!Number.isInteger(productId) || productId <= 0) {
    return reply.code(400).send({ error: "INVALID_PRODUCT_ID" });
  }

  const result = await pool.query(`DELETE FROM products WHERE id = $1`, [productId]);
  if (result.rowCount === 0) {
    return reply.code(404).send({ error: "PRODUCT_NOT_FOUND" });
  }
  return reply.code(204).send();
});

app.post("/api/v1/leads", async (request, reply) => {
  if (!enforceLeadRateLimit(request.ip)) {
    return reply.code(429).send({
      error: "RATE_LIMITED",
      message: "تم تجاوز عدد المحاولات، يرجى الانتظار قليلاً ثم المحاولة مرة أخرى."
    });
  }

  const parsed = createLeadSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({
      error: "INVALID_INPUT",
      details: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message
      }))
    });
  }

  const payload = parsed.data;
  const captchaValid = await verifyTurnstileToken(payload.captchaToken ?? "", request.ip);
  if (!captchaValid) {
    return reply.code(400).send({
      error: "INVALID_CAPTCHA",
      message: "التحقق الأمني غير صالح، أعد المحاولة."
    });
  }

  try {
    const lead = await withTransaction(async (client) => {
      const customerResult = await client.query<{ id: number }>(
        `
          INSERT INTO customers (full_name, phone, city)
          VALUES ($1, $2, NULLIF($3, ''))
          ON CONFLICT (phone) DO UPDATE
          SET full_name = EXCLUDED.full_name,
              city = COALESCE(NULLIF(EXCLUDED.city, ''), customers.city),
              updated_at = NOW()
          RETURNING id
        `,
        [payload.fullName, payload.phone, payload.city ?? ""]
      );

      const customerId = customerResult.rows[0].id;
      const leadResult = await client.query<{ id: number }>(
        `
          INSERT INTO leads (customer_id, product_type, budget_range, details, source)
          VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), $5)
          RETURNING id
        `,
        [
          customerId,
          payload.productType,
          payload.budgetRange ?? "",
          payload.details ?? "",
          payload.source ?? "website"
        ]
      );

      const leadId = leadResult.rows[0].id;

      await client.query(
        `
          INSERT INTO lead_events (lead_id, event_type, note)
          VALUES ($1, 'lead_created', 'Lead created from website form')
        `,
        [leadId]
      );

      return { id: leadId };
    });

    return reply.code(201).send({
      ok: true,
      leadId: lead.id,
      message: "تم حفظ الطلب بنجاح"
    });
  } catch (error) {
    request.log.error(error, "Failed to create lead");
    return reply.code(500).send({
      error: "INTERNAL_ERROR",
      message: "تعذر حفظ الطلب حالياً"
    });
  }
});

app.post("/api/v1/admin/auth/login", async (request, reply) => {
  const body = (request.body ?? {}) as { username?: string; password?: string; twoFactorCode?: string };
  const username = (body.username ?? "").trim();
  const password = body.password ?? "";
  const twoFactorCode = (body.twoFactorCode ?? "").trim();

  if (!username || !password) {
    return reply.code(400).send({ error: "INVALID_CREDENTIALS" });
  }

  const userResult = await pool.query<{
    id: number;
    username: string;
    password_hash: string;
    role: string;
    is_active: boolean;
    failed_attempts: number;
    locked_until: Date | null;
    two_factor_enabled: boolean;
    two_factor_secret: string | null;
  }>(
    `
      SELECT id, username, password_hash, role, is_active, failed_attempts, locked_until, two_factor_enabled, two_factor_secret
      FROM admin_users
      WHERE username = $1
      LIMIT 1
    `,
    [username]
  );

  if (userResult.rowCount === 0) {
    await writeAuditLog({
      action: "admin_login_failed_unknown_user",
      details: { username },
      request
    });
    return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
  }

  const user = userResult.rows[0];

  if (!user.is_active) {
    await writeAuditLog({
      userId: user.id,
      action: "admin_login_blocked_inactive",
      details: { username: user.username },
      request
    });
    return reply.code(403).send({ error: "ACCOUNT_DISABLED" });
  }

  if (user.locked_until && user.locked_until.getTime() > Date.now()) {
    await writeAuditLog({
      userId: user.id,
      action: "admin_login_blocked_locked",
      details: { lockedUntil: user.locked_until.toISOString() },
      request
    });
    return reply.code(423).send({
      error: "ACCOUNT_LOCKED",
      lockedUntil: user.locked_until.toISOString()
    });
  }

  const isValidPassword = await bcrypt.compare(password, user.password_hash);
  if (!isValidPassword) {
    const nextAttempts = user.failed_attempts + 1;
    const shouldLock = nextAttempts >= lockoutMaxAttempts;

    await pool.query(
      `
        UPDATE admin_users
        SET failed_attempts = $1,
            locked_until = CASE WHEN $2 THEN NOW() + ($3 || ' minutes')::interval ELSE NULL END
        WHERE id = $4
      `,
      [nextAttempts, shouldLock, lockoutMinutes, user.id]
    );

    await writeAuditLog({
      userId: user.id,
      action: shouldLock ? "admin_login_locked_by_failures" : "admin_login_failed_password",
      details: { failedAttempts: nextAttempts, threshold: lockoutMaxAttempts },
      request
    });

    if (shouldLock) {
      return reply.code(423).send({ error: "ACCOUNT_LOCKED" });
    }
    return reply.code(401).send({ error: "INVALID_CREDENTIALS" });
  }

  if (user.two_factor_enabled) {
    const secret = user.two_factor_secret ?? "";
    const isTwoFactorValid = Boolean(twoFactorCode) && authenticator.check(twoFactorCode, secret);
    if (!isTwoFactorValid) {
      const nextAttempts = user.failed_attempts + 1;
      const shouldLock = nextAttempts >= lockoutMaxAttempts;
      await pool.query(
        `
          UPDATE admin_users
          SET failed_attempts = $1,
              locked_until = CASE WHEN $2 THEN NOW() + ($3 || ' minutes')::interval ELSE NULL END
          WHERE id = $4
        `,
        [nextAttempts, shouldLock, lockoutMinutes, user.id]
      );

      await writeAuditLog({
        userId: user.id,
        action: shouldLock ? "admin_login_locked_by_2fa_failures" : "admin_login_failed_2fa",
        details: { failedAttempts: nextAttempts, threshold: lockoutMaxAttempts },
        request
      });

      if (!twoFactorCode) {
        return reply.code(202).send({ requiresTwoFactor: true });
      }

      if (shouldLock) {
        return reply.code(423).send({ error: "ACCOUNT_LOCKED" });
      }
      return reply.code(401).send({ error: "INVALID_2FA_CODE" });
    }
  }

  await pool.query(
    `
      UPDATE admin_users
      SET failed_attempts = 0,
          locked_until = NULL,
          last_login_at = NOW()
      WHERE id = $1
    `,
    [user.id]
  );

  const session = await createAdminSession({
    userId: user.id,
    username: user.username,
    role: user.role,
    request
  });

  await writeAuditLog({
    userId: user.id,
    action: "admin_login_success",
    details: { username: user.username },
    request
  });

  return reply.send({
    ok: true,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      twoFactorEnabled: user.two_factor_enabled
    }
  });
});

app.post("/api/v1/admin/auth/refresh", async (request, reply) => {
  const body = (request.body ?? {}) as { refreshToken?: string };
  const refreshToken = (body.refreshToken ?? "").trim();
  if (!refreshToken) {
    return reply.code(400).send({ error: "INVALID_REFRESH_TOKEN" });
  }

  const refreshTokenHash = hashToken(refreshToken);
  const sessionResult = await pool.query<{
    session_id: number;
    user_id: number;
    username: string;
    role: string;
    is_active: boolean;
  }>(
    `
      SELECT
        s.id AS session_id,
        u.id AS user_id,
        u.username,
        u.role,
        u.is_active
      FROM admin_sessions s
      INNER JOIN admin_users u ON u.id = s.user_id
      WHERE s.refresh_token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW()
      LIMIT 1
    `,
    [refreshTokenHash]
  );

  if (sessionResult.rowCount === 0) {
    return reply.code(401).send({ error: "INVALID_REFRESH_TOKEN" });
  }

  const session = sessionResult.rows[0];
  if (!session.is_active) {
    return reply.code(403).send({ error: "ACCOUNT_DISABLED" });
  }

  const newSession = await createAdminSession({
    userId: session.user_id,
    username: session.username,
    role: session.role,
    request
  });

  await pool.query(
    `
      UPDATE admin_sessions
      SET revoked_at = NOW()
      WHERE id = $1
    `,
    [session.session_id]
  );

  await writeAuditLog({
    userId: session.user_id,
    action: "admin_token_refreshed",
    request
  });

  return reply.send({
    ok: true,
    accessToken: newSession.accessToken,
    refreshToken: newSession.refreshToken
  });
});

app.post("/api/v1/admin/auth/logout", async (request, reply) => {
  const body = (request.body ?? {}) as { refreshToken?: string };
  const refreshToken = (body.refreshToken ?? "").trim();
  if (!refreshToken) {
    return reply.code(204).send();
  }

  const refreshTokenHash = hashToken(refreshToken);
  await pool.query(
    `
      UPDATE admin_sessions
      SET revoked_at = NOW()
      WHERE refresh_token_hash = $1
        AND revoked_at IS NULL
    `,
    [refreshTokenHash]
  );

  return reply.code(204).send();
});

app.get("/api/v1/admin/auth/me", { preHandler: authenticateAdmin }, async (request) => {
  const admin = (request as AdminRequest).admin;
  const result = await pool.query<{
    id: number;
    username: string;
    role: string;
    two_factor_enabled: boolean;
    last_login_at: Date | null;
  }>(
    `
      SELECT id, username, role, two_factor_enabled, last_login_at
      FROM admin_users
      WHERE id = $1
      LIMIT 1
    `,
    [Number(admin.sub)]
  );

  if (result.rowCount === 0) {
    return { ok: false };
  }

  const user = result.rows[0];
  return {
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      twoFactorEnabled: user.two_factor_enabled,
      lastLoginAt: user.last_login_at?.toISOString() ?? null
    }
  };
});

const twoFaSetupHandler = async (request: FastifyRequest, reply: FastifyReply) => {
  const admin = (request as AdminRequest).admin;
  const secret = authenticator.generateSecret();
  const otpauthUrl = authenticator.keyuri(admin.username, "JD Boujdour", secret);

  await writeAuditLog({
    userId: Number(admin.sub),
    action: "admin_2fa_setup_requested",
    request
  });

  return reply.send({
    ok: true,
    secret,
    otpauthUrl,
    issuer: "JD Boujdour",
    account: admin.username
  });
};

app.get("/api/v1/admin/auth/2fa/setup", { preHandler: authenticateAdmin }, twoFaSetupHandler);
app.post("/api/v1/admin/auth/2fa/setup", { preHandler: authenticateAdmin }, twoFaSetupHandler);

app.post("/api/v1/admin/auth/2fa/enable", { preHandler: authenticateAdmin }, async (request, reply) => {
  const admin = (request as AdminRequest).admin;
  const body = (request.body ?? {}) as { secret?: string; code?: string };
  const secret = (body.secret ?? "").trim();
  const code = (body.code ?? "").trim();

  if (!secret || !code) {
    return reply.code(400).send({ error: "INVALID_2FA_PAYLOAD" });
  }

  const isValid = authenticator.check(code, secret);
  if (!isValid) {
    await writeAuditLog({
      userId: Number(admin.sub),
      action: "admin_2fa_enable_failed",
      request
    });
    return reply.code(400).send({ error: "INVALID_2FA_CODE" });
  }

  await pool.query(
    `
      UPDATE admin_users
      SET two_factor_enabled = true,
          two_factor_secret = $1
      WHERE id = $2
    `,
    [secret, Number(admin.sub)]
  );

  await writeAuditLog({
    userId: Number(admin.sub),
    action: "admin_2fa_enabled",
    request
  });

  return reply.send({ ok: true, twoFactorEnabled: true });
});

app.post("/api/v1/admin/auth/2fa/disable", { preHandler: authenticateAdmin }, async (request, reply) => {
  const admin = (request as AdminRequest).admin;
  const body = (request.body ?? {}) as { code?: string };
  const code = (body.code ?? "").trim();

  const result = await pool.query<{ two_factor_secret: string | null; two_factor_enabled: boolean }>(
    `
      SELECT two_factor_secret, two_factor_enabled
      FROM admin_users
      WHERE id = $1
      LIMIT 1
    `,
    [Number(admin.sub)]
  );

  if (result.rowCount === 0) {
    return reply.code(404).send({ error: "USER_NOT_FOUND" });
  }

  const row = result.rows[0];
  if (!row.two_factor_enabled || !row.two_factor_secret) {
    return reply.send({ ok: true, twoFactorEnabled: false });
  }

  const isValid = Boolean(code) && authenticator.check(code, row.two_factor_secret);
  if (!isValid) {
    await writeAuditLog({
      userId: Number(admin.sub),
      action: "admin_2fa_disable_failed",
      request
    });
    return reply.code(400).send({ error: "INVALID_2FA_CODE" });
  }

  await pool.query(
    `
      UPDATE admin_users
      SET two_factor_enabled = false,
          two_factor_secret = NULL
      WHERE id = $1
    `,
    [Number(admin.sub)]
  );

  await writeAuditLog({
    userId: Number(admin.sub),
    action: "admin_2fa_disabled",
    request
  });

  return reply.send({ ok: true, twoFactorEnabled: false });
});

app.get("/api/v1/admin/leads", { preHandler: authenticateAdmin }, async (request, reply) => {
  const status = typeof request.query === "object" && request.query !== null
    ? (request.query as Record<string, unknown>).status
    : undefined;

  const limitRaw = typeof request.query === "object" && request.query !== null
    ? (request.query as Record<string, unknown>).limit
    : undefined;

  const limit = Number.isFinite(Number(limitRaw)) ? Math.min(Math.max(Number(limitRaw), 1), 200) : 50;

  try {
    const hasValidStatus = typeof status === "string" && allowedStatuses.has(status);
    const sql = hasValidStatus
      ? `
          SELECT
            l.id,
            l.product_type,
            l.budget_range,
            l.details,
            l.status,
            l.source,
            l.created_at,
            c.full_name,
            c.phone,
            c.city
          FROM leads l
          INNER JOIN customers c ON c.id = l.customer_id
          WHERE l.status = $1
          ORDER BY l.created_at DESC
          LIMIT $2
        `
      : `
          SELECT
            l.id,
            l.product_type,
            l.budget_range,
            l.details,
            l.status,
            l.source,
            l.created_at,
            c.full_name,
            c.phone,
            c.city
          FROM leads l
          INNER JOIN customers c ON c.id = l.customer_id
          ORDER BY l.created_at DESC
          LIMIT $1
        `;

    const params = hasValidStatus ? [status, limit] : [limit];
    const result = await pool.query(sql, params);
    return reply.send({ ok: true, count: result.rowCount, items: result.rows });
  } catch (error) {
    request.log.error(error, "Failed to fetch admin leads");
    return reply.code(500).send({ error: "INTERNAL_ERROR" });
  }
});

app.patch("/api/v1/admin/leads/:id/status", { preHandler: authenticateAdmin }, async (request, reply) => {
  const admin = (request as AdminRequest).admin;
  const params = request.params as { id?: string };
  const body = request.body as { status?: string; note?: string } | undefined;
  const leadId = Number(params.id);
  const nextStatus = body?.status;
  const note = (body?.note ?? "").trim();

  if (!Number.isInteger(leadId) || leadId <= 0) {
    return reply.code(400).send({ error: "INVALID_LEAD_ID" });
  }

  if (typeof nextStatus !== "string" || !allowedStatuses.has(nextStatus)) {
    return reply.code(400).send({
      error: "INVALID_STATUS",
      allowed: Array.from(allowedStatuses)
    });
  }

  try {
    const updated = await withTransaction(async (client) => {
      const updateResult = await client.query<{ id: number; status: string }>(
        `
          UPDATE leads
          SET status = $1
          WHERE id = $2
          RETURNING id, status
        `,
        [nextStatus, leadId]
      );

      if (updateResult.rowCount === 0) {
        return null;
      }

      await client.query(
        `
          INSERT INTO lead_events (lead_id, event_type, note)
          VALUES ($1, 'status_changed', $2)
        `,
        [leadId, note || `Status changed to ${nextStatus}`]
      );

      return updateResult.rows[0];
    });

    if (!updated) {
      return reply.code(404).send({ error: "LEAD_NOT_FOUND" });
    }

    await writeAuditLog({
      userId: Number(admin.sub),
      action: "admin_lead_status_updated",
      details: { leadId, status: nextStatus },
      request
    });

    return reply.send({ ok: true, id: updated.id, status: updated.status });
  } catch (error) {
    request.log.error(error, "Failed to update lead status");
    return reply.code(500).send({ error: "INTERNAL_ERROR" });
  }
});

app.get("/api/v1/admin/audit-logs", { preHandler: authenticateAdmin }, async (request, reply) => {
  const limitRaw = typeof request.query === "object" && request.query !== null
    ? (request.query as Record<string, unknown>).limit
    : undefined;
  const limit = Number.isFinite(Number(limitRaw)) ? Math.min(Math.max(Number(limitRaw), 1), 200) : 50;

  const result = await pool.query(
    `
      SELECT id, user_id, action, details, ip_address, user_agent, created_at
      FROM admin_audit_logs
      ORDER BY created_at DESC
      LIMIT $1
    `,
    [limit]
  );

  return reply.send({ ok: true, count: result.rowCount, items: result.rows });
});

const port = Number(process.env.PORT ?? 3000);
const host = "0.0.0.0";

const start = async () => {
  try {
    await ensureAdminSchemaAndSeed();
    await ensureCatalogSchema();
    await app.listen({ host, port });
    app.log.info(`API listening on ${host}:${port}`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

const gracefulShutdown = async () => {
  try {
    await app.close();
    await pool.end();
    process.exit(0);
  } catch {
    process.exit(1);
  }
};

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

void start();
