'use strict';

function buildWeeklyDashboardTrend(db, fromCents, now = new Date()) {
  const labels = [];
  const savings = [];
  const loans = [];

  for (let i = 11; i >= 0; i--) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i * 7));
    const year = date.getUTCFullYear();
    const yearStart = new Date(Date.UTC(year, 0, 1));
    const week = Math.ceil((((date - yearStart) / 86400000) + yearStart.getUTCDay() + 1) / 7);
    const key = `${year}-${week}`;
    labels.push(key);

    const savingsCents = db.savings
      .filter(entry => entry.week === key && !entry.reversed && (!entry.status || entry.status === 'verified'))
      .reduce((total, entry) => total + Number(entry.amountCents || 0), 0);
    const loanCents = db.cashLoans
      .filter(loan => loan.week === key && !['rejected', 'cleared'].includes(loan.status))
      .reduce((total, loan) => total + Number(loan.amountCents || 0), 0)
      + db.itemLoans
        .filter(loan => loan.week === key && !['rejected', 'cleared'].includes(loan.status))
        .reduce((total, loan) => total + Number(loan.costCents || loan.amountCents || 0), 0);

    savings.push(savingsCents);
    loans.push(loanCents);
  }

  return { labels, savings: savings.map(fromCents), loans: loans.map(fromCents) };
}

function exportHistory(db) {
  return db.exports.slice(-250).reverse().map(entry => ({
    id: entry.id, userId: entry.userId, userRole: entry.userRole,
    type: entry.type, target: entry.target, format: entry.format, at: entry.at
  }));
}

module.exports = { buildWeeklyDashboardTrend, exportHistory };
