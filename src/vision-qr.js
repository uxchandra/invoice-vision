import crypto from "node:crypto";
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
//   dengan ketiga nilai amount diformat 2 desimal (mis. 45000 -> 45000.00).
//   QR dibuat dari string Base64 tersebut (ZXing di aslinya; di sini library qrcode).
// ============================================================================

export const QR_PREFIX = "VISION";

// Validasi panjang key sesuai AES (16/24/32). Spec VISION: 16 digit.
export function validateKey(key) {
  const len = Buffer.byteLength(String(key ?? ""), "utf8");
  return len === 16 || len === 24 || len === 32;
}

// Bersihkan amount: buang pemisah ribuan, pakai nilai apa adanya (tanpa paksa desimal).
// Mengikuti app VISION: 25000000 -> "25000000", 146004755.05 -> "146004755.05".
export function formatAmount(value) {
  const n = Number(String(value).replace(/,/g, "."));
  if (!Number.isFinite(n)) return String(value);
  return String(n);
}

// Susun plaintext persis seperti contoh manual book
export function buildPlaintext(row) {
  return [
    QR_PREFIX,
    row.suppInvNo,
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

// PNG buffer QR dari string terenkripsi (ZXing: UTF-8, 500x500)
export async function makeQrPng(payload) {
  return QRCode.toBuffer(payload, {
    type: "png",
    errorCorrectionLevel: "M",
    width: 500,
    margin: 4,
  });
}

// Satu langkah: row -> { plaintext, payload, png }
export async function generateRow(row, privateKey) {
  const plaintext = buildPlaintext(row);
  const payload = encrypt(plaintext, privateKey);
  const png = await makeQrPng(payload);
  return { plaintext, payload, png };
}
