'use strict';
/* Shared API + DOM helpers. All requests carry the X-Requested-With header (CSRF defense). */
const API_BASE_URL = String(window.API_BASE_URL || '').replace(/\/+$/, '');
const api = {
  url(path) {
    if (/^https?:\/\//i.test(path)) return path;
    return API_BASE_URL + (String(path).startsWith('/') ? path : '/' + path);
  },
  async req(method, url, body, isForm) {
    const target = this.url(url);
    const opt = { method, headers: { 'X-Requested-With': 'XMLHttpRequest' }, credentials: 'include' };
    if (isForm) opt.body = body;
    else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const r = await fetch(target, opt);
    let data = null;
    try { data = await r.json(); } catch { /* non-JSON */ }
    if (r.status === 401 && url.startsWith('/api') && !url.startsWith('/api/auth')) { location.href = '/login.html'; throw new Error('Authentication required'); }
    if (r.status === 423) { const e = new Error((data && data.error) || 'Account locked/disabled'); e.status = 423; throw e; }
    if (!r.ok) { const e = new Error((data && data.error) || ('Error ' + r.status)); e.status = r.status; e.code = data && data.code; e.data = data; throw e; }
    return data;
  },
  get(u) { return this.req('GET', u); },
  post(u, b) { return this.req('POST', u, b); },
  put(u, b) { return this.req('PUT', u, b); },
  del(u, b) { return this.req('DELETE', u, b); },
  upload(u, fd) { return this.req('POST', u, fd, true); }
};

function toast(msg, kind) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const t = document.createElement('div');
  t.className = 'toast ' + (kind || 'ok');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}

/* Safe-ish element builder. User data goes through textContent (never innerHTML) unless marked raw=true with trusted markup. */
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of kids) {
    if (c == null) continue;
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return e;
}

const fmtDate = s => (s ? new Date(s).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' }) : '-');
const fmtDue = (s) => {
  if (!s) return '-';
  const due = new Date(s);
  const now = new Date();
  const diff = Math.ceil((due - now) / 86400000);
  const dateStr = due.toLocaleDateString('en-KE', { timeZone: 'Africa/Nairobi', month: 'short', day: 'numeric', year: 'numeric' });
  if (diff < 0) return `${dateStr} (${Math.abs(diff)}d overdue)`;
  if (diff === 0) return `${dateStr} (today)`;
  return `${dateStr} (in ${diff}d)`;
};
const DEFPIC = 'data:image/svg+xml;utf8,' + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='32' fill='#2a3752'/><circle cx='32' cy='25' r='11' fill='#8fa3c8'/><path d='M10 58c3-13 12-18 22-18s19 5 22 18' fill='#8fa3c8'/></svg>");
const pic = (p, cls) => h('img', { src: p || DEFPIC, class: cls || '', alt: 'profile picture', onerror: function () { this.src = DEFPIC; } });
