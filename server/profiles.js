/* server/profiles.js — perfiles: foto y descripción.
     GET    /api/profile/<nombre>          -> {username, bio, avatar (versión o null), since}
     GET    /api/profile/<nombre>/avatar   -> la foto (imagen)
     PUT    /api/profile                   -> {bio} cambia tu descripción
     PUT    /api/profile/avatar            -> cuerpo = la imagen (WebP o JPEG) cambia tu foto
     DELETE /api/profile/avatar            -> quita tu foto
     GET    /api/profile/<nombre>?full=1   -> además: seguidores, si sois amigos, qué escucha (según
                                              su privacidad), su sala, canción, artistas, listas
                                              públicas y vuestra compatibilidad
     PUT/DELETE /api/profile/<nombre>/follow   seguir / dejar de seguir (si os seguís, sois amigos)
     GET    /api/profile/<nombre>/playlist/<id> una lista pública suya
     GET    /api/friends                   -> a quién sigues (con lo que escuchan) y quién te sigue
     PUT    /api/profile {song, share, top} -> canción del perfil y privacidad

   Seguridad de las subidas:
   - Aquí no hay PHP ni nada que se ejecute: es un Worker y la foto se guarda como DATOS en D1
     (texto base64), nunca como archivo en una carpeta servida.
   - La app ya la rehace (recorte cuadrado, 256 px, WebP) antes de subirla, lo que quita metadatos
     como el GPS. Aun así aquí se comprueba todo como si viniera de alguien malicioso:
     tipo real por los primeros bytes (solo WebP o JPEG), estructura coherente, tamaño máximo,
     dimensiones máximas (contra "bombas" de descompresión) y que no lleve código incrustado
     (<?php, <script, <html…: los archivos "políglota").
   - Al servirla: siempre con su tipo de imagen, nosniff, CSP sandbox y sin poder abrirse como
     página; solo para usuarios con sesión.
   - Límite de subidas por persona y hora. Todas las consultas son parametrizadas (sin inyección SQL).
   - La descripción se limpia (sin caracteres de control, 160 como mucho) y se guarda cifrada. */
import { schema, currentUser, readData } from './accounts.js';
import { seal, open } from './crypto.js';
import { presenceOf, ensureApiSchema, cleanTrack } from './api.js';

const MAX_BYTES = 200 * 1024, MAX_SIDE = 1024, BIO_MAX = 160;
const USER_RE = /^[a-z0-9_.-]{3,24}$/i;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const err = (status, msg) => json(status, { error: msg });

let ready = null;
function profileSchema(db) {
  if (!ready) ready = db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS profiles (user_id INTEGER PRIMARY KEY, bio TEXT, avatar TEXT, avatar_type TEXT, avatar_v INTEGER, updated INTEGER NOT NULL)'),
    // preferencias del perfil (cifradas): canción del perfil, quién ve lo que escuchas, artistas
    db.prepare('CREATE TABLE IF NOT EXISTS profile_prefs (user_id INTEGER PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL)'),
    // a quién sigue cada uno (si os seguís los dos, sois amigos)
    db.prepare('CREATE TABLE IF NOT EXISTS follows (user_id INTEGER NOT NULL, target_id INTEGER NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (user_id, target_id))'),
    db.prepare('CREATE INDEX IF NOT EXISTS follows_target ON follows (target_id)')
  ]).catch(e => { ready = null; throw e; });
  return ready;
}
const SHARE = ['all', 'friends', 'none'];
const DEF_PREFS = { song: null, share: 'friends', top: true };
async function prefsOf(env, row) {
  if (!row || !row.data) return { ...DEF_PREFS };
  try { return { ...DEF_PREFS, ...JSON.parse(await open(env, row.user_id + ':prefs', row.data)) }; } catch (_) { return { ...DEF_PREFS }; }
}
// lo que más escucha alguien, por artista (de sus estadísticas)
function artistWeights(stats) {
  const by = new Map();
  Object.values((stats && stats.plays) || {}).forEach(e => {
    if (!e || !e.t) return;
    const name = String(e.t.artist || '').split(/,|&| y | feat\.? /i)[0].trim();
    if (!name) return;
    const a = by.get(name.toLowerCase()) || { name, artistId: e.t.artistId || '', secs: 0 };
    a.secs += +e.secs || 0;
    if (!a.artistId && e.t.artistId) a.artistId = e.t.artistId;
    by.set(name.toLowerCase(), a);
  });
  return [...by.values()].filter(a => a.secs > 0).sort((a, b) => b.secs - a.secs);
}
// compatibilidad: cuánto se parece el reparto de escucha por artistas (0–100)
function compat(a, b) {
  if (a.length < 3 || b.length < 3) return null;
  const tot = l => l.reduce((s, x) => s + x.secs, 0);
  const ta = tot(a), tb = tot(b), mb = new Map(b.map(x => [x.name.toLowerCase(), x]));
  let overlap = 0; const common = [];
  a.forEach(x => {
    const y = mb.get(x.name.toLowerCase());
    if (!y) return;
    overlap += Math.min(x.secs / ta, y.secs / tb);
    common.push({ name: x.name, artistId: x.artistId || y.artistId || '', w: x.secs / ta + y.secs / tb });
  });
  return { pct: Math.round(100 * Math.pow(overlap, .55)), common: common.sort((p, q) => q.w - p.w).slice(0, 6).map(({ name, artistId }) => ({ name, artistId })) };
}
const publicLists = pls => (Array.isArray(pls) ? pls : []).filter(p => p && p.pub).slice(0, 30);
const ROOM_LIVE = 15 * 60e3;

