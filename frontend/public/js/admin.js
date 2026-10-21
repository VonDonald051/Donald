'use strict';
document.addEventListener('DOMContentLoaded', async () => {
  initBG('stars-only');
  const { me } = await api.get('/api/me');
  const badge = (text, cls) => h('span', { class: 'badge ' + cls }, text);

  async function loadAgreements() {
    const { agreements } = await api.get('/api/admin/system-agreements');
    const table = document.getElementById('agreements-table');
    table.replaceChildren(h('tr', {}, h('th', {}, 'Agreement code'), h('th', {}, 'Status'), h('th', {}, 'Group'), h('th', {}, 'Issued'), h('th', {}, 'Expires'), h('th', {}, 'Signed')));
    for (const item of agreements || []) table.append(h('tr', {},
      h('td', {}, item.agreementCode || '-'),
      h('td', {}, badge(item.status, item.status === 'SIGNED' ? 'ok' : item.status === 'PENDING' ? 'warn' : 'muted')),
      h('td', {}, item.groupName || '-'), h('td', {}, fmtDate(item.createdAt)),
      h('td', {}, fmtDate(item.expiresAt)), h('td', {}, item.signedAt ? fmtDate(item.signedAt) : '-')));
    if (!agreements || !agreements.length) table.append(h('tr', {}, h('td', { colspan: '6', class: 'muted' }, 'No agreement records.')));
  }

  async function loadAudit() {
    const { entries } = await api.get('/api/admin/audit');
    const table = document.getElementById('audit-table');
    table.replaceChildren(h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'Actor'), h('th', {}, 'Role'), h('th', {}, 'Action'), h('th', {}, 'IP'), h('th', {}, 'Integrity hash')));
    for (const entry of entries || []) table.append(h('tr', {},
      h('td', {}, fmtDate(entry.at)), h('td', {}, entry.actor == null ? 'System' : String(entry.actor)),
      h('td', {}, entry.actorRole || '-'), h('td', {}, entry.action || '-'),
      h('td', {}, entry.ip || '-'), h('td', {}, h('code', { title: entry.prevHash || '' }, String(entry.hash || '').slice(0, 16) + '…'))));
    if (!entries || !entries.length) table.append(h('tr', {}, h('td', { colspan: '6', class: 'muted' }, 'No audit entries.')));
  }

  let currentBranding = { name: 'Chama Savings', logo: null, colors: null };
  try { const { branding } = await api.get('/api/auth/branding'); if (branding) currentBranding = branding; } catch {}
  let chatStarted = false;
  DASH.buildChrome(me, currentBranding.name + ' · ADMIN', [
    ['agreements', '📄', 'Agreements'], ['audit', '◷', 'Audit Log'],
    ['chat', '✉', 'Administrative Chat'], ['member-account', '👤', 'My Member Account'], ['profile', '◉', 'My Profile']
  ], id => {
    if (id === 'agreements') loadAgreements().catch(error => toast(error.message, 'err'));
    if (id === 'audit') loadAudit().catch(error => toast(error.message, 'err'));
    if (id === 'chat' && !chatStarted) { chatStarted = true; CHAT.init(me); }
    if (id === 'member-account') location.href = '/app/member';
  }, currentBranding);
  DASH.wireProfile(me);
  try { await loadAgreements(); } catch (error) { toast(error.message, 'err'); }
});
