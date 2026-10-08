import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "./auth-middleware";
import {
  CRUD_TABLES,
  DELETABLE_TABLES,
  importRowSchema,
  tableSchemas,
  transactionSchema,
} from "./schemas";

/* eslint-disable @typescript-eslint/no-explicit-any */
const month = z.string().regex(/^\d{4}-\d{2}$/);
const optUuid = z.string().uuid().nullable().optional();
const optDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable()
  .optional();

export const listRows = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => z.object({ table: z.enum(CRUD_TABLES) }).parse(d))
  .handler(async ({ data }) => {
    const { db } = await import("./db.server");
    const byName = data.table === "categories" || data.table === "accounts";
    const res = await db()
      .from(data.table)
      .select("*")
      .order(byName ? "name" : "created_at", { ascending: true });
    if (res.error) throw new Error(res.error.message);
    return (res.data ?? []) as any[];
  });

export const saveRow = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        table: z.enum(CRUD_TABLES),
        id: z.string().uuid().nullable().optional(),
        values: z.unknown(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const values = tableSchemas[data.table].parse(data.values);
    if (data.table === "accounts") {
      const a = values as z.output<typeof import("./schemas").accountSchema>;
      const configured = [
        a.credit_card_cutoff_day,
        a.credit_card_due_day,
        a.credit_card_start_month,
      ].filter(Boolean).length;
      if (configured && (configured !== 3 || a.type !== "credit_card"))
        throw new Error("Lengkapi pengaturan tagihan kartu kredit.");
      if (a.credit_card_start_month && a.credit_card_start_month < "2000-01")
        throw new Error("Periode pertama minimal Januari 2000.");
      if (data.id) {
        const { db } = await import("./db.server");
        const existing = await db()
          .from("credit_card_statements")
          .select("id")
          .eq("account_id", data.id)
          .limit(1);
        const { isMissingTable } = await import("./finance.server");
        if (existing.error && !isMissingTable(existing.error))
          throw new Error(existing.error.message);
        if (existing.data?.length) {
          const old = await db().from("accounts").select("*").eq("id", data.id).single();
          if (old.error) throw new Error(old.error.message);
          if (
            a.type !== "credit_card" ||
            a.currency !== old.data.currency ||
            a.credit_card_start_month !== old.data.credit_card_start_month ||
            a.credit_card_opening_due !== old.data.credit_card_opening_due ||
            !configured
          )
            throw new Error(
              "Kartu sudah memiliki tagihan. Jenis, mata uang, periode pertama dan utang awal tidak dapat diubah.",
            );
        }
      }
    }
    if (!data.id) await (await import("./demo.server")).assertDemoCapacity(data.table);
    if (data.table === "gold_purchases") {
      const { saveGold } = await import("./assets.server");
      const saved = await saveGold(data.id ?? null, values as any);
      const { logActivity } = await import("./finance.server");
      await logActivity(`gold_purchases.${data.id ? "update" : "create"}`, "gold_purchases", {
        name: (values as any).place ?? null,
        amount: (values as any).grams,
        currency: null,
      });
      return saved as any;
    }
    const { db } = await import("./db.server");
    const run = (v: any) =>
      (data.id
        ? db().from(data.table).update(v).eq("id", data.id)
        : db().from(data.table).insert(v)
      )
        .select()
        .single();
    let res = await run(values);
    const cardColumns = [
      "credit_card_cutoff_day",
      "credit_card_due_day",
      "credit_card_start_month",
      "credit_card_opening_due",
    ];
    if (
      data.table === "accounts" &&
      res.error &&
      cardColumns.some((c) => res.error!.message.includes(c))
    ) {
      const v = { ...values } as Record<string, unknown>;
      if (cardColumns.some((c) => v[c] != null))
        throw new Error(
          "Jalankan bagian v16 di supabase/schema.sql untuk mengaktifkan tagihan kartu kredit.",
        );
      for (const c of cardColumns) delete v[c];
      res = await run(v);
    }
    // Optional v4/v8 columns may not exist yet in the user's database: retry without them.
    const optional =
      data.table === "accounts"
        ? ["transfer_fees", "topup_fees", "monthly_fee", "monthly_fee_day"]
        : data.table === "subscriptions"
          ? ["tax_percent"]
          : data.table === "goals"
            ? ["account_id"]
            : data.table === "budgets"
              ? ["rollover"]
              : [];
    if (res.error && optional.some((c) => res.error!.message.includes(c))) {
      const v: any = { ...(values as any) };
      for (const c of optional) delete v[c];
      res = await run(v);
    }
    if (res.error) throw new Error(res.error.message);
    const { logActivity } = await import("./finance.server");
    await logActivity(`${data.table}.${data.id ? "update" : "create"}`, data.table, {
      name: (values as any).name ?? (values as any).place ?? null,
      amount:
        (values as any).amount ?? (values as any).target_amount ?? (values as any).grams ?? null,
      currency: (values as any).currency ?? null,
    });
    return res.data as any;
  });

