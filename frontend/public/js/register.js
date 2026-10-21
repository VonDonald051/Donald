'use strict';
document.addEventListener('DOMContentLoaded', () => {
  const $ = id => document.getElementById(id);
  const pw = $('password'), cf = $('confirmPassword');

  $('peek1').addEventListener('click', () => { pw.type = pw.type === 'password' ? 'text' : 'password'; });

  $('f').addEventListener('submit', async e => {
    e.preventDefault();
    ['err', 'e-firstName', 'e-lastName', 'e-email', 'e-phone', 'e-safeCode', 'e-password'].forEach(i => { $(i).textContent = ''; if (i === 'err') $(i).hidden = true; });
    $('done').hidden = true;
    const go = $('go'); go.disabled = true; go.textContent = 'Creating account…';
    try {
      await api.post('/api/auth/register', {
        firstName: $('firstName').value, lastName: $('lastName').value,
        email: $('email').value, phone: $('phone').value,
        safeCode: $('safeCode').value,
        password: pw.value, confirmPassword: cf.value
      });
      $('f').hidden = true;
      const d = $('done');
      d.innerHTML = '';
      d.append('Account created and safe code consumed. ');
      d.append(h('a', { href: '/login.html' }, 'Login now →'));
      d.hidden = false;
    } catch (ex) {
      const errs = ex.data && ex.data.errors;
      if (errs) {
        for (const [k, v] of Object.entries(errs)) {
          const box = $('e-' + k);
          if (box) box.textContent = v; else { $('err').textContent = v; $('err').hidden = false; }
        }
      } else { $('err').textContent = ex.message; $('err').hidden = false; }
    } finally { go.disabled = false; go.textContent = 'Register'; }
  });
});
