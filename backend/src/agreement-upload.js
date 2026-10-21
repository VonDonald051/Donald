'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const storage = require('./agreement-storage');
const pdf = require('./agreement-pdf');

const MAX_PDF_BYTES = 8 * 1024 * 1024;
const ACTIVE_CONTENT = /\/(?:JavaScript|JS|Launch|EmbeddedFiles|RichMedia|OpenAction|AA)\b/;

function hash(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

function command(bin, args, timeout = 15000) {
  return execFileSync(bin, args, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

function scanPdf(buffer) {
  const scanner = process.env.AGREEMENT_CLAMSCAN_BIN || 'clamscan';
  const temp = path.join(os.tmpdir(), `agreement-scan-${crypto.randomUUID()}.pdf`);
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, buffer); fs.fsyncSync(fd); fs.closeSync(fd);
    try {
      command(scanner, ['--no-summary', '--', temp], 30000);
    } catch (error) {
      if (error.code === 1) throw Object.assign(new Error('The uploaded PDF was identified as unsafe.'), { publicStatus: 400, publicCode: 'malware_detected' });
      throw Object.assign(new Error('Agreement malware scanning is unavailable.'), { publicStatus: 503, publicCode: 'scanner_unavailable' });
    }
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temp); } catch {}
  }
}

// Retained for callers that explicitly require certificate-based signing. The
// member upload flow uses the handwritten ink and QR verification below.
function validateSignature(buffer, original) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12 || buffer.length > MAX_PDF_BYTES) throw Object.assign(new Error('PDF must be at most 4 MB.'), { publicStatus: 413, publicCode: 'size_limit' });
  if (buffer.subarray(0, 5).toString('ascii') !== '%PDF-' || !buffer.subarray(-2048).includes(Buffer.from('%%EOF'))) {
    throw Object.assign(new Error('Upload is not a complete PDF.'), { publicStatus: 400, publicCode: 'invalid_pdf' });
  }
  if (!original || buffer.length <= original.length || !buffer.subarray(0, original.length).equals(original)) {
    throw Object.assign(new Error('The generated agreement body was changed or replaced.'), { publicStatus: 400, publicCode: 'document_changed' });
  }
  const text = buffer.toString('latin1');
  if (ACTIVE_CONTENT.test(text)) throw Object.assign(new Error('PDF active content is not accepted.'), { publicStatus: 400, publicCode: 'active_content' });
  const temp = path.join(os.tmpdir(), `agreement-signature-${crypto.randomUUID()}.pdf`);
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, buffer); fs.fsyncSync(fd); fs.closeSync(fd);
    let result;
    try { result = command(process.env.PDFSIG_BIN || 'pdfsig', [temp]); }
    catch { throw Object.assign(new Error('A valid cryptographic PDF signature is required.'), { publicStatus: 400, publicCode: 'signature_invalid' }); }
    const fieldOk = result.includes(`Signature Field Name: ${pdf.FIELD_NAME}`);
    const signatureValid = /Signature Validation:\s*Signature is Valid\.?\s*(?:\r?\n|$)/m.test(result);
    const fullDocument = /Total document signed\s*$/m.test(result);
    if (!fieldOk || !signatureValid || !fullDocument) throw Object.assign(new Error('The agreement signature field must contain a valid signature covering the signed document.'), { publicStatus: 400, publicCode: 'signature_missing_or_invalid' });
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(temp); } catch {}
  }
}

function writePrivateTemp(dir, name, data) {
  const target = path.join(dir, name);
  const fd = fs.openSync(target, 'wx', 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return target;
}

function pgmToken(buffer, state) {
  for (;;) {
    while (state.offset < buffer.length && /\s/.test(String.fromCharCode(buffer[state.offset]))) state.offset++;
    if (buffer[state.offset] !== 0x23) break;
    while (state.offset < buffer.length && buffer[state.offset] !== 0x0a) state.offset++;
  }
  const start = state.offset;
  while (state.offset < buffer.length && !/\s/.test(String.fromCharCode(buffer[state.offset]))) state.offset++;
  if (start === state.offset) throw new Error('Invalid rendered agreement image.');
  return buffer.toString('ascii', start, state.offset);
}

function decodePgm(buffer) {
  const state = { offset: 0 };
  if (pgmToken(buffer, state) !== 'P5') throw new Error('Unsupported rendered agreement image.');
  const width = Number(pgmToken(buffer, state)), height = Number(pgmToken(buffer, state)), max = Number(pgmToken(buffer, state));
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 100 || height < 100 || max !== 255) throw new Error('Invalid rendered agreement image.');
  if (buffer[state.offset] === 0x0d && buffer[state.offset + 1] === 0x0a) state.offset += 2;
  else if (/\s/.test(String.fromCharCode(buffer[state.offset]))) state.offset++;
  const pixels = buffer.subarray(state.offset);
  if (pixels.length !== width * height) throw new Error('Truncated rendered agreement image.');
  return { width, height, pixels };
}

