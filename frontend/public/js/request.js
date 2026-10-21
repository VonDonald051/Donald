'use strict';
document.addEventListener('DOMContentLoaded', async () => {
  const $ = id => document.getElementById(id);
  const sel = $('groupId');
  try {
    const { groups } = await api.get('/api/auth/groups');
    sel.append(h('option', { value: '' }, '— choose a group to join —'));
    groups.forEach(g => sel.append(h('option', { value: g.id }, g.name)));
  } catch { sel.append(h('option', { value: '' }, 'Could not load groups — retry later')); }

  $('f').addEventListener('submit', async e => {
    e.preventDefault();
    ['e-firstName', 'e-lastName', 'e-email', 'e-phone', 'e-groupId'].forEach(i => { $(i).textContent = ''; });
    $('err').hidden = true; $('done').hidden = true;
    const go = $('go'); go.disabled = true; go.textContent = 'Sending…';
    try {
      await api.post('/api/auth/request-access', {
        firstName: $('firstName').value, lastName: $('lastName').value,
        email: $('email').value, phone: $('phone').value,
        groupId: sel.value, note: $('note').value
      });
      $('f').hidden = true;
      $('done').textContent = 'Request sent. The Group Admin will generate your one-time Safe Code and share it with you (you will also receive an email when email is configured).';
      $('done').hidden = false;
    } catch (ex) {
      const errs = ex.data && ex.data.errors;
      if (errs) for (const [k, v] of Object.entries(errs)) { const box = $('e-' + k); if (box) box.textContent = v; else { $('err').textContent = v; $('err').hidden = false; } }
      else { $('err').textContent = ex.message; $('err').hidden = false; }
    } finally { go.disabled = false; go.textContent = 'Send Request'; }
  });
});
