'use strict';
document.addEventListener('DOMContentLoaded', () => {
  const f = document.getElementById('f'), err = document.getElementById('err'), done = document.getElementById('done');
  f.addEventListener('submit', async e => {
    e.preventDefault(); err.hidden = true;
    const go = document.getElementById('go'); go.disabled = true; go.textContent = 'Sending…';
    try {
      await api.post('/api/auth/forgot', { email: document.getElementById('email').value });
      done.hidden = false; f.hidden = true;
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
    finally { go.disabled = false; go.textContent = 'Send reset link'; }
  });
});