/* ---------------------------------------------------------------- comprobación de imágenes */
const u32le = (b, i) => b[i] | b[i + 1] << 8 | b[i + 2] << 16 | (b[i + 3] << 24 >>> 0);
const u16be = (b, i) => b[i] << 8 | b[i + 1];
// tipo real por los "números mágicos" del principio del archivo
function sniff(b) {
  if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length > 4 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  return null;
}
// ancho y alto leídos de la propia imagen (y de paso, que la estructura sea coherente)
function dims(b, type) {
  if (type === 'image/webp') {
    if (u32le(b, 4) + 8 !== b.length) return null;              // el tamaño declarado tiene que cuadrar
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (chunk === 'VP8 ') return b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a ? { w: (b[26] | b[27] << 8) & 0x3fff, h: (b[28] | b[29] << 8) & 0x3fff } : null;
    if (chunk === 'VP8L') { if (b[20] !== 0x2f) return null; const v = u32le(b, 21); return { w: (v & 0x3fff) + 1, h: (v >> 14 & 0x3fff) + 1 }; }
    if (chunk === 'VP8X') return { w: 1 + (b[24] | b[25] << 8 | b[26] << 16), h: 1 + (b[27] | b[28] << 8 | b[29] << 16) };
    return null;
  }
  if (type === 'image/jpeg') {
    if (b[b.length - 2] !== 0xFF || b[b.length - 1] !== 0xD9) return null;     // tiene que acabar como un JPEG
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xFF) return null;
      const m = b[i + 1];
      if (m === 0xD8 || (m >= 0xD0 && m <= 0xD7) || m === 0x01) { i += 2; continue; }
      const len = u16be(b, i + 2);
      if (len < 2) return null;
      if ((m >= 0xC0 && m <= 0xC3) || (m >= 0xC5 && m <= 0xC7) || (m >= 0xC9 && m <= 0xCB) || (m >= 0xCD && m <= 0xCF)) return { h: u16be(b, i + 5), w: u16be(b, i + 7) };
      i += 2 + len;
    }
    return null;
  }
  return null;
}
// código incrustado dentro de la imagen (archivos que son imagen y a la vez script o página)
function hasCode(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) { const c = b[i]; s += c >= 32 && c < 127 ? String.fromCharCode(c | (c >= 65 && c <= 90 ? 32 : 0)) : ' '; }
  return /<\?php|<\?=\s*\$|<script|<html|<iframe|<svg[\s>]|<body|javascript:|onerror\s*=|onload\s*=/.test(s);
}
export function checkImage(bytes) {
  if (!bytes.length) return { error: 'La imagen está vacía' };
  if (bytes.length > MAX_BYTES) return { error: 'La imagen es demasiado grande (máximo 200 KB)' };
  const type = sniff(bytes);
  if (!type) return { error: 'Solo se aceptan imágenes WebP o JPEG' };
  const d = dims(bytes, type);
  if (!d || !d.w || !d.h) return { error: 'La imagen está dañada o no es válida' };
  if (d.w > MAX_SIDE || d.h > MAX_SIDE) return { error: `La imagen es demasiado grande (máximo ${MAX_SIDE} px)` };
  if (hasCode(bytes)) return { error: 'La imagen contiene datos no permitidos' };
  return { type, w: d.w, h: d.h };
}

