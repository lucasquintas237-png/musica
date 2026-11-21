/* server/ytm.js — YouTube Music desde el servidor (para la API pública /api/v1).
   Es la misma lectura de respuestas que hace app.js en el navegador, en versión reducida:
   búsqueda, radio de una canción y página de artista. */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const VER = '1.20241106.01.00';
const ctx = { client: { clientName: 'WEB_REMIX', clientVersion: VER, hl: 'es', gl: 'ES' } };
const PARAMS = { songs: 'EgWKAQIIAWoMEA4QChADEAQQCRAF', albums: 'EgWKAQIYAWoMEA4QChADEAQQCRAF', artists: 'EgWKAQIgAWoMEA4QChADEAQQCRAF', playlists: 'EgeKAQQoAEABagwQDhAKEAMQBBAJEAU%3D' };

async function call(ep, body) {
  const r = await fetch(`https://music.youtube.com/youtubei/v1/${ep}?prettyPrint=false`, {
    method: 'POST', body: JSON.stringify({ context: ctx, ...body }),
    headers: {
      'Content-Type': 'application/json', 'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      'Origin': 'https://music.youtube.com', 'Referer': 'https://music.youtube.com/',
      'X-Youtube-Client-Name': '67', 'X-Youtube-Client-Version': VER
    }
  });
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
const parseDur = t => (t || '').trim().split(':').reduce((a, b) => a * 60 + (+b || 0), 0);
function cover(u, size = 544) {
  if (!u) return '';
  u = u.replace(/^\/\//, 'https://');
  if (/googleusercontent\.com|ggpht\.com/.test(u)) {
    if (/=w\d+-h\d+/.test(u)) return u.replace(/=w\d+-h\d+[^/]*$/, `=w${size}-h${size}-l90-rj`);
    if (/=s\d+/.test(u)) return u.replace(/=s\d+[^/]*$/, `=s${size}`);
  }
  return u;
}
function fromRuns(runs) {
  const artists = runs.filter(x => /ARTIST|USER_CHANNEL/.test(pageType(x)));
  const albumRun = runs.find(x => pageType(x) === 'MUSIC_PAGE_TYPE_ALBUM');
  const parts = runs.map(x => x.text).join('').split(/\s+•\s+/).map(s => s.trim()).filter(Boolean);
  let artist = artists.map(a => a.text).join(', ');
  if (!artist) artist = parts.find(p => !TYPE_WORDS.test(p) && !isDur(p) && !/^\d{4}$/.test(p) && !/reproducci|visualiza|usuarios|views|suscript/i.test(p)) || '';
  return { artist, artistId: artists[0] ? browseId(artists[0]) : '', album: albumRun ? albumRun.text : '', albumId: albumRun ? browseId(albumRun) : '', year: parts.find(p => /^\d{4}$/.test(p)) || '' };
}
function parseItem(r) {
  const cols = (r.flexColumns || []).map(c => ((c.musicResponsiveListItemFlexColumnRenderer || {}).text || {}).runs || []);
  const title = (cols[0] || []).map(x => x.text).join('');
  const meta = cols.slice(1).flat();
  const fixed = (r.fixedColumns || []).map(c => txt((c.musicResponsiveListItemFixedColumnRenderer || {}).text)).join(' ');
  const we = walk(r.overlay, 'watchEndpoint')[0] || walk(cols[0], 'watchEndpoint')[0] || {};
  const id = (r.playlistItemData && r.playlistItemData.videoId) || we.videoId || '';
  const m = fromRuns(meta), pt = pageType(r);
  const durS = [...meta.map(x => x.text), fixed].find(isDur);
  return {
    kind: id ? 'song' : /ALBUM/.test(pt) ? 'album' : /ARTIST|USER_CHANNEL/.test(pt) ? 'artist' : /PLAYLIST/.test(pt) ? 'playlist' : 'other',
    id, title, artist: m.artist, artistId: m.artistId, album: m.album, albumId: m.albumId, year: m.year,
    dur: durS ? parseDur(durS) : 0, cover: cover(thumb(r.thumbnail)), browseId: browseId(r) || '',
    mvt: walk(we, 'musicVideoType')[0] || ''
  };
}
function parseTwoRow(r) {
  const pt = pageType(r), we = walk(r.navigationEndpoint, 'watchEndpoint')[0];
  return {
    kind: we && we.videoId ? 'song' : /ALBUM/.test(pt) ? 'album' : /ARTIST/.test(pt) ? 'artist' : /PLAYLIST/.test(pt) ? 'playlist' : 'other',
    id: we ? we.videoId : '', title: txt(r.title), browseId: browseId(r) || '', cover: cover(thumb(r.thumbnailRenderer))
  };
}
export const song = t => ({ id: t.id, title: t.title, artist: t.artist, artistId: t.artistId || '', album: t.album || '', albumId: t.albumId || '', dur: t.dur || 0, cover: t.cover || '' });
const other = t => ({ id: t.browseId, title: t.title, ...(t.artist ? { artist: t.artist } : {}), ...(t.year ? { year: t.year } : {}), cover: t.cover || '' });

export async function search(q, type = 'songs') {
  if (!PARAMS[type]) type = 'songs';
  const items = walk(await call('search', { query: q, params: PARAMS[type] }), 'musicResponsiveListItemRenderer').map(parseItem);
  if (type === 'songs') return items.filter(i => i.kind === 'song').map(song);
  const kind = { albums: 'album', artists: 'artist', playlists: 'playlist' }[type];
  return items.filter(i => i.kind === kind).map(other);
}

export async function radio(videoId) {
  const j = await call('next', { videoId, playlistId: 'RDAMVM' + videoId, isAudioOnly: true, enablePersistentPlaylistPanel: true, tunerSettingValue: 'AUTOMIX_SETTING_NORMAL' });
  let items = walk(j, 'playlistPanelVideoRenderer').map(v => {
    const m = fromRuns((v.longBylineText && v.longBylineText.runs) || []);
    const mvt = walk(v.navigationEndpoint, 'musicVideoType')[0] || '';
    return { id: v.videoId, title: txt(v.title), artist: m.artist || txt(v.shortBylineText), artistId: m.artistId, album: m.album, albumId: m.albumId, dur: parseDur(txt(v.lengthText)), cover: cover(thumb(v.thumbnail)), video: mvt && mvt !== 'MUSIC_VIDEO_TYPE_ATV' };
  }).filter(t => t.id);
  const audio = items.filter(t => !t.video);
  if (audio.length >= 5) items = audio;
  return items.map(song);
}

export async function artist(id) {
  const j = await call('browse', { browseId: id });
  const h = walk(j, 'musicImmersiveHeaderRenderer')[0] || walk(j, 'musicVisualHeaderRenderer')[0] || walk(j, 'musicResponsiveHeaderRenderer')[0] || {};
  const name = txt(h.title);
  const shelf = walk(j, 'musicShelfRenderer')[0];
  const songs = shelf ? walk(shelf, 'musicResponsiveListItemRenderer').map(parseItem).filter(t => t.id).map(t => song({ ...t, artist: t.artist || name, artistId: t.artistId || id })) : [];
  const similar = walk(j, 'musicCarouselShelfRenderer').map(c => walk(c.contents, 'musicTwoRowItemRenderer').map(parseTwoRow))
    .filter(l => l.length && l.every(i => i.kind === 'artist')).flat().map(a => ({ id: a.browseId, name: a.title })).filter(a => a.id && a.id !== id);
  return { id, name, songs, similar };
}

/* Recomendaciones de una canción (la misma idea que reco.js, sin tu perfil): su radio sin variantes
   de la misma canción, más canciones del artista y de sus artistas parecidos. */
const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const artistKey = a => norm((a || '').split(/,|&| y | x | feat\.? /i)[0]);
const JUNK = /\b(letra|lyrics?|karaoke|instrumental|cover|sped ?up|slowed|8d|nightcore|reverb|bass ?boost(ed)?|tik ?tok|acapella|a capella)\b/i;
const baseTitle = s => norm(String(s || '').replace(/[([].*?[)\]]/g, ' ').replace(/\s[-–—|]\s.*$/, ' ').replace(/\b(feat|ft|con|with)\b.*$/i, ''));
function isVariant(seed, c) {
  const a = baseTitle(seed.title), b = baseTitle(c.title), same = artistKey(seed.artist) === artistKey(c.artist);
  if (JUNK.test(c.title) && !JUNK.test(seed.title || '')) return true;
  if (!a || !b) return false;
  if (a === b) return !same;
  return !same && a.length > 3 && (b.includes(a) || a.includes(b));
}
export async function recommend(videoId, limit = 25) {
  const list = await radio(videoId);
  const seed = list.find(t => t.id === videoId) || list[0];
  if (!seed) return { seed: null, tracks: [] };
  const good = list.filter(t => t.id !== seed.id && !isVariant(seed, t));
  let own = [], sim = [];
  if (seed.artistId) {
    try {
      const a = await artist(seed.artistId);
      own = a.songs.filter(t => t.id !== seed.id).slice(0, 5);
      const others = await Promise.all(a.similar.slice(0, 4).map(s => artist(s.id).catch(() => null)));
      const lists = others.filter(Boolean).map(o => o.songs.slice(0, 4));
      for (let i = 0; i < 4; i++) lists.forEach(l => l[i] && sim.push(l[i]));
    } catch (_) {}
  }
  // mezcla: radio primero, con canciones del artista y de los parecidos intercaladas
  const out = [], seen = new Set([seed.id]), per = new Map();
  const add = t => {
    if (!t || seen.has(t.id) || isVariant(seed, t)) return;
    const k = artistKey(t.artist);
    if ((per.get(k) || 0) >= 3) return;
    seen.add(t.id); per.set(k, (per.get(k) || 0) + 1); out.push(t);
  };
  const n = Math.max(good.length, own.length, sim.length);
  for (let i = 0; i < n && out.length < limit; i++) { add(good[i]); if (i % 3 === 1) add(own.shift()); if (i % 2 === 0) add(sim.shift()); }
  [...sim, ...own].forEach(t => out.length < limit && add(t));
  return { seed, tracks: out.slice(0, limit) };
}
