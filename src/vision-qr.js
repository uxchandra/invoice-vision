import crypto from "node:crypto";
import zlib from "node:zlib";
import QRCode from "qrcode";

// ============================================================================
// Mesin QR VISION — replika persis dari source VB.NET (VisionTmminVb/Module1.vb)
//
//   AES (RijndaelManaged), Mode = CBC, Padding = PKCS7
//   Key = UTF8(privateKey)         (16 digit => AES-128)
//   IV  = 16 byte nol
//   Plaintext di-ASCII-kan lalu dienkripsi, hasilnya Base64.
//   Plaintext format:
//     VISION|<SUPP_INV_NO>|<AMOUNT_BEFORE_TAX>|<TOTAL_INVOICE_AMOUNT>|<INV_TAX_AMOUNT>|<INV_TAX_NO>
//   dengan SUPP_INV_NO "/" -> "." dan ketiga nilai amount diformat 2 desimal (mis. 45000 -> 45000.00).
//   QR dibuat dari string Base64 tersebut (ZXing di aslinya; di sini library qrcode).
// ============================================================================

export const QR_PREFIX = "VISION";

// Validasi panjang key sesuai AES (16/24/32). Spec VISION: 16 digit.
export function validateKey(key) {
  const len = Buffer.byteLength(String(key ?? ""), "utf8");
  return len === 16 || len === 24 || len === 32;
}

// Amount: 2 digit terakhir dianggap desimal (sen), seperti app VISION.
//   40995900 -> "409959.00",  4509500 -> "45095.00".
// Kalau nilai sudah mengandung titik desimal, dipakai apa adanya (2 desimal).
export function formatAmount(value) {
  const s = String(value ?? "").trim().replace(/,/g, ".");
  if (s === "") return "0.00";
  if (s.includes(".")) {
    const n = Number(s);
    return Number.isFinite(n) ? n.toFixed(2) : s;
  }
  const digits = s.replace(/[^\d]/g, "").padStart(3, "0"); // minimal 3 digit untuk x.xx
  return `${digits.slice(0, -2).replace(/^0+(?=\d)/, "")}.${digits.slice(-2)}`;
}

// Supplier Invoice No sesuai nilai "screen" sistem VISION:
//  - garis miring "/" diganti titik "."
//  - tahun 4 digit di segmen terakhir dipendekkan jadi 2 digit (2026 -> 26)
// Contoh: 3031/STEP/XI/2026 -> 3031.STEP.XI.26
export function formatSuppInvNo(value) {
  const parts = String(value ?? "").trim().split("/");
  const last = parts[parts.length - 1];
  if (parts.length > 1 && /^\d{4}$/.test(last)) parts[parts.length - 1] = last.slice(-2);
  return parts.join(".");
}

// Susun plaintext persis seperti contoh manual book
export function buildPlaintext(row) {
  return [
    QR_PREFIX,
    formatSuppInvNo(row.suppInvNo),
    formatAmount(row.amountBeforeTax),
    formatAmount(row.totalInvoiceAmount),
    formatAmount(row.invTaxAmount),
    row.invTaxNo,
  ].join("|");
}

// Enkripsi AES-CBC/PKCS7, IV nol, plaintext ASCII -> Base64 (identik VB.NET)
export function encrypt(plaintext, privateKey) {
  const key = Buffer.from(String(privateKey), "utf8");
  const iv = Buffer.alloc(16, 0);
  const cipher = crypto.createCipheriv(`aes-${key.length * 8}-cbc`, key, iv);
  const buf = Buffer.from(plaintext, "ascii");
  return Buffer.concat([cipher.update(buf), cipher.final()]).toString("base64");
}

// Dekripsi (untuk verifikasi/audit)
export function decrypt(base64, privateKey) {
  const key = Buffer.from(String(privateKey), "utf8");
  const iv = Buffer.alloc(16, 0);
  const d = crypto.createDecipheriv(`aes-${key.length * 8}-cbc`, key, iv);
  return Buffer.concat([d.update(Buffer.from(base64, "base64")), d.final()]).toString("ascii");
}

// Ukuran cetak QR: 3 x 3 cm. Resolusi tetap 500x500 px (tajam saat dicetak),
// tapi metadata DPI (chunk pHYs) diset supaya Word/Excel/dll langsung
// menampilkannya 3 x 3 cm saat disisipkan, tanpa perlu resize manual.
export const QR_SIZE_CM = 3;
export const QR_SIZE_PX = 500;

// Sisipkan chunk pHYs (pixels per meter) tepat setelah IHDR
function setPngPhysicalSize(png, sizePx, sizeCm) {
  const ppm = Math.round(sizePx / (sizeCm / 100));
  const data = Buffer.alloc(9);
  data.writeUInt32BE(ppm, 0);
  data.writeUInt32BE(ppm, 4);
  data[8] = 1; // unit: meter
  const type = Buffer.from("pHYs", "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(9, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([type, data])) >>> 0, 0);
  const ihdrEnd = 8 + 4 + 4 + 13 + 4; // signature + IHDR (len, type, data, crc)
  return Buffer.concat([png.subarray(0, ihdrEnd), len, type, data, crc, png.subarray(ihdrEnd)]);
}

// PNG buffer QR dari string terenkripsi (ZXing: UTF-8, 500x500), ukuran cetak 3x3 cm
export async function makeQrPng(payload) {
  const png = await QRCode.toBuffer(payload, {
    type: "png",
    errorCorrectionLevel: "M",
    width: QR_SIZE_PX,
    margin: 4,
  });
  return setPngPhysicalSize(png, QR_SIZE_PX, QR_SIZE_CM);
}

// Satu langkah: row -> { plaintext, payload, png }
export async function generateRow(row, privateKey) {
  const plaintext = buildPlaintext(row);
  const payload = encrypt(plaintext, privateKey);
  const png = await makeQrPng(payload);
  return { plaintext, payload, png };
}
