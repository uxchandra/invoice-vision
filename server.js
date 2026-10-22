import "dotenv/config";
import express from "express";
import multer from "multer";
import archiver from "archiver";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COLUMNS, parseInvoiceWorkbook, buildInvoiceTemplate, validateRow } from "./src/excel.js";
import { generateRow, validateKey } from "./src/vision-qr.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const QR_DIR = path.join(DATA_DIR, "qr");
const JOB_FILE = path.join(DATA_DIR, "job.json");
const RESULT_FILE = path.join(DATA_DIR, "result.json");

// Private key enkripsi (16 digit = AES-128), diambil dari .env
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";

const PORT = Number(process.env.PORT) || 4000;

await fs.mkdir(QR_DIR, { recursive: true });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Satu job aktif disimpan di memori + file, supaya worker & UI sinkron
let job = null; // { rows: [...], summary, valid }
let generating = false;

// Nama file aman dari SUPP_INV_NO
const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "_");

async function loadJob() {
  try {
    job = JSON.parse(await fs.readFile(JOB_FILE, "utf8"));
  } catch {
    job = null;
  }
}
await loadJob();

function buildPreview(rows) {
  // Dup SUPP_INV_NO dalam file
  const firstRow = new Map();
  for (const r of rows) {
    const key = r.suppInvNo.toLowerCase();
    if (!r.suppInvNo) continue;
    const first = firstRow.get(key);
    if (first) r.errors.push(`SUPP_INV_NO sudah dipakai di baris ${first}`);
    else firstRow.set(key, r.baris);
  }
  const invalid = rows.filter((r) => r.errors.length > 0).length;
  return {
    rows,
    summary: { total: rows.length, siap: rows.length - invalid, invalid },
    valid: invalid === 0,
  };
}

app.get("/api/template", async (_req, res) => {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="template-invoice.xlsx"');
  res.send(await buildInvoiceTemplate());
});

app.post("/api/preview", upload.single("file"), async (req, res) => {
  if (!req.file?.buffer?.length) return res.status(422).json({ message: "File Excel wajib diupload" });
  let parsed;
  try {
    parsed = await parseInvoiceWorkbook(req.file.buffer);
  } catch {
    return res.status(422).json({ message: "File tidak bisa dibaca. Pastikan formatnya .xlsx" });
  }
  if (parsed.error) return res.status(422).json({ message: parsed.error });
  res.json(buildPreview(parsed.rows));
});

// Simpan job valid sebagai job aktif (reset hasil QR lama)
app.post("/api/import", upload.single("file"), async (req, res) => {
  if (!req.file?.buffer?.length) return res.status(422).json({ message: "File Excel wajib diupload" });
  let parsed;
  try {
    parsed = await parseInvoiceWorkbook(req.file.buffer);
  } catch {
    return res.status(422).json({ message: "File tidak bisa dibaca. Pastikan formatnya .xlsx" });
  }
  if (parsed.error) return res.status(422).json({ message: parsed.error });

  const preview = buildPreview(parsed.rows);
  if (!preview.valid) return res.status(422).json({ message: "Masih ada baris error, cek preview dulu" });
  await saveJob(preview);
  res.status(201).json({ message: `${job.rows.length} invoice siap digenerate`, job });
});

// Input manual: body { rows: [{ suppInvNo, amountBeforeTax, totalInvoiceAmount, invTaxAmount, invTaxNo }] }
function manualRows(body) {
  const rows = Array.isArray(body?.rows) ? body.rows : [];
  return rows.map((r, i) => validateRow(r, i + 1));
}

app.post("/api/preview-manual", (req, res) => {
  const rows = manualRows(req.body);
  if (rows.length === 0) return res.status(422).json({ message: "Belum ada invoice yang diisi" });
  res.json(buildPreview(rows));
});

app.post("/api/import-manual", async (req, res) => {
  if (generating) return res.status(409).json({ message: "Proses generate sedang berjalan" });
  const rows = manualRows(req.body);
  if (rows.length === 0) return res.status(422).json({ message: "Belum ada invoice yang diisi" });
  const preview = buildPreview(rows);
  if (!preview.valid) return res.status(422).json({ message: "Masih ada data error, cek daftar dulu" });
  await saveJob(preview);
  res.status(201).json({ message: `${job.rows.length} invoice siap digenerate`, job });
});

// Simpan preview valid sebagai job aktif (reset hasil QR lama)
async function saveJob(preview) {
  for (const f of await fs.readdir(QR_DIR)) await fs.rm(path.join(QR_DIR, f));

  job = {
    importedAt: new Date().toISOString(),
    rows: preview.rows.map((r, i) => ({
      no: i + 1,
      suppInvNo: r.suppInvNo,
      amountBeforeTax: r.amountBeforeTax,
      totalInvoiceAmount: r.totalInvoiceAmount,
      invTaxAmount: r.invTaxAmount,
      invTaxNo: r.invTaxNo,
      file: `${safeName(r.suppInvNo)}.png`,
      status: "pending",
    })),
    summary: preview.summary,
  };
  await fs.writeFile(JOB_FILE, JSON.stringify(job, null, 2));
}

// Status job + cek PNG mana yang sudah ada
app.get("/api/status", async (_req, res) => {
  if (!job) return res.json({ job: null, generating });
  const files = new Set(await fs.readdir(QR_DIR));
  const rows = job.rows.map((r) => ({ ...r, hasQr: files.has(r.file) }));
  const done = rows.filter((r) => r.hasQr).length;
  res.json({ generating, keyReady: validateKey(PRIVATE_KEY), job: { ...job, rows }, done, total: rows.length });
});

