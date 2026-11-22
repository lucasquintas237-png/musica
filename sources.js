'use strict';
/* sources.js — "ver todo", listas de Spotify y YouTube Music, enlaces pegados,
   búsqueda de la canción equivalente en YouTube Music y manejo de errores de reproducción. */
const Sources = (() => {
  const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s*[([](feat|ft|con|with|prod|remaster|official|audio|video|lyric)[^)\]]*[)\]]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const mainArtist = s => (s || '').split(/,|&| y | x | feat\.? /i)[0].trim();

  /* ---------------- enlaces ---------------- */
  function parseLink(s) {
    s = (s || '').trim();
    if (!/^(https?:\/\/)?([a-z0-9-]+\.)*(youtube\.com|youtu\.be|spotify\.com|spotify\.link|deezer\.com|music\.apple\.com)\//i.test(s) && !/^spotify:/.test(s)) return null;
    let u;
    try { u = new URL(/^https?:/i.test(s) ? s : 'https://' + s); } catch (_) {
      const m = s.match(/^spotify:(playlist|album|track):([A-Za-z0-9]+)/);
      return m ? { src: 'spotify', kind: m[1], id: m[2] } : null;
    }
    const host = u.hostname.replace(/^www\.|^m\./, '');
    if (host === 'youtu.be') return { src: 'yt', kind: 'video', id: u.pathname.slice(1, 12) };
    if (/youtube\.com$/.test(host)) {
      const list = u.searchParams.get('list'), v = u.searchParams.get('v');
      if (v) return { src: 'yt', kind: 'video', id: v, list };
      if (list && !/^RD/.test(list)) return { src: 'yt', kind: 'playlist', id: list };
      let m = u.pathname.match(/\/browse\/(MPRE[\w-]+)/); if (m) return { src: 'yt', kind: 'album', id: m[1] };
      m = u.pathname.match(/\/channel\/(UC[\w-]+)/); if (m) return { src: 'yt', kind: 'artist', id: m[1] };
      m = u.pathname.match(/\/browse\/(VL[\w-]+)/); if (m) return { src: 'yt', kind: 'playlist', id: m[1].slice(2) };
      m = u.pathname.match(/\/shorts\/([\w-]{11})/); if (m) return { src: 'yt', kind: 'video', id: m[1] };
      return null;
    }
    if (/spotify\.com$/.test(host)) {
      const m = u.pathname.match(/\/(playlist|album|track)\/([A-Za-z0-9]+)/);
      return m ? { src: 'spotify', kind: m[1], id: m[2] } : null;
    }
    if (/deezer\.com$/.test(host)) {
      const m = u.pathname.match(/\/(playlist|album|track)\/(\d+)/);
      return m ? { src: 'deezer', kind: m[1], id: m[2] } : null;
    }
    if (host === 'music.apple.com') {
      const m = u.pathname.match(/\/(playlist|album|song)\//);
      return m ? { src: 'apple', kind: m[1] === 'song' || u.searchParams.get('i') ? 'track' : m[1], url: u.href, id: u.pathname } : null;
    }
    return null;
  }

  /* Deezer: API pública (listas, álbumes y canciones; las listas largas vienen por páginas) */
  async function fetchDeezer(kind, id) {
    const get = async p => { const r = await fetch('/api/deezer/' + p); if (!r.ok) throw new Error('Deezer respondió ' + r.status); const j = await r.json(); if (j.error) throw new Error(j.error.message || 'Deezer: no encontrada'); return j; };
    const map = (x, album) => ({ title: x.title_short || x.title, artist: (x.artist && x.artist.name) || '', dur: x.duration || 0, album: (x.album && x.album.title) || album || '' });
    if (kind === 'track') { const t = await get('track/' + id); return { name: t.title, cover: t.album && t.album.cover_xl, tracks: [map(t)] }; }
    const d = await get(`${kind}/${id}`);
    const list = (d.tracks && d.tracks.data) || [];
    const total = (d.tracks && d.tracks.total) || d.nb_tracks || list.length;
    for (let idx = list.length; idx < Math.min(total, 1000); idx += 100) {
      const page = await get(`${kind}/${id}/tracks?index=${idx}&limit=100`);
      if (!page.data || !page.data.length) break;
      list.push(...page.data);
    }
    return { name: d.title || 'Lista de Deezer', cover: d.picture_xl || d.cover_xl || '', tracks: list.map(x => map(x, kind === 'album' ? d.title : '')) };
  }

  /* Apple Music: su página pública lleva dentro los datos (título, artista y duración de cada canción) */
  async function fetchApple(url) {
    const r = await fetch('/api/apple?u=' + encodeURIComponent(url));
    if (!r.ok) throw new Error('Apple Music respondió ' + r.status + (r.status === 404 ? ' (¿enlace correcto y público?)' : ''));
    const html = await r.text();
    const ssd = html.match(/<script[^>]*id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/);
    if (!ssd) throw new Error('No se pudo leer la página de Apple Music');
    const tracks = [], seen = new Set();
    const walk = o => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) return o.forEach(walk);
      if (typeof o.title === 'string' && typeof o.artistName === 'string' && (o.duration || o.durationInMilliseconds)) {
        const k = o.title + '|' + o.artistName;
        if (!seen.has(k)) { seen.add(k); tracks.push({ title: o.title, artist: o.artistName, dur: Math.round((o.duration || o.durationInMilliseconds || 0) / 1000), album: o.albumName || '' }); }
      }
      for (const k in o) walk(o[k]);
    };
    walk(JSON.parse(ssd[1]));
    const meta = n => { const m = html.match(new RegExp(`<meta[^>]+property="${n}"[^>]+content="([^"]*)"`)); return m ? m[1] : ''; };
    const name = (meta('og:title') || 'Lista de Apple Music').replace(/\s+([-–—]|on|en)\s+Apple Music$/i, '').replace(/&amp;/g, '&');
    return { name, cover: meta('og:image'), tracks };
  }

  async function fetchSpotify(kind, id) {
    const r = await fetch(`/api/spotify/${kind}/${id}`);
    if (!r.ok) throw new Error('Spotify respondió ' + r.status + (r.status === 404 ? ' (¿la lista es privada?)' : ''));
    const html = await r.text();
    const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error('No se pudo leer la página de Spotify');
    const j = JSON.parse(m[1]);
    const ent = YTM.walk(j, 'entity')[0];
    if (!ent) throw new Error('Lista de Spotify vacía o privada');
    const img = (ent.coverArt && ent.coverArt.sources && ent.coverArt.sources[0] && ent.coverArt.sources[0].url) ||
      (ent.visualIdentity && ent.visualIdentity.image && ent.visualIdentity.image[0] && ent.visualIdentity.image[0].url) || '';
    let tracks;
    if (kind === 'track') {
      tracks = [{ title: ent.name || ent.title, artist: (ent.artists || []).map(a => a.name).join(', ') || ent.subtitle || '', dur: Math.round(((ent.duration && ent.duration.totalMilliseconds) || 0) / 1000) }];
    } else {
      tracks = (ent.trackList || []).map(x => ({ title: x.title, artist: (x.subtitle || '').replace(/ /g, ' ').replace(/\s*,\s*/g, ', '), dur: Math.round((x.duration || 0) / 1000) }));
    }
    return {
      name: ent.name || ent.title || 'Lista de Spotify', cover: img,
      tracks: tracks.filter(t => t.title).map(t => ({ id: '', artistId: '', album: kind === 'album' ? (ent.name || '') : '', albumId: '', cover: '', ...t }))
    };
  }

  async function loadLink(link) {
    if (link.src === 'spotify') return { ...(await fetchSpotify(link.kind, link.id)), source: 'Spotify' };
    const blank = d => ({ ...d, tracks: d.tracks.filter(t => t.title).map(t => ({ id: '', artistId: '', albumId: '', cover: '', ...t })) });
    if (link.src === 'deezer') return { ...blank(await fetchDeezer(link.kind, link.id)), source: 'Deezer' };
    if (link.src === 'apple') return { ...blank(await fetchApple(link.url)), source: 'Apple Music' };
    if (link.kind === 'playlist') return { ...(await YTM.playlist(link.id)), source: 'YouTube Music' };
    if (link.kind === 'album') { const a = await YTM.album(link.id); return { name: a.title, cover: a.cover, tracks: a.tracks, source: 'Álbum' }; }
    if (link.kind === 'video') { const t = await YTM.track(link.id); return { name: t ? t.title : 'Canción', cover: t && t.cover, tracks: t ? [t] : [], source: 'YouTube' }; }
    throw new Error('Enlace no compatible');
  }

  // Resultado al pegar un enlace en el buscador
  async function linkResult(link, box) {
    if (link.src === 'yt' && link.kind === 'artist') return Features.openArtist(link.id);
    if (link.src === 'yt' && link.kind === 'album') return Features.openAlbum(link.id);
    App.loading(box);
    try {
      const d = await loadLink(link);
      box.innerHTML = '';
      if (!d.tracks.length) { box.appendChild(el('<div class="empty">El enlace no tiene canciones (o es privado).</div>')); return; }
      const single = d.tracks.length === 1;
      box.appendChild(App.section(single ? 'Enlace' : `${d.name} · ${d.tracks.length} canciones (${d.source})`));
      if (!single) {
        const act = el('<div class="hero" style="margin-top:0"><div class="actions"></div></div>');
        const mk = (ic, label, fn, tonal) => { const b = el(`<button class="btn${tonal ? ' tonal' : ''}">${icon(ic)}${esc(label)}</button>`); b.onclick = fn; $('.actions', act).appendChild(b); };
        mk('play', 'Reproducir', () => App.playList(d.tracks, 0, d.name));
        mk('lib', 'Guardar en mis listas', () => { Library.createPlaylist(d.name, d.tracks, { cover: d.cover, source: d.source }); toast('Lista guardada'); }, true);
        box.appendChild(act);
      }
      const shown = d.tracks.slice(0, 100);
      const list = App.trackList(shown, { from: d.name, onClick: (t, i) => App.playList(d.tracks, i, d.name) });
      box.appendChild(list);
      fillRows(list, shown);
    } catch (e) { box.innerHTML = `<div class="empty">No se pudo abrir el enlace. ${esc(e.message)}</div>`; }
  }

  function importPrompt() {
    App.prompt('Importar lista (Spotify, YouTube Music, Deezer o Apple Music)', '', async url => {
      const link = parseLink(url);
      if (!link || link.kind === 'artist') return toast('Ese enlace no es de una lista, álbum o canción');
      toast('Importando…', 8000);
      try {
        const d = await loadLink(link);
        if (!d.tracks.length) return toast('La lista está vacía o es privada');
        const pl = Library.createPlaylist(d.name, d.tracks, { cover: d.cover, source: d.source });
        toast(`Importada «${pl.name}» · ${pl.tracks.length} canciones`);
        Features.openPlaylist(pl.id);
      } catch (e) { toast('No se pudo importar: ' + e.message, 4500); }
    }, 'https://open.spotify.com/playlist/…');
  }

  function openYTPlaylist(id) {
    App.openView('Lista', async box => {
      App.loading(box);
      try {
        const d = await YTM.playlist(id);
        box.innerHTML = '';
        box.appendChild(el(`<div class="hero"><img src="${esc(d.cover || PLACEHOLDER)}" alt=""><div class="meta"><h1>${esc(d.name)}</h1><div class="muted">${d.tracks.length} canciones · YouTube Music</div><div class="actions"></div></div></div>`));
        const a = $('.actions', box);
        const b1 = el(`<button class="btn">${icon('play')}Reproducir</button>`); b1.onclick = () => App.playList(d.tracks, 0, d.name); a.appendChild(b1);
        const b2 = el(`<button class="btn tonal">${icon('lib')}Guardar</button>`); b2.onclick = () => { Library.createPlaylist(d.name, d.tracks, { cover: d.cover, source: 'YouTube Music' }); toast('Lista guardada'); }; a.appendChild(b2);
        box.appendChild(App.trackList(d.tracks, { from: d.name }));
      } catch (e) { box.innerHTML = `<div class="empty">No se pudo cargar la lista. ${esc(e.message)}</div>`; }
    });
  }

  /* ---------------- ver todo ---------------- */
  function seeAll(title, q, initial) {
    App.openView(title, box => {
      box.appendChild(el(`<h1 class="title">${esc(title)}</h1>`));
      const list = initial || [];
      // en una búsqueda, elegir una canción pone su radio detrás (no el resto de resultados)
      box.appendChild(App.trackList(list, { from: title, showAlbum: true, onClick: q ? (t => App.playWithRadio(t, title)) : undefined }));
      if (!list.length && q) {
        const sp = App.loading(box);
        YTM.search(q, 'songs').then(r => { sp.remove(); box.appendChild(App.trackList(r, { from: title, showAlbum: true })); }).catch(() => { sp.remove(); toast('No se pudo cargar'); });
      }
    });
  }

  /* ---------------- buscar la canción en YouTube Music ---------------- */
  function bestMatch(t, list, exclude = []) {
    const tt = norm(t.title), ta = norm(mainArtist(t.artist));
    let best = null, bs = -1e9;
    list.forEach((c, i) => {
      if (!c.id || exclude.includes(c.id)) return;
      const ct = norm(c.title), ca = norm(c.artist);
      let s = -i * 2;
      if (ct === tt) s += 40; else if (ct.includes(tt) || tt.includes(ct)) s += 22;
      if (ta && ca.includes(ta)) s += 30;
      if (t.dur && c.dur) s -= Math.min(30, Math.abs(t.dur - c.dur) / 2);
      if (/karaoke|cover|instrumental|8d|sped up|slowed/.test(ct) && !/karaoke|cover|instrumental|8d|sped up|slowed/.test(tt)) s -= 35;
      if (s > bs) { bs = s; best = c; }
    });
    return best;
  }
  async function resolve(t, exclude = []) {
    const key = norm(t.title) + '|' + norm(mainArtist(t.artist));
    const cache = store.get('resolved', {});
    if (!exclude.length && cache[key]) { Object.assign(t, { ...cache[key], title: t.title || cache[key].title }); return t; }
    const list = await YTM.search(`${t.title} ${mainArtist(t.artist)}`.trim(), 'songs');
    const m = bestMatch(t, list, exclude);
    if (!m) return t;
    t.id = m.id;
    t.cover = t.cover || m.cover; t.album = t.album || m.album; t.albumId = t.albumId || m.albumId;
    t.artistId = t.artistId || m.artistId; t.dur = t.dur || m.dur; t.artist = t.artist || m.artist;
    if (!exclude.length) {
      cache[key] = clean(m);
      const keys = Object.keys(cache);
      if (keys.length > 800) keys.slice(0, keys.length - 800).forEach(k => delete cache[k]);
      store.set('resolved', cache);
    }
    return t;
  }

  /* Listas importadas (Spotify, Deezer, Apple): solo traen título y artista. Esto busca en segundo
     plano cada canción en YouTube Music (de 3 en 3) y rellena su id, portada y álbum; onEach avisa
     de cada una para actualizar la fila. Las que ya suenan en la cola se completan también. */
  async function complete(tracks, onEach, conc = 3) {
    const todo = tracks.map((t, i) => [t, i]).filter(([t]) => t && !t.id && t.title);
    let k = 0, changed = 0;
    const worker = async () => {
      while (k < todo.length) {
        const [t, i] = todo[k++];
        try { await resolve(t); } catch (_) {}
        if (!t.id) continue;
        changed++;
        App.state.queue.forEach(q => { if (!q.id && q.title === t.title && q.artist === t.artist) Object.assign(q, { id: t.id, cover: q.cover || t.cover, album: q.album || t.album, albumId: q.albumId || t.albumId, artistId: q.artistId || t.artistId, dur: q.dur || t.dur }); });
        try { onEach && onEach(t, i); } catch (_) {}
      }
    };
    await Promise.all(Array.from({ length: Math.min(conc, todo.length) }, worker));
    if (changed) App.emit('queue');
    return changed;
  }
  // actualiza las filas de una lista ya pintada según se van completando sus canciones
  function fillRows(box, tracks, done) {
    if (!tracks.some(t => t && !t.id)) return;
    complete(tracks, (t, i) => {
      if (!box.isConnected) return;
      const r = box.querySelectorAll('.row')[i];
      if (!r) return;
      r.dataset.id = t.id;
      const im = r.querySelector('img.art');
      if (im && t.cover) { delete im.dataset.orig; delete im.dataset.tries; im.src = small(t.cover); }
      App.highlight();
    }).then(n => { if (n && done) done(); });
  }

  /* ---------------- errores de reproducción ---------------- */
  let streak = 0;
  const MSG = { 2: 'enlace no válido', 5: 'error del reproductor', 100: 'no disponible', 101: 'el autor no permite reproducirla fuera de YouTube', 150: 'el autor no permite reproducirla fuera de YouTube' };
  async function onPlaybackError(code, t) {
    if (!t) return;
    streak++;
    // Muchos errores 150 seguidos casi siempre significan que la app se abrió por IP
    if ((code === 150 || code === 101) && streak >= 3 && /^\d{1,3}(\.\d{1,3}){3}$/.test(location.hostname)) {
      $('#ipwarn').innerHTML = 'YouTube está bloqueando las canciones porque la app se abrió por IP. Ábrela con el nombre del PC (p. ej. <b>http://nombre-del-pc.local:' + (location.port || 5500) + '</b>).';
      $('#ipwarn').hidden = false;
    }
    const tok = App._tok;
    t._tried = [...(t._tried || []), t.id];
    if (t._tried.length <= 2) {
      // probar otra versión de la misma canción
      try {
        const alt = { title: t.title, artist: t.artist, dur: t.dur };
        await resolve(alt, t._tried);
        if (tok !== App._tok) return;
        if (alt.id && !t._tried.includes(alt.id)) {
          t.id = alt.id;
          Player.load(t.id);
          return;
        }
      } catch (_) {}
    }
    if (tok !== App._tok) return;
    toast(`«${t.title}»: ${MSG[code] || 'error ' + code}. Saltando…`);
    if (streak > 8) { streak = 0; App.state.playing = false; App.updatePlaying(); return toast('Demasiados errores seguidos; reproducción detenida', 4000); }
    App.next(false);
  }
  // un "playing" correcto reinicia la racha de errores
  const origState = App.onPlayerState.bind(App);
  App.onPlayerState = st => { if (st === 1) streak = 0; origState(st); };

  return { parseLink, linkResult, importPrompt, openYTPlaylist, seeAll, resolve, complete, fillRows, onPlaybackError, fetchSpotify, loadLink };
})();
