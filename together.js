'use strict';
/* together.js — "Escuchar juntos": cada persona oye la música en su dispositivo, sincronizada.
   - El anfitrión publica lo que suena (canción, pausa y posición) al cambiar algo y cada 8 s.
   - Los invitados consultan la sala cada 2 s y se ajustan: cambian de canción, pausan/reanudan y
     corrigen la posición si se desvían más de 1,5 s (compensando la diferencia de reloj con el
     servidor). Si un invitado pone una canción, se propone al anfitrión y este la añade a su cola.
   - Necesita las cuentas (web publicada en Cloudflare). Se entra con el código o con un enlace
     "#sala=CÓDIGO". Al recargar la página se vuelve a entrar en la misma sala. */
const Together = (() => {
  let room = null;            // { code, isHost, host }
  let offset = 0;             // hora del servidor - hora local (ms)
  let pollT = 0, beatT = 0, pushT = 0, bar = null, applying = false, lastTrackId = '';
  const KEY = 'mz:room';

  async function api(method, path, body) {
    const t0 = Date.now();
    const r = await fetch('/api/' + path, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch (_) {}
    if (j && j.now) offset = j.now - (t0 + Date.now()) / 2;        // reloj del servidor (con la mitad del viaje)
    return { ok: r.ok, status: r.status, j };
  }
  const available = () => !!(window.Account && Account.supported === true && Account.user);
  const trackOf = t => t && { id: t.id, title: t.title, artist: t.artist, album: t.album, artistId: t.artistId, albumId: t.albumId, cover: t.cover, dur: t.dur };

  /* ---------------------------------------------------------------- entrar y salir */
  async function create() {
    if (!available()) return toast('Para escuchar juntos inicia sesión en la web publicada');
    const r = await api('POST', 'room', { track: trackOf(App.current), playing: App.state.playing, pos: Player.time() });
    if (!r.ok) return toast((r.j && r.j.error) || 'No se pudo crear la sala');
    enter(r.j.room);
    infoSheet();
  }
  async function join(code) {
    code = String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 6) return toast('El código tiene 6 letras o números');
    if (!available()) return toast('Para escuchar juntos inicia sesión');
    const r = await api('POST', `room/${code}/join`);
    if (!r.ok) return toast((r.j && r.j.error) || 'No se pudo entrar en la sala');
    enter(r.j.room);
    toast(r.j.room.isHost ? 'Has vuelto a tu sala' : `Escuchando con ${r.j.room.host}`);
    if (!r.j.room.isHost) apply(r.j.room.state);
  }
  function enter(rm) {
    room = { code: rm.code, isHost: rm.isHost, host: rm.host };
    try { localStorage.setItem(KEY, rm.code); } catch (_) {}
    document.body.classList.add('in-room');
    renderBar(rm);
    clearInterval(pollT); clearInterval(beatT);
    pollT = setInterval(poll, 2000);
    if (room.isHost) beatT = setInterval(() => push(), 8000);
  }
  async function leave(silent) {
    if (!room) return;
    const code = room.code, host = room.isHost;
    clearInterval(pollT); clearInterval(beatT);
    room = null;
    try { localStorage.removeItem(KEY); } catch (_) {}
    document.body.classList.remove('in-room');
    bar && bar.remove(); bar = null;
    try { await api('POST', `room/${code}/leave`); } catch (_) {}
    if (!silent) toast(host ? 'Sala cerrada' : 'Has salido de la sala');
  }

  /* ---------------------------------------------------------------- anfitrión: publicar */
  function push(now) {
    if (!room || !room.isHost) return;
    clearTimeout(pushT);
    const send = () => api('POST', `room/${room.code}/state`, { track: trackOf(App.current), playing: App.state.playing, pos: Player.time() }).catch(() => {});
    now ? send() : (pushT = setTimeout(send, 250));
  }

  /* ---------------------------------------------------------------- consultar la sala */
  async function poll() {
    if (!room) return;
    let r;
    try { r = await api('GET', `room/${room.code}`); } catch (_) { return; }
    if (!room) return;
    if (r.status === 404) { leave(true); return toast('La sala se ha cerrado'); }
    if (!r.ok || !r.j) return;
    const rm = r.j.room;
    renderBar(rm);
    if (rm.isHost) {
      (rm.suggest || []).forEach(s => {
        const st = App.state;
        if (!App.current) App.playList([s.track], 0, 'Sala ' + rm.code);
        else { st.queue.splice(st.index + 1, 0, { ...s.track }); App.emit('queue'); App.saveQueue(); }
        toast(`${s.by} propone «${s.track.title}»`, 3500);
      });
    } else apply(rm.state);
  }

  /* ---------------------------------------------------------------- invitado: sincronizarse */
  function apply(st) {
    if (!room || room.isHost || !st) return;
    if (!st.track) { if (App.state.playing) Player.pause(); return; }
    const expected = st.pos + (st.playing ? (Date.now() + offset - st.at) / 1000 : 0);
    const cur = App.current;
    applying = true;
    try {
      if (!cur || (cur.id !== st.track.id && cur.vid !== st.track.id)) {
        if (lastTrackId === st.track.id && Date.now() - (apply._t || 0) < 4000) return;   // ya se está cargando
        lastTrackId = st.track.id; apply._t = Date.now();
        const s = App.state;
        s.queue = [{ ...st.track, atv: true }]; s.index = 0; s.from = 'Sala ' + room.code;
        App.start(Math.max(0, expected + .5), st.playing);                                  // +0,5 s: lo que tarda en cargar
        return;
      }
      if (!Player.ready) return;
      if (st.playing && !App.state.playing) Player.play();
      if (!st.playing && App.state.playing) Player.pause();
      // sonando: se corrige si se desvía más de 1 s; en pausa, se queda en el segundo exacto
      const drift = Player.time() - expected;
      if (Math.abs(drift) > (st.playing ? 1 : .4)) Player.seek(Math.max(0, expected));
    } finally { applying = false; }
  }

  /* ---------------------------------------------------------------- invitado: controles */
  function guardGuest() {
    const wrap = (name, msg) => {
      const orig = App[name];
      App[name] = function (...a) {
        if (room && !room.isHost && !applying) {
          if (!(name === 'next' && a[0] === true)) toast(msg || `En la sala manda ${room.host}`);   // al acabar sola: sin aviso, espera al anfitrión
          return;
        }
        return orig.apply(this, a);
      };
    };
    ['next', 'prev', 'toggle', 'jump'].forEach(n => wrap(n));
    // poner una canción siendo invitado = proponerla al anfitrión
    const pl = App.playList, pwr = App.playWithRadio;
    const propose = t => { if (!t || !t.id) return toast('Esta canción no se puede proponer'); api('POST', `room/${room.code}/suggest`, { track: trackOf(t) }).then(r => toast(r.ok ? `Propuesta enviada a ${room.host}` : (r.j && r.j.error) || 'No se pudo proponer')); };
    App.playList = function (list, i = 0, ...a) { if (room && !room.isHost && !applying) return propose(list && list[i]); return pl.call(this, list, i, ...a); };
    App.playWithRadio = function (t, ...a) { if (room && !room.isHost && !applying) return propose(t); return pwr.call(this, t, ...a); };
  }

  /* ---------------------------------------------------------------- interfaz */
  function renderBar(rm) {
    if (!room) return;
    if (!bar) {
      bar = el(`<div id="room-bar" role="status"><span class="rb-dot" aria-hidden="true"></span><button class="rb-info" type="button"></button>
        <button class="icb rb-x" type="button" aria-label="Salir de la sala">${icon('close')}</button></div>`);
      bar.querySelector('.rb-info').onclick = () => infoSheet();
      bar.querySelector('.rb-x').onclick = () => leave();
      document.body.appendChild(bar);
    }
    const n = (rm.members || []).length;
    bar.querySelector('.rb-info').innerHTML = `<b>Sala ${esc(rm.code)}</b><span>${rm.isHost ? 'Eres el anfitrión' : 'Con ' + esc(rm.host)} · ${n} ${n === 1 ? 'persona' : 'personas'}</span>`;
    bar._members = rm.members || [];
  }
  const link = () => `${location.origin}${location.pathname}#sala=${room.code}`;
  async function invite() {
    const url = link(), text = `Escucha música conmigo: sala ${room.code}`;
    if (navigator.share) { try { await navigator.share({ title: 'Escuchar juntos', text, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
    try { await navigator.clipboard.writeText(url); toast('Enlace de la sala copiado'); } catch (_) { App.prompt('Copia este enlace', url, () => {}); }
  }
  function infoSheet() {
    if (!room) return;
    const members = (bar && bar._members) || [];
    App.sheet({
      title: 'Sala ' + room.code, sub: room.isHost ? 'Eres el anfitrión: lo que pongas lo oirán todos' : `Escuchas lo que pone ${room.host}. Si eliges una canción, se le propone.`,
      body: box => {
        const b = el(`<div class="room-sheet"><div class="room-code" aria-label="Código de la sala">${room.code.split('').map(c => `<span>${c}</span>`).join('')}</div>
          <p class="muted">${members.length ? 'Escuchando ahora: ' + members.map(esc).join(', ') : ''}</p>
          <div class="acct-actions"><button class="btn tonal" data-r="leave" type="button">${room.isHost ? 'Cerrar sala' : 'Salir'}</button><button class="btn" data-r="invite" type="button">${icon('link')}Invitar</button></div></div>`);
        b.querySelector('[data-r=invite]').onclick = invite;
        b.querySelector('[data-r=leave]').onclick = () => { App.closeSheet(); leave(); };
        box.appendChild(b);
      }
    });
  }
  function openSheet() {
    if (room) return infoSheet();
    if (!available()) return toast(window.Account && Account.supported === false ? 'Escuchar juntos solo funciona en la web publicada (con cuentas)' : 'Inicia sesión para escuchar juntos');
    App.sheet({
      title: 'Escuchar juntos', sub: 'Cada uno en su dispositivo, todos oyendo lo mismo',
      body: box => {
        const b = el(`<div class="room-sheet">
          <button class="btn room-create" type="button">${icon('plus')}Crear una sala</button>
          <p class="muted">o entra en la sala de otra persona:</p>
          <form class="room-join"><input type="text" maxlength="6" placeholder="CÓDIGO" aria-label="Código de la sala" autocapitalize="characters" spellcheck="false"><button class="btn tonal" type="submit">Entrar</button></form></div>`);
        b.querySelector('.room-create').onclick = () => { App.closeSheet(); create(); };
        b.querySelector('.room-join').onsubmit = e => { e.preventDefault(); const c = e.target.querySelector('input').value; App.closeSheet(); join(c); };
        box.appendChild(b);
      }
    });
  }

  // anfitrión: publicar cada cambio; también si adelanta o atrasa con la barra
  function hostHooks() {
    App.on('track', () => push(true));
    const up = App.updatePlaying;
    App.updatePlaying = function (...a) { const r = up.apply(this, a); push(); return r; };
    let lastPos = 0, lastAt = 0;
    App.on('time', ({ cur }) => {
      const now = Date.now();
      if (room && room.isHost && App.state.playing && lastAt && Math.abs(cur - (lastPos + (now - lastAt) / 1000)) > 2) push();
      lastPos = cur; lastAt = now;
    });
  }

  // "#sala=CÓDIGO" en la dirección, o la sala en la que estabas antes de recargar
  function autoJoin() {
    if (window.Account && Account.supported === null) return setTimeout(autoJoin, 700);
    if (document.body.classList.contains('gated')) return setTimeout(autoJoin, 1000);
    const m = location.hash.match(/^#sala=([A-Za-z0-9]{6})/);
    let code = m ? m[1] : '';
    if (m) history.replaceState(null, '', location.pathname + location.search);
    if (!code) { try { code = localStorage.getItem(KEY) || ''; } catch (_) {} }
    if (code && available()) join(code).then(() => { if (!room) try { localStorage.removeItem(KEY); } catch (_) {} });
  }

  document.addEventListener('DOMContentLoaded', () => {
    guardGuest(); hostHooks();
    document.addEventListener('click', e => { if (e.target.closest('[data-together]')) openSheet(); });
    setTimeout(autoJoin, 900);
  }, { once: true });
  addEventListener('hashchange', () => { if (/^#sala=/.test(location.hash)) autoJoin(); });

  return { open: openSheet, create, join, leave, get room() { return room; } };
})();
window.Together = Together;
