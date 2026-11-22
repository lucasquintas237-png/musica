'use strict';
/* together.js — "Escuchar juntos": cada persona oye la música en su dispositivo, sincronizada,
   al estilo Jam.
   - Controlan la música el anfitrión, los administradores que él nombre y, si él lo permite, todos:
     al cambiar algo lo publican y los demás (también el anfitrión) se ajustan al último cambio.
     El anfitrión además publica un latido cada 8 s.
   - Cola compartida: todo el mundo ve qué viene después y quién lo añadió. Los invitados añaden
     canciones directamente (si el anfitrión lo permite) y pueden quitar las suyas. Al acabar una
     canción, el anfitrión pone la siguiente de la cola de la sala.
   - Reacciones con emojis que ven todos, chat y "Añadir canciones para el grupo".
   - Los invitados consultan la sala cada 2 s y se ajustan: cambian de canción, pausan/reanudan y
     corrigen la posición si se desvían más de 1 s (compensando la diferencia de reloj con el servidor).
   - El anfitrión puede bloquear a alguien en esa sala o en todas sus salas.
   - Necesita las cuentas (web publicada en Cloudflare). Se entra con el código o con un enlace
     "#sala=CÓDIGO". Al recargar la página se vuelve a entrar en la misma sala. */
const Together = (() => {
  let room = null;            // { code, isHost, isAdmin, control, host }
  let offset = 0;             // hora del servidor - hora local (ms)
  let pollT = 0, beatT = 0, pushT = 0, bar = null, applying = false, lastTrackId = '';
  let lastV = 0;              // última versión del estado de la sala que conoce este dispositivo
  let quietUntil = 0;         // tras aplicar un cambio de otro, no se republica lo mismo
  let lastRoom = null;        // última vista de la sala (personas, cola, ajustes, bloqueados)
  let needSync = false;       // al entrar (o al recargar) hay que ponerse al día antes de publicar nada
  let intentAt = 0;           // última acción de verdad de esta persona (play, pausa, adelantar)
  let trackAt = 0;            // último cambio de canción propio (no el que llega de la sala)
  let hold = false;           // invitado que ha pausado solo para él
  let hintAt = 0;             // aviso de "toca ▶" (los navegadores no dejan sonar sin tocar antes)
  let lastEvent = 0;          // último evento (reacción, chat…) recibido
  let chat = [];              // mensajes del chat
  let popping = false;
  const EMOJIS = ['🔥', '❤️', '😂', '🙌', '💃', '👏', '😍', '🤯'];
  const canCtl = () => !!(room && (room.isHost || room.control));
  const me = () => String((window.Account && Account.user) || '').toLowerCase();
  const isMe = name => String(name || '').toLowerCase() === me();
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
    toast(r.j.room.isHost ? 'Has vuelto a tu sala' : r.j.room.control ? `Eres administrador en la sala de ${r.j.room.host}` : `Escuchando con ${r.j.room.host}`);
    // todos (también el anfitrión al recargar) se ponen con lo que suena ahora en la sala
    apply(r.j.room.state);
  }
  function enter(rm, joining) {
    room = { code: rm.code, isHost: rm.isHost, isAdmin: !!rm.isAdmin, control: !!rm.control, host: rm.host };
    lastV = rm.v || 0;
    needSync = !!joining; hold = false; hintAt = 0; lastTrackId = '';
    chat = []; lastEvent = rm.lastEvent || 0;
    (rm.events || []).forEach(e => { if (e.kind === 'chat') chat.push(e); });
    try { localStorage.setItem(KEY, rm.code); } catch (_) {}
    document.body.classList.add('in-room');
    document.querySelectorAll('[data-together]').forEach(b => b.setAttribute('aria-label', 'Escuchar juntos: estás en una sala'));
    renderBar(rm);
    clearInterval(pollT); clearInterval(beatT);
    pollT = setInterval(poll, 2000);
    if (room.isHost) beatT = setInterval(() => push(true, true), 8000);
  }
  async function leave(silent) {
    if (!room) return;
    const code = room.code, host = room.isHost;
    clearInterval(pollT); clearInterval(beatT);
    room = null; lastRoom = null; chat = [];
    try { localStorage.removeItem(KEY); } catch (_) {}
    document.body.classList.remove('in-room');
    document.querySelectorAll('[data-together]').forEach(b => b.setAttribute('aria-label', 'Escuchar juntos'));
    bar && bar.remove(); bar = null;
    // "Reproduciendo · Sala ABC123" ya no tiene sentido: vuelve a mostrar el álbum o el artista
    const s = App.state;
    if (s.from && s.from.startsWith('Sala ')) {
      s.from = '';
      const t = App.current, f = document.getElementById('p-from');
      if (t && f) f.textContent = t.album || t.artist || '—';
      App.saveQueue && App.saveQueue();
    }
    try { await api('POST', `room/${code}/leave`); } catch (_) {}
    if (!silent) toast(host ? 'Sala cerrada' : 'Has salido de la sala');
  }

  /* ---------------------------------------------------------------- quien controla: publicar */
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
    try { r = await api('GET', `room/${room.code}?since=${lastEvent}`); } catch (_) { return; }
    if (!room) return;
    if (r.status === 404) { leave(true); return toast('La sala se ha cerrado'); }
    if (r.status === 403) { leave(true); return toast('El anfitrión te ha bloqueado en esta sala', 4000); }
    if (!r.ok || !r.j) return;
    const rm = r.j.room;
    if (!rm.isHost && !!rm.control !== room.control) {
      room.control = !!rm.control;
      hold = false;
      toast(room.control ? 'Ya puedes manejar la música de la sala' : 'Ya no puedes manejar la música de la sala', 4000);
    }
    room.isAdmin = !!rm.isAdmin;
    handleEvents(rm.events || []);
    if (rm.lastEvent > lastEvent) lastEvent = rm.lastEvent;
    renderBar(rm);
    // quien maneja la música se ajusta a los cambios de los demás (y, al entrar, hasta quedar al
    // día); los invitados, siempre
    const fresh = rm.v > lastV;
    if (fresh) lastV = rm.v;
    const st = rm.state;
    if (canCtl()) {
      const other = st && st.by && !isMe(st.by);
      // tras aplicar un cambio de otro, el latido del anfitrión se calla hasta que este dispositivo
      // esté de verdad al día: si no, mientras carga la canción nueva publicaría la vieja o el
      // segundo 0 y desharía el cambio
      if (fresh && other) { apply(st); needSync = true; }
      else if (needSync) apply(st);
      if (needSync && inSync(st)) needSync = false;
    } else apply(st);
    hintPlay(st);
    // sala sin nada sonando y con canciones en la cola: el anfitrión empieza
    if (room.isHost && !App.current && rm.queue && rm.queue.length) popAndPlay(false);
  }

  /* ---------------------------------------------------------------- eventos: reacciones, chat, canciones añadidas */
  function handleEvents(list) {
    let newChat = false;
    for (const e of list) {
      if (e.id <= lastEvent) continue;
      lastEvent = e.id;
      if (e.kind === 'react') { if (!isMe(e.by)) floatEmoji(e.data.emoji, e.by); }
      else if (e.kind === 'chat') {
        chat.push(e); if (chat.length > 50) chat.shift(); newChat = true;
        if (!isMe(e.by) && !sheetOpen()) toast(`${e.by}: ${e.data.text}`, 4000);
      } else if (e.kind === 'add') { if (!isMe(e.by)) toast(`${e.by} añadió «${e.data.title}»`, 3000); }
    }
    if (newChat) renderChat();
  }
  // emoji que sube flotando por la pantalla (como en los directos)
  function floatEmoji(emoji, by) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return toast(`${by || ''} ${emoji}`.trim(), 1500);
    const n = document.createElement('div');
    n.className = 'room-float';
    n.innerHTML = `<span class="rf-e">${esc(emoji)}</span>${by ? `<span class="rf-by">${esc(by)}</span>` : ''}`;
    n.style.left = (12 + Math.random() * 70) + '%';
    n.style.setProperty('--dx', (Math.random() * 80 - 40) + 'px');
    document.body.appendChild(n);
    setTimeout(() => n.remove(), 2600);
  }
  function react(emoji) {
    if (!room) return;
    floatEmoji(emoji, '');
    api('POST', `room/${room.code}/react`, { emoji }).catch(() => {});
  }
  async function sendChat(text) {
    if (!room || !(text = String(text || '').trim())) return;
    const r = await api('POST', `room/${room.code}/chat`, { text }).catch(() => null);
    if (!r || !r.ok) return toast((r && r.j && r.j.error) || 'No se pudo enviar', 2500);
    poll();
  }

  /* ---------------------------------------------------------------- cola compartida */
  async function addToQueue(t, quiet) {
    if (!room) return false;
    if (!t || !t.id) { if (typeof Sources !== 'undefined') { try { await Sources.resolve(t); } catch (_) {} } }
    if (!t || !t.id) { toast('Esta canción no se puede añadir'); return false; }
    const r = await api('POST', `room/${room.code}/queue`, { track: trackOf(t) }).catch(() => null);
    if (!r || !r.ok) { toast((r && r.j && r.j.error) || 'No se pudo añadir', 3000); return false; }
    if (r.j && r.j.room) renderBar(r.j.room);
    if (!quiet) toast(`Añadida a la cola de la sala: «${t.title}»`);
    return true;
  }
  async function removeFromQueue(qid) {
    const r = await api('POST', `room/${room.code}/queue/remove`, { qid }).catch(() => null);
    if (!r || !r.ok) return toast((r && r.j && r.j.error) || 'No se pudo quitar', 2500);
    if (r.j && r.j.room) renderBar(r.j.room);
  }
  // pasa a la siguiente de la cola de la sala (quien controla); devuelve si había alguna
  async function popAndPlay(auto) {
    if (popping || !room) return false;
    popping = true;
    try {
      const r = await api('POST', `room/${room.code}/queue/pop`).catch(() => null);
      const t = r && r.ok && r.j && r.j.track;
      if (!t) return false;
      const s = App.state, item = { ...t, atv: true, roomId: t.id };
      if (!App.current) { s.queue = [item]; s.index = 0; App.start(); }
      else { s.queue.splice(s.index + 1, 0, item); s.index++; App.start(); }
      App.saveQueue && App.saveQueue();
      if (r.j.by && !isMe(r.j.by)) toast(`Suena lo que añadió ${r.j.by}: «${t.title}»`, 3000);
      return true;
    } finally { popping = false; }
  }
  // canciones para el grupo: parecidas a lo que suena (sin repetir lo que ya está en la cola)
  async function addForGroup(btn) {
    const base = App.current || (lastRoom && lastRoom.state && lastRoom.state.track);
    if (!base) return toast('Pon algo primero para saber qué os gusta');
    if (btn) { btn.disabled = true; btn.dataset.l = btn.textContent; btn.textContent = 'Buscando…'; }
    try {
      const have = new Set([(base.roomId || base.id), base.vid, ...((lastRoom && lastRoom.queue) || []).map(q => q.track.id)].filter(Boolean));
      const list = (window.Reco ? await Reco.radioFor(base) : await YTM.radio(base.id)).filter(t => t.id && !have.has(t.id)).slice(0, 5);
      let n = 0;
      for (const t of list) if (await addToQueue(t, true)) n++;
      toast(n ? `${n} canciones añadidas para el grupo` : 'No se encontraron canciones parecidas');
    } catch (_) { toast('No se encontraron canciones parecidas'); }
    if (btn) { btn.disabled = false; btn.textContent = btn.dataset.l; }
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
    // poner una canción siendo invitado = añadirla a la cola de la sala (como en un Jam)
    const pl = App.playList, pwr = App.playWithRadio;
    App.playList = function (list, i = 0, ...a) { if (room && !canCtl() && !applying) return addToQueue(list && list[i]); return pl.call(this, list, i, ...a); };
    App.playWithRadio = function (t, ...a) { if (room && !canCtl() && !applying) return addToQueue(t); return pwr.call(this, t, ...a); };
  }

  /* ---------------------------------------------------------------- interfaz */
  const sheetOpen = () => !!document.querySelector('#sheet:not([hidden]) .room-sheet[data-code]');
  function renderBar(rm) {
    if (!room) return;
    lastRoom = rm;
    if (!bar) {
      bar = el(`<div id="room-bar" role="status"><span class="rb-dot" aria-hidden="true"></span><button class="rb-info" type="button"></button>
        <button class="icb rb-x" type="button" aria-label="Salir de la sala">${icon('close')}</button></div>`);
      bar.querySelector('.rb-info').onclick = () => infoSheet();
      bar.querySelector('.rb-x').onclick = () => leave();
      document.body.appendChild(bar);
    }
    const n = (rm.members || []).length;
    bar.querySelector('.rb-info').innerHTML = `<b>Sala ${esc(rm.code)}</b><span>${rm.isHost ? 'Eres el anfitrión' : rm.isAdmin ? 'Administrador · con ' + esc(rm.host) : 'Con ' + esc(rm.host)} · ${n} ${n === 1 ? 'persona' : 'personas'}</span>`;
    // si la hoja de la sala está abierta, se actualizan sus partes
    const sh = document.querySelector('#sheet .room-sheet[data-code]');
    if (sh && sh.dataset.code === rm.code) {
      renderPeople(sh.querySelector('.room-people'));
      renderQueue(sh.querySelector('.room-queue'));
      renderConf(sh.querySelector('.room-conf'));
    }
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
      title: p.name, sub: p.admin ? 'Administrador: puede manejar la música' : 'Invitado: escucha y añade canciones',
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
    if (!box || !rm || !room) return;
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
  // la cola de la sala, con quién añadió cada canción
  function renderQueue(box) {
    const rm = lastRoom;
    if (!box || !rm || !room) return;
    const q = rm.queue || [];
    const sig = q.map(x => x.qid).join(',') + '|' + canCtl();
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.innerHTML = '';
    if (!q.length) {
      box.appendChild(el(`<p class="muted rq-empty">${rm.conf && !rm.conf.guestsAdd && !canCtl() ? 'El anfitrión no deja añadir canciones.' : 'Aún no hay nada en la cola. Busca una canción y púlsala para añadirla.'}</p>`));
      return;
    }
    q.forEach((x, i) => {
      const t = x.track;
      const row = el(`<div class="rq-row"><img class="rq-art" src="${esc(small(t.cover) || PLACEHOLDER)}" alt="">
        <span class="rq-txt"><b class="ellipsis">${esc(t.title)}</b><small class="ellipsis">${esc(t.artist)}</small></span>
        <span class="rq-by" title="Añadida por ${esc(x.by)}">${esc(x.by.slice(0, 1).toUpperCase())}</span></div>`);
      if (x.mine || canCtl()) {
        const b = el(`<button class="icb" type="button" aria-label="Quitar de la cola">${icon('close')}</button>`);
        b.onclick = () => removeFromQueue(x.qid);
        row.appendChild(b);
      }
      box.appendChild(row);
    });
  }
  function renderChat(root) {
    const box = (root || document).querySelector(root ? '.room-chat-log' : '#sheet .room-chat-log');
    if (!box) return;
    box.innerHTML = '';
    if (!chat.length) { box.appendChild(el('<p class="muted rc-empty">Di algo a la sala 👋</p>')); return; }
    chat.slice(-30).forEach(m => {
      box.appendChild(el(`<div class="rc-msg${isMe(m.by) ? ' me' : ''}"><b>${esc(m.by)}</b><span>${esc(m.data.text)}</span></div>`));
    });
    box.scrollTop = box.scrollHeight;
  }
  // ajustes de la sala (los cambia el anfitrión; los demás los ven)
  function renderConf(box) {
    const rm = lastRoom;
    if (!box || !rm || !room || !room.isHost) return;
    const c = rm.conf || {};
    const sig = JSON.stringify(c);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    const sw = on => `<span class="switch${on ? ' on' : ''}" role="switch" aria-checked="${!!on}"></span>`;
    box.innerHTML = `<p class="rp-sec">Ajustes de la sala</p>
      <div class="set" data-c="guestsAdd"><div class="lbl">Todos pueden añadir canciones<small>Lo que elijan va a la cola de la sala</small></div>${sw(c.guestsAdd)}</div>
      <div class="set" data-c="guestsControl"><div class="lbl">Todos pueden controlar la música<small>Pausar, saltar y cambiar de canción, como tú</small></div>${sw(c.guestsControl)}</div>`;
    box.querySelectorAll('[data-c]').forEach(x => x.onclick = async () => {
      const k = x.dataset.c;
      const r = await api('POST', `room/${room.code}/conf`, { [k]: !c[k] }).catch(() => null);
      if (r && r.ok && r.j && r.j.room) renderBar(r.j.room);
      else toast('No se pudo cambiar', 2500);
    });
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
      sub: room.isHost ? 'Eres el anfitrión' : room.control ? 'Puedes manejar la música' : 'Con ' + room.host,
      body: box => {
        const hint = room.isHost ? 'Lo que pongas lo oirán todos. Toca ⋯ junto a alguien para hacerle administrador (podrá cambiar de canción, pausar y adelantar) o para bloquearle.'
          : room.control ? `Puedes cambiar de canción, pausar y adelantar en la sala de ${room.host}.`
          : 'Elige canciones para añadirlas a la cola de la sala. Suenan para todos cuando les toca.';
        const b = el(`<div class="room-sheet" data-code="${esc(room.code)}">
          <div class="room-code" aria-label="Código de la sala">${room.code.split('').map(c => `<span>${c}</span>`).join('')}</div>
          <div class="acct-actions"><button class="btn tonal" data-r="leave" type="button">${room.isHost ? 'Cerrar sala' : 'Salir'}</button><button class="btn" data-r="invite" type="button">${icon('link')}Invitar</button></div>
          <div class="room-react" role="group" aria-label="Reacciones">${EMOJIS.map(e => `<button type="button" data-e="${e}" aria-label="Reaccionar con ${e}">${e}</button>`).join('')}</div>
          <p class="rp-sec">Cola de la sala</p>
          <div class="room-queue"></div>
          <button class="btn tonal room-group" type="button">${icon('radio')}Añadir canciones para el grupo</button>
          <p class="rp-sec">Chat</p>
          <div class="room-chat"><div class="room-chat-log" aria-live="polite"></div>
            <form class="room-chat-form"><input type="text" maxlength="200" placeholder="Escribe un mensaje…" aria-label="Mensaje para la sala" autocomplete="off"><button class="btn" type="submit">Enviar</button></form></div>
          <p class="rp-sec">En la sala</p>
          <div class="room-people"></div>
          <div class="room-conf"></div>
          <p class="muted" style="font-size:13.5px">${esc(hint)}</p></div>`);
        b.querySelector('[data-r=invite]').onclick = invite;
        b.querySelector('[data-r=leave]').onclick = () => { App.closeSheet(); leave(); };
        b.querySelectorAll('[data-e]').forEach(x => x.onclick = () => react(x.dataset.e));
        b.querySelector('.room-group').onclick = e => addForGroup(e.currentTarget);
        b.querySelector('.room-chat-form').onsubmit = e => { e.preventDefault(); const i = e.target.querySelector('input'); const v = i.value; i.value = ''; sendChat(v); };
        box.appendChild(b);
        renderPeople(b.querySelector('.room-people'));
        renderQueue(b.querySelector('.room-queue'));
        renderConf(b.querySelector('.room-conf'));
        renderChat(b);
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
    // siguiente: si hay canciones en la cola de la sala, va primero la de la sala
    const nx = App.next;
    App.next = function (auto, ...rest) {
      const roomQueue = room && lastRoom && lastRoom.queue && lastRoom.queue.length;
      if (roomQueue && canCtl() && !applying && (room.isHost || !auto) && App.state.repeat !== 'one') {
        popAndPlay(auto).then(ok => { if (!ok) nx.call(App, auto, ...rest); });
        return;
      }
      return nx.call(this, auto, ...rest);
    };
    // al acabar una canción solo avanza el anfitrión: el fundido entre canciones (que pasa a la
    // siguiente de la cola propia) se desactiva para los demás, y también si hay cola de la sala
    const cfc = App.crossfadeCheck;
    App.crossfadeCheck = function (...a) {
      if (room && (!room.isHost || (lastRoom && lastRoom.queue && lastRoom.queue.length))) return;
      return cfc.apply(this, a);
    };
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

  return { open: openSheet, create, join, leave, addToQueue, react, get room() { return room; } };
})();
window.Together = Together;
