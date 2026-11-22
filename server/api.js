/* server/api.js — tokens personales y API pública (/api/v1) de cada cuenta.

   Desde la app (con la sesión iniciada):
     GET    /api/tokens                 -> tus tokens (sin el secreto)
     POST   /api/tokens {name, scope}   -> crea uno; el token completo solo se devuelve aquí
     DELETE /api/tokens/<id>            -> lo borra (deja de funcionar al momento)
     POST   /api/presence               -> la app cuenta qué suena {device, track, playing, pos, volume}
     GET    /api/remote?device=&since=  -> la app recoge las órdenes a distancia y qué datos cambió la API

   API pública: Authorization: Bearer ms_...   (ver GET /api/v1 para la lista)
   En la base de datos solo se guarda el SHA-256 de cada token. Permisos: "read" (leer) o
   "control" (leer, cambiar la biblioteca y manejar la reproducción). */
import { schema, currentUser, readData, writeData } from './accounts.js';
import { seal, open } from './crypto.js';
import * as Y from './ytm.js';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Max-Age': '86400' };
const json = (status, body, extra = {}) => new Response(JSON.stringify(body, null, 1), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } });
const err = (status, msg, extra) => json(status, { error: msg }, extra);
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const MAX_TOKENS = 10, MAX_VALUE = 900 * 1024;
const ONLINE = 150e3;          // una app que no da señales en 2,5 min se considera cerrada
const CMD_TTL = 60e3;          // las órdenes que nadie recoge en 1 min se descartan
const RATE = 120;              // peticiones por minuto y token

let ready = null;
function apiSchema(db) {
  if (!ready) {
    ready = db.batch([
      db.prepare('CREATE TABLE IF NOT EXISTS api_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, hint TEXT NOT NULL, scope TEXT NOT NULL, created INTEGER NOT NULL, last_used INTEGER)'),
      db.prepare('CREATE TABLE IF NOT EXISTS presence (user_id INTEGER PRIMARY KEY, device TEXT NOT NULL, state TEXT NOT NULL, updated INTEGER NOT NULL)'),
      db.prepare('CREATE TABLE IF NOT EXISTS remote_cmds (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, cmd TEXT NOT NULL, created INTEGER NOT NULL)')
    ]).catch(e => { ready = null; throw e; });
  }
  return ready;
}

const body = async request => { try { return await request.json(); } catch (_) { return {}; } };
const s = (v, n) => String(v == null ? '' : v).slice(0, n);
const isVid = id => /^[\w-]{11}$/.test(id || '');
function cleanTrack(t) {
  if (!t || typeof t !== 'object' || !isVid(t.id)) return null;
  return { id: t.id, title: s(t.title, 200), artist: s(t.artist, 200), artistId: s(t.artistId, 64), album: s(t.album, 200), albumId: s(t.albumId, 64), dur: +t.dur || 0, cover: s(t.cover, 500) };
}

/* ---------------------------------------------------------------- datos de la cuenta (cifrados, ver accounts.js) */
let ENV = null;   // el entorno de la petición en curso (para las claves de cifrado)
const getData = (db, uid, key, def) => readData(ENV, db, uid, key, def);
const setData = (db, uid, key, value) => writeData(ENV, db, uid, key, value);
// datos de una canción a partir de su id (si la API solo recibe el id)
async function trackOf(b) {
  const t = cleanTrack(b.track) || (isVid(b.id) ? cleanTrack(b) : null);
  if (t && t.title) return t;
  const id = (t && t.id) || b.id;
  if (!isVid(id)) return null;
  const list = await Y.radio(id).catch(() => []);
  return cleanTrack(list.find(x => x.id === id)) || { id, title: '', artist: '', artistId: '', album: '', albumId: '', dur: 0, cover: '' };
}

