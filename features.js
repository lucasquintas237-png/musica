'use strict';
/* features.js — letras sincronizadas (LRCLIB), radio, cola, temporizador de apagado,
   atajos de teclado, buscador, páginas de artista/álbum/lista, estadísticas,
   exportar/importar, PWA y tema claro/oscuro. */
const Features = (() => {
  const settings = () => store.get('settings', {});
  const setSetting = (k, v) => { const s = settings(); s[k] = v; store.set('settings', s); };

  /* ================================================================ tema */
  const mq = matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    const t = settings().theme || 'auto';
    document.documentElement.dataset.theme = t === 'auto' ? (mq.matches ? 'dark' : 'light') : t;
    M3.applyColor();
  }
  mq.addEventListener && mq.addEventListener('change', applyTheme);
  applyTheme();
  M3.setEnabled(settings().dynamic !== false);

  /* ================================================================ letras */
  const lyr = { id: null, data: null, lines: [], cur: -1, userScroll: 0 };
  const cleanTitle = s => (s || '').replace(/\s*[([](feat|ft|con|with|prod)[^)\]]*[)\]]/ig, '').replace(/\s+-\s+.*(remaster|version|versión|live|en vivo|edit|mix).*$/i, '').trim();
  const mainArtist = s => (s || '').split(/,|&| y | x | feat\.? /i)[0].trim();

  async function fetchLyrics(t) {
    const q = new URLSearchParams({ track_name: cleanTitle(t.title), artist_name: mainArtist(t.artist) });
    if (t.album) q.set('album_name', t.album);
    if (t.dur) q.set('duration', Math.round(t.dur));
    try {
      const r = await fetch('/api/lrc/get?' + q);
      if (r.ok) { const j = await r.json(); if (j && (j.syncedLyrics || j.plainLyrics)) return j; }
    } catch (_) {}
    const q2 = new URLSearchParams({ track_name: cleanTitle(t.title), artist_name: mainArtist(t.artist) });
    const r2 = await fetch('/api/lrc/search?' + q2);
    if (!r2.ok) return null;
    const list = await r2.json();
    if (!Array.isArray(list) || !list.length) return null;
    const score = x => (x.syncedLyrics ? 0 : 100) + (t.dur && x.duration ? Math.abs(x.duration - t.dur) : 50);
    return list.filter(x => x.syncedLyrics || x.plainLyrics).sort((a, b) => score(a) - score(b))[0] || null;
  }
  function parseLRC(s) {
    const out = [];
    (s || '').split('\n').forEach(line => {
      const tags = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
      const text = line.replace(/\[[^\]]*\]/g, '').trim();
      tags.forEach(m => out.push({ t: +m[1] * 60 + +m[2], text }));
    });
    return out.sort((a, b) => a.t - b.t);
  }
  async function loadLyrics(panel) {
    const t = App.current;
    if (!t) return;
    if (lyr.id === t.id && lyr.data !== undefined && panel.querySelector('.lyrics')) return;
    lyr.id = t.id; lyr.cur = -1; lyr.lines = [];
    panel.classList.remove('synced');
    panel.innerHTML = '<div class="spinner"></div>';
    let data = null;
    try { data = await fetchLyrics(t); } catch (_) {}
    if (App.current !== t || panel.dataset.kind !== 'lyrics') return;
    lyr.data = data;
    if (!data) { panel.innerHTML = '<div class="lyrics plain"><p class="muted">No hay letra disponible para esta canción.</p></div>'; return; }
    const box = el(`<div class="lyrics${data.syncedLyrics ? '' : ' plain'}"></div>`);
    panel.classList.toggle('synced', !!data.syncedLyrics);
    if (data.syncedLyrics) {
      lyr.auto = null; lyr.syncMode = false;
      lyr.lines = parseLRC(data.syncedLyrics);
      lyr.lines.forEach(l => {
        const p = el(`<p>${esc(l.text || '♪')}</p>`);
        p.onclick = () => {
          // modo sincronizar: la línea tocada es la que suena ahora
          if (lyr.syncMode) { setOffset(Player.time() - l.t); lyr.syncMode = false; updateLyrBar(); toast('Letra ajustada: ' + fmtOff(getOffset())); return; }
          Player.seek(Math.max(0, l.t + getOffset())); Player.play();
        };
        box.appendChild(p);
      });
    } else {
      data.plainLyrics.split('\n').forEach(l => box.appendChild(el(`<p>${esc(l) || '&nbsp;'}</p>`)));
    }
    box.appendChild(el('<p class="src">Letra: LRCLIB</p>'));
    panel.innerHTML = '';
    if (data.syncedLyrics) {
      const bar = el(`<div class="lyr-bar">
        <button class="chip" data-l="-" aria-label="Letra antes">−0,5 s</button>
        <span class="lyr-off"></span>
        <button class="chip" data-l="+" aria-label="Letra después">+0,5 s</button>
        <button class="chip" data-l="sync">Sincronizar</button>
        <button class="chip" data-l="auto">Auto</button></div>`);
      bar.onclick = e => {
        const b = e.target.closest('[data-l]');
        if (!b) return;
        const k = b.dataset.l;
        if (k === '-') setOffset(getOffset() - .5);
        else if (k === '+') setOffset(getOffset() + .5);
        else if (k === 'auto') { clearOffset(); toast('Desfase automático: ' + fmtOff(getOffset())); }
        else { lyr.syncMode = !lyr.syncMode; updateLyrBar(); if (lyr.syncMode) toast('Toca la línea que está sonando ahora', 3500); }
      };
      panel.appendChild(bar);
    }
    panel.appendChild(box);
    updateLyrBar();
    panel.onscroll = () => { if (!panel._auto) lyr.userScroll = Date.now(); panel._auto = false; };
  }
  /* Desfase de la letra (s): cuánto más tarde empieza la canción en este vídeo que en la letra.
     Se guarda por canción; si no hay uno guardado se estima comparando la duración del vídeo
     con la de la letra (un vídeo bastante más largo suele llevar una intro). */
  const offsets = () => store.get('lyrOffsets', {});
  const fmtOff = v => (Math.abs(v) < .05 ? 'sin desfase' : (v > 0 ? '+' : '−') + Math.abs(v).toFixed(1).replace('.', ',') + ' s');
  function getOffset() {
    const o = offsets()[lyr.id];
    return o != null ? o : (lyr.auto || 0);
  }
  function setOffset(v) {
    const o = offsets();
    o[lyr.id] = Math.round(v * 10) / 10;
    const keys = Object.keys(o);
    if (keys.length > 800) delete o[keys[0]];
    store.set('lyrOffsets', o);
    lyr.cur = -2; updateLyrBar(); syncLyrics(Player.time());
  }
  function clearOffset() {
    const o = offsets(); delete o[lyr.id]; store.set('lyrOffsets', o);
    lyr.cur = -2; updateLyrBar(); syncLyrics(Player.time());
  }
  function estimateAuto() {
    if (lyr.auto != null || !lyr.data || !lyr.data.duration) return;
    let vid = '';
    try { vid = Player.yt.getVideoData().video_id; } catch (_) {}
    const vd = Player.duration();
    if (vid !== lyr.id || !(vd > 0)) return;           // aún no se sabe la duración de este vídeo
    const d = vd - lyr.data.duration;
    lyr.auto = d > 4 && d < 150 ? Math.round(d * 10) / 10 : 0;
    updateLyrBar();
  }
  function updateLyrBar() {
    const bar = $('#player .lyr-bar');
    if (!bar) return;
    const saved = offsets()[lyr.id] != null;
    bar.querySelector('.lyr-off').textContent = fmtOff(getOffset()) + (saved ? '' : lyr.auto ? ' (auto)' : '');
    bar.querySelector('[data-l=sync]').classList.toggle('on', !!lyr.syncMode);
    bar.querySelector('[data-l=auto]').hidden = !saved;
    $('#player .lyrics') && $('#player .lyrics').classList.toggle('syncing', !!lyr.syncMode);
  }

  function syncLyrics(cur) {
    const panel = $('#player .p-panel');
    if (panel.hidden || panel.dataset.kind !== 'lyrics' || !lyr.lines.length) return;
    estimateAuto();
    cur -= getOffset();
    let i = -1;
    for (let k = 0; k < lyr.lines.length; k++) { if (lyr.lines[k].t <= cur + .25) i = k; else break; }
    if (i === lyr.cur) return;
    const ps = panel.querySelectorAll('.lyrics p');
    panel.querySelectorAll('.lyrics p.on').forEach(p => p.classList.remove('on'));
    lyr.cur = i;
    if (i < 0 || !ps[i]) return;
    ps[i].classList.add('on');
    if (Date.now() - lyr.userScroll > 3000) {
      panel._auto = true;
      panel.scrollTo({ top: ps[i].offsetTop - panel.clientHeight * .38, behavior: 'smooth' });
    }
  }

  /* ================================================================ cola */
  function renderQueue(panel) {
    const s = App.state;
    const box = el('<div class="queue"></div>');
    const cur = App.current;
    if (cur) { box.appendChild(el('<h3>Sonando</h3>')); box.appendChild(App.trackRow(cur, s.index, s.queue, { onClick: () => {} })); }
    const up = s.queue.slice(s.index + 1);
    const h = el(`<h3 style="display:flex;justify-content:space-between;align-items:center">A continuación <span class="muted" style="font-weight:400">${up.length} canciones</span></h3>`);
    if (up.length) { const b = el('<button class="chip">Vaciar</button>'); b.onclick = () => { s.queue.splice(s.index + 1); App.emit('queue'); App.saveQueue(); }; h.appendChild(b); }
    box.appendChild(h);
    up.forEach((t, k) => box.appendChild(App.trackRow(t, s.index + 1 + k, s.queue, { inQueue: true, onClick: (_, i) => App.jump(i) })));
    if (!up.length) box.appendChild(el(`<div class="empty">No hay más canciones en la cola.${s.autoRadio ? ' Al terminar seguirá sonando música parecida (radio).' : ''}</div>`));
    panel.classList.remove('synced');
    panel.innerHTML = '';
    panel.appendChild(box);
  }

  function togglePanel(kind) {
    const panel = $('#player .p-panel'), coverEl = $('#player .p-cover');
    if (!$('#player').classList.contains('open')) App.openPlayer();
    const showing = !panel.hidden && panel.dataset.kind === kind;
    $$('#player .p-tools [data-act=lyrics], #player .p-tools [data-act=queue]').forEach(b => b.classList.remove('on'));
    if (showing) { panel.hidden = true; coverEl.style.visibility = ''; panel.dataset.kind = ''; return; }
    panel.hidden = false; coverEl.style.visibility = 'hidden'; panel.dataset.kind = kind;
    $(`#player .p-tools [data-act=${kind}]`).classList.add('on');
    if (kind === 'lyrics') { lyr.id = null; loadLyrics(panel); }
    else renderQueue(panel);
  }

  /* ================================================================ radio */
  async function startRadio(t) {
    if (!t || !t.id) return toast('No se puede crear una radio de esta canción');
    toast('Creando radio…');
    try {
      const list = (window.Reco ? await Reco.radioFor(t) : await YTM.radio(t.id)).filter(x => x.id !== t.id);
      if (!list.length) return toast('No se encontraron canciones parecidas');
      const s = App.state;
      if (App.current && App.current.id === t.id) {
        s.queue.splice(s.index + 1, s.queue.length, ...list);
        s.from = 'Radio de ' + t.title;
        $('#p-from').textContent = s.from;
        App.emit('queue'); App.saveQueue();
        toast('Radio lista: ' + list.length + ' canciones');
      } else App.playList([t, ...list], 0, 'Radio de ' + t.title);
    } catch (e) { toast('No se pudo crear la radio'); }
  }
  async function extendRadio(t, playNext) {
    try {
      const s = App.state, have = new Set(s.queue.map(x => x.id).concat(s.queue.map(x => x.vid)).filter(Boolean));
      // radio ordenada según tus gustos (sin lo que acabas de oír ni lo que sueles saltar)
      const list = (window.Reco ? await Reco.radioFor(t, { exclude: have }) : await YTM.radio(t.id)).filter(x => !have.has(x.id));
      // (si se amplía por adelantado, para el fundido, no se para nada aunque falle)
      if (!list.length) { if (playNext) { s.playing = false; App.updatePlaying(); } return; }
      s.queue.push(...list.map(x => ({ ...x })));
      App.emit('queue');
      if (playNext) { s.index++; App.start(); }
      App.saveQueue();
    } catch (_) { if (playNext) { App.state.playing = false; App.updatePlaying(); } }
  }

  /* ================================================================ temporizador */
  const timer = { end: 0, endOfTrack: false };
  function timerMenu() {
    const left = timer.end ? Math.max(0, Math.round((timer.end - Date.now()) / 60000)) : 0;
    const set = (min, eot) => {
      timer.end = min ? Date.now() + min * 60000 : 0; timer.endOfTrack = !!eot;
      updateTimerUI();
      toast(min ? `La música se parará en ${min} min` : eot ? 'La música se parará al acabar esta canción' : 'Temporizador desactivado');
    };
    App.sheet({
      title: 'Temporizador de apagado', sub: timer.end ? `Quedan ${left} min` : timer.endOfTrack ? 'Al acabar la canción' : 'Desactivado',
      items: [
        ...[15, 30, 45, 60, 90].map(m => ({ icon: 'timer', label: m + ' minutos', fn: () => set(m) })),
        { icon: 'note', label: 'Al acabar la canción', fn: () => set(0, true) },
        (timer.end || timer.endOfTrack) && { icon: 'close', label: 'Desactivar', fn: () => set(0, false) }
      ]
    });
  }
  function updateTimerUI() {
    const on = !!(timer.end || timer.endOfTrack);
    $('#player [data-act=timer]').classList.toggle('on', on);
  }
  setInterval(() => {
    if (timer.end && Date.now() >= timer.end) {
      timer.end = 0; updateTimerUI();
      Player.pause(); toast('Temporizador: música en pausa');
    }
  }, 1000);
  function consumeEndOfTrack() {
    if (!timer.endOfTrack) return false;
    timer.endOfTrack = false; updateTimerUI();
    toast('Temporizador: fin de la canción');
    return true;
  }

  /* ================================================================ atajos de teclado */
  const SHORTCUTS = [
    ['Espacio', 'Reproducir / pausar'], ['→ / ←', 'Avanzar / retroceder 5 s'], ['Mayús + → / ←', 'Siguiente / anterior'],
    ['↑ / ↓', 'Subir / bajar volumen'], ['N / P', 'Siguiente / anterior'], ['M', 'Silenciar'], ['L', 'Letra'], ['Q', 'Cola'],
    ['F', 'Favorita'], ['S', 'Aleatorio'], ['R', 'Repetir'], ['/', 'Buscar'], ['Esc', 'Cerrar']
  ];
  let lastVol = 80;
  document.addEventListener('keydown', e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (e.key === 'Escape') {
      if (!$('#sheet').hidden) return App.closeSheet();
      if ($('#player').classList.contains('open')) return App.closePlayer();
      if (App.views.length) return history.back();
      if (typing) e.target.blur();
      return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const act = {
      ' ': () => App.toggle(),
      arrowright: () => e.shiftKey ? App.next() : Player.seek(Player.time() + 5),
      arrowleft: () => e.shiftKey ? App.prev() : Player.seek(Math.max(0, Player.time() - 5)),
      arrowup: () => App.setVolume(App.state.volume + 5),
      arrowdown: () => App.setVolume(App.state.volume - 5),
      n: () => App.next(), p: () => App.prev(),
      m: () => { if (App.state.volume > 0) { lastVol = App.state.volume; App.setVolume(0); toast('Silenciado'); } else App.setVolume(lastVol || 80); },
      l: () => togglePanel('lyrics'), q: () => togglePanel('queue'),
      f: () => { if (App.current) { Library.toggleFav(App.current); App.updateFav(); } },
      s: () => App.setShuffle(!App.state.shuffle), r: () => App.cycleRepeat(),
      '/': () => { App.closePlayer(); Glass.select('search'); setTimeout(() => { const i = $('#tab-search input'); i && i.focus(); }, 60); }
    }[k];
    if (act) { e.preventDefault(); act(); }
  });

  /* ================================================================ buscador */
  let searchTok = 0;
  function renderSearch(tab) {
    const w = el(`<div class="wrap"><h1 class="title">Buscar</h1>
      <form class="search-box" role="search">${icon('search')}
        <input type="search" placeholder="Canciones, artistas, álbumes o un enlace" enterkeyhint="search" autocomplete="off" aria-label="Buscar">
        <button type="button" class="icb clear" aria-label="Borrar" hidden style="width:32px;height:32px">${icon('close')}</button></form>
      <div class="chips" id="s-chips"></div><div id="s-res"></div></div>`);
    tab.appendChild(w);
    const input = $('input', w), clear = $('.clear', w), res = $('#s-res', w);
    const run = debounce(() => doSearch(input.value), 450);
    input.addEventListener('input', () => { clear.hidden = !input.value; if (!input.value.trim()) { res.innerHTML = ''; showChips(); } else run(); });
    $('form', w).addEventListener('submit', e => { e.preventDefault(); input.blur(); doSearch(input.value, true); });
    clear.onclick = () => { input.value = ''; clear.hidden = true; res.innerHTML = ''; showChips(); input.focus(); };
    showChips();
  }
  function showChips() {
    const box = $('#s-chips');
    if (!box) return;
    const hist = store.get('searchHist', []);
    box.innerHTML = '';
    hist.forEach(q => {
      const c = el(`<button class="chip">${icon('timer', 'ic" style="width:16px;height:16px')}${esc(q)}</button>`);
      c.onclick = () => { const i = $('#tab-search input'); i.value = q; $('#tab-search .clear').hidden = false; doSearch(q, true); };
      box.appendChild(c);
    });
    if (hist.length) { const c = el('<button class="chip">Borrar historial</button>'); c.onclick = () => { store.set('searchHist', []); showChips(); }; box.appendChild(c); }
  }
  function saveQuery(q) {
    store.set('searchHist', [q, ...store.get('searchHist', []).filter(x => x.toLowerCase() !== q.toLowerCase())].slice(0, 10));
  }
  async function doSearch(q, save) {
    q = (q || '').trim();
    const res = $('#s-res');
    if (!q) return;
    const tok = ++searchTok;
    // ¿es un enlace? (YouTube, YouTube Music, Spotify)
    const link = Sources.parseLink(q);
    if (link) { res.innerHTML = ''; Sources.linkResult(link, res); return; }
    $('#s-chips').innerHTML = '';
    res.innerHTML = '';
    App.loading(res);
    const [songs, artists, albums] = await Promise.allSettled([YTM.search(q, 'songs'), YTM.search(q, 'artists'), YTM.search(q, 'albums')]);
    if (tok !== searchTok) return;
    res.innerHTML = '';
    if (songs.status === 'rejected' && artists.status === 'rejected') {
      res.appendChild(el(`<div class="empty">No se pudo buscar. ¿Está en marcha <b>serve.ps1</b> y hay conexión a internet?<br><small>${esc(songs.reason && songs.reason.message)}</small></div>`));
      return;
    }
    if (save) saveQuery(q);
    const S = songs.value || [], A = artists.value || [], L = albums.value || [];
    if (!S.length && !A.length && !L.length) { res.appendChild(el('<div class="empty">Sin resultados.</div>')); return; }
    // si el primer artista coincide con lo buscado, va primero
    const ql = q.toLowerCase();
    const artistFirst = A[0] && A[0].title.toLowerCase() === ql;
    const artistsSec = () => { if (!A.length) return; res.appendChild(App.section('Artistas')); res.appendChild(App.shelf(A.slice(0, 12).map(a => ({ ...a, sub: 'Artista' })), a => openArtist(a.browseId, a), true)); };
    if (artistFirst) artistsSec();
    if (S.length) {
      res.appendChild(App.section('Canciones', S.length > 5 ? () => Sources.seeAll('Canciones: ' + q, q, S) : null));
      res.appendChild(App.trackList(S.slice(0, 5), { from: 'Búsqueda: ' + q, showAlbum: true, onClick: t => App.playWithRadio(t, 'Búsqueda: ' + q) }));
    }
    if (!artistFirst) artistsSec();
    if (L.length) { res.appendChild(App.section('Álbumes')); res.appendChild(App.shelf(L.slice(0, 12), a => openAlbum(a.browseId, a))); }
  }

  /* ================================================================ artista, álbum, listas */
  function hero(box, { img, title, sub, round, actions = [] }) {
    const h = el(`<div class="hero${round ? ' round' : ''}"><img src="${esc(img || PLACEHOLDER)}" alt=""><div class="meta"><h1>${esc(title || '')}</h1><div class="muted">${sub || ''}</div><div class="actions"></div></div></div>`);
    actions.filter(Boolean).forEach(a => { const b = el(`<button class="btn${a.tonal ? ' tonal' : ''}">${icon(a.icon)}${esc(a.label)}</button>`); b.onclick = a.fn; $('.actions', h).appendChild(b); });
    box.appendChild(h);
    return h;
  }
  function failed(box, e) { box.innerHTML = `<div class="empty">No se pudo cargar. ${esc(e && e.message || '')}</div>`; }

  function openArtist(id, hint = {}) {
    if (!id) return toast('Artista no disponible');
    App.openView(hint.title, async box => {
      App.loading(box);
      try {
        const a = await YTM.artist(id);
        box.innerHTML = '';
        hero(box, {
          img: a.cover || hint.cover, title: a.name || hint.title, sub: a.songs.length ? 'Artista' : '', round: true,
          actions: [
            a.songs.length && { icon: 'play', label: 'Reproducir', fn: () => App.playList(a.songs, 0, a.name) },
            a.songs.length && { icon: 'radio', label: 'Radio', tonal: true, fn: () => startRadio(a.songs[0]) },
            a.songs.length && { icon: 'shuffle', label: 'Aleatorio', tonal: true, fn: () => { App.setShuffle(true); App.playList(a.songs, 0, a.name); } }
          ]
        });
        if (a.songs.length) { box.appendChild(App.section('Canciones')); box.appendChild(App.trackList(a.songs, { from: a.name, showAlbum: true })); }
        a.carousels.forEach(c => {
          box.appendChild(App.section(c.title));
          box.appendChild(App.shelf(c.items, it => App.openItem(it), c.items.every(i => i.kind === 'artist')));
        });
        if (a.desc) box.appendChild(el(`<p class="muted" style="margin-top:24px;font-size:14px">${esc(a.desc.slice(0, 600))}${a.desc.length > 600 ? '…' : ''}</p>`));
      } catch (e) { failed(box, e); }
    });
  }

  function openAlbum(id, hint = {}) {
    if (!id) return toast('Álbum no disponible');
    App.openView(hint.title, async box => {
      App.loading(box);
      try {
        const a = await YTM.album(id);
        box.innerHTML = '';
        const total = a.tracks.reduce((s, t) => s + (t.dur || 0), 0);
        const h = hero(box, {
          img: a.cover || hint.cover, title: a.title || hint.title,
          sub: `<a href="#" class="art-link" style="color:inherit;font-weight:600">${esc(a.artist)}</a><br>${esc([a.year, a.tracks.length + ' canciones', total ? Math.round(total / 60) + ' min' : ''].filter(Boolean).join(' · '))}`,
          actions: [
            { icon: 'play', label: 'Reproducir', fn: () => App.playList(a.tracks, 0, a.title) },
            { icon: 'shuffle', label: 'Aleatorio', tonal: true, fn: () => { App.setShuffle(true); App.playList(a.tracks, 0, a.title); } },
            { icon: 'lib', label: 'Guardar', tonal: true, fn: () => { Library.createPlaylist(a.title, a.tracks, { cover: a.cover, source: 'Álbum' }); toast('Guardado en tus listas'); } },
            { icon: 'queue', label: 'A la cola', tonal: true, fn: () => App.addToQueue(a.tracks) }
          ]
        });
        const link = $('.art-link', h);
        link.onclick = e => { e.preventDefault(); a.artistId && openArtist(a.artistId, { title: a.artist }); };
        box.appendChild(App.trackList(a.tracks, { from: a.title, numbers: true }));
      } catch (e) { failed(box, e); }
    });
  }

  function listPage(box, { name, tracks, cover, sub, playlistId, actions = [], rerender }) {
    box.innerHTML = '';
    hero(box, {
      img: cover || (tracks[0] && tracks[0].cover), title: name, sub: esc(sub || tracks.length + ' canciones'),
      actions: [
        tracks.length && { icon: 'play', label: 'Reproducir', fn: () => App.playList(tracks, 0, name) },
        tracks.length && { icon: 'shuffle', label: 'Aleatorio', tonal: true, fn: () => { App.setShuffle(true); App.playList(tracks, 0, name); } },
        ...actions
      ]
    });
    box.appendChild(App.trackList(tracks, { from: name, playlistId, onRemove: rerender, empty: 'Lista vacía. Añade canciones desde el menú ⋯ de cualquier canción.' }));
  }
  function openPlaylist(pid) {
    App.openView('Lista', box => {
      const render = () => {
        const pl = Library.playlists().find(p => p.id === pid);
        if (!pl) return history.back();
        listPage(box, {
          name: pl.name, tracks: pl.tracks, cover: pl.cover, playlistId: pid, rerender: render,
          sub: pl.tracks.length + ' canciones' + (pl.source ? ' · importada de ' + pl.source : ''),
          actions: [
            { icon: 'queue', label: 'A la cola', tonal: true, fn: () => App.addToQueue(pl.tracks) },
            { icon: 'more', label: 'Más', tonal: true, fn: () => App.sheet({ title: pl.name, items: [
              { icon: 'lyrics', label: 'Renombrar', fn: () => App.prompt('Nuevo nombre', pl.name, n => { Library.renamePlaylist(pid, n); render(); }) },
              { icon: 'trash', label: 'Eliminar lista', fn: () => { Library.deletePlaylist(pid); toast('Lista eliminada'); history.back(); } }
            ] }) }
          ]
        });
      };
      render();
    });
  }
  function openFavorites() {
    App.openView('Favoritas', box => {
      const render = () => {
        const favs = Library.favs();
        listPage(box, { name: 'Favoritas', tracks: favs, sub: favs.length + ' canciones' });
      };
      render();
    });
  }

  /* ================================================================ estadísticas */
  function openStats() {
    App.openView('Estadísticas', box => {
      const s = Library.stats();
      const plays = Object.values(s.plays);
      const totalPlays = plays.reduce((a, e) => a + e.n, 0);
      const artists = {};
      plays.forEach(e => { const a = mainArtist(e.t.artist) || '—'; (artists[a] = artists[a] || { n: 0, secs: 0, id: e.t.artistId, cover: e.t.cover }); artists[a].n += e.n; artists[a].secs += e.secs; });
      const hrs = s.total / 3600;
      box.appendChild(el('<h1 class="title">Estadísticas</h1>'));
      box.appendChild(el(`<div class="kpis">
        <div class="kpi"><b>${hrs >= 1 ? hrs.toFixed(1) + ' h' : Math.round(s.total / 60) + ' min'}</b><span>escuchando</span></div>
        <div class="kpi"><b>${totalPlays}</b><span>reproducciones</span></div>
        <div class="kpi"><b>${plays.length}</b><span>canciones distintas</span></div>
        <div class="kpi"><b>${Object.keys(artists).length}</b><span>artistas</span></div></div>`));
      // últimos 7 días
      box.appendChild(App.section('Últimos 7 días'));
      const days = [];
      for (let i = 6; i >= 0; i--) { const d = new Date(Date.now() - i * 864e5); days.push({ k: d.toISOString().slice(0, 10), l: d.toLocaleDateString('es', { weekday: 'short' }) }); }
      const max = Math.max(60, ...days.map(d => s.days[d.k] || 0));
      box.appendChild(el(`<div class="bars">${days.map(d => { const m = Math.round((s.days[d.k] || 0) / 60); return `<div title="${m} min"><span>${m}</span><i style="height:${((s.days[d.k] || 0) / max * 100).toFixed(1)}%"></i><span>${esc(d.l)}</span></div>`; }).join('')}</div>`));
      const top = plays.sort((a, b) => b.n - a.n || b.secs - a.secs).slice(0, 10).map(e => ({ ...e.t, _n: e.n }));
      box.appendChild(App.section('Canciones más escuchadas'));
      box.appendChild(App.trackList(top, { from: 'Lo más escuchado', empty: 'Aún no hay datos: escucha algo de música.' }));
      const topA = Object.entries(artists).sort((a, b) => b[1].secs - a[1].secs).slice(0, 8);
      if (topA.length) {
        box.appendChild(App.section('Artistas más escuchados'));
        box.appendChild(App.shelf(topA.map(([name, v]) => ({ title: name, sub: Math.round(v.secs / 60) + ' min · ' + v.n + ' veces', cover: v.cover, browseId: v.id, kind: 'artist' })), it => it.browseId ? openArtist(it.browseId, it) : toast('Artista no disponible'), true));
      }
    });
  }

  /* ================================================================ exportar / importar */
  function exportData() {
    const data = {};
    store.keys().forEach(k => data[k] = store.get(k));
    const blob = new Blob([JSON.stringify({ app: 'musica', v: 1, date: new Date().toISOString(), data }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'musica-copia-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('Copia descargada');
  }
  function importData() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'application/json,.json';
    inp.onchange = async () => {
      const f = inp.files[0];
      if (!f) return;
      try {
        const j = JSON.parse(await f.text());
        if (!j || j.app !== 'musica' || !j.data) throw new Error('El archivo no es una copia de esta app');
        App.sheet({
          title: 'Importar copia', sub: new Date(j.date).toLocaleString('es'), items: [
            { icon: 'upload', label: 'Combinar con lo que tengo', fn: () => { merge(j.data); location.reload(); } },
            { icon: 'trash', label: 'Reemplazar todo', fn: () => { store.keys().forEach(k => store.remove(k)); Object.entries(j.data).forEach(([k, v]) => store.set(k, v)); location.reload(); } }
          ]
        });
      } catch (e) { toast('No se pudo importar: ' + e.message, 4000); }
    };
    inp.click();
  }
  function merge(d) {
    const byId = (a, b) => { const seen = new Set(a.map(x => x.id)); return [...a, ...(b || []).filter(x => !seen.has(x.id))]; };
    store.set('favs', byId(Library.favs(), d.favs));
    store.set('history', byId(Library.history(), d.history).slice(0, 100));
    store.set('playlists', byId(Library.playlists(), d.playlists));
    const s = Library.stats(), o = d.stats || { plays: {}, days: {}, total: 0 };
    Object.entries(o.plays || {}).forEach(([id, e]) => { const m = s.plays[id] || (s.plays[id] = { t: e.t, n: 0, secs: 0 }); m.n += e.n; m.secs += e.secs; });
    Object.entries(o.days || {}).forEach(([k, v]) => s.days[k] = (s.days[k] || 0) + v);
    s.total += o.total || 0;
    store.set('stats', s);
  }

  /* ================================================================ configuración */
  function renderSettings(tab) {
    const w = el('<div class="wrap"><h1 class="title">Configuración</h1><div id="set-body"></div></div>');
    tab.appendChild(w);
    refreshSettings();
  }
  function refreshSettings() {
    const b = $('#set-body');
    if (!b) return;
    const s = settings();
    const theme = s.theme || 'auto';
    const sw = on => `<span class="switch${on ? ' on' : ''}" role="switch" aria-checked="${!!on}"></span>`;
    b.innerHTML = `
      <div id="acct-slot"></div>
      <h2 class="sec">Apariencia</h2>
      <div class="group">
        <div class="set" style="cursor:default">${icon('theme')}<div class="lbl">Tema</div>
          <div class="seg" id="seg-theme">${[['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Oscuro']].map(([v, l]) => `<button data-v="${v}" class="${theme === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        <div class="set" data-k="dynamic">${icon('palette')}<div class="lbl">Color dinámico<small>Fondo y colores tomados de la portada</small></div>${sw(s.dynamic !== false)}</div>
        <div class="set" data-k="animBg">${icon('radio')}<div class="lbl">Fondo animado al ritmo<small>El color de fondo se mueve y late con el BPM mientras suena música</small></div>${sw(s.animBg !== false)}</div>
        <div class="set" data-k="refraction">${icon('search')}<div class="lbl">Cristal de la barra de navegación<small>${Glass.supported ? 'Cristal líquido con WebGL: refracción, aberración y brillos' : 'Tu navegador no tiene WebGL2; aquí se usa desenfoque'}</small></div>${sw(s.refraction !== false && Glass.supported)}</div>
      </div>
      <h2 class="sec">Reproducción</h2>
      <div class="group">
        <div class="set" data-k="preferAudio">${icon('lyrics')}<div class="lbl">Preferir la versión de audio<small>Si eliges un videoclip, suena su pista de audio oficial: sin intros y con la letra sincronizada</small></div>${sw(s.preferAudio !== false)}</div>
        <div class="set" style="cursor:default">${icon('queue')}<div class="lbl">Fundido entre canciones<small>La siguiente empieza mientras acaba la actual</small></div>
          <div class="seg" id="seg-cf">${[[0, 'No'], [3, '3 s'], [6, '6 s'], [10, '10 s']].map(([v, l]) => `<button data-v="${v}" class="${(+s.crossfade || 0) === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        <div class="set" data-k="autoRadio">${icon('radio')}<div class="lbl">Seguir con música parecida<small>Al acabar la cola, sigue con una radio</small></div>${sw(s.autoRadio !== false)}</div>
        <div class="set" data-a="timer">${icon('timer')}<div class="lbl">Temporizador de apagado<small>${timer.end ? 'Activo · quedan ' + Math.max(0, Math.round((timer.end - Date.now()) / 60000)) + ' min' : timer.endOfTrack ? 'Al acabar la canción' : 'Desactivado'}</small></div></div>
      </div>
      <h2 class="sec">Biblioteca</h2>
      <div class="group">
        <div class="set" data-a="import-link">${icon('link')}<div class="lbl">Importar lista<small>Pega un enlace de Spotify o YouTube Music</small></div></div>
        <div class="set" data-a="stats">${icon('chart')}<div class="lbl">Estadísticas</div></div>
        <div class="set" data-a="export">${icon('download')}<div class="lbl">Exportar datos<small>Favoritas, listas, historial y estadísticas</small></div></div>
        <div class="set" data-a="import">${icon('upload')}<div class="lbl">Importar datos<small>Desde una copia exportada</small></div></div>
        <div class="set" data-a="clear-hist">${icon('trash')}<div class="lbl">Borrar historial de escucha</div></div>
      </div>
      <h2 class="sec">Atajos de teclado</h2>
      <div class="group"><div class="keys">${SHORTCUTS.map(([k, d]) => `<span>${k.split(' / ').map(x => `<kbd>${esc(x)}</kbd>`).join(' / ')}</span><span class="muted">${esc(d)}</span>`).join('')}</div></div>
      <h2 class="sec">Acerca de</h2>
      <div class="group">
        <div class="set" style="cursor:default">${icon('info')}<div class="lbl">Música<small>Búsqueda en YouTube Music · letras de LRCLIB · servidor en ${esc(location.host || 'local')}</small></div></div>
      </div>`;
    if (window.Account) Account.renderSlot($('#acct-slot', b));
    const cfBtns = $$('#seg-cf button', b);
    cfBtns.forEach(x => x.onclick = () => {
      setSetting('crossfade', +x.dataset.v);
      cfBtns.forEach(y => y.classList.toggle('on', y === x));
      toast(+x.dataset.v ? `Fundido de ${x.dataset.v} s entre canciones` : 'Sin fundido entre canciones');
    });
    // grupo de botones conectados: solo cambia la selección, sin volver a pintar el bloque
    const segBtns = $$('#seg-theme button', b);
    segBtns.forEach(x => x.onclick = () => {
      setSetting('theme', x.dataset.v); applyTheme();
      segBtns.forEach(y => { y.classList.toggle('on', y === x); y.setAttribute('aria-pressed', y === x); });
    });
    $$('.set[data-k]', b).forEach(x => x.onclick = () => {
      const k = x.dataset.k, cur = settings()[k] !== false, v = !cur;
      if (k === 'refraction' && !Glass.supported) return toast('Tu navegador no admite la refracción; se usa desenfoque');
      setSetting(k, v);
      if (k === 'dynamic') M3.setEnabled(v);
      if (k === 'refraction') Glass.setRefraction(v);
      if (k === 'autoRadio') App.state.autoRadio = v;
      refreshSettings();
    });
    $$('.set[data-a]', b).forEach(x => x.onclick = () => ({
      timer: () => timerMenu(), 'import-link': () => Sources.importPrompt(), stats: () => openStats(),
      export: () => exportData(), import: () => importData(),
      'clear-hist': () => App.sheet({ title: '¿Borrar el historial?', sub: 'Las estadísticas también se reinician', items: [{ icon: 'trash', label: 'Borrar', fn: () => { store.set('history', []); store.set('stats', { plays: {}, days: {}, total: 0 }); toast('Historial borrado'); } }] })
    }[x.dataset.a])());
  }

  /* ================================================================ PWA */
  if ('serviceWorker' in navigator && window.isSecureContext && location.protocol !== 'file:') {
    addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  /* ================================================================ eventos */
  App.on('track', () => {
    const panel = $('#player .p-panel');
    if (!panel.hidden) panel.dataset.kind === 'lyrics' ? loadLyrics(panel) : renderQueue(panel);
  });
  App.on('queue', () => {
    const panel = $('#player .p-panel');
    if (!panel.hidden && panel.dataset.kind === 'queue') renderQueue(panel);
  });
  App.on('time', ({ cur }) => syncLyrics(cur));

  return {
    renderSearch, renderSettings, refreshSettings, togglePanel, startRadio, extendRadio, timerMenu, consumeEndOfTrack,
    endOfTrackPending: () => timer.endOfTrack,
    openArtist, openAlbum, openPlaylist, openFavorites, openStats, exportData, importData, doSearch, applyTheme
  };
})();
