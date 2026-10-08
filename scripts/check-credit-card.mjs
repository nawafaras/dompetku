// Run with PGLITE_MODULE pointing to an installed @electric-sql/pglite module.
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const { PGlite } = await import(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const db = new PGlite();
await db.exec(`
create role anon; create role authenticated; create role service_role;
create table accounts(id uuid primary key default gen_random_uuid(),name text,type text,currency text,archived boolean default false);
create table categories(id uuid primary key default gen_random_uuid(),name text,kind text,unique(name,kind));
create table transactions(id uuid primary key default gen_random_uuid(),kind text,amount numeric,currency text,amount_idr numeric,account_id uuid,to_account_id uuid,category_id uuid,description text,occurred_at date,source text,external_id text unique);
`);
const schema = await readFile(new URL("../supabase/schema.sql", import.meta.url), "utf8");
await db.exec(schema.slice(schema.indexOf("-- ===== v16: tagihan kartu kredit (")));
const card = "00000000-0000-4000-8000-000000000001";
const bank = "00000000-0000-4000-8000-000000000002";
const statement = "00000000-0000-4000-8000-000000000003";
const key = "00000000-0000-4000-8000-000000000004";
await db.query(
  "insert into accounts(id,name,type,currency) values($1,'Card','credit_card','IDR'),($2,'Bank','bank','IDR')",
  [card, bank],
);
await db.query(
  "insert into credit_card_statements(id,account_id,period_start,period_end,due_date,currency,calculated_amount,final_amount) values($1,$2,'2026-01-01','2026-01-20','2026-02-05','IDR',1000000,1000000)",
  [statement, card],
);
const pay = () =>
  db.query("select dk_card_payment($1,$2,600000,'2026-02-01',2500,1,$3,null) id", [
    statement,
    bank,
    key,
  ]);
const first = await pay();
assert.equal((await pay()).rows[0].id, first.rows[0].id);
let tx = (await db.query("select * from transactions")).rows;
assert.equal(tx.length, 2);
assert.equal(Number(tx.find((t) => t.kind === "transfer").amount), 600000);
assert.equal(Number(tx.find((t) => t.kind === "expense").amount), 2500);
assert.equal(
  Number(
    (await db.query("select sum(allocated_amount) paid from credit_card_payments")).rows[0].paid,
  ),
  600000,
);
await assert.rejects(
  db.query("select dk_card_payment($1,$2,500000,'2026-02-01',0,1,gen_random_uuid(),null)", [
    statement,
    bank,
  ]),
  /melebihi/,
);
await assert.rejects(db.query("delete from transactions where kind='transfer'"), /terkait tagihan/);
await assert.rejects(
  db.query("select dk_card_payment($1,$2,100000,'2026-02-01',0,1,gen_random_uuid(),null)", [
    statement,
    card,
  ]),
  /Sumber dana/,
);
assert.equal((await db.query("select * from transactions")).rows.length, 2);
await db.query("select dk_card_correct($1,500000,'bank correction',null,null)", [statement]);
await db.query("select dk_card_cancel($1)", [first.rows[0].id]);
assert.equal((await db.query("select * from transactions")).rows.length, 0);
assert.equal((await db.query("select * from credit_card_payments")).rows.length, 0);
const transfer = (
  await db.query(
    "insert into transactions(kind,amount,currency,account_id,to_account_id,occurred_at) values('transfer',700000,'IDR',$1,$2,'2026-02-01') returning id",
    [bank, card],
  )
).rows[0].id;
const linked = (
  await db.query(
    "select dk_card_payment($1,null,400000,'2026-02-01',0,1,gen_random_uuid(),$2) id",
    [statement, transfer],
  )
).rows[0].id;
await db.query("select dk_card_cancel($1)", [linked]);
assert.equal((await db.query("select * from transactions")).rows.length, 1);
await assert.rejects(
  db.query("select dk_card_payment($1,null,500001,'2026-02-01',0,1,gen_random_uuid(),$2)", [
    statement,
    transfer,
  ]),
  /melebihi/,
);
// Same transfer may be allocated across statements, never beyond its value.
await db.query(
  "insert into credit_card_statements(account_id,period_start,period_end,due_date,currency,calculated_amount,final_amount) values($1,'2026-01-21','2026-02-20','2026-03-05','IDR',1000000,1000000)",
  [card],
);
const secondStatement = (
  await db.query("select id from credit_card_statements where period_end='2026-02-20'")
).rows[0].id;
await db.query("select dk_card_payment($1,null,400000,'2026-02-01',0,1,gen_random_uuid(),$2)", [
  statement,
  transfer,
]);
await assert.rejects(
  db.query("select dk_card_payment($1,null,400000,'2026-02-01',0,1,gen_random_uuid(),$2)", [
    secondStatement,
    transfer,
  ]),
  /Alokasi/,
);
await db.query("select dk_card_payment($1,null,300000,'2026-02-01',0,1,gen_random_uuid(),$2)", [
  secondStatement,
  transfer,
]);
assert.equal(
  Number(
    (
      await db.query(
        "select sum(allocated_amount) total from credit_card_payments where transaction_id=$1",
        [transfer],
      )
    ).rows[0].total,
  ),
  700000,
);
await db.close();
console.log(
  "Credit card SQL: atomic payment, retry, overpayment, protection, correction, cancellation, unlink passed.",
);
