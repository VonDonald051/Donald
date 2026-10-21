'use strict';
/* Animated dashboard backgrounds:
 *  'stars'       - black sky, moving stars + one moon (Owner)
 *  'stars-only'  - black sky, moving stars (Super Admin and Admin)
 *  'clouds'      - slow moving clouds (Members)
 */
function initBG(kind) {
  const cv = document.getElementById('bg');
  if (!cv) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const ctx = cv.getContext('2d');
  if (!ctx.roundRect) { // Safari < 16 fallback
    ctx.constructor.prototype.roundRect = ctx.constructor.prototype.roundRect || function (x, y, w, h, r) {
      r = Math.min(r || 0, w / 2, h / 2);
      this.moveTo(x + r, y); this.arcTo(x + w, y, x + w, y + h, r); this.arcTo(x + w, y + h, x, y + h, r);
      this.arcTo(x, y + h, x, y, r); this.arcTo(x, y, x + w, y, r); this.closePath();
      return this;
    };
  }
  let W, H, parts = [], t = 0;
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  const resize = () => {
    W = innerWidth; H = innerHeight;
    cv.width = W * DPR; cv.height = H * DPR;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  };
  resize();
  addEventListener('resize', resize);
  const R = (a, b) => a + Math.random() * (b - a);

  if (kind === 'stars' || kind === 'stars-only') {
    for (let i = 0; i < 150; i++) parts.push({ x: R(0, innerWidth), y: R(0, innerHeight), r: R(0.4, 1.7), tw: R(0.5, 2.4), ph: R(0, 7), vy: R(4, 14) });
    const moon = { x: 0.76, y: 0.16, r: 52 };
    const craters = [[-14, -10, 9], [10, 6, 7], [-2, 16, 5], [18, -14, 4], [-20, 14, 3.5]];
    (function loop() {
      ctx.clearRect(0, 0, W, H);
      t += 0.016;
      if (kind === 'stars') {
        const mx = W * moon.x + Math.sin(t * 0.12) * 14, my = H * moon.y + Math.cos(t * 0.09) * 8;
        const halo = ctx.createRadialGradient(mx, my, moon.r * 0.6, mx, my, moon.r * 3.4);
        halo.addColorStop(0, 'rgba(200,214,255,0.22)'); halo.addColorStop(1, 'rgba(200,214,255,0)');
        ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(mx, my, moon.r * 3.4, 0, 7); ctx.fill();
        const mg = ctx.createRadialGradient(mx - 14, my - 14, 6, mx, my, moon.r);
        mg.addColorStop(0, '#f6f2e5'); mg.addColorStop(0.75, '#cfd4e4'); mg.addColorStop(1, '#aab0c6');
        ctx.fillStyle = mg; ctx.beginPath(); ctx.arc(mx, my, moon.r, 0, 7); ctx.fill();
        ctx.fillStyle = 'rgba(148,156,180,0.55)';
        for (const [dx, dy, cr] of craters) { ctx.beginPath(); ctx.arc(mx + dx, my + dy, cr, 0, 7); ctx.fill(); }
      }
      // moving twinkling stars
      for (const s of parts) {
        s.y += s.vy * 0.016; if (s.y > H + 4) { s.y = -4; s.x = R(0, W); }
        const a = 0.35 + 0.65 * Math.abs(Math.sin(t * s.tw + s.ph));
        ctx.fillStyle = `rgba(255,255,255,${a})`;
        ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 7); ctx.fill();
      }
      requestAnimationFrame(loop);
    })();
  }

  if (kind === 'clouds') {
    for (let i = 0; i < 14; i++) parts.push({ x: R(-160, innerWidth), y: R(0, innerHeight), s: R(0.6, 1.7), speed: R(5, 13), opacity: R(0.25, 0.65) });
    (function loop() {
      ctx.clearRect(0, 0, W, H);
      for (const cloud of parts) {
        cloud.x += cloud.speed * 0.016;
        if (cloud.x > W + 180) { cloud.x = -180; cloud.y = R(0, H); }
        const radius = 26 * cloud.s;
        ctx.fillStyle = `rgba(255,255,255,${cloud.opacity})`;
        ctx.beginPath();
        ctx.arc(cloud.x, cloud.y, radius, 0, 7);
        ctx.arc(cloud.x + radius, cloud.y - radius * 0.35, radius * 1.25, 0, 7);
        ctx.arc(cloud.x + radius * 2, cloud.y, radius, 0, 7);
        ctx.fill();
      }
      requestAnimationFrame(loop);
    })();
  }

  if (kind === 'roses') {
    const drawRose = (x, y, s, rot) => {
      ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
      ctx.strokeStyle = 'rgba(46,160,90,0.8)'; ctx.lineWidth = Math.max(1.4, s * 0.07);
      ctx.beginPath(); ctx.moveTo(0, s * 0.5); ctx.quadraticCurveTo(s * 0.12, s * 1.1, 0, s * 1.7); ctx.stroke();
      ctx.fillStyle = 'rgba(46,160,90,0.65)';
      ctx.beginPath(); ctx.ellipse(-s * 0.34, s * 1.05, s * 0.3, s * 0.12, -0.6, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.ellipse(s * 0.3, s * 1.3, s * 0.28, s * 0.11, 0.7, 0, 7); ctx.fill();
      const reds = ['#8f1220', '#c21730', '#ff4457', '#d92a3f'];
      for (let i = 0; i < 22; i++) {
        const a = i * 0.62, r = (i / 22) * s * 0.85;
        ctx.fillStyle = reds[i % 4];
        ctx.beginPath();
        ctx.arc(Math.cos(a) * r, Math.sin(a) * r * 0.92 - s * 0.1, Math.max(1, s * (0.34 - i * 0.009)), 0, 7);
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(120,10,25,0.75)'; ctx.lineWidth = 1;
      for (let k = 1; k <= 3; k++) { ctx.beginPath(); ctx.arc(0, -s * 0.1, s * 0.22 * k, 0.4, Math.PI * 1.5); ctx.stroke(); }
      ctx.restore();
    };
    for (let i = 0; i < 22; i++) parts.push({ x: R(0, innerWidth), y: R(0, innerHeight), s: R(13, 30), rot: R(-0.5, 0.5), vr: R(-0.25, 0.25), vy: R(10, 26), sw: R(0, 7) });
    (function loop() {
      ctx.clearRect(0, 0, W, H); t += 0.016;
      for (const p of parts) {
        p.y -= p.vy * 0.016; p.rot += p.vr * 0.008;
        const x = p.x + Math.sin(t * 0.7 + p.sw) * 26;
        if (p.y < -70) { p.y = H + 60; p.x = R(0, W); }
        drawRose(x, p.y, p.s, p.rot);
      }
      requestAnimationFrame(loop);
    })();
  }

  if (kind === 'money') {
    const DENOMS = [
      { d: '100', c: '#7c3aed', bg: '#efe7fd' },
      { d: '200', c: '#a16207', bg: '#faf3df' },
      { d: '500', c: '#0f766e', bg: '#e0f5f2' },
      { d: '1000', c: '#166534', bg: '#e5f4e8' }
    ];
    const note = (x, y, w, hgt, rot, sp, det) => {
      ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
      ctx.globalAlpha = 0.96;
      ctx.fillStyle = det.bg;
      ctx.beginPath(); ctx.roundRect(-w / 2, -hgt / 2, w, hgt, 7); ctx.fill();
      ctx.strokeStyle = det.c; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.roundRect(-w / 2 + 4, -hgt / 2 + 4, w - 8, hgt - 8, 5); ctx.stroke();
      ctx.strokeStyle = det.c + '99'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(-w / 2 + 9, -hgt / 2 + 9, w - 18, hgt - 18, 4); ctx.stroke();
      ctx.fillStyle = det.c;
      ctx.font = `800 ${hgt * 0.42}px Arial, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(det.d, 0, 1);
      ctx.font = `700 ${hgt * 0.15}px Arial, sans-serif`;
      ctx.fillText('KES', -w / 2 + 20, -hgt / 2 + 14);
      ctx.beginPath(); ctx.ellipse(w / 2 - 20, -hgt / 2 + 13, 8, 6, 0, 0, 7); ctx.stroke();
      ctx.font = `${Math.max(4.5, hgt * 0.1)}px Arial`;
      ctx.fillText('CENTRAL BANK OF KENYA', 0, hgt / 2 - 8);
      ctx.fillText(sp, w / 2 - 26, hgt / 2 - 8);
      ctx.globalAlpha = 1; ctx.restore();
    };
    for (let i = 0; i < 15; i++) {
      const det = DENOMS[i % 4];
      parts.push({ x: R(0, innerWidth), y: R(0, innerHeight), rot: R(-0.5, 0.5), ph: R(0, 7), vx: R(-14, -4), vy: R(9, 22), size: R(0.75, 1.25), det, sn: 'KB' + Math.floor(R(1000000, 9999999)) });
    }
    (function loop() {
      ctx.clearRect(0, 0, W, H); t += 0.016;
      for (const p of parts) {
        p.x += p.vx * 0.016; p.y += p.vy * 0.016;
        const w = 118 * p.size, hgt = 54 * p.size;
        if (p.y - hgt > H || p.x + w < 0) { p.y = R(-140, -60); p.x = R(0, W + 200); }
        const rot = p.rot + Math.sin(t * 0.9 + p.ph) * 0.16;
        note(p.x + Math.sin(t * 0.6 + p.ph) * 18, p.y, w, hgt, rot, p.sn, p.det);
      }
      requestAnimationFrame(loop);
    })();
  }
}
