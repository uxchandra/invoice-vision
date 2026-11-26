import ExcelJS from "exceljs";
import { formatSuppInvNo } from "./vision-qr.js";

// ===== Kolom import invoice =====
// Dikenali dari nama header (urutan bebas). Header dicari di 10 baris teratas.
// Field mengikuti aplikasi VISION Invoice Digital Transformation.
// Format export Coretax (Faktur Keluaran) dikenali lewat alias:
//   Referensi -> SUPP_INV_NO, Harga Jual/Penggantian/DPP -> AMOUNT_BEFORE_TAX,
//   Total amount -> TOTAL_INVOICE_AMOUNT, PPN -> INV_TAX_AMOUNT, Nomor Faktur Pajak -> INV_TAX_NO
export const COLUMNS = [
  { key: "suppInvNo", header: "SUPP_INV_NO", width: 22, max: 60, aliases: ["referensi", "supplierinvoiceno", "noinvoicesupplier", "noinvoice", "invoiceno"] },
  { key: "amountBeforeTax", header: "AMOUNT_BEFORE_TAX", width: 20, aliases: ["hargajualpenggantiandpp", "amountbeforetax", "dpp", "sebelumpajak", "nilaisebelumpajak"] },
  { key: "totalInvoiceAmount", header: "TOTAL_INVOICE_AMOUNT", width: 22, aliases: ["totalamount", "totalinvoice", "grandtotal", "total"] },
  { key: "invTaxAmount", header: "INV_TAX_AMOUNT", width: 18, aliases: ["ppn", "taxamount", "nilaipajak", "jumlahpajak"] },
  { key: "invTaxNo", header: "INV_TAX_NO", width: 18, max: 60, aliases: ["nomorfakturpajak", "taxno", "nofakturpajak", "nopajak", "fakturpajak"] },
];

// Layout template = layout export Coretax. `use` = kolom yang dipakai untuk QR.
const TEMPLATE_COLUMNS = [
  { header: " ", width: 4 },
  { header: "NPWP Pembeli / Identitas lainnya", width: 20, text: true },
  { header: "Nama Pembeli", width: 38 },
  { header: "Kode Transaksi", width: 20 },
  { header: "Nomor Faktur Pajak", width: 21, text: true, use: "invTaxNo" },
  { header: "Tanggal Faktur Pajak", width: 20 },
  { header: "Masa Pajak", width: 11 },
  { header: "Tahun", width: 7 },
  { header: "Status Faktur", width: 12 },
  { header: "ESignStatus", width: 11 },
  { header: "Harga Jual/Penggantian/DPP", width: 24, money: true, use: "amountBeforeTax" },
  { header: "DPP Nilai Lain/DPP", width: 18, money: true },
  { header: "PPN", width: 16, money: true, use: "invTaxAmount" },
  { header: "PPnBM", width: 10, money: true },
  { header: "Penandatangan", width: 22 },
  { header: "Referensi", width: 20, text: true, use: "suppInvNo" },
  { header: "Metode Input", width: 12 },
  { header: "Dilaporkan oleh Penjual", width: 12 },
  { header: "Dilaporkan oleh Pemungut PPN", width: 12 },
  { header: "IsShowClearName", width: 12 },
  { header: "Total amount", width: 18, money: true, use: "totalInvoiceAmount" },
];

// Field angka: boleh desimal, tidak boleh negatif
const NUMERIC_KEYS = new Set(["amountBeforeTax", "totalInvoiceAmount", "invTaxAmount"]);

const HEADER_SCAN_ROWS = 10;
const normalize = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

const headerLookup = new Map();
for (const c of COLUMNS) {
  for (const name of [c.header, c.key, ...(c.aliases ?? [])]) headerLookup.set(normalize(name), c.key);
}

function cellText(cell) {
  const v = cell?.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if (v instanceof Date) return v.toISOString();
    if ("text" in v) return String(v.text);
    if ("result" in v) return String(v.result ?? "");
    if ("richText" in v) return v.richText.map((r) => r.text).join("");
  }
  return String(v).trim();
}

function findHeader(ws) {
  for (let r = 1; r <= Math.min(HEADER_SCAN_ROWS, ws.rowCount); r++) {
    const map = new Map();
    ws.getRow(r).eachCell((cell, col) => {
      const key = headerLookup.get(normalize(cellText(cell)));
      if (key && !map.has(key)) map.set(key, col);
    });
    if (map.has("suppInvNo")) return { row: r, map };
  }
  return null;
}

// Buang pemisah ribuan, terima koma/titik desimal. Mengembalikan null kalau bukan angka valid.
function parseNumber(raw) {
  if (!raw) return { ok: false, empty: true };
  let s = raw.replace(/\s/g, "");
  // 1.234.567,89 (format ID) -> 1234567.89
  if (/,\d{1,2}$/.test(s) && s.includes(".")) s = s.replace(/\./g, "").replace(",", ".");
  // 1.234.567 (pemisah ribuan titik, tanpa desimal) -> 1234567
  else if (/^-?\d{1,3}(\.\d{3}){2,}$/.test(s)) s = s.replace(/\./g, "");
  else if (s.includes(",") && !s.includes(".")) s = s.replace(",", ".");
  else s = s.replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return { ok: false, empty: false };
  return { ok: true, value: Number(s), text: s };
}

