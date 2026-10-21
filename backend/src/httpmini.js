'use strict';
/* Minimal, zero-dependency web framework over node:http.
 * Provides the small Express-like surface this app uses:
 * Router (get/post/put/delete/patch/use), App (use routes & middleware),
 * JSON/multipart/urlencoded body parsing, res.status/json/send/redirect/sendFile,
 * static file serving, :route params, query parsing, error middleware. */
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf', '.csv': 'text/csv; charset=utf-8'
};

function compilePath(p) {
  const keys = [];
  let rx = p.replace(/[.+*?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([A-Za-z0-9_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
  // Make trailing slash optional
  if (rx.endsWith('/')) rx = rx.slice(0, -1) + '/?$';
  return { rx: new RegExp('^' + rx + '$'), keys, src: p };
}

const prefixMatch = (pathname, prefix) =>
  prefix === '/' || pathname === prefix || pathname.startsWith(prefix + '/');

function enhance(req, res) {
  const qIndex = req.url.indexOf('?');
  req.query = Object.fromEntries(new URL('http://h' + req.url).searchParams);
  req.params = {};
  req.body = {};
  req.originalUrl = req.url;
  const xf = req.headers['x-forwarded-for'];
  const forwardedIp = process.env.TRUST_PROXY === '1' && typeof xf === 'string' ? xf.split(',')[0].trim() : '';
  req.ip = forwardedIp || req.socket.remoteAddress || '';
  req.protocol = (req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted) ? 'https' : 'http';

  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (obj) => {
    if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = (body) => {
    if (typeof body === 'object' && !Buffer.isBuffer(body)) return res.json(body);
    if (!res.headersSent && !res.getHeader('Content-Type')) {
      res.setHeader('Content-Type',
        typeof body === 'string' && body.startsWith('<') ? 'text/html; charset=utf-8' : 'application/octet-stream');
    }
    res.end(body);
    return res;
  };
  res.redirect = (target) => {
    res.statusCode = 302;
    res.setHeader('Location', target);
    res.end('Redirecting to ' + target);
  };
  res.sendFile = (file) => {
    res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    fs.createReadStream(file)
      .on('error', () => { if (!res.headersSent) res.statusCode = 404; res.end('Not found'); })
      .pipe(res);
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('request body too large'), { status: 413, type: 'entity.too.large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

class Router {
  constructor() { this.stack = []; }
  use(...fns) {
    for (const fn of fns) {
      if (typeof fn !== 'function') throw new Error('Router middleware must be a function.');
      this.stack.push({ mw: fn });
    }
    return this;
  }
  route(method, p, ...handlers) { this.stack.push({ method, path: p, handlers }); return this; }
  get(p, ...h) { return this.route('GET', p, ...h); }
  post(p, ...h) { return this.route('POST', p, ...h); }
  put(p, ...h) { return this.route('PUT', p, ...h); }
  delete(p, ...h) { return this.route('DELETE', p, ...h); }
  patch(p, ...h) { return this.route('PATCH', p, ...h); }
}

class App {
  constructor() {
    this.mws = [];
    this.routes = [];
    this.errMw = null;
    this.server = http.createServer((q, s) => this._handle(q, s));
  }
  use(a, b) {
    if (typeof a === 'function' && !b) {
      if (a.length === 4) this.errMw = a; else this.mws.push({ prefix: '/', fn: a });
      return this;
    }
    const prefix = (a === '/' ? '/' : String(a).replace(/\/$/, ''));
    if (typeof b === 'function') { this.mws.push({ prefix, fn: b }); return this; }
    if (b instanceof Router) {
      for (const it of b.stack) {
        if (it.mw) this.mws.push({ prefix, fn: it.mw });
        else this.routes.push({ method: it.method, handlers: it.handlers, ...compilePath(prefix === '/' ? it.path : prefix + it.path) });
      }
      return this;
    }
    throw new Error('unsupported use() argument');
  }
  get(p, ...h) { this.routes.push({ method: 'GET', handlers: h, ...compilePath(p) }); return this; }
  post(p, ...h) { this.routes.push({ method: 'POST', handlers: h, ...compilePath(p) }); return this; }
  put(p, ...h) { this.routes.push({ method: 'PUT', handlers: h, ...compilePath(p) }); return this; }
  delete(p, ...h) { this.routes.push({ method: 'DELETE', handlers: h, ...compilePath(p) }); return this; }
  patch(p, ...h) { this.routes.push({ method: 'PATCH', handlers: h, ...compilePath(p) }); return this; }
  listen(port, host, cb) {
    if (typeof host === 'function') return this.server.listen(port, host);
    return this.server.listen(port, host, cb);
  }

  _fail(err, req, res) {
    if (this.errMw) { try { this.errMw(err, req, res, () => {}); } catch (e) { console.error(e); } return; }
    if (!res.headersSent) { res.statusCode = 500; res.end('Internal server error'); }
  }

  async _handle(req, res) {
    enhance(req, res);
    let pathname;
    try { pathname = decodeURIComponent(req.url.split('?')[0]); } catch { pathname = req.url.split('?')[0]; }

    // body parsing (express.json equivalent + raw multipart buffer)
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const ct = String(req.headers['content-type'] || '');
      try {
        if (ct.includes('application/json')) {
          // JSON carries small structured requests plus Owner logo uploads (base64, capped at 2MB).
          const raw = await readBody(req, 3 * 1024 * 1024);
          if (raw.length) {
            try { req.body = JSON.parse(raw.toString('utf8')); }
            catch { res.status(400).json({ error: 'Invalid JSON body' }); return; }
          }
        } else if (ct.includes('multipart/form-data') || /^application\/pdf(?:\s*;|$)/i.test(ct)) {
          req.rawBuffer = await readBody(req, 9 * 1024 * 1024);
          req.contentType = ct;
        } else if (ct.includes('application/x-www-form-urlencoded')) {
          const raw = await readBody(req, 256 * 1024);
          req.body = Object.fromEntries(new URL('http://h/?' + raw.toString('utf8')).searchParams);
        }
      } catch (err) { return this._fail(err, req, res); }
    }

    // find route (exact method + path pattern)
    let matched = null;
    for (const r of this.routes) {
      if (r.method !== req.method) continue;
      if (r.src === pathname) { matched = { r, values: [] }; break; }
      const m = r.rx.exec(pathname);
      if (m) { matched = { r, values: m.slice(1) }; break; }
    }

    const seq = [];
    for (const mw of this.mws) {
      if (!prefixMatch(pathname, mw.prefix)) continue;
      if (mw.prefix === '/') { seq.push(mw.fn); continue; }
      // connect-style mount: strip the prefix while the middleware handles the request
      seq.push((req, res, next) => {
        const origUrl = req.url;
        const cut = pathname.slice(mw.prefix.length);
        const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
        req.url = (cut === '' ? '/' : cut) + qs;
        let restored = false;
        const n2 = (err) => { if (!restored) { restored = true; req.url = origUrl; } next(err); };
        try {
          const out = mw.fn(req, res, n2);
          if (out && typeof out.catch === 'function') out.catch(n2);
        } catch (e) { n2(e); }
      });
    }
    if (matched) {
      matched.r.keys.forEach((k, i) => { req.params[k] = decodeURIComponent(matched.values[i] || ''); });
      seq.push(...matched.r.handlers);
    }

    let i = 0;
    const next = (err) => {
      if (err) return this._fail(err, req, res);
      const fn = seq[i++];
      if (!fn) {
        if (!res.writableEnded && !res.headersSent) {
          const isApi = pathname.startsWith('/api');
          if (isApi) res.status(404).json({ error: 'Not found' });
          else res.status(404).send('Not found');
        }
        return;
      }
      try {
        const out = fn(req, res, next);
        if (out && typeof out.catch === 'function') out.catch(next);
      } catch (e) { next(e); }
    };
    next();
  }
}

function serveStatic(root, opts = {}) {
  const ROOT = path.resolve(root);
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let p;
    try { p = decodeURIComponent(req.url.split('?')[0]); } catch { return next(); }
    if (p.includes('\0')) return res.status(400).end('Bad request');
    const file = path.normalize(path.join(ROOT, p));
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return next();
    fs.stat(file, (e, st) => {
      if (e || !st.isFile()) return next();
      if (path.basename(file).startsWith('.')) { res.statusCode = 404; return res.end('Not found'); }
      res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
      if (opts.maxAge) res.setHeader('Cache-Control', 'public, max-age=' + opts.maxAge);
      res.setHeader('Content-Length', st.size);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  };
}

module.exports = { App, Router, serveStatic, MIME };