function renderFirstPage(buffer, dir, name) {
  const input = writePrivateTemp(dir, `${name}.pdf`, buffer);
  let info;
  try { info = command(process.env.PDFINFO_BIN || 'pdfinfo', [input]); }
  catch { throw Object.assign(new Error('PDF inspection tools are unavailable.'), { publicStatus: 503, publicCode: 'pdf_tools_unavailable' }); }
  const pages = /^Pages:\s+(\d+)\s*$/mi.exec(info);
  if (!pages || Number(pages[1]) !== 1) throw Object.assign(new Error('Upload one upright, single-page agreement scan.'), { publicStatus: 400, publicCode: 'page_count_invalid' });
  const prefix = path.join(dir, name);
  try { command(process.env.PDFTOPPM_BIN || 'pdftoppm', ['-f', '1', '-l', '1', '-r', '120', '-gray', '-singlefile', input, prefix], 30000); }
  catch { throw Object.assign(new Error('PDF page rendering is unavailable.'), { publicStatus: 503, publicCode: 'pdf_render_unavailable' }); }
  try {
    const image = decodePgm(fs.readFileSync(`${prefix}.pgm`));
    if (Math.abs(image.width / image.height - 595.28 / 841.89) > 0.035) {
      throw Object.assign(new Error('Agreement scans must be upright A4 pages.'), { publicStatus: 400, publicCode: 'page_size_invalid' });
    }
    return image;
  }
  catch (error) {
    if (error.publicCode) throw error;
    throw Object.assign(new Error('The uploaded PDF page could not be rendered.'), { publicStatus: 400, publicCode: 'pdf_render_invalid' });
  }
}

function signatureInkCount(image) {
  const { width, height, pixels } = image;
  const x0 = Math.floor(width * 115 / 595.28), x1 = Math.ceil(width * 528 / 595.28);
  const y0 = Math.floor(height * 724 / 841.89), y1 = Math.ceil(height * 749 / 841.89);
  const baseline = Math.round(height * 737 / 841.89), clearLine = Math.ceil(height * 2.3 / 841.89);
  let ink = 0;
  for (let y = y0; y < y1; y++) {
    if (Math.abs(y - baseline) <= clearLine) continue;
    for (let x = x0; x < x1; x++) if (pixels[y * width + x] < 155) ink++;
  }
  return ink;
}

function requireHandwrittenMark(image) {
  if (signatureInkCount(image) < 12) {
    throw Object.assign(new Error('The handwritten signature area is empty. Sign inside the marked field before uploading.'), { publicStatus: 400, publicCode: 'signature_missing' });
  }
}

function verifyScanIdentity(imagePath, agreement) {
  const scanner = process.env.AGREEMENT_QRSCAN_BIN || 'zbarimg';
  let decoded;
  try { decoded = command(scanner, ['--quiet', '--raw', imagePath], 15000).trim().split(/\r?\n/).filter(Boolean); }
  catch (error) {
    if (Number.isInteger(error.status)) throw Object.assign(new Error('The agreement QR code could not be read. Keep it visible and scan the full page.'), { publicStatus: 400, publicCode: 'agreement_qr_missing' });
    throw Object.assign(new Error('Agreement QR scanning is unavailable.'), { publicStatus: 503, publicCode: 'qr_scanner_unavailable' });
  }
  if (decoded.length !== 1 || decoded[0] !== agreement.verificationUrl) {
    throw Object.assign(new Error('This scan does not contain the QR code for your current system-generated agreement.'), { publicStatus: 400, publicCode: 'agreement_qr_mismatch' });
  }
}

function inspect(buffer, original, agreement) {
  if (hash(original) !== agreement.fileHash) throw Object.assign(new Error('The stored system agreement is unavailable or has changed.'), { publicStatus: 503, publicCode: 'original_unavailable' });
  if (!pdf.verifyStoredSeal(agreement)) throw Object.assign(new Error('The stored system agreement seal is invalid.'), { publicStatus: 503, publicCode: 'seal_invalid' });
  if (!Buffer.isBuffer(buffer) || buffer.length < 12 || buffer.length > MAX_PDF_BYTES) throw Object.assign(new Error('PDF must be at most 4 MB.'), { publicStatus: 413, publicCode: 'size_limit' });
  if (buffer.subarray(0, 5).toString('ascii') !== '%PDF-' || !buffer.subarray(-2048).includes(Buffer.from('%%EOF'))) {
    throw Object.assign(new Error('Upload is not a complete PDF.'), { publicStatus: 400, publicCode: 'invalid_pdf' });
  }
  const text = buffer.toString('latin1');
  if (ACTIVE_CONTENT.test(text)) throw Object.assign(new Error('PDF active content is not accepted.'), { publicStatus: 400, publicCode: 'active_content' });
  scanPdf(buffer);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agreement-upload-'));
  try {
    const uploadedImage = renderFirstPage(buffer, dir, 'uploaded');
    requireHandwrittenMark(uploadedImage);
    if (buffer.length > original.length || !buffer.subarray(0, original.length).equals(original)) {
      const qrImagePath = path.join(dir, 'uploaded.pgm');
      verifyScanIdentity(qrImagePath, agreement);
    } else if (!text.includes(`/Subject (${agreement.agreementCode})`) || !text.includes(`VonDonald-HMAC-SHA256:${agreement.documentSeal}`)) {
      throw Object.assign(new Error('The system-generated agreement code or seal is missing.'), { publicStatus: 400, publicCode: 'seal_invalid' });
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  return hash(buffer);
}

module.exports = { MAX_PDF_BYTES, hash, inspect, validateSignature };
