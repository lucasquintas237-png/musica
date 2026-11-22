'use strict';
/* app.js — núcleo: utilidades, API de YouTube Music, reproductor (solo audio),
   cola, biblioteca (favoritas, listas, historial, estadísticas) y pantalla de inicio. */

/* ======================================================================= utilidades */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (n, cls = 'ic') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const fmt = s => { s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
const parseDur = t => (t || '').trim().split(':').reduce((a, b) => a * 60 + (+b || 0), 0);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }

/* Datos en el navegador. Cada cuenta tiene su propio espacio ("mz:u:<nombre>:"); sin sesión se
   usa el de invitado ("mz:"). account.js cambia el espacio y sincroniza con el servidor. */
const store = {
  ns: 'mz:',
  onset: null,
  get(k, d) { try { const v = localStorage.getItem(this.ns + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) {
    try { localStorage.setItem(this.ns + k, JSON.stringify(v)); } catch (_) {}
    if (this.onset) try { this.onset(k, v); } catch (_) {}
  },
  remove(k) { try { localStorage.removeItem(this.ns + k); } catch (_) {} },
  keys() {
    try {
      return Object.keys(localStorage)
        .filter(k => k.startsWith(this.ns) && !(this.ns === 'mz:' && k.startsWith('mz:u:')))
        .map(k => k.slice(this.ns.length))
        .filter(k => k !== 'audioMap' && k !== 'who');
    } catch (_) { return []; }
  }
};

// si algo de la app falla en un navegador (p. ej. uno antiguo), se avisa una vez con el error,
// para poder contarlo en vez de que los botones "no hagan nada"
let errShown = false;
addEventListener('error', e => {
  if (errShown || !e.message || /ResizeObserver|Script error/i.test(e.message) || (e.filename && !e.filename.startsWith(location.origin))) return;
  errShown = true;
  setTimeout(() => toast('Algo ha fallado en la app: ' + e.message + ' (' + (e.filename || '').split('/').pop() + ':' + e.lineno + ')', 9000), 500);
});
// lo mismo con los fallos dentro de funciones asíncronas (si no, no se veía nada)
addEventListener('unhandledrejection', e => {
  const r = e.reason, msg = r && (r.message || String(r));
  if (errShown || !msg || /AbortError|NotAllowedError|play\(\)|Failed to fetch|NetworkError|Load failed/i.test(msg)) return;
  errShown = true;
  const at = (r && r.stack || '').match(/\/([\w.-]+\.js):(\d+)/);
  setTimeout(() => toast('Algo ha fallado en la app: ' + msg + (at ? ' (' + at[1] + ':' + at[2] + ')' : ''), 9000), 500);
});

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('on'), ms);
}

