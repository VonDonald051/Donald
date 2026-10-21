'use strict';

const ACTIVE_LOAN_STATUSES = new Set(['disbursed', 'overdue']);

function amountForLoan(loan) {
  return Number(loan.type === 'item' ? (loan.costCents || loan.amountCents) : (loan.amountCents || loan.totalDueCents)) || 0;
}

function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function buildTrend({ savings = [], loans = [], members = 0, now = new Date() }) {
  const current = now instanceof Date ? now : new Date(now);
  const currentTime = current.getTime();
  const firstMonth = Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 11, 1);
  const periods = Array.from({ length: 12 }, (_, index) => {
    const start = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 11 + index, 1));
    const end = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1) - 1;
    return { start: start.getTime(), end, label: new Intl.DateTimeFormat('en-KE', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(start) };
  });

  const savingEvents = savings.filter(entry => !entry.reversed && (!entry.status || entry.status === 'verified'))
    .map(entry => ({ at: timestamp(entry.verifiedAt || entry.createdAt), savings: Number(entry.amountCents) || 0, loans: 0 }))
    .filter(entry => entry.at != null && entry.at <= currentTime);
  const loanEvents = [];
  for (const loan of loans) {
    const amount = amountForLoan(loan);
    const fallbackDisbursement = ACTIVE_LOAN_STATUSES.has(loan.status) || loan.status === 'cleared'
      ? (loan.verifiedAt || loan.createdAt) : null;
    const disbursedAt = timestamp(loan.disbursedAt || fallbackDisbursement);
    if (amount > 0 && disbursedAt != null && disbursedAt <= currentTime) loanEvents.push({ at: disbursedAt, savings: 0, loans: amount });
    const clearedAt = timestamp(loan.clearedAt || loan.repaidAt);
    if (amount > 0 && clearedAt != null && clearedAt <= currentTime) loanEvents.push({ at: clearedAt, savings: 0, loans: -amount });
  }
  const events = savingEvents.concat(loanEvents).sort((a, b) => a.at - b.at);
  let savingsCents = 0, loanOutstandingCents = 0, eventIndex = 0;
  const saved = [], loanBalance = [];
  for (const period of periods) {
    while (eventIndex < events.length && events[eventIndex].at <= period.end) {
      savingsCents += events[eventIndex].savings;
      loanOutstandingCents += events[eventIndex].loans;
      eventIndex++;
    }
    saved.push(Math.max(0, savingsCents));
    loanBalance.push(Math.max(0, loanOutstandingCents));
  }

  const pendingSavingsCents = savings.filter(entry => !entry.reversed && entry.status === 'pending')
    .reduce((sum, entry) => sum + (Number(entry.amountCents) || 0), 0);
  const activeLoans = loans.filter(loan => ACTIVE_LOAN_STATUSES.has(loan.status));
  const activeLoanCents = activeLoans.reduce((sum, loan) => sum + amountForLoan(loan), 0);
  const verifiedSavingsCents = savings.filter(entry => !entry.reversed && (!entry.status || entry.status === 'verified'))
    .reduce((sum, entry) => sum + (Number(entry.amountCents) || 0), 0);

  return {
    labels: periods.map(period => period.label),
    series: { savingsCents: saved, loanOutstandingCents: loanBalance },
    summary: { members, verifiedSavingsCents, pendingSavingsCents, activeLoanCents, activeLoans: activeLoans.length },
    periodStart: new Date(firstMonth).toISOString(), updatedAt: current.toISOString()
  };
}

module.exports = { buildTrend };
