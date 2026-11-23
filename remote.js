'use strict';
/* remote.js — la app y la API pública (/api/v1).
   - Cuenta al servidor qué suena (canción, posición, pausa) para GET /api/v1/now.
   - Recoge cada pocos segundos las órdenes a distancia (pausar, siguiente, poner una canción…)
     que llegan por la API y las aplica. Solo las recibe la app "activa": la última que sonó.
   - Si la API cambia favoritas o listas, las trae sin recargar.
   - Configuración → API: crear y borrar tokens, y la documentación con ejemplos.
   Solo funciona con cuentas (servidor de Cloudflare); con serve.ps1 en el PC no hace nada. */
const Remote = (() => {
  let device = '';
  try { device = localStorage.getItem('mz:device') || ''; if (!device) { device = Math.random().toString(36).slice(2, 12); localStorage.setItem('mz:device', device); } } catch (_) { device = 'd' + Date.now().toString(36); }
  const deviceName = (() => {
    const u = navigator.userAgent;
    const os = /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : /Mac/.test(u) ? 'Mac' : /Windows/.test(u) ? 'PC' : /Linux/.test(u) ? 'Linux' : 'Navegador';
    const app = matchMedia('(display-mode: standalone)').matches ? ' (app)' : '';
    return os + app;
  })();
  const on = () => !!(window.Account && Account.user);
  const api = async (method, path, body, keepalive) => {
    const r = await fetch('/api/' + path, { method, credentials: 'same-origin', keepalive: !!keepalive, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch (_) {}
    return { ok: r.ok, status: r.status, j };
  };
  const clean = t => t && { id: t.id, title: t.title, artist: t.artist, artistId: t.artistId || '', album: t.album || '', albumId: t.albumId || '', dur: t.dur || (window.Player && Player.ready ? Math.round(Player.duration() || 0) : 0), cover: t.cover || '' };

  /* ---------------------------------------------------------------- qué suena */
  let pushT = 0, lastBeat = 0, retries = 0, durSent = '';
  // la canción que tiene cargada de verdad el reproductor (al cambiar de canción, durante un
  // momento sigue la anterior: su tiempo y su duración no valen para la nueva)
  const loadedId = () => { try { return window.Player && Player.ready && Player.yt.getVideoData ? Player.yt.getVideoData().video_id || '' : ''; } catch (_) { return ''; } };
  function state(closed) {
    const s = App.state, t = App.current;
    const ok = !!(t && loadedId() === t.id);
    const tr = t ? clean(t) : null;
    if (tr) tr.dur = (ok && Math.round(Player.duration() || 0)) || t.dur || 0;
    return { device, deviceName, track: tr, playing: !!s.playing && !closed && ok, pos: ok ? Player.time() : 0, volume: s.volume, shuffle: !!s.shuffle, repeat: s.repeat, closed: !!closed, ok };
  }
  function push(now) {
    if (!on()) return;
    clearTimeout(pushT);
    pushT = setTimeout(() => {
      const st = state();
      // aún cargando la canción nueva: se cuenta ya (título) y otra vez en cuanto esté (tiempo)
      if (App.current && !st.ok && retries < 15) { retries++; pushT = setTimeout(() => push(true), 1000); }
      else retries = 0;
      if (st.ok && st.track && st.track.dur) durSent = st.track.id;
      lastBeat = Date.now();
      delete st.ok;
      api('POST', 'presence', st).catch(() => {});
    }, now ? 0 : 400);
  }
  // latido: mientras suena, cada 20 s (corrige cualquier desfase); con la app a la vista y en
  // pausa, cada minuto (para saber que sigue abierta)
  setInterval(() => {
    if (!on()) return;
    const gap = Date.now() - lastBeat;
    if ((App.state.playing && gap > 20e3) || (document.visibilityState === 'visible' && gap > 55e3)) push(true);
  }, 5e3);
  addEventListener('pagehide', () => { if (on()) api('POST', 'presence', state(true), true).catch(() => {}); });

  /* ---------------------------------------------------------------- órdenes a distancia */
  let since = 0, polling = false;
  async function poll() {
    if (!on() || polling) return;
    polling = true;
    try {
      const r = await api('GET', `remote?device=${encodeURIComponent(device)}&since=${since}`);
      if (r.ok && r.j) {
        if (since && r.j.changed && r.j.changed.length) Account.pullKeys(r.j.changed).catch(() => {});
        since = r.j.now || Date.now();
        (r.j.cmds || []).forEach(run);
      }
    } catch (_) {}
    polling = false;
  }
  function run(c) {
    const t = c.track ? { ...c.track, atv: false } : null;
    try {
      switch (c.type) {
        case 'play': if (!App.state.playing) App.current ? App.toggle() : null; break;
        case 'pause': if (App.state.playing) Player.pause(); break;
        case 'toggle': App.toggle(); break;
        case 'next': App.next(); break;
        case 'previous': App.prev(); break;
        case 'seek': Player.seek(Math.max(0, +c.position || 0)); push(true); break;
        case 'volume': App.setVolume(+c.volume); push(true); break;
        case 'playTrack': if (t) { c.radio ? App.playWithRadio(t) : App.playNow(t, 'API'); toast('Desde la API: ' + t.title); } break;
        case 'queue': if (t) App.addToQueue(t); break;
        case 'playNext': if (t) App.playNext(t); break;
      }
    } catch (_) {}
  }
  // más a menudo con la app a la vista; los navegadores frenan los temporizadores en segundo plano
  let tick = 0;
  setInterval(() => { tick++; if (document.visibilityState === 'visible' || tick % 3 === 0) poll(); }, 4000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { poll(); push(true); } });

  function hooks() {
    App.on('track', () => push());
    const up = App.updatePlaying;
    App.updatePlaying = function (...a) { const r = up.apply(this, a); push(); return r; };
    // saltos con la barra de progreso
    let lastPos = 0, lastAt = 0;
    App.on('time', ({ cur }) => {
      const now = Date.now();
      if (App.state.playing && lastAt && Math.abs(cur - (lastPos + (now - lastAt) / 1000)) > 3) push();
      // la duración de la canción ya se sabe: se cuenta (si antes no se sabía)
      else if (App.current && durSent !== App.current.id && App.state.playing && Player.duration() > 0 && loadedId() === App.current.id) { durSent = App.current.id; push(); }
      lastPos = cur; lastAt = now;
    });
    const wait = () => on() ? (push(true), poll()) : setTimeout(wait, 1500);
    setTimeout(wait, 1500);
  }

  /* ---------------------------------------------------------------- Configuración → API */
  const fmtDate = ms => ms ? new Date(ms).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const codeBox = text => {
    const b = el(`<div class="api-code"><span></span><button class="copy" aria-label="Copiar">${icon('copy')}</button></div>`);
    $('span', b).textContent = text;
    $('.copy', b).onclick = () => navigator.clipboard && navigator.clipboard.writeText(text).then(() => toast('Copiado'), () => toast('No se pudo copiar'));
    return b;
  };

  function open() {
    if (!on()) return toast('La API necesita una cuenta: inicia sesión');
    App.openView('API', box => {
      box.appendChild(el(`<h1 class="title">API</h1>`));
      box.appendChild(el(`<p class="api-intro">Con un token puedes usar tu música desde otros sitios: un bot, Atajos del iPhone, un widget o tus propios programas. Cada token se ve <b>una sola vez</b> al crearlo; guárdalo como una contraseña. Si se te escapa, bórralo y crea otro.</p>`));
      const fresh = el('<div></div>'); box.appendChild(fresh);
      box.appendChild(el(`<h2 class="sec">Tus tokens</h2>`));
      const list = el('<div class="group"></div>'); box.appendChild(list);
      const add = el(`<button class="btn" style="margin:4px 0 8px">${icon('plus')}Crear token</button>`);
      add.onclick = () => create(list, fresh);
      box.appendChild(add);
      renderTokens(list);
      docs(box);
    });
  }

  async function renderTokens(list) {
    list.innerHTML = '';
    App.loading(list);
    const r = await api('GET', 'tokens').catch(() => null);
    list.innerHTML = '';
    if (!r || !r.ok) { list.appendChild(el(`<div class="set" style="cursor:default">${icon('info')}<div class="lbl">No se pudieron cargar<small>${esc((r && r.j && r.j.error) || 'Sin conexión')}</small></div></div>`)); return; }
    if (!r.j.tokens.length) { list.appendChild(el(`<div class="set" style="cursor:default">${icon('key')}<div class="lbl">Aún no tienes tokens<small>Crea uno para empezar</small></div></div>`)); return; }
    r.j.tokens.forEach(t => {
      const row = el(`<div class="set api-tok" style="cursor:default">${icon('key')}<div class="lbl">${esc(t.name)}<small>${esc(t.hint)} · ${t.scope === 'control' ? 'Leer y controlar' : 'Solo leer'} · ${t.last_used ? 'usado el ' + fmtDate(t.last_used) : 'sin usar'}</small></div><button class="del" aria-label="Borrar token">${icon('trash')}</button></div>`);
      $('.del', row).onclick = () => App.sheet({
        title: '¿Borrar «' + t.name + '»?', sub: 'Lo que lo use dejará de funcionar al momento',
        items: [{ icon: 'trash', label: 'Borrar token', fn: async () => { const d = await api('DELETE', 'tokens/' + t.id).catch(() => null); toast(d && d.ok ? 'Token borrado' : 'No se pudo borrar'); renderTokens(list); } }]
      });
      list.appendChild(row);
    });
  }

  function create(list, fresh) {
    App.sheet({
      title: 'Nuevo token', body: box => {
        let scope = 'read';
        const f = el(`<form class="api-form">
          <input type="text" maxlength="60" placeholder="Para qué es (p. ej. Bot de Discord)" aria-label="Nombre del token">
          <div class="seg" role="group" aria-label="Permiso"><button type="button" data-v="read" class="on">Solo leer</button><button type="button" data-v="control">Leer y controlar</button></div>
          <small class="muted">«Leer y controlar» también puede cambiar tus favoritas y listas y manejar la reproducción.</small>
          <div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn tonal">Cancelar</button><button class="btn">Crear</button></div></form>`);
        $$('.seg button', f).forEach(b => b.onclick = () => { scope = b.dataset.v; $$('.seg button', f).forEach(x => x.classList.toggle('on', x === b)); });
        $('.tonal', f).onclick = () => App.closeSheet();
        f.onsubmit = async e => {
          e.preventDefault();
          const name = $('input', f).value.trim() || 'Token';
          const r = await api('POST', 'tokens', { name, scope }).catch(() => null);
          App.closeSheet();
          if (!r || !r.ok) return toast((r && r.j && r.j.error) || 'No se pudo crear el token', 4000);
          fresh.innerHTML = '';
          const n = el(`<div class="api-new"><b>Tu token «${esc(r.j.name)}»</b><span>Cópialo ahora: no se volverá a mostrar.</span></div>`);
          n.insertBefore(codeBox(r.j.token), n.children[1]);
          fresh.appendChild(n);
          fresh.scrollIntoView({ behavior: 'smooth', block: 'center' });
          renderTokens(list);
        };
        box.appendChild(f);
      }
    });
  }

  async function docs(box) {
    const base = location.origin + '/api/v1';
    box.appendChild(el(`<h2 class="sec">Cómo se usa</h2>`));
    box.appendChild(el(`<p class="api-intro">Envía tu token en la cabecera <kbd>Authorization: Bearer …</kbd>. Todas las respuestas son JSON. Como mucho 120 peticiones por minuto por token. Las órdenes de reproducción y «qué suena» necesitan la app abierta en algún dispositivo con tu cuenta.</p>`));
    box.appendChild(el(`<p class="api-intro" style="margin-bottom:0"><b>Qué suena ahora</b> (curl)</p>`));
    box.appendChild(codeBox(`curl -H "Authorization: Bearer TU_TOKEN" ${base}/now`));
    box.appendChild(el(`<p class="api-intro" style="margin-bottom:0"><b>Pasar a la siguiente</b> (curl)</p>`));
    box.appendChild(codeBox(`curl -X POST -H "Authorization: Bearer TU_TOKEN" ${base}/player/next`));
    box.appendChild(el(`<p class="api-intro" style="margin-bottom:0"><b>Buscar y poner una canción</b> (JavaScript)</p>`));
    box.appendChild(codeBox(`const T = 'TU_TOKEN', API = '${base}';
const h = { Authorization: 'Bearer ' + T, 'Content-Type': 'application/json' };
const { results } = await (await fetch(API + '/search?q=' + encodeURIComponent('columbia quevedo'), { headers: h })).json();
await fetch(API + '/player/play', { method: 'POST', headers: h, body: JSON.stringify({ id: results[0].id }) });`));
    box.appendChild(el(`<p class="api-intro"><b>Atajos del iPhone</b>: acción «Obtener contenido de URL» con la dirección <kbd>${esc(base)}/player/toggle</kbd>, método POST y una cabecera <kbd>Authorization</kbd> con el valor <kbd>Bearer TU_TOKEN</kbd>. Añádelo a la pantalla de inicio o a Siri.</p>`));
    const g = el('<div></div>'); box.appendChild(g);
    try {
      const d = await (await fetch('/api/v1')).json();
      const sec = (title, o) => {
        g.appendChild(el(`<h2 class="sec">${esc(title)}</h2>`));
        const grp = el('<div class="group"></div>');
        Object.entries(o).forEach(([k, v]) => { const r = el('<div class="api-ep"><code></code><span></span></div>'); $('code', r).textContent = k; $('span', r).textContent = v; grp.appendChild(r); });
        g.appendChild(grp);
      };
      sec('Leer (cualquier token)', d.read);
      sec('Controlar (token «Leer y controlar»)', d.control);
    } catch (_) {}
  }

  document.addEventListener('DOMContentLoaded', hooks, { once: true });
  return { open, poll, push, device };
})();
window.Remote = Remote;
