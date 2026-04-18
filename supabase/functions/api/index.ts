import { createClient } from "npm:@supabase/supabase-js@2";
import bcrypt from "npm:bcryptjs@2.4.3";
import { SignJWT, jwtVerify } from "npm:jose@5.9.6";
import { authenticator } from "npm:otplib@12";

type Json = Record<string, unknown>;

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const jwtSecret =
  (Deno.env.get("ADMIN_JWT_SECRET") ?? Deno.env.get("JWT_SECRET") ?? "").trim();

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in Edge Function secrets");
}
if (!jwtSecret || jwtSecret.length < 12) {
  throw new Error("Missing ADMIN_JWT_SECRET/JWT_SECRET (min length 12) in Edge Function secrets");
}

const supabase = createClient(supabaseUrl, serviceRoleKey);
const jwtKey = new TextEncoder().encode(jwtSecret);

const jwtIssuer = "jd-boujdour-api";
const jwtAudience = "jd-boujdour-admin";

function jsonResponse(body: Json, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function parseCorsOrigins(): { allowAny: boolean; allowList: string[] } {
  const raw = (Deno.env.get("CORS_ORIGIN") ?? "*")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const allowAny = raw.includes("*") || raw.length === 0;
  return { allowAny, allowList: raw };
}

function withCors(req: Request, res: Response): Response {
  const origin = req.headers.get("origin") ?? "";
  const { allowAny, allowList } = parseCorsOrigins();

  const headers = new Headers(res.headers);
  if (allowAny) {
    headers.set("access-control-allow-origin", "*");
  } else if (origin && allowList.includes(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "origin");
    headers.set("access-control-allow-credentials", "true");
  }

  headers.set("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
  headers.set("access-control-allow-headers", "content-type, authorization, x-client-info, apikey");
  headers.set("access-control-max-age", "86400");

  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function normalizeText(value: unknown, maxLen: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.slice(0, maxLen);
}

async function readJsonBody(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function isValidMoroccanPhone(phone: string): boolean {
  return /^(?:\+212|212|0)(?:5|6|7)[0-9]{8}$/.test(phone);
}

function getRequestIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first.slice(0, 80);
  }
  const cfIp = req.headers.get("cf-connecting-ip");
  if (cfIp) return cfIp.trim().slice(0, 80);
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim().slice(0, 80);
  return "";
}

function getUserAgent(req: Request): string {
  return (req.headers.get("user-agent") ?? "").trim().slice(0, 300);
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function createRefreshToken(): string {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function getBearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

async function signAccessToken(payload: { sub: string; username: string; role: string }, ttlSeconds: number): Promise<string> {
  return await new SignJWT({
    username: payload.username,
    role: payload.role,
    typ: "admin_access",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(jwtIssuer)
    .setAudience(jwtAudience)
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${Math.max(60, ttlSeconds)}s`)
    .sign(jwtKey);
}

async function verifyAccessToken(token: string): Promise<{ sub: string; username: string; role: string } | null> {
  try {
    const { payload } = await jwtVerify(token, jwtKey, {
      algorithms: ["HS256"],
      issuer: jwtIssuer,
      audience: jwtAudience,
    });
    const sub = String(payload.sub ?? "");
    const username = typeof payload.username === "string" ? payload.username : "";
    const role = typeof payload.role === "string" ? payload.role : "";
    if (!sub || !username || !role) return null;
    return { sub, username, role };
  } catch {
    return null;
  }
}

async function writeAuditLog(params: {
  userId?: number | null;
  action: string;
  details?: Record<string, unknown>;
  req: Request;
}): Promise<void> {
  await supabase.from("admin_audit_logs").insert({
    user_id: params.userId ?? null,
    action: params.action,
    details: params.details ?? null,
    ip_address: getRequestIp(params.req) || null,
    user_agent: getUserAgent(params.req) || null,
  });
}

async function ensureSeedAdminUser(): Promise<void> {
  const seedUsername = (Deno.env.get("ADMIN_USERNAME") ?? "").trim();
  const seedPassword = Deno.env.get("ADMIN_PASSWORD") ?? "";
  if (!seedUsername || !seedPassword) return;

  const { data: anyUser } = await supabase.from("admin_users").select("id").limit(1);
  if (anyUser && anyUser.length > 0) {
    const syncOnStart = (Deno.env.get("ADMIN_SYNC_PASSWORD_ON_START") ?? "false").toLowerCase() === "true";
    if (!syncOnStart) return;
    const hash = bcrypt.hashSync(seedPassword, 10);
    await supabase.from("admin_users").update({ password_hash: hash }).eq("username", seedUsername);
    return;
  }

  const hash = bcrypt.hashSync(seedPassword, 10);
  await supabase.from("admin_users").insert({
    username: seedUsername,
    password_hash: hash,
    role: "admin",
    is_active: true,
    failed_attempts: 0,
    locked_until: null,
    two_factor_enabled: false,
    two_factor_secret: null,
  });
}

async function verifyTurnstile(params: { token: string; remoteIp: string }): Promise<boolean> {
  const enabled = (Deno.env.get("TURNSTILE_ENABLED") ?? "false").toLowerCase() === "true";
  if (!enabled) return true;
  const secretKey = (Deno.env.get("TURNSTILE_SECRET_KEY") ?? "").trim();
  if (!secretKey) return false;
  if (!params.token) return false;

  const body = new URLSearchParams();
  body.set("secret", secretKey);
  body.set("response", params.token);
  if (params.remoteIp) body.set("remoteip", params.remoteIp);

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) return false;
  const data = await response.json().catch(() => null);
  return Boolean(data && data.success === true);
}

const allowedLeadStatuses = new Set(["new", "contacted", "closed"]);

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const pathname = url.pathname;

    if (req.method === "OPTIONS") {
      return withCors(req, new Response(null, { status: 204 }));
    }

    // Expected calls:
    // https://<project-ref>.supabase.co/functions/v1/api/v1/...
    const basePrefix = "/functions/v1/api";
    const afterPrefix = pathname.startsWith(basePrefix) ? pathname.slice(basePrefix.length) : pathname;
    // Be tolerant to callers that accidentally include `/api` in JD_API_BASE:
    // https://.../functions/v1/api + /api/v1/... => /functions/v1/api/api/v1/...
    const routePath = afterPrefix.startsWith("/api/v1/")
      ? `/v1/${afterPrefix.slice("/api/v1/".length)}`
      : afterPrefix;

    // keep a very simple ping route
    if (
      req.method === "GET" &&
      (routePath === "" ||
        routePath === "/" ||
        routePath === "/api" ||
        routePath === "/v1" ||
        routePath === "/v1/health" ||
        routePath === "/health")
    ) {
      return withCors(
        req,
        jsonResponse(
          {
            ok: true,
            function: "api",
            service: "supabase-edge",
            hint: "Use /api/v1/... from the frontend (or /v1/... inside this function).",
          },
          { status: 200 },
        ),
      );
    }

    if (!routePath.startsWith("/v1/")) {
      return withCors(req, jsonResponse({ ok: false, error: "NOT_FOUND" }, { status: 404 }));
    }

    // Public config (captcha)
    if (req.method === "GET" && routePath === "/v1/public-config") {
      const enabled = (Deno.env.get("TURNSTILE_ENABLED") ?? "false").toLowerCase() === "true";
      const siteKey = Deno.env.get("TURNSTILE_SITE_KEY") ?? "";
      return withCors(req, jsonResponse({ ok: true, captcha: { enabled, provider: "turnstile", siteKey } }, { status: 200 }));
    }

    // Products
    if (req.method === "GET" && routePath === "/v1/products") {
      const limitRaw = url.searchParams.get("limit") ?? "30";
      const limit = Number.isFinite(Number(limitRaw)) ? Math.min(Math.max(Number(limitRaw), 1), 100) : 30;

      const { data, error } = await supabase
        .from("products")
        .select("id,name,slug,price,currency,popularity,main_image_url,is_active")
        .eq("is_active", true)
        .order("popularity", { ascending: false })
        .limit(limit);

      if (error) {
        console.error("products query failed", error);
        return withCors(req, jsonResponse({ ok: false, error: "INTERNAL_ERROR" }, { status: 500 }));
      }

      return withCors(req, jsonResponse({ ok: true, count: data?.length ?? 0, items: data ?? [] }, { status: 200 }));
    }

    // Leads (public)
    if (req.method === "POST" && routePath === "/v1/leads") {
      const body = await readJsonBody(req);
      if (!body || typeof body !== "object") {
        return withCors(req, jsonResponse({ ok: false, error: "INVALID_JSON" }, { status: 400 }));
      }

      const fullName = normalizeText(body.fullName, 120);
      const phone = normalizeText(body.phone, 40).replace(/\s+/g, "");
      const city = normalizeText(body.city, 120);
      const productType = normalizeText(body.productType, 150);
      const budgetRange = normalizeText(body.budgetRange, 100);
      const details = normalizeText(body.details, 1200);
      const source = normalizeText(body.source ?? "website", 40) || "website";
      const captchaToken = normalizeText(body.captchaToken, 2048);

      if (fullName.length < 2 || productType.length < 2) {
        return withCors(req, jsonResponse({ ok: false, error: "VALIDATION_ERROR" }, { status: 400 }));
      }
      if (!isValidMoroccanPhone(phone)) {
        return withCors(req, jsonResponse({ ok: false, error: "INVALID_PHONE" }, { status: 400 }));
      }

      const ip = getRequestIp(req);
      const captchaValid = await verifyTurnstile({ token: captchaToken, remoteIp: ip });
      if (!captchaValid) {
        return withCors(req, jsonResponse({ ok: false, error: "INVALID_CAPTCHA" }, { status: 400 }));
      }

      const { data: customerRows, error: customerError } = await supabase
        .from("customers")
        .upsert({ full_name: fullName, phone, city: city || null }, { onConflict: "phone" })
        .select("id")
        .limit(1);

      if (customerError || !customerRows?.length) {
        console.error("customer upsert failed", customerError);
        return withCors(req, jsonResponse({ ok: false, error: "INTERNAL_ERROR" }, { status: 500 }));
      }

      const customerId = customerRows[0].id;

      const { data: leadRows, error: leadError } = await supabase
        .from("leads")
        .insert({
          customer_id: customerId,
          product_type: productType,
          budget_range: budgetRange || null,
          details: details || null,
          source,
          status: "new",
        })
        .select("id")
        .limit(1);

      if (leadError || !leadRows?.length) {
        console.error("lead insert failed", leadError);
        return withCors(req, jsonResponse({ ok: false, error: "INTERNAL_ERROR" }, { status: 500 }));
      }

      const leadId = leadRows[0].id;
      await supabase.from("lead_events").insert({ lead_id: leadId, event_type: "created", note: details || null });

      return withCors(req, jsonResponse({ ok: true, leadId }, { status: 201 }));
    }

    // =========================
    // Admin API (matches admin.js)
    // =========================

    if (req.method === "POST" && routePath === "/v1/admin/auth/login") {
      await ensureSeedAdminUser();
      const body = await readJsonBody(req);
      const username = normalizeText(body?.username, 120);
      const password = typeof body?.password === "string" ? body.password : "";
      const twoFactorCode = normalizeText(body?.twoFactorCode, 32).replace(/\s+/g, "");

      if (!username || !password) {
        return withCors(req, jsonResponse({ ok: false, error: "VALIDATION_ERROR" }, { status: 400 }));
      }

      const { data: admin, error } = await supabase
        .from("admin_users")
        .select("id,username,password_hash,role,is_active,failed_attempts,locked_until,two_factor_enabled,two_factor_secret")
        .eq("username", username)
        .maybeSingle();

      if (error) {
        return withCors(req, jsonResponse({ ok: false, error: "INTERNAL_ERROR" }, { status: 500 }));
      }

      if (!admin) {
        await writeAuditLog({ userId: null, action: "admin_login_failed_unknown_user", details: { username }, req });
        return withCors(req, jsonResponse({ ok: false, error: "INVALID_CREDENTIALS" }, { status: 401 }));
      }

      if (!admin.is_active) {
        await writeAuditLog({ userId: admin.id, action: "admin_login_blocked_inactive", req });
        return withCors(req, jsonResponse({ ok: false, error: "ACCOUNT_INACTIVE" }, { status: 403 }));
      }

      if (admin.locked_until && new Date(admin.locked_until) > new Date()) {
        await writeAuditLog({ userId: admin.id, action: "admin_login_blocked_locked", req });
        return withCors(req, jsonResponse({ ok: false, error: "ACCOUNT_LOCKED" }, { status: 423 }));
      }

      const passwordOk = bcrypt.compareSync(password, admin.password_hash);
      const maxFailedAttempts = Number(Deno.env.get("ADMIN_LOCKOUT_MAX_ATTEMPTS") ?? "5");
      const lockMinutes = Number(Deno.env.get("ADMIN_LOCKOUT_MINUTES") ?? "15");

      if (!passwordOk) {
        const nextFailedAttempts = (admin.failed_attempts ?? 0) + 1;
        let nextLockedUntil: string | null = null;
        if (nextFailedAttempts >= Math.max(1, maxFailedAttempts)) {
          const lockDate = new Date();
          lockDate.setMinutes(lockDate.getMinutes() + Math.max(1, lockMinutes));
          nextLockedUntil = lockDate.toISOString();
        }
        await supabase
          .from("admin_users")
          .update({ failed_attempts: nextFailedAttempts, locked_until: nextLockedUntil })
          .eq("id", admin.id);
        await writeAuditLog({ userId: admin.id, action: "admin_login_failed_password", req });
        if (nextLockedUntil) await writeAuditLog({ userId: admin.id, action: "admin_login_locked_by_failures", req });
        return withCors(req, jsonResponse({ ok: false, error: "INVALID_CREDENTIALS" }, { status: nextLockedUntil ? 423 : 401 }));
      }

      if (admin.two_factor_enabled) {
        if (!twoFactorCode) {
          return withCors(req, jsonResponse({ ok: false, error: "TWO_FACTOR_REQUIRED" }, { status: 202 }));
        }
        const secret = admin.two_factor_secret ?? "";
        const ok = Boolean(secret) && authenticator.verify({ token: twoFactorCode, secret });
        if (!ok) {
          const nextFailedAttempts = (admin.failed_attempts ?? 0) + 1;
          let nextLockedUntil: string | null = null;
          if (nextFailedAttempts >= Math.max(1, maxFailedAttempts)) {
            const lockDate = new Date();
            lockDate.setMinutes(lockDate.getMinutes() + Math.max(1, lockMinutes));
            nextLockedUntil = lockDate.toISOString();
          }
          await supabase
            .from("admin_users")
            .update({ failed_attempts: nextFailedAttempts, locked_until: nextLockedUntil })
            .eq("id", admin.id);
          await writeAuditLog({ userId: admin.id, action: "admin_login_failed_2fa", req });
          if (nextLockedUntil) await writeAuditLog({ userId: admin.id, action: "admin_login_locked_by_2fa_failures", req });
          return withCors(req, jsonResponse({ ok: false, error: "INVALID_2FA" }, { status: nextLockedUntil ? 423 : 401 }));
        }
      }

      await supabase
        .from("admin_users")
        .update({ failed_attempts: 0, locked_until: null, last_login_at: new Date().toISOString() })
        .eq("id", admin.id);

      const accessTtlSeconds = Number(Deno.env.get("ACCESS_TOKEN_TTL_SECONDS") ?? "900");
      const refreshTokenDays = Number(Deno.env.get("REFRESH_TOKEN_DAYS") ?? "7");

      const refreshToken = createRefreshToken();
      const refreshTokenHash = await sha256Hex(refreshToken);
      const expiresAt = new Date(Date.now() + Math.max(1, refreshTokenDays) * 86_400_000).toISOString();
      await supabase.from("admin_sessions").insert({
        user_id: admin.id,
        refresh_token_hash: refreshTokenHash,
        expires_at: expiresAt,
        revoked_at: null,
        user_agent: getUserAgent(req) || null,
        ip_address: getRequestIp(req) || null,
      });

      const accessToken = await signAccessToken({ sub: String(admin.id), username: admin.username, role: admin.role }, accessTtlSeconds);
      await writeAuditLog({ userId: admin.id, action: "admin_login_success", req });

      return withCors(
        req,
        jsonResponse(
          { ok: true, accessToken, refreshToken, user: { id: admin.id, username: admin.username, role: admin.role } },
          { status: 200 },
        ),
      );
    }

    if (req.method === "POST" && routePath === "/v1/admin/auth/refresh") {
      const body = await readJsonBody(req);
      const refreshToken = typeof body?.refreshToken === "string" ? body.refreshToken : "";
      if (!refreshToken) return withCors(req, jsonResponse({ ok: false, error: "VALIDATION_ERROR" }, { status: 400 }));

      const refreshTokenHash = await sha256Hex(refreshToken);
      const { data: sessionRows } = await supabase
        .from("admin_sessions")
        .select("id,user_id,expires_at,revoked_at")
        .eq("refresh_token_hash", refreshTokenHash)
        .limit(1);
      const session = sessionRows?.[0];
      if (!session || session.revoked_at || (session.expires_at && new Date(session.expires_at) <= new Date())) {
        return withCors(req, jsonResponse({ ok: false, error: "INVALID_SESSION" }, { status: 401 }));
      }

      const { data: admin } = await supabase
        .from("admin_users")
        .select("id,username,role,is_active,locked_until")
        .eq("id", session.user_id)
        .maybeSingle();
      if (!admin || !admin.is_active) {
        return withCors(req, jsonResponse({ ok: false, error: "INVALID_SESSION" }, { status: 401 }));
      }
      if (admin.locked_until && new Date(admin.locked_until) > new Date()) {
        return withCors(req, jsonResponse({ ok: false, error: "ACCOUNT_LOCKED" }, { status: 423 }));
      }

      await supabase.from("admin_sessions").update({ revoked_at: new Date().toISOString() }).eq("id", session.id);

      const refreshTokenDays = Number(Deno.env.get("REFRESH_TOKEN_DAYS") ?? "7");
      const newRefreshToken = createRefreshToken();
      const newHash = await sha256Hex(newRefreshToken);
      const expiresAt = new Date(Date.now() + Math.max(1, refreshTokenDays) * 86_400_000).toISOString();
      await supabase.from("admin_sessions").insert({
        user_id: admin.id,
        refresh_token_hash: newHash,
        expires_at: expiresAt,
        revoked_at: null,
        user_agent: getUserAgent(req) || null,
        ip_address: getRequestIp(req) || null,
      });

      const accessTtlSeconds = Number(Deno.env.get("ACCESS_TOKEN_TTL_SECONDS") ?? "900");
      const accessToken = await signAccessToken({ sub: String(admin.id), username: admin.username, role: admin.role }, accessTtlSeconds);
      await writeAuditLog({ userId: admin.id, action: "admin_token_refreshed", req });

      return withCors(req, jsonResponse({ ok: true, accessToken, refreshToken: newRefreshToken }, { status: 200 }));
    }

    if (req.method === "POST" && routePath === "/v1/admin/auth/logout") {
      const body = await readJsonBody(req);
      const refreshToken = typeof body?.refreshToken === "string" ? body.refreshToken : "";
      if (refreshToken) {
        const refreshTokenHash = await sha256Hex(refreshToken);
        await supabase
          .from("admin_sessions")
          .update({ revoked_at: new Date().toISOString() })
          .eq("refresh_token_hash", refreshTokenHash);
      }
      return withCors(req, jsonResponse({ ok: true }, { status: 200 }));
    }

    // Authenticated admin routes
    if (routePath.startsWith("/v1/admin/")) {
      const token = getBearerToken(req);
      if (!token) return withCors(req, jsonResponse({ ok: false, error: "UNAUTHORIZED" }, { status: 401 }));
      const payload = await verifyAccessToken(token);
      if (!payload) return withCors(req, jsonResponse({ ok: false, error: "UNAUTHORIZED" }, { status: 401 }));
      const adminUserId = Number(payload.sub);
      if (!Number.isFinite(adminUserId) || adminUserId <= 0) {
        return withCors(req, jsonResponse({ ok: false, error: "UNAUTHORIZED" }, { status: 401 }));
      }

      if (req.method === "GET" && routePath === "/v1/admin/auth/me") {
        const { data: admin } = await supabase
          .from("admin_users")
          .select("id,username,role,is_active,two_factor_enabled,last_login_at")
          .eq("id", adminUserId)
          .maybeSingle();
        if (!admin || !admin.is_active) {
          return withCors(req, jsonResponse({ ok: false, error: "UNAUTHORIZED" }, { status: 401 }));
        }
        return withCors(req, jsonResponse({ ok: true, user: admin }, { status: 200 }));
      }

      if (req.method === "GET" && routePath === "/v1/admin/leads") {
        const statusParam = (url.searchParams.get("status") ?? "").trim();
        const query = supabase
          .from("leads")
          .select("id,created_at,customer_id,product_type,budget_range,details,status")
          .order("created_at", { ascending: false })
          .limit(200);
        const { data, error } = statusParam ? await query.eq("status", statusParam) : await query;
        if (error) return withCors(req, jsonResponse({ ok: false, error: "INTERNAL_ERROR" }, { status: 500 }));

        const leads = (data ?? []) as any[];
        const customerIds = Array.from(new Set(leads.map((l) => l.customer_id).filter((id) => Number.isInteger(id) && id > 0)));
        const customersById = new Map<number, { full_name: string; phone: string; city: string | null }>();
        if (customerIds.length) {
          const { data: customerRows } = await supabase
            .from("customers")
            .select("id,full_name,phone,city")
            .in("id", customerIds);
          for (const c of customerRows ?? []) {
            customersById.set(c.id, { full_name: c.full_name, phone: c.phone, city: c.city ?? null });
          }
        }

        const items = leads.map((row) => {
          const customer = customersById.get(row.customer_id) ?? { full_name: "", phone: "", city: null };
          return {
            id: row.id,
            created_at: row.created_at,
            full_name: customer.full_name,
            phone: customer.phone,
            city: customer.city,
            product_type: row.product_type,
            budget_range: row.budget_range ?? null,
            details: row.details ?? null,
            status: row.status,
          };
        });
        return withCors(req, jsonResponse({ ok: true, count: items.length, items }, { status: 200 }));
      }

      const leadStatusMatch = routePath.match(/^\/v1\/admin\/leads\/(\d+)\/status$/);
      if (req.method === "PATCH" && leadStatusMatch) {
        const leadId = Number(leadStatusMatch[1]);
        const body = await readJsonBody(req);
        const nextStatus = normalizeText(body?.status, 40);
        const note = normalizeText(body?.note, 500);
        if (!Number.isInteger(leadId) || leadId <= 0) {
          return withCors(req, jsonResponse({ ok: false, error: "INVALID_LEAD_ID" }, { status: 400 }));
        }
        if (!allowedLeadStatuses.has(nextStatus)) {
          return withCors(
            req,
            jsonResponse({ ok: false, error: "INVALID_STATUS", allowed: Array.from(allowedLeadStatuses) }, { status: 400 }),
          );
        }

        const { data: updatedRows, error: updateError } = await supabase
          .from("leads")
          .update({ status: nextStatus })
          .eq("id", leadId)
          .select("id,status")
          .limit(1);
        if (updateError) return withCors(req, jsonResponse({ ok: false, error: "INTERNAL_ERROR" }, { status: 500 }));
        const updated = updatedRows?.[0];
        if (!updated) return withCors(req, jsonResponse({ ok: false, error: "LEAD_NOT_FOUND" }, { status: 404 }));

        await supabase.from("lead_events").insert({
          lead_id: leadId,
          event_type: "status_changed",
          note: note || `Status changed to ${nextStatus}`,
        });

        await writeAuditLog({
          userId: adminUserId,
          action: "admin_lead_status_updated",
          details: { leadId, status: nextStatus },
          req,
        });

        return withCors(req, jsonResponse({ ok: true, id: updated.id, status: updated.status }, { status: 200 }));
      }

      if (req.method === "GET" && routePath === "/v1/admin/audit-logs") {
        const limitRaw = url.searchParams.get("limit") ?? "50";
        const limit = Number.isFinite(Number(limitRaw)) ? Math.min(Math.max(Number(limitRaw), 1), 200) : 50;
        const { data, error } = await supabase
          .from("admin_audit_logs")
          .select("id,user_id,action,details,ip_address,user_agent,created_at")
          .order("created_at", { ascending: false })
          .limit(limit);
        if (error) return withCors(req, jsonResponse({ ok: false, error: "INTERNAL_ERROR" }, { status: 500 }));
        return withCors(req, jsonResponse({ ok: true, count: data?.length ?? 0, items: data ?? [] }, { status: 200 }));
      }

      if (req.method === "GET" && routePath === "/v1/admin/auth/2fa/setup") {
        const secret = authenticator.generateSecret();
        const otpauthUrl = authenticator.keyuri(payload.username, "jd-boujdour", secret);
        await writeAuditLog({ userId: adminUserId, action: "admin_2fa_setup_requested", req });
        return withCors(req, jsonResponse({ ok: true, secret, otpauthUrl }, { status: 200 }));
      }

      if (req.method === "POST" && routePath === "/v1/admin/auth/2fa/enable") {
        const body = await readJsonBody(req);
        const secret = normalizeText(body?.secret, 256).replace(/\s+/g, "");
        const code = normalizeText(body?.code, 32).replace(/\s+/g, "");
        if (!secret || !code) return withCors(req, jsonResponse({ ok: false, error: "VALIDATION_ERROR" }, { status: 400 }));
        const ok = authenticator.verify({ token: code, secret });
        if (!ok) {
          await writeAuditLog({ userId: adminUserId, action: "admin_2fa_enable_failed", req });
          return withCors(req, jsonResponse({ ok: false, error: "INVALID_2FA" }, { status: 400 }));
        }
        await supabase
          .from("admin_users")
          .update({ two_factor_enabled: true, two_factor_secret: secret })
          .eq("id", adminUserId);
        await writeAuditLog({ userId: adminUserId, action: "admin_2fa_enabled", req });
        return withCors(req, jsonResponse({ ok: true }, { status: 200 }));
      }

      if (req.method === "POST" && routePath === "/v1/admin/auth/2fa/disable") {
        const body = await readJsonBody(req);
        const code = normalizeText(body?.code, 32).replace(/\s+/g, "");
        if (!code) return withCors(req, jsonResponse({ ok: false, error: "VALIDATION_ERROR" }, { status: 400 }));

        const { data: admin } = await supabase
          .from("admin_users")
          .select("two_factor_enabled,two_factor_secret")
          .eq("id", adminUserId)
          .maybeSingle();
        const secret = admin?.two_factor_secret ?? "";
        if (!admin?.two_factor_enabled || !secret) {
          return withCors(req, jsonResponse({ ok: false, error: "2FA_NOT_ENABLED" }, { status: 400 }));
        }
        const ok = authenticator.verify({ token: code, secret });
        if (!ok) {
          await writeAuditLog({ userId: adminUserId, action: "admin_2fa_disable_failed", req });
          return withCors(req, jsonResponse({ ok: false, error: "INVALID_2FA" }, { status: 400 }));
        }
        await supabase
          .from("admin_users")
          .update({ two_factor_enabled: false, two_factor_secret: null })
          .eq("id", adminUserId);
        await writeAuditLog({ userId: adminUserId, action: "admin_2fa_disabled", req });
        return withCors(req, jsonResponse({ ok: true }, { status: 200 }));
      }

      return withCors(req, jsonResponse({ ok: false, error: "NOT_FOUND" }, { status: 404 }));
    }

    return withCors(req, jsonResponse({ ok: false, error: "NOT_FOUND" }, { status: 404 }));
  } catch (error) {
    console.error("Unhandled error", error);
    return withCors(req, jsonResponse({ ok: false, error: "INTERNAL_ERROR" }, { status: 500 }));
  }
});
