import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test_jwt_secret_123";
process.env.ACCESS_TOKEN_TTL_SECONDS = "900";
process.env.REFRESH_TOKEN_DAYS = "7";
process.env.ADMIN_LOCKOUT_MAX_ATTEMPTS = "5";
process.env.ADMIN_LOCKOUT_MINUTES = "15";
process.env.LEADS_RATE_LIMIT_WINDOW_MS = "60000";
process.env.LEADS_RATE_LIMIT_MAX = "5";
process.env.TURNSTILE_ENABLED = "false";

let queryMock: any;

vi.mock("../src/db.js", () => {
  queryMock = vi.fn();
  return {
    pool: {
      query: (...args: unknown[]) => queryMock(...args),
      end: vi.fn()
    },
    withTransaction: async (fn: any) =>
      fn({
        query: (...args: unknown[]) => queryMock(...args)
      })
  };
});

import { app } from "../src/index.js";

const hashedPassword = bcrypt.hashSync("AdminPass123!", 10);

describe("admin auth routes", () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes("FROM admin_users WHERE username")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: 1,
              username: "admin",
              password_hash: hashedPassword,
              role: "admin",
              is_active: true,
              failed_attempts: 0,
              locked_until: null,
              two_factor_enabled: false,
              two_factor_secret: null
            }
          ]
        };
      }
      if (sql.toLowerCase().startsWith("insert into admin_audit_logs")) {
        return { rowCount: 1, rows: [] };
      }
      // updates / sessions insert
      return { rowCount: 1, rows: [{ id: 1 }] };
    });
  });

  it("rejects missing credentials", async () => {
    const res = await request(app.server).post("/api/v1/admin/auth/login").send({});
    expect(res.status).toBe(400);
  });

  it("logs in with valid credentials", async () => {
    const res = await request(app.server)
      .post("/api/v1/admin/auth/login")
      .send({ username: "admin", password: "AdminPass123!" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("accessToken");
    expect(res.body).toHaveProperty("refreshToken");
    expect(res.body).toHaveProperty("user.username", "admin");
  });
});
