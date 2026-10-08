import { db } from "./db.server";
import { today, isMissingTable, logActivity, getUsdIdr } from "./finance.server";
import { cardPeriod, cardTotal, cardStatus, type CardTransaction } from "./credit-card";
import { shiftMonth, addDays } from "./dates";
import { fetchAll } from "./paginate";
import type { Json } from "./database.types";

function must<T>(r: { data: T; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data;
}

export async function prepareCardStatements() {
  const probe = await db().from("credit_card_statements").select("id").limit(1);
  if (isMissingTable(probe.error)) return false;
  must(probe);
  const cards = must(await db().from("accounts").select("*").eq("type", "credit_card"));
  for (const a of cards ?? []) {
    if (!a.credit_card_cutoff_day || !a.credit_card_due_day || !a.credit_card_start_month) continue;
    const current = today();
    const existing = must(
      await db()
        .from("credit_card_statements")
        .select("period_end")
        .eq("account_id", a.id)
        .order("period_end", { ascending: false })
        .limit(1),
    );
    let month = existing?.[0]
      ? shiftMonth(existing[0].period_end.slice(0, 7), 1)
      : a.credit_card_start_month;
    let previousEnd = existing?.[0]?.period_end;
    // ponytail: create at most 120 overdue periods per request; later reads finish the backlog.
    for (let i = 0; i < 120; i++, month = shiftMonth(month, 1)) {
      const p = cardPeriod(month, a.credit_card_cutoff_day, a.credit_card_due_day);
      if (previousEnd) p.start = addDays(previousEnd, 1);
      if (p.end >= current) break;
      const tx = await periodTransactions(a.id, p.start, p.end);
      const calculated = cardTotal(tx, a.id, p.start, p.end);
      const opening =
        month === a.credit_card_start_month ? Number(a.credit_card_opening_due ?? 0) : 0;
      await (await import("./demo.server")).assertDemoCapacity("credit_card_statements");
      const res = await db()
        .from("credit_card_statements")
        .upsert(
          {
            account_id: a.id,
            period_start: p.start,
            period_end: p.end,
            due_date: p.due,
            currency: a.currency,
            calculated_amount: calculated,
            opening_amount: opening,
            final_amount: calculated + opening,
            correction_note: null,
            snapshot: tx as unknown as Json,
          },
          { onConflict: "account_id,period_end", ignoreDuplicates: true },
        );
      must(res);
      previousEnd = p.end;
    }
  }
  return true;
}

async function periodTransactions(account: string, start: string, end: string) {
  return (
    must(
      await fetchAll<CardTransaction>((from, to) =>
        db()
          .from("transactions")
          .select("id,kind,amount,account_id,occurred_at,description")
          .eq("account_id", account)
          .gte("occurred_at", start)
          .lte("occurred_at", end)
          .order("id")
          .range(from, to),
      ),
    ) ?? []
  );
}

export async function cardStatements(offset = 0, account?: string) {
  const ready = await prepareCardStatements();
  const cards = must(await db().from("accounts").select("*").eq("type", "credit_card")) ?? [];
  if (!ready) return { ready, cards, running: [], rows: [], total: 0 };
  const running = [];
  for (const a of cards) {
    if (!a.credit_card_cutoff_day || !a.credit_card_due_day || !a.credit_card_start_month) continue;
    let month = today().slice(0, 7);
    if (cardPeriod(month, a.credit_card_cutoff_day, a.credit_card_due_day).end < today())
      month = shiftMonth(month, 1);
    if (month < a.credit_card_start_month) month = a.credit_card_start_month;
    const p = cardPeriod(month, a.credit_card_cutoff_day, a.credit_card_due_day);
    const latest = must(
      await db()
        .from("credit_card_statements")
        .select("period_end")
        .eq("account_id", a.id)
        .order("period_end", { ascending: false })
        .limit(1),
    );
    if (latest?.[0]) p.start = addDays(latest[0].period_end, 1);
    running.push({
      account_id: a.id,
      ...p,
      amount:
        cardTotal(await periodTransactions(a.id, p.start, p.end), a.id, p.start, p.end) +
        (month === a.credit_card_start_month ? Number(a.credit_card_opening_due ?? 0) : 0),
    });
  }
  let query = db()
    .from("credit_card_statements")
    .select("*", { count: "exact" })
    .order("period_end", { ascending: false })
    .order("id");
  if (account) query = query.eq("account_id", account);
  const res = await query.range(offset, offset + 19);
  const rows = must(res) ?? [];
  const payments = rows.length
    ? (must(
        await fetchAll<import("./database.types").Tables<"credit_card_payments">>((from, to) =>
          db()
            .from("credit_card_payments")
            .select("*")
            .in(
              "statement_id",
              rows.map((s) => s.id),
            )
            .order("id")
            .range(from, to),
        ),
      ) ?? [])
    : [];
  return {
    ready,
    cards,
    running,
    total: res.count ?? 0,
    rows: rows.map((s) => {
      const linked = payments.filter((p) => p.statement_id === s.id);
      const paid = linked.reduce((v, p) => v + Number(p.allocated_amount), 0);
      return {
        ...s,
        paid,
        remaining: Math.max(0, Number(s.final_amount) - paid),
        status: cardStatus(Number(s.final_amount), paid, s.due_date, today()),
        payments: linked,
      };
    }),
  };
}

export async function cardDetail(id: string) {
  const s = must(await db().from("credit_card_statements").select("*").eq("id", id).single());
  if (!s) throw new Error("Tagihan tidak ditemukan");
  const transactions = await periodTransactions(s.account_id, s.period_start, s.period_end);
  const transfers =
    must(
      await db()
        .from("transactions")
        .select("id,amount,currency,occurred_at,description,account_id")
        .eq("kind", "transfer")
        .eq("to_account_id", s.account_id)
        .order("occurred_at", { ascending: false })
        .order("id")
        .limit(100),
    ) ?? [];
  const allocations = transfers.length
    ? (must(
        await fetchAll<{ transaction_id: string; allocated_amount: number; owned: boolean }>(
          (from, to) =>
            db()
              .from("credit_card_payments")
              .select("transaction_id,allocated_amount,owned")
              .in(
                "transaction_id",
                transfers.map((tx) => tx.id),
              )
              .order("id")
              .range(from, to),
        ),
      ) ?? [])
    : [];
  return {
    statement: s,
    transactions,
    calculated: cardTotal(transactions, s.account_id, s.period_start, s.period_end),
    transfers: transfers
      .filter((tx) => !allocations.some((p) => p.transaction_id === tx.id && p.owned))
      .map((tx) => ({
        ...tx,
        available:
          Number(tx.amount) -
          allocations
            .filter((p) => p.transaction_id === tx.id)
            .reduce((sum, p) => sum + Number(p.allocated_amount), 0),
      }))
      .filter((tx) => tx.available > 0),
  };
}

export async function correctCard(id: string, amount: number, note: string, refresh: boolean) {
  const detail = await cardDetail(id);
  const final = refresh ? detail.calculated + Number(detail.statement.opening_amount) : amount;
  must(
    await db().rpc("dk_card_correct", {
      p_statement: id,
      p_amount: final,
      p_note: note,
      p_calculated: refresh ? detail.calculated : null,
      p_snapshot: refresh ? (detail.transactions as unknown as Json) : null,
    }),
  );
  await logActivity("credit_card_statements.update", "credit_card_statements", {
    amount: final,
    previous_amount: detail.statement.final_amount,
    name: note || detail.statement.period_end,
    currency: detail.statement.currency,
  });
}

export async function payCard(input: {
  id: string;
  source: string | null;
  amount: number;
  date: string;
  fee: number;
  key: string;
  transfer: string | null;
}) {
  const { assertDemoCapacity } = await import("./demo.server");
  await assertDemoCapacity("credit_card_payments");
  if (!input.transfer) await assertDemoCapacity("transactions");
  const result = must(
    await db().rpc("dk_card_payment", {
      p_statement: input.id,
      p_source: input.source,
      p_amount: input.amount,
      p_date: input.date,
      p_fee: input.fee,
      p_rate: await getUsdIdr(),
      p_key: input.key,
      p_transfer: input.transfer,
    }),
  );
  await logActivity("credit_card.pay", "credit_card_statements", { amount: input.amount });
  return result;
}

export async function cancelCard(id: string) {
  must(await db().rpc("dk_card_cancel", { p_payment: id }));
  await logActivity("credit_card.cancel", "credit_card_payments");
}

export async function cardReminders(limit: string, current: string, rate: number) {
  if (!(await prepareCardStatements())) return [];
  const statements =
    must(await db().from("credit_card_statements").select("*").lte("due_date", limit)) ?? [];
  const payments =
    must(
      await fetchAll<{ statement_id: string; allocated_amount: number }>((from, to) =>
        db()
          .from("credit_card_payments")
          .select("statement_id,allocated_amount")
          .order("id")
          .range(from, to),
      ),
    ) ?? [];
  const cards = must(await db().from("accounts").select("id,name")) ?? [];
  const { diffDays } = await import("./dates");
  return statements.flatMap((s) => {
    const amount = Math.max(
      0,
      Number(s.final_amount) -
        payments
          .filter((p) => p.statement_id === s.id)
          .reduce((v, p) => v + Number(p.allocated_amount), 0),
    );
    return amount > 0
      ? [
          {
            type: "credit_card" as const,
            id: s.id,
            title: `Tagihan kartu kredit ${cards.find((a) => a.id === s.account_id)?.name ?? ""}`,
            amount,
            currency: s.currency,
            amount_idr: amount * (s.currency === "USD" ? rate : 1),
            due_date: s.due_date,
            days_left: diffDays(current, s.due_date),
            overdue: s.due_date < current,
          },
        ]
      : [];
  });
}
