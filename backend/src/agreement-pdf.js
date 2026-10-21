'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { PdfDoc } = require('./pdf');
const qr = require('./qrcode');
const codes = require('./agreement-codes');
const dbm = require('./db');

const FIELD_NAME = 'member_signature_v1';
const FIELD_POSITION = Object.freeze({ x: 46, top: 672, width: 503, height: 118 });
const TERMS_VERSION = 'chama-terms-v2';
const TERMS = [
  'Membership is governed by the group rules and the applicable laws of Kenya.',
  'Members are responsible for reviewing contribution, loan, repayment, and group decision records.',
  'A loan request is subject to the group approval process and available member savings.',
  'A member must report a repayment and provide any required evidence for verification.',
  'Group financial records are recorded by the system and material corrections must be auditable.',
  'The member confirms that the profile details shown in this agreement are current at signing.'
];
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 2_000_000;

function sealKey() {
  const key = process.env.AGREEMENT_PDF_SEAL_KEY || '';
  if (Buffer.byteLength(key, 'utf8') < 32) throw new Error('Agreement PDF sealing is not configured.');
  return key;
}

function verificationBase() {
  const base = String(process.env.AGREEMENT_VERIFY_BASE_URL || '').replace(/\/$/, '');
  let parsed;
  try { parsed = new URL(base); } catch { throw new Error('Agreement verification URL is not configured.'); }
  const localHttp = process.env.NODE_ENV !== 'production' && parsed.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if ((parsed.protocol !== 'https:' && !localHttp) || parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.pathname.endsWith('/a')) {
    throw new Error('Agreement verification URL must be a clean HTTPS /a URL (loopback HTTP is allowed only outside production).');
  }
  return base;
}

function verificationUrl(code) {
  const url = `${verificationBase()}/${codes.verificationToken(code)}`;
  if (Buffer.byteLength(url, 'utf8') > 53) throw new Error('Agreement verification URL is too long for the current QR generator.');
  return url;
}

function assertConfigured() {
  sealKey();
  const base = verificationBase();
  if (Buffer.byteLength(`${base}/${'A'.repeat(22)}`, 'utf8') > 53) throw new Error('Agreement verification URL is too long for the current QR generator.');
}

function verifyStoredSeal(agreement) {
  if (!agreement || agreement.termsVersion !== TERMS_VERSION || !agreement.pdfGeneratedAt || !agreement.profileSnapshot || !agreement.verificationUrl || !agreement.signatureField) return false;
  const payload = JSON.stringify({
    template: TERMS_VERSION, agreementCode: agreement.agreementCode, generatedAt: agreement.pdfGeneratedAt,
    profile: agreement.profileSnapshot, terms: TERMS, verificationUrl: agreement.verificationUrl,
    signatureField: agreement.signatureField
  });
  const expected = crypto.createHmac('sha256', sealKey()).update(payload).digest();
  let actual;
  try { actual = Buffer.from(agreement.documentSeal, 'hex'); } catch { return false; }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function verifyStoredAcceptanceSeal(agreement) {
  if (!agreement || agreement.acceptanceTermsVersion !== TERMS_VERSION || !agreement.acceptancePdfGeneratedAt
      || !agreement.acceptanceProfileSnapshot || !agreement.acceptanceVerifyUrl || !agreement.acceptanceSignatureField
      || !agreement.acceptance || agreement.acceptance.memberId !== agreement.memberId
      || !agreement.acceptance.acceptedAt || !agreement.acceptance.reference) return false;
  const payload = JSON.stringify({
    template: TERMS_VERSION, agreementCode: agreement.agreementCode,
    generatedAt: agreement.acceptancePdfGeneratedAt, profile: agreement.acceptanceProfileSnapshot,
    terms: TERMS, verificationUrl: agreement.acceptanceVerifyUrl,
    signatureField: agreement.acceptanceSignatureField, acceptance: agreement.acceptance
  });
  const expected = crypto.createHmac('sha256', sealKey()).update(payload).digest();
  let actual;
  try { actual = Buffer.from(agreement.acceptanceSeal, 'hex'); } catch { return false; }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function safePhotoPath(pic) {
  if (typeof pic !== 'string' || !pic.startsWith('/uploads/')) return null;
  const name = path.basename(pic);
  const file = path.join(__dirname, '..', '..', 'database', 'uploads', name);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_IMAGE_BYTES) return null;
    return file;
  } catch { return null; }
}

