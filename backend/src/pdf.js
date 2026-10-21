'use strict';
/* Minimal PDF writer for reports and controlled agreements (A4, forms, metadata, images). */

function esc(s) {
  return String(s)
    .replace(/[^ -~]/g, '?')          // core fonts: latin-1 printable subset
    .replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

class PdfDoc {
  constructor() {
    this.W = 595.28; this.H = 841.89; // A4 points
    this.pages = [];
    this.y = 0;
    this.newPage();
    this._imgId = 0;
    this.metadata = {};
  }
  setMetadata(metadata = {}) { this.metadata = { ...metadata }; return this; }
  textAt(str, { x = 46, top = 46, size = 10, bold = false, color = [34, 34, 34] } = {}) {
    const y = this.H - top;
    this._op(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${color.map(c => (c / 255).toFixed(3)).join(' ')} rg ${x} ${y.toFixed(1)} Td (${esc(str)}) Tj ET`);
    return this;
  }
  rectAt(x, top, w, h, { stroke = [90, 90, 90], fill = null, lineWidth = 0.7 } = {}) {
    const y = this.H - top - h;
    if (fill) this._op(`${fill.map(c => (c / 255).toFixed(3)).join(' ')} rg ${x} ${y.toFixed(1)} ${w} ${h} re f`);
    this._op(`${lineWidth} w ${stroke.map(c => (c / 255).toFixed(3)).join(' ')} RG ${x} ${y.toFixed(1)} ${w} ${h} re S`);
    return this;
  }
  lineAt(x1, top1, x2, top2, color = [120, 120, 120], lineWidth = 0.7) {
    this._op(`${lineWidth} w ${color.map(c => (c / 255).toFixed(3)).join(' ')} RG ${x1} ${(this.H - top1).toFixed(1)} m ${x2} ${(this.H - top2).toFixed(1)} l S`);
    return this;
  }
  fieldAt(name, x, top, w, h, type = 'Tx') {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(name) || !['Tx', 'Sig'].includes(type)) throw new Error('Invalid PDF form field.');
    this.page.fields.push({ name, x, top, w, h, type });
    return this;
  }
  newPage() {
    this.page = { ops: [], images: {}, fields: [] };
    this.pages.push(this.page);
    this.y = 46;
    return this;
  }
  _op(s) { this.page.ops.push(s); }
  text(str, { x = 46, size = 10, bold = false, color = [34, 34, 34], dy = null } = {}) {
    if (this.y > this.H - 40) this.newPage();
    if (dy == null) dy = size * 1.45;
    const y = this.H - this.y;
    this._op(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${color.map(c => (c / 255).toFixed(3)).join(' ')} rg ${x} ${y.toFixed(1)} Td (${esc(str)}) Tj ET`);
    this.y += dy;
    return this;
  }
  gap(px = 6) { this.y += px; return this; }
  rule() {
    if (this.y > this.H - 40) this.newPage();
    const y = this.H - this.y;
    this._op(`0.5 w 0.80 0.80 0.80 RG 46 ${y.toFixed(1)} m ${this.W - 46} ${y.toFixed(1)} l S`);
    this.y += 10;
    return this;
  }
  cell(text, x, y, w, { size = 8.5, bold = false, invert = false } = {}) {
    const yy = this.H - y;
    if (invert) {
      this._op(`0.122 0.161 0.220 rg ${x} ${(yy - 2).toFixed(1)} ${w} 15 re f`);
    }
    const clip = String(text);
    this._op(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${invert ? '1 1 1' : '0.133 0.133 0.133'} rg ${x + 3} ${(yy + 1).toFixed(1)} Td (${esc(clip.length * size * 0.52 > w - 6 ? clip.slice(0, Math.max(3, Math.floor((w - 8) / (size * 0.52)))) + '…' : clip)}) Tj ET`);
  }
  hline(x1, x2, y) {
    const yy = this.H - y;
    this._op(`0.25 w 0.898 0.906 0.922 RG ${x1} ${yy.toFixed(1)} m ${x2} ${yy.toFixed(1)} l S`);
  }
  image(buffer, width, height, x, y, imgW, imgH) {
    if (this.y > this.H - 40) this.newPage();
    const key = 'img' + (++this._imgId);
    const hex = buffer.toString('hex').toUpperCase();
    const filtered = Buffer.from(hex, 'hex');
    this.page.images[key] = { buffer: filtered, width, height, colorSpace: 'DeviceRGB', bits: 8 };
    const yy = this.H - this.y - (imgH || height);
    this._op(`q ${(imgW || width).toFixed(1)} 0 0 ${(imgH || height).toFixed(1)} ${x.toFixed(1)} ${yy.toFixed(1)} cm /${key} Do Q`);
    this.y += (imgH || height) + 6;
    return this;
  }
  jpegImage(buffer, width, height, x, imgW, imgH, colorSpace = 'DeviceRGB') {
    if (this.y > this.H - 40) this.newPage();
    const key = 'img' + (++this._imgId);
    this.page.images[key] = { buffer: Buffer.from(buffer), width, height, colorSpace, bits: 8, filter: 'DCTDecode' };
    const drawW = imgW || width, drawH = imgH || height;
    const yy = this.H - this.y - drawH;
    this._op(`q ${drawW.toFixed(1)} 0 0 ${drawH.toFixed(1)} ${x.toFixed(1)} ${yy.toFixed(1)} cm /${key} Do Q`);
    this.y += drawH + 6;
    return this;
  }
  buffer() {
    const objects = [];
    const kids = [];
    let id = 4;
    const pageObjs = this.pages.map(() => ++id);
    const contentObjs = this.pages.map(() => ++id);
    const imgObjs = [];
    for (const p of this.pages) { for (const k in p.images) { imgObjs.push({ key: k, data: p.images[k] }); } }
    const imgObjIds = imgObjs.map(() => ++id);
    const fieldObjs = [];
    this.pages.forEach((page, pageIndex) => page.fields.forEach(field => fieldObjs.push({ field, pageIndex, id: ++id })));
    const formId = ++id;
    const infoId = ++id;
    objects[1] = `<< /Type /Catalog /Pages 2 0 R /AcroForm ${formId} 0 R >>`;
    objects[2] = `<< /Type /Pages /Kids [${pageObjs.map(p => `${p} 0 R`).join(' ')}] /Count ${this.pages.length} >>`;
    objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;
    objects[4] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>`;
    imgObjIds.forEach((oid, i) => {
      const im = imgObjs[i].data;
      const filter = im.filter ? ` /Filter /${im.filter}` : '';
      objects[oid] = `<< /Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} /ColorSpace /${im.colorSpace || 'DeviceRGB'} /BitsPerComponent ${im.bits || 8}${filter} /Length ${im.buffer.length} >>\nstream\n${im.buffer.toString('binary')}\nendstream`;
    });
    this.pages.forEach((p, i) => {
      const stream = p.ops.join('\n');
      const resources = `<< /Font << /F1 3 0 R /F2 4 0 R >> ${imgObjs.length ? `/XObject << ${imgObjIds.map((oid, j) => `/${imgObjs[j].key} ${oid} 0 R`).join(' ')} >>` : ''} >>`;
      objects[contentObjs[i]] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
      const annots = fieldObjs.filter(entry => entry.pageIndex === i).map(entry => `${entry.id} 0 R`);
      objects[pageObjs[i]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.W} ${this.H}] /Resources ${resources} ${annots.length ? `/Annots [${annots.join(' ')}]` : ''} /Contents ${contentObjs[i]} 0 R >>`;
    });
    for (const { field, pageIndex, id: fieldId } of fieldObjs) {
      const rect = `${field.x} ${this.H - field.top - field.h} ${field.x + field.w} ${this.H - field.top}`;
      const value = field.type === 'Tx' ? '/V () /DA (/F1 9 Tf 0 g) /Q 0' : '';
      objects[fieldId] = `<< /Type /Annot /Subtype /Widget /FT /${field.type} /T (${esc(field.name)}) /Rect [${rect}] /P ${pageObjs[pageIndex]} 0 R /F 4 /BS << /W 0.7 /S /S >> /MK << /BC [0.35 0.35 0.35] >> ${value} >>`;
    }
    objects[formId] = `<< /Fields [${fieldObjs.map(entry => `${entry.id} 0 R`).join(' ')}] /NeedAppearances true /SigFlags 3 /DA (/F1 9 Tf 0 g) >>`;
    const info = Object.entries(this.metadata).filter(([key, value]) => /^[A-Za-z]+$/.test(key) && value != null)
      .map(([key, value]) => `/${key} (${esc(value)})`).join(' ');
    objects[infoId] = `<< ${info} >>`;
    let out = '%PDF-1.4\n';
    const offsets = [0];
    for (let i = 1; i < objects.length; i++) {
      offsets[i] = Buffer.byteLength(out, 'latin1');
      out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xrefPos = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (let i = 1; i < objects.length; i++) out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
    return Buffer.from(out, 'latin1');
  }
}

module.exports = { PdfDoc };
