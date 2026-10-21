'use strict';
document.addEventListener('DOMContentLoaded', () => {
  const f = document.getElementById('f');
  const err = document.getElementById('err');
  const go = document.getElementById('go');
  const pw = document.getElementById('password');
  const peek = document.getElementById('peek');
  const phoneStep = document.getElementById('phone-step');
  const phoneForm = document.getElementById('phone-form');
  const phoneGo = document.getElementById('phone-go');
  const googleButton = document.getElementById('google-login');
  const googleSeparator = document.getElementById('google-separator');

  api.get('/api/auth/branding').then(({ branding }) => {
    if (!branding) return;
    const name = branding.name || 'Savings System';
    document.title = `Login · ${name}`;
    const heading = document.getElementById('login-brand-name');
    if (heading) heading.textContent = name;
    const logo = document.getElementById('login-brand-logo');
    if (logo && branding.logo) { logo.src = branding.logo; logo.hidden = false; }
  }).catch(() => {});

  const showPhoneStep = (phone) => {
    f.hidden = true;
    phoneStep.hidden = false;
    googleButton.hidden = true;
    googleSeparator.hidden = true;
    if (phone) document.getElementById('phone-hint').textContent = `Enter the one-time passcode sent to ${phone}.`;
    document.getElementById('phone-code').focus();
  };

  api.get('/api/auth/google/config').then((config) => {
    googleButton.classList.toggle('google-disabled', !config.available);
    googleButton.setAttribute('aria-disabled', String(!config.available));
  }).catch(() => {});

  googleButton.addEventListener('click', (event) => {
    if (googleButton.getAttribute('aria-disabled') !== 'true') return;
    event.preventDefault();
    err.textContent = 'Google sign-in needs OAuth and phone verification credentials configured for this server.';
    err.hidden = false;
  });

  const params = new URLSearchParams(location.search);
  if (params.get('phone_verification') === '1') showPhoneStep();
  const authErrors = {
    google_unavailable: 'Google sign-in is not configured for this server yet.',
    google_cancelled: 'Google sign-in was cancelled.',
    account_unavailable: 'This Google account is not linked to an active system account.',
    google_failed: 'Google sign-in could not be verified. Please try again.'
  };
  if (authErrors[params.get('auth_error')]) {
    err.textContent = authErrors[params.get('auth_error')];
    err.hidden = false;
  }

  peek.addEventListener('click', () => { pw.type = pw.type === 'password' ? 'text' : 'password'; });

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    go.disabled = true;
    go.textContent = 'Signing in…';
    try {
      const body = {
        email: document.getElementById('email').value.trim(),
        password: pw.value,
        remember: document.getElementById('remember').checked
      };
      const r = await api.post('/api/auth/login', body);
      if (r.phoneVerification) {
        showPhoneStep(r.phone);
        err.hidden = true;
        return;
      }
      location.href = r.home || '/login.html';
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      go.disabled = false;
      go.textContent = 'Login';
    }
  });

  phoneForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.hidden = true;
    phoneGo.disabled = true;
    phoneGo.textContent = 'Verifying…';
    try {
      const result = await api.post('/api/auth/phone/verify', { code: document.getElementById('phone-code').value.trim() });
      location.href = result.home || '/login.html';
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      phoneGo.disabled = false;
      phoneGo.textContent = 'Verify passcode';
    }
  });
});
