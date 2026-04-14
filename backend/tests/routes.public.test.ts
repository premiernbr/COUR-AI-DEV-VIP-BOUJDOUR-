import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";

process.env.NODE_ENV = "test";

// import after setting NODE_ENV to avoid auto-start
import { app } from "../src/index.js";

describe("public routes", () => {
  it("GET /health returns ok", async () => {
    const res = await request(app.server).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, service: "api" });
  });

  it("GET /api/v1/public-config returns captcha config shape", async () => {
    const res = await request(app.server).get("/api/v1/public-config");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("ok", true);
    expect(res.body).toHaveProperty("captcha");
    expect(res.body.captcha).toHaveProperty("enabled");
    expect(res.body.captcha).toHaveProperty("provider", "turnstile");
  });
});
