import ExcelJS from "exceljs";

// ===== Kolom import invoice =====
// Dikenali dari nama header (urutan bebas). Header dicari di 10 baris teratas.
// Field mengikuti aplikasi VISION Invoice Digital Transformation.
export const COLUMNS = [
  { key: "suppInvNo", header: "SUPP_INV_NO", width: 22, max: 60, aliases: ["supplierinvoiceno", "noinvoicesupplier", "noinvoice", "invoiceno"] },
  { key: "amountBeforeTax", header: "AMOUNT_BEFORE_TAX", width: 20, aliases: ["amountbeforetax", "dpp", "sebelumpajak", "nilaisebelumpajak"] },
  { key: "totalInvoiceAmount", header: "TOTAL_INVOICE_AMOUNT", width: 22, aliases: ["totalinvoice", "totalamount", "grandtotal", "total"] },
  { key: "invTaxAmount", header: "INV_TAX_AMOUNT", width: 18, aliases: ["taxamount", "ppn", "nilaipajak", "jumlahpajak"] },
  { key: "invTaxNo", header: "INV_TAX_NO", width: 18, max: 60, aliases: ["taxno", "nofakturpajak", "nopajak", "fakturpajak"] },
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
  else if (s.includes(",") && !s.includes(".")) s = s.replace(",", ".");
  else s = s.replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return { ok: false, empty: false };
  return { ok: true, value: Number(s), text: s };
}

export async function parseInvoiceWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const ws = wb.worksheets.find((s) => s.state === "visible" && s.actualRowCount > 0);
  if (!ws) return { error: "File Excel kosong" };

  const header = findHeader(ws);
  if (!header) return { error: 'Kolom "SUPP_INV_NO" tidak ditemukan. Gunakan template import invoice.' };

  const rows = [];
  for (let r = header.row + 1; r <= ws.rowCount; r++) {
    const text = (key) => {
      const col = header.map.get(key);
      return col ? cellText(ws.getCell(r, col)) : "";
    };
    const values = Object.fromEntries(COLUMNS.map((c) => [c.key, text(c.key)]));
    if (Object.values(values).every((v) => !v)) continue;

    const errors = [];
    const warnings = [];
    const data = {};

    if (!values.suppInvNo) errors.push("SUPP_INV_NO wajib diisi");
    if (!values.invTaxNo) errors.push("INV_TAX_NO wajib diisi");
    for (const c of COLUMNS) {
      if (c.max && values[c.key].length > c.max) errors.push(`${c.header} maksimal ${c.max} karakter`);
    }

    data.suppInvNo = values.suppInvNo;
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

    rows.push({ baris: r, ...data, errors, warnings });
  }

  if (rows.length === 0) return { error: `Belum ada data invoice (mulai baris ${header.row + 1})` };
  return { rows };
}

// ===== Template Excel =====
export async function buildInvoiceTemplate() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Invoice", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));

  const thin = { style: "thin" };
  ws.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = { top: thin, left: thin, bottom: thin, right: thin };
  });

  ws.addRow({
    suppInvNo: "4363464363",
    amountBeforeTax: 45000,
    totalInvoiceAmount: 49500,
    invTaxAmount: 4500,
    invTaxNo: "010.000-25.00000001",
  });

  const guide = wb.addWorksheet("PETUNJUK");
  guide.columns = [{ width: 110 }];
  [
    "PETUNJUK IMPORT INVOICE",
    "",
    '1. Isi data di sheet "Invoice" mulai baris 2. Satu baris = satu invoice = satu QR.',
    "2. Semua kolom wajib diisi.",
    "3. SUPP_INV_NO dan INV_TAX_NO berupa teks/nomor, maksimal 60 karakter, SUPP_INV_NO tidak boleh dobel.",
    "4. AMOUNT_BEFORE_TAX, TOTAL_INVOICE_AMOUNT, INV_TAX_AMOUNT berupa angka (boleh desimal).",
    "5. Hapus baris contoh sebelum import.",
    "6. Nama file QR hasil generate = SUPP_INV_NO.png",
  ].forEach((line, i) => {
    const cell = guide.getCell(i + 1, 1);
    cell.value = line;
    if (i === 0) cell.font = { bold: true, size: 14 };
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