/* ---------------------------------------------------------------- utilidades */
const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
function cleanBio(v) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩]/g, '')   // control e invisibles
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, BIO_MAX);
}
// límite de subidas: 20 cambios de foto por persona y hora (en memoria de la instancia)
const ups = new Map();
function tooMany(uid) {
  const now = Date.now(), l = (ups.get(uid) || []).filter(t => now - t < 3600e3);
  l.push(now); ups.set(uid, l);
  if (ups.size > 2000) ups.delete(ups.keys().next().value);
  return l.length > 20;
}

export async function handleProfiles(request, env, path) {
  const db = env.DB;
  if (!db) return err(501, 'Los perfiles necesitan la base de datos de Cloudflare');
  await schema(db); await profileSchema(db);
  const me = await currentUser(request, db);
  if (!me) return err(401, 'Inicia sesión');
  const m = request.method;

  // ---- lo tuyo
  if (path === 'profile' && m === 'PUT') {
    let b = {};
    try { b = await request.json(); } catch (_) { return err(400, 'Datos no válidos'); }
    if (!b || typeof b !== 'object') return err(400, 'Datos no válidos');
    const out = { ok: true };
    if ('bio' in b) {
      const bio = out.bio = cleanBio(b.bio);
      await db.prepare('INSERT INTO profiles (user_id, bio, updated) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET bio = excluded.bio, updated = excluded.updated')
        .bind(me.id, bio ? await seal(env, me.id + ':bio', bio) : '', Date.now()).run();
    }
    if ('song' in b || 'share' in b || 'top' in b) {
      const row = await db.prepare('SELECT user_id, data FROM profile_prefs WHERE user_id = ?').bind(me.id).first();
      const p = await prefsOf(env, row);
      if ('song' in b) p.song = b.song ? cleanTrack(b.song) : null;
      if ('share' in b) { if (!SHARE.includes(b.share)) return err(400, 'Valor no válido'); p.share = b.share; }
      if ('top' in b) p.top = !!b.top;
      await db.prepare('INSERT INTO profile_prefs (user_id, data, updated) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated = excluded.updated')
        .bind(me.id, await seal(env, me.id + ':prefs', JSON.stringify({ song: p.song, share: p.share, top: p.top })), Date.now()).run();
      out.prefs = { song: p.song, share: p.share, top: p.top };
    }
    return json(200, out);
  }

  // ---- amigos: a quién sigues, con lo que escuchan (si lo comparten) y si tienen sala abierta
  if (path === 'friends' && m === 'GET') return json(200, await friends(env, db, me));
  if (path === 'profile/avatar' && m === 'PUT') {
    if (tooMany(me.id)) return err(429, 'Has cambiado la foto demasiadas veces; prueba dentro de un rato');
    const len = +request.headers.get('Content-Length') || 0;
    if (len > MAX_BYTES) return err(413, 'La imagen es demasiado grande (máximo 200 KB)');
    const bytes = new Uint8Array(await request.arrayBuffer());
    const c = checkImage(bytes);
    if (c.error) return err(400, c.error);
    const v = Date.now();
    await db.prepare('INSERT INTO profiles (user_id, avatar, avatar_type, avatar_v, updated) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET avatar = excluded.avatar, avatar_type = excluded.avatar_type, avatar_v = excluded.avatar_v, updated = excluded.updated')
      .bind(me.id, b64(bytes), c.type, v, v).run();
    return json(200, { ok: true, avatar: v });
  }
  if (path === 'profile/avatar' && m === 'DELETE') {
    await db.prepare('UPDATE profiles SET avatar = NULL, avatar_type = NULL, avatar_v = NULL, updated = ? WHERE user_id = ?').bind(Date.now(), me.id).run();
    return json(200, { ok: true });
  }

  // ---- el de cualquiera (por nombre)
  const mm = path.match(/^profile\/([^/]{1,40})(?:\/(avatar|follow|playlist\/([\w-]{1,40})))?$/);
  if (!mm) return err(404, 'api');
  const sub = mm[2] || '', isFollow = sub === 'follow';
  if (isFollow ? !['PUT', 'DELETE'].includes(m) : m !== 'GET') return err(405, 'Método no permitido');
  let name;
  try { name = decodeURIComponent(mm[1]); } catch (_) { return err(400, 'Nombre no válido'); }
  if (!USER_RE.test(name)) return err(404, 'No existe esa persona');
  const u = await db.prepare('SELECT u.id, u.username, u.created, p.bio, p.avatar_v, p.avatar_type' + (sub === 'avatar' ? ', p.avatar' : '') + ' FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.username = ?').bind(name).first();
  if (!u) return err(404, 'No existe esa persona');

  // seguir / dejar de seguir
  if (isFollow) {
    if (u.id === me.id) return err(400, 'No puedes seguirte a ti');
    if (m === 'PUT') {
      const n = await db.prepare('SELECT COUNT(*) AS n FROM follows WHERE user_id = ?').bind(me.id).first();
      if (n && n.n >= 500) return err(400, 'Sigues a demasiada gente (máximo 500)');
      await db.prepare('INSERT OR IGNORE INTO follows (user_id, target_id, created) VALUES (?, ?, ?)').bind(me.id, u.id, Date.now()).run();
    } else await db.prepare('DELETE FROM follows WHERE user_id = ? AND target_id = ?').bind(me.id, u.id).run();
    return json(200, { ok: true, following: m === 'PUT' });
  }

  // una lista pública de esa persona, con sus canciones
  if (sub.startsWith('playlist/')) {
    const pl = publicLists(await readData(env, db, u.id, 'playlists', [])).find(p => p.id === mm[3]);
    if (!pl) return err(404, 'Esa lista no existe o no es pública');
    return json(200, { id: pl.id, name: String(pl.name || '').slice(0, 100), owner: u.username, tracks: (pl.tracks || []).slice(0, 500).map(cleanTrack).filter(Boolean) });
  }

  if (sub === 'avatar') {
    if (!u.avatar || !/^image\/(webp|jpeg)$/.test(u.avatar_type || '')) return new Response(null, { status: 404, headers: { 'Cache-Control': 'private, max-age=300' } });
    const bytes = unb64(u.avatar);
    const fresh = new URL(request.url).searchParams.get('v') === String(u.avatar_v);
    return new Response(bytes, { status: 200, headers: {
      'Content-Type': u.avatar_type,
      'Content-Length': String(bytes.length),
      'Cache-Control': fresh ? 'private, max-age=31536000, immutable' : 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': 'inline; filename="avatar"',
      'Cross-Origin-Resource-Policy': 'same-origin'
    } });
  }
  let bio = '';
  if (u.bio) { try { bio = await open(env, u.id + ':bio', u.bio); } catch (_) { bio = ''; } }
  const base = { username: u.username, bio, avatar: u.avatar_v || null, since: u.created, me: u.id === me.id };
  if (!new URL(request.url).searchParams.get('full')) return json(200, base);
  return json(200, { ...base, ...(await fullProfile(env, db, me, u)) });
}