export const deleteRow = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z.object({ table: z.enum(DELETABLE_TABLES), id: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data }) => {
    if (data.table === "debt_payments") {
      const { deleteDebtPayment, logActivity } = await import("./finance.server");
      const info = await deleteDebtPayment(data.id);
      await logActivity("debt_payment.delete", "debt_payments", info);
      return { ok: true };
    }
    const { db } = await import("./db.server");
    const prev = await db().from(data.table).select("*").eq("id", data.id).maybeSingle();
    const res = await db().from(data.table).delete().eq("id", data.id);
    if (res.error) throw new Error(res.error.message);
    const p = (prev.data ?? {}) as any;
    // Photos go after the row is gone, and only those no split sibling still references.
    if (data.table === "transactions" && prev.data)
      await (await import("./split.server")).removeOrphanPhotos([p], [data.id]);
    if (data.table === "gold_purchases" && p.transaction_id)
      await db().from("transactions").delete().eq("id", p.transaction_id);
    const { logActivity } = await import("./finance.server");
    await logActivity(`${data.table}.delete`, data.table, {
      name: p.name ?? p.description ?? null,
      amount: p.amount ?? p.grams ?? null,
      currency: p.currency ?? null,
    });
    return { ok: true };
  });

export const saveTransaction = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid().nullable().optional(), values: transactionSchema }).parse(d),
  )
  .handler(async ({ data }) => {
    const { insertTransaction, updateTransaction } = await import("./finance.server");
    if (data.id) return (await updateTransaction(data.id, data.values)) as any;
    const tx = await insertTransaction(data.values);
    // v11: instant budget alerts (never throws; [] on any failure).
    const { budgetAlertsFor } = await import("./budget.server");
    return { ...tx, budgetAlerts: await budgetAlertsFor(tx) } as any;
  });

const txFilterSchema = z.object({
  month: month.optional(),
  kind: z.enum(["income", "expense", "transfer"]).optional(),
  search: z.string().max(100).optional(),
  category_id: z.string().uuid().optional(),
  account_id: z.string().uuid().optional(),
  sort: z.enum(["occurred_at", "amount", "description"]).optional(),
  direction: z.enum(["asc", "desc"]).optional(),
});

export const listTransactions = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    txFilterSchema.extend({ offset: z.number().int().min(0).optional() }).parse(d),
  )
  .handler(async ({ data }) => {
    const { listTransactions } = await import("./finance.server");
    return (await listTransactions(data)) as any[];
  });

export const getTxCount = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => txFilterSchema.parse(d))
  .handler(async ({ data }) => {
    const { countTransactions } = await import("./finance.server");
    return countTransactions(data);
  });

export const getDashboard = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => z.object({ month }).parse(d))
  .handler(async ({ data }) => {
    const { computeDashboard } = await import("./finance.server");
    return (await computeDashboard(data.month)) as any;
  });

export const getReminders = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => z.object({ days: z.number().int().min(1).max(365) }).parse(d))
  .handler(async ({ data }) => {
    const { computeReminders } = await import("./finance.server");
    return computeReminders(data.days);
  });

export const getDebts = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async () => {
    const { computeDebts } = await import("./finance.server");
    return (await computeDebts()) as any[];
  });

export const getBudgets = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => z.object({ month }).parse(d))
  .handler(async ({ data }) => {
    const { computeBudgets } = await import("./finance.server");
    return computeBudgets(data.month);
  });

export const getBalances = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async () => {
    const { db } = await import("./db.server");
    const res = await db().from("account_balances").select("*").order("name");
    if (res.error) throw new Error(res.error.message);
    return (res.data ?? []) as any[];
  });

export const getFxRate = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async () => {
    const { getUsdIdr } = await import("./finance.server");
    return { usdIdr: await getUsdIdr() };
  });

export const payDebt = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z.object({ debt_id: z.string().uuid(), account_id: optUuid, date: optDate }).parse(d),
  )
  .handler(async ({ data }) => {
    const { payDebt } = await import("./finance.server");
    return payDebt(data.debt_id, data.account_id ?? null, data.date ?? null);
  });

export const paySubscription = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), account_id: optUuid, date: optDate }).parse(d),
  )
  .handler(async ({ data }) => {
    const { paySubscription } = await import("./finance.server");
    return paySubscription(data.id, data.account_id ?? null, data.date ?? null);
  });

export const addGoalFunds = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        amount: z
          .number()
          .finite()
          .refine((n) => n !== 0, "Nominal harus diisi"),
        account_id: optUuid,
        date: optDate,
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { addGoalFunds } = await import("./finance.server");
    return addGoalFunds(data.id, data.amount, data.account_id ?? null, data.date ?? null);
  });

