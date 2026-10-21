'use strict';
/* Encrypted chat UI (member <-> group admin) + WebRTC video calls (registered users only).
 * Every message is AES-GCM encrypted in this browser before it leaves (server sees ciphertext only). */
const CHAT = (() => {
  let me, myPair, peer = null, peerKey = null, socket = null, poll = null, typed = 0;

  // ---------- WebRTC state ----------
  let pc = null, localStream = null, callWith = null, callActive = false;

  const $ = id => document.getElementById(id);
  const RTC_CFG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  function openCallModal(title) { $('callTitle').textContent = title; $('callModal').classList.add('on'); }
  function closeCallModal() { $('callModal').classList.remove('on'); }

  function setCallButtons(state) {
    $('btnAccept').style.display = state === 'incoming' ? '' : 'none';
    $('btnDecline').style.display = state === 'incoming' ? '' : 'none';
    $('btnEnd').style.display = (state === 'incall' || state === 'calling') ? '' : 'none';
  }

  async function getMedia() {
    if (localStream) return localStream;
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    $('localV').srcObject = localStream;
    return localStream;
  }

  function newPC(otherId) {
    pc = new RTCPeerConnection(RTC_CFG);
    localStream.getTracks().forEach(tr => pc.addTrack(tr, localStream));
    pc.onicecandidate = e => { if (e.candidate) socket.emit('call:ice', { to: otherId, candidate: e.candidate }); };
    pc.ontrack = e => { $('remoteV').srcObject = e.streams[0]; };
    pc.onconnectionstatechange = () => {
      if (pc && ['failed', 'disconnected', 'closed'].includes(pc.connectionState)) endCall(false, 'connection ' + pc.connectionState);
    };
  }

  async function startCall() {
    if (!peer) return toast('Select a chat contact first', 'err');
    try {
      callWith = peer.id; callActive = false;
      openCallModal('Calling ' + peer.name + '…'); setCallButtons('calling');
      $('callStatus').textContent = 'Ringing… waiting for answer';
      await getMedia();
      newPC(peer.id);
      socket.emit('call:invite', { to: peer.id });
    } catch (e) { toast('Camera/mic needed for video calls: ' + e.message, 'err'); endCall(false); }
  }

  async function acceptCall() {
    try {
      $('callStatus').textContent = 'Connecting…';
      await getMedia();
      newPC(callWith);
      socket.emit('call:accept', { to: callWith });
      setCallButtons('incall');
    } catch (e) { toast('Camera/mic needed: ' + e.message, 'err'); socket.emit('call:decline', { to: callWith }); closeCallModal(); }
  }

  function endCall(notify, reason) {
    if (notify && callWith) socket.emit('call:end', { to: callWith });
    try { if (pc) pc.close(); } catch { }
    pc = null;
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    $('localV').srcObject = null; $('remoteV').srcObject = null;
    callWith = null; callActive = false;
    closeCallModal();
    if (reason) toast('Call ' + reason);
  }

  function wireSocket() {
    WS.connect('/rt');
    socket = WS;
    socket.on('chat:new', d => { if (peer && d.from === peer.id && !d.echo) loadMessages(); else if (d.from !== (peer && peer.id) && !d.echo) toast('🔒 New encrypted message'); });
    socket.on('chat:typing', d => {
      if (peer && d.from === peer.id) {
        $('cTyping').textContent = peer.name + ' is typing…';
        clearTimeout(typed); typed = setTimeout(() => { $('cTyping').textContent = ''; }, 2500);
      }
    });
    socket.on('call:incoming', d => {
      callWith = d.from.id;
      openCallModal('Incoming video call'); setCallButtons('incoming');
      $('callStatus').textContent = d.from.name + ' is calling you';
      $('callStatus').classList.add('pulse');
    });
    socket.on('call:accepted', async () => {
      $('callStatus').classList.remove('pulse');
      $('callStatus').textContent = 'Connected';
      setCallButtons('incall'); callActive = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('call:offer', { to: callWith, sdp: offer });
    });
    socket.on('call:offer', async d => {
      await pc.setRemoteDescription(d.sdp);
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      socket.emit('call:answer', { to: callWith, sdp: ans });
      $('callStatus').classList.remove('pulse');
      $('callStatus').textContent = 'Connected';
      setCallButtons('incall'); callActive = true;
    });
    socket.on('call:answer', async d => { if (pc) await pc.setRemoteDescription(d.sdp); });
    socket.on('call:ice', async d => { try { if (pc && d.candidate) await pc.addIceCandidate(d.candidate); } catch { } });
    socket.on('call:ended', d => { endCall(false, d.reason || 'ended'); });
    socket.on('call:error', d => { toast(d.error, 'err'); endCall(false); });
  }

  function setupChatLayout() {
    const root = $('cList');
    if (root.closest('.chatwrap')) root.closest('.chatwrap').id = 'chatWrap';
    root.classList.add('chat-sidebar');
    root.replaceChildren(
      h('div', { class: 'chat-sidebar-head' },
        h('div', { class: 'chat-sidebar-title' }, h('h3', {}, 'Chats'), h('span', { class: 'chat-lock' }, '🔒 Private')),
        h('label', { class: 'chat-search' }, h('span', { 'aria-hidden': 'true' }, '⌕'),
          h('input', { id: 'cSearch', type: 'search', placeholder: 'Search conversations', autocomplete: 'off', 'aria-label': 'Search conversations' }))
      ),
      h('div', { class: 'chat-contact-list', id: 'cContactList' })
    );
    $('cSearch').addEventListener('input', filterContacts);

    const header = document.querySelector('.chathead');
    if (header && !$('cBack')) {
      const back = h('button', { id: 'cBack', class: 'chat-back', type: 'button', 'aria-label': 'Back to chats' }, '‹');
      header.querySelector('.who2')?.before(back);
      back.addEventListener('click', () => $('chatWrap')?.classList.add('mobile-list'));
    }
    $('chatWrap')?.classList.add('mobile-list');
  }

  function filterContacts() {
    const query = $('cSearch').value.trim().toLocaleLowerCase();
    document.querySelectorAll('#cContactList .citem').forEach(row => {
      row.hidden = !row.dataset.search.includes(query);
    });
  }

  // ---------- contacts ----------
  async function loadContacts() {
    const { contacts } = await api.get('/api/chat/contacts');
    setupChatLayout();
    const box = $('cContactList'); box.replaceChildren();
    if (!contacts.length) { box.append(h('div', { class: 'chat-no-contacts' }, h('div', { class: 'chat-empty-icon' }, '☏'), h('strong', {}, 'No conversations yet'), h('span', {}, 'Available contacts will appear here.'))); return; }
    contacts.forEach(c => {
      const it = h('button', { class: 'citem' + (peer && peer.id === c.id ? ' on' : ''), type: 'button' },
        pic(c.pic, ''), h('span', { class: 'citem-copy' },
          h('span', { class: 'citem-top' }, h('span', { class: 'n' }, c.name), h('span', { class: 'contact-role' }, c.role.replaceAll('_', ' '))),
          h('span', { class: 'r' }, 'End-to-end encrypted')));
      it.dataset.search = `${c.name} ${c.role.replaceAll('_', ' ')}`.toLocaleLowerCase();
      it.addEventListener('click', () => selectPeer(c));
      box.append(it);
    });
    filterContacts();
    if (!peer && contacts.length) selectPeer(contacts[0]);
  }

  async function selectPeer(c) {
    peer = c; peerKey = null;
    $('chatWrap')?.classList.remove('mobile-list');
    document.querySelectorAll('.citem').forEach(x => x.classList.remove('on'));
    loadContacts2Highlight();
    $('cPeerName').textContent = c.name;
    $('cPeerPic').src = c.pic || DEFPIC;
    $('cMsgs').innerHTML = '';
    $('cCall').disabled = false;
    $('cInput').disabled = false; $('cSend').disabled = false;
    if (!c.pub) {
      $('cMsgs').append(h('div', { class: 'sysline' }, '⚠ ' + c.name + ' has not opened chat yet — encryption key unavailable. Ask them to log in once.'));
    } else {
      peerKey = await E2E.chatKey(myPair.priv, c.pub);
    }
    await loadMessages();
  }
  function loadContacts2Highlight() {
    const items = document.querySelectorAll('#cContactList .citem .n');
    items.forEach(n => { if (peer && n.textContent === peer.name) n.closest('.citem').classList.add('on'); });
  }

  async function loadMessages() {
    if (!peer) return;
    const { messages } = await api.get('/api/chat/with/' + peer.id);
    const box = $('cMsgs');
    box.innerHTML = '';
    let previousDay = '';
    if (!messages.length) box.append(h('div', { class: 'chat-welcome' },
      h('div', { class: 'chat-welcome-mark' }, '🔒'),
      h('strong', {}, 'Your messages are private'),
      h('span', {}, 'Messages are encrypted on this device before they are sent. Say hello to start the conversation.')));
    for (const m of messages) {
      const date = new Date(m.at);
      const day = date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      if (day !== previousDay) {
        box.append(h('div', { class: 'chat-day' }, h('span', {}, day)));
        previousDay = day;
      }
      let text;
      try {
        text = peerKey ? await E2E.decrypt(peerKey, m.iv, m.ct) : '🔒 [key unavailable]';
      } catch { text = '🔒 [cannot decrypt on this device]'; }
      const bub = h('div', { class: 'bub ' + (m.from === me.id ? 'me' : 'them') },
        h('span', { class: 'bubble-text' }, text),
        h('span', { class: 'tm' }, date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
      box.append(bub);
    }
    box.scrollTop = box.scrollHeight;
  }

  async function send() {
    const inp = $('cInput');
    const text = inp.value.trim();
    if (!text) return;
    if (!peer) return toast('Pick a contact first', 'err');
    if (!peerKey) return toast('Cannot encrypt: peer has not published a key yet', 'err');
    inp.value = '';
    try {
      const payload = await E2E.encrypt(peerKey, text);
      await api.post('/api/chat/send', { peerId: peer.id, iv: payload.iv, ct: payload.ct });
      await loadMessages();
    } catch (e) { toast(e.message, 'err'); inp.value = text; }
  }

  async function init(meInfo) {
    me = meInfo;
    myPair = await E2E.ensurePair();
    await E2E.uploadPub(myPair.pub); // keep server copy of my public key fresh
    wireSocket();
    await loadContacts();
    poll = setInterval(() => { if (peer) loadMessages(); }, 5000);

    $('cSend').addEventListener('click', send);
    setupComposer();
    let lastType = 0;
    $('cInput').addEventListener('input', () => {
      const n = Date.now();
      if (peer && n - lastType > 1800) { lastType = n; socket.emit('chat:typing', { to: peer.id }); }
    });
    $('cCall').addEventListener('click', startCall);
    $('btnAccept').addEventListener('click', acceptCall);
    $('btnDecline').addEventListener('click', () => { socket.emit('call:decline', { to: callWith }); endCall(false, 'declined'); });
    $('btnEnd').addEventListener('click', () => endCall(true));
  }

  function setupComposer() {
    const oldInput = $('cInput');
    const area = h('textarea', { id: 'cInput', class: oldInput.className, placeholder: 'Type a message', rows: '1', 'aria-label': 'Message' });
    area.disabled = oldInput.disabled;
    oldInput.replaceWith(area);
    area.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    area.addEventListener('input', () => {
      area.style.height = 'auto';
      area.style.height = `${Math.min(area.scrollHeight, 120)}px`;
    });
  }

  return { init };
})();
