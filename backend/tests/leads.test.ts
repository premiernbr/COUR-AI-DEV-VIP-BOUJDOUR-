import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test_jwt_secret_123";
process.env.ACCESS_TOKEN_TTL_SECONDS = "900";
process.env.REFRESH_TOKEN_DAYS = "7";
process.env.ADMIN_LOCKOUT_MAX_ATTEMPTS = "5";
process.env.ADMIN_LOCKOUT_MINUTES = "15";
process.env.LEADS_RATE_LIMIT_WINDOW_MS = "60000";
process.env.LEADS_RATE_LIMIT_MAX = "5";
process.env.TURNSTILE_ENABLED = "false";

const queryMock = vi.fn();

vi.mock("../src/db.js", () => ({
  pool: {
    query: (...args: unknown[]) => queryMock(...args),
    end: vi.fn()
  },
  withTransaction: async (fn: any) =>
    fn({
      query: (...args: unknown[]) => queryMock(...args)
    })
}));

import { app } from "../src/index.js";

describe("leads route", () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockImplementation((sql: string) => {
      if (sql.includes("INSERT INTO customers")) {
        return { rowCount: 1, rows: [{ id: 10 }] };
      }
      if (sql.includes("INSERT INTO leads")) {
        return { rowCount: 1, rows: [{ id: 20 }] };
      }
      if (sql.includes("INSERT INTO lead_events")) {
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    });
  });

  it("creates a lead with valid payload", async () => {
    const res = await request(app.server).post("/api/v1/leads").send({
      fullName: "عميل تجريبي",
      phone: "+212612345678",
      city: "الرباط",
      productType: "صالون",
      budgetRange: "10k-15k",
      details: "تفاصيل مختصرة"
    });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("leadId", 20);
  });

  it("rejects invalid phone", async () => {
    const res = await request(app.server).post("/api/v1/leads").send({
      fullName: "عميل",
      phone: "123",
      productType: "صالون",
      details: ""
    });
    expect(res.status).toBe(400);
  });
});