// Proses semua baris: susun plaintext VISION, enkripsi, render PNG
async function processJob() {
  const results = [];
  let ok = 0;
  for (const row of job.rows) {
    try {
      const { plaintext, payload, png } = await generateRow(row, PRIVATE_KEY);
      await fs.writeFile(path.join(QR_DIR, row.file), png);
      ok++;
      results.push({ no: row.no, suppInvNo: row.suppInvNo, file: row.file, ok: true, plaintext, payload });
    } catch (err) {
      results.push({ no: row.no, suppInvNo: row.suppInvNo, file: row.file, ok: false, error: String(err?.message || err) });
    }
  }
  await fs.writeFile(
    RESULT_FILE,
    JSON.stringify({ total: job.rows.length, ok, gagal: job.rows.length - ok, results, finishedAt: new Date().toISOString() }, null, 2),
  );
  generating = false;
}

// Generate semua QR langsung di backend (tanpa aplikasi desktop)
app.post("/api/generate", async (_req, res) => {
  if (!job || job.rows.length === 0) return res.status(422).json({ message: "Belum ada job. Import Excel dulu." });
  if (generating) return res.status(409).json({ message: "Proses generate sedang berjalan" });
  if (!validateKey(PRIVATE_KEY))
    return res.status(422).json({ message: "PRIVATE_KEY belum di-set / panjang tidak valid (harus 16 digit). Cek file .env." });

  generating = true;
  await fs.rm(RESULT_FILE, { force: true });
  // Jalankan di belakang supaya UI bisa polling progres
  processJob().catch(() => (generating = false));
  res.json({ message: "Proses generate dimulai." });
});

app.get("/api/qr/:file", (req, res) => {
  const file = path.basename(req.params.file);
  const full = path.join(QR_DIR, file);
  res.sendFile(full, (err) => err && res.status(404).end());
});

app.get("/api/download-zip", async (_req, res) => {
  const files = await fs.readdir(QR_DIR);
  if (files.length === 0) return res.status(404).json({ message: "Belum ada QR yang digenerate" });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="qr-invoice.zip"');
  const zip = archiver("zip", { zlib: { level: 9 } });
  zip.pipe(res);
  for (const f of files) zip.append(createReadStream(path.join(QR_DIR, f)), { name: f });
  await zip.finalize();
});

// Export isi tabel Hasil QR ke Excel (dengan gambar QR disematkan)
app.get("/api/export-excel", async (_req, res) => {
  if (!job || job.rows.length === 0) return res.status(404).json({ message: "Belum ada data" });
  const files = new Set(await fs.readdir(QR_DIR));
  const rows = job.rows.filter((r) => files.has(r.file));
  if (rows.length === 0) return res.status(404).json({ message: "Belum ada QR yang digenerate" });

  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Hasil QR", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "SUPP_INV_NO", key: "suppInvNo", width: 18 },
    { header: "AMOUNT_BEFORE_TAX", key: "amountBeforeTax", width: 20 },
    { header: "TOTAL_INVOICE_AMOUNT", key: "totalInvoiceAmount", width: 22 },
    { header: "INV_TAX_AMOUNT", key: "invTaxAmount", width: 18 },
    { header: "INV_TAX_NO", key: "invTaxNo", width: 18 },
    { header: "QR", key: "qr", width: 12 },
    { header: "FILE", key: "file", width: 24 },
  ];
  const thin = { style: "thin" };
  ws.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFB91C1C" } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = { top: thin, left: thin, bottom: thin, right: thin };
  });

  const num = (v) => (isNaN(Number(v)) ? v : Number(v));
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const row = ws.addRow({
      suppInvNo: r.suppInvNo,
      amountBeforeTax: num(r.amountBeforeTax),
      totalInvoiceAmount: num(r.totalInvoiceAmount),
      invTaxAmount: num(r.invTaxAmount),
      invTaxNo: r.invTaxNo,
      qr: "",
      file: r.file,
    });
    row.height = 60;
    row.getCell("suppInvNo").numFmt = "@"; // teks: jaga nol depan
    row.getCell("invTaxNo").numFmt = "@";
    [2, 3, 4].forEach((c) => (row.getCell(c).numFmt = "#,##0"));
    row.eachCell((cell) => (cell.alignment = { vertical: "middle" }));

    try {
      const buffer = await fs.readFile(path.join(QR_DIR, r.file));
      const imgId = wb.addImage({ buffer, extension: "png" });
      // kolom QR = index 5 (0-based), baris data mulai 1 (0-based untuk row index)
      ws.addImage(imgId, { tl: { col: 5.2, row: row.number - 1 + 0.1 }, ext: { width: 72, height: 72 } });
    } catch {
      /* lewati jika file hilang */
    }
  }

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="hasil-qr-invoice.xlsx"');
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
});

app.get("/api/columns", (_req, res) => res.json(COLUMNS.map((c) => ({ key: c.key, header: c.header }))));

app
  .listen(PORT, () => console.log(`Invoice Vision jalan di http://localhost:${PORT}`))
  .on("error", (err) => {
    if (err.code !== "EADDRINUSE") throw err;
    console.error(`Port ${PORT} sudah dipakai (server lama masih jalan?). Matikan dulu, mis.:`);
    console.error(`  Get-NetTCPConnection -LocalPort ${PORT} -State Listen | % { Stop-Process -Id $_.OwningProcess }`);
    process.exit(1);
  });