/* ---------------------------------------------------------------- perfil completo */
async function fullProfile(env, db, me, u) {
  const mine = u.id === me.id;
  await ensureApiSchema(db);
  const [rel, pref, pres] = await db.batch([
    db.prepare(`SELECT (SELECT COUNT(*) FROM follows WHERE target_id = ?1) AS followers, (SELECT COUNT(*) FROM follows WHERE user_id = ?1) AS following,
      (SELECT 1 FROM follows WHERE user_id = ?2 AND target_id = ?1) AS iFollow, (SELECT 1 FROM follows WHERE user_id = ?1 AND target_id = ?2) AS followsMe`).bind(u.id, me.id),
    db.prepare('SELECT user_id, data FROM profile_prefs WHERE user_id = ?').bind(u.id),
    db.prepare('SELECT user_id, state, updated FROM presence WHERE user_id = ?').bind(u.id)
  ]);
  const r = (rel.results || [])[0] || {};
  const prefs = await prefsOf(env, (pref.results || [])[0]);
  const friends = !!(r.iFollow && r.followsMe);
  const sees = mine || prefs.share === 'all' || (prefs.share === 'friends' && friends);
  const out = {
    followers: r.followers || 0, following: r.following || 0, iFollow: !!r.iFollow, followsMe: !!r.followsMe, friends,
    song: prefs.song || null, now: null, room: null, top: [], playlists: [], compat: null
  };
  if (mine) out.prefs = { share: prefs.share, top: prefs.top };
  if (sees) out.now = (await presenceOf(env, pres.results)).get(u.id) || null;
  // su sala abierta (solo para amigos, que así pueden entrar sin pedir el código)
  if (friends || mine) {
    try {
      const rm = await db.prepare('SELECT code, updated FROM rooms WHERE host_id = ? ORDER BY updated DESC LIMIT 1').bind(u.id).first();
      if (rm && Date.now() - rm.updated < ROOM_LIVE) out.room = rm.code;
    } catch (_) {}
  }
  const [theirStats, theirLists, myStats] = await Promise.all([
    readData(env, db, u.id, 'stats', { plays: {} }),
    readData(env, db, u.id, 'playlists', []),
    mine ? null : readData(env, db, me.id, 'stats', { plays: {} })
  ]);
  const theirs = artistWeights(theirStats);
  if (prefs.top || mine) out.top = theirs.slice(0, 6).map(({ name, artistId }) => ({ name, artistId }));
  out.playlists = publicLists(theirLists).map(p => {
    const t = (p.tracks || []).find(x => x && x.cover);
    return { id: String(p.id).slice(0, 40), name: String(p.name || '').slice(0, 100), total: (p.tracks || []).length, cover: t ? String(t.cover).slice(0, 500) : '' };
  });
  if (!mine) out.compat = compat(artistWeights(myStats), theirs);
  return out;
}

