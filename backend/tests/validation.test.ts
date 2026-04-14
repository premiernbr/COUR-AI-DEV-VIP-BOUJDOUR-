import { describe, it, expect } from "vitest";
import { createLeadSchema } from "../src/validation.js";

describe("createLeadSchema", () => {
  it("accepts a valid lead payload", () => {
    const parsed = createLeadSchema.parse({
      fullName: "يوسف العلوي",
      phone: "+212612345678",
      city: "الرباط",
      productType: "صالون فاخر",
      budgetRange: "20k-30k",
      details: "تفاصيل مختصرة",
      source: "website",
      captchaToken: "token"
    });
    expect(parsed.phone).toBe("+212612345678".replace(/\s+/g, ""));
  });

  it("rejects invalid phone", () => {
    expect(() =>
      createLeadSchema.parse({
        fullName: "محمد",
        phone: "123",
        productType: "صالون",
        details: "",
        captchaToken: ""
      })
    ).toThrow();
  });

  it("trims and enforces lengths", () => {
    const longName = "أ".repeat(130);
    expect(() =>
      createLeadSchema.parse({
        fullName: longName,
        phone: "+212612345678",
        productType: "صالون",
        details: "",
        captchaToken: ""
      })
    ).toThrow();
  });
});
