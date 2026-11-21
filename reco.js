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
    Object.values(stats.plays || {}).forEach(e => {
      const sk = e.skips || 0;
      add(e.t, Math.log2(1 + (e.n || 0)) * 1.5 + Math.min(3, (e.secs || 0) / 600) - sk * 1.2);
      const k = artistKey(e.t && e.t.artist);
      if (k && sk) { const a = askips.get(k) || { s: 0, n: 0 }; a.s += sk; a.n += e.n || 0; askips.set(k, a); }
    });
    favs.forEach(t => add(t, 3));
    // artistas que sigues y canciones elegidas en la bienvenida (pesan menos según crece tu historial)
    (store.get('followed', []) || []).forEach(a => { const k = artistKey(a.name); if (k) artist.set(k, (artist.get(k) || 0) + 4); });
    const fade = Math.exp(-hist.length / 30);
    (store.get('seedSongs', []) || []).forEach(t => add(t, 2.5 * fade));
    const skipped = new Set(Object.values(stats.plays || {}).filter(e => (e.skips || 0) >= 2 && (e.skips || 0) > (e.n || 0)).map(e => e.t.id));
    const recent = new Set(hist.slice(0, 25).map(t => t.id));
    return { artist, song, tracks, askips, skipped, recent, hist, favs };
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
    const scored = [...byId.values()].filter(c => !p.skipped.has(c.t.id)).map(c => {
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
  async function radioFor(t, { exclude = new Set(), limit = 40 } = {}) {
    const p = profile();
    const ex = new Set([...exclude, t.id, t.vid].filter(Boolean));
    const list = await radio(t.vid || t.id);
    // es la radio de ESA canción: manda el orden de la radio; el perfil solo quita lo que sueles
    // saltar o acabas de oír y matiza un poco
    const ranked = rank(fromRadio(list, 3), p, { limit, perArtist: 4, exclude: ex, discover: false, aff: .15 });
    return spread(ranked);
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

  return { profile, radioFor, home, rank, radio, artistKey, invalidate: () => { homeCache = null; } };
})();
window.Reco = Reco;