/* ======================================================================= portadas */
function cover(u, size = 544) {
  if (!u) return '';
  u = u.replace(/^\/\//, 'https://');
  if (/googleusercontent\.com|ggpht\.com/.test(u)) {
    if (/=w\d+-h\d+/.test(u)) return u.replace(/=w\d+-h\d+[^/]*$/, `=w${size}-h${size}-l90-rj`);
    if (/=s\d+/.test(u)) return u.replace(/=s\d+[^/]*$/, `=s${size}`);
    return u + `=w${size}-h${size}-l90-rj`;
  }
  if (/i\.ytimg\.com\/vi\//.test(u)) return u.replace(/\/[a-z0-9_]*default\.(jpg|webp).*$/, size > 200 ? '/hqdefault.jpg' : '/mqdefault.jpg');
  return u;
}
const small = u => cover(u, 120);
const PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="#2a2a32"/><path d="M12 6v7.55A3 3 0 1013.5 16V9h3V6h-4.5z" fill="#666" transform="translate(-1 0)"/></svg>');

/* Imágenes que siempre cargan: si una portada falla (404, bloqueo por referer, red), se prueba
   a través del proxy local y con otros tamaños antes de poner el marcador. */
const proxied = u => '/api/img?u=' + encodeURIComponent(u);
function imgAlternatives(u) {
  if (u.startsWith('/api/img')) { try { u = new URL(u, location.href).searchParams.get('u') || ''; } catch (_) { return []; } }
  if (!/^https?:/i.test(u)) return [];
  const out = [proxied(u)];
  if (/googleusercontent\.com|ggpht\.com/.test(u)) {
    const base = u.replace(/=[^/=]*$/, '');
    out.push(base + '=s544', proxied(base + '=s544'), proxied(base + '=s226'), proxied(base));
  }
  const yt = u.match(/i\.ytimg\.com\/vi(?:_webp)?\/([^/]+)\//);
  if (yt) ['hqdefault.jpg', 'mqdefault.jpg', 'default.jpg'].forEach(f => out.push(proxied(`https://i.ytimg.com/vi/${yt[1]}/${f}`)));
  return [...new Set(out)];
}
function retryImg(im) {
  const src = im.getAttribute('src') || '';
  if (!src || src.startsWith('data:')) return;
  // la misma <img> puede recibir otra portada (mini reproductor): entonces se empieza de cero
  if (!im.dataset.orig || src !== im.dataset.last) { im.dataset.orig = src; im.dataset.tries = 0; }
  const alts = imgAlternatives(im.dataset.orig).filter(x => x !== im.dataset.orig);
  const n = +(im.dataset.tries || 0);
  im.dataset.tries = n + 1;
  const next = n < alts.length ? alts[n] : PLACEHOLDER;
  im.dataset.last = next;
  im.src = next;
  // agotadas las variantes: se vuelve a intentar más tarde (3 rondas, cada vez esperando más)
  if (next === PLACEHOLDER) {
    const round = +(im.dataset.round || 0), orig = im.dataset.orig;
    if (round < 3) setTimeout(() => {
      if (!im.isConnected || im.dataset.last !== PLACEHOLDER || im.dataset.orig !== orig) return;
      im.dataset.round = round + 1; im.dataset.tries = 0; im.dataset.last = orig;
      im.src = orig;
    }, 4000 * (round + 1));
  }
}
// imágenes que se quedan colgadas (red lenta): pasados 12 s sin cargar, se prueba la siguiente variante
const imgSeen = new WeakMap();
setInterval(() => {
  const now = Date.now();
  document.querySelectorAll('img[src]').forEach(im => {
    if (im.complete || im.getAttribute('src').startsWith('data:')) { imgSeen.delete(im); return; }
    const s = imgSeen.get(im);
    if (!s || s.src !== im.src) imgSeen.set(im, { src: im.src, t: now });
    else if (now - s.t > 12000) { imgSeen.delete(im); retryImg(im); }
  });
}, 3000);
document.addEventListener('error', e => { if (e.target instanceof HTMLImageElement) retryImg(e.target); }, true);
// YouTube devuelve una imagen gris de 120×90 cuando no hay miniatura: también se cuenta como fallo
document.addEventListener('load', e => {
  const im = e.target;
  if (im instanceof HTMLImageElement && im.naturalWidth === 120 && im.naturalHeight === 90 && /ytimg/.test(im.dataset.orig || im.src) && /maxres|sd|hq/.test(im.src)) retryImg(im);
}, true);
// al volver la conexión, reintentar las que se quedaron con el marcador
addEventListener('online', () => $$('img[data-orig]').forEach(im => { if (im.src.startsWith('data:')) { im.dataset.tries = 0; im.src = im.dataset.orig; } }));

/* ======================================================================= YouTube Music */
const YTM = (() => {
  const ctx = { client: { clientName: 'WEB_REMIX', clientVersion: '1.20241106.01.00', hl: 'es', gl: 'ES' } };
  // Filtros de búsqueda de YouTube Music: canciones, álbumes, artistas
  const PARAMS = { songs: 'EgWKAQIIAWoMEA4QChADEAQQCRAF', albums: 'EgWKAQIYAWoMEA4QChADEAQQCRAF', artists: 'EgWKAQIgAWoMEA4QChADEAQQCRAF', playlists: 'EgeKAQQoAEABagwQDhAKEAMQBBAJEAU%3D' };

  async function call(ep, body) {
    const r = await fetch('/api/ytm/' + ep, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ context: ctx, ...body }) });
    if (!r.ok) throw new Error('YouTube Music respondió ' + r.status);
    return r.json();
  }

  const txt = o => o ? (o.runs ? o.runs.map(r => r.text).join('') : (o.simpleText || '')) : '';
  function walk(o, key, out = []) {
    if (!o || typeof o !== 'object') return out;
    if (Array.isArray(o)) { for (const x of o) walk(x, key, out); return out; }
    for (const k in o) { if (k === key) out.push(o[k]); else walk(o[k], key, out); }
    return out;
  }
  const pageType = x => x && x.navigationEndpoint && x.navigationEndpoint.browseEndpoint &&
    ((x.navigationEndpoint.browseEndpoint.browseEndpointContextSupportedConfigs || {}).browseEndpointContextMusicConfig || {}).pageType || '';
  const browseId = x => x && x.navigationEndpoint && x.navigationEndpoint.browseEndpoint && x.navigationEndpoint.browseEndpoint.browseId;
  const thumb = o => { const t = walk(o, 'thumbnails')[0] || []; return t.length ? t[t.length - 1].url : ''; };
  const TYPE_WORDS = /^(canci[oó]n|song|v[ií]deo|video|[aá]lbum|album|sencillo|single|ep|artista|artist|lista|playlist|episodio|podcast)$/i;
  const isDur = s => /^\d{1,2}:\d{2}(:\d{2})?$/.test((s || '').trim());

  function fromRuns(runs) {
    const artists = runs.filter(x => /ARTIST|USER_CHANNEL/.test(pageType(x)));
    const albumRun = runs.find(x => pageType(x) === 'MUSIC_PAGE_TYPE_ALBUM');
    const parts = runs.map(x => x.text).join('').split(/\s+•\s+/).map(s => s.trim()).filter(Boolean);
    let artist = artists.map(a => a.text).join(', ');
    if (!artist) artist = parts.find(p => !TYPE_WORDS.test(p) && !isDur(p) && !/^\d{4}$/.test(p) && !/reproducci|visualiza|usuarios|views|suscript/i.test(p)) || '';
    return {
      artist, artistId: artists[0] ? browseId(artists[0]) : '',
      album: albumRun ? albumRun.text : '', albumId: albumRun ? browseId(albumRun) : '',
      year: (parts.find(p => /^\d{4}$/.test(p)) || ''), parts
    };
  }

  // Fila de resultado (canción, álbum, artista o lista)
  function parseItem(r) {
    const cols = (r.flexColumns || []).map(c => ((c.musicResponsiveListItemFlexColumnRenderer || {}).text || {}).runs || []);
    const title = (cols[0] || []).map(x => x.text).join('');
    const meta = cols.slice(1).flat();
    const fixed = (r.fixedColumns || []).map(c => txt((c.musicResponsiveListItemFixedColumnRenderer || {}).text)).join(' ');
    const we = walk(r.overlay, 'watchEndpoint')[0] || walk(cols[0], 'watchEndpoint')[0] || {};
    const id = (r.playlistItemData && r.playlistItemData.videoId) || we.videoId || '';
    const m = fromRuns(meta);
    const pt = pageType(r);
    const durS = [...meta.map(x => x.text), fixed].find(isDur);
    const mvt = walk(we, 'musicVideoType')[0] || '';
    return {
      kind: id ? 'song' : /ALBUM/.test(pt) ? 'album' : /ARTIST|USER_CHANNEL/.test(pt) ? 'artist' : /PLAYLIST/.test(pt) ? 'playlist' : 'other',
      id, title, artist: m.artist, artistId: m.artistId, album: m.album, albumId: m.albumId, year: m.year,
      dur: durS ? parseDur(durS) : 0, cover: cover(thumb(r.thumbnail)), browseId: browseId(r) || '',
      sub: m.parts.join(' • '), video: mvt && mvt !== 'MUSIC_VIDEO_TYPE_ATV', mvt
    };
  }

  // Tarjeta (carrusel): álbum, sencillo, artista, lista
  function parseTwoRow(r) {
    const pt = pageType(r), we = walk(r.navigationEndpoint, 'watchEndpoint')[0];
    const subRuns = (r.subtitle && r.subtitle.runs) || [];
    const m = fromRuns(subRuns);
    return {
      kind: we && we.videoId ? 'song' : /ALBUM/.test(pt) ? 'album' : /ARTIST/.test(pt) ? 'artist' : /PLAYLIST/.test(pt) ? 'playlist' : 'other',
      id: we ? we.videoId : '', title: txt(r.title), sub: txt(r.subtitle), artist: m.artist, artistId: m.artistId, year: m.year,
      cover: cover(thumb(r.thumbnailRenderer)), browseId: browseId(r) || ''
    };
  }

  // Elemento de la cola de "radio" (endpoint next)
  function parsePanel(v) {
    const by = (v.longBylineText && v.longBylineText.runs) || [];
    const m = fromRuns(by);
    const mvt = walk(v.navigationEndpoint, 'musicVideoType')[0] || '';
    return {
      kind: 'song', id: v.videoId, title: txt(v.title), artist: m.artist || txt(v.shortBylineText), artistId: m.artistId,
      album: m.album, albumId: m.albumId, dur: parseDur(txt(v.lengthText)), cover: cover(thumb(v.thumbnail)),
      video: mvt && mvt !== 'MUSIC_VIDEO_TYPE_ATV', mvt
    };
  }
  const clean = t => {
    const o = { id: t.id, title: t.title, artist: t.artist, artistId: t.artistId || '', album: t.album || '', albumId: t.albumId || '', dur: t.dur || 0, cover: t.cover || '' };
    if (t.mvt === 'MUSIC_VIDEO_TYPE_ATV') o.atv = true;   // ya es la pista de audio oficial
    return o;
  };

  async function search(q, type = 'songs') {
    const j = await call('search', { query: q, params: PARAMS[type] });
    const items = walk(j, 'musicResponsiveListItemRenderer').map(parseItem);
    if (type === 'songs') {
      const songs = items.filter(i => i.kind === 'song');
      if (songs.length) return songs.map(clean);
      // Plan B: si el filtro "Canciones" no da nada (región sin catálogo o filtro caducado),
      // búsqueda sin filtro quedándonos con pistas de audio y vídeos oficiales.
      const all = walk(await call('search', { query: q }), 'musicResponsiveListItemRenderer').map(parseItem)
        .filter(i => i.kind === 'song' && i.mvt !== 'MUSIC_VIDEO_TYPE_PODCAST_EPISODE');
      const rank = i => ({ MUSIC_VIDEO_TYPE_ATV: 0, MUSIC_VIDEO_TYPE_OMV: 1, MUSIC_VIDEO_TYPE_OFFICIAL_SOURCE_MUSIC: 1 }[i.mvt] ?? 2);
      return all.sort((a, b) => rank(a) - rank(b)).map(clean);
    }
    if (type === 'albums') return items.filter(i => i.kind === 'album');
    if (type === 'artists') return items.filter(i => i.kind === 'artist');
    return items.filter(i => i.kind === 'playlist');
  }

  async function suggestions(q) {
    try {
      const j = await call('music/get_search_suggestions', { input: q });
      return walk(j, 'searchSuggestionRenderer').map(s => txt(s.suggestion)).slice(0, 6);
    } catch (_) { return []; }
  }

  async function radio(videoId) {
    const j = await call('next', { videoId, playlistId: 'RDAMVM' + videoId, isAudioOnly: true, enablePersistentPlaylistPanel: true, tunerSettingValue: 'AUTOMIX_SETTING_NORMAL' });
    let items = walk(j, 'playlistPanelVideoRenderer').map(parsePanel).filter(t => t.id);
    const audio = items.filter(t => !t.video);
    if (audio.length >= 5) items = audio;  // solo pistas de audio si hay suficientes
    return items.map(clean);
  }

  async function track(videoId) {
    const j = await call('next', { videoId, isAudioOnly: true });
    const items = walk(j, 'playlistPanelVideoRenderer').map(parsePanel);
    const t = items.find(x => x.id === videoId) || items[0];
    return t ? clean(t) : null;
  }

  function header(j) {
    const h = walk(j, 'musicResponsiveHeaderRenderer')[0] || walk(j, 'musicDetailHeaderRenderer')[0] ||
      walk(j, 'musicImmersiveHeaderRenderer')[0] || walk(j, 'musicVisualHeaderRenderer')[0] ||
      walk(j, 'musicEditablePlaylistDetailHeaderRenderer')[0] || {};
    const strap = (h.straplineTextOne && h.straplineTextOne.runs) || [];
    return {
      title: txt(h.title), sub: txt(h.subtitle), second: txt(h.secondSubtitle),
      artist: strap.map(r => r.text).join(''), artistId: strap[0] ? browseId(strap[0]) : '',
      cover: cover(thumb(h.foregroundThumbnail || h.thumbnail)),
      desc: txt((walk(h, 'musicDescriptionShelfRenderer')[0] || {}).description) || txt(h.description)
    };
  }

  async function album(id) {
    const j = await call('browse', { browseId: id });
    const h = header(j);
    const tracks = walk(j, 'musicResponsiveListItemRenderer').map(parseItem).filter(t => t.id).map(t => {
      t.artist = t.artist || h.artist; t.artistId = t.artistId || h.artistId;
      t.album = h.title; t.albumId = id; t.cover = h.cover || t.cover;
      return clean(t);
    });
    return { ...h, year: (h.sub.match(/\d{4}/) || [''])[0], tracks };
  }

  async function artist(id) {
    const j = await call('browse', { browseId: id });
    const h = header(j);
    const shelf = walk(j, 'musicShelfRenderer')[0];
    const songs = shelf ? walk(shelf, 'musicResponsiveListItemRenderer').map(parseItem).filter(t => t.id).map(t => { t.artist = t.artist || h.title; return clean(t); }) : [];
    const carousels = walk(j, 'musicCarouselShelfRenderer').map(c => ({
      title: txt(walk(c.header, 'title')[0]),
      items: walk(c.contents, 'musicTwoRowItemRenderer').map(parseTwoRow)
    })).filter(c => c.items.length);
    return { name: h.title, cover: h.cover, desc: h.desc, sub: [h.sub, h.second].filter(Boolean).join(' · '), songs, carousels };
  }

  async function playlist(id) {
    const j = await call('browse', { browseId: id.startsWith('VL') ? id : 'VL' + id });
    const h = header(j);
    const tracks = walk(j, 'musicResponsiveListItemRenderer').map(parseItem).filter(t => t.id).map(clean);
    return { name: h.title, cover: h.cover || (tracks[0] && tracks[0].cover) || '', tracks };
  }

  /* Versión de audio oficial de una canción. Los videoclips y vídeos subidos por usuarios suelen
     tener intros o finales extra, y la letra sincronizada (LRCLIB) está cronometrada sobre la
     pista de audio. YouTube Music enlaza cada videoclip con su audio ("counterpart"), pero sin
     sesión iniciada la API no lo devuelve, así que se busca la pista de audio (ATV) de la misma
     canción y se comprueba que el título y el artista coincidan. */
  const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\((?:[^)]*(?:video|vídeo|oficial|official|letra|lyrics?|audio|visualizer|hd|4k|mv)[^)]*)\)|\[[^\]]*\]/g, ' ')
    .replace(/\b(official|oficial|music|video|videoclip|lyric|lyrics|letra|audio|visualizer|hd|4k|mv)\b/g, ' ')
    .replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const audioCache = new Map(Object.entries((() => { try { return JSON.parse(localStorage.getItem('mz:audioMap') || '{}'); } catch (_) { return {}; } })()));
  function saveAudioCache() {
    const o = Object.fromEntries([...audioCache].slice(-1500));
    try { localStorage.setItem('mz:audioMap', JSON.stringify(o)); } catch (_) {}
  }
  async function audioVersion(t) {
    if (!t || !t.id) return '';
    if (audioCache.has(t.id)) return audioCache.get(t.id);
    let title = t.title || '', artist = t.artist || '';
    // títulos de vídeos subidos tipo "Artista - Canción (Letra)": el canal no suele ser el artista
    const dash = title.match(/^([^-–—]{2,40}?)\s*[-–—]\s*(.+)$/);
    if (dash && norm(dash[2])) { artist = dash[1] + ' ' + artist; title = dash[2]; }
    const nt = norm(title), na = norm(artist).split(' ').filter(w => w.length > 2);
    if (!nt) return '';
    let id = '';
    try {
      const j = await call('search', { query: `${norm(title)} ${dash ? dash[1] : artist}`.trim(), params: PARAMS.songs });
      const songs = walk(j, 'musicResponsiveListItemRenderer').map(parseItem).filter(i => i.kind === 'song' && i.mvt === 'MUSIC_VIDEO_TYPE_ATV');
      const hit = songs.find(s => {
        const st = norm(s.title), sa = norm(s.artist);
        const titleOk = st === nt || (st.length > 3 && (nt.startsWith(st) || st.startsWith(nt)));
        const artistOk = !na.length || na.some(w => sa.includes(w));
        return titleOk && artistOk;
      });
      id = hit ? hit.id : '';
    } catch (_) { return ''; }        // sin red: no se guarda, se reintentará
    audioCache.set(t.id, id);
    if (id) audioCache.set(id, id);
    saveAudioCache();
    return id;
  }

  return { call, search, suggestions, radio, track, album, artist, playlist, walk, txt, audioVersion };
})();

