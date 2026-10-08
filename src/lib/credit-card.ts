import { addDays, shiftMonth } from "./dates";

export function cardDate(month: string, day: number): string {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return `${month}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

export function cardPeriod(month: string, cutoff: number, due: number) {
  const end = cardDate(month, cutoff);
  const start = addDays(cardDate(shiftMonth(month, -1), cutoff), 1);
  const candidate = cardDate(month, due);
  return { start, end, due: candidate > end ? candidate : cardDate(shiftMonth(month, 1), due) };
}

export type CardTransaction = {
  id: string;
  kind: string;
  amount: number;
  account_id: string | null;
  occurred_at: string;
  description: string | null;
};

export function cardTotal(
  rows: readonly CardTransaction[],
  account: string,
  start: string,
  end: string,
) {
  return (
    Math.round(
      rows.reduce((sum, t) => {
        if (t.account_id !== account || t.occurred_at < start || t.occurred_at > end) return sum;
        return sum + (t.kind === "income" ? -Number(t.amount) : Number(t.amount));
      }, 0) * 100,
    ) / 100
  );
}

export function cardStatus(total: number, paid: number, due: string, today: string) {
  if (paid >= total) return "Lunas";
  if (due < today) return "Terlambat";
  return paid > 0 ? "Sebagian" : "Belum dibayar";
}
