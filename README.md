# Invoice Vision

Aplikasi web **standalone** untuk **import Excel invoice → generate QR terenkripsi massal**.
QR dibuat langsung di backend (tanpa aplikasi desktop), mengikuti spesifikasi resmi
`VisionTmminVb` (VB.NET).

## Spesifikasi QR (replika dari source VB.NET)

- **Enkripsi:** AES (Rijndael) mode **CBC**, padding **PKCS7**
- **Key:** `UTF8(PRIVATE_KEY)` — 16 digit → AES-128
- **IV:** 16 byte nol
- **Plaintext (ASCII):**
  `VISION|<SUPP_INV_NO>|<AMOUNT_BEFORE_TAX>|<TOTAL_INVOICE_AMOUNT>|<INV_TAX_AMOUNT>|<INV_TAX_NO>`
  dengan ketiga amount diformat 2 desimal (mis. `45000` → `45000.00`).
- **Output:** Base64 → di-encode jadi QR (UTF-8, 500×500).

Contoh (key `VISION0123456789`):
```
VISION|00176.I.23|1195780140.00|1327315955.00|146004755.05|0100032361617140
→ OOzKH2RRr/1EL4N3IG8luSJLCgNaRGq4oz7q+tSzr/lGFAqMuy2CCblT7Oikj4nStModUZkMyX7WFgkM2BHs0imyfZdwb4SCxgZ6OnGnsSM=
```

## Setup

```bash
npm install
cp .env.example .env    # lalu isi PRIVATE_KEY dengan key asli (16 digit)
npm start
```

Buka http://localhost:4000

1. **Download Template** → isi invoice di Excel (satu baris = satu QR).
2. **Pilih File Excel** → cek preview (validasi otomatis).
3. **Simpan sebagai Job**.
4. **Generate Semua QR** → QR dibuat instan di server.
5. **Export Excel** (tabel Hasil QR + gambar QR tersemat), atau unduh per file.

## Konfigurasi (.env)

| Variable | Keterangan |
|---|---|
| `PRIVATE_KEY` | Private key enkripsi, **16 digit** (AES-128). Wajib. |
| `PORT` | Port web (default 4000). |

> `.env` berisi secret dan **tidak di-commit**. Gunakan `.env.example` sebagai acuan.

## Kolom Excel

| Kolom | Wajib | Keterangan |
|---|---|---|
| SUPP_INV_NO | ya | Nomor invoice supplier (teks, tidak boleh dobel) |
| AMOUNT_BEFORE_TAX | ya | Angka (otomatis 2 desimal di QR) |
| TOTAL_INVOICE_AMOUNT | ya | Angka |
| INV_TAX_AMOUNT | ya | Angka |
| INV_TAX_NO | ya | Nomor faktur pajak — **ketik sebagai teks** agar nol depan/16 digit utuh |

Header tidak case-sensitive dan mengenali beberapa alias (lihat `src/excel.js`).

## Struktur

```
server.js            Express: UI, import/parse Excel, generate QR, galeri, export Excel
src/excel.js         Parse + validasi + template Excel (ExcelJS)
src/vision-qr.js     Mesin enkripsi AES + QR (replika Module1.vb)
public/index.html    Antarmuka web
data/qr/             Hasil PNG (di-reset tiap import baru)
.env                 PRIVATE_KEY (tidak di-commit)
```

## Catatan

Versi sebelumnya menggerakkan aplikasi desktop `qr_gen_2025.v.exe` karena spesifikasi
QR belum diketahui. Sejak spesifikasi `VisionTmminVb` didapat, QR dibuat langsung di
backend — lebih cepat, lintas-platform, dan tak butuh aplikasi desktop.
QR dari versi standalone ini mengikuti format VB.NET (ada prefix `VISION|` dan amount
2 desimal), sehingga **berbeda** dengan QR aplikasi Delphi lama.
