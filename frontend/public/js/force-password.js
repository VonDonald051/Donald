'use strict';
document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('force-password-form');
  const error = document.getElementById('err');
  const button = document.getElementById('change-password');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    error.hidden = true;
    button.disabled = true;
    button.textContent = 'Updating…';
    try {
      const result = await api.post('/api/me/password', {
        currentPassword: document.getElementById('current-password').value,
        newPassword: document.getElementById('new-password').value,
        confirmPassword: document.getElementById('confirm-password').value
      });
      location.href = result.home || '/login.html';
    } catch (cause) {
      error.textContent = cause.message;
      error.hidden = false;
      button.disabled = false;
      button.textContent = 'Change password';
    }
  });
  document.getElementById('logout-link').addEventListener('click', async event => {
    event.preventDefault();
    try { await api.post('/api/auth/logout'); } catch {}
    location.href = '/login.html';
  });
});