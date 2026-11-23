'use strict';
/* profile.js — perfiles: foto y descripción.
   - Profile.av(nombre, clase) da el avatar de cualquiera (foto o su inicial). Allá donde salga,
     al pulsarlo se abre su perfil.
   - Tu perfil se edita desde él mismo: foto (la app la recorta en cuadrado, la reduce a 256 px y
     la vuelve a codificar en WebP, así no viajan metadatos como el GPS) y una descripción corta.
   - Las fotos se piden al servidor una vez por persona y se guardan unos minutos en memoria. */
const Profile = (() => {
  const TTL = 5 * 60e3, BIO_MAX = 160;
  const cache = new Map(), inflight = new Map();     // nombre en minúsculas -> {username, bio, avatar, since, t}
  const key = n => String(n || '').toLowerCase();
  const initialOf = n => esc((String(n || '?').trim().charAt(0) || '?').toUpperCase());
  const imgUrl = (n, v) => `/api/profile/${encodeURIComponent(n)}/avatar?v=${encodeURIComponent(v)}`;
  const on = () => !!(window.Account && Account.supported === true && Account.user);

  // HTML del avatar: se puede meter en cualquier plantilla
  function av(name, cls = '') {
    if (!name) return '';
    const c = cache.get(key(name));
    if (!c || Date.now() - c.t > TTL) queue(name);
    const img = c && c.avatar ? `<img class="pf-img" src="${esc(imgUrl(c.username, c.avatar))}" alt="" draggable="false">` : '';
    return `<span class="pf-av ${cls}" data-profile="${esc(name)}" role="button" tabindex="0" aria-label="Perfil de ${esc(name)}"><span class="pf-ini" aria-hidden="true">${initialOf(name)}</span>${img}</span>`;
  }

  // datos de un perfil (con caché y sin pedir dos veces lo mismo a la vez)
  async function get(name, fresh) {
    const k = key(name), c = cache.get(k);
    if (!fresh && c && Date.now() - c.t < TTL) return c;
    if (inflight.has(k)) return inflight.get(k);
    const p = (async () => {
      try {
        const r = await fetch('/api/profile/' + encodeURIComponent(name), { credentials: 'same-origin' });
        if (!r.ok) { const e = new Error(r.status === 404 ? 'No existe esa persona' : 'No se pudo cargar el perfil'); e.status = r.status; throw e; }
        const j = await r.json();
        const v = { username: String(j.username || name), bio: String(j.bio || ''), avatar: j.avatar || null, since: +j.since || 0, me: !!j.me, t: Date.now() };
        cache.set(k, v);
        return v;
      } finally { inflight.delete(k); }
    })();
    inflight.set(k, p);
    return p;
  }

  // los avatares que se pintaron sin saber aún si había foto se completan al llegar los datos
  const pending = new Set();
  let qt = 0;
  function queue(name) {
    if (!on()) return;
    pending.add(name);
    clearTimeout(qt);
    qt = setTimeout(() => {
      const names = [...pending]; pending.clear();
      names.forEach(n => get(n).then(paint).catch(() => {
        // sin datos: se deja la inicial y no se vuelve a preguntar en un rato
        cache.set(key(n), { username: n, bio: '', avatar: null, since: 0, t: Date.now() });
      }));
    }, 60);
  }
  function paint(p) {
    const k = key(p.username);
    $$('.pf-av[data-profile]').forEach(a => {
      if (key(a.dataset.profile) !== k) return;
      const old = a.querySelector('.pf-img');
      if (!p.avatar) { old && old.remove(); return; }
      const src = imgUrl(p.username, p.avatar);
      if (old && old.getAttribute('src') === src) return;
      const im = old || document.createElement('img');
      im.className = 'pf-img'; im.alt = ''; im.draggable = false;
      im.src = src;
      if (!old) a.appendChild(im);
    });
  }
  // si una foto no carga, se queda la inicial
  document.addEventListener('error', e => { const t = e.target; if (t instanceof HTMLImageElement && t.classList.contains('pf-img')) t.remove(); }, true);

  // al pulsar cualquier avatar se abre el perfil
  function fromEvent(e) {
    const a = e.target.closest && e.target.closest('.pf-av[data-profile]');
    if (!a || a.closest('.pf-hero')) return null;
    return a.dataset.profile;
  }
  document.addEventListener('click', e => {
    const n = fromEvent(e);
    if (!n) return;
    e.preventDefault(); e.stopPropagation();
    open(n);
  }, true);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const n = fromEvent(e);
    if (!n) return;
    e.preventDefault(); e.stopPropagation();
    open(n);
  }, true);

  const monthYear = t => { try { return new Date(t).toLocaleDateString(document.documentElement.lang || 'es', { month: 'long', year: 'numeric' }); } catch (_) { return ''; } };

  /* ---------------------------------------------------------------- vista del perfil */
  function open(name) {
    if (!on()) return toast('Inicia sesión para ver perfiles');
    // lo que tape la vista (hoja de la sala, reproductor a pantalla completa) se cierra antes
    if (!$('#sheet').hidden) App.closeSheet();
    if ($('#player').classList.contains('open')) App.closePlayer();
    // si ya estás viendo ese perfil, no se apila otro igual
    const top = App.views[App.views.length - 1];
    if (top && top.dataset.profile && key(top.dataset.profile) === key(name)) return;
    const v = App.openView('Perfil', box => load(box, name));
    v.dataset.profile = name;
  }
  // (re)carga el perfil completo en la vista
  async function load(box, name) {
    box.innerHTML = '';
    const sp = App.loading(box);
    try {
      const r = await fetch('/api/profile/' + encodeURIComponent(name) + '?full=1', { credentials: 'same-origin' });
      let j = null; try { j = await r.json(); } catch (_) {}
      if (!r.ok || !j) throw new Error((j && j.error) || 'No se pudo cargar el perfil');
      const c = { username: j.username, bio: j.bio || '', avatar: j.avatar || null, since: +j.since || 0, me: !!j.me, t: Date.now() };
      cache.set(key(j.username), c);
      paint(c);
      sp.remove();
      render(box, j);
    } catch (e) {
      sp.remove();
      box.appendChild(el(`<p class="muted pf-empty">${esc(e.message || 'No se pudo cargar el perfil')}</p>`));
    }
  }
  const plural = (n, one, many) => `<b>${n}</b> ${n === 1 ? one : many}`;
  function render(box, p) {
    box.innerHTML = '';
    const mine = p.me || key(p.username) === key(Account.user);
    const h = el(`<div class="pf-hero">
      ${av(p.username, 'pf-big')}
      <h1 class="pf-name"></h1>
      <p class="pf-bio"></p>
      <p class="pf-stats"><button type="button" data-f="1">${plural(p.followers || 0, 'seguidor', 'seguidores')}</button> · <button type="button" data-f="1">${plural(p.following || 0, 'siguiendo', 'siguiendo')}</button>${p.followsMe && !mine ? ` <span class="pf-tag">${p.friends ? 'Sois amigos' : 'Te sigue'}</span>` : ''}</p>
      ${p.since ? `<p class="muted pf-since">Miembro desde ${esc(monthYear(p.since))}</p>` : ''}
      <div class="pf-actions"></div>
    </div>`);
    h.querySelector('.pf-name').textContent = p.username;
    const bio = h.querySelector('.pf-bio');
    bio.textContent = p.bio || (mine ? 'Aún no has escrito nada sobre ti.' : '');
    bio.classList.toggle('muted', !p.bio);
    bio.hidden = !p.bio && !mine;
    const big = h.querySelector('.pf-big');
    big.removeAttribute('role'); big.removeAttribute('tabindex');
    h.querySelectorAll('[data-f]').forEach(b => { b.disabled = !mine; if (mine) b.onclick = () => openFriends(); });
    const act = h.querySelector('.pf-actions');
    if (mine) {
      const ed = el(`<button class="btn" type="button">${icon('edit')}<span>Editar perfil</span></button>`);
      ed.onclick = () => edit(p, () => load(box, p.username));
      const fr = el(`<button class="btn tonal" type="button">${icon('people')}<span>Amigos</span></button>`);
      fr.onclick = () => openFriends();
      const ac = el(`<button class="btn tonal icon-only" type="button" aria-label="Cuenta">${icon('more')}</button>`);
      ac.onclick = () => Account.accountMenu(ac);
      act.append(ed, fr, ac);
    } else {
      const fb = el(`<button class="btn${p.iFollow ? ' tonal' : ''}" type="button"></button>`);
      const label = () => { fb.innerHTML = p.iFollow ? `${icon('check')}<span>${p.friends ? 'Amigos' : 'Siguiendo'}</span>` : `${icon('plus')}<span>${p.followsMe ? 'Seguir también' : 'Seguir'}</span>`; fb.classList.toggle('tonal', !!p.iFollow); };
      label();
      fb.onclick = async () => {
        fb.disabled = true;
        const ok = await follow(p.username, !p.iFollow);
        fb.disabled = false;
        if (ok) load(box, p.username);
      };
      act.append(fb);
    }
    if (p.room && !mine) {
      const rb = el(`<button class="btn tonal" type="button">${icon('people')}<span>Unirse a su sala</span></button>`);
      rb.onclick = () => { window.Together && Together.join(p.room); };
      act.append(rb);
    }
    box.appendChild(h);

    // lo que está escuchando
    // (siempre está, aunque ahora no suene nada: aparece sola si empieza a sonar algo)
    box.appendChild(nowCard(p.now, p.username, mine));
    // compatibilidad musical
    if (p.compat) {
      const c = p.compat;
      const card = el(`<div class="pf-card pf-compat"><div class="pf-compat-top"><span>Compatibilidad musical</span><b>${c.pct}%</b></div>
        <div class="pf-meter"><i style="width:${Math.max(3, Math.min(100, c.pct))}%"></i></div>
        ${c.common.length ? `<p class="muted">Tenéis en común</p><div class="pf-chips"></div>` : '<p class="muted">Aún no tenéis artistas en común</p>'}</div>`);
      chips(card.querySelector('.pf-chips'), c.common);
      box.appendChild(card);
    }
    // canción del perfil
    if (p.song && p.song.id) {
      box.appendChild(App.section(mine ? 'Tu canción' : 'Su canción'));
      box.appendChild(App.trackList([p.song], { from: 'Perfil de ' + p.username }));
    }
    // artistas que más escucha
    if (p.top && p.top.length) {
      box.appendChild(App.section(mine ? 'Tus artistas más escuchados' : 'Lo que más escucha'));
      const w = el('<div class="pf-chips pf-chips-pad"></div>');
      chips(w, p.top);
      box.appendChild(w);
    }
    // listas públicas
    if (p.playlists && p.playlists.length) {
      box.appendChild(App.section(mine ? 'Tus listas públicas' : 'Sus listas'));
      box.appendChild(App.shelf(p.playlists.map(x => ({ ...x, title: x.name, sub: x.total + ' canciones', cover: x.cover || PLACEHOLDER })), x => openList(p.username, x.id)));
    } else if (mine) {
      box.appendChild(el('<p class="muted pf-hint">Puedes mostrar listas en tu perfil desde el menú «Más» de cada lista, y elegir tu canción desde el menú ⋯ de cualquier canción.</p>'));
    }
  }
  function chips(box, list) {
    if (!box) return;
    (list || []).forEach(a => {
      const b = el(`<button class="pf-chip" type="button"></button>`);
      b.textContent = a.name;
      if (a.artistId) b.onclick = () => Features.openArtist(a.artistId, { title: a.name });
      else b.onclick = () => { Glass.select('search'); setTimeout(() => Features.doSearch && Features.doSearch(a.name), 50); };
      box.appendChild(b);
    });
  }
  const fmtT = s => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  /* Tarjeta "Escuchando ahora", en vivo: el tiempo avanza cada segundo y cada pocos segundos se
     pregunta al servidor (por si cambia de canción, pausa o salta). En tu propio perfil se usa
     directamente lo que suena en esta app. Al tocarla suena lo mismo, por el mismo punto. */
  function nowCard(n, who, mine) {
    const c = el(`<button type="button" class="pf-card pf-now">
      <img alt="">
      <span class="pf-now-txt"><small></small><b class="ellipsis"></b><span class="ellipsis muted pf-now-artist"></span>
        <span class="pf-now-bar"><i></i></span><span class="pf-now-time muted"></span></span>
      ${mine ? '' : `<span class="pf-now-play" aria-hidden="true">${icon('play')}</span>`}</button>`);
    c._live = { who, mine, n, t0: Date.now(), polled: Date.now(), id: '' };
    if (mine) c.disabled = true;
    else {
      c.setAttribute('aria-label', 'Escuchar lo mismo que ' + who);
      c.onclick = () => { const L = c._live; if (L.n && L.n.track) listenWith(L.n.track, { ...L.n, position: livePos(L) }, who); };
    }
    paintNow(c);
    return c;
  }
  // lo que suena en esta app (para tu propio perfil)
  function localNow() {
    const t = App.current;
    if (!t) return null;
    const dur = (window.Player && Player.ready && Player.duration()) || t.dur || 0;
    return { playing: !!App.state.playing, track: t, position: window.Player && Player.ready ? Player.time() : 0, duration: dur };
  }
  const livePos = L => {
    const n = L.n;
    if (!n) return 0;
    const p = n.position + (n.playing ? (Date.now() - L.t0) / 1000 : 0);
    return n.duration ? Math.min(n.duration, p) : p;
  };
  function paintNow(c) {
    const L = c._live;
    if (L.mine) { L.n = localNow(); L.t0 = Date.now(); }
    const n = L.n;
    c.hidden = !(n && n.track);
    if (c.hidden) return;
    const t = n.track, pos = livePos(L), dur = n.duration || t.dur || 0;
    if (L.id !== t.id) {
      L.id = t.id;
      c.querySelector('img').src = small(t.cover) || PLACEHOLDER;
      c.querySelector('b').textContent = t.title;
      c.querySelector('.pf-now-artist').textContent = t.artist;
    }
    c.classList.toggle('on', !!n.playing);
    c.querySelector('small').textContent = n.playing ? (L.mine ? 'Estás escuchando' : 'Escuchando ahora') : 'En pausa';
    c.querySelector('.pf-now-bar i').style.width = (dur ? Math.min(100, pos / dur * 100) : 0) + '%';
    c.querySelector('.pf-now-time').textContent = dur ? `${fmtT(pos)} / ${fmtT(dur)}` : fmtT(pos);
  }
  async function pollNow(c) {
    const L = c._live;
    L.polled = Date.now();
    try {
      const r = await fetch('/api/profile/' + encodeURIComponent(L.who) + '?now=1', { credentials: 'same-origin' });
      if (!r.ok) return;
      const j = await r.json();
      L.n = j.now || null; L.t0 = Date.now();
      paintNow(c);
    } catch (_) {}
  }
  setInterval(() => {
    if (document.hidden) return;
    document.querySelectorAll('.pf-now').forEach(c => {
      if (!c._live || !c.isConnected || c.closest('.view[hidden]')) return;
      if (!c._live.mine && Date.now() - c._live.polled > 6000) pollNow(c);
      paintNow(c);
    });
  }, 1000);
  // posición actualizada de un dato de "qué suena" recibido hace un rato
  const aged = (n, since) => ({ ...n, position: Math.min(n.duration || Infinity, n.position + (n.playing ? (Date.now() - since) / 1000 : 0)) });
  function listenWith(t, n, who) {
    const at = n.playing ? n.position + 1 : n.position;
    App.playList([t], 0, 'Con ' + who);
    // cuando el reproductor la tenga cargada, se salta al mismo punto
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      if (window.Player && Player.ready && App.current && App.current.id === t.id && Player.duration() > 0) {
        clearInterval(iv);
        if (at > 3 && at < Player.duration() - 3) Player.seek(at + tries * .25);
      } else if (tries > 40) clearInterval(iv);
    }, 250);
    toast('Escuchando lo mismo que ' + who);
  }
  async function follow(name, yes) {
    try {
      const r = await fetch('/api/profile/' + encodeURIComponent(name) + '/follow', { method: yes ? 'PUT' : 'DELETE', credentials: 'same-origin' });
      let j = null; try { j = await r.json(); } catch (_) {}
      if (!r.ok) { toast((j && j.error) || 'No se pudo'); return false; }
      toast(yes ? 'Ahora sigues a ' + name : 'Has dejado de seguir a ' + name);
      friendsCache = null;
      return true;
    } catch (_) { toast('No se pudo conectar con el servidor'); return false; }
  }

  /* ---------------------------------------------------------------- listas públicas de otros */
  function openList(owner, id) {
    App.openView('Lista', async box => {
      const sp = App.loading(box);
      try {
        const r = await fetch(`/api/profile/${encodeURIComponent(owner)}/playlist/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        sp.remove();
        const tracks = j.tracks || [], from = j.name;
        const h = el(`<div class="hero"><img src="${esc(small((tracks.find(x => x.cover) || {}).cover) || PLACEHOLDER)}" alt=""><div class="meta"><h1></h1><div class="muted"></div><div class="actions"></div></div></div>`);
        h.querySelector('h1').textContent = j.name;
        h.querySelector('.muted').textContent = `De ${j.owner} · ${tracks.length} canciones`;
        const a = h.querySelector('.actions');
        if (tracks.length) {
          const pl = el(`<button class="btn" type="button">${icon('play')}<span>Reproducir</span></button>`); pl.onclick = () => App.playList(tracks, 0, from);
          const sh = el(`<button class="btn tonal" type="button">${icon('shuffle')}<span>Aleatorio</span></button>`); sh.onclick = () => { App.setShuffle(true); App.playList(tracks, 0, from); };
          a.append(pl, sh);
        }
        if (key(owner) !== key(Account.user)) {
          const sv = el(`<button class="btn tonal" type="button">${icon('plus')}<span>Guardar copia</span></button>`);
          sv.onclick = () => { Library.createPlaylist(j.name, tracks, { source: j.owner }); toast('Guardada en tu biblioteca'); sv.disabled = true; };
          a.append(sv);
        }
        box.appendChild(h);
        box.appendChild(App.trackList(tracks, { from }));
      } catch (e) { sp.remove(); box.appendChild(el(`<p class="muted pf-empty">${esc((e && e.message) || 'No se pudo cargar la lista')}</p>`)); }
    });
  }

  /* ---------------------------------------------------------------- amigos */
  let friendsCache = null;
  async function loadFriends(force) {
    if (!force && friendsCache && Date.now() - friendsCache.t < 30e3) return friendsCache;
    const r = await fetch('/api/friends', { credentials: 'same-origin' });
    if (!r.ok) throw new Error('No se pudo cargar');
    const j = await r.json();
    [...(j.people || []), ...(j.followers || [])].forEach(x => {
      const k = key(x.username), c = cache.get(k);
      cache.set(k, { ...(c || { bio: '', since: 0 }), username: x.username, avatar: x.avatar || null, t: Date.now() });
    });
    friendsCache = { ...j, t: Date.now() };
    return friendsCache;
  }
  function personRow(x, extra) {
    const row = el(`<div class="pf-row">${av(x.username, 'pf-row-av')}<span class="pf-row-txt"><b class="ellipsis"></b><small class="ellipsis muted"></small></span></div>`);
    row.querySelector('b').textContent = x.username;
    const sm = row.querySelector('small');
    if (x.now && x.now.track) { sm.textContent = (x.now.playing ? '♪ ' : '⏸ ') + x.now.track.title + ' · ' + x.now.track.artist; sm.classList.toggle('pf-live', !!x.now.playing); }
    else sm.textContent = x.mutual === false ? 'Le sigues' : x.mutual ? 'Amigos' : 'Te sigue';
    row.querySelector('.pf-row-txt').onclick = () => open(x.username);
    if (extra) row.appendChild(extra);
    return row;
  }
  function openFriends() {
    App.openView('Amigos', box => {
      box.appendChild(el('<h1 class="title">Amigos</h1>'));
      const f = el(`<form class="pf-find"><input type="search" name="q" placeholder="Buscar a alguien por su nombre de usuario" autocomplete="off" maxlength="24" aria-label="Nombre de usuario"><button class="btn" type="submit">Buscar</button></form>`);
      f.onsubmit = async e => {
        e.preventDefault();
        const q = f.q.value.trim();
        if (!/^[a-z0-9_.-]{3,24}$/i.test(q)) return toast('Escribe el nombre de usuario exacto');
        try { await get(q, true); open(q); } catch (err) { toast(err.message || 'No existe esa persona'); }
      };
      box.appendChild(f);
      const list = el('<div class="pf-list"></div>');
      box.appendChild(list);
      const draw = async force => {
        let d;
        try { d = await loadFriends(force); } catch (_) { list.innerHTML = '<p class="muted pf-empty">No se pudieron cargar tus amigos</p>'; return; }
        list.innerHTML = '';
        if (!d.people.length && !d.followers.length) {
          list.appendChild(el('<p class="muted pf-empty">Aún no sigues a nadie. Busca a alguien por su nombre o pulsa la foto de quien esté contigo en una sala.</p>'));
          return;
        }
        if (d.followers.length) {
          list.appendChild(App.section('Te siguen'));
          d.followers.forEach(x => {
            const b = el(`<button class="btn tonal pf-mini" type="button">${icon('plus')}<span>Seguir</span></button>`);
            b.onclick = async () => { b.disabled = true; if (await follow(x.username, true)) draw(true); else b.disabled = false; };
            list.appendChild(personRow(x, b));
          });
        }
        if (d.people.length) {
          list.appendChild(App.section('Sigues a'));
          d.people.forEach(x => {
            let extra = null;
            if (x.room) { extra = el(`<button class="btn tonal pf-mini" type="button">${icon('people')}<span>Su sala</span></button>`); extra.onclick = () => window.Together && Together.join(x.room); }
            else if (x.now && x.now.track) { extra = el(`<button class="icb" type="button" aria-label="Escuchar lo mismo">${icon('play')}</button>`); extra.onclick = () => listenWith(x.now.track, aged(x.now, d.t), x.username); }
            list.appendChild(personRow(x, extra));
          });
        }
      };
      draw(true);
      // mientras está abierta, se actualiza sola
      const iv = setInterval(() => {
        if (!list.isConnected) return clearInterval(iv);
        if (!document.hidden && !list.closest('.view[hidden]')) draw(true);
      }, 12e3);
    });
  }

  // en Inicio: amigos que están escuchando algo ahora
  async function homeStrip(w) {
    if (!on() || !w || !w.isConnected) return;
    let d;
    try { d = await loadFriends(); } catch (_) { return; }
    const live = d.people.filter(x => x.now && x.now.track && x.now.playing).slice(0, 12);
    const old = w.querySelector('.pf-home');
    if (old) old.remove();
    if (!live.length) return;
    const box = el('<div class="pf-home"></div>');
    box.appendChild(App.section('Tus amigos escuchan', () => openFriends()));
    const s = el('<div class="pf-strip"></div>');
    live.forEach(x => {
      const c = el(`<div class="pf-friend">${av(x.username, 'pf-friend-av')}<button type="button" class="pf-friend-song"><img src="${esc(small(x.now.track.cover) || PLACEHOLDER)}" alt=""><b class="ellipsis"></b><small class="ellipsis muted"></small></button></div>`);
      c.querySelector('b').textContent = x.now.track.title;
      c.querySelector('small').textContent = x.username;
      c.querySelector('.pf-friend-song').onclick = () => listenWith(x.now.track, aged(x.now, d.t), x.username);
      s.appendChild(c);
    });
    box.appendChild(s);
    const after = w.querySelector('h1.title');
    after ? after.after(box) : w.prepend(box);
  }
  document.addEventListener('DOMContentLoaded', () => {
    const rh = App.renderHome;
    App.renderHome = function (...a) {
      const r = rh.apply(this, a);
      setTimeout(() => homeStrip(document.querySelector('#tab-home .wrap')), 0);
      return r;
    };
    // se refresca cada 20 s mientras Inicio está a la vista
    setInterval(() => {
      const tab = document.querySelector('#tab-home');
      if (!document.hidden && tab && !tab.hidden && !document.body.classList.contains('in-view')) { friendsCache = null; homeStrip(tab.querySelector('.wrap')); }
    }, 20e3);
  }, { once: true });

  // tu canción del perfil (desde el menú de una canción)
  async function setSong(t) {
    try {
      const r = await fetch('/api/profile', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ song: t ? clean(t) : null }) });
      if (!r.ok) throw 0;
      toast(t ? 'Ahora es la canción de tu perfil' : 'Canción quitada de tu perfil');
    } catch (_) { toast('No se pudo guardar'); }
  }

  /* ---------------------------------------------------------------- editar el tuyo */
  // la foto se rehace en el propio navegador: recorte cuadrado centrado, 256 px, WebP (o JPEG)
  async function encode(file, q = .86) {
    if (!/^image\//.test(file.type || '')) throw new Error('Elige una imagen');
    if (file.size > 25 * 1024 * 1024) throw new Error('La imagen es demasiado grande');
    let src, w, h, done = () => {};
    try { src = await createImageBitmap(file); w = src.width; h = src.height; done = () => src.close && src.close(); }
    catch (_) {
      const url = URL.createObjectURL(file);
      src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('No se pudo leer la imagen')); i.src = url; });
      w = src.naturalWidth; h = src.naturalHeight; done = () => URL.revokeObjectURL(url);
    }
    try {
      if (!w || !h) throw new Error('No se pudo leer la imagen');
      const S = 256, side = Math.min(w, h);
      const cv = document.createElement('canvas'); cv.width = cv.height = S;
      const cx = cv.getContext('2d');
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(src, (w - side) / 2, (h - side) / 2, side, side, 0, 0, S, S);
      const blob = (type, quality) => new Promise(r => cv.toBlob(r, type, quality));
      let b = await blob('image/webp', q);
      if (!b || b.type !== 'image/webp') b = await blob('image/jpeg', q);
      for (let qq = q - .15; b && b.size > 190 * 1024 && qq > .3; qq -= .15) b = await blob(b.type, qq);
      if (!b) throw new Error('No se pudo preparar la imagen');
      return b;
    } finally { done(); }
  }
  async function upload(file) {
    let last;
    // dos intentos con distinta calidad: si el servidor rechaza los bytes, otra codificación vale
    for (const q of [.86, .8]) {
      const b = await encode(file, q);
      const r = await fetch('/api/profile/avatar', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': b.type }, body: b });
      let j = null; try { j = await r.json(); } catch (_) {}
      if (r.ok && j && j.avatar) return j.avatar;
      last = new Error((j && j.error) || 'No se pudo subir la foto');
      if (r.status !== 400) break;
    }
    throw last;
  }

  function edit(p, after) {
    const me = Account.user;
    App.sheet({
      title: 'Editar perfil', sub: 'Lo verán en las salas',
      body: box => {
        const f = el(`<form class="acct-form pf-form">
          <div class="pf-photo">${av(me, 'pf-mid')}
            <div class="pf-photo-btns">
              <label class="btn tonal pf-pick">${icon('image')}<span>Cambiar foto</span><input type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif,image/heic" hidden></label>
              <button type="button" class="btn text pf-del"${p.avatar ? '' : ' hidden'}>Quitar foto</button>
            </div>
          </div>
          <label><span>Descripción</span><textarea name="bio" maxlength="${BIO_MAX}" rows="3" placeholder="Cuéntales qué música te gusta…"></textarea><small class="pf-count"></small></label>
          <label><span>Quién ve lo que estás escuchando</span><select name="share">
            <option value="friends">Solo amigos (os seguís los dos)</option><option value="all">Cualquiera con cuenta</option><option value="none">Nadie</option></select></label>
          <label class="pf-check"><input type="checkbox" name="top"><span>Mostrar mis artistas más escuchados</span></label>
          ${p.song ? `<label class="pf-check"><input type="checkbox" name="nosong"><span>Quitar «${esc(p.song.title)}» como canción del perfil</span></label>` : ''}
          <p class="acct-err" role="alert" hidden></p>
          <div class="acct-actions"><button type="button" class="btn tonal" data-cancel>Cancelar</button><button class="btn" type="submit">Guardar</button></div>
        </form>`);
        const errBox = f.querySelector('.acct-err'), ta = f.bio, count = f.querySelector('.pf-count');
        const mid = f.querySelector('.pf-mid');
        mid.removeAttribute('role'); mid.removeAttribute('tabindex'); mid.removeAttribute('data-profile');
        const showErr = m => { errBox.textContent = m; errBox.hidden = !m; };
        ta.value = p.bio || '';
        const pr = p.prefs || { share: 'friends', top: true };
        f.share.value = pr.share; f.top.checked = pr.top !== false;
        const upd = () => { count.textContent = `${ta.value.length}/${BIO_MAX}`; };
        ta.oninput = upd; upd();
        let picked = null, removed = false, preview = '';
        const setPreview = url => {
          let im = mid.querySelector('.pf-img');
          if (!url) { im && im.remove(); return; }
          if (!im) { im = document.createElement('img'); im.className = 'pf-img'; im.alt = ''; mid.appendChild(im); }
          im.src = url;
        };
        f.querySelector('input[type=file]').onchange = async e => {
          const file = e.target.files && e.target.files[0];
          e.target.value = '';
          if (!file) return;
          showErr('');
          try {
            const b = await encode(file);          // vista previa tal como se subirá
            picked = file; removed = false;
            if (preview) URL.revokeObjectURL(preview);
            preview = URL.createObjectURL(b);
            setPreview(preview);
            f.querySelector('.pf-del').hidden = false;
          } catch (err) { showErr(err.message || 'No se pudo leer la imagen'); }
        };
        f.querySelector('.pf-del').onclick = () => {
          picked = null; removed = true; setPreview('');
          f.querySelector('.pf-del').hidden = true;
        };
        f.querySelector('[data-cancel]').onclick = () => App.closeSheet();
        f.onsubmit = async e => {
          e.preventDefault();
          showErr('');
          const btn = f.querySelector('[type=submit]');
          btn.disabled = true;
          try {
            const c = cache.get(key(me)) || { ...p };
            if (picked) c.avatar = await upload(picked);
            else if (removed && p.avatar) {
              const r = await fetch('/api/profile/avatar', { method: 'DELETE', credentials: 'same-origin' });
              if (!r.ok) throw new Error('No se pudo quitar la foto');
              c.avatar = null;
            }
            const body = {};
            if (ta.value.trim() !== (p.bio || '')) body.bio = ta.value;
            if (f.share.value !== pr.share) body.share = f.share.value;
            if (f.top.checked !== (pr.top !== false)) body.top = f.top.checked;
            if (f.nosong && f.nosong.checked) body.song = null;
            if (Object.keys(body).length) {
              const r = await fetch('/api/profile', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
              let j = null; try { j = await r.json(); } catch (_) {}
              if (!r.ok) throw new Error((j && j.error) || 'No se pudo guardar');
              if ('bio' in j) c.bio = j.bio;
            }
            c.t = Date.now();
            cache.set(key(me), c);
            if (preview) URL.revokeObjectURL(preview);
            paint(c);
            App.closeSheet();
            toast('Perfil guardado');
            after && after();
          } catch (err) { showErr(err.message || 'No se pudo conectar con el servidor'); btn.disabled = false; }
        };
        box.appendChild(f);
      }
    });
  }

  return { av, open, get, paint, openFriends, setSong, on };
})();
window.Profile = Profile;