/* ---------------------------------------------------------------- qué suena */
async function nowPlaying(db, uid) {
  const r = await db.prepare('SELECT device, state, updated FROM presence WHERE user_id = ?').bind(uid).first();
  const now = Date.now();
  if (!r) return { online: false, playing: false, track: null };
  let st;
  try { st = JSON.parse(await open(ENV, uid + ':presence', r.state)); } catch (_) { return { online: false, playing: false, track: null }; }
  const online = !st.closed && now - r.updated < ONLINE;
  const playing = online && !!st.playing;
  let pos = +st.pos || 0;
  if (playing) pos += (now - (st.at || r.updated)) / 1000;
  if (st.track && st.track.dur) pos = Math.min(pos, st.track.dur);
  return { online, playing, track: st.track || null, position: Math.round(pos * 10) / 10, duration: (st.track && st.track.dur) || 0, volume: st.volume ?? null, shuffle: !!st.shuffle, repeat: st.repeat || 'off', device: st.deviceName || '', updated: r.updated };
}

/* ---------------------------------------------------------------- límite de peticiones */
const hits = new Map();
function limited(key) {
  const now = Date.now(), w = hits.get(key);
  if (!w || now - w.t > 60e3) { hits.set(key, { t: now, n: 1 }); if (hits.size > 2000) hits.delete(hits.keys().next().value); return 0; }
  w.n++;
  return w.n > RATE ? Math.ceil((w.t + 60e3 - now) / 1000) : 0;
}

/* ---------------------------------------------------------------- documentación */
const DOCS = {
  name: 'API de Música',
  auth: 'Cabecera Authorization: Bearer <tu token>. Los tokens se crean en Configuración → API.',
  limit: RATE + ' peticiones por minuto y token',
  read: {
    'GET /api/v1/me': 'tu cuenta y el permiso del token',
    'GET /api/v1/now': 'qué suena ahora (canción, posición, si está en pausa) en tu app abierta',
    'GET /api/v1/favorites': 'tus favoritas',
    'GET /api/v1/playlists': 'tus listas (sin canciones)',
    'GET /api/v1/playlists/<id>': 'una lista con sus canciones',
    'GET /api/v1/history?limit=50': 'lo último que has escuchado',
    'GET /api/v1/top?type=songs|artists&limit=20': 'lo que más escuchas (por tiempo)',
    'GET /api/v1/search?q=texto&type=songs|albums|artists|playlists': 'buscar en YouTube Music',
    'GET /api/v1/recommendations?id=<videoId>&limit=25': 'canciones parecidas a una canción'
  },
  control: {
    'POST /api/v1/favorites {id}': 'añadir a favoritas',
    'DELETE /api/v1/favorites/<id>': 'quitar de favoritas',
    'POST /api/v1/playlists {name, ids?: []}': 'crear una lista',
    'POST /api/v1/playlists/<id>/tracks {id}': 'añadir una canción a una lista',
    'DELETE /api/v1/playlists/<id>/tracks/<videoId>': 'quitarla de la lista',
    'POST /api/v1/player/play {id?, radio?: true}': 'reanudar, o poner una canción (y su radio detrás)',
    'POST /api/v1/player/pause': 'pausar',
    'POST /api/v1/player/toggle': 'pausar / reanudar',
    'POST /api/v1/player/next': 'siguiente',
    'POST /api/v1/player/previous': 'anterior',
    'POST /api/v1/player/seek {position}': 'ir a un segundo',
    'POST /api/v1/player/volume {volume}': 'volumen de 0 a 100',
    'POST /api/v1/queue {id, next?: true}': 'añadir a la cola (o que suene a continuación)'
  },
  note: 'El control de la reproducción y /now necesitan la app abierta en algún dispositivo con tu cuenta.'
};

