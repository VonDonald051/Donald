'use strict';
document.addEventListener('DOMContentLoaded', async () => {
  initBG('stars-only');
  const { me } = await api.get('/api/me');
  const { memberProfile } = await api.get('/api/me').catch(() => ({ memberProfile: null }));
  const loaders = {};
  const stat = (n, c) => h('div', { class: 'card stat' }, h('div', { class: 'num' }, String(n)), h('div', { class: 'cap' }, c));
  const badge = (t, k) => h('span', { class: 'badge ' + k }, t);

  loaders.ov = async () => {
    const o = await api.get('/api/sa/overview');
    const s = document.getElementById('ov-stats');
    s.innerHTML = '';
    s.append(stat(o.groups, 'Groups'), stat(o.groupAdmins, 'Group Admins'), stat(o.members, 'Members'),
      stat(o.locked, 'Locked accounts'), stat(o.pendingRequests, 'Pending access requests'), stat(o.messages, 'Encrypted messages'));
    const secBox = document.getElementById('ov-sec');
    if (secBox) {
      secBox.innerHTML = '';
      const kv = [
        ['Teams security alerts', o.teamsAlertsConfigured ? 'Configured' : 'Not configured'],
        ['AI alerting', o.aiAlertsConfigured ? 'Configured' : 'Not enabled']
      ];
      for (const [k, v] of kv) { secBox.append(h('div', { class: 'k' }, k), h('div', {}, v)); }
    }
    renderTrendChart('sa-trend-chart');
  };

  async function renderTrendChart(canvasId) {
    const target = document.getElementById(canvasId);
    if (!target || !window.FinanceChart) return;
    let data;
    try { data = await api.get('/api/sa/charts/trends'); } catch { return; }
    FinanceChart.render(target, data.labels, [
      { name: 'Savings (KES)', values: data.savings.map(value => Number(value || 0) * 100), color: '#4ade80' },
      { name: 'Loans (KES)', values: data.loans.map(value => Number(value || 0) * 100), color: '#f2c14e' }
    ]);
  }

  loaders.groups = async () => {
    const { groups } = await api.get('/api/sa/groups');
    const chart = document.getElementById('sa-savings-chart');
    chart.replaceChildren();
    const maximum = Math.max(1, ...groups.map(group => Number(group.savingsCents || 0)));
    for (const group of groups) {
      const width = Math.round(Number(group.savingsCents || 0) / maximum * 100);
      chart.append(h('div', { class: 'mb' },
        h('div', { class: 'btnrow', style: 'justify-content:space-between' }, h('span', {}, group.name), h('span', { class: 'small muted' }, 'KES ' + (Number(group.savingsCents || 0) / 100).toFixed(2))),
        h('div', { role: 'img', 'aria-label': `${group.name}: ${width}% of highest group savings`, style: 'height:9px;background:rgba(255,255,255,.15)' }, h('div', { style: `height:100%;width:${width}%;background:#e6b94a` }))));
    }
    if (!groups.length) chart.append(h('div', { class: 'muted' }, 'No savings groups yet.'));
    const tbl = document.getElementById('groups-tbl');
    tbl.innerHTML = '';
    tbl.append(h('tr', {}, h('th', {}, 'ID'), h('th', {}, 'Name'), h('th', {}, 'Description'), h('th', {}, 'Members'), h('th', {}, 'Savings'), h('th', {}, 'Admins'), h('th', {}, 'Status'), h('th', {}, 'Actions')));
    for (const g of groups) {
      tbl.append(h('tr', {},
        h('td', {}, String(g.id)), h('td', {}, g.name), h('td', { class: 'muted' }, g.description || '-'),
        h('td', {}, String(g.members)), h('td', {}, 'KES ' + (Number(g.savingsCents || 0) / 100).toFixed(2)), h('td', {}, String(g.admins)), h('td', {}, g.suspended ? badge('Suspended', 'bad') : badge('Active', 'ok')),
        h('td', {}, h('button', {
          class: 'btn sm ghost', onclick: async () => {
            const n = prompt('Group name:', g.name); if (n == null) return;
            try { await api.put('/api/sa/groups/' + g.id, { name: n }); toast('Saved'); loaders.groups(); }
            catch (e) { toast(e.message, 'err'); }
          }
        }, '✏ Rename'), !g.suspended ? h('button', { class: 'btn sm ghost', onclick: async () => { try { await api.post('/api/sa/groups/' + g.id + '/suspend'); toast('Group suspended'); loaders.groups(); } catch (e) { toast(e.message, 'err'); } } }, 'Suspend') : null)));
    }
  };
  document.getElementById('ng-go').addEventListener('click', async () => {
    try {
      await api.post('/api/sa/groups', { name: document.getElementById('ng-name').value, description: document.getElementById('ng-desc').value });
      document.getElementById('ng-name').value = ''; document.getElementById('ng-desc').value = '';
      toast('Group created'); loaders.groups();
    } catch (e) { toast(e.message, 'err'); }
  });

  loaders.gas = async () => {
    const [{ users }, { groups }] = await Promise.all([api.get('/api/sa/group-admins'), api.get('/api/sa/groups')]);
    const selector = document.getElementById('ga-group');
    selector.replaceChildren(...groups.filter(group => !group.suspended).map(group => h('option', { value: group.id }, group.name)));
    const tbl = document.getElementById('gas-tbl');
    tbl.innerHTML = '';
    tbl.append(h('tr', {}, h('th', {}, 'Admin'), h('th', {}, 'Email'), h('th', {}, 'Phone'), h('th', {}, 'Group'), h('th', {}, 'State')));
    for (const u of users) {
      tbl.append(h('tr', {}, h('td', {}, pic(u.pic, 'av'), u.name), h('td', {}, u.email), h('td', {}, u.phone || '-'),
        h('td', {}, u.group || '—'), h('td', {}, u.locked ? badge('locked', 'bad') : badge('active', 'ok'))));
    }
  };
  document.getElementById('ga-create').addEventListener('click', async () => {
    try {
      const result = await api.post('/api/sa/group-admins', {
        firstName: document.getElementById('ga-fn').value,
        lastName: document.getElementById('ga-ln').value,
        email: document.getElementById('ga-em').value,
        phone: document.getElementById('ga-ph').value,
        groupId: document.getElementById('ga-group').value,
        password: document.getElementById('ga-pw').value,
        confirmPassword: document.getElementById('ga-cp').value
      });
      alert(`Group Admin account created for ${result.user.email}.\nTemporary password:\n\n${result.temporaryPassword}\n\nDeliver it securely and have the user change it after sign-in.`);
      ['ga-fn', 'ga-ln', 'ga-em', 'ga-ph', 'ga-pw', 'ga-cp'].forEach(id => { document.getElementById(id).value = ''; });
      await loaders.gas();
    } catch (error) {
      const errors = error.data && error.data.errors;
      toast(errors ? Object.values(errors).join(' · ') : error.message, 'err');
    }
  });

  loaders.members = async () => {
    const { users } = await api.get('/api/sa/members');
    const tbl = document.getElementById('members-tbl');
    tbl.innerHTML = '';
    tbl.append(h('tr', {}, h('th', {}, 'Member'), h('th', {}, 'Email'), h('th', {}, 'Phone'), h('th', {}, 'Group'), h('th', {}, 'Joined'), h('th', {}, 'State')));
    for (const u of users) {
      tbl.append(h('tr', {}, h('td', {}, pic(u.pic, 'av'), u.name), h('td', {}, u.email), h('td', {}, u.phone || '-'),
        h('td', {}, u.group || '—'), h('td', {}, fmtDate(u.createdAt)),
        h('td', {}, u.locked ? badge('locked', 'bad') : u.disabled ? badge('disabled', 'warn') : badge('active', 'ok'))));
    }
  };

  // ---- GA Loans (SA verifies GA loans) ----
  loaders['ga-loans'] = async () => {
    const gaId = document.getElementById('ga-loan-select').value;
    if (!gaId) return;
    const { loans } = await api.get('/api/sa/ga-loans?gaId=' + gaId);
    const tbl = document.getElementById('ga-loans-tbl');
    tbl.innerHTML = '';
    tbl.append(h('tr', {}, h('th', {}, 'Type'), h('th', {}, 'Amount'), h('th', {}, 'Due'), h('th', {}, 'Fine'), h('th', {}, 'Status'), h('th', {}, 'Actions')));
    for (const l of loans) {
      const amount = l.type === 'cash' ? 'KES ' + ((l.amountCents || 0) / 100).toFixed(2) : l.itemName;
      const fine = l.type === 'cash' ? 'KES ' + ((l.fineCents || 0) / 100).toFixed(2) : '-';
      const actions = [];
      if (l.status === 'pending') {
        actions.push(h('button', { class: 'btn sm', onclick: async () => { try { await api.post('/api/sa/ga-loans/' + l.id + '/verify', { type: l.type }); toast('Verified'); loaders['ga-loans'](); } catch (e) { toast(e.message, 'err'); } } }, '✅ Verify'));
      }
      if (l.status === 'verified') {
        actions.push(h('button', { class: 'btn sm', onclick: async () => { try { await api.post('/api/sa/ga-loans/' + l.id + '/disburse', { type: l.type }); toast('Disbursed'); loaders['ga-loans'](); } catch (e) { toast(e.message, 'err'); } } }, '💰 Disburse'));
      }
      if (['disbursed', 'overdue'].includes(l.status)) {
        actions.push(h('button', { class: 'btn sm ghost', onclick: async () => { try { const x = await api.post('/api/sa/ga-loans/' + l.id + '/clear', { type: l.type }); toast('Cleared'); loaders['ga-loans'](); } catch (e) { toast(e.message, 'err'); } } }, '✔ Clear'));
      }
      tbl.append(h('tr', {}, h('td', {}, l.type), h('td', {}, amount), h('td', {}, l.dueAt ? fmtDate(l.dueAt) : '-'), h('td', {}, fine), h('td', {}, l.status), h('td', {}, h('div', { class: 'btnrow' }, ...actions))));
    }
    if (!loans.length) tbl.append(h('tr', {}, h('td', { class: 'muted', colspan: '6' }, 'No loans for this Group Admin.')));
  };

  // Populate GA select on load
  (async () => {
    const { users } = await api.get('/api/sa/group-admins');
    const sel = document.getElementById('ga-loan-select');
    if (sel) {
      sel.innerHTML = '';
      users.forEach(u => sel.append(h('option', { value: u.id }, u.name + ' (' + (u.group || '-') + ')')));
      sel.addEventListener('change', () => loaders['ga-loans']());
    }
  })();

  // ---- My Member Account ----
  loaders['my-member'] = async () => {
    const mp = memberProfile;
    const regBox = document.getElementById('mm-registration');
    const agrBox = document.getElementById('mm-agreement');
    const savBox = document.getElementById('mm-savings');
    const loanBox = document.getElementById('mm-loans');
    const fineBox = document.getElementById('mm-fines');

    // Registration fee
    regBox.innerHTML = '';
    regBox.append(h('h3', { class: 'mb' }, 'Registration Fee'));
    if (mp && mp.registrationFeePaid) {
      regBox.append(h('div', { class: 'ok' }, '✅ Registration fee paid'), h('div', { class: 'small muted' }, 'Paid on ' + fmtDate(mp.registrationFeePaidAt)));
    } else {
    regBox.append(h('div', { class: 'muted' }, 'KES 200 registration fee not yet paid'), h('button', { class: 'btn mt', id: 'mm-pay-fee' }, 'Report KES 200 payment to Owner'));
    }

    // System agreements are issued only to member-role accounts.
    agrBox.innerHTML = '';
    agrBox.append(h('h3', { class: 'mb' }, 'System Agreement'), h('div', { class: 'muted' }, 'System agreements are issued to member accounts.'));

    // Savings
    savBox.innerHTML = '';
    savBox.append(h('h3', { class: 'mb' }, 'Weekly Savings'));
    const { savings } = await api.get('/api/me/member-profile/savings').catch(() => ({ savings: [] }));
    const totalSaved = savings.reduce((n, s) => n + Number((s.amountCents || 0) / 100), 0);
    savBox.append(h('div', { class: 'kv' }, h('div', { class: 'k' }, 'Total savings'), h('div', {}, 'KES ' + totalSaved.toFixed(2))));
    savBox.append(h('div', { class: 'grid cols3 mt' }, h('div', {}, h('label', { class: 'f' }, 'Amount (KES)'), h('input', { class: 'inp', id: 'mm-save-amt', type: 'number', min: '1' })), h('div', {}, h('label', { class: 'f' }, 'Week (optional)'), h('input', { class: 'inp', id: 'mm-save-week', placeholder: 'e.g. 2026-40' })), h('div', {}, h('button', { class: 'btn', id: 'mm-save-go' }, 'Add saving'))));
    const savTbl = h('table', { class: 'tbl mt' });
    savTbl.append(h('tr', {}, h('th', {}, 'Amount'), h('th', {}, 'Week'), h('th', {}, 'Description'), h('th', {}, 'Date')));
    savings.forEach(s => savTbl.append(h('tr', {}, h('td', {}, 'KES ' + ((s.amountCents || 0) / 100).toFixed(2)), h('td', {}, s.week || '-'), h('td', {}, s.description || '-'), h('td', {}, fmtDate(s.createdAt)))));
    savBox.append(savTbl);

    // Loans
    loanBox.innerHTML = '';
    loanBox.append(h('h3', { class: 'mb' }, 'My Loans'));
    const { loans } = await api.get('/api/me/loans').catch(() => ({ loans: [] }));
    const loanTbl = h('table', { class: 'tbl' });
    loanTbl.append(h('tr', {}, h('th', {}, 'Type'), h('th', {}, 'Amount'), h('th', {}, 'Due'), h('th', {}, 'Fine'), h('th', {}, 'Status')));
    loans.forEach(l => {
      const amount = l.type === 'cash' ? 'KES ' + ((l.totalDueCents || l.amountCents || 0) / 100).toFixed(2) : l.itemName;
      const fine = l.type === 'cash' ? 'KES ' + ((l.fineCents || 0) / 100).toFixed(2) : '-';
      loanTbl.append(h('tr', {}, h('td', {}, l.type), h('td', {}, amount), h('td', {}, l.dueAt ? fmtDate(l.dueAt) : '-'), h('td', {}, fine), h('td', {}, l.status)));
    });
    loanBox.append(loanTbl);

    // Fines
    fineBox.innerHTML = '';
    fineBox.append(h('h3', { class: 'mb' }, 'My Fines'));
    const { fines } = await api.get('/api/me/fines').catch(() => ({ fines: [] }));
    const fineTbl = h('table', { class: 'tbl' });
    fineTbl.append(h('tr', {}, h('th', {}, 'Amount'), h('th', {}, 'Paid'), h('th', {}, 'Loan ID'), h('th', {}, 'Date')));
    fines.forEach(f => fineTbl.append(h('tr', {}, h('td', {}, 'KES ' + ((f.amountCents || 0) / 100).toFixed(2)), h('td', {}, f.paid ? 'YES' : 'NO'), h('td', {}, f.loanRef || '-'), h('td', {}, fmtDate(f.createdAt)))));
    fineBox.append(fineTbl);
  };

  // ---- event handlers for My Member Account ----
  document.addEventListener('click', async (e) => {
    if (e.target.id === 'mm-pay-fee') {
      try { await api.post('/api/me/member-profile/registration-fee'); toast('Payment report sent to the Owner for approval'); loaders['my-member'](); } catch (e) { toast(e.message, 'err'); }
    }
    if (e.target.id === 'mm-save-go') {
      try { await api.post('/api/me/member-profile/savings', { amount: document.getElementById('mm-save-amt').value, week: document.getElementById('mm-save-week').value }); toast('Savings report sent to the Owner for approval'); loaders['my-member'](); } catch (e) { toast(e.message, 'err'); }
    }
  });

   const NAV = [['ov', '🏠', 'Overview'], ['groups', '👥', 'Groups'], ['gas', '🛡️', 'Group Admins'],
     ['ga-loans', '💳', 'GA Loans'], ['members', '👤', 'Members'], ['my-member', '👤', 'My Member Account'], ['chat', '✉', 'Admin Chat'], ['notif', '🔔', 'Notifications'], ['profile', '🖼️', 'My Profile']];
   let chatStarted = false;
   const notifLoad = DASH.notifView('view-notif');
   let currentBranding = { name: 'VonDonald051 Savings', logo: null, colors: null };
   try { const { branding } = await api.get('/api/auth/branding'); if (branding) currentBranding = branding; } catch (e) { /* noop */ }
   DASH.buildChrome(me, currentBranding.name + ' · SUPER ADMIN', NAV, id => {
    if (id === 'notif') notifLoad();
    else if (id === 'ga-loans') loaders['ga-loans']();
    else if (id === 'my-member') loaders['my-member']();
    else if (id === 'chat' && !chatStarted) { chatStarted = true; CHAT.init(me); }
    else if (loaders[id]) loaders[id]();
  }, currentBranding);
  DASH.wireProfile(me);
  loaders.ov();
});
