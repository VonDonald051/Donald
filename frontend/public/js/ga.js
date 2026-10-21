'use strict';
document.addEventListener('DOMContentLoaded', async () => {
  initBG('none');
  const { me } = await api.get('/api/me');
  const loaders = {};
  const stat = (n, c) => h('div', { class: 'card stat' }, h('div', { class: 'num' }, String(n)), h('div', { class: 'cap' }, c));
  const badge = (t, k) => h('span', { class: 'badge ' + k }, t);

  loaders.ov = async () => {
    const o = await api.get('/api/ga/overview');
    const s = document.getElementById('ov-stats');
    s.innerHTML = '';
    s.append(stat(o.members, 'Members'), stat(o.codesLeft, 'Safe codes left'), stat(o.codesUsed, 'Codes used'),
      stat(o.pendingRequests, 'Pending requests'), stat(o.lockedMembers, 'Locked members'),
      stat(o.messages, 'Chat messages'), stat(o.safeCodeRequired ? 'ON' : 'OFF', 'Safe-code gate'), stat('🔒', 'E2E chat'));
    const g = document.getElementById('ov-group');
    g.innerHTML = '';
    if (o.group) {
      g.append(h('h3', { class: 'mb' }, o.group.name),
        h('div', { class: 'muted' }, o.group.description || ''),
        h('div', { class: 'small muted mt' }, 'Group ID #' + o.group.id),
        h('div', { class: 'kv mt' },
          h('div', { class: 'k' }, 'Group total savings'), h('div', {}, 'KES ' + (o.totalGroupSavingsCents / 100).toFixed(2))));
    } else g.append(h('div', { class: 'muted' }, '⚠ You are not assigned to a group yet — ask the V Super Admin to assign you.'));
  };

  loaders.finance = async () => {
    const updated = document.getElementById('ga-finance-updated');
    try {
      const data = await api.get('/api/ga/finance-trend');
      const summary = data.summary || {};
      document.getElementById('ga-finance-stats').replaceChildren(
        stat(String(summary.members || 0), 'Group members'),
        stat(FinanceChart.kes(summary.verifiedSavingsCents), 'Verified member savings'),
        stat(FinanceChart.kes(summary.pendingSavingsCents), 'Savings awaiting verification'),
        stat(FinanceChart.kes(summary.activeLoanCents), `Outstanding member loans · ${summary.activeLoans || 0} active`));
      FinanceChart.render(document.getElementById('ga-finance-chart'), data.labels, [
        { name: 'Verified member savings', values: data.series.savingsCents, color: '#35cb83' },
        { name: 'Outstanding member loans', values: data.series.loanOutstandingCents, color: '#ff7884' }
      ]);
      updated.textContent = 'Updated ' + new Date(data.updatedAt).toLocaleTimeString('en-KE');
    } catch (error) {
      updated.textContent = 'Summary temporarily unavailable';
    }
  };

  loaders.members = async () => {
    const { agreements } = await api.get('/api/ga/system-agreements');
    const tbl = document.getElementById('ga-agreements-tbl');
    tbl.replaceChildren(h('tr', {}, h('th', {}, 'Agreement code'), h('th', {}, 'Status'), h('th', {}, 'Group'), h('th', {}, 'Issued'), h('th', {}, 'Expires'), h('th', {}, 'Signed')));
    for (const agreement of agreements || []) tbl.append(h('tr', {},
      h('td', {}, agreement.agreementCode || '-'), h('td', {}, badge(agreement.status, agreement.status === 'SIGNED' ? 'ok' : agreement.status === 'PENDING' ? 'warn' : 'muted')),
      h('td', {}, agreement.groupName || '-'), h('td', {}, fmtDate(agreement.createdAt)), h('td', {}, fmtDate(agreement.expiresAt)), h('td', {}, agreement.signedAt ? fmtDate(agreement.signedAt) : '-')));
    if (!agreements || !agreements.length) tbl.append(h('tr', {}, h('td', { colspan: '6', class: 'muted' }, 'No agreement records.')));
  };

  loaders.loans = async () => {
    const [items, data] = await Promise.all([api.get('/api/ga/items'), api.get('/api/ga/loans')]);
    const it = document.getElementById('items-tbl'); it.innerHTML = '';
    it.append(h('tr', {}, h('th', {}, 'Item'), h('th', {}, 'Category'), h('th', {}, 'Description'), h('th', {}, 'Price'), h('th', {}, 'Added')));
    items.items.forEach(x => {
      it.append(h('tr', {}, h('td', {}, x.name), h('td', {}, x.category || 'Weekly item'), h('td', {}, x.description), h('td', {}, 'KES ' + ((x.priceCents || 0) / 100).toFixed(2)), h('td', {}, fmtDate(x.createdAt))));
    });
    const ownItem = document.getElementById('ga-loan-item'); ownItem.innerHTML = ''; items.items.forEach(x => ownItem.append(h('option', { value: x.id }, `${x.name} · ${x.category || 'Weekly item'} · KES ${(x.priceCents / 100).toFixed(2)}`)));
    const tbl = document.getElementById('loans-tbl'); tbl.innerHTML = ''; tbl.append(h('tr', {}, h('th', {}, 'Loan ID'), h('th', {}, 'Type'), h('th', {}, 'Amount'), h('th', {}, 'Due'), h('th', {}, 'Fine'), h('th', {}, 'Status'), h('th', {}, 'Action')));
    data.loans.forEach(l => {
      const amount = l.type === 'cash' ? 'KES ' + ((l.amountCents || 0) / 100).toFixed(2) : l.itemName;
      const fine = l.type === 'cash' ? 'KES ' + ((Number(l.fineCents || 0) + Number(l.fineNowCents || 0)) / 100).toFixed(2) : '-';
      const actions = [];
      if (l.status === 'pending') actions.push(h('button', { class: 'btn sm', onclick: async () => { try { await api.post('/api/ga/loans/' + l.id + '/verify', { type: l.type }); toast('Verified'); loaders.loans(); loaders.ov(); } catch (e) { toast(e.message, 'err'); } } }, 'Verify'));
      if (l.status === 'verified') actions.push(h('button', { class: 'btn sm', onclick: async () => { try { await api.post('/api/ga/loans/' + l.id + '/disburse', { type: l.type }); toast('Disbursed'); loaders.loans(); loaders.ov(); } catch (e) { toast(e.message, 'err'); } } }, 'Disburse'));
      if (['disbursed', 'overdue'].includes(l.status)) actions.push(h('button', { class: 'btn sm ghost', onclick: async () => { try { const x = await api.post('/api/ga/loans/' + l.id + '/clear', { type: l.type }); toast('Cleared'); loaders.loans(); loaders.ov(); } catch (e) { toast(e.message, 'err'); } } }, 'Clear'));
      tbl.append(h('tr', {}, h('td', {}, '#' + l.id), h('td', {}, l.type), h('td', {}, amount), h('td', {}, l.dueAt ? fmtDate(l.dueAt) : '-'), h('td', {}, fine), h('td', {}, badge(l.status, l.status === 'pending' ? 'warn' : l.status === 'cleared' ? 'ok' : 'acc')), h('td', {}, h('div', { class: 'btnrow' }, ...actions))));
    });
  };
  document.getElementById('item-add').addEventListener('click', async () => {
    const name = document.getElementById('item-name').value;
    const description = document.getElementById('item-desc').value;
    const category = document.getElementById('item-category').value;
    const price = document.getElementById('item-price').value;
    try { await api.post('/api/ga/items', { name, description, category, price }); document.getElementById('item-name').value = ''; document.getElementById('item-desc').value = ''; document.getElementById('item-price').value = ''; toast('Item added'); loaders.loans(); } catch (e) { toast(e.message, 'err'); }
  });
  document.getElementById('ga-loan-go').addEventListener('click', async () => {
    const type = document.getElementById('ga-loan-type').value;
    const amount = type === 'cash' ? document.getElementById('ga-loan-amount').value : null;
    const itemId = type === 'item' ? document.getElementById('ga-loan-item').value : null;
    try { await api.post('/api/ga/my-loans', { type, amount, itemId }); toast('Your loan request was sent to the Owner'); loaders.loans(); loaders.ov(); } catch (e) { toast(e.message, 'err'); }
  });

  loaders.codes = async () => {
    const { codes } = await api.get('/api/ga/safe-codes');
    const tbl = document.getElementById('codes-tbl');
    tbl.innerHTML = '';
    tbl.append(h('tr', {}, h('th', {}, 'Code'), h('th', {}, 'Status'), h('th', {}, 'Created'), h('th', {}, 'Used at'), h('th', {}, 'Actions')));
    for (const c of codes) {
      const st = c.used ? badge('used', 'ok') : c.active ? badge('active', 'acc') : badge('revoked', 'bad');
      tbl.append(h('tr', {}, h('td', {}, h('code', {}, c.code)), h('td', {}, st), h('td', {}, fmtDate(c.createdAt)),
        h('td', {}, c.usedAt ? fmtDate(c.usedAt) : '-'),
        h('td', {}, (!c.used && c.active)
          ? h('button', { class: 'btn sm danger', onclick: async () => { try { await api.del('/api/ga/safe-codes/' + c.id); toast('Revoked'); loaders.codes(); } catch (e) { toast(e.message, 'err'); } } }, 'Revoke')
          : '-')));
    }
  };
  document.getElementById('gen-code').addEventListener('click', async () => {
    try {
      const r = await api.post('/api/ga/safe-codes', { count: 1 });
      const box = document.getElementById('new-codes');
      box.innerHTML = '';
      box.append(h('b', {}, 'New safe code (one-time use): '), h('code', { style: 'font-size:16px;color:var(--acc)' }, r.codes[0]),
        h('div', { class: 'small muted mt' }, 'Share it with the new member so they can register. The V Super Admin was email-notified.'));
      box.hidden = false;
      loaders.codes(); loaders.ov();
    } catch (e) { toast(e.message, 'err'); }
  });

  loaders.requests = async () => {
    const { requests } = await api.get('/api/ga/requests');
    const tbl = document.getElementById('req-tbl');
    tbl.innerHTML = '';
    tbl.append(h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Email'), h('th', {}, 'Phone'), h('th', {}, 'Note'), h('th', {}, 'Requested'), h('th', {}, 'Status'), h('th', {}, 'Safe code / Actions')));
    for (const q of requests) {
      const st = q.status === 'pending' ? badge('pending', 'warn') : q.status === 'approved' ? badge('approved', 'ok') : badge('rejected', 'bad');
      const act = q.status === 'pending'
        ? h('div', { class: 'btnrow' },
          h('button', {
            class: 'btn sm', onclick: async () => {
              try {
                const r = await api.post(`/api/ga/requests/${q.id}/approve`);
                alert(`Approved. Safe code for ${q.email}:\n\n${r.code}\n\n(They were emailed when email is configured; the V Super Admin was notified.)`);
                loaders.requests(); loaders.codes();
              } catch (e) { toast(e.message, 'err'); }
            }
          }, '✅ Approve → code'),
          h('button', { class: 'btn sm danger', onclick: async () => { try { await api.post(`/api/ga/requests/${q.id}/reject`); loaders.requests(); } catch (e) { toast(e.message, 'err'); } } }, 'Reject'))
        : (q.codeIssued ? h('code', {}, q.codeIssued) : '-');
      tbl.append(h('tr', {}, h('td', {}, q.firstName + ' ' + q.lastName), h('td', {}, q.email), h('td', {}, q.phone || '-'),
        h('td', { class: 'muted' }, q.note || '-'), h('td', {}, fmtDate(q.at)), h('td', {}, st), h('td', {}, act)));
    }
    if (!requests.length) tbl.append(h('tr', {}, h('td', { class: 'muted', colspan: '7' }, 'No requests yet.')));
  };

  document.getElementById('an-go').addEventListener('click', async () => {
    try {
      const r = await api.post('/api/ga/announce', { title: document.getElementById('an-title').value, body: document.getElementById('an-body').value });
      document.getElementById('an-title').value = ''; document.getElementById('an-body').value = '';
      toast(`Announcement delivered to ${r.delivered} member(s)`);
    } catch (e) { toast(e.message, 'err'); }
  });

  // Group Admin views do not expose member account or profile pages.
  let chatStarted = false;
  try {
    WS.on('group:finance:updated', () => {
      loaders.finance();
      if (document.getElementById('view-ov').classList.contains('on')) loaders.ov();
    });
    WS.connect('/rt');
  } catch (error) { /* periodic refresh remains available */ }
  setInterval(() => { if (!document.hidden) loaders.finance(); }, 30000);
   const NAV = [['ov', '🏠', 'My Group'], ['members', '📄', 'Agreements'], ['codes', '🔐', 'Safe Codes'],
     ['requests', '📨', 'Requests'], ['loans', '💳', 'Items & Loans'], ['announce', '📣', 'Announce'], ['chat', '💬', 'Chat & Calls'], ['notif', '🔔', 'Notifications'], ['member-account', '👤', 'My Member Account'], ['profile', '🖼️', 'My Profile']];
   const notifLoad = DASH.notifView('view-notif');
   let currentBranding = { name: 'VonDonald051 Savings', logo: null, colors: null };
    try { const { branding } = await api.get('/api/auth/branding'); if (branding) currentBranding = branding; } catch (e) { /* noop */ }
   DASH.buildChrome(me, currentBranding.name + ' · GROUP ADMIN', NAV, id => {
    if (id === 'notif') notifLoad();
    else if (id === 'member-account') location.href = '/app/member';
    else if (id === 'chat' && !chatStarted) { chatStarted = true; CHAT.init(me); }
    else if (loaders[id]) loaders[id]();
  }, currentBranding);
  DASH.wireProfile(me);
  loaders.ov();
  loaders.finance();
});