function jpegInfo(data) {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) throw new Error('Invalid JPEG profile photo.');
  let i = 2;
  while (i + 4 < data.length) {
    if (data[i] !== 0xff) { i++; continue; }
    while (data[i] === 0xff) i++;
    const marker = data[i++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (i + 2 > data.length) break;
    const length = data.readUInt16BE(i);
    if (length < 2 || i + length > data.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      const height = data.readUInt16BE(i + 3), width = data.readUInt16BE(i + 5), components = data[i + 7];
      if (!width || !height || width * height > MAX_IMAGE_PIXELS || ![1, 3, 4].includes(components)) throw new Error('Unsupported JPEG profile photo dimensions or color space.');
      return { width, height, colorSpace: components === 1 ? 'DeviceGray' : components === 4 ? 'DeviceCMYK' : 'DeviceRGB' };
    }
    i += length;
  }
  throw new Error('JPEG profile photo dimensions could not be read.');
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePng(data) {
  if (data.length < 33 || data.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new Error('Invalid PNG profile photo.');
  let width, height, depth, colorType, interlace, palette = null, transparency = null;
  const chunks = [];
  for (let i = 8; i + 12 <= data.length;) {
    const length = data.readUInt32BE(i), kind = data.toString('ascii', i + 4, i + 8);
    if (i + 12 + length > data.length) throw new Error('Truncated PNG profile photo.');
    const value = data.subarray(i + 8, i + 8 + length);
    if (kind === 'IHDR') { width = value.readUInt32BE(0); height = value.readUInt32BE(4); depth = value[8]; colorType = value[9]; interlace = value[12]; }
    if (kind === 'IDAT') chunks.push(value);
    if (kind === 'PLTE') palette = Buffer.from(value);
    if (kind === 'tRNS') transparency = Buffer.from(value);
    if (kind === 'IEND') break;
    i += 12 + length;
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 })[colorType];
  if (!width || !height || width * height > MAX_IMAGE_PIXELS || depth !== 8 || !channels || interlace !== 0 || (colorType === 3 && (!palette || palette.length % 3 || palette.length > 768))) throw new Error('Unsupported PNG profile photo encoding.');
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(chunks));
  if (raw.length !== (stride + 1) * height) throw new Error('PNG profile photo data is invalid.');
  const decoded = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], rowStart = y * stride, srcStart = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const value = raw[srcStart + x], left = x >= channels ? decoded[rowStart + x - channels] : 0;
      const above = y ? decoded[rowStart - stride + x] : 0, upperLeft = y && x >= channels ? decoded[rowStart - stride + x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = above;
      else if (filter === 3) predictor = Math.floor((left + above) / 2);
      else if (filter === 4) predictor = paeth(left, above, upperLeft);
      else if (filter !== 0) throw new Error('Unsupported PNG filter.');
      decoded[rowStart + x] = (value + predictor) & 0xff;
    }
  }
  const rgb = Buffer.alloc(width * height * 3);
  for (let p = 0, q = 0; p < width * height; p++, q += channels) {
    if (colorType === 0) rgb[p * 3] = rgb[p * 3 + 1] = rgb[p * 3 + 2] = decoded[q];
    else if (colorType === 2) decoded.copy(rgb, p * 3, q, q + 3);
    else if (colorType === 3) {
      const index = decoded[q], paletteOffset = index * 3;
      if (paletteOffset + 2 >= palette.length) throw new Error('PNG palette index is invalid.');
      const alpha = transparency && index < transparency.length ? transparency[index] : 255;
      for (let c = 0; c < 3; c++) rgb[p * 3 + c] = Math.round((palette[paletteOffset + c] * alpha + 255 * (255 - alpha)) / 255);
    }
    else if (colorType === 4) {
      const gray = decoded[q], alpha = decoded[q + 1];
      rgb[p * 3] = rgb[p * 3 + 1] = rgb[p * 3 + 2] = Math.round((gray * alpha + 255 * (255 - alpha)) / 255);
    } else {
      const alpha = decoded[q + 3];
      for (let c = 0; c < 3; c++) rgb[p * 3 + c] = Math.round((decoded[q + c] * alpha + 255 * (255 - alpha)) / 255);
    }
  }
  return { width, height, rgb };
}

