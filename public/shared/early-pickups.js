/* Shared Early Pickups component.
 *
 * Usage (counselor or admin portal):
 *
 *   EarlyPickups.mount(container, {
 *     getToken:    () => currentAccessToken,
 *     getUserId:   () => currentUserId,   // integer
 *     getUserName: () => currentUserName,
 *     onAuthError: () => logout(),
 *   });
 *
 * The component owns its SSE connection, poll fallback, and DOM inside the
 * container. Call EarlyPickups.unmount() on logout to close the stream.
 *
 * Claim UX:
 *   - Others see "✓ Claimed by {Name}" for 1.5s, then the row disappears.
 *   - The claimer sees "✓ Claimed by me" with an Undo link for 5s, long
 *     enough to recover from a mis-tap, before the row disappears locally.
 *   - Undo calls /unclaim which re-broadcasts the pickup to everyone.
 */
(function (global) {
  'use strict';

  const POLL_INTERVAL_MS = 3000;
  const PUBLIC_FADE_MS   = 1500;   // "Claimed by X" flash shown to others
  const CLAIMER_WINDOW_MS = 5000;  // How long the claimer keeps the Undo link

  let opts = null;
  let container = null;
  let listEl = null;
  let statusEl = null;
  let countEl = null;

  // id -> { pickup, state, timeoutId }
  //   state: 'unclaimed' | 'claiming' | 'claimed-by-me' | 'claimed-by-other'
  const pickups = new Map();

  let sse = null;
  let sseFails = 0;
  let pollTimer = null;
  let usingPolling = false;
  // Delay before we demote the status pill from "Live" to "Offline" on an SSE
  // error. EventSource auto-reconnects within ~3s on a transient blip, and
  // flipping the pill every time caused the admin to keep seeing "Offline"
  // flash across the screen even though the stream was fine.
  const OFFLINE_GRACE_MS = 4000;
  let offlineTimer = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    const am = h < 12 ? 'AM' : 'PM';
    h = h % 12 || 12;
    return `${h}:${m} ${am}`;
  }

  function buildShell() {
    container.innerHTML = `
      <section class="ep-section" aria-live="polite">
        <div class="ep-header">
          <span class="ep-header-icon" aria-hidden="true">🕒</span>
          <span class="ep-header-title">Early Pickups</span>
          <span class="ep-status" data-ep-status title="Live connection">Live</span>
          <span class="ep-header-count zero" data-ep-count>0</span>
        </div>
        <div class="ep-list" data-ep-list></div>
      </section>
      <div class="ep-toast" data-ep-toast role="status" aria-live="polite"></div>
    `;
    listEl = container.querySelector('[data-ep-list]');
    statusEl = container.querySelector('[data-ep-status]');
    countEl = container.querySelector('[data-ep-count]');
  }

  function setConnectionStatus(state) {
    if (!statusEl) return;
    if (state === 'connected') {
      if (offlineTimer) { clearTimeout(offlineTimer); offlineTimer = null; }
      statusEl.classList.remove('disconnected');
      statusEl.textContent = 'Live';
      return;
    }
    if (state === 'disconnected') {
      statusEl.classList.add('disconnected');
      statusEl.textContent = usingPolling ? 'Polling' : 'Offline';
      return;
    }
    // 'reconnecting': hold "Live" for a few seconds before flipping to
    // "Offline". EventSource fires 'error' on every proxy renewal and keep-
    // alive blip and reconnects on its own — users should only see the pill
    // demote if the outage actually sticks.
    if (offlineTimer) return;
    offlineTimer = setTimeout(() => {
      offlineTimer = null;
      if (!sse || sse.readyState !== 1 /* OPEN */) {
        statusEl.classList.add('disconnected');
        statusEl.textContent = usingPolling ? 'Polling' : 'Offline';
      }
    }, OFFLINE_GRACE_MS);
  }

  function toast(msg, isError) {
    const el = container && container.querySelector('[data-ep-toast]');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2600);
  }

  function renderAll() {
    if (!listEl) return;
    const sorted = [...pickups.values()]
      .map(r => r.pickup)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    const unclaimedCount = [...pickups.values()].filter(r => r.state !== 'claimed-by-other').length;
    if (countEl) {
      countEl.textContent = String(unclaimedCount);
      countEl.classList.toggle('zero', unclaimedCount === 0);
    }

    if (sorted.length === 0) {
      listEl.innerHTML = `
        <div class="ep-empty">
          <div class="ep-empty-icon" aria-hidden="true">✅</div>
          <div class="ep-empty-title">All clear</div>
          <div class="ep-empty-sub">No parents are waiting right now.</div>
        </div>`;
      return;
    }

    listEl.innerHTML = sorted.map(p => cardHtml(p)).join('');
  }

  function cardHtml(p) {
    const rec = pickups.get(p.id);
    const state = rec ? rec.state : 'unclaimed';
    const message = `<strong>${esc(p.parent_name)}</strong> has arrived to pick up <strong>${esc(p.child_name)}</strong>`;
    const time = formatTime(p.created_at);

    if (state === 'claimed-by-me') {
      return `
        <div class="ep-card claimed" data-id="${p.id}">
          <div class="ep-card-body">
            <div class="ep-card-message">${message}</div>
            <div class="ep-card-meta">
              <span class="ep-claimed-badge">✓ Claimed by me</span>
            </div>
          </div>
          <button class="ep-undo-btn" data-action="unclaim" data-id="${p.id}">Undo</button>
        </div>`;
    }

    if (state === 'claimed-by-other') {
      const who = rec && rec.pickup.claimed_by_name ? esc(rec.pickup.claimed_by_name) : 'a counselor';
      return `
        <div class="ep-card claimed" data-id="${p.id}">
          <div class="ep-card-body">
            <div class="ep-card-message">${message}</div>
            <div class="ep-card-meta">
              <span class="ep-claimed-badge">✓ Claimed by ${who}</span>
            </div>
          </div>
        </div>`;
    }

    const btnDisabled = state === 'claiming' ? 'disabled' : '';
    const btnLabel = state === 'claiming' ? 'Claiming…' : "I've Got This";
    return `
      <div class="ep-card" data-id="${p.id}">
        <div class="ep-card-body">
          <div class="ep-card-message">${message}</div>
          <div class="ep-card-meta">
            ${time ? `<span class="ep-clock">🕒 ${esc(time)}</span>` : ''}
          </div>
        </div>
        <button class="ep-claim-btn" data-action="claim" data-id="${p.id}" ${btnDisabled}>${btnLabel}</button>
      </div>`;
  }

  function vanish(id, afterMs) {
    const rec = pickups.get(id);
    if (!rec) return;
    if (rec.timeoutId) clearTimeout(rec.timeoutId);
    rec.timeoutId = setTimeout(() => {
      const el = listEl && listEl.querySelector(`.ep-card[data-id="${id}"]`);
      if (el) {
        el.classList.add('vanishing');
        setTimeout(() => {
          pickups.delete(id);
          renderAll();
        }, 400);
      } else {
        pickups.delete(id);
        renderAll();
      }
    }, afterMs);
  }

  function applySnapshot(list) {
    // Reset local map but preserve any rows the claimer is mid-undo on.
    const mine = new Map();
    for (const [id, rec] of pickups.entries()) {
      if (rec.state === 'claimed-by-me') mine.set(id, rec);
    }
    pickups.clear();
    for (const p of list) {
      pickups.set(p.id, { pickup: p, state: 'unclaimed', timeoutId: null });
    }
    for (const [id, rec] of mine.entries()) {
      // Keep showing the claimer's in-flight "Claimed by me" row even if the
      // server list no longer includes it (it's claimed now).
      if (!pickups.has(id)) pickups.set(id, rec);
    }
    renderAll();
  }

  function handleEvent(type, data) {
    if (type === 'snapshot') {
      applySnapshot(data || []);
      return;
    }
    if (type === 'created') {
      if (!pickups.has(data.id)) {
        pickups.set(data.id, { pickup: data, state: 'unclaimed', timeoutId: null });
        renderAll();
      }
      return;
    }
    if (type === 'claimed') {
      const rec = pickups.get(data.id);
      if (!rec) return;
      // If this client is the claimer, our optimistic path already handled it.
      if (rec.state === 'claimed-by-me' || rec.state === 'claiming') return;
      rec.pickup = Object.assign({}, rec.pickup, data);
      rec.state = 'claimed-by-other';
      renderAll();
      vanish(data.id, PUBLIC_FADE_MS);
      return;
    }
    if (type === 'unclaimed') {
      const existing = pickups.get(data.id);
      if (existing && existing.timeoutId) clearTimeout(existing.timeoutId);
      pickups.set(data.id, {
        pickup: Object.assign({}, (existing && existing.pickup) || {}, data, {
          claimed_by: null, claimed_by_name: null, claimed_at: null,
        }),
        state: 'unclaimed',
        timeoutId: null,
      });
      renderAll();
      return;
    }
    // heartbeat: ignore
  }

  // ─── Transport: SSE primary, polling fallback ────────────────────────────
  function connectSSE() {
    if (!('EventSource' in global)) { startPolling(); return; }
    const token = opts.getToken();
    if (!token) { startPolling(); return; }

    try {
      sse = new EventSource(`/api/pickups/stream?token=${encodeURIComponent(token)}`);
    } catch (e) {
      startPolling();
      return;
    }

    sse.addEventListener('open', () => {
      sseFails = 0;
      usingPolling = false;
      stopPolling();
      setConnectionStatus('connected');
    });

    ['snapshot', 'created', 'claimed', 'unclaimed', 'heartbeat'].forEach(type => {
      sse.addEventListener(type, ev => {
        // Any successful event means the connection is healthy — reset the
        // failure counter so one transient blip can't permanently demote us
        // to polling.
        sseFails = 0;
        try { handleEvent(type, JSON.parse(ev.data)); } catch (_) {}
      });
    });

    // Extra event types the host page wants to observe (e.g. 'parent-response').
    // These bypass handleEvent and go straight to the host callback so the
    // component doesn't need to know their schema.
    const extras = Array.isArray(opts.extraEventTypes) ? opts.extraEventTypes : [];
    extras.forEach(type => {
      sse.addEventListener(type, ev => {
        sseFails = 0;
        let data;
        try { data = JSON.parse(ev.data); } catch (_) { return; }
        try { opts.onExtraEvent && opts.onExtraEvent(type, data); } catch (_) {}
      });
    });

    sse.addEventListener('error', async () => {
      sseFails += 1;
      // Soft indicator: "Live" stays up for OFFLINE_GRACE_MS so a transient
      // error (Render/Cloudflare keep-alive renewals are frequent) doesn't
      // flash "Offline" at the user. A real outage still flips the pill.
      setConnectionStatus('reconnecting');

      // Token likely expired — EventSource will otherwise loop on 401 forever.
      // Try a refresh once; on success, reconnect with the new token instead
      // of demoting to polling (which would reuse the same stale token).
      if (sse && sse.readyState === EventSource.CLOSED && opts.onAuthRefresh) {
        try { sse.close(); } catch (_) {}
        sse = null;
        let refreshed = false;
        try { refreshed = await opts.onAuthRefresh(); } catch (_) {}
        if (refreshed) {
          sseFails = 0;
          connectSSE();
          return;
        }
      }

      if (sseFails >= 2 && !usingPolling) {
        try { sse && sse.close(); } catch (_) {}
        sse = null;
        startPolling();
      }
    });
  }

  function onVisibilityChange() {
    if (document.visibilityState !== 'visible') return;
    // If SSE was never open or was closed while we were backgrounded, force a
    // fresh connection — this also pulls a new snapshot so we can't miss
    // events that happened while the tab was asleep.
    if (!sse || sse.readyState !== EventSource.OPEN) {
      try { sse && sse.close(); } catch (_) {}
      sse = null;
      sseFails = 0;
      connectSSE();
    }
  }

  async function pollOnce() {
    try {
      const res = await fetch('/api/counselor/pickup-alerts', {
        headers: { 'Authorization': 'Bearer ' + opts.getToken() },
      });
      if (res.status === 401) { opts.onAuthError && opts.onAuthError(); return; }
      if (!res.ok) return;
      const list = await res.json();
      applySnapshot(list);
      setConnectionStatus('connected');
    } catch (_) {
      setConnectionStatus('disconnected');
    }
  }

  function startPolling() {
    usingPolling = true;
    setConnectionStatus('disconnected');
    if (pollTimer) return;
    pollOnce();
    pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ─── Claim / Unclaim ─────────────────────────────────────────────────────
  async function onClaim(id) {
    const rec = pickups.get(id);
    if (!rec || rec.state !== 'unclaimed') return;

    // Optimistic: mark claiming immediately so double-taps can't fire twice.
    rec.state = 'claiming';
    renderAll();

    let res;
    try {
      res = await fetch(`/api/pickups/${id}/claim`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + opts.getToken() },
      });
    } catch (e) {
      rec.state = 'unclaimed';
      renderAll();
      toast('Network error — try again', true);
      return;
    }

    if (res.status === 409) {
      let body = {};
      try { body = await res.json(); } catch (_) {}
      const who = body.claimed_by_name || 'someone else';
      toast(`Already claimed by ${who}`, true);
      pickups.delete(id);
      renderAll();
      return;
    }
    if (res.status === 401) { opts.onAuthError && opts.onAuthError(); return; }
    if (!res.ok) {
      rec.state = 'unclaimed';
      renderAll();
      toast('Could not claim — try again', true);
      return;
    }

    const data = await res.json();
    rec.pickup = Object.assign({}, rec.pickup, data);
    rec.state = 'claimed-by-me';
    renderAll();
    // Give the claimer a real undo window. After it expires, vanish locally.
    vanish(id, CLAIMER_WINDOW_MS);
  }

  async function onUnclaim(id) {
    const rec = pickups.get(id);
    if (!rec || rec.state !== 'claimed-by-me') return;
    if (rec.timeoutId) { clearTimeout(rec.timeoutId); rec.timeoutId = null; }

    let res;
    try {
      res = await fetch(`/api/pickups/${id}/unclaim`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + opts.getToken() },
      });
    } catch (e) {
      toast('Network error — try again', true);
      vanish(id, CLAIMER_WINDOW_MS);
      return;
    }

    if (res.status === 401) { opts.onAuthError && opts.onAuthError(); return; }
    if (!res.ok) {
      toast('Could not undo — try again', true);
      vanish(id, CLAIMER_WINDOW_MS);
      return;
    }

    const data = await res.json();
    rec.pickup = Object.assign({}, rec.pickup, data, {
      claimed_by: null, claimed_by_name: null, claimed_at: null,
    });
    rec.state = 'unclaimed';
    renderAll();
    toast('Undone — pickup is back on everyone\u2019s list');
  }

  function onClick(ev) {
    const btn = ev.target.closest('[data-action]');
    if (!btn) return;
    const id = parseInt(btn.getAttribute('data-id'), 10);
    if (!id) return;
    const action = btn.getAttribute('data-action');
    if (action === 'claim') onClaim(id);
    else if (action === 'unclaim') onUnclaim(id);
  }

  function mount(target, options) {
    unmount();
    container = typeof target === 'string' ? document.querySelector(target) : target;
    if (!container) return;
    opts = Object.assign({
      getToken: () => null,
      getUserId: () => null,
      getUserName: () => '',
      onAuthError: () => {},
      onAuthRefresh: null,
      extraEventTypes: [],
      onExtraEvent: null,
    }, options || {});
    buildShell();
    container.addEventListener('click', onClick);
    document.addEventListener('visibilitychange', onVisibilityChange);
    renderAll();
    connectSSE();
  }

  function unmount() {
    if (container) {
      container.removeEventListener('click', onClick);
      container.innerHTML = '';
    }
    document.removeEventListener('visibilitychange', onVisibilityChange);
    container = listEl = statusEl = countEl = null;
    if (sse) { try { sse.close(); } catch (_) {} sse = null; }
    stopPolling();
    if (offlineTimer) { clearTimeout(offlineTimer); offlineTimer = null; }
    usingPolling = false;
    sseFails = 0;
    for (const rec of pickups.values()) {
      if (rec.timeoutId) clearTimeout(rec.timeoutId);
    }
    pickups.clear();
  }

  global.EarlyPickups = { mount, unmount };
})(window);
