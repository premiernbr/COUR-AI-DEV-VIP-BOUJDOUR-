import { z } from "zod";

const moroccanPhoneRegex = /^(?:\+212|212|0)(?:5|6|7)[0-9]{8}$/;

export const createLeadSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  phone: z
    .string()
    .trim()
    .transform((v) => v.replace(/\s+/g, ""))
    .refine((v) => moroccanPhoneRegex.test(v), "رقم الهاتف غير صحيح"),
  city: z.string().trim().max(120).optional().or(z.literal("")),
  productType: z.string().trim().min(2).max(150),
  budgetRange: z.string().trim().max(100).optional().or(z.literal("")),
  details: z.string().trim().max(1200).optional().or(z.literal("")),
  source: z.string().trim().max(40).optional(),
  captchaToken: z.string().trim().max(2048).optional().or(z.literal(""))
});

export type CreateLeadInput = z.infer<typeof createLeadSchema>;
