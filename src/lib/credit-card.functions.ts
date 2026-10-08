import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "./auth-middleware";

const id = z.string().uuid();
export const getCardStatements = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z
      .object({ offset: z.number().int().min(0).max(100000).default(0), account: id.optional() })
      .parse(d),
  )
  .handler(async ({ data }) =>
    (await import("./credit-card.server")).cardStatements(data.offset, data.account),
  );
export const getCardDetail = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => id.parse(d))
  .handler(async ({ data }) => (await import("./credit-card.server")).cardDetail(data));
export const correctCardStatement = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id,
        amount: z.number().finite().min(-1e12).max(1e12),
        note: z.string().trim().max(1000),
        refresh: z.boolean().default(false),
      })
      .parse(d),
  )
  .handler(async ({ data }) =>
    (await import("./credit-card.server")).correctCard(
      data.id,
      data.amount,
      data.note,
      data.refresh,
    ),
  );
export const payCardStatement = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id,
        source: id.nullable(),
        amount: z
          .number()
          .finite()
          .positive()
          .max(1e12)
          .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.0001),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .refine(
            (v) => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v,
          ),
        fee: z.number().finite().min(0).max(1e12),
        key: id,
        transfer: id.nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => (await import("./credit-card.server")).payCard(data));
export const cancelCardPayment = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => id.parse(d))
  .handler(async ({ data }) => (await import("./credit-card.server")).cancelCard(data));