function addPhoto(doc, member) {
  const file = safePhotoPath(member.pic);
  if (!file) throw new Error('A current profile photo is required to generate the agreement.');
  const data = fs.readFileSync(file);
  const photoHash = crypto.createHash('sha256').update(data).digest('hex');
  const dimensions = data[0] === 0xff && data[1] === 0xd8 ? jpegInfo(data) : null;
  if (dimensions) doc.jpegImage(data, dimensions.width, dimensions.height, 487, 62, 62, dimensions.colorSpace);
  else {
    if (data.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new Error('Agreement profile photos must be JPEG or supported PNG.');
    const decoded = decodePng(data);
    doc.image(decoded.rgb, decoded.width, decoded.height, 487, 0, 62, 62);
  }
  return photoHash;
}

function wrap(text, max = 92) {
  const words = String(text).split(/\s+/), lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > max && line) { lines.push(line); line = word; }
    else line = candidate;
  }
  if (line) lines.push(line);
  return lines;
}

function create(agreement, member, profile, group, generatedDate = new Date(), acceptance = null) {
  if (!agreement || agreement.status !== 'PENDING' || Date.parse(agreement.expiresAt) <= Date.now()) throw new Error('Only an active pending agreement can be generated.');
  const generatedAt = generatedDate.toISOString();
  const verifyUrl = verificationUrl(agreement.agreementCode);
  const doc = new PdfDoc();
  doc.text('VonDonald Savings', { size: 18, bold: true, dy: 25 });
  doc.text('Member Agreement', { size: 14, bold: true, color: [65, 65, 65], dy: 20 });
  doc.text(`Generated (UTC): ${generatedAt}`, { size: 8.5, color: [95, 95, 95], dy: 15 });
  doc.rule();
  doc.text('Member details', { size: 11, bold: true, dy: 17 });
  const fullName = `${member.firstName} ${member.lastName}`;
  const fields = [
    `Name: ${fullName}`,
    `Member ID: ${member.id}`,
    `Email: ${member.email}`,
    `Phone: ${member.phone || 'Not provided'}`,
    `Group: ${group.name}`
  ];
  for (const field of fields) doc.text(field, { size: 9, dy: 13 });
  const photoHash = addPhoto(doc, member);
  doc.gap(3);
  doc.text('Terms', { size: 11, bold: true, dy: 16 });
  for (let i = 0; i < TERMS.length; i++) {
    const lines = wrap(`${i + 1}. ${TERMS[i]}`);
    for (const line of lines) doc.text(line, { size: 8.5, dy: 12 });
  }
  doc.gap(2);
  doc.text('Verify this agreement by scanning the QR code. Verification displays status and dates only.', { size: 8, color: [75, 75, 75], dy: 12 });
  const qrImage = qr.renderQR(verifyUrl, 2);
  doc.image(qrImage.buffer, qrImage.width, qrImage.height, 487, 0, 50, 50);
  if (doc.pages.length !== 1 || doc.y > FIELD_POSITION.top - 10) throw new Error('Agreement template content exceeded its fixed one-page layout.');

  const snapshot = {
    memberId: member.id, name: fullName, email: member.email, phone: member.phone || '',
    groupId: group.id, groupName: group.name, photoHash
  };
  const signatureField = acceptance
    ? { type: 'electronic_acceptance', name: 'system_acceptance_v1', position: FIELD_POSITION }
    : { name: FIELD_NAME, position: FIELD_POSITION };
  const sealData = {
    template: TERMS_VERSION, agreementCode: agreement.agreementCode, generatedAt,
    profile: snapshot, terms: TERMS, verificationUrl: verifyUrl,
    signatureField
  };
  if (acceptance) sealData.acceptance = acceptance;
  const sealPayload = JSON.stringify(sealData);
  const seal = crypto.createHmac('sha256', sealKey()).update(sealPayload).digest('hex');
  doc.setMetadata({
    Title: acceptance ? 'Electronically accepted member agreement' : 'System-generated member agreement',
    Subject: agreement.agreementCode,
    Keywords: `VonDonald-HMAC-SHA256:${seal};AgreementCode:${agreement.agreementCode}`,
    Creator: 'VonDonald Savings System', Producer: 'VonDonald controlled agreement template'
  });

  // Fixed header and footer are appended after layout so every generated page carries the code.
  for (let index = 0; index < doc.pages.length; index++) {
    doc.page = doc.pages[index];
    doc.textAt(`Agreement code: ${agreement.agreementCode}`, { x: 46, top: 25, size: 8, bold: true, color: [65, 65, 65] });
    doc.lineAt(46, 33, 549, 33, [210, 210, 210], 0.5);
    doc.textAt(`Agreement code: ${agreement.agreementCode}`, { x: 46, top: 817, size: 7.5, color: [90, 90, 90] });
    doc.textAt(`Page ${index + 1} of ${doc.pages.length}`, { x: 490, top: 817, size: 7.5, color: [90, 90, 90] });
  }
  doc.page = doc.pages[doc.pages.length - 1];
  doc.rectAt(FIELD_POSITION.x, FIELD_POSITION.top, FIELD_POSITION.width, FIELD_POSITION.height, { stroke: [105, 105, 105] });
  if (acceptance) {
    doc.textAt('Electronically accepted', { x: 57, top: 695, size: 10, bold: true });
    doc.textAt(`Accepted by: ${snapshot.name}`, { x: 57, top: 720, size: 9 });
    doc.textAt(`Accepted (UTC): ${acceptance.acceptedAt}`, { x: 57, top: 741, size: 9 });
    doc.textAt(`Acceptance reference: ${acceptance.reference}`, { x: 57, top: 762, size: 8.5 });
    doc.textAt('Recorded by the VonDonald Savings system', { x: 57, top: 781, size: 8, color: [75, 75, 75] });
  } else {
    doc.textAt(`Signature field: ${FIELD_NAME}`, { x: FIELD_POSITION.x, top: 661, size: 7.5, color: [85, 85, 85] });
    doc.textAt('Name', { x: 57, top: 695, size: 9, bold: true });
    doc.lineAt(105, 697, 528, 697);
    doc.fieldAt('member_name_v1', 105, 684, 423, 25, 'Tx');
    doc.textAt('Signature', { x: 57, top: 735, size: 9, bold: true });
    doc.lineAt(115, 737, 528, 737);
    doc.fieldAt(FIELD_NAME, 115, 724, 413, 25, 'Sig');
    doc.textAt('Date', { x: 57, top: 775, size: 9, bold: true });
    doc.lineAt(88, 777, 528, 777);
    doc.fieldAt('member_date_v1', 88, 764, 440, 25, 'Tx');
  }

  const buffer = doc.buffer();
  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
  return {
    buffer, fileHash, seal, generatedAt, verifyUrl,
    profileSnapshot: snapshot, termsVersion: TERMS_VERSION,
    signatureField,
    sealPayload
  };
}

module.exports = { create, assertConfigured, verifyStoredSeal, verifyStoredAcceptanceSeal, FIELD_NAME, FIELD_POSITION, TERMS_VERSION, TERMS };
