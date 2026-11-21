'use strict';
/* account.js — cuentas de usuario (solo nombre y contraseña, sin correo).
   - Cada cuenta tiene sus propios datos en el navegador (favoritas, listas, historial, estadísticas,
     búsquedas, ajustes...) y se sincronizan con el servidor, así el inicio ("Para ti", recientes)
     y el historial de búsqueda son de cada persona y la siguen a cualquier dispositivo.
   - En la web publicada hay que iniciar sesión para usarla: sin sesión sale una pantalla de
     bienvenida con "Entrar" y "Crear cuenta". Al crear una cuenta, lo que hubiera guardado en ese
     navegador como invitado pasa a la cuenta nueva.
   - Las cuentas necesitan el servidor de Cloudflare (base de datos D1). Con serve.ps1 en el PC no
     hay cuentas: no sale la bienvenida y la app funciona en modo invitado. */
const Account = (() => {
  // mismas claves que acepta el servidor (server/accounts.js)
  const SYNC = ['favs', 'playlists', 'history', 'stats', 'searchHist', 'settings', 'lyrOffsets', 'volume', 'shuffle', 'repeat', 'resolved', 'followed', 'seedSongs', 'onboarded', 'disliked'];
  const DELAY = { stats: 20000 };              // las estadísticas cambian cada pocos segundos al escuchar
  const nsOf = name => 'mz:u:' + name.toLowerCase() + ':';
  const raw = (ns, k) => { try { return localStorage.getItem(ns + k); } catch (_) { return null; } };
  const rawSet = (ns, k, v) => { try { localStorage.setItem(ns + k, v); } catch (_) {} };

  let user = null;          // nombre de la cuenta con sesión
  let supported = null;     // null: aún no se sabe; false: este servidor no tiene cuentas
  let who = '';
  try { who = localStorage.getItem('mz:who') || ''; } catch (_) {}
  // el espacio de datos se elige ya, antes de que la app lea nada
  if (who) store.ns = nsOf(who);

  const timers = new Map(), pending = new Set();

  // si el servidor dice que no hay sesión (caducada o cerrada en otro sitio), vuelve la bienvenida
  const nativeFetch = window.fetch.bind(window);
  let expiredShown = false;
  window.fetch = async (...a) => {
    const r = await nativeFetch(...a);
    try {
      const u = new URL(typeof a[0] === 'string' ? a[0] : a[0].url, location.href);
      if (r.status === 401 && u.origin === location.origin && u.pathname.startsWith('/api/') && !u.pathname.startsWith('/api/auth/') && !expiredShown) {
        expiredShown = true;
        if (who) { toast('La sesión ha caducado. Vuelve a entrar.'); setTimeout(() => switchTo(''), 800); }
        else if (supported !== false) showGate('login');
      }
    } catch (_) {}
    return r;
  };

  async function api(method, path, body, keepalive) {
    const opt = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { opt.body = typeof body === 'string' ? body : JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
    if (keepalive) opt.keepalive = true;
    const r = await fetch('/api/' + path, opt);
    let j = null;
    try { j = await r.json(); } catch (_) {}
    return { ok: r.ok, status: r.status, j };
  }

  /* ---------------------------------------------------------------- sincronización */
  async function upload(k, keepalive) {
    pending.delete(k);
    clearTimeout(timers.get(k)); timers.delete(k);
    const v = raw(store.ns, k);
    if (v == null || !user) return;
    try { await api('PUT', 'data/' + k, v, keepalive && v.length < 60000); } catch (_) { pending.add(k); }
  }
  function schedule(k) {
    if (!user || !SYNC.includes(k)) return;
    pending.add(k);
    clearTimeout(timers.get(k));
    timers.set(k, setTimeout(() => upload(k), DELAY[k] || 1500));
  }
  function flush(keepalive) { return Promise.all([...pending].map(k => upload(k, keepalive))); }
  store.onset = k => schedule(k);
  addEventListener('pagehide', () => flush(true));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(true); });

  // trae los datos de la cuenta; lo que solo esté en este dispositivo se sube
  async function pull() {
    const r = await api('GET', 'data');
    if (!r.ok || !r.j) return false;
    const data = r.j.data || {};
    let changed = false;
    SYNC.forEach(k => {
      if (k in data) {
        const v = JSON.stringify(data[k]);
        if (raw(store.ns, k) !== v) { rawSet(store.ns, k, v); changed = true; }
      } else if (raw(store.ns, k) != null) schedule(k);
    });
    return changed;
  }

  function refreshUI() {
    try {
      if (!document.getElementById('tab-home').hidden && !App.views.length) App.renderHome();
      Features.refreshSettings && Features.refreshSettings();
      App.updateFav(); App.highlight();
    } catch (_) {}
  }

  /* ---------------------------------------------------------------- sesión */
  function switchTo(name) {
    try { name ? localStorage.setItem('mz:who', name) : localStorage.removeItem('mz:who'); } catch (_) {}
    location.reload();
  }

  async function check() {
    let r = null;
    try { r = await api('GET', 'auth/me'); } catch (_) { r = null; }
    if (!r) { supported = who ? true : null; if (who) user = who; renderAll(); return; }   // sin conexión
    if (r.status === 404 || r.status === 405 || r.status === 501) {
      supported = false;
      try { localStorage.removeItem('mz:accounts'); } catch (_) {}
      if (gateEl) { gateEl.remove(); gateEl = null; document.body.classList.remove('gated'); }
      if (who) switchTo('');                // este servidor no tiene cuentas: modo invitado
      renderAll(); return;
    }
    supported = true;
    try { localStorage.setItem('mz:accounts', '1'); } catch (_) {}
    if (r.ok && r.j && r.j.username) {
      user = r.j.username;
      if (!who || who.toLowerCase() !== user.toLowerCase()) return switchTo(user);
      renderAll();
      if (await pull()) refreshUI();
    } else {
      if (who) { toast('La sesión ha caducado. Vuelve a entrar.'); return switchTo(''); }
      renderAll();
      showGate('login');                    // sin sesión no se puede usar la app
    }
  }

  async function submit(mode, username, password) {
    const r = await api('POST', 'auth/' + mode, { username, password });
    if (!r.ok) throw new Error((r.j && r.j.error) || 'No se pudo conectar con el servidor');
    const name = r.j.username;
    if (mode === 'register') {
      // lo que tenías como invitado pasa a tu cuenta nueva
      const ns = nsOf(name);
      for (const k of SYNC) {
        const v = raw('mz:', k);
        if (v == null) continue;
        rawSet(ns, k, v);
        try { await api('PUT', 'data/' + k, v); } catch (_) {}
      }
    }
    switchTo(name);
  }

  async function logout() {
    await flush();
    try { await api('POST', 'auth/logout'); } catch (_) {}
    switchTo('');
  }

  /* ---------------------------------------------------------------- interfaz */
  const initial = n => esc((n || '?').trim().charAt(0).toUpperCase());

  // formulario de entrar / crear cuenta (lo usan la hoja y la pantalla de bienvenida)
  function buildForm(mode, onSwitch) {
    const reg = mode === 'register';
    const f = el(`<form class="acct-form" autocomplete="on">
          <label><span>Nombre de usuario</span><input type="text" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" minlength="3" maxlength="24" required></label>
          <label><span>Contraseña</span><input type="password" name="password" autocomplete="${reg ? 'new-password' : 'current-password'}" minlength="${reg ? 6 : 1}" maxlength="200" required></label>
          <p class="acct-err" role="alert" hidden></p>
          <div class="acct-actions">
            <button type="button" class="btn tonal" data-switch>${reg ? 'Ya tengo cuenta' : 'Crear una cuenta'}</button>
            <button class="btn" type="submit">${reg ? 'Crear cuenta' : 'Entrar'}</button>
          </div>
          ${reg ? '<p class="acct-note">De 3 a 24 caracteres: letras, números, punto, guion o guion bajo. La contraseña, de al menos 6. No hay forma de recuperarla, así que apúntala.</p>' : ''}
        </form>`);
    const errBox = f.querySelector('.acct-err'), btn = f.querySelector('[type=submit]');
    f.querySelector('[data-switch]').onclick = () => onSwitch(reg ? 'login' : 'register');
    f.onsubmit = async e => {
      e.preventDefault();
      errBox.hidden = true; btn.disabled = true; btn.textContent = reg ? 'Creando…' : 'Entrando…';
      try { await submit(mode, f.username.value.trim(), f.password.value); }
      catch (x) {
        errBox.textContent = x.message; errBox.hidden = false;
        btn.disabled = false; btn.textContent = reg ? 'Crear cuenta' : 'Entrar';
      }
    };
    return f;
  }

  function openSheet(mode = 'login') {
    if (gateEl) return showGate(mode);
    const reg = mode === 'register';
    App.sheet({
      title: reg ? 'Crear cuenta' : 'Iniciar sesión',
      sub: 'Solo nombre de usuario y contraseña',
      body: box => box.appendChild(buildForm(mode, openSheet))
    });
  }

  /* Pantalla de bienvenida: en la web publicada hay que entrar con una cuenta para usar la app.
     Tapa todo hasta que se inicia sesión (no aparece donde no hay cuentas, como con serve.ps1). */
  let gateEl = null;
  function showGate(mode = 'login') {
    const reg = mode === 'register';
    if (!gateEl) {
      gateEl = document.createElement('div');
      gateEl.id = 'auth-gate';
      gateEl.setAttribute('role', 'dialog'); gateEl.setAttribute('aria-modal', 'true'); gateEl.setAttribute('aria-labelledby', 'gate-title');
      document.body.appendChild(gateEl);
      document.body.classList.add('gated');
      try { Player.pause(); } catch (_) {}
    }
    gateEl.innerHTML = `<div class="gate-card">
      <div class="gate-logo" aria-hidden="true">${icon('note')}</div>
      <h1 id="gate-title">${reg ? 'Crea tu cuenta' : 'Te damos la bienvenida'}</h1>
      <p class="gate-sub">${reg ? 'Solo un nombre de usuario y una contraseña, sin correo.' : 'Inicia sesión para escuchar tu música, con tu propio inicio, favoritas e historial.'}</p>
      <div class="gate-tabs" role="tablist">
        <button role="tab" aria-selected="${!reg}" class="${reg ? '' : 'on'}" data-m="login">Entrar</button>
        <button role="tab" aria-selected="${reg}" class="${reg ? 'on' : ''}" data-m="register">Crear cuenta</button>
      </div>
    </div>`;
    const card = gateEl.querySelector('.gate-card');
    const f = buildForm(mode, showGate);
    f.querySelector('[data-switch]').remove();        // aquí se cambia con las pestañas de arriba
    card.appendChild(f);
    card.querySelectorAll('.gate-tabs button').forEach(b => b.onclick = () => { if (b.dataset.m !== mode) showGate(b.dataset.m); });
    setTimeout(() => f.username.focus(), 50);
  }

  function accountMenu(origin) {
    if (!user) return openSheet('login');
    App.sheet({
      title: user, sub: 'Tu música se guarda en tu cuenta', origin,
      items: [{ icon: 'back', label: 'Cerrar sesión', fn: () => logout() }]
    });
  }

  // bloque "Cuenta" al principio de Configuración
  function renderSlot(box) {
    if (!box) return;
    if (supported === false) {
      box.innerHTML = `<h2 class="sec">Cuenta</h2><div class="group"><div class="set" style="cursor:default">${icon('person')}<div class="lbl">Modo invitado<small>Las cuentas solo funcionan en la versión publicada en internet (Cloudflare). Aquí tus datos se guardan en este navegador.</small></div></div></div>`;
      return;
    }
    if (user) {
      box.innerHTML = `<h2 class="sec">Cuenta</h2><div class="group">
        <div class="set" style="cursor:default"><span class="acct-avatar" aria-hidden="true">${initial(user)}</span><div class="lbl">${esc(user)}<small>Favoritas, listas, historial y búsquedas se guardan en tu cuenta y se sincronizan entre dispositivos</small></div></div>
        <div class="set" data-acct="logout">${icon('back')}<div class="lbl">Cerrar sesión</div></div></div>`;
      box.querySelector('[data-acct=logout]').onclick = () => logout();
    } else {
      box.innerHTML = `<h2 class="sec">Cuenta</h2><div class="group">
        <div class="set" data-acct="login">${icon('person')}<div class="lbl">Iniciar sesión<small>Tu propio inicio, historial y búsquedas, en cualquier dispositivo</small></div></div>
        <div class="set" data-acct="register">${icon('plus')}<div class="lbl">Crear cuenta<small>Solo nombre de usuario y contraseña, sin correo</small></div></div></div>`;
      box.querySelector('[data-acct=login]').onclick = () => openSheet('login');
      box.querySelector('[data-acct=register]').onclick = () => openSheet('register');
    }
  }

  // avatar en Inicio y saludo con el nombre
  function decorateHome() {
    const w = document.querySelector('#tab-home .wrap');
    if (!w) return;
    if (supported === false) { const old = w.querySelector('.acct-btn'); old && old.remove(); return; }
    const h1 = w.querySelector('h1.title');
    if (h1 && user && !h1.dataset.named) { h1.dataset.named = '1'; h1.textContent += ', ' + user; }
    let b = w.querySelector('.acct-btn');
    if (!b) {
      b = document.createElement('button');
      b.className = 'acct-btn';
      w.prepend(b);
      b.onclick = () => accountMenu(b);
    }
    b.setAttribute('aria-label', user ? 'Cuenta de ' + user : 'Iniciar sesión');
    b.innerHTML = user ? `<span class="acct-avatar">${initial(user)}</span>` : icon('person');
  }

  function renderAll() {
    decorateHome();
    const slot = document.getElementById('acct-slot');
    if (slot) renderSlot(slot);
  }

  document.addEventListener('DOMContentLoaded', () => {
    const rh = App.renderHome;
    App.renderHome = function (...a) { const r = rh.apply(this, a); try { decorateHome(); } catch (_) {} return r; };
    decorateHome();
    // si ya sabemos que este servidor tiene cuentas y no hay sesión, la bienvenida sale al instante
    let known = false;
    try { known = localStorage.getItem('mz:accounts') === '1'; } catch (_) {}
    if (known && !who) showGate('login');
    check();
  }, { once: true });

  return {
    renderSlot, openSheet, logout,
    get user() { return user; },
    get supported() { return supported; }
  };
})();
window.Account = Account;
