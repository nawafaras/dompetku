import { describe, it, expect } from "vitest";
import { cardPeriod, cardTotal, cardStatus } from "../lib/credit-card";
import { applyRemap, RESTORE_TABLES } from "../lib/backup";

describe("credit card statements", () => {
  it("restores payments after their parents and remaps snapshot references", () => {
    expect(RESTORE_TABLES.indexOf("credit_card_payments")).toBeGreaterThan(
      RESTORE_TABLES.indexOf("credit_card_statements"),
    );
    expect(
      applyRemap(
        "credit_card_statements",
        [{ account_id: "old-card", snapshot: [{ id: "old-tx", account_id: "old-card" }] }],
        { accounts: { "old-card": "card" }, transactions: { "old-tx": "tx" } },
      ),
    ).toEqual([{ account_id: "card", snapshot: [{ id: "tx", account_id: "card" }] }]);
  });
  it("clamps month ends, crosses years and keeps due dates after closing", () => {
    expect(cardPeriod("2027-01", 20, 5)).toEqual({
      start: "2026-12-21",
      end: "2027-01-20",
      due: "2027-02-05",
    });
    expect(cardPeriod("2028-02", 31, 31)).toEqual({
      start: "2028-02-01",
      end: "2028-02-29",
      due: "2028-03-31",
    });
    expect(cardPeriod("2027-02", 31, 5).end).toBe("2027-02-28");
  });
  it("includes closing day, refunds and cash advances but excludes incoming payments", () => {
    const rows = [
      {
        id: "1",
        kind: "expense",
        amount: 1000,
        account_id: "card",
        occurred_at: "2026-01-20",
        description: null,
      },
      {
        id: "2",
        kind: "income",
        amount: 100,
        account_id: "card",
        occurred_at: "2026-01-19",
        description: null,
      },
      {
        id: "3",
        kind: "transfer",
        amount: 600,
        account_id: "bank",
        occurred_at: "2026-01-19",
        description: null,
      },
      {
        id: "4",
        kind: "expense",
        amount: 900,
        account_id: "card",
        occurred_at: "2026-01-21",
        description: null,
      },
      {
        id: "5",
        kind: "transfer",
        amount: 50,
        account_id: "card",
        occurred_at: "2026-01-19",
        description: null,
      },
    ];
    expect(cardTotal(rows, "card", "2025-12-21", "2026-01-20")).toBe(950);
    expect(cardStatus(950, 600, "2026-02-05", "2026-02-04")).toBe("Sebagian");
    expect(cardStatus(950, 600, "2026-02-05", "2026-02-06")).toBe("Terlambat");
    expect(cardStatus(950, 1000, "2026-02-05", "2026-02-06")).toBe("Lunas");
  });
});
