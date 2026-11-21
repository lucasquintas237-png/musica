'use strict';
/* reco.js — recomendaciones a partir de tus gustos.
   Perfil: lo que escuchas (lo reciente pesa más), cuántas veces y cuánto rato, tus favoritas y lo
   que saltas (pasar una canción en los primeros segundos cuenta en contra, de la canción y de su
   artista). Con ese perfil se ordenan las canciones de las radios de YouTube Music:
   - "Para ti": radios de varias canciones que te gustan, mezcladas;
   - "Mezclas diarias": una por cada uno de tus artistas principales;
   - "Porque escuchaste…": a partir de algo reciente;
   - la radio que sigue a una canción (al elegirla en la búsqueda o al acabar la cola).
   En todas se evita repetir lo que acabas de oír, lo que sueles saltar y demasiadas canciones
   seguidas del mismo artista. */
const Reco = (() => {
  const RC = 'mz:radioCache', TTL = 6 * 3600e3;
  let rc = {};
  try { rc = JSON.parse(localStorage.getItem(RC) || '{}'); } catch (_) {}
  const saveRc = () => {
    const ks = Object.keys(rc).sort((a, b) => rc[a].t - rc[b].t);
    while (ks.length > 40) delete rc[ks.shift()];
    try { localStorage.setItem(RC, JSON.stringify(rc)); } catch (_) {}
  };
  const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const artistKey = a => norm((a || '').split(/,|&| y | x | feat\.? /i)[0]);

  // radio de YouTube Music de una canción (guardada unas horas para no repetir peticiones)
  async function radio(id) {
    const c = rc[id];
    if (c && Date.now() - c.t < TTL) return c.list;
    const list = await YTM.radio(id);
    rc[id] = { t: Date.now(), list }; saveRc();
    return list;
  }

  /* Variantes de la misma canción: versiones con letra, covers, karaoke, sped up… o la misma canción
     subida por otros. YouTube a veces llena la radio con eso (sobre todo desde servidores en la nube)
     y no es música "parecida": se quitan. */
  const JUNK = /\b(letra|lyrics?|karaoke|instrumental|cover|sped ?up|slowed|8d|nightcore|reverb|bass ?boost(ed)?|tik ?tok|acapella|a capella)\b/i;
  const baseTitle = s => norm(String(s || '').replace(/[([].*?[)\]]/g, ' ').replace(/\s[-–—|]\s.*$/, ' ').replace(/\b(feat|ft|con|with)\b.*$/i, ''));
  function isVariant(seed, c) {
    if (!seed || !c) return false;
    const a = baseTitle(seed.title), b = baseTitle(c.title);
    const sameArtist = artistKey(seed.artist) === artistKey(c.artist);
    if (JUNK.test(c.title) && !JUNK.test(seed.title || '')) return true;
    if (!a || !b) return false;
    if (a === b) return !sameArtist || c.id !== seed.id && /remix|version|versión|en vivo|live/i.test(c.title) && !/remix|version|versión|en vivo|live/i.test(seed.title);
    // títulos que contienen el de la canción (p. ej. "sordo de un pie letra"), de otro artista
    return !sameArtist && a.length > 3 && (b.includes(a) || a.includes(b));
  }

  /* artistas: sus canciones populares y sus "artistas parecidos" (de su página en YouTube Music) */
  const SC = 'mz:artistInfo';
  let sc = {};
  try { sc = JSON.parse(localStorage.getItem(SC) || '{}'); } catch (_) {}
  const saveSc = () => {
    const ks = Object.keys(sc).filter(k => k !== '_ids').sort((a, b) => sc[a].t - sc[b].t);
    while (ks.length > 60) delete sc[ks.shift()];
    try { localStorage.setItem(SC, JSON.stringify(sc)); } catch (_) {}
  };
  async function artistInfo(id) {
    const c = sc[id];
    if (c && Date.now() - c.t < 24 * 3600e3) return c;
    const a = await YTM.artist(id);
    const similar = a.carousels.filter(cr => cr.items.length && cr.items.every(i => i.kind === 'artist')).flatMap(cr => cr.items)
      .map(i => ({ id: i.browseId, name: i.title })).filter(x => x.id && x.id !== id).slice(0, 8);
    sc[id] = { t: Date.now(), name: a.name, songs: a.songs.slice(0, 8).map(s => ({ ...s, artistId: s.artistId || id })), similar };
    saveSc();
    return sc[id];
  }
  async function artistIdOf(t) {
    if (t.artistId) return t.artistId;
    const name = (t.artist || '').split(/,|&| y | x | feat\.? /i)[0].trim();
    if (!name) return '';
    sc._ids = sc._ids || {};
    const k = norm(name);
    if (sc._ids[k]) return sc._ids[k];
    const r = await YTM.search(name, 'artists');
    const hit = r.find(a => norm(a.title) === k) || r[0];
    sc._ids[k] = hit ? hit.browseId : '';
    saveSc();
    return sc._ids[k];
  }

  /* ---------------------------------------------------------------- perfil */
  function profile() {
    const hist = Library.history(), stats = Library.stats(), favs = Library.favs();
    const artist = new Map(), song = new Map(), tracks = new Map(), askips = new Map();
    const add = (t, w) => {
      if (!t || !t.id) return;
      tracks.set(t.id, tracks.get(t.id) || t);
      song.set(t.id, (song.get(t.id) || 0) + w);
      const k = artistKey(t.artist); if (k) artist.set(k, (artist.get(k) || 0) + w);
    };
    hist.forEach((t, i) => add(t, 2 * Math.pow(.96, i)));                 // lo reciente pesa más
    const now = Date.now();
    Object.values(stats.plays || {}).forEach(e => {
      const sk = e.skips || 0, n = e.n || 0, dur = (e.t && e.t.dur) || 0;
      // escucharla entera cuenta más que dejarla a medias
      const done = dur && n ? Math.min(1.2, (e.secs || 0) / (n * dur)) : .5;
      // lo que te gusta últimamente pesa más que lo de hace meses
      const fresh = e.last ? 2 * Math.exp(-(now - e.last) / (14 * 864e5)) : 0;
      add(e.t, Math.log2(1 + n) * 1.2 + done * 1.5 + fresh + Math.min(2, (e.secs || 0) / 900) - sk * 1.5);
      const k = artistKey(e.t && e.t.artist);
      if (k && sk) { const a = askips.get(k) || { s: 0, n: 0 }; a.s += sk; a.n += n; askips.set(k, a); }
    });
    favs.forEach(t => add(t, 3));
    // artistas que sigues y canciones elegidas en la bienvenida (pesan menos según crece tu historial)
    (store.get('followed', []) || []).forEach(a => { const k = artistKey(a.name); if (k) artist.set(k, (artist.get(k) || 0) + 4); });
    const fade = Math.exp(-hist.length / 30);
    (store.get('seedSongs', []) || []).forEach(t => add(t, 2.5 * fade));
    const skipped = new Set(Object.values(stats.plays || {}).filter(e => (e.skips || 0) >= 2 && (e.skips || 0) > (e.n || 0)).map(e => e.t.id));
    // "No me interesa": esa canción fuera y su artista muy abajo
    const dis = store.get('disliked', { ids: [], artists: [] }) || { ids: [], artists: [] };
    (dis.ids || []).forEach(id => skipped.add(id));
    const banned = new Set(dis.artists || []);
    banned.forEach(k => artist.set(k, (artist.get(k) || 0) - 6));
    const recent = new Set(hist.slice(0, 25).map(t => t.id));
    return { artist, song, tracks, askips, skipped, recent, hist, favs, banned };
  }

  // las mejores canciones del perfil, de artistas distintos
  function seeds(p, k = 3, avoid = new Set()) {
    const out = [], seen = new Set();
    for (const [id, s] of [...p.song.entries()].sort((a, b) => b[1] - a[1])) {
      const t = p.tracks.get(id), a = artistKey(t && t.artist);
      if (!t || s <= 0 || avoid.has(id) || seen.has(a) || p.skipped.has(id)) continue;
      seen.add(a); out.push(t);
      if (out.length >= k) break;
    }
    return out;
  }

  const fromRadio = (list, weight = 1) => list.map((t, i) => ({ t, w: weight / (1 + i * .08) }));

  // ordena candidatas según el perfil, con variedad de artistas
  function rank(cands, p, { limit = 25, perArtist = 2, exclude = new Set(), discover = true, aff: affW = .6 } = {}) {
    const byId = new Map();
    for (const { t, w } of cands) {
      if (!t || !t.id || exclude.has(t.id)) continue;
      const c = byId.get(t.id) || { t, w: 0, n: 0 };
      c.w += w; c.n++; byId.set(t.id, c);
    }
    const scored = [...byId.values()].filter(c => !p.skipped.has(c.t.id) && !(p.banned && p.banned.has(artistKey(c.t.artist)))).map(c => {
      const k = artistKey(c.t.artist), aff = Math.max(0, p.artist.get(k) || 0), sk = p.askips.get(k);
      let s = c.w + affW * Math.log2(1 + aff) + (c.n - 1) * .8;          // aparece en varias radios: mejor
      if (sk && sk.s > sk.n) s -= Math.min(2, (sk.s - sk.n) * .3);        // artista que sueles saltar
      if (p.recent.has(c.t.id)) s -= 2.5;                                 // lo acabas de oír
      else if (discover && (p.song.get(c.t.id) || 0) > 0) s -= .4;         // ya conocida: deja sitio a lo nuevo
      return { t: c.t, s };
    }).sort((a, b) => b.s - a.s);
    const out = [], per = new Map();
    for (const x of scored) {
      const k = artistKey(x.t.artist);
      if ((per.get(k) || 0) >= perArtist) continue;
      per.set(k, (per.get(k) || 0) + 1);
      out.push(x.t);
      if (out.length >= limit) break;
    }
    return out;
  }

  /* ---------------------------------------------------------------- radio de una canción */
  /* Como Spotify: la radio de una canción mezcla
       · la radio de YouTube Music de esa canción (sin variantes ni versiones de la misma),
       · otras canciones del mismo artista,
       · canciones de sus artistas parecidos (mismo estilo).
     Si la radio de YouTube viene pobre (pasa desde servidores en la nube), lo del artista y sus
     parecidos la sostiene igualmente. */
  async function radioFor(t, { exclude = new Set(), limit = 40 } = {}) {
    const p = profile();
    const seed = { ...t, id: t.vid || t.id };
    const ex = new Set([...exclude, t.id, t.vid].filter(Boolean));
    const [rlist, pool] = await Promise.all([
      radio(seed.id).catch(() => []),
      artistPool(seed).catch(() => ({ own: [], similar: [] }))
    ]);
    const good = rlist.filter(c => c.id && !isVariant(seed, c));
    // calidad de la radio: cuántos artistas distintos trae (una radio "buena" trae muchos)
    const radioArtists = new Set(good.map(c => artistKey(c.artist))).size;
    const rw = radioArtists >= 6 ? 3 : radioArtists >= 3 ? 2 : 1;
    const cands = fromRadio(good, rw);
    const seen = new Set(good.map(c => c.id));
    const push = (c, w) => { if (c.id && !seen.has(c.id) && !isVariant(seed, c)) { seen.add(c.id); cands.push({ t: c, w, n: 1 }); } };
    pool.own.slice(0, 6).forEach((c, i) => push(c, 1.6 / (1 + i * .25)));
    pool.similar.forEach((c, i) => push(c, (rw < 3 ? 2.2 : 1.5) / (1 + i * .06)));
    return spread(rank(cands, p, { limit, perArtist: 3, exclude: ex, discover: false, aff: .25 }));
  }
  // canciones del artista de la semilla y de sus artistas parecidos (intercaladas)
  async function artistPool(t) {
    const id = await artistIdOf(t);
    if (!id) return { own: [], similar: [] };
    const a = await artistInfo(id);
    const sims = await Promise.all(a.similar.slice(0, 5).map(s => artistInfo(s.id).catch(() => null)));
    const lists = sims.filter(Boolean).map(s => s.songs.slice(0, 5));
    const similar = [];
    for (let i = 0; i < 5; i++) lists.forEach(l => { if (l[i]) similar.push(l[i]); });
    return { own: a.songs.filter(s => s.id !== t.id), similar };
  }
  // "No me interesa": quita la canción de las recomendaciones (y, si se pide, a su artista)
  function dislike(t, artistToo = false) {
    const d = store.get('disliked', { ids: [], artists: [] }) || { ids: [], artists: [] };
    d.ids = [t.id, ...(d.ids || []).filter(x => x !== t.id)].slice(0, 500);
    d.artists = d.artists || [];
    const k = artistKey(t.artist);
    if (artistToo && k && !d.artists.includes(k)) d.artists.unshift(k);
    store.set('disliked', d);
    invalidate();
  }
  // evita dos canciones seguidas del mismo artista (si se puede)
  function spread(list) {
    const out = [], rest = list.slice();
    while (rest.length) {
      const last = out.length && artistKey(out[out.length - 1].artist);
      const i = rest.findIndex(t => artistKey(t.artist) !== last);
      out.push(rest.splice(i < 0 ? 0 : i, 1)[0]);
    }
    return out;
  }

  /* ---------------------------------------------------------------- inicio */
  let homeCache = null;
  async function home() {
    const p = profile();
    const sig = (p.hist[0] && p.hist[0].id) + '|' + p.favs.length + '|' + p.song.size;
    if (homeCache && homeCache.sig === sig && Date.now() - homeCache.t < 15 * 60e3) return homeCache.data;
    const top = seeds(p, 3);
    if (!top.length) return { forYou: [], mixes: [], because: null };
    const radios = await Promise.all(top.map(s => radio(s.id).catch(() => [])));
    const forYou = rank(radios.flatMap(l => fromRadio(l)), p, { limit: 20, perArtist: 2, exclude: new Set(top.map(s => s.id)) });

    // mezclas diarias: una por artista principal (sus canciones que te gustan + parecidas)
    const topArtists = [...p.artist.entries()].filter(e => e[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 4).map(e => e[0]);
    const mixes = [];
    for (const a of topArtists) {
      const own = [...p.song.entries()].map(([id, s]) => ({ t: p.tracks.get(id), s })).filter(x => x.t && artistKey(x.t.artist) === a && x.s > 0 && !p.skipped.has(x.t.id)).sort((x, y) => y.s - x.s);
      if (!own.length) continue;
      const seed = own[0].t;
      const rl = await radio(seed.id).catch(() => []);
      const sim = rank(fromRadio(rl), p, { limit: 22, perArtist: 3, exclude: new Set(own.map(x => x.t.id)) });
      const mine = own.slice(0, 4).map(x => x.t);
      // intercala tus canciones con las nuevas
      const tracks = [];
      for (let i = 0; tracks.length < 25 && (i < mine.length || i * 4 < sim.length); i++) { if (mine[i]) tracks.push(mine[i]); tracks.push(...sim.slice(i * 4, i * 4 + 4)); }
      const names = [...new Set(tracks.map(t => (t.artist || '').split(',')[0].trim()).filter(Boolean))].slice(0, 3);
      mixes.push({ title: 'Mezcla diaria ' + (mixes.length + 1), sub: names.join(', ') + ' y más', cover: seed.cover, tracks: tracks.slice(0, 25) });
      if (mixes.length >= 3) break;
    }

    // porque escuchaste: algo reciente que no esté ya entre las semillas
    let because = null;
    const bseed = p.hist.find(t => !top.some(s => s.id === t.id) && !p.skipped.has(t.id));
    if (bseed) {
      const bl = await radio(bseed.id).catch(() => []);
      const tracks = rank(fromRadio(bl), p, { limit: 12, perArtist: 2, exclude: new Set([bseed.id, ...forYou.slice(0, 8).map(t => t.id)]) });
      if (tracks.length) because = { seed: bseed, tracks };
    }
    const data = { forYou, mixes, because };
    homeCache = { sig, t: Date.now(), data };
    return data;
  }

  function invalidate() { homeCache = null; }
  return { profile, radioFor, home, rank, radio, artistKey, invalidate, dislike, isVariant };
})();
window.Reco = Reco;
