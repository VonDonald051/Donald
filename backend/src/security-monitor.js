'use strict';

const emailer = require('./emailer');
const sentinel = require('./sentinel');

const WINDOW_MS = 15 * 60 * 1000;
const THRESHOLD = 4;
const failuresByIp = new Map();
let started = false;

function aiConfigured() {
  return !!process.env.AI_API_KEY && !!process.env.AI_API_URL;
}

async function aiAnalyze(detail) {
  if (!aiConfigured()) return null;
  try {
    const url = new URL(process.env.AI_API_URL);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.AI_API_KEY}` },
      body: JSON.stringify({
        model: process.env.AI_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a security analyst. Analyze this login burst alert and return a concise severity assessment (LOW/MEDIUM/HIGH) and a one-sentence recommendation. Format: "Severity: X\nRecommendation: Y"' },
          { role: 'user', content: detail }
        ],
        max_tokens: 120
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error(`AI API HTTP ${response.status}`);
    const json = await response.json();
    const text = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    return String(text || '').trim();
  } catch (error) {
    console.error('[security alert] AI analysis failed:', error.message);
    return null;
  }
}

function start() {
  if (started) return;
  started = true;
  const cleanup = setInterval(() => {
    const cutoff = Date.now() - WINDOW_MS;
    for (const [ip, times] of failuresByIp) {
      const recent = times.filter(time => time > cutoff);
      if (recent.length) failuresByIp.set(ip, recent);
      else failuresByIp.delete(ip);
    }
  }, 60 * 1000);
  cleanup.unref();
  console.log(`[security-monitor] Rule monitor armed: ${THRESHOLD} failed logins per IP / 15m; ${emailer.mode()}.`);
  if (aiConfigured()) {
    console.log(`[security-monitor] AI alerting is enabled (${process.env.AI_API_URL || 'custom endpoint'}).`);
  } else {
    console.log('[security-monitor] No AI provider is configured; alerts use deterministic security rules.');
  }
}

async function recordFailedLogin(req, email, accountLocked = false) {
  const ip = String(req && req.ip || 'unknown');
  const cutoff = Date.now() - WINDOW_MS;
  const attempts = (failuresByIp.get(ip) || []).filter(time => time > cutoff);
  attempts.push(Date.now());
  failuresByIp.set(ip, attempts);

  const alertNumber = Math.floor(attempts.length / THRESHOLD);
  const lastAlertNumber = Math.floor((attempts.length - 1) / THRESHOLD);
  if (attempts.length < THRESHOLD || alertNumber <= lastAlertNumber) return attempts.length;

  let detail = `At least ${attempts.length} failed login attempts came from IP ${ip} within 15 minutes. Latest account identifier: ${String(email || 'unknown').slice(0, 120)}.${accountLocked ? ' The account was locked after four failed passwords.' : ''}`;
  try { sentinel.emit('login_burst', req, detail); } catch {}
  if (aiConfigured()) {
    const aiResult = await aiAnalyze(detail);
    if (aiResult) detail = `${detail}\n\nAI analysis:\n${aiResult}`;
  }
  emailer.securityAlert('Repeated failed logins from one IP', detail).catch(error => {
    console.error('[security alert] Admin alert delivery failed:', error.message);
  });
  return attempts.length;
}

module.exports = { start, recordFailedLogin, WINDOW_MS, THRESHOLD, aiConfigured };