export const exportTransactionsCsv = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => z.object({ month: month.optional() }).parse(d))
  .handler(async ({ data }) => {
    const { exportCsv } = await import("./finance.server");
    return { csv: await exportCsv(data.month) };
  });

export const scanReceipt = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z.object({ image: z.string().startsWith("data:image/").max(8_000_000) }).parse(d),
  )
  .handler(async ({ data }) => {
    (await import("./demo.server")).assertNotDemo();
    const { parseReceipt } = await import("./ocr.server");
    const { parseContext } = await import("./finance.server");
    return parseReceipt(data.image, await parseContext());
  });

export const getYearly = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => z.object({ year: z.string().regex(/^\d{4}$/) }).parse(d))
  .handler(async ({ data }) => {
    const { computeYearly } = await import("./finance.server");
    return (await computeYearly(data.year)) as any;
  });

export const importTransactionsCsv = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => z.object({ csv: z.string().min(1).max(5_000_000) }).parse(d))
  .handler(async ({ data }) => {
    (await import("./demo.server")).assertNotDemo();
    const { importCsv } = await import("./finance.server");
    return importCsv(data.csv);
  });

export const uploadReceiptImage = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z.object({ image: z.string().startsWith("data:image/").max(8_000_000) }).parse(d),
  )
  .handler(async ({ data }) => {
    (await import("./demo.server")).assertNotDemo();
    const { uploadReceipt } = await import("./receipt.server");
    return uploadReceipt(data.image);
  });

export const getReceiptUrl = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => z.object({ path: z.string().min(1).max(500) }).parse(d))
  .handler(async ({ data }) => {
    const { receiptUrl } = await import("./receipt.server");
    return { url: await receiptUrl(data.path) };
  });

export const getCategoryTrend = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z.object({ months: z.number().int().min(3).max(24), end: month }).parse(d),
  )
  .handler(async ({ data }) => {
    const { categoryTrend } = await import("./finance.server");
    return categoryTrend(data.months, data.end);
  });

export const getYearlySummary = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) => z.object({ year: z.number().int().min(2000).max(2100) }).parse(d))
  .handler(async ({ data }) => {
    const { yearlySummary } = await import("./finance.server");
    return yearlySummary(data.year);
  });

export const importCsvTransactions = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z
      .object({ rows: z.array(importRowSchema).min(1).max(5000), createMissing: z.boolean() })
      .parse(d),
  )
  .handler(async ({ data }) => {
    (await import("./demo.server")).assertNotDemo();
    const { importTransactions } = await import("./finance.server");
    return importTransactions(data.rows, data.createMissing);
  });

export const getNetWorth = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z.object({ months: z.number().int().min(3).max(36), end: month }).parse(d),
  )
  .handler(async ({ data }) => {
    const { netWorthSeries } = await import("./finance.server");
    return netWorthSeries(data.months, data.end);
  });

export const exportBackupJson = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async () => {
    const { exportBackup } = await import("./finance.server");
    return exportBackup();
  });

export const getActivity = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z.object({ limit: z.number().int().min(1).max(100).default(30) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { listActivity } = await import("./finance.server");
    return listActivity(data.limit ?? 30);
  });

/* ---------------- Gold & receivables & cash ---------------- */
const recvSchema = () => import("./schemas").then((m) => m.receivableSchema);

export const getGold = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(25),
        sort: z.enum(["occurred_at", "grams", "price_per_gram", "total"]).default("occurred_at"),
        direction: z.enum(["asc", "desc"]).default("desc"),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { goldSummary } = await import("./assets.server");
    return goldSummary(data) as Promise<any>;
  });

export const getReceivables = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(24),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { listReceivables } = await import("./assets.server");
    return listReceivables(data) as Promise<any>;
  });

export const saveReceivableFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid().nullable().optional(), values: z.unknown() }).parse(d),
  )
  .handler(async ({ data }) => {
    const values = (await recvSchema()).parse(data.values);
    if (!data.id) await (await import("./demo.server")).assertDemoCapacity("receivables");
    const { saveReceivable } = await import("./assets.server");
    return (await saveReceivable(data.id ?? null, values)) as any;
  });

export const payReceivableFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        amount: z.number().positive(),
        account_id: optUuid,
        date: optDate,
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { payReceivable } = await import("./assets.server");
    return payReceivable(data.id, data.amount, data.account_id ?? null, data.date ?? null);
  });

export const receivableActionFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        action: z.enum(["settle", "reopen", "delete", "delete_payment"]),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const a = await import("./assets.server");
    if (data.action === "settle") await a.setReceivableStatus(data.id, "paid");
    else if (data.action === "reopen") await a.setReceivableStatus(data.id, "active");
    else if (data.action === "delete") await a.deleteReceivable(data.id);
    else await a.deleteReceivablePayment(data.id);
    return { ok: true };
  });

export const getAssets = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async () => {
    const { assetsOverview } = await import("./assets.server");
    return (await assetsOverview()) as any;
  });
