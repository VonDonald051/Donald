'use strict';
document.addEventListener('DOMContentLoaded', async () => {
  initBG('clouds');
  const { me } = await api.get('/api/me');
  const stat = (n, c) => h('div', { class: 'card stat' }, h('div', { class: 'num' }, String(n)), h('div', { class: 'cap' }, c));
  const badge = (t, k) => h('span', { class: 'badge ' + k }, t);

  const loaders = {};
  loaders.ov = async () => {
    const o = await api.get('/api/member/overview');
    const s = document.getElementById('ov-stats');
    s.innerHTML = '';
    s.append(stat(o.group ? 1 : 0, 'Group membership'), stat(o.stats.messages, 'Encrypted messages'),
      stat(o.stats.announcements, 'Announcements received'), stat(o.stats.activeLoans, 'Active loan requests'));
    const g = document.getElementById('ov-group');
    g.innerHTML = '';
    g.append(h('h3', { class: 'mb' }, 'My Group'));
    if (o.group) {
      g.append(h('div', { class: 'kv' },
        h('div', { class: 'k' }, 'Name'), h('div', {}, o.group.name),
        h('div', { class: 'k' }, 'About'), h('div', {}, o.group.description || '-'),
        h('div', { class: 'k' }, 'Member since'), h('div', {}, fmtDate(o.stats.joined))));
    } else g.append(h('div', { class: 'muted' }, 'You are not in a group yet — your group admin will add you via safe code.'));
    const ga = document.getElementById('ov-ga');
    ga.innerHTML = '';
    ga.append(h('h3', { class: 'mb' }, 'My Group Admin'));
    if (o.groupAdmin) {
      ga.append(h('div', { class: 'btnrow' }, pic(o.groupAdmin.pic, 'av'),
        h('div', {}, h('b', {}, o.groupAdmin.name), h('div', { class: 'small muted' }, o.groupAdmin.email), h('div', { class: 'small muted' }, o.groupAdmin.phone || ''))));
      ga.append(h('div', { class: 'small muted mt' }, 'Chat and video-call them from the "Chat & Calls" tab.'));
    } else ga.append(h('div', { class: 'muted' }, 'No group admin assigned yet.'));
    const kit = document.getElementById('ov-kit');
    kit.replaceChildren();
    for (const category of o.kit || []) {
      const title = category.category === 'tshirt' ? 'T-shirt' : 'Cap';
      const card = h('div', { class: 'card' }, h('h3', { class: 'mb' }, title));
      if (!category.items.length) card.append(h('div', { class: 'muted' }, `No ${title.toLowerCase()} has been configured by your Group Admin.`));
      for (const item of category.items) {
        const state = item.status === 'cleared' ? 'Cleared' : item.status === 'available' ? 'Available' : item.status;
        card.append(h('div', { class: 'kv' }, h('div', { class: 'k' }, item.name), h('div', {}, 'KES ' + (Number(item.priceCents || 0) / 100).toFixed(2)), h('div', { class: 'k' }, 'Status'), h('div', {}, state)));
      }
      kit.append(card);
    }
  };

  loaders.finance = async () => {
    const updated = document.getElementById('member-finance-updated');
    if (['admin', 'super_admin', 'group_admin'].includes(me.role)) {
      agreementBox.replaceChildren(h('div', { class: 'small muted' }, 'This is your Owner-assigned staff member account. Payments and loan requests are sent to the Owner for approval.'));
    } else try {
      const data = await api.get('/api/me/finance-trend');
      const summary = data.summary || {};
      const stats = document.getElementById('member-finance-stats');
      stats.replaceChildren(
        stat(FinanceChart.kes(summary.verifiedSavingsCents), 'Verified savings'),
        stat(FinanceChart.kes(summary.pendingSavingsCents), 'Awaiting savings verification'),
        stat(FinanceChart.kes(summary.activeLoanCents), 'Outstanding loans'),
        stat(String(summary.activeLoans || 0), 'Active loans'));
      FinanceChart.render(document.getElementById('member-finance-chart'), data.labels, [
        { name: 'Verified savings', values: data.series.savingsCents, color: '#19856d' },
        { name: 'Outstanding loans', values: data.series.loanOutstandingCents, color: '#d36c44' }
      ]);
      updated.textContent = 'Updated ' + new Date(data.updatedAt).toLocaleTimeString('en-KE');
    } catch (error) {
      updated.textContent = 'Chart temporarily unavailable';
    }
  };

  loaders.savings = async () => {
    const staffAccount = ['admin', 'super_admin', 'group_admin'].includes(me.role);
    const { memberProfile, registrationFeePending } = await api.get('/api/me');
    const { savings, totalCents, pendingCents } = await api.get('/api/me/member-profile/savings');
    const status = document.getElementById('saving-account-status');
    status.replaceChildren(h('h3', { class: 'mb' }, 'Account status'));
    status.append(h('div', { class: 'kv' },
      h('div', { class: 'k' }, 'Registration fee'), h('div', {}, memberProfile && memberProfile.registrationFeePaid ? 'Paid · KES 200' : registrationFeePending ? 'Reported · awaiting verification' : 'Unpaid · KES 200'),
      h('div', { class: 'k' }, 'System agreement'), h('div', {}, staffAccount ? 'Not required for staff accounts' : 'See agreement status below'),
      h('div', { class: 'k' }, 'Verified savings'), h('div', {}, 'KES ' + (Number(totalCents || 0) / 100).toFixed(2)),
      h('div', { class: 'k' }, 'Awaiting verification'), h('div', {}, 'KES ' + (Number(pendingCents || 0) / 100).toFixed(2))));
    if (memberProfile && !memberProfile.registrationFeePaid && !registrationFeePending) status.append(h('button', { class: 'btn mt', id: 'saving-pay-fee' }, 'Report KES 200 payment'));
    const agreementBox = h('div', { class: 'mt' });
    status.append(agreementBox);
    if (staffAccount) {
      agreementBox.replaceChildren(h('div', { class: 'small muted' }, 'Staff savings and loan requests do not require a member agreement. They are sent to the Owner for approval.'));
    } else try {
      const { agreement } = await api.get('/api/me/system-agreements/current');
      agreementBox.replaceChildren(h('div', { class: 'small muted' }, agreement ? `Agreement ${agreement.status} · ${agreement.agreementCode}` : 'No agreement issued yet.'));
      if (!agreement || agreement.status === 'EXPIRED') agreementBox.append(h('button', { class: 'btn mt', id: 'saving-sign-agreement' }, agreement ? 'Request a new agreement' : 'Request agreement'));
      if (agreement && agreement.status === 'PENDING') agreementBox.append(
        h('p', { class: 'small mt' }, 'Review the agreement terms before continuing. Clicking “Agree and sign” records your electronic acceptance and creates your signed agreement PDF.'),
        h('a', { class: 'btn ghost', href: api.url('/api/me/system-agreements/current.pdf') }, 'Review agreement terms (PDF)'),
        h('button', { class: 'btn mt', id: 'agreement-accept-btn' }, 'Agree and sign'));
      if (agreement && agreement.status === 'SIGNED') agreementBox.append(h('a', { class: 'btn ghost mt', href: api.url('/api/me/system-agreements/current.signed.pdf') }, 'Download signed agreement PDF'));
    } catch (error) { agreementBox.replaceChildren(h('div', { class: 'small muted' }, error.message || 'System agreements are unavailable.')); }

    const entry = document.getElementById('saving-entry');
    entry.replaceChildren(h('h3', { class: 'mb' }, 'Weekly contribution'));
    entry.append(h('label', { class: 'f', for: 'saving-amount' }, 'Amount (KES)'), h('input', { class: 'inp', id: 'saving-amount', type: 'number', min: '1', step: '0.01' }));
    entry.append(h('label', { class: 'f', for: 'saving-week' }, 'Week (optional)'), h('input', { class: 'inp', id: 'saving-week', placeholder: 'YYYY-WW' }));
    entry.append(h('button', { class: 'btn mt', id: 'saving-submit' }, 'Add weekly saving'));

    const table = document.getElementById('my-savings-tbl');
    table.replaceChildren(h('tr', {}, h('th', {}, 'Amount'), h('th', {}, 'Week'), h('th', {}, 'Description'), h('th', {}, 'Date'), h('th', {}, 'Status')));
    for (const saving of savings) table.append(h('tr', {},
      h('td', {}, 'KES ' + (Number(saving.amountCents || 0) / 100).toFixed(2)),
      h('td', {}, saving.week || '-'), h('td', {}, saving.description || '-'), h('td', {}, fmtDate(saving.createdAt)), h('td', {}, saving.status === 'pending' ? 'Awaiting verification' : 'Verified')));
    if (!savings.length) table.append(h('tr', {}, h('td', { colspan: '5', class: 'muted' }, 'No savings recorded yet.')));
  };

  loaders.loans = async () => {
    const qs = new URLSearchParams({ page: '1' });
    if (document.getElementById('loan-filter-status')) qs.set('status', document.getElementById('loan-filter-status').value);
    const [data, meData, itemsData] = await Promise.all([api.get('/api/me/loans?' + qs.toString()), api.get('/api/me'), api.get('/api/member/items')]);
    const { loans, page, pages } = data;
    const savingsCents = meData.savingsTotalCents || 0;
    const limitCents = Math.floor(savingsCents * 0.5);
    const itemSelect = document.getElementById('loan-item');
    itemSelect.replaceChildren(...itemsData.items.filter(item => Number(item.priceCents) > 0).map(item => h('option', { value: item.id }, `${item.name} · ${item.category === 'tshirt' ? 'T-shirt' : item.category === 'cap' ? 'Cap' : 'Weekly item'} · KES ${(item.priceCents / 100).toFixed(2)}`)));
    const hasUncleared = loans.some(l => !['cleared', 'rejected'].includes(l.status));
    document.getElementById('loan-limit').innerHTML = `<b>Borrowing limit:</b> KES ${(limitCents / 100).toFixed(2)} (50% of your savings)${hasUncleared ? ' | <span class="badge warn">You can borrow again once your current loan is cleared</span>' : ''}`;
    document.getElementById('loan-request').disabled = hasUncleared;
    const tbl = document.getElementById('my-loans-tbl');
    tbl.innerHTML = '';
    if (!document.getElementById('loan-filter-status')) {
      const filter = h('div', { class: 'filters mt' },
        h('label', { class: 'f' }, 'Filter: '),
        h('select', { class: 'inp', id: 'loan-filter-status' },
          h('option', { value: '' }, 'All'), h('option', { value: 'pending' }, 'Requested'),
          h('option', { value: 'verified' }, 'Verified'), h('option', { value: 'disbursed' }, 'Disbursed'),
          h('option', { value: 'overdue' }, 'Overdue'), h('option', { value: 'cleared' }, 'Cleared'), h('option', { value: 'rejected' }, 'Rejected')));
      filter.querySelector('select').addEventListener('change', () => loaders.loans());
      tbl.parentElement.insertBefore(filter, tbl);
    }
    tbl.append(h('tr', {}, h('th', {}, 'Type'), h('th', {}, 'Amount'), h('th', {}, 'Due'), h('th', {}, 'Fine'), h('th', {}, 'Status'), h('th', {}, 'Repayment')));
    if (!loans.length) {
      tbl.append(h('tr', {}, h('td', { class: 'muted', colspan: '6' }, 'No loans yet. Request one above.')));
    } else {
      loans.forEach(l => {
        const amount = l.type === 'cash' ? 'KES ' + ((l.totalDueCents || l.amountCents || 0) / 100).toFixed(2) : l.itemName;
        const fine = l.type === 'cash' && l.fineCents ? 'KES ' + (l.fineCents / 100).toFixed(2) : '-';
        const statusClass = l.status === 'overdue' ? 'bad' : l.status === 'cleared' ? 'ok' : l.status === 'rejected' ? 'warn' : '';
        const dueDisplay = l.dueAt ? fmtDue(l.dueAt) : '-';
        const repayment = ['disbursed', 'overdue'].includes(l.status)
          ? l.repaymentReportedAt ? 'Awaiting verification' : h('button', { class: 'btn sm ghost', onclick: async () => {
            if (!confirm('Only report a repayment after you have paid the Group Admin.')) return;
            try { await api.post(`/api/me/loans/${l.id}/repayment-report`); toast('Repayment reported for Group Admin verification'); loaders.loans(); }
            catch (error) { toast(error.message, 'err'); }
          } }, 'Report payment')
          : '-';
        tbl.append(h('tr', {},
          h('td', {}, l.type === 'cash' ? 'Cash loan' : l.type === 'item' ? 'Item loan' : l.type),
          h('td', {}, amount), h('td', {}, dueDisplay),
          h('td', {}, fine),
          h('td', {}, badge(l.status, statusClass)), h('td', {}, repayment)));
      });
    }
    document.getElementById('loan-paging').textContent = loans.length ? `Page ${page} of ${pages}` : '';
  };
  document.getElementById('loan-type').addEventListener('change', e => { document.getElementById('cash-fields').hidden = e.target.value !== 'cash'; document.getElementById('item-fields').hidden = e.target.value !== 'item'; });
  const openLoanRequest = type => {
    const loanType = document.getElementById('loan-type');
    loanType.value = type;
    loanType.dispatchEvent(new Event('change'));
    loanType.focus();
  };
  document.getElementById('quick-cash-loan').addEventListener('click', () => openLoanRequest('cash'));
  document.getElementById('quick-item-loan').addEventListener('click', () => openLoanRequest('item'));
  document.getElementById('loan-request').addEventListener('click', async () => {
    try {
      const type = document.getElementById('loan-type').value;
      await api.post('/api/me/member-profile/loans', { type, amount: document.getElementById('loan-amount').value, itemId: document.getElementById('loan-item').value });
      toast(['admin', 'super_admin', 'group_admin'].includes(me.role) ? 'Loan request sent to the Owner' : 'Loan request sent to your group admin');
      loaders.loans(); loaders.ov();
    } catch (e) { toast(e.message, 'err'); }
  });

  document.addEventListener('click', async event => {
    if (event.target.id === 'saving-pay-fee') {
      const staffAccount = ['admin', 'super_admin', 'group_admin'].includes(me.role);
      if (!confirm(`Only report this after you have paid. The ${staffAccount ? 'Owner' : 'Group Admin'} will verify your payment.`)) return;
      try { await api.post('/api/me/member-profile/registration-fee'); toast(`Payment report sent to the ${staffAccount ? 'Owner' : 'Group Admin'} for approval`); loaders.savings(); }
      catch (error) { toast(error.message, 'err'); }
    }
    if (event.target.id === 'saving-sign-agreement') {
      try {
        await api.post('/api/me/system-agreements');
        toast('Agreement issued. Review the terms, then select Agree and sign.');
        loaders.savings();
      } catch (error) { toast(error.message, 'err'); }
    }
    if (event.target.id === 'agreement-accept-btn') {
      event.target.disabled = true;
      try {
        await api.post('/api/me/system-agreements/current/accept');
        toast('Agreement accepted and signed. Your PDF is ready to download.');
        await loaders.savings();
      } catch (error) { toast(error.message, 'err'); event.target.disabled = false; }
    }
    if (event.target.id === 'saving-submit') {
      try {
        await api.post('/api/me/member-profile/savings', { amount: document.getElementById('saving-amount').value, week: document.getElementById('saving-week').value });
        toast(['admin', 'super_admin', 'group_admin'].includes(me.role) ? 'Savings report sent to the Owner for approval' : 'Weekly saving recorded'); loaders.savings();
      } catch (error) { toast(error.message, 'err'); }
    }
  });

  loaders.fines = async () => {
    const { fines, totalCents, paidCents, outstandingCents } = await api.get('/api/me/fines');
    const tbl = document.getElementById('my-fines-tbl');
    tbl.innerHTML = '';
    tbl.append(h('tr', {}, h('th', {}, 'Amount'), h('th', {}, 'Paid'), h('th', {}, 'Loan ID'), h('th', {}, 'Date'), h('th', {}, 'Check')));
    if (!fines.length) {
      tbl.append(h('tr', {}, h('td', { class: 'muted', colspan: '5' }, 'No fines. Keep it up!')));
    } else {
      fines.forEach(f => {
        const paidState = f.paid ? badge('Paid', 'ok') : f.paidAt ? badge('Part paid', 'warn') : badge('Unpaid', 'bad');
        const checkState = f.paid ? badge('Verified', 'ok') : badge('Pending check', 'warn');
        tbl.append(h('tr', {},
          h('td', {}, 'KES ' + ((f.amountCents || 0) / 100).toFixed(2)),
          h('td', {}, paidState), h('td', {}, f.loanRef || '-'), h('td', {}, fmtDate(f.createdAt)), h('td', {}, checkState)));
      });
    }
    const tot = document.getElementById('fines-totals');
    if (tot) tot.innerHTML = `<b>Total:</b> KES ${(totalCents / 100).toFixed(2)} | <b>Paid:</b> KES ${(paidCents / 100).toFixed(2)} | <b>Outstanding:</b> KES ${(outstandingCents / 100).toFixed(2)}`;
  };

  loaders.statement = async () => {
    const fmt = document.getElementById('stmt-fmt') ? document.getElementById('stmt-fmt').value : 'pdf';
    window.open(api.url('/api/me/statement?format=' + encodeURIComponent(fmt)), '_blank');
  };

  // ---- WebSocket realtime ----
  try {
    WS.connect('/rt');
    WS.on('loan:updated', (loan) => {
      if (loan && loan.userId === me.id) {
        loaders.finance();
        if (document.getElementById('view-loans').classList.contains('on')) loaders.loans();
      }
    });
    WS.on('finance:updated', () => {
      loaders.finance();
      if (document.getElementById('view-savings').classList.contains('on')) loaders.savings();
    });
    WS.on('fine:updated', (fine) => {
      if (fine && fine.userId === me.id && document.getElementById('view-fines').classList.contains('on')) loaders.fines();
    });
    WS.on('notification:new', () => {
      if (document.getElementById('view-notif').classList.contains('on')) DASH.notifView('view-notif')();
    });
  } catch (e) { /* no-op */ }

  let chatStarted = false;
  const NAV = [
    ['ov', '🏠', 'My Dashboard'], ['savings', '▤', 'My Savings'], ['loans', '💳', 'My Loans'], ['fines', '💰', 'My Fines'],
    ['chat', '💬', 'Chat & Calls'], ['notif', '🔔', 'Notifications'], ['profile', '🖼️', 'My Profile']
  ];
  const notifLoad = DASH.notifView('view-notif');
  let currentBranding = { name: 'VonDonald051 Savings', logo: null, colors: null };
  try { const { branding } = await api.get('/api/auth/branding'); if (branding) currentBranding = branding; } catch (e) { /* noop */ }
  DASH.buildChrome(me, currentBranding.name + ' · MEMBER', NAV, id => {
    if (id === 'notif') notifLoad();
    else if (id === 'chat' && !chatStarted) { chatStarted = true; CHAT.init(me); }
    else if (id === 'loans') loaders.loans();
    else if (id === 'fines') loaders.fines();
    else if (loaders[id]) loaders[id]();
  }, currentBranding);
  DASH.wireProfile(me);
  loaders.ov();
  loaders.finance();
  setInterval(() => { if (!document.hidden) loaders.finance(); }, 30000);
  loaders.loans().catch(error => toast(error.message, 'err'));
});
