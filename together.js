'use strict';
/* together.js — "Escuchar juntos": cada persona oye la música en su dispositivo, sincronizada.
   - El anfitrión y los administradores que él nombre manejan la música: al cambiar algo lo
     publican, y los demás (también el anfitrión) se ajustan al último cambio. El anfitrión además
     publica un latido cada 8 s.
   - Los invitados consultan la sala cada 2 s y se ajustan: cambian de canción, pausan/reanudan y
     corrigen la posición si se desvían más de 1 s (compensando la diferencia de reloj con el
     servidor). Si un invitado pone una canción, se propone al anfitrión y este la añade a su cola.
   - El anfitrión puede bloquear a alguien en esa sala o en todas sus salas.
   - Necesita las cuentas (web publicada en Cloudflare). Se entra con el código o con un enlace
     "#sala=CÓDIGO". Al recargar la página se vuelve a entrar en la misma sala. */
const Together = (() => {
  let room = null;            // { code, isHost, isAdmin, host }
  let offset = 0;             // hora del servidor - hora local (ms)
  let pollT = 0, beatT = 0, pushT = 0, bar = null, applying = false, lastTrackId = '';
  let lastV = 0;              // última versión del estado de la sala que conoce este dispositivo
  let quietUntil = 0;         // tras aplicar un cambio de otro, no se republica lo mismo
  let lastRoom = null;        // última vista de la sala (personas, bloqueados)
  let needSync = false;       // al entrar (o al recargar) hay que ponerse al día antes de publicar nada
  let intentAt = 0;           // última acción de verdad de esta persona (play, pausa, adelantar)
  let trackAt = 0;            // último cambio de canción propio (no el que llega de la sala)
  let hold = false;           // invitado que ha pausado solo para él
  let hintAt = 0;             // aviso de "toca ▶" (los navegadores no dejan sonar sin tocar antes)
  const canCtl = () => !!(room && (room.isHost || room.isAdmin));
  const me = () => String((window.Account && Account.user) || '').toLowerCase();
  const KEY = 'mz:room';

  async function api(method, path, body) {
    const t0 = Date.now();
    const r = await fetch('/api/' + path, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch (_) {}
    if (j && j.now) offset = j.now - (t0 + Date.now()) / 2;        // reloj del servidor (con la mitad del viaje)
    return { ok: r.ok, status: r.status, j };
  }
  const available = () => !!(window.Account && Account.supported === true && Account.user);
  // a la sala se publica el id con el que llegó la canción (no la versión que suene aquí)
  const trackOf = t => t && { id: t.roomId || t.id, title: t.title, artist: t.artist, album: t.album, artistId: t.artistId, albumId: t.albumId, cover: t.cover, dur: t.dur };

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
    enter(r.j.room, true);
    toast(r.j.room.isHost ? 'Has vuelto a tu sala' : r.j.room.isAdmin ? `Eres administrador en la sala de ${r.j.room.host}` : `Escuchando con ${r.j.room.host}`);
    // todos (también el anfitrión al recargar) se ponen con lo que suena ahora en la sala
    apply(r.j.room.state);
  }
  function enter(rm, joining) {
    room = { code: rm.code, isHost: rm.isHost, isAdmin: !!rm.isAdmin, host: rm.host };
    lastV = rm.v || 0;
    needSync = !!joining; hold = false; hintAt = 0; lastTrackId = '';
    try { localStorage.setItem(KEY, rm.code); } catch (_) {}
    document.body.classList.add('in-room');
    renderBar(rm);
    clearInterval(pollT); clearInterval(beatT);
    pollT = setInterval(poll, 2000);
    if (room.isHost) beatT = setInterval(() => push(true, true), 8000);
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

  /* ---------------------------------------------------------------- anfitrión y administradores: publicar */
  function push(now, beat) {
    if (!canCtl()) return;
    if (beat && needSync) return;                       // aún no está al día: no pisa lo que suena en la sala
    if (!beat && Date.now() < quietUntil) return;       // es el eco de un cambio de otro: no se republica
    clearTimeout(pushT);
    const send = () => {
      if (!canCtl()) return;
      api('POST', `room/${room.code}/state`, { track: trackOf(App.current), playing: App.state.playing, pos: Player.time(), beat: !!beat, baseV: lastV })
        .then(r => { if (r.ok && r.j && r.j.ok !== false && r.j.v) lastV = r.j.v; }).catch(() => {});
    };
    now ? send() : (pushT = setTimeout(send, 250));
  }

  /* ---------------------------------------------------------------- consultar la sala */
  async function poll() {
    if (!room) return;
    let r;
    try { r = await api('GET', `room/${room.code}`); } catch (_) { return; }
    if (!room) return;
    if (r.status === 404) { leave(true); return toast('La sala se ha cerrado'); }
    if (r.status === 403) { leave(true); return toast('El anfitrión te ha bloqueado en esta sala', 4000); }
    if (!r.ok || !r.j) return;
    const rm = r.j.room;
    if (!rm.isHost && !!rm.isAdmin !== room.isAdmin) {
      room.isAdmin = !!rm.isAdmin;
      hold = false;
      toast(room.isAdmin ? `${rm.host} te ha hecho administrador: ya puedes manejar la música` : 'Ya no eres administrador de la sala', 4000);
    }
    renderBar(rm);
    // quien maneja la música se ajusta a los cambios de los demás (y, al entrar, hasta quedar al
    // día); los invitados, siempre
    const fresh = rm.v > lastV;
    if (fresh) lastV = rm.v;
    const st = rm.state;
    if (canCtl()) {
      const other = st && st.by && String(st.by).toLowerCase() !== me();
      if ((fresh && other) || needSync) apply(st);
      if (needSync && inSync(st)) needSync = false;
    } else apply(st);
    hintPlay(st);
    if (rm.isHost) {
      (rm.suggest || []).forEach(s => {
        const st = App.state;
        if (!App.current) App.playList([s.track], 0, 'Sala ' + rm.code);
        else { st.queue.splice(st.index + 1, 0, { ...s.track }); App.emit('queue'); App.saveQueue(); }
        toast(`${s.by} propone «${s.track.title}»`, 3500);
      });
    }
  }

  /* ---------------------------------------------------------------- sincronizarse con la sala */
  const expectedPos = st => st.pos + (st.playing ? (Date.now() + offset - st.at) / 1000 : 0);
  // la misma canción aunque en este dispositivo suene otra versión (si la original no se podía
  // reproducir aquí, la app prueba otra y cambia el id)
  const sameTrack = (cur, st) => {
    if (!cur || !st || !st.track) return false;
    const id = st.track.id;
    return cur.id === id || cur.vid === id || cur.roomId === id || !!(cur._tried && cur._tried.includes(id));
  };
  function inSync(st) {
    if (!st || !st.track) return true;
    if (!Player.ready || !sameTrack(App.current, st) || !!App.state.playing !== !!st.playing) return false;
    return Math.abs(Player.time() - expectedPos(st)) < 2.5;
  }
  // tras recargar, el navegador no deja que suene hasta que se toca algo: se avisa una vez
  function hintPlay(st) {
    if (!st || !st.playing || hold || App.state.playing || !sameTrack(App.current, st) || !Player.ready) { if (App.state.playing) hintAt = 0; return; }
    if (!hintAt) { hintAt = Date.now(); return; }
    if (hintAt > 0 && Date.now() - hintAt > 4000) { hintAt = -1; toast('Toca ▶ para escuchar lo que suena en la sala', 5000); }
  }
  function apply(st) {
    if (!room || !st || hold) return;
    if (!st.track) { if (App.state.playing && !canCtl()) Player.pause(); return; }
    const expected = expectedPos(st);
    const cur = App.current;
    applying = true;
    try {
      if (!sameTrack(cur, st)) {
        if (lastTrackId === st.track.id && Date.now() - (apply._t || 0) < 4000) return;   // ya se está cargando
        lastTrackId = st.track.id; apply._t = Date.now();
        quietUntil = Date.now() + 4000;
        const s = App.state;
        if (canCtl() && s.queue.length) {
          // quien maneja la música conserva su cola: salta a esa canción (o la mete a continuación)
          const i = s.queue.findIndex(x => sameTrack(x, st));
          if (i >= 0) s.index = i;
          else { s.queue.splice(s.index + 1, 0, { ...st.track, atv: true, roomId: st.track.id }); s.index++; }
        } else { s.queue = [{ ...st.track, atv: true, roomId: st.track.id }]; s.index = 0; s.from = 'Sala ' + room.code; }
        App.start(Math.max(0, expected + .5), st.playing);                                  // +0,5 s: lo que tarda en cargar
        App.saveQueue && App.saveQueue();
        return;
      }
      if (!Player.ready) return;
      if (st.playing !== App.state.playing) quietUntil = Date.now() + 1500;
      if (st.playing && !App.state.playing) Player.play();
      if (!st.playing && App.state.playing) Player.pause();
      // sonando: se corrige si se desvía más de 1 s; en pausa, se queda en el segundo exacto
      const drift = Player.time() - expected;
      if (Math.abs(drift) > (st.playing ? 1 : .4)) { quietUntil = Date.now() + 1500; Player.seek(Math.max(0, expected)); }
    } finally { applying = false; }
  }

  /* ---------------------------------------------------------------- invitado: controles */
  function guardGuest() {
    const wrap = (name, msg) => {
      const orig = App[name];
      App[name] = function (...a) {
        // al acabar la canción sola, solo avanza el anfitrión (los demás esperan a su cambio)
        if (room && !room.isHost && !applying && name === 'next' && a[0] === true) return;
        if (room && !canCtl() && !applying) { toast(msg || `En la sala manda ${room.host}`); return; }
        return orig.apply(this, a);
      };
    };
    // play/pausa no se bloquea aquí: lo decide el reproductor (ver hooks), así un invitado puede
    // darle a ▶ para empezar a oír la sala o pausar solo para él
    ['next', 'prev', 'jump'].forEach(n => wrap(n));
    // poner una canción siendo invitado = proponerla al anfitrión
    const pl = App.playList, pwr = App.playWithRadio;
    const propose = t => { if (!t || !t.id) return toast('Esta canción no se puede proponer'); api('POST', `room/${room.code}/suggest`, { track: trackOf(t) }).then(r => toast(r.ok ? `Propuesta enviada a ${room.host}` : (r.j && r.j.error) || 'No se pudo proponer')); };
    App.playList = function (list, i = 0, ...a) { if (room && !canCtl() && !applying) return propose(list && list[i]); return pl.call(this, list, i, ...a); };
    App.playWithRadio = function (t, ...a) { if (room && !canCtl() && !applying) return propose(t); return pwr.call(this, t, ...a); };
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
    bar.querySelector('.rb-info').innerHTML = `<b>Sala ${esc(rm.code)}</b><span>${rm.isHost ? 'Eres el anfitrión' : rm.isAdmin ? 'Administrador · con ' + esc(rm.host) : 'Con ' + esc(rm.host)} · ${n} ${n === 1 ? 'persona' : 'personas'}</span>`;
    bar._members = rm.members || [];
    lastRoom = rm;
    // si la hoja de la sala está abierta, se actualiza la lista de personas
    const ppl = document.querySelector('#sheet .room-people');
    if (ppl && ppl.dataset.code === rm.code) renderPeople(ppl);
  }

  /* ---------------------------------------------------------------- personas: administradores y bloqueos */
  async function hostAct(act, name, extra, msg) {
    if (!room || !room.isHost) return;
    const r = await api('POST', `room/${room.code}/${act}`, { name, ...extra });
    if (!r.ok) return toast((r.j && r.j.error) || 'No se pudo hacer', 3500);
    toast(msg);
    if (r.j && r.j.room) renderBar(r.j.room);
  }
  function personMenu(p) {
    App.sheet({
      title: p.name, sub: p.admin ? 'Administrador: puede manejar la música' : 'Invitado: escucha y propone canciones',
      items: [
        p.admin ? { icon: 'person', label: 'Quitar administrador', fn: () => hostAct('admin', p.name, { on: false }, `${p.name} ya no es administrador`) }
          : { icon: 'person', label: 'Hacer administrador', fn: () => hostAct('admin', p.name, { on: true }, `${p.name} ahora puede manejar la música`) },
        { icon: 'close', label: 'Bloquear en esta sala', fn: () => confirmBan(p.name, 'room') },
        { icon: 'close', label: 'Bloquear en todas mis salas', fn: () => confirmBan(p.name, 'all') }
      ]
    });
  }
  function confirmBan(name, scope) {
    App.sheet({
      title: `¿Bloquear a ${name}?`, sub: scope === 'all' ? 'Saldrá de esta sala y no podrá entrar en ninguna sala tuya' : 'Saldrá de esta sala y no podrá volver a entrar en ella',
      items: [{ icon: 'close', label: 'Bloquear', fn: () => hostAct('ban', name, { scope }, scope === 'all' ? `${name} bloqueado en todas tus salas` : `${name} bloqueado en esta sala`) }]
    });
  }
  function renderPeople(box) {
    const rm = lastRoom;
    if (!rm || !room) return;
    box.innerHTML = '';
    const people = (rm.people || []).slice().sort((a, b) => (b.host - a.host) || (b.admin - a.admin) || a.name.localeCompare(b.name));
    people.forEach(p => {
      const badge = p.host ? 'Anfitrión' : p.admin ? 'Administrador' : '';
      const row = el(`<div class="rp-row"><span class="rp-av" aria-hidden="true">${esc(p.name.slice(0, 1).toUpperCase())}</span>
        <span class="rp-name">${esc(p.name)}${p.me ? ' (tú)' : ''}${badge ? `<small>${badge}</small>` : ''}</span></div>`);
      if (room.isHost && !p.host && !p.me) {
        const b = el(`<button class="icb" type="button" aria-label="Opciones de ${esc(p.name)}">${icon('more')}</button>`);
        b.onclick = () => personMenu(p);
        row.appendChild(b);
      }
      box.appendChild(row);
    });
    if (room.isHost && rm.bans && rm.bans.length) {
      box.appendChild(el('<p class="rp-sec">Bloqueados</p>'));
      rm.bans.forEach(x => {
        const row = el(`<div class="rp-row"><span class="rp-av off" aria-hidden="true">${esc(x.name.slice(0, 1).toUpperCase())}</span>
          <span class="rp-name">${esc(x.name)}<small>${x.scope === 'all' ? 'En todas tus salas' : 'En esta sala'}</small></span>
          <button class="btn tonal rp-un" type="button">Desbloquear</button></div>`);
        row.querySelector('.rp-un').onclick = () => hostAct('unban', x.name, { scope: x.scope }, `${x.name} desbloqueado`);
        box.appendChild(row);
      });
    }
  }
  const link = () => `${location.origin}${location.pathname}#sala=${room.code}`;
  async function invite() {
    const url = link(), text = `Escucha música conmigo: sala ${room.code}`;
    if (navigator.share) { try { await navigator.share({ title: 'Escuchar juntos', text, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
    try { await navigator.clipboard.writeText(url); toast('Enlace de la sala copiado'); } catch (_) { App.prompt('Copia este enlace', url, () => {}); }
  }
  function infoSheet() {
    if (!room) return;
    App.sheet({
      title: 'Sala ' + room.code,
      sub: room.isHost ? 'Eres el anfitrión' : room.isAdmin ? 'Eres administrador' : 'Con ' + room.host,
      body: box => {
        const hint = room.isHost ? 'Lo que pongas lo oirán todos. Toca ⋯ junto a alguien para hacerle administrador (podrá cambiar de canción, pausar y adelantar) o para bloquearle.'
          : room.isAdmin ? `Puedes cambiar de canción, pausar y adelantar en la sala de ${room.host}.`
          : `Escuchas lo que pone ${room.host}. Si eliges una canción, se le propone.`;
        const b = el(`<div class="room-sheet"><div class="room-code" aria-label="Código de la sala">${room.code.split('').map(c => `<span>${c}</span>`).join('')}</div>
          <div class="room-people" data-code="${esc(room.code)}"></div>
          <p class="muted" style="font-size:13.5px">${esc(hint)}</p>
          <div class="acct-actions"><button class="btn tonal" data-r="leave" type="button">${room.isHost ? 'Cerrar sala' : 'Salir'}</button><button class="btn" data-r="invite" type="button">${icon('link')}Invitar</button></div></div>`);
        b.querySelector('[data-r=invite]').onclick = invite;
        b.querySelector('[data-r=leave]').onclick = () => { App.closeSheet(); leave(); };
        renderPeople(b.querySelector('.room-people'));
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

  /* Se publica solo lo que hace alguien de verdad (o el cambio de canción del anfitrión al acabar
     una), nunca lo que el reproductor hace solo: cargar, quedarse bloqueado sin sonido tras
     recargar, etc. Así nadie mueve a toda la sala por accidente. */
  function hostHooks() {
    // play, pausa y adelantar (botones, barra, letra, teclado, pantalla de bloqueo, temporizador…)
    ['play', 'pause', 'seek'].forEach(n => {
      const orig = Player[n].bind(Player);
      Player[n] = function (...a) {
        if (room && !applying) {
          if (canCtl()) { intentAt = Date.now(); needSync = false; quietUntil = 0; if (n === 'seek') { orig(...a); push(); return; } }
          else if (n === 'seek') { toast(`En la sala manda ${room.host}`); return; }
          else if (n === 'pause') { hold = true; toast('Pausado solo para ti: dale a ▶ para volver con la sala', 3500); }
          else if (n === 'play') { hold = false; hintAt = -1; if (lastRoom && lastRoom.state && lastRoom.state.track) { orig(...a); setTimeout(() => apply(lastRoom.state), 400); return; } }
        }
        return orig(...a);
      };
    });
    App.on('track', () => {
      if (!room || applying || Date.now() < quietUntil) return;
      trackAt = Date.now(); push(true);
    });
    const up = App.updatePlaying;
    App.updatePlaying = function (...a) {
      const r = up.apply(this, a);
      const now = Date.now();
      if (room && canCtl() && (now - intentAt < 4000 || now - trackAt < 8000)) push();
      return r;
    };
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
