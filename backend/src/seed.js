'use strict';

function genCode() {
  const crypto = require('crypto');
  const segment = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `VD-${segment()}-${segment()}`;
}

module.exports.genCode = genCode;