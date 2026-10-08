# Tagihan kartu kredit

1. Jalankan bagian **v16** di `supabase/schema.sql` pada Supabase SQL Editor.
2. Buka **Akun**, ubah akun jenis **Kartu kredit**.
3. Isi tanggal cut-off, tanggal jatuh tempo, periode pertama (`YYYY-MM`). Utang awal hanya untuk kewajiban yang belum termasuk transaksi dalam periode pertama; tidak membuat pengeluaran baru.
4. Buka **Tagihan Kartu Kredit**. Periode berjalan berupa estimasi; periode ditutup setelah hari cut-off berlalu saat halaman/dashboard/pengingat dibuka.
5. Cocokkan tagihan bank melalui **Koreksi tagihan**. Koreksi tidak mengubah saldo: bunga, biaya, refund perlu transaksi tersendiri.
6. Klik **Bayar**, pilih sumber dana bermata uang sama, nominal dan tanggal. Pembayaran membuat transfer, biaya admin membuat pengeluaran terpisah. Tidak mengirim uang melalui bank.
7. Untuk transfer yang sudah tercatat, pilih **Tautkan transfer yang sudah ada**. Nominal dapat dialokasikan ke beberapa tagihan, tidak melebihi nilai transfer.

Transaksi tepat tanggal cut-off masuk periode tersebut. Jatuh tempo memakai tanggal berikutnya setelah cut-off, tanggal 29–31 mengikuti hari terakhir bulan. Estimasi menggunakan tanggal transaksi, bukan tanggal pembukuan bank.

Snapshot tidak berubah otomatis saat transaksi lama diubah. Detail menampilkan perubahan nominal; **Perbarui perhitungan** mengganti nominal final setelah konfirmasi, termasuk koreksi sebelumnya. Koreksi dicatat dalam activity log.

**Batalkan** menghapus transfer/biaya milik pembayaran. **Lepas tautan** mempertahankan transfer lama. Transaksi terkait tidak dapat diedit/dihapus sebelum pembatalan/pelepasan tautan. Arsipkan kartu yang sudah memiliki tagihan, jangan hapus.

Pembayaran dari menu **Hutang & Cicilan** mencatat pengeluaran. Jangan mencatat pembayaran belanja yang sama di sana jika belanja sudah dicatat penuh pada kartu.

Pengingat hanya memuat sisa tagihan positif. Email/bot/n8n memakai payload pengingat yang sama; pengiriman terjadwal memerlukan automation yang sudah tersedia.

## Verifikasi SQL lokal

`scripts/check-credit-card.mjs` menguji migrasi v16 dan pembayaran pada PostgreSQL embedded PGlite. Dependency verifikasi tidak ditambahkan ke aplikasi:

```sh
PGLITE_MODULE=/absolute/path/to/@electric-sql/pglite/dist/index.js node scripts/check-credit-card.mjs
```