async function friends(env, db, me) {
  await ensureApiSchema(db);
  const [fl, back] = await db.batch([
    db.prepare(`SELECT u.id, u.username, p.avatar_v, (SELECT 1 FROM follows b WHERE b.user_id = u.id AND b.target_id = ?1) AS mutual
      FROM follows f JOIN users u ON u.id = f.target_id LEFT JOIN profiles p ON p.user_id = u.id WHERE f.user_id = ?1 ORDER BY f.created DESC LIMIT 200`).bind(me.id),
    // quien te sigue y tú aún no
    db.prepare(`SELECT u.username, p.avatar_v FROM follows f JOIN users u ON u.id = f.user_id LEFT JOIN profiles p ON p.user_id = u.id
      WHERE f.target_id = ?1 AND NOT EXISTS (SELECT 1 FROM follows b WHERE b.user_id = ?1 AND b.target_id = f.user_id) ORDER BY f.created DESC LIMIT 50`).bind(me.id)
  ]);
  const list = fl.results || [];
  const ids = list.map(x => x.id);
  let pres = new Map(), prefs = new Map(), rooms = new Map();
  if (ids.length) {
    const q = ids.map(() => '?').join(',');
    const [pr, pf] = await db.batch([
      db.prepare(`SELECT user_id, state, updated FROM presence WHERE user_id IN (${q})`).bind(...ids),
      db.prepare(`SELECT user_id, data FROM profile_prefs WHERE user_id IN (${q})`).bind(...ids)
    ]);
    pres = await presenceOf(env, pr.results);
    for (const row of pf.results || []) prefs.set(row.user_id, await prefsOf(env, row));
    try {   // la tabla de salas puede no existir aún
      const { results } = await db.prepare(`SELECT host_id, code FROM rooms WHERE host_id IN (${q}) AND updated > ?`).bind(...ids, Date.now() - ROOM_LIVE).all();
      (results || []).forEach(x => rooms.set(x.host_id, x.code));
    } catch (_) {}
  }
  const people = list.map(x => {
    const p = prefs.get(x.id) || DEF_PREFS, mutual = !!x.mutual;
    const sees = p.share === 'all' || (p.share === 'friends' && mutual);
    return { username: x.username, avatar: x.avatar_v || null, mutual, now: sees ? pres.get(x.id) || null : null, room: mutual ? rooms.get(x.id) || null : null };
  });
  // primero quien está escuchando algo
  people.sort((a, b) => (!!b.now - !!a.now) || (!!(b.now && b.now.playing) - !!(a.now && a.now.playing)));
  return { people, followers: (back.results || []).map(x => ({ username: x.username, avatar: x.avatar_v || null })) };
}
