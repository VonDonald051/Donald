'use strict';
document.addEventListener('DOMContentLoaded', () => {
  const err = document.getElementById('err'), done = document.getElementById('done'), f = document.getElementById('f');
  const token = new URLSearchParams(location.search).get('token') || '';
  if (!token) { err.textContent = 'Missing reset token. Use the link from your email.'; err.hidden = false; f.hidden = true; }
  f.addEventListener('submit', async e => {
    e.preventDefault(); err.hidden = true;
    try {
      await api.post('/api/auth/reset', {
        token,
        password: document.getElementById('password').value,
        confirmPassword: document.getElementById('confirm').value
      });
      f.hidden = true; done.innerHTML = '';
      done.append('Password updated. ', h('a', { href: '/login.html' }, 'Login →'));
      done.hidden = false;
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });
});
