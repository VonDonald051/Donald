'use strict';
/* Neon segmented ring background (auth pages): a circle of soft dashes with a slow
 * glowing mint arc sweeping around - matches the reference design. */
(function () {
  const cv = document.getElementById('ring');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  const registerShell = document.querySelector('.register-shell');
  let W, H, cx, cy, R, t = 0;
  const SEG = 46;                 // number of dashes
  const TICK = 0.34;              // dash length (radians)
  function resize() {
    W = innerWidth; H = innerHeight;
    cv.width = W * DPR; cv.height = H * DPR;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    if (registerShell) {
      const bounds = registerShell.getBoundingClientRect();
      cx = W / 2;
      cy = H / 2;
      const formRadius = Math.hypot(bounds.width, bounds.height) / 2 + 18;
      R = Math.min(formRadius, Math.min(W, H) * 0.46);
    } else {
      cx = W / 2; cy = H * 0.46;
      R = Math.min(W, H) * 0.42;
    }
  }
  resize();
  addEventListener('resize', resize);

  function angDist(a, b) { let d = Math.abs(a - b) % (Math.PI * 2); return d > Math.PI ? Math.PI * 2 - d : d; }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    t += 0.0035;                       // slow rotation of the whole ring
    const hl = Math.PI * 0.28 + Math.sin(t * 0.6) * 0.9 + t * 0.22; // glowing arc wanders around
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(8, R * 0.045);
    for (let i = 0; i < SEG; i++) {
      const a = t + (i * Math.PI * 2) / SEG;
      const d = angDist(a % (Math.PI * 2), hl % (Math.PI * 2));
      const k = Math.max(0, 1 - d / 0.55);           // glow strength for nearby dashes
      if (k > 0) {
        ctx.strokeStyle = `rgba(${Math.floor(95 + 20 * k)}, ${Math.floor(210 + 40 * k)}, ${Math.floor(205 + 20 * k)}, ${0.55 + 0.45 * k})`;
        ctx.shadowColor = 'rgba(95,242,205,0.9)';
        ctx.shadowBlur = 16 * k;
      } else {
        ctx.strokeStyle = 'rgba(84, 98, 138, 0.42)';
        ctx.shadowBlur = 0;
      }
      ctx.beginPath();
      ctx.arc(cx, cy, R, a, a + TICK);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
})();