/* ======================================================================= reproductor (YouTube IFrame, oculto) */
/* Dos reproductores de YouTube ocultos: el "activo" es el que suena y manda; el otro sirve para
   el fundido entre canciones (crossfade): carga la siguiente en silencio, arranca unos segundos
   antes de que acabe la actual y los volúmenes se cruzan (curva de potencia constante). */
const Player = {
  ps: [null, null], ok: [false, false], a: 0,
  ready: false, pending: null, failed: false, fading: null, vol: 80,
  get yt() { return this.ps[this.a]; },
  init() {
    if (!document.getElementById('yt2')) { const d = document.createElement('div'); d.id = 'yt2'; document.getElementById('yt-host').appendChild(d); }
    window.onYouTubeIframeAPIReady = () => {
      ['yt', 'yt2'].forEach((el, k) => {
        this.ps[k] = new YT.Player(el, {
          width: 200, height: 200,
          playerVars: { autoplay: 1, controls: 0, disablekb: 1, playsinline: 1, rel: 0, fs: 0, iv_load_policy: 3, origin: location.origin },
          events: {
            onReady: () => {
              this.ok[k] = true;
              if (k === this.a) {
                this.ready = true;
                this.setVolume(App.state.volume);
                if (this.pending) { const p = this.pending; this.pending = null; this.load(p.id, p.start, p.autoplay); }
              } else this.ps[k].mute();
            },
            onStateChange: e => {
              if (k === this.a) {
                // la canción que se va termina durante el fundido: se completa el cambio
                if (this.fading && e.data === 0) return this.finishFade();
                App.onPlayerState(e.data);
              } else if (this.fading && k === this.fading.to && e.data === 1 && !this.fading.started) {
                this.fading.started = true; this.fading.t0 = performance.now();
              }
            },
            onError: e => { if (k === this.a) App.onPlayerError(e.data); else if (this.fading) this.abortFade(); }
          }
        });
      });
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { this.failed = true; this.blockedHelp(); };
    document.head.appendChild(s);
    // si en 15 s no está listo, algo lo bloquea (bloqueador de anuncios, red, navegador)
    setTimeout(() => { if (!this.ready) { this.failed = true; if (App.current) this.blockedHelp(); } }, 15000);
  },
  // explica por qué no suena: casi siempre un bloqueador o una red que bloquea YouTube
  blockedHelp() {
    toast('No se pudo cargar el reproductor de YouTube. Si usas un bloqueador de anuncios (o Brave, Opera, Samsung Internet…), desactívalo para esta web y recarga. Si estás en una red de trabajo o instituto, prueba con datos móviles.', 10000);
  },
  load(id, start = 0, autoplay = true, quiet = false) {
    if (!this.ready) {
      this.pending = { id, start, autoplay };
      if (!quiet) { if (this.failed) this.blockedHelp(); else toast('Cargando el reproductor…', 2000); }
      return;
    }
    if (this.fading) this.abortFade();
    if (autoplay) this.yt.loadVideoById({ videoId: id, startSeconds: start });
    else this.yt.cueVideoById({ videoId: id, startSeconds: start });
  },
  play() { this.ready && this.yt.playVideo(); },
  pause() { if (!this.ready) return; if (this.fading) this.finishFade(); this.yt.pauseVideo(); },
  stop() { this.ready && this.yt.stopVideo(); },
  seek(s) { if (!this.ready) return; if (this.fading) this.abortFade(); this.yt.seekTo(s, true); },
  time() { return this.ready && this.yt.getCurrentTime ? this.yt.getCurrentTime() || 0 : 0; },
  duration() { return this.ready && this.yt.getDuration ? this.yt.getDuration() || 0 : 0; },
  setVolume(v) {
    this.vol = v;
    if (!this.ready) return;
    if (this.fading) return;                       // durante el fundido manda la curva
    this.yt.setVolume(v); v > 0 ? this.yt.unMute() : this.yt.mute();
  },

  /* ---------------- fundido entre canciones ---------------- */
  canFade() { return this.ready && this.ok[1 - this.a] && !this.fading; },
  startFade(id, secs, onSwap) {
    const to = 1 - this.a, nxt = this.ps[to];
    this.fading = { from: this.a, to, dur: secs * 1000, t0: 0, started: false, onSwap, since: performance.now() };
    try { nxt.setVolume(0); nxt.unMute(); nxt.loadVideoById({ videoId: id, startSeconds: 0 }); } catch (_) { return this.abortFade(); }
    clearInterval(this._fi);
    this._fi = setInterval(() => this.fadeStep(), 50);
  },
  fadeStep() {
    const f = this.fading;
    if (!f) return clearInterval(this._fi);
    if (!f.started) { if (performance.now() - f.since > 8000) this.abortFade(); return; }   // no arranca: se cancela
    const k = Math.min(1, (performance.now() - f.t0) / f.dur), v = this.vol;
    try {
      this.ps[f.from].setVolume(Math.round(v * Math.cos(k * Math.PI / 2)));
      this.ps[f.to].setVolume(Math.round(v * Math.sin(k * Math.PI / 2)));
      if (v === 0) this.ps[f.to].mute();
    } catch (_) {}
    if (k >= 1) this.finishFade();
  },
  finishFade() {
    const f = this.fading;
    if (!f) return;
    clearInterval(this._fi);
    this.fading = null;
    try { this.ps[f.from].stopVideo(); this.ps[f.from].mute(); } catch (_) {}
    this.a = f.to;
    try { this.yt.setVolume(this.vol); this.vol > 0 ? this.yt.unMute() : this.yt.mute(); if (!f.started) this.yt.playVideo(); } catch (_) {}
    f.onSwap && f.onSwap();
  },
  abortFade() {
    const f = this.fading;
    if (!f) return;
    clearInterval(this._fi);
    this.fading = null;
    try { this.ps[f.to].stopVideo(); this.ps[f.to].mute(); } catch (_) {}
    try { this.ps[f.from].setVolume(this.vol); } catch (_) {}
  }
};

/* ======================================================================= biblioteca */
const Library = {
  favs() { return store.get('favs', []); },
  isFav(id) { return !!id && this.favs().some(t => t.id === id); },
  toggleFav(t) {
    let f = this.favs();
    const on = !f.some(x => x.id === t.id);
    f = on ? [clean(t), ...f] : f.filter(x => x.id !== t.id);
    store.set('favs', f);
    toast(on ? 'Añadida a favoritas' : 'Quitada de favoritas');
    App.emit('library');
    return on;
  },
  playlists() { return store.get('playlists', []); },
  savePlaylists(p) { store.set('playlists', p); App.emit('library'); },
  createPlaylist(name, tracks = [], extra = {}) {
    const p = this.playlists();
    const pl = { id: 'p' + Date.now().toString(36), name: name || 'Nueva lista', tracks: tracks.map(clean), created: Date.now(), ...extra };
    p.unshift(pl);
    this.savePlaylists(p);
    return pl;
  },
  addToPlaylist(pid, t) {
    const p = this.playlists(), pl = p.find(x => x.id === pid);
    if (!pl) return;
    if (t.id && pl.tracks.some(x => x.id === t.id)) return toast('Ya está en «' + pl.name + '»');
    pl.tracks.push(clean(t));
    this.savePlaylists(p);
    toast('Añadida a «' + pl.name + '»');
  },
  removeFromPlaylist(pid, idx) {
    const p = this.playlists(), pl = p.find(x => x.id === pid);
    if (!pl) return;
    pl.tracks.splice(idx, 1);
    this.savePlaylists(p);
  },
  deletePlaylist(pid) { this.savePlaylists(this.playlists().filter(x => x.id !== pid)); },
  renamePlaylist(pid, name) { const p = this.playlists(), pl = p.find(x => x.id === pid); if (pl) { pl.name = name; this.savePlaylists(p); } },
  history() { return store.get('history', []); },
  addHistory(t) {
    if (!t.id) return;
    const h = [clean(t), ...this.history().filter(x => x.id !== t.id)].slice(0, 100);
    store.set('history', h);
  },
  // estadísticas: reproducciones, segundos escuchados por canción, por día y total
  stats() { return store.get('stats', { plays: {}, days: {}, total: 0 }); },
  countPlay(t) {
    if (!t.id) return;
    const s = this.stats();
    const e = s.plays[t.id] || (s.plays[t.id] = { t: clean(t), n: 0, secs: 0 });
    e.n++; e.t = clean(t); e.last = Date.now();
    store.set('stats', s);
  },
  // pasar una canción al poco de empezar cuenta en contra para las recomendaciones
  countSkip(t) {
    if (!t || !t.id) return;
    const s = this.stats();
    const e = s.plays[t.id] || (s.plays[t.id] = { t: clean(t), n: 0, secs: 0 });
    e.skips = (e.skips || 0) + 1; e.t = clean(t);
    store.set('stats', s);
  },
  addTime(t, secs) {
    if (!t || !t.id) return;
    this._acc = (this._acc || 0) + secs;
    if (this._acc < 5) return;             // se guarda cada 5 s para no escribir sin parar
    const s = this.stats(), now = new Date(), day = now.toISOString().slice(0, 10);
    const e = s.plays[t.id] || (s.plays[t.id] = { t: clean(t), n: 0, secs: 0 });
    e.secs += this._acc; s.total += this._acc; s.days[day] = (s.days[day] || 0) + this._acc;
    // a qué horas escuchas (para el resumen) y a qué horas escuchas cada canción (para recomendar)
    const hr = now.getHours();
    s.hours = s.hours || {}; s.hours[hr] = (s.hours[hr] || 0) + this._acc;
    e.h = e.h || {}; e.h[hr] = (e.h[hr] || 0) + this._acc;
    e.last = Date.now();
    this._acc = 0;
    store.set('stats', s);
  }
};
function clean(t) { return { id: t.id || '', title: t.title || '', artist: t.artist || '', artistId: t.artistId || '', album: t.album || '', albumId: t.albumId || '', dur: t.dur || 0, cover: t.cover || '' }; }

/* ======================================================================= app */
const App = {
  state: { queue: [], index: -1, playing: false, shuffle: false, repeat: 'off', volume: 80, from: '', original: null, autoRadio: true },
  bus: new EventTarget(),
  views: [],
  _tok: 0,
  _rendered: {},
  on(ev, fn) { this.bus.addEventListener(ev, e => fn(e.detail)); },
  emit(ev, d) { this.bus.dispatchEvent(new CustomEvent(ev, { detail: d })); },
  get current() { return this.state.queue[this.state.index] || null; },

  /* ---------------- cola y reproducción ---------------- */
  playList(list, i = 0, from = '') {
    if (!list || !list.length) return;
    const s = this.state;
    s.queue = list.map(t => ({ ...t }));
    s.index = Math.max(0, Math.min(i, s.queue.length - 1));
    s.from = from;
    s.original = null;
    if (s.shuffle) this.shuffleRest(true);
    this.start();
    this.saveQueue();
  },
  playNow(t, from = '') { this.playList([t], 0, from); },
  // suena esa canción y detrás su radio (canciones parecidas), ordenada según tus gustos
  async playWithRadio(t, from) {
    this.playList([t], 0, 'Radio de ' + t.title);
    try {
      const list = window.Reco ? await Reco.radioFor(t) : (await YTM.radio(t.id)).filter(x => x.id !== t.id);
      const s = this.state, cur = this.current;
      if (!cur || (cur.id !== t.id && cur.vid !== t.id)) return;     // ya se cambió de canción
      const have = new Set(s.queue.map(x => x.id).concat(s.queue.map(x => x.vid)).filter(Boolean));
      s.queue.push(...list.filter(x => !have.has(x.id)).map(x => ({ ...x })));
      this.emit('queue'); this.saveQueue();
    } catch (_) {}
  },
  playNext(t) {
    const s = this.state;
    if (!this.current) return this.playNow(t);
    s.queue.splice(s.index + 1, 0, { ...t });
    toast('Sonará a continuación');
    this.emit('queue'); this.saveQueue();
  },
  addToQueue(list) {
    const s = this.state;
    list = Array.isArray(list) ? list : [list];
    if (!this.current) return this.playList(list, 0);
    s.queue.push(...list.map(t => ({ ...t })));
    toast(list.length > 1 ? `${list.length} canciones añadidas a la cola` : 'Añadida a la cola');
    this.emit('queue'); this.saveQueue();
  },
  removeFromQueue(i) {
    const s = this.state;
    if (i === s.index) return;
    s.queue.splice(i, 1);
    if (i < s.index) s.index--;
    this.emit('queue'); this.saveQueue();
  },
  jump(i) { this.state.index = i; this.start(); this.saveQueue(); },

  async start(startAt = 0, autoplay = true) {
    const t = this.current;
    if (!t) return;
    const tok = ++this._tok;
    this._tries = 0;
    this.updateNow(t);
    if (!t.id && typeof Sources !== 'undefined') {
      try { await Sources.resolve(t); } catch (_) {}
      if (tok !== this._tok) return;
      if (!t.id) { toast('No se encontró «' + t.title + '»'); return this.next(true); }
      this.updateNow(t);
    }
    // preferir la versión de audio oficial: misma canción sin intros, y la letra va sincronizada
    if (store.get('settings', {}).preferAudio !== false && !t.vid && !t.atv) {
      const aid = await Promise.race([YTM.audioVersion(t), new Promise(r => setTimeout(() => r(''), 2500))]);
      if (tok !== this._tok) return;
      if (aid && aid !== t.id) { t.vid = t.id; t.id = aid; }
    }
    Player.load(t.id, startAt, autoplay);
    // si a los 8 s no ha empezado a sonar, se dice por qué (en vez de no hacer nada)
    if (autoplay) setTimeout(() => {
      if (tok !== this._tok || this.state.playing) return;
      if (!Player.ready) return Player.blockedHelp();
      let st = -1;
      try { st = Player.yt.getPlayerState(); } catch (_) {}
      if (st === -1 || st === 5 || st === 2) toast('No empieza a sonar: toca ▶. Si sigue sin sonar, revisa el volumen y que el móvil no esté en silencio.', 6000);
      else if (st === 3) toast('La canción tarda en cargar: la conexión va lenta', 4000);
    }, 8000);
    this._counted = false;
    Library.addHistory(t);
    this.emit('track', t);
    this.emit('queue');
  },
  next(auto = false) {
    const s = this.state;
    if (!s.queue.length) return;
    if (!auto && this.current && Player.ready) {
      const cur = Player.time(), dur = Player.duration() || this.current.dur || 0;
      if (cur > 1 && cur < Math.min(30, dur * .4 || 30)) Library.countSkip(this.current);
    }
    if (auto && typeof Features !== 'undefined' && Features.consumeEndOfTrack()) { s.playing = false; this.updatePlaying(); return; }
    if (auto && s.repeat === 'one') { Player.seek(0); Player.play(); return; }
    if (s.index < s.queue.length - 1) { s.index++; return this.start(); }
    if (s.repeat === 'all') { s.index = 0; return this.start(); }
    if (s.autoRadio && typeof Features !== 'undefined' && this.current) return Features.extendRadio(this.current, true);
    if (auto) { s.playing = false; this.updatePlaying(); }
  },
  prev() {
    const s = this.state;
    if (Player.time() > 3 || s.index === 0) { Player.seek(0); return; }
    s.index--; this.start();
  },
  toggle() {
    if (!this.current) return;
    if (!Player.ready) return Player.failed ? Player.blockedHelp() : toast('El reproductor aún está cargando…');
    this.state.playing ? Player.pause() : Player.play();
  },
  setShuffle(on) {
    const s = this.state;
    s.shuffle = on;
    if (on) this.shuffleRest();
    else if (s.original) {
      const cur = this.current;
      s.queue = s.original; s.original = null;
      s.index = Math.max(0, s.queue.findIndex(t => t.id === cur.id && t.title === cur.title));
    }
    store.set('shuffle', on);
    this.updateModes(); this.emit('queue'); this.saveQueue();
  },
  shuffleRest(fresh) {
    const s = this.state;
    s.original = fresh ? s.queue.slice() : (s.original || s.queue.slice());
    const rest = s.queue.splice(s.index + 1);
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    s.queue.push(...rest);
  },
  cycleRepeat() {
    const order = ['off', 'all', 'one'];
    this.state.repeat = order[(order.indexOf(this.state.repeat) + 1) % 3];
    store.set('repeat', this.state.repeat);
    toast({ off: 'Repetir: desactivado', all: 'Repetir: todo', one: 'Repetir: esta canción' }[this.state.repeat]);
    this.updateModes();
  },
  setVolume(v) {
    this.state.volume = Math.max(0, Math.min(100, Math.round(v)));
    Player.setVolume(this.state.volume);
    store.set('volume', this.state.volume);
    const r = $('#p-vol'); r.value = this.state.volume; r.style.setProperty('--v', this.state.volume + '%');
  },
  // segundo por el que va la canción actual (aparte de la cola, que es más grande)
  savePos(cur) {
    const t = this.current;
    if (!t || !t.id) return;
    this._posAt = Date.now();
    const pos = cur != null ? cur : Player.time();
    try { localStorage.setItem(store.ns + 'pos', JSON.stringify({ id: t.id, pos: Math.max(0, Math.floor(pos)) })); } catch (_) {}
  },
  saveQueue() {
    const s = this.state;
    store.set('queue', { q: s.queue.slice(0, 300).map(clean), i: s.index, from: s.from });
  },

  onPlayerState(st) {
    const s = this.state;
    if (st === 1) { s.playing = true; this._tries = 0; }
    if (st === 2 || st === 0 || st === -1 && !s.playing) s.playing = false;
    if (st === 0) { this.updatePlaying(); return this.next(true); }
    this.updatePlaying();
  },
  onPlayerError(code) {
    if (typeof Sources !== 'undefined') return Sources.onPlaybackError(code, this.current);
    toast('No se puede reproducir (error ' + code + ')');
    this.next(true);
  },

  /* ---------------- interfaz del reproductor ---------------- */
  updateNow(t) {
    const mini = $('#mini');
    mini.hidden = false;
    $('img', mini).src = small(t.cover) || PLACEHOLDER;
    $('.t', mini).textContent = t.title;
    $('.s', mini).textContent = t.artist;
    $('#p-title').textContent = t.title;
    $('#p-artist').textContent = t.artist + (t.album ? ' — ' + t.album : '');
    $('#p-from').textContent = this.state.from || t.album || t.artist || '—';
    $('#player .p-cover').src = t.cover || PLACEHOLDER;
    $('#p-dur').textContent = fmt(t.dur);
    $('#p-cur').textContent = '0:00';
    this.wave && this.wave.set(0);
    document.title = `${t.title} · ${t.artist}`;
    M3.setCover(t.cover);
    this.updateFav();
    this.highlight();
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title, artist: t.artist, album: t.album,
        artwork: t.cover ? [{ src: t.cover, sizes: '544x544', type: 'image/jpeg' }] : []
      });
    }
  },
  updatePlaying() {
    const p = this.state.playing;
    $$('[data-act=toggle] use').forEach(u => u.setAttribute('href', p ? '#i-pause' : '#i-play'));
    $('#player').classList.toggle('playing', p);
    this.wave && this.wave.setPlaying(p);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = p ? 'playing' : 'paused';
  },
  updateFav() {
    const t = this.current, on = t && Library.isFav(t.id);
    const b = $('#player [data-act=fav]');
    b.classList.toggle('on', !!on);
    $('use', b).setAttribute('href', on ? '#i-heart-f' : '#i-heart');
  },
  updateModes() {
    const s = this.state;
    $('#player [data-act=shuffle]').classList.toggle('on', s.shuffle);
    const r = $('#player [data-act=repeat]');
    r.classList.toggle('on', s.repeat !== 'off');
    $('use', r).setAttribute('href', s.repeat === 'one' ? '#i-repeat1' : '#i-repeat');
  },
  highlight() {
    const id = this.current && this.current.id, vid = this.current && this.current.vid;
    $$('.row[data-id]').forEach(r => r.classList.toggle('playing', !!id && (r.dataset.id === id || r.dataset.id === vid)));
  },
  openPlayer() {
    if (!this.current) return;
    const p = $('#player');
    if (p.classList.contains('open')) return;
    p.classList.add('open'); p.setAttribute('aria-hidden', 'false');
    this.wave.setActive(true);
    history.pushState({ player: 1 }, '');
  },
  closePlayer(fromPop) {
    const p = $('#player');
    if (!p.classList.contains('open')) return;
    p.classList.remove('open'); p.setAttribute('aria-hidden', 'true');
    this.wave.setActive(false);
    if (!fromPop && history.state && history.state.player) history.back();
  },

  tick() {
    const t = this.current;
    if (!t || !Player.ready) return;
    const cur = Player.time(), dur = Player.duration() || t.dur || 0;
    if (dur && !t.dur) t.dur = Math.round(dur);
    if (this.wave && !this.wave.dragging) { this.wave.set(dur ? cur / dur : 0); $('#p-cur').textContent = fmt(cur); }
    $('#p-dur').textContent = fmt(dur);
    $('#mini .bar i').style.width = (dur ? cur / dur * 100 : 0) + '%';
    $('#mini').style.setProperty('--p', dur ? Math.min(1, cur / dur).toFixed(4) : 0);
    if (this.state.playing) {
      Library.addTime(t, .25);
      if (!this._counted && cur > Math.min(30, dur / 2)) { this._counted = true; Library.countPlay(t); }
      // por dónde va (para seguir ahí al volver a abrir la app); cada 3 s basta
      if (Date.now() - (this._posAt || 0) > 3000) this.savePos(cur);
    }
    this.emit('time', { cur, dur });
    this.crossfadeCheck(cur, dur);
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && dur && this.state.playing && (this._ps = (this._ps || 0) + 1) % 8 === 0) {
      try { navigator.mediaSession.setPositionState({ duration: dur, position: Math.min(cur, dur), playbackRate: 1 }); } catch (_) {}
    }
  },

  /* ---------------- fundido entre canciones (crossfade) ---------------- */
  // segundos de fundido elegidos en Configuración (0 = sin fundido)
  get crossfade() { return +(store.get('settings', {}).crossfade || 0); },
  crossfadeCheck(cur, dur) {
    const s = this.state, cf = this.crossfade;
    if (!cf || !s.playing || !dur || Player.fading || s.repeat === 'one') return;
    if (typeof Features !== 'undefined' && Features.endOfTrackPending && Features.endOfTrackPending()) return;
    const left = dur - cur;
    // la cola se acaba y sigue la radio: se amplía antes para poder fundir
    if (s.index >= s.queue.length - 1 && s.autoRadio && left < cf + 25 && !this._extending && typeof Features !== 'undefined') {
      this._extending = true;
      Features.extendRadio(this.current, false).finally(() => { this._extending = false; });
    }
    const nx = s.index < s.queue.length - 1 ? s.queue[s.index + 1] : (s.repeat === 'all' ? s.queue[0] : null);
    if (!nx || !nx.id || dur < cf * 2 + 10) return;
    // preparar la versión de audio de la siguiente unos segundos antes
    if (left < cf + 12 && !nx._pre) {
      nx._pre = true;
      if (store.get('settings', {}).preferAudio !== false && !nx.vid && !nx.atv) {
        YTM.audioVersion(nx).then(aid => { if (aid && aid !== nx.id) { nx.vid = nx.id; nx.id = aid; } }).catch(() => {});
      }
    }
    // +1 s: lo que tarda en arrancar el segundo reproductor
    if (left <= cf + 1 && cur > 5 && Player.canFade()) {
      const idx = s.index < s.queue.length - 1 ? s.index + 1 : 0;
      Player.startFade(nx.id, cf, () => this.crossAdvance(idx));
    }
  },
  // la siguiente ya suena: se actualiza todo sin volver a cargarla
  crossAdvance(idx) {
    const s = this.state;
    s.index = idx;
    const t = this.current;
    if (!t) return;
    ++this._tok;
    this._tries = 0; this._counted = false;
    // la anterior ha acabado: cuenta para "parar tras X canciones"
    if (typeof Features !== 'undefined') Features.consumeEndOfTrack();
    s.playing = true;
    this.updateNow(t);
    this.updatePlaying();
    Library.addHistory(t);
    this.emit('track', t);
    this.emit('queue');
    this.saveQueue();
  },

  /* ---------------- piezas de interfaz ---------------- */
  trackRow(t, i, list, opts = {}) {
    const lead = opts.numbers ? `<span class="num">${i + 1}</span>` : `<img class="art" decoding="async" src="${esc(small(t.cover) || PLACEHOLDER)}" alt="">`;
    const sub = opts.noArtist ? (t.dur ? fmt(t.dur) : '') : [t.artist, opts.showAlbum && t.album].filter(Boolean).join(' · ');
    const r = el(`<div class="row" data-id="${esc(t.id)}" role="button" tabindex="0">
      ${lead}
      <div class="txt"><div class="t ellipsis">${esc(t.title)}</div><div class="s ellipsis">${esc(sub)}</div></div>
      ${!opts.noArtist && t.dur ? `<span class="d">${fmt(t.dur)}</span>` : ''}
      <button class="opt" aria-label="Opciones">${icon('more')}</button></div>`);
    r.addEventListener('click', e => {
      if (e.target.closest('.opt')) { e.stopPropagation(); return this.trackMenu(t, { ...opts, origin: e.target.closest('.opt') }, i); }
      if (opts.onClick) return opts.onClick(t, i);
      this.playList(list, i, opts.from || '');
    });
    r.addEventListener('keydown', e => { if (e.key === 'Enter') r.click(); });
    r.addEventListener('contextmenu', e => { e.preventDefault(); this.trackMenu(t, opts, i); });
    if (this.current && this.current.id === t.id) r.classList.add('playing');
    return r;
  },
  trackList(list, opts = {}) {
    const box = el('<div class="list"></div>');
    list.forEach((t, i) => box.appendChild(this.trackRow(t, i, list, opts)));
    if (!list.length) box.appendChild(el(`<div class="empty">${esc(opts.empty || 'Nada por aquí todavía.')}</div>`));
    return box;
  },
  card(item, onClick, round) {
    const c = el(`<div class="card${round ? ' round' : ''}" role="button" tabindex="0">
      <img decoding="async" src="${esc(cover(item.cover, 300) || PLACEHOLDER)}" alt="">
      <div class="t ellipsis">${esc(item.title || item.name)}</div><div class="s ellipsis">${esc(item.sub || item.artist || '')}</div></div>`);
    c.addEventListener('click', () => onClick(item));
    c.addEventListener('keydown', e => { if (e.key === 'Enter') onClick(item); });
    return c;
  },
  shelf(items, onClick, round) {
    const s = el('<div class="shelf"></div>');
    items.forEach(i => s.appendChild(this.card(i, onClick, round)));
    return s;
  },
  section(title, more) {
    const h = el(`<h2 class="sec"><span>${esc(title)}</span></h2>`);
    if (more) { const b = el('<button class="more">Ver todo</button>'); b.onclick = more; h.appendChild(b); }
    return h;
  },
  openItem(item) {
    if (item.kind === 'album' || /^MPRE/.test(item.browseId || '')) return Features.openAlbum(item.browseId, item);
    if (item.kind === 'artist') return Features.openArtist(item.browseId, item);
    if (item.kind === 'playlist') return Sources.openYTPlaylist(item.browseId.replace(/^VL/, ''));
    if (item.kind === 'song' && item.id) return this.playNow(item);
  },

  /* hoja de acciones */
  sheet({ title, sub, img, items = [], body, origin }) {
    // menú M3 que sale del botón pulsado, si no hay formulario ni reproductor abierto
    if (origin && !body && !$('#player').classList.contains('open') && origin.isConnected) {
      return M3.menu(origin, { title, sub, img: img ? small(img) : '', items });
    }
    const sh = $('#sheet');
    sh.innerHTML = '';
    sh.style.removeProperty('--k');
    const box = el('<div class="box" role="dialog" aria-modal="true"></div>');
    box.appendChild(el('<div class="sheet-handle" role="button" tabindex="0" aria-label="Arrastra para cerrar o ampliar; toca para ampliar o reducir"></div>'));
    if (title) box.appendChild(el(`<div class="head">${img ? `<img src="${esc(small(img))}" alt="">` : ''}<div class="ellipsis"><b class="ellipsis">${esc(title)}</b><span class="muted">${esc(sub || '')}</span></div></div>`));
    items.filter(Boolean).forEach(it => {
      const b = el(`<button class="it">${icon(it.icon || 'note')}<span>${esc(it.label)}</span></button>`);
      b.onclick = () => { this.closeSheet(); it.fn(); };
      box.appendChild(b);
    });
    if (body) body(box);
    sh.appendChild(box);
    sh.hidden = false;
    sh.onclick = e => { if (e.target === sh) this.closeSheet(true); };
    this.sheetDrag(sh, box);
    const f = box.querySelector('input,button');
    f && setTimeout(() => f.focus(), 50);
  },
  closeSheet(animate) {
    const sh = $('#sheet'), box = $('.box', sh);
    const done = () => { sh.hidden = true; sh.innerHTML = ''; sh.style.removeProperty('--k'); };
    if (!animate || !box || sh.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) return done();
    // se va hacia abajo con aceleración (como al deslizarla) y el fondo se aclara
    box.style.transition = 'transform .24s cubic-bezier(.3,0,.8,.15)';
    box.style.transform = `translateY(${box.getBoundingClientRect().height + 40}px)`;
    sh.style.transition = '--k .24s linear';
    sh.style.setProperty('--k', 0);
    setTimeout(done, 240);
  },

  /* Hoja inferior de Material 3: el asa de arriba se arrastra. Hacia abajo la cierra (si se
     baja más de un tercio o con un gesto rápido); hacia arriba la amplía a casi toda la pantalla.
     Tocar el asa alterna entre normal y ampliada. En pantallas táctiles también se puede
     arrastrar desde el contenido si está desplazado del todo arriba. */
  sheetDrag(sh, box) {
    const handle = $('.sheet-handle', box);
    const rubber = (d, dim) => (1 - 1 / (d * .55 / dim + 1)) * dim;
    let d = null, block = false;
    const setK = y => sh.style.setProperty('--k', Math.max(0, Math.min(1, 1 - y / Math.max(1, d ? d.h : 1))).toFixed(3));
    const toggle = () => { box.classList.toggle('expanded'); };
    handle.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    box.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const onHandle = !!e.target.closest('.sheet-handle, .head');
      // desde el contenido solo con el dedo, si la hoja no está desplazada y no es un campo de texto
      if (!onHandle && (e.pointerType !== 'touch' || box.scrollTop > 0 || e.target.closest('input,textarea,.bpm-tap,input[type=range]'))) return;
      d = { id: e.pointerId, y0: e.clientY, last: e.clientY, t: e.timeStamp, v: 0, h: box.getBoundingClientRect().height, on: false, onHandle };
    });
    box.addEventListener('pointermove', e => {
      if (!d || e.pointerId !== d.id) return;
      const dy = e.clientY - d.y0;
      if (!d.on) {
        // un toque siempre mueve un poco el dedo: desde el contenido hace falta un gesto claro
        // (en móviles con pantallas muy sensibles, 6 px bastaban para que pulsar un botón cerrara la hoja)
        if (Math.abs(dy) < (d.onHandle ? 6 : 16)) return;
        if (!d.onHandle && dy < 0) { d = null; return; }      // desde el contenido, hacia arriba es desplazar
        d.on = true;
        try { box.setPointerCapture(d.id); } catch (_) {}
        box.style.transition = 'none'; sh.style.transition = 'none';
      }
      const dt = Math.max(1, e.timeStamp - d.t);
      d.v = .7 * d.v + .3 * ((e.clientY - d.last) / dt * 1000); d.last = e.clientY; d.t = e.timeStamp;
      // hacia abajo sigue al dedo; hacia arriba, con resistencia (anticipa la ampliación)
      const y = dy >= 0 ? dy : -rubber(-dy, 60);
      box.style.transform = `translateY(${y}px)`;
      setK(Math.max(0, dy));
      e.preventDefault();
    });
    const end = e => {
      if (!d || e.pointerId !== d.id) return;
      const { on, onHandle, v, h } = d, dy = e.clientY - d.y0;
      d = null;
      if (!on) { if (onHandle && e.type === 'pointerup' && e.target.closest('.sheet-handle')) toggle(); return; }
      block = true; setTimeout(() => { block = false; }, 60);
      // se cierra al bajarla un tercio, o con un gesto rápido que además recorra un trozo
      if (dy > h / 3 || (v > 900 && dy > 48)) return this.closeSheet(true);
      if (box.classList.contains('expanded') && (dy > 70 || v > 500)) box.classList.remove('expanded');
      else if (!box.classList.contains('expanded') && (dy < -40 || v < -600)) box.classList.add('expanded');
      // vuelve a su sitio con un muelle
      box.style.transition = 'transform .45s cubic-bezier(.34,1.45,.64,1), min-height .45s cubic-bezier(.05,.7,.1,1), max-height .45s cubic-bezier(.05,.7,.1,1)';
      box.style.transform = '';
      sh.style.transition = '--k .3s linear';
      sh.style.setProperty('--k', 1);
    };
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
    // que soltar después de arrastrar no cuente como pulsar una opción
    box.addEventListener('click', e => { if (block) { e.stopPropagation(); e.preventDefault(); } }, true);
  },
  prompt(title, value, cb, placeholder = '') {
    this.sheet({
      title, body: box => {
        const f = el(`<form><input type="text" value="${esc(value || '')}" placeholder="${esc(placeholder)}" aria-label="${esc(title)}"><div style="display:flex;gap:8px;justify-content:flex-end;margin-top:6px"><button type="button" class="btn tonal">Cancelar</button><button class="btn">Aceptar</button></div></form>`);
        f.onsubmit = e => { e.preventDefault(); const v = f.querySelector('input').value.trim(); this.closeSheet(); if (v) cb(v); };
        f.querySelector('.tonal').onclick = () => this.closeSheet();
        box.appendChild(f);
      }
    });
  },
  trackMenu(t, opts = {}, i) {
    const fav = Library.isFav(t.id);
    this.sheet({
      title: t.title, sub: t.artist, img: t.cover, origin: opts.origin, items: [
        { icon: 'playnext', label: 'Reproducir a continuación', fn: () => this.playNext(t) },
        { icon: 'queue', label: 'Añadir a la cola', fn: () => this.addToQueue(t) },
        window.Together && Together.room && { icon: 'people', label: 'Añadir a la cola de la sala', fn: () => Together.addToQueue(t) },
        { icon: 'radio', label: 'Iniciar radio', fn: () => Features.startRadio(t) },
        { icon: 'lib', label: 'Añadir a una lista', fn: () => this.pickPlaylist(t) },
        { icon: fav ? 'heart-f' : 'heart', label: fav ? 'Quitar de favoritas' : 'Añadir a favoritas', fn: () => { Library.toggleFav(t); this.updateFav(); } },
        t.artistId && { icon: 'person', label: 'Ir al artista', fn: () => { this.closePlayer(); Features.openArtist(t.artistId, { title: t.artist }); } },
        t.albumId && { icon: 'album', label: 'Ir al álbum', fn: () => { this.closePlayer(); Features.openAlbum(t.albumId, { title: t.album }); } },
        opts.playlistId && { icon: 'trash', label: 'Quitar de esta lista', fn: () => { Library.removeFromPlaylist(opts.playlistId, i); opts.onRemove && opts.onRemove(); } },
        opts.inQueue && { icon: 'trash', label: 'Quitar de la cola', fn: () => this.removeFromQueue(i) },
        t.id && window.BPM && { icon: 'chart', label: 'BPM de la canción', fn: () => BPM.sheet(t) },
        t.id && window.BPM && { icon: 'bolt', label: 'Mezcla con su ritmo', fn: () => BPM.tempoMix(t) },
        t.id && window.Reco && { icon: 'close', label: 'No me interesa', fn: () => { Reco.dislike(t); toast('No te la recomendaremos más'); } },
        t.id && window.Reco && t.artist && { icon: 'close', label: 'No me recomiendes a ' + t.artist.split(/,|&/)[0].trim(), fn: () => { Reco.dislike(t, true); toast('Vale, menos ' + t.artist.split(/,|&/)[0].trim()); } },
        t.id && this.canDownload && { icon: 'download', label: 'Descargar canción', fn: () => this.download(t) },
        t.id && { icon: 'link', label: 'Copiar enlace', fn: () => { navigator.clipboard && navigator.clipboard.writeText('https://music.youtube.com/watch?v=' + t.id).then(() => toast('Enlace copiado'), () => toast('No se pudo copiar')); } }
      ]
    });
  },
  /* Descargar una canción como archivo de audio (m4a con título, artista y portada).
     Lo hace yt-dlp en el PC donde corre serve.ps1; en la web de Cloudflare no está disponible. */
  canDownload: false,
  async checkDownload() {
    try { const r = await fetch('/api/dl/ping'); this.canDownload = r.ok && !!(await r.json()).ytdlp; } catch (_) { this.canDownload = false; }
  },
  async download(t) {
    const name = [t.artist, t.title].filter(Boolean).join(' - ') || t.id;
    toast('Descargando «' + t.title + '»… puede tardar unos segundos', 20000);
    try {
      const r = await fetch(`/api/dl/${encodeURIComponent(t.id)}?name=${encodeURIComponent(name)}`);
      if (!r.ok) throw new Error((await r.text()).replace(/^ERROR:\s*/, '') || 'error ' + r.status);
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a');
      a.href = url; a.download = name.replace(/[\\/:*?"<>|]/g, '') + '.m4a';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      toast('Descargada: ' + name);
    } catch (e) { toast('No se pudo descargar: ' + e.message, 6000); }
  },
  pickPlaylist(t) {
    const pls = Library.playlists();
    this.sheet({
      title: 'Añadir a una lista', items: [
        { icon: 'plus', label: 'Nueva lista…', fn: () => this.prompt('Nombre de la lista', '', name => { const pl = Library.createPlaylist(name); Library.addToPlaylist(pl.id, t); }) },
        ...pls.map(p => ({ icon: 'lib', label: `${p.name} (${p.tracks.length})`, fn: () => Library.addToPlaylist(p.id, t) }))
      ]
    });
  },

  /* ---------------- pestañas y vistas ---------------- */
  showTab(name, reselect) {
    const tab = $('#tab-' + name);
    if (!tab) return;
    this.closeAllViews();
    $$('#app .tab').forEach(s => s.hidden = s !== tab);
    store.set('tab', name);
    if (reselect) { tab.scrollTo({ top: 0, behavior: 'smooth' }); if (name === 'search') { const i = $('#tab-search input'); i && i.focus(); } return; }
    if (name === 'home') this.renderHome();
    else if (!this._rendered[name]) { this._rendered[name] = true; name === 'search' ? Features.renderSearch(tab) : Features.renderSettings(tab); }
    if (name === 'settings') Features.refreshSettings && Features.refreshSettings();
  },
  openView(title, build) {
    const v = el(`<div class="view"><div class="wrap"><div class="view-top"><button class="back" aria-label="Atrás">${icon('back')}</button></div><div class="body"></div></div></div>`);
    $('.back', v).onclick = () => history.back();
    const host = $('#view');
    host.hidden = false;
    document.body.classList.add('in-view');
    $$('.view', host).forEach(x => x.hidden = true);
    host.appendChild(v);
    this.views.push(v);
    history.pushState({ view: this.views.length }, '');
    build($('.body', v), v);
    return v;
  },
  closeView() {
    const v = this.views.pop();
    if (v) v.remove();
    const top = this.views[this.views.length - 1];
    if (top) top.hidden = false;
    else { $('#view').hidden = true; document.body.classList.remove('in-view'); this.highlight(); }
  },
  closeAllViews() { while (this.views.length) this.closeView(); },
  loading(box) { const s = el('<div class="spinner" role="progressbar" aria-label="Cargando"></div>'); box.appendChild(s); return s; },

  // vista de una mezcla (o de "Para ti"): portada, reproducir / aleatorio y la lista
  openMix(m) {
    this.openView(m.title, box => {
      const h = el(`<div class="hero"><img src="${esc(m.cover || PLACEHOLDER)}" alt=""><div class="meta"><h1>${esc(m.title)}</h1><div class="muted">${esc(m.sub || '')} · ${m.tracks.length} canciones</div><div class="actions"></div></div></div>`);
      const act = $('.actions', h);
      const b1 = el(`<button class="btn">${icon('play')}Reproducir</button>`); b1.onclick = () => this.playList(m.tracks, 0, m.title);
      const b2 = el(`<button class="btn tonal">${icon('shuffle')}Aleatorio</button>`); b2.onclick = () => { this.setShuffle(true); this.playList(m.tracks, 0, m.title); };
      act.append(b1, b2);
      box.appendChild(h);
      box.appendChild(this.trackList(m.tracks, { from: m.title }));
    });
  },

  /* ---------------- inicio ---------------- */
  renderHome() {
    const tab = $('#tab-home');
    const hr = new Date().getHours();
    const hello = hr < 6 ? 'Buenas noches' : hr < 13 ? 'Buenos días' : hr < 21 ? 'Buenas tardes' : 'Buenas noches';
    const hist = Library.history(), favs = Library.favs(), pls = Library.playlists();
    const w = el(`<div class="wrap"><h1 class="title">${hello}</h1></div>`);

    if (!hist.length && !favs.length && !pls.length) {
      w.appendChild(el(`<div class="group" style="padding:22px"><h2 style="margin:0 0 6px">Empieza a escuchar</h2>
        <p class="muted" style="margin:0 0 16px">Busca cualquier canción o artista. También puedes pegar un enlace de YouTube Music o de una lista de Spotify.</p>
        <button class="btn" data-go="search">${icon('search')} Buscar música</button></div>`));
      $('[data-go]', w).onclick = () => Glass.select('search');
    }

    const seeded = hist.length || store.get('seedSongs', []).length || store.get('followed', []).length;
    if (seeded) {
      if (hist.length) {
        w.appendChild(this.section('Escuchado recientemente', () => this.openView('Recientes', b => { b.appendChild(el('<h1 class="title">Recientes</h1>')); b.appendChild(this.trackList(hist, { from: 'Recientes' })); })));
        w.appendChild(this.shelf(hist.slice(0, 14).map(t => ({ ...t, sub: t.artist })), t => this.playNow(t, 'Recientes')));
      }
      // recomendaciones según tus gustos (reco.js): Para ti, mezclas diarias y "Porque escuchaste"
      const forBox = el('<div></div>'), mixBox = el('<div></div>'), becBox = el('<div></div>'), newBox = el('<div></div>');
      let forYou = [];
      w.appendChild(this.section('Para ti', () => forYou.length && this.openMix({ title: 'Para ti', sub: 'Elegidas según lo que escuchas', cover: forYou[0].cover, tracks: forYou })));
      w.appendChild(forBox); w.appendChild(mixBox); w.appendChild(newBox); w.appendChild(becBox);
      // novedades de los artistas que sigues
      if (typeof Features !== 'undefined' && Features.newReleases && store.get('followed', []).length) {
        Features.newReleases().then(list => {
          if (!list.length) return;
          newBox.appendChild(this.section('Novedades de tus artistas'));
          newBox.appendChild(this.shelf(list, it => this.openItem(it)));
        }).catch(() => {});
      }
      this.loading(forBox);
      (window.Reco ? Reco.home() : Promise.reject()).then(d => {
        forYou = d.forYou || [];
        forBox.innerHTML = '';
        if (forYou.length) forBox.appendChild(this.trackList(forYou.slice(0, 8), { from: 'Para ti', onClick: (t, i) => this.playList(forYou, i, 'Para ti') }));
        else forBox.appendChild(el('<div class="empty">Escucha algo más de música para recibir recomendaciones.</div>'));
        if (d.mixes && d.mixes.length) {
          mixBox.appendChild(this.section('Tus mezclas diarias'));
          mixBox.appendChild(this.shelf(d.mixes.map(m => ({ ...m, title: m.title, sub: m.sub, cover: m.cover })), m => this.openMix(m)));
          mixBox.querySelectorAll('.card').forEach((c, i) => c.classList.add('mix', 'mix-' + (i % 3)));
        }
        if (d.because) {
          const b = d.because;
          becBox.appendChild(this.section('Porque escuchaste «' + b.seed.title + '»'));
          becBox.appendChild(this.shelf(b.tracks.map(t => ({ ...t, sub: t.artist })), t => this.playWithRadio(t, 'Porque escuchaste ' + b.seed.title)));
        }
      }).catch(() => { forBox.innerHTML = '<div class="empty">No se pudieron cargar sugerencias.</div>'; });
    }

    // acceso a "Tu resumen" (wrapped.js) cuando ya hay datos de escucha
    if (window.Wrapped && Object.keys(Library.stats().plays || {}).length) {
      const d = Wrapped.data();
      const ban = el(`<button class="wr-banner"><span class="wr-banner-shape" aria-hidden="true"></span><span class="wr-banner-txt"><b>Tu resumen musical ${d ? d.year : ''}</b><small>${d ? d.mins.toLocaleString('es-ES') + ' minutos · tu canción, tus artistas y más' : ''}</small></span>${icon('play')}</button>`);
      ban.onclick = () => Wrapped.open();
      w.appendChild(ban);
    }

    w.appendChild(this.section('Tus listas'));
    const tiles = el('<div class="tiles"></div>');
    const tile = (ph, name, sub, fn) => { const t = el(`<div class="tile" role="button" tabindex="0"><div class="ph">${ph}</div><div class="ellipsis"><b class="ellipsis" style="display:block">${esc(name)}</b><span class="muted" style="font-size:13px">${esc(sub)}</span></div></div>`); t.onclick = fn; t.onkeydown = e => { if (e.key === 'Enter') fn(); }; tiles.appendChild(t); };
    tile(icon('heart-f'), 'Favoritas', favs.length + ' canciones', () => Features.openFavorites());
    pls.forEach(p => tile(p.cover || (p.tracks[0] && p.tracks[0].cover) ? `<img src="${esc(small(p.cover || p.tracks[0].cover))}" alt="">` : icon('lib'), p.name, p.tracks.length + ' canciones' + (p.source ? ' · ' + p.source : ''), () => Features.openPlaylist(p.id)));
    tile(icon('plus'), 'Nueva lista', 'Crear una lista vacía', () => this.prompt('Nombre de la lista', '', name => { Library.createPlaylist(name); this.renderHome(); }));
    tile(icon('link'), 'Importar lista', 'Spotify, YouTube Music, Deezer o Apple', () => Sources.importPrompt());
    w.appendChild(tiles);

    const stats = Library.stats();
    if (Object.keys(stats.plays).length) {
      w.appendChild(this.section('Lo que más escuchas', () => Features.openStats()));
      const top = Object.values(stats.plays).sort((a, b) => b.n - a.n || b.secs - a.secs).slice(0, 5).map(e => e.t);
      w.appendChild(this.trackList(top, { from: 'Lo más escuchado' }));
    }

    tab.innerHTML = '';
    tab.appendChild(w);
  },

  /* ---------------- arranque ---------------- */
  init() {
    const s = this.state;
    s.volume = store.get('volume', 80);
    s.shuffle = store.get('shuffle', false);
    s.repeat = store.get('repeat', 'off');
    s.autoRadio = store.get('settings', {}).autoRadio !== false;

    // aviso: abierto por IP o como archivo
    const hn = location.hostname;
    if (location.protocol === 'file:') {
      $('#ipwarn').innerHTML = 'Abre la app a través del servidor: ejecuta <b>serve.ps1</b> y entra en <b>http://localhost:5500</b>.';
      $('#ipwarn').hidden = false;
    } else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hn) && hn !== '127.0.0.1' || hn.includes(':')) {
      $('#ipwarn').innerHTML = `Has abierto la app por IP (${esc(hn)}). YouTube bloquea la reproducción así (error 150) y salta canciones. Ábrela con el nombre del PC, p. ej. <b>http://nombre-del-pc.local:${location.port || 5500}</b>. <a href="#" id="ipclose">Cerrar</a>`;
      $('#ipwarn').hidden = false;
      $('#ipclose').onclick = e => { e.preventDefault(); $('#ipwarn').hidden = true; };
    }

    Player.init();
    this.wave = M3.Wave($('#p-wave'), f => { const d = Player.duration() || (this.current && this.current.dur) || 0; if (d) { Player.seek(f * d); $('#p-cur').textContent = fmt(f * d); } });
    this.wave.setActive(false);
    this.setVolume(s.volume);
    $('#p-vol').addEventListener('input', e => this.setVolume(+e.target.value));

    // controles (mini y reproductor completo)
    document.addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const a = b.dataset.act;
      if (b.closest('#mini')) e.stopPropagation();
      ({
        toggle: () => this.toggle(), next: () => this.next(), prev: () => this.prev(),
        close: () => this.closePlayer(), shuffle: () => this.setShuffle(!s.shuffle), repeat: () => this.cycleRepeat(),
        fav: () => { if (this.current) { Library.toggleFav(this.current); this.updateFav(); } },
        more: () => this.current && this.trackMenu(this.current),
        lyrics: () => Features.togglePanel('lyrics'), queue: () => Features.togglePanel('queue'),
        radio: () => this.current && Features.startRadio(this.current), timer: () => Features.timerMenu()
      }[a] || (() => {}))();
    });
    $('#mini').addEventListener('click', () => this.openPlayer());
    $('#p-artist').addEventListener('click', () => { const t = this.current; if (t && t.artistId) { this.closePlayer(); Features.openArtist(t.artistId, { title: t.artist }); } });

    // deslizar hacia abajo para cerrar el reproductor
    const stage = $('#player .p-stage');
    let y0 = null;
    stage.addEventListener('pointerdown', e => { if (!$('#player .p-panel').hidden) return; y0 = e.clientY; });
    addEventListener('pointerup', e => { if (y0 != null && e.clientY - y0 > 90) this.closePlayer(); y0 = null; });

    // botón atrás del navegador/Android
    addEventListener('popstate', () => {
      if (M3.menuOpen) { M3.closeMenu(); return; }
      if (!$('#sheet').hidden) { this.closeSheet(); return; }
      if ($('#player').classList.contains('open')) { this.closePlayer(true); return; }
      if (this.views.length) this.closeView();
    });

    if ('mediaSession' in navigator) {
      const ms = navigator.mediaSession;
      const set = (a, f) => { try { ms.setActionHandler(a, f); } catch (_) {} };
      set('play', () => Player.play()); set('pause', () => Player.pause());
      set('previoustrack', () => this.prev()); set('nexttrack', () => this.next());
      set('seekto', d => Player.seek(d.seekTime));
    }

    this.on('library', () => { if (!$('#tab-home').hidden && !this.views.length) this.renderHome(); });
    this.checkDownload();
    setInterval(() => this.tick(), 250);

    // pestañas (barra Liquid Glass)
    const tab = store.get('tab', 'home');
    // la barra ya no es de cristal: el WebGL (liquid.js) solo pinta el fondo animado
    Glass.init({ tab, refraction: true, onChange: (name, changed) => this.showTab(name, !changed && !this.views.length) });
    document.documentElement.classList.toggle('no-aura', store.get('settings', {}).aura === false);
    this.showTab(tab);
    this.updateModes();

    // recuperar la cola de la última vez (sin reproducir)
    const q = store.get('queue', null);
    if (q && q.q && q.q.length) {
      s.queue = q.q; s.index = Math.min(q.i, q.q.length - 1); s.from = q.from || '';
      if (this.current && this.current.id) {
        const t = this.current;
        this.updateNow(t);
        // seguir por donde se dejó (si es la misma canción y no estaba casi acabada)
        let p = null;
        try { p = JSON.parse(localStorage.getItem(store.ns + 'pos') || 'null'); } catch (_) {}
        let at = p && (p.id === t.id || p.id === t.vid) ? p.pos : 0;
        if (t.dur && at > t.dur - 5) at = 0;
        Player.load(t.id, at, false, true);
        if (at) { $('#p-cur').textContent = fmt(at); this.wave && t.dur && this.wave.set(at / t.dur); }
      }
    }
    // al cerrar o dejar la app en segundo plano se guarda el segundo exacto
    const keep = () => { if (this.current && Player.ready && Player.time() > 0) this.savePos(); };
    addEventListener('pagehide', keep);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') keep(); });
    this.on('track', () => this.savePos(0));
    this.emit('ready');
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());
