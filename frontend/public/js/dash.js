'use strict';
/* Shared dashboard chrome: static left flex nav, profile section, notifications renderer. */
const DASH = (() => {

  function applyBranding(branding, role) {
    if (!branding) return;
    const brandText = document.getElementById('brand-txt');
    if (brandText && branding.name) {
      const suffix = String(brandText.textContent || '').match(/\s·\s.*$/)?.[0] || '';
      brandText.textContent = branding.name + suffix;
    }
    const host = document.querySelector('.brand');
    if (host) {
      let logo = host.querySelector('.brand-logo');
      if (branding.logo) {
        if (!logo) { logo = h('img', { class: 'brand-logo', alt: '' }); host.prepend(logo); }
        logo.src = branding.logo;
        const dot = host.querySelector('.dot'); if (dot) dot.hidden = true;
      } else {
        if (logo) logo.remove();
        const dot = host.querySelector('.dot'); if (dot) dot.hidden = false;
      }
    }
    const colors = branding.colors && branding.colors[role];
    if (!colors) return;
    const bg = colors.background;
    const rgb = bg.match(/^#([0-9a-f]{6})$/i);
    if (!rgb) return;
    const channels = rgb[1].match(/../g).map(value => parseInt(value, 16));
    const luminance = channels.map(value => { const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
    const dark = luminance < .35;
    const [r, g, b] = colors.accent.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i).slice(1).map(value => parseInt(value, 16));
    const style = document.body.style;
    style.setProperty('--bg', bg);
    style.setProperty('--acc', colors.accent);
    style.setProperty('--accSoft', `rgba(${r},${g},${b},.15)`);
    style.setProperty('--txt', dark ? '#f1f4f8' : '#202832');
    style.setProperty('--mut', dark ? '#aab4c1' : '#596775');
    style.setProperty('--panel', dark ? 'rgba(255,255,255,.075)' : 'rgba(255,255,255,.78)');
    style.setProperty('--line', dark ? 'rgba(255,255,255,.16)' : 'rgba(25,43,57,.16)');
    style.background = bg;
    document.body.dataset.ownerColors = '1';
  }

  function buildChrome(me, brand, navDef, onSwitch, branding) {
    document.getElementById('u-name').textContent = me.name;
    document.getElementById('u-role').textContent = me.role.replace(/_/g, ' ');
    const img = document.getElementById('u-pic');
    img.src = me.pic || DEFPIC;
    img.onerror = () => { img.src = DEFPIC; };
    document.getElementById('brand-txt').textContent = brand;
    applyBranding(branding, me.role);
    if (typeof WS !== 'undefined') {
      WS.on('branding:updated', update => applyBranding(update, me.role));
      WS.connect('/rt');
    }
    const nav = document.getElementById('nav');
    navDef.forEach(([id, ico, label], i) => {
      const a = h('a', { class: 'navlink' + (i === 0 ? ' on' : ''), 'data-v': id, href: '#' },
        h('span', { class: 'ico' }, ico), h('span', { class: 'lbl' }, label));
      a.addEventListener('click', e => {
        e.preventDefault();
        document.querySelectorAll('.navlink').forEach(x => x.classList.remove('on'));
        a.classList.add('on');
        document.querySelectorAll('.view').forEach(x => x.classList.remove('on'));
        const v = document.getElementById('view-' + id);
        if (v) v.classList.add('on');
        onSwitch && onSwitch(id);
      });
      nav.append(a);
    });
    document.getElementById('logout').addEventListener('click', async e => {
      e.preventDefault();
      try { await api.post('/api/auth/logout'); } catch { }
      location.href = '/login.html';
    });
  }

  /* profile view (same for every role): picture upload + change password */
  function wireProfile(me) {
    const box = document.getElementById('view-profile');
    box.innerHTML = '';
    const bigImg = h('img', { src: me.pic || DEFPIC, alt: 'profile picture', style: 'width:96px;height:96px;border-radius:50%;object-fit:cover;border:3px solid var(--acc)' });
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg', class: 'inp', style: 'max-width:340px' });
    const upBtn = h('button', { class: 'btn' }, 'Upload picture');
    const info = h('div', { class: 'kv mt' },
      h('div', { class: 'k' }, 'Name'), h('div', {}, me.name),
      h('div', { class: 'k' }, 'Email'), h('div', {}, me.email),
      h('div', { class: 'k' }, 'Phone'), h('div', {}, me.phone || '-'),
      h('div', { class: 'k' }, 'Role'), h('div', { style: 'text-transform:capitalize' }, me.role.replace(/_/g, ' ')));
    const cur = h('input', { type: 'password', class: 'inp', placeholder: 'Current password', autocomplete: 'current-password' });
    const nw = h('input', { type: 'password', class: 'inp', placeholder: 'New password (9+ chars, upper/lower/digit/symbol)', autocomplete: 'new-password' });
    const cf = h('input', { type: 'password', class: 'inp', placeholder: 'Confirm new password', autocomplete: 'new-password' });
    const chg = h('button', { class: 'btn ghost' }, 'Change password');
    const firstName = h('input', { class: 'inp', maxlength: '60', value: me.firstName || '', autocomplete: 'given-name' });
    const lastName = h('input', { class: 'inp', maxlength: '60', value: me.lastName || '', autocomplete: 'family-name' });
    const email = h('input', { class: 'inp', type: 'email', maxlength: '120', value: me.email || '', autocomplete: 'email' });
    const phone = h('input', { class: 'inp', type: 'tel', maxlength: '30', value: me.phone || '', autocomplete: 'tel' });
    const reauth = h('input', { class: 'inp', type: 'password', placeholder: 'Current password (required for email or phone changes)', autocomplete: 'current-password' });
    const saveProfile = h('button', { class: 'btn' }, 'Save profile');

    upBtn.addEventListener('click', async () => {
      if (!file.files[0]) return toast('Choose a PNG/JPG/WEBP image first (max 2MB)', 'err');
      if (file.files[0].size > 2 * 1024 * 1024) return toast('Image too large (max 2MB)', 'err');
      const fd = new FormData(); fd.append('pic', file.files[0]);
      try {
        const r = await api.upload('/api/me/picture', fd);
        bigImg.src = r.pic + '?t=' + Date.now();
        const navImg = document.getElementById('u-pic'); if (navImg) navImg.src = bigImg.src;
        toast('Profile picture updated');
      } catch (e) { toast(e.message, 'err'); }
    });
    chg.addEventListener('click', async () => {
      try {
        await api.post('/api/me/password', { currentPassword: cur.value, newPassword: nw.value, confirmPassword: cf.value });
        cur.value = nw.value = cf.value = '';
        toast('Password changed');
      } catch (e) { toast(e.message, 'err'); }
    });
    saveProfile.addEventListener('click', async () => {
      try {
        const result = await api.put('/api/me/profile', {
          firstName: firstName.value, lastName: lastName.value,
          email: email.value, phone: phone.value, currentPassword: reauth.value
        });
        Object.assign(me, result.me);
        document.getElementById('u-name').textContent = result.me.name;
        document.getElementById('u-role').textContent = result.me.role.replace(/_/g, ' ');
        reauth.value = '';
        toast('Profile updated');
      } catch (e) { toast(e.message, 'err'); }
    });

    box.append(
      h('div', { class: 'hdr' }, h('div', {}, h('h2', {}, 'My Profile'), h('div', { class: 'sub' }, 'Your picture and password'))),
      h('div', { class: 'grid cols2' },
        h('div', { class: 'card' }, h('h3', { class: 'mb' }, 'Profile picture'),
          h('div', { class: 'btnrow' }, bigImg),
          h('div', { class: 'mt btnrow', style: 'flex-direction:column;align-items:flex-start;gap:8px' }, file, upBtn)),
        h('div', { class: 'card' }, h('h3', { class: 'mb' }, 'Account'), info)),
      h('div', { class: 'card mt' }, h('h3', { class: 'mb' }, 'Editable profile details'),
        h('div', { class: 'grid cols2' },
          h('div', {}, h('label', { class: 'f' }, 'First name'), firstName),
          h('div', {}, h('label', { class: 'f' }, 'Last name'), lastName),
          h('div', {}, h('label', { class: 'f' }, 'Email'), email),
          h('div', {}, h('label', { class: 'f' }, 'Phone'), phone)),
        h('div', { class: 'mt' }, reauth, saveProfile)),
      h('div', { class: 'card mt' }, h('h3', { class: 'mb' }, 'Change password'),
        h('div', { class: 'grid cols3' },
          h('div', {}, h('label', { class: 'f' }, 'Current'), cur),
          h('div', {}, h('label', { class: 'f' }, 'New'), nw),
          h('div', {}, h('label', { class: 'f' }, 'Confirm'), cf)),
        h('div', { class: 'mt' }, chg))
    );
  }

  /* shared notifications list renderer (uses /api/me/notifications) */
  async function renderNotifications(box) {
    box.innerHTML = '<div class="muted small">Loading…</div>';
    try {
      const { notifications } = await api.get('/api/me/notifications');
      box.innerHTML = '';
      if (!notifications.length) { box.append(h('div', { class: 'muted small' }, 'No notifications yet.')); return; }
      for (const n of notifications.reverse ? notifications : []) {
        const card = h('div', { class: 'notif' + (n.read ? '' : ' unread') },
          h('div', { class: 't' }, n.title, n.type === 'email' ? h('span', { class: 'tagEmail' }, 'EMAIL') : null),
          h('div', { class: 'b' }, n.body), h('div', { class: 'w' }, fmtDate(n.at)));
        card.addEventListener('click', async () => {
          if (card.classList.contains('unread')) {
            try { await api.post('/api/me/notifications/' + n.id + '/read'); } catch { }
            card.classList.remove('unread');
          }
        });
        box.append(card);
      }
    } catch (e) { box.innerHTML = ''; box.append(h('div', { class: 'muted small' }, e.message)); }
  }

  function notifView(boxId) {
    const box = document.getElementById(boxId);
    box.innerHTML = '';
    box.append(
      h('div', { class: 'hdr' }, h('div', {}, h('h2', {}, 'Notifications'), h('div', { class: 'sub' }, 'Tap an item to mark it as read'))),
      h('div', { id: boxId + '-list' }));
    return () => renderNotifications(document.getElementById(boxId + '-list'));
  }

  return { buildChrome, applyBranding, wireProfile, notifView };
})();