/* ================================================================ API pública */
async function v1(request, db, path) {
  const m = request.method;
  if (m === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const H = CORS;
  if (path === 'v1' || path === 'v1/') return json(200, DOCS, H);

  const auth = (request.headers.get('Authorization') || '').match(/^Bearer\s+(ms_[a-f0-9]{40})$/i);
  if (!auth) return err(401, 'Falta el token: Authorization: Bearer ms_...', H);
  const tok = await db.prepare('SELECT t.id, t.scope, t.last_used, u.id AS uid, u.username FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.hash = ?').bind(await sha256(auth[1].toLowerCase())).first();
  if (!tok) return err(401, 'Token no válido o borrado', H);
  const wait = limited('t' + tok.id);
  if (wait) return err(429, 'Demasiadas peticiones; espera ' + wait + ' s', { ...H, 'Retry-After': String(wait) });
  if (!tok.last_used || Date.now() - tok.last_used > 300e3) await db.prepare('UPDATE api_tokens SET last_used = ? WHERE id = ?').bind(Date.now(), tok.id).run();

  const uid = tok.uid, url = new URL(request.url), q = k => url.searchParams.get(k) || '';
  const lim = (d, max) => Math.max(1, Math.min(max, parseInt(q('limit'), 10) || d));
  const p = path.slice(3);   // sin "v1/"
  const ok = b => json(200, b, H);

  // ---- leer
  if (m === 'GET') {
    if (p === 'me') return ok({ username: tok.username, scope: tok.scope });
    if (p === 'now') return ok(await nowPlaying(db, uid));
    if (p === 'favorites') { const f = await getData(db, uid, 'favs', []); return ok({ total: f.length, tracks: f }); }
    if (p === 'history') { const h = await getData(db, uid, 'history', []); return ok({ tracks: h.slice(0, lim(50, 100)) }); }
    if (p === 'playlists') return ok({ playlists: (await getData(db, uid, 'playlists', [])).map(x => ({ id: x.id, name: x.name, total: (x.tracks || []).length, created: x.created || null })) });
    const pl = p.match(/^playlists\/([\w-]{1,40})$/);
    if (pl) {
      const x = (await getData(db, uid, 'playlists', [])).find(y => y.id === pl[1]);
      return x ? ok({ id: x.id, name: x.name, tracks: x.tracks || [] }) : err(404, 'No existe esa lista', H);
    }
    if (p === 'top') {
      const st = await getData(db, uid, 'stats', { plays: {} });
      const plays = Object.values(st.plays || {}).filter(e => e && e.t);
      const n = lim(20, 100);
      if (q('type') === 'artists') {
        const by = new Map();
        plays.forEach(e => {
          const name = (e.t.artist || '').split(/,|&/)[0].trim();
          if (!name) return;
          const a = by.get(name) || { name, artistId: e.t.artistId || '', seconds: 0, plays: 0 };
          a.seconds += e.secs || 0; a.plays += e.n || 0; by.set(name, a);
        });
        return ok({ artists: [...by.values()].sort((a, b) => b.seconds - a.seconds).slice(0, n).map(a => ({ ...a, seconds: Math.round(a.seconds) })) });
      }
      return ok({ tracks: plays.sort((a, b) => (b.secs || 0) - (a.secs || 0)).slice(0, n).map(e => ({ ...e.t, plays: e.n || 0, seconds: Math.round(e.secs || 0) })) });
    }
    if (p === 'search') {
      if (!q('q').trim()) return err(400, 'Falta ?q=', H);
      return ok({ results: (await Y.search(q('q').slice(0, 200), q('type') || 'songs')).slice(0, lim(20, 50)) });
    }
    if (p === 'recommendations') {
      if (!isVid(q('id'))) return err(400, 'Falta ?id=<videoId de 11 caracteres>', H);
      return ok(await Y.recommend(q('id'), lim(25, 50)));
    }
    return err(404, 'No existe: GET /api/' + path + ' (mira GET /api/v1)', H);
  }

  // ---- cambiar: hace falta el permiso "control"
  if (tok.scope !== 'control') return err(403, 'Este token solo puede leer', H);
  const b = await body(request);

  if (p === 'favorites' && m === 'POST') {
    const t = await trackOf(b);
    if (!t) return err(400, 'Falta {id}', H);
    const f = await getData(db, uid, 'favs', []);
    if (f.some(x => x.id === t.id)) return ok({ ok: true, already: true, track: t });
    await setData(db, uid, 'favs', [t, ...f]);
    return ok({ ok: true, track: t });
  }
  const fd = p.match(/^favorites\/([\w-]{11})$/);
  if (fd && m === 'DELETE') {
    const f = await getData(db, uid, 'favs', []);
    const nf = f.filter(x => x.id !== fd[1]);
    if (nf.length === f.length) return err(404, 'No está en favoritas', H);
    await setData(db, uid, 'favs', nf);
    return ok({ ok: true });
  }
  if (p === 'playlists' && m === 'POST') {
    const name = s(b.name, 100).trim();
    if (!name) return err(400, 'Falta {name}', H);
    const ids = (Array.isArray(b.ids) ? b.ids : []).filter(isVid).slice(0, 50);
    const tracks = (await Promise.all(ids.map(id => trackOf({ id })))).filter(Boolean);
    const list = await getData(db, uid, 'playlists', []);
    const pl = { id: 'p' + Date.now().toString(36), name, tracks, created: Date.now() };
    await setData(db, uid, 'playlists', [pl, ...list]);
    return ok({ ok: true, playlist: { id: pl.id, name, total: tracks.length } });
  }
  const pt = p.match(/^playlists\/([\w-]{1,40})\/tracks(?:\/([\w-]{11}))?$/);
  if (pt) {
    const list = await getData(db, uid, 'playlists', []), pl = list.find(x => x.id === pt[1]);
    if (!pl) return err(404, 'No existe esa lista', H);
    pl.tracks = pl.tracks || [];
    if (m === 'POST' && !pt[2]) {
      const t = await trackOf(b);
      if (!t) return err(400, 'Falta {id}', H);
      if (pl.tracks.some(x => x.id === t.id)) return ok({ ok: true, already: true });
      pl.tracks.push(t);
    } else if (m === 'DELETE' && pt[2]) {
      const n = pl.tracks.length;
      pl.tracks = pl.tracks.filter(x => x.id !== pt[2]);
      if (pl.tracks.length === n) return err(404, 'Esa canción no está en la lista', H);
    } else return err(405, 'Método no permitido', H);
    await setData(db, uid, 'playlists', list);
    return ok({ ok: true, total: pl.tracks.length });
  }

  // ---- reproducción: se deja la orden y la recoge la app abierta
  const pc = p.match(/^player\/(play|pause|toggle|next|previous|seek|volume)$/);
  if ((pc || p === 'queue') && m === 'POST') {
    const np = await nowPlaying(db, uid);
    if (!np.online) return err(409, 'No hay ninguna app abierta con tu cuenta', H);
    let cmd;
    if (p === 'queue') {
      const t = await trackOf(b);
      if (!t) return err(400, 'Falta {id}', H);
      cmd = { type: b.next ? 'playNext' : 'queue', track: t };
    } else {
      const a = pc[1];
      if (a === 'play' && (b.id || b.track)) {
        const t = await trackOf(b);
        if (!t) return err(400, 'Id de canción no válido', H);
        cmd = { type: 'playTrack', track: t, radio: b.radio !== false };
      } else if (a === 'seek') {
        if (!(+b.position >= 0)) return err(400, 'Falta {position} en segundos', H);
        cmd = { type: 'seek', position: +b.position };
      } else if (a === 'volume') {
        if (!(+b.volume >= 0 && +b.volume <= 100)) return err(400, 'Falta {volume} de 0 a 100', H);
        cmd = { type: 'volume', volume: Math.round(+b.volume) };
      } else cmd = { type: a };
    }
    const n = await db.prepare('SELECT COUNT(*) AS n FROM remote_cmds WHERE user_id = ? AND created > ?').bind(uid, Date.now() - CMD_TTL).first();
    if (n && n.n >= 30) return err(429, 'Demasiadas órdenes pendientes', H);
    await db.prepare('INSERT INTO remote_cmds (user_id, cmd, created) VALUES (?, ?, ?)').bind(uid, JSON.stringify(cmd), Date.now()).run();
    return json(202, { ok: true, sent: cmd.type, note: 'La app la aplicará en unos segundos' }, H);
  }
  return err(404, 'No existe: ' + m + ' /api/' + path + ' (mira GET /api/v1)', H);
}

/* ================================================================ desde la app */
async function app(request, db, path) {
  const me = await currentUser(request, db);
  if (!me) return err(401, 'Sin sesión');
  const m = request.method;

  if (path === 'tokens' && m === 'GET') {
    const { results } = await db.prepare('SELECT id, name, hint, scope, created, last_used FROM api_tokens WHERE user_id = ? ORDER BY id DESC').bind(me.id).all();
    const tokens = [];
    for (const t of results || []) { try { t.name = await open(ENV, me.id + ':token', t.name); } catch (_) { t.name = 'Token'; } tokens.push(t); }
    return json(200, { tokens });
  }
  if (path === 'tokens' && m === 'POST') {
    const b = await body(request);
    const name = s(b.name, 60).trim() || 'Token';
    const scope = b.scope === 'control' ? 'control' : 'read';
    const n = await db.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?').bind(me.id).first();
    if (n && n.n >= MAX_TOKENS) return err(400, 'Como mucho ' + MAX_TOKENS + ' tokens; borra alguno');
    const token = 'ms_' + hex(crypto.getRandomValues(new Uint8Array(20)));
    const hint = token.slice(0, 7) + '…' + token.slice(-4);
    const r = await db.prepare('INSERT INTO api_tokens (user_id, name, hash, hint, scope, created) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
      .bind(me.id, await seal(ENV, me.id + ':token', name), await sha256(token), hint, scope, Date.now()).first();
    return json(200, { token, id: r.id, name, hint, scope });
  }
  const td = path.match(/^tokens\/(\d+)$/);
  if (td && m === 'DELETE') {
    await db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').bind(+td[1], me.id).run();
    return json(200, { ok: true });
  }

  if (path === 'presence' && m === 'POST') {
    const b = await body(request);
    const device = s(b.device, 40);
    if (!device) return err(400, 'Falta device');
    // si otra app está sonando ahora mismo, una que solo está abierta (en pausa) no le quita el sitio
    const cur = await db.prepare('SELECT device, state, updated FROM presence WHERE user_id = ?').bind(me.id).first();
    if (cur && cur.device !== device && !b.playing && Date.now() - cur.updated < ONLINE) {
      let cs = {};
      try { cs = JSON.parse(await open(ENV, me.id + ':presence', cur.state)); } catch (_) {}
      if (cs.playing && !cs.closed) return json(200, { ok: true, active: false });
    }
    if (b.closed && cur && cur.device !== device) return json(200, { ok: true, active: false });
    const state = { track: cleanTrack(b.track), playing: !!b.playing, pos: Math.max(0, +b.pos || 0), at: Date.now(), volume: b.volume == null ? null : +b.volume, shuffle: !!b.shuffle, repeat: s(b.repeat, 4), deviceName: s(b.deviceName, 40), closed: !!b.closed };
    await db.prepare('INSERT INTO presence (user_id, device, state, updated) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET device = excluded.device, state = excluded.state, updated = excluded.updated')
      .bind(me.id, device, await seal(ENV, me.id + ':presence', JSON.stringify(state)), Date.now()).run();
    return json(200, { ok: true, active: true });
  }

  if (path === 'remote' && m === 'GET') {
    const url = new URL(request.url), device = s(url.searchParams.get('device'), 40), since = +url.searchParams.get('since') || 0;
    const now = Date.now();
    const out = { now, cmds: [], changed: [] };
    // las órdenes son para la app que está "activa" (la última que contó qué suena)
    const pr = await db.prepare('SELECT device, updated FROM presence WHERE user_id = ?').bind(me.id).first();
    if (pr && pr.device === device) {
      const { results } = await db.prepare('SELECT id, cmd, created FROM remote_cmds WHERE user_id = ? ORDER BY id LIMIT 20').bind(me.id).all();
      if (results && results.length) {
        out.cmds = results.filter(r => now - r.created < CMD_TTL).map(r => JSON.parse(r.cmd));
        await db.prepare('DELETE FROM remote_cmds WHERE user_id = ? AND id <= ?').bind(me.id, results[results.length - 1].id).run();
      }
    }
    // datos de la cuenta que han cambiado desde fuera (otra app o la API)
    if (since) {
      const { results } = await db.prepare("SELECT key, updated FROM userdata WHERE user_id = ? AND updated > ? AND key IN ('favs','playlists','followed','disliked')").bind(me.id, since).all();
      out.changed = results || [];
    }
    return json(200, out);
  }
  return err(404, 'api');
}

export async function handleApi(request, env, path) {
  const db = env.DB;
  const v = /^v1(\/|$)/.test(path);
  if (!db) return v ? err(501, 'La API necesita la base de datos de Cloudflare', CORS) : err(501, 'Sin base de datos');
  try {
    ENV = env;
    await schema(db); await apiSchema(db);
    return v ? await v1(request, db, path) : await app(request, db, path);
  } catch (e) {
    if (e && e.status) return err(e.status, e.message, v ? CORS : {});
    console.error('api', e);
    return err(500, 'Error del servidor', v ? CORS : {});
  }
}
