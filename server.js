import express from "express";
import multer from "multer";
import archiver from "archiver";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COLUMNS, parseInvoiceWorkbook, buildInvoiceTemplate } from "./src/excel.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const QR_DIR = path.join(DATA_DIR, "qr");
const JOB_FILE = path.join(DATA_DIR, "job.json");
const RESULT_FILE = path.join(DATA_DIR, "result.json");
const PS_SCRIPT = path.join(__dirname, "src", "automation.ps1");

// Lokasi aplikasi VISION; bisa dioverride lewat env EXE_PATH
const EXE_PATH =
  process.env.EXE_PATH || path.join(process.env.USERPROFILE || "C:\\Users\\user", "Downloads", "qr_gen_2025.v.exe");

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

  // Bersihkan QR lama
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
  res.status(201).json({ message: `${job.rows.length} invoice siap digenerate`, job });
});

// Status job + cek PNG mana yang sudah ada
app.get("/api/status", async (_req, res) => {
  if (!job) return res.json({ job: null, generating });
  const files = new Set(await fs.readdir(QR_DIR));
  const rows = job.rows.map((r) => ({ ...r, hasQr: files.has(r.file) }));
  const done = rows.filter((r) => r.hasQr).length;
  res.json({ generating, exePath: EXE_PATH, job: { ...job, rows }, done, total: rows.length });
});

// Jalankan worker PowerShell untuk generate semua QR
app.post("/api/generate", async (_req, res) => {
  if (!job || job.rows.length === 0) return res.status(422).json({ message: "Belum ada job. Import Excel dulu." });
  if (generating) return res.status(409).json({ message: "Proses generate sedang berjalan" });
  if (process.platform !== "win32")
    return res.status(422).json({ message: "Generate QR hanya bisa di Windows (butuh aplikasi VISION)." });

  try {
    await fs.access(EXE_PATH);
  } catch {
    return res.status(422).json({ message: `Aplikasi VISION tidak ditemukan di: ${EXE_PATH}` });
  }

  generating = true;
  await fs.writeFile(JOB_FILE, JSON.stringify(job, null, 2));
  await fs.rm(RESULT_FILE, { force: true });

  const ps = spawn(
    "powershell.exe",
    ["-NoProfile", "-Sta", "-ExecutionPolicy", "Bypass", "-File", PS_SCRIPT, "-JobFile", JOB_FILE, "-OutDir", QR_DIR, "-ExePath", EXE_PATH, "-ResultFile", RESULT_FILE],
    { windowsHide: false },
  );
  let log = "";
  ps.stdout.on("data", (d) => (log += d));
  ps.stderr.on("data", (d) => (log += d));
  ps.on("close", async (code) => {
    generating = false;
    let result = null;
    try {
      result = JSON.parse(await fs.readFile(RESULT_FILE, "utf8"));
    } catch {
      /* worker tidak menulis hasil */
    }
    await fs.writeFile(path.join(DATA_DIR, "last-run.log"), `exit ${code}\n${log}`);
  });

  res.json({ message: "Proses generate dimulai. Pantau progres di halaman ini." });
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

app.listen(PORT, () => console.log(`Invoice Vision jalan di http://localhost:${PORT}`));
