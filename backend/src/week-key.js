'use strict';

function currentWeekKey(date = new Date()) {
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - start) / 86400000) + start.getUTCDay() + 1) / 7);
  return `${date.getUTCFullYear()}-${week}`;
}

module.exports = { currentWeekKey };
