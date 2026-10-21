'use strict';
/* End-to-end chat encryption: ECDH P-256 key agreement -> AES-256-GCM.
 * Private keys NEVER leave this browser; the server only stores/relays ciphertext. */
const E2E = (() => {
  const SU = window.crypto.subtle;
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0)).buffer;

  async function ensurePair() {
    const raw = localStorage.getItem('vd_e2e');
    if (raw) {
      try {
        const j = JSON.parse(raw);
        const priv = await SU.importKey('jwk', j.priv, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
        return { priv, pub: j.pubStr };
      } catch { localStorage.removeItem('vd_e2e'); }
    }
    const kp = await SU.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
    const pubJwk = await SU.exportKey('jwk', kp.publicKey);
    const privJwk = await SU.exportKey('jwk', kp.privateKey);
    const pubStr = JSON.stringify(pubJwk);
    localStorage.setItem('vd_e2e', JSON.stringify({ priv: privJwk, pubStr }));
    return { priv: kp.privateKey, pub: pubStr };
  }

  async function uploadPub(pubStr) {
    try { await api.post('/api/me/pubkey', { jwk: pubStr }); } catch { /* will retry next load */ }
  }

  async function chatKey(priv, peerPubStr) {
    const pub = await SU.importKey('jwk', JSON.parse(peerPubStr), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    return SU.deriveKey({ name: 'ECDH', public: pub }, priv, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function encrypt(key, text) {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const ct = await SU.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
    return { iv: b64(iv.buffer), ct: b64(ct) };
  }

  async function decrypt(key, ivB64, ctB64) {
    const pt = await SU.decrypt({ name: 'AES-GCM', iv: new Uint8Array(unb64(ivB64)) }, key, unb64(ctB64));
    return new TextDecoder().decode(pt);
  }

  return { ensurePair, uploadPub, chatKey, encrypt, decrypt };
})();
