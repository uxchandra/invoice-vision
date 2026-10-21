# Invoice Vision

Aplikasi lokal untuk **import Excel invoice → generate QR massal** memakai aplikasi
desktop **VISION Invoice Digital Transformation** (`qr_gen_2025.v.exe`).

Alih-alih mengetik satu per satu di aplikasi VISION, cukup siapkan Excel berisi
banyak invoice, upload, lalu klik **Generate Semua QR**. Worker otomatis mengisi
form aplikasi, menekan *Generate QR* dan *Copy*, lalu menyimpan tiap QR sebagai PNG
(`<SUPP_INV_NO>.png`). QR dibuat sepenuhnya oleh aplikasi VISION resmi — aplikasi ini
tidak membuat atau mengubah enkripsi QR apa pun, sehingga hasilnya identik dengan
input manual.

## Syarat

- Windows (worker memakai otomasi Win32 + clipboard).
- Node.js 18+.
- Aplikasi `qr_gen_2025.v.exe` ada di komputer ini.

## Setup

```bash
npm install
```

Lokasi aplikasi VISION default: `%USERPROFILE%\Downloads\qr_gen_2025.v.exe`.
Kalau berbeda, set lewat environment variable `EXE_PATH`.

## Menjalankan

```bash
npm start
```

Buka http://localhost:4000

1. **Download Template** → isi invoice di Excel (satu baris = satu QR).
2. **Pilih File Excel** → cek preview (validasi otomatis).
3. **Simpan sebagai Job**.
4. **Generate Semua QR** → worker memproses semua baris (~2–3 detik per invoice).
5. Lihat galeri, atau **Download Semua (ZIP)**.

## PENTING — jangan jalankan VISION sebagai Administrator

Worker meluncurkan instance aplikasi VISION-nya sendiri pada integrity **Medium**
dan mengendalikannya lewat pesan Win32. Kalau aplikasi VISION dibuka **"Run as
administrator"** (integrity High), Windows UIPI akan **memblokir** otomasi dan QR
gagal dibuat. Biarkan worker yang membuka aplikasinya sendiri; tutup instance VISION
yang terbuka manual sebagai admin bila ada.

## Kolom Excel

| Kolom | Wajib | Keterangan |
|---|---|---|
| SUPP_INV_NO | ya | Nomor invoice supplier (maks 60 char, tidak boleh dobel) |
| AMOUNT_BEFORE_TAX | ya | Angka (boleh desimal) |
| TOTAL_INVOICE_AMOUNT | ya | Angka |
| INV_TAX_AMOUNT | ya | Angka |
| INV_TAX_NO | ya | Nomor faktur pajak (maks 60 char) |

Nama header tidak case-sensitive dan mengenali beberapa alias (mis. `no_invoice`,
`dpp`, `ppn`, `no_faktur_pajak`). Lihat `src/excel.js`.

## Struktur

```
server.js            Express: UI, upload/parse Excel, trigger worker, galeri, ZIP
src/excel.js         Parse + validasi + template Excel (ExcelJS)
src/automation.ps1   Worker PowerShell: isi form VISION, Generate, Copy, simpan PNG
public/index.html    Antarmuka web
data/qr/             Hasil PNG (di-reset tiap import baru)
```

## Cara kerja worker (ringkas)

1. `Start-Process qr_gen_2025.v.exe` → instance milik worker (Medium integrity).
2. Petakan 5 `TEdit` (urut posisi) + tombol `Generate`/`Copy` lewat `EnumChildWindows`.
3. Per baris: `WM_SETTEXT` ke 5 field → verifikasi `WM_GETTEXT` → klik Generate →
   tunggu render → klik Copy → ambil bitmap dari clipboard → cek tidak kosong →
   simpan PNG.
4. Tutup instance di akhir.
