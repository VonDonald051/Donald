'use strict';
/* Tiny WebSocket client for the built-in realtime hub (no socket.io needed).
 * JSON envelopes {e: event, d: data}, auto-reconnect with backoff.
 * Patch 3: loan and fine realtime updates. */
const WS = (() => {
  let ws = null, open = false, queue = [], retryMs = 1500, url = null, socketPath = null, stopped = false;
  const handlers = {};

  function connect(path) {
    stopped = false;
    socketPath = path || socketPath || '/rt';
    let requestedUrl;
    if (window.API_BASE_URL) {
      const apiOrigin = new URL(window.API_BASE_URL, location.href);
      apiOrigin.protocol = apiOrigin.protocol === 'https:' ? 'wss:' : 'ws:';
      apiOrigin.pathname = socketPath;
      apiOrigin.search = '';
      apiOrigin.hash = '';
      requestedUrl = apiOrigin.href;
    } else {
      requestedUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + socketPath;
    }
    if (ws && url === requestedUrl && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
    url = requestedUrl;
    try { ws = new WebSocket(url); } catch { return schedule(); }
    ws.onopen = () => {
      open = true; retryMs = 1500;
      queue.forEach(o => { try { ws.send(JSON.stringify(o)); } catch { } });
      queue = [];
      handlers.open && handlers.open();
    };
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(m.data); } catch { return; }
      if (msg && typeof msg.e === 'string' && handlers[msg.e]) {
        try { handlers[msg.e](msg.d); } catch (e) { console.error(e); }
      }
    };
    ws.onerror = () => { try { ws.close(); } catch { } };
    ws.onclose = () => { if (open) { open = false; handlers.close && handlers.close(); } if (!stopped) schedule(); };
  }
  function schedule() {
    setTimeout(() => { retryMs = Math.min(retryMs * 1.6, 15000); connect(socketPath || '/rt'); }, retryMs);
  }
  function on(e, f) { handlers[e] = f; }
  function disconnect() { stopped = true; queue = []; if (ws) { try { ws.close(); } catch {} } }
  function emit(e, d) {
    const o = { e, d: d == null ? null : d };
    if (open) { try { ws.send(JSON.stringify(o)); } catch { queue.push(o); } }
    else queue.push(o);
  }
  on('auth:revoked', () => { stopped = true; queue = []; });
  return { connect, on, emit, disconnect };
})();
