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
    if (!/^(https?:\/\/)?([a-z0-9-]+\.)*(youtube\.com|youtu\.be|spotify\.com|spotify\.link)\//i.test(s) && !/^spotify:/.test(s)) return null;
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
    return null;
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
      box.appendChild(App.trackList(d.tracks.slice(0, 100), { from: d.name, onClick: (t, i) => App.playList(d.tracks, i, d.name) }));
    } catch (e) { box.innerHTML = `<div class="empty">No se pudo abrir el enlace. ${esc(e.message)}</div>`; }
  }

  function importPrompt() {
    App.prompt('Importar lista (Spotify o YouTube Music)', '', async url => {
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

  return { parseLink, linkResult, importPrompt, openYTPlaylist, seeAll, resolve, onPlaybackError, fetchSpotify };
})();