// Validasi satu invoice (dari Excel maupun input manual). values = { suppInvNo, ..., invTaxNo } berupa teks.
export function validateRow(input, baris) {
  const values = Object.fromEntries(COLUMNS.map((c) => [c.key, String(input?.[c.key] ?? "").trim()]));
  const errors = [];
  const warnings = [];
  const data = {};

  if (!values.suppInvNo) errors.push("SUPP_INV_NO wajib diisi");
  if (!values.invTaxNo) errors.push("INV_TAX_NO wajib diisi");
  for (const c of COLUMNS) {
    if (c.max && values[c.key].length > c.max) errors.push(`${c.header} maksimal ${c.max} karakter`);
  }

  data.suppInvNo = formatSuppInvNo(values.suppInvNo); // "/" -> "." + tahun 4 digit -> 2 digit
  data.invTaxNo = values.invTaxNo;

  for (const key of NUMERIC_KEYS) {
    const col = COLUMNS.find((c) => c.key === key);
    const parsed = parseNumber(values[key]);
    if (!parsed.ok) {
      errors.push(parsed.empty ? `${col.header} wajib diisi` : `${col.header} harus berupa angka (isi: "${values[key]}")`);
      data[key] = values[key];
    } else {
      if (parsed.value < 0) errors.push(`${col.header} tidak boleh negatif`);
      data[key] = parsed.text;
    }
  }

  return { baris, ...data, errors, warnings };
}

export async function parseInvoiceWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const ws = wb.worksheets.find((s) => s.state === "visible" && s.actualRowCount > 0);
  if (!ws) return { error: "File Excel kosong" };

  const header = findHeader(ws);
  if (!header) return { error: 'Kolom "Referensi" / "SUPP_INV_NO" tidak ditemukan. Gunakan template import invoice.' };

  const rows = [];
  for (let r = header.row + 1; r <= ws.rowCount; r++) {
    const text = (key) => {
      const col = header.map.get(key);
      return col ? cellText(ws.getCell(r, col)) : "";
    };
    const values = Object.fromEntries(COLUMNS.map((c) => [c.key, text(c.key)]));
    if (Object.values(values).every((v) => !v)) continue;
    // Total kosong (mis. rumus belum terhitung) -> hitung DPP + PPN
    if (!values.totalInvoiceAmount) {
      const dpp = parseNumber(values.amountBeforeTax);
      const ppn = parseNumber(values.invTaxAmount);
      if (dpp.ok && ppn.ok) values.totalInvoiceAmount = String(Math.round((dpp.value + ppn.value) * 100) / 100);
    }
    rows.push(validateRow(values, r));
  }

  if (rows.length === 0) return { error: `Belum ada data invoice (mulai baris ${header.row + 1})` };
  return { rows };
}

// ===== Template Excel (layout export Coretax) =====
export async function buildInvoiceTemplate() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("data", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = TEMPLATE_COLUMNS.map((c) => ({ header: c.header, width: c.width }));

  const thin = { style: "thin" };
  TEMPLATE_COLUMNS.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    if (c.text) col.numFmt = "@"; // teks: jaga nol depan & nomor panjang
    if (c.money) col.numFmt = "#,##0";
    const cell = ws.getCell(1, i + 1);
    // Kolom yang dipakai untuk QR diberi warna biru, sisanya abu-abu (opsional)
    cell.font = { bold: true, color: { argb: c.use ? "FFFFFFFF" : "FF404040" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: c.use ? "FF1F4E78" : "FFD9D9D9" } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = { top: thin, left: thin, bottom: thin, right: thin };
  });
  ws.getRow(1).height = 32;

  const sample = [
    null, "0010000990092000", "TOYOTA MOTOR MANUFACTURING INDONESIA", "04 - DPP Nilai Lain",
    "04002600498490662", "2026-11-13T00:00:00", "November", "2026", "APPROVED", "Done",
    232000000, 212666667, 25520000, 0, "SIGIT WIDI HATMONO", "3010/STEP/XI/2026", "XML", false, null, null,
  ];
  const row = ws.addRow(sample);
  row.getCell(21).value = { formula: `K${row.number}+M${row.number}`, result: 257520000 };

  const guide = wb.addWorksheet("PETUNJUK");
  guide.columns = [{ width: 115 }];
  [
    "PETUNJUK IMPORT INVOICE — VISION QR",
    "",
    '1. Format sama dengan export Faktur Keluaran Coretax. File export Coretax bisa langsung di-import.',
    '2. Isi data di sheet "data" mulai baris 2. Satu baris = satu invoice = satu QR.',
    "3. Kolom yang dipakai (header biru), sisanya (abu-abu) boleh dikosongkan:",
    "   - Referensi                    -> SUPP_INV_NO (wajib, tidak boleh dobel)",
    "   - Harga Jual/Penggantian/DPP   -> AMOUNT_BEFORE_TAX",
    "   - PPN                          -> INV_TAX_AMOUNT",
    "   - Total amount                 -> TOTAL_INVOICE_AMOUNT (kalau kosong otomatis = Harga Jual + PPN)",
    "   - Nomor Faktur Pajak           -> INV_TAX_NO (wajib, ketik sebagai teks agar nol depan tidak hilang)",
    "4. Angka: pemisah ribuan otomatis dibuang (contoh 25.000.000 => 25000000).",
    "5. QR berisi teks terenkripsi dari: VISION|SUPP_INV_NO|AMOUNT_BEFORE_TAX|TOTAL_INVOICE_AMOUNT|INV_TAX_AMOUNT|INV_TAX_NO",
    "6. Hapus baris contoh sebelum import. Nama file QR = Referensi (karakter / diganti _), mis. 3010_STEP_XI_2026.png",
    "7. Template lama (header SUPP_INV_NO, AMOUNT_BEFORE_TAX, dst.) masih bisa di-import.",
  ].forEach((line, i) => {
    const cell = guide.getCell(i + 1, 1);
    cell.value = line;
    if (i === 0) cell.font = { bold: true, size: 14 };
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
