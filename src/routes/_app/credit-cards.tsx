import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/app-shell";
import { RouteError } from "@/components/route-error";
import { PageSkeleton } from "@/components/skeletons";
import { EntityDialog } from "@/components/entity-dialog";
import { Pagination } from "@/components/pagination";
import { useConfirm } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  cardStatementsQuery,
  cardDetailQuery,
  rowsQuery,
  invalidateFor,
  errMsg,
} from "@/lib/queries";
import {
  payCardStatement,
  correctCardStatement,
  cancelCardPayment,
} from "@/lib/credit-card.functions";
import { todayStr, dateLabel } from "@/lib/dates";
import { money } from "@/lib/format";
import { usePrivacy } from "@/lib/privacy";
import { useI18n } from "@/lib/i18n";
import { pageHead } from "@/lib/head";

export const Route = createFileRoute("/_app/credit-cards")({
  head: () => pageHead("Tagihan Kartu Kredit", "Tagihan, jatuh tempo dan pembayaran kartu kredit."),
  component: CreditCardsPage,
  errorComponent: RouteError,
});

function CreditCardsPage() {
  usePrivacy();
  const { t, lang } = useI18n();
  const [offset, setOffset] = useState(0);
  const [account, setAccount] = useState("");
  const query = useQuery(cardStatementsQuery(offset, account || undefined));
  const accounts = useQuery(rowsQuery("accounts")).data ?? [];
  const qc = useQueryClient();
  const pay = useServerFn(payCardStatement);
  const correct = useServerFn(correctCardStatement);
  const cancel = useServerFn(cancelCardPayment);
  const ask = useConfirm();
  type Statement = NonNullable<typeof query.data>["rows"][number];
  const [form, setForm] = useState<{
    kind: "pay" | "correct";
    row: Statement;
    key: string;
    initial: Record<string, unknown>;
  } | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const detail = useQuery({ ...cardDetailQuery(detailId ?? ""), enabled: !!detailId });
  const paymentDetail = useQuery({
    ...cardDetailQuery(form?.row.id ?? ""),
    enabled: form?.kind === "pay",
  });
  const changed = () => invalidateFor(qc, "credit_card_payments");
  const name = (id: string) => query.data?.cards.find((a) => a.id === id)?.name ?? "";
  const date = (v: string) => dateLabel(v, lang === "en" ? "en-US" : "id-ID");
  if (query.isPending) return <PageSkeleton />;
  if (query.error) throw query.error;
  const data = query.data;
  return (
    <>
      <PageHeader
        title={t("Tagihan Kartu Kredit")}
        subtitle={t("Pembayaran dicatat sebagai transfer, bukan pengeluaran baru.")}
      />
      {!data.ready ? (
        <Card className="p-5">
          <p>
            {t(
              "Jalankan bagian v16 di supabase/schema.sql untuk mengaktifkan tagihan kartu kredit.",
            )}
          </p>
        </Card>
      ) : (
        <>
          <p className="mb-4 text-sm text-muted-foreground">
            {t("Atur cut-off, jatuh tempo dan periode pertama pada akun kartu kredit.")}{" "}
            <Link to="/accounts" className="text-primary underline">
              {t("Akun")}
            </Link>
          </p>
          <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.cards.map((a) => {
              const running = data.running.find((r) => r.account_id === a.id);
              return (
                <Card key={a.id} className="space-y-2 p-5">
                  <h2 className="font-display font-semibold">{a.name}</h2>
                  {running ? (
                    <>
                      <p className="text-sm text-muted-foreground">
                        {t("Estimasi berjalan")} · {date(running.start)} – {date(running.end)}
                      </p>
                      <p className="num text-2xl font-semibold">
                        {money(running.amount, a.currency)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t("Jatuh tempo")} {date(running.due)}
                      </p>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {t("Pengaturan tagihan belum lengkap")}
                    </p>
                  )}
                </Card>
              );
            })}
          </div>
          <label className="mb-4 block text-sm">
            {t("Kartu kredit")}
            <select
              className="ml-3 rounded-md border bg-background p-2"
              value={account}
              onChange={(e) => {
                setAccount(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">{t("Semua")}</option>
              {data.cards.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          {!data.rows.length ? (
            <p className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
              {t("Belum ada tagihan tercetak")}
            </p>
          ) : (
            <div className="space-y-3">
              {data.rows.map((s) => (
                <Card key={s.id} className="p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="font-display font-semibold">{name(s.account_id)}</h2>
                      <p className="text-sm text-muted-foreground">
                        {date(s.period_start)} – {date(s.period_end)}
                      </p>
                    </div>
                    <Badge variant={s.status === "Terlambat" ? "destructive" : "secondary"}>
                      {t(s.status)}
                    </Badge>
                  </div>
                  {s.paid > Number(s.final_amount) && (
                    <p className="mb-3 text-sm text-muted-foreground">
                      {t("Kelebihan pembayaran")}:{" "}
                      <span className="num">
                        {money(s.paid - Number(s.final_amount), s.currency)}
                      </span>
                    </p>
                  )}
                  <div className="my-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {[
                      ["Total tagihan:", s.final_amount],
                      ["Sudah dibayar", s.paid],
                      ["Sisa", s.remaining],
                    ].map(([label, value]) => (
                      <div key={String(label)}>
                        <p className="text-xs text-muted-foreground">{t(String(label))}</p>
                        <p className="num font-semibold">{money(Number(value), s.currency)}</p>
                      </div>
                    ))}
                    <div>
                      <p className="text-xs text-muted-foreground">{t("Jatuh tempo")}</p>
                      <p>{date(s.due_date)}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={s.remaining <= 0}
                      onClick={() =>
                        setForm({
                          kind: "pay",
                          row: s,
                          key: crypto.randomUUID(),
                          initial: {
                            source: null,
                            amount: s.remaining,
                            date: todayStr(),
                            fee: 0,
                            transfer: null,
                          },
                        })
                      }
                    >
                      {t("Bayar")}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() =>
                        setForm({
                          kind: "correct",
                          row: s,
                          key: "",
                          initial: { amount: s.final_amount, note: s.correction_note ?? "" },
                        })
                      }
                    >
                      {t("Koreksi tagihan")}
                    </Button>
                    <Button variant="ghost" onClick={() => setDetailId(s.id)}>
                      {t("Detail")}
                    </Button>
                  </div>
                  {s.payments.length > 0 && (
                    <div className="mt-4 space-y-2 border-t pt-3">
                      <p className="text-xs text-muted-foreground">{t("Riwayat pembayaran")}</p>
                      {s.payments.map((p) => (
                        <div
                          key={p.id}
                          className="flex flex-wrap items-center justify-between gap-2 text-sm"
                        >
                          <span className="num">
                            {date(p.created_at.slice(0, 10))} ·{" "}
                            {money(p.allocated_amount, s.currency)}
                          </span>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              if (
                                !(await ask.confirm(
                                  t(
                                    p.owned
                                      ? "Batalkan pembayaran dan hapus transfer terkait?"
                                      : "Lepas tautan pembayaran? Transfer tetap tersimpan.",
                                  ),
                                  { destructive: true },
                                ))
                              )
                                return;
                              try {
                                await cancel({ data: p.id });
                                await changed();
                              } catch (e) {
                                toast.error(errMsg(e));
                              }
                            }}
                          >
                            {t(p.owned ? "Batalkan" : "Lepas tautan")}
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}
          <Pagination
            offset={offset}
            pageSize={20}
            total={data.total}
            visible={data.rows.length}
            onChange={setOffset}
          />
        </>
      )}
      {form && (
        <EntityDialog
          open
          onOpenChange={(o) => {
            if (!o) setForm(null);
          }}
          title={t(form.kind === "pay" ? "Bayar tagihan kartu kredit" : "Koreksi tagihan")}
          description={t(
            form.kind === "pay"
              ? "Pencatatan transfer saja; uang tidak dikirim melalui bank."
              : "Koreksi tagihan tidak mengubah saldo akun. Catat biaya atau refund secara terpisah.",
          )}
          initial={form.initial}
          fields={(v) =>
            form.kind === "correct"
              ? [
                  { name: "amount", label: t("Nominal final"), type: "number", step: "0.01" },
                  { name: "note", label: t("Catatan koreksi"), type: "textarea" },
                ]
              : [
                  {
                    name: "transfer",
                    label: t("Tautkan transfer yang sudah ada (opsional)"),
                    type: "select",
                    options: [
                      { value: "__none", label: t("Pembayaran baru") },
                      ...(paymentDetail.data?.transfers ?? []).map((tx) => ({
                        value: tx.id,
                        label: `${date(tx.occurred_at)} · ${money(tx.available, tx.currency, { reveal: true })}`,
                      })),
                    ],
                  },
                  ...(!v["transfer"]
                    ? [
                        {
                          name: "source",
                          label: t("Sumber dana"),
                          type: "select" as const,
                          options: accounts
                            .filter(
                              (a) =>
                                a.type !== "credit_card" &&
                                !a.archived &&
                                a.currency === form.row.currency,
                            )
                            .map((a) => ({ value: a.id, label: a.name })),
                        },
                        { name: "date", label: t("Tanggal"), type: "date" as const },
                        {
                          name: "fee",
                          label: t("Biaya admin"),
                          type: "number" as const,
                          step: "0.01",
                        },
                      ]
                    : []),
                  { name: "amount", label: t("Jumlah"), type: "number", step: "0.01" },
                ]
          }
          onSubmit={async (v) => {
            if (form.kind === "pay")
              await pay({
                data: {
                  id: form.row.id,
                  source: v["source"] ? String(v["source"]) : null,
                  amount: Number(v["amount"]),
                  date: String(v["date"]),
                  fee: Number(v["fee"] || 0),
                  key: form.key,
                  transfer: v["transfer"] ? String(v["transfer"]) : null,
                },
              });
            else
              await correct({
                data: {
                  id: form.row.id,
                  amount: Number(v["amount"]),
                  note: String(v["note"] || ""),
                  refresh: false,
                },
              });
            await changed();
          }}
        />
      )}
      <Dialog
        open={!!detailId}
        onOpenChange={(o) => {
          if (!o) setDetailId(null);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("Detail tagihan")}</DialogTitle>
            <DialogDescription>
              {t("Periksa transaksi dan selisih terhadap snapshot tagihan.")}
            </DialogDescription>
          </DialogHeader>
          {detail.isPending ? (
            <p>{t("Memuat...")}</p>
          ) : detail.error ? (
            <p role="alert">{errMsg(detail.error)}</p>
          ) : (
            detail.data && (
              <>
                <p>
                  {t("Nominal otomatis")}:{" "}
                  <span className="num">
                    {money(detail.data.calculated, detail.data.statement.currency)}
                  </span>
                </p>
                {Number(detail.data.statement.calculated_amount) !== detail.data.calculated && (
                  <>
                    <p className="text-sm text-expense">{t("Ada perubahan transaksi")}</p>
                    <Button
                      onClick={async () => {
                        if (
                          !(await ask.confirm(t("Perbarui perhitungan dan ganti nominal final?")))
                        )
                          return;
                        try {
                          await correct({
                            data: { id: detailId!, amount: 0, note: "", refresh: true },
                          });
                          await changed();
                        } catch (e) {
                          toast.error(errMsg(e));
                        }
                      }}
                    >
                      {t("Perbarui perhitungan")}
                    </Button>
                  </>
                )}
                <ul className="divide-y">
                  {detail.data.transactions.map((tx) => (
                    <li key={tx.id} className="flex justify-between gap-3 py-2 text-sm">
                      <span>
                        {date(tx.occurred_at)} · {tx.description}
                      </span>
                      <span className="num shrink-0">
                        {money(tx.amount, detail.data!.statement.currency)}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-sm font-semibold">{t("Transfer masuk terbaru")}</p>
                {detail.data.transfers.map((tx) => (
                  <div key={tx.id} className="space-y-1 border-t py-2 text-sm">
                    <p>
                      {date(tx.occurred_at)} ·{" "}
                      <span className="num">{money(tx.available, tx.currency)}</span>
                    </p>
                  </div>
                ))}
              </>
            )
          )}
        </DialogContent>
      </Dialog>
      {ask.element}
    </>
  );
}
