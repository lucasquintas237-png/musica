/* server/rooms.js — "Escuchar juntos": salas con código en Cloudflare D1, al estilo Jam.
   El anfitrión (y quien tenga permiso) publica qué suena; los demás lo consultan cada pocos segundos
   y se sincronizan. Hay una cola compartida que ve todo el mundo, reacciones y chat.
     POST /api/room                       -> crea una sala (eres el anfitrión)
     POST /api/room/<code>/join           -> entrar
     GET  /api/room/<code>?since=<id>     -> estado, personas, cola, ajustes y eventos nuevos (reacciones, chat)
     POST /api/room/<code>/state          -> (quien controla) publica el estado {track, playing, pos}
     POST /api/room/<code>/queue          -> añade una canción a la cola de la sala {track}
     POST /api/room/<code>/queue/remove   -> quita una canción {qid} (la tuya, o cualquiera si controlas)
     POST /api/room/<code>/queue/pop      -> (quien controla) saca la siguiente de la cola para ponerla
     POST /api/room/<code>/react          -> reacción con un emoji {emoji}
     POST /api/room/<code>/chat           -> mensaje {text}
     POST /api/room/<code>/conf           -> (anfitrión) {guestsAdd, guestsControl}
     POST /api/room/<code>/leave          -> salir (si sale el anfitrión, la sala se cierra)
     POST /api/room/<code>/admin|ban|unban-> (anfitrión) administradores y bloqueos {name, on|scope}
   Controlan la música el anfitrión, los administradores y, si el anfitrión lo permite, todos.
   El estado guarda quién hizo el último cambio y todos, también el anfitrión, se sincronizan con él.
   Las salas sin actividad durante 6 horas se borran solas. */
import { schema, currentUser } from './accounts.js';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const err = (status, msg) => json(status, { error: msg });
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const IDLE = 6 * 3600e3, ONLINE = 15e3;
const EMOJIS = ['🔥', '❤️', '😂', '🙌', '💃', '👏', '😍', '🤯'];
const MAX_QUEUE = 100;
const DEFAULT_CONF = { guestsAdd: true, guestsControl: false };
// todo lo que pertenece a una sala (se borra con ella)
const ROOM_TABLES = ['room_members', 'room_suggest', 'room_admins', 'room_queue', 'room_conf', 'room_events'];

let ready = null;
function roomSchema(db) {
  if (!ready) {
    ready = db.batch([
      db.prepare('CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, host_id INTEGER NOT NULL, host_name TEXT NOT NULL, state TEXT NOT NULL, v INTEGER NOT NULL, updated INTEGER NOT NULL)'),
      db.prepare('CREATE TABLE IF NOT EXISTS room_members (code TEXT NOT NULL, user_id INTEGER NOT NULL, name TEXT NOT NULL, seen INTEGER NOT NULL, PRIMARY KEY (code, user_id))'),
      db.prepare('CREATE TABLE IF NOT EXISTS room_suggest (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, user_name TEXT NOT NULL, track TEXT NOT NULL, created INTEGER NOT NULL)'),
      db.prepare('CREATE TABLE IF NOT EXISTS room_admins (code TEXT NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY (code, user_id))'),
      // code = '' : bloqueado en todas las salas de ese anfitrión
      db.prepare('CREATE TABLE IF NOT EXISTS room_bans (host_id INTEGER NOT NULL, user_id INTEGER NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (host_id, user_id, code))'),
      db.prepare('CREATE TABLE IF NOT EXISTS room_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, user_id INTEGER NOT NULL, user_name TEXT NOT NULL, track TEXT NOT NULL, created INTEGER NOT NULL)'),
      db.prepare('CREATE TABLE IF NOT EXISTS room_conf (code TEXT PRIMARY KEY, conf TEXT NOT NULL)'),
      db.prepare('CREATE TABLE IF NOT EXISTS room_events (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, user_name TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL)')
    ]).catch(e => { ready = null; throw e; });
  }
  return ready;
}

// solo los datos necesarios de una canción (y con límites de tamaño)
function cleanTrack(t) {
  if (!t || typeof t !== 'object' || !/^[\w-]{11}$/.test(t.id || '')) return null;
  const s = (v, n) => String(v || '').slice(0, n);
  return { id: t.id, title: s(t.title, 200), artist: s(t.artist, 200), album: s(t.album, 200), artistId: s(t.artistId, 64), albumId: s(t.albumId, 64), cover: s(t.cover, 500), dur: +t.dur || 0, atv: true };
}

const isAdmin = async (db, code, uid) => !!(await db.prepare('SELECT 1 AS x FROM room_admins WHERE code = ? AND user_id = ?').bind(code, uid).first());
const isBanned = async (db, hostId, code, uid) => !!(await db.prepare("SELECT 1 AS x FROM room_bans WHERE host_id = ? AND user_id = ? AND (code = ? OR code = '')").bind(hostId, uid, code).first());
async function getConf(db, code) {
  const r = await db.prepare('SELECT conf FROM room_conf WHERE code = ?').bind(code).first();
  try { return { ...DEFAULT_CONF, ...(r ? JSON.parse(r.conf) : {}) }; } catch (_) { return { ...DEFAULT_CONF }; }
}
const canControl = async (db, code, me, hostId, conf) => me.id === hostId || conf.guestsControl || await isAdmin(db, code, me.id);
const event = (db, code, me, kind, data) => db.prepare('INSERT INTO room_events (code, user_name, kind, data, created) VALUES (?, ?, ?, ?, ?)').bind(code, me.username, kind, JSON.stringify(data), Date.now()).run();
const dropRoom = (db, code) => db.batch(ROOM_TABLES.map(t => db.prepare(`DELETE FROM ${t} WHERE code = ?`).bind(code))
  .concat([db.prepare("DELETE FROM room_bans WHERE code = ? AND code <> ''").bind(code), db.prepare('DELETE FROM rooms WHERE code = ?').bind(code)]));

async function roomView(db, code, me, since = -1) {
  const r = await db.prepare('SELECT code, host_id, host_name, state, v, updated FROM rooms WHERE code = ?').bind(code).first();
  if (!r) return null;
  const now = Date.now();
  const { results } = await db.prepare('SELECT m.name, m.user_id, m.seen, a.user_id AS adm FROM room_members m LEFT JOIN room_admins a ON a.code = m.code AND a.user_id = m.user_id WHERE m.code = ? AND m.seen > ? ORDER BY m.seen DESC').bind(code, now - ONLINE).all();
  const list = results || [];
  const isHost = r.host_id === me.id;
  const conf = await getConf(db, code);
  const admin = !isHost && await isAdmin(db, code, me.id);
  const room = {
    code, host: r.host_name, isHost, isAdmin: admin, control: isHost || admin || conf.guestsControl, conf,
    v: r.v, state: JSON.parse(r.state),
    members: list.map(m => m.name),
    people: list.map(m => ({ name: m.name, host: m.user_id === r.host_id, admin: !!m.adm, me: m.user_id === me.id }))
  };
  // cola compartida
  const q = await db.prepare('SELECT id, user_id, user_name, track FROM room_queue WHERE code = ? ORDER BY id LIMIT ?').bind(code, MAX_QUEUE).all();
  room.queue = (q.results || []).map(x => ({ qid: x.id, by: x.user_name, mine: x.user_id === me.id, track: JSON.parse(x.track) }));
  // eventos (reacciones, chat, canciones añadidas): los nuevos desde "since"; al entrar, el chat reciente
  if (since >= 0) {
    const ev = since === 0
      ? await db.prepare("SELECT id, user_name, kind, data, created FROM (SELECT * FROM room_events WHERE code = ? AND kind = 'chat' ORDER BY id DESC LIMIT 30) ORDER BY id").bind(code).all()
      : await db.prepare('SELECT id, user_name, kind, data, created FROM room_events WHERE code = ? AND id > ? AND created > ? ORDER BY id LIMIT 60').bind(code, since, now - 120e3).all();
    room.events = (ev.results || []).map(x => ({ id: x.id, by: x.user_name, kind: x.kind, data: JSON.parse(x.data), at: x.created }));
    const last = await db.prepare('SELECT MAX(id) AS id FROM room_events WHERE code = ?').bind(code).first();
    room.lastEvent = (last && last.id) || 0;
  }
  if (isHost) {
    const b = await db.prepare("SELECT name, code FROM room_bans WHERE host_id = ? AND (code = ? OR code = '') ORDER BY created DESC").bind(me.id, code).all();
    room.bans = (b.results || []).map(x => ({ name: x.name, scope: x.code ? 'room' : 'all' }));
  }
  return room;
}

async function touch(db, code, me) {
  await db.prepare('INSERT INTO room_members (code, user_id, name, seen) VALUES (?, ?, ?, ?) ON CONFLICT(code, user_id) DO UPDATE SET seen = excluded.seen, name = excluded.name')
    .bind(code, me.id, me.username, Date.now()).run();
}

async function addToQueue(db, code, me, track) {
  const t = cleanTrack(track);
  if (!t) return err(400, 'Canción no válida');
  const n = await db.prepare('SELECT COUNT(*) AS n FROM room_queue WHERE code = ?').bind(code).first();
  if (n && n.n >= MAX_QUEUE) return err(429, 'La cola de la sala está llena');
  await db.prepare('INSERT INTO room_queue (code, user_id, user_name, track, created) VALUES (?, ?, ?, ?, ?)').bind(code, me.id, me.username, JSON.stringify(t), Date.now()).run();
  await event(db, code, me, 'add', { title: t.title, artist: t.artist });
  return null;
}

export async function handleRooms(request, env, path) {
  const db = env.DB;
  if (!db) return err(501, 'Las salas necesitan la base de datos de Cloudflare');
  await schema(db); await roomSchema(db);
  const me = await currentUser(request, db);
  if (!me) return err(401, 'Inicia sesión para escuchar juntos');
  const m = request.method;
  const body = async () => { try { return await request.json(); } catch (_) { return {}; } };

  // limpieza ocasional de salas abandonadas y de eventos viejos
  if (Math.random() < .05) {
    const old = Date.now() - IDLE;
    const stale = await db.prepare('SELECT code FROM rooms WHERE updated < ?').bind(old).all();
    for (const s of stale.results || []) await dropRoom(db, s.code);
    await db.prepare('DELETE FROM room_events WHERE created < ? AND kind <> ?').bind(Date.now() - 600e3, 'chat').run();
  }

  if (path === 'room' && m === 'POST') {
    const b = await body();
    // una sala por anfitrión: al crear otra se cierran las anteriores (evita llenar la base de datos)
    const old = await db.prepare('SELECT code FROM rooms WHERE host_id = ?').bind(me.id).all();
    for (const o of old.results || []) await dropRoom(db, o.code);
    for (let tries = 0; tries < 5; tries++) {
      const code = Array.from(crypto.getRandomValues(new Uint8Array(6)), x => ALPHA[x % ALPHA.length]).join('');
      const state = { track: cleanTrack(b.track), playing: !!b.playing, pos: +b.pos || 0, at: Date.now() };
      try {
        await db.prepare('INSERT INTO rooms (code, host_id, host_name, state, v, updated) VALUES (?, ?, ?, ?, 1, ?)').bind(code, me.id, me.username, JSON.stringify(state), Date.now()).run();
        await touch(db, code, me);
        return json(200, { room: await roomView(db, code, me, 0), now: Date.now() });
      } catch (e) { if (!/UNIQUE/i.test(String(e && e.message))) throw e; }
    }
    return err(500, 'No se pudo crear la sala');
  }

  const mm = path.match(/^room\/([A-Z2-9]{6})(?:\/(join|state|suggest|leave|admin|ban|unban|queue|queue\/remove|queue\/pop|react|chat|conf))?$/);
  if (!mm) return err(404, 'api');
  const code = mm[1], act = mm[2] || '';
  const r = await db.prepare('SELECT host_id, v, state FROM rooms WHERE code = ?').bind(code).first();
  if (!r) return err(404, 'Esa sala no existe o ya se cerró');
  const host = r.host_id === me.id;
  if (!host && act !== 'leave' && await isBanned(db, r.host_id, code, me.id)) {
    await db.prepare('DELETE FROM room_members WHERE code = ? AND user_id = ?').bind(code, me.id).run();
    return err(403, 'No puedes entrar en esta sala');
  }
  const view = async (since = -1) => json(200, { room: await roomView(db, code, me, since), now: Date.now() });

  // ---- anfitrión: administradores y bloqueos (por nombre de usuario)
  if (act === 'admin' || act === 'ban' || act === 'unban') {
    if (m !== 'POST') return err(405, 'Método no permitido');
    if (!host) return err(403, 'Solo el anfitrión puede hacer esto');
    const b = await body();
    const u = await db.prepare('SELECT id, username FROM users WHERE username = ?').bind(String(b.name || '').slice(0, 40)).first();
    if (!u) return err(404, 'No existe esa persona');
    if (u.id === me.id) return err(400, 'No puedes hacerte esto a ti mismo');
    const scopeCode = b.scope === 'all' ? '' : code;
    if (act === 'admin') {
      if (b.on === false) await db.prepare('DELETE FROM room_admins WHERE code = ? AND user_id = ?').bind(code, u.id).run();
      else await db.prepare('INSERT OR IGNORE INTO room_admins (code, user_id) VALUES (?, ?)').bind(code, u.id).run();
    } else if (act === 'ban') {
      await db.batch([
        db.prepare('INSERT OR REPLACE INTO room_bans (host_id, user_id, code, name, created) VALUES (?, ?, ?, ?, ?)').bind(me.id, u.id, scopeCode, u.username, Date.now()),
        db.prepare('DELETE FROM room_admins WHERE code = ? AND user_id = ?').bind(code, u.id),
        db.prepare('DELETE FROM room_members WHERE code = ? AND user_id = ?').bind(code, u.id),
        db.prepare('DELETE FROM room_queue WHERE code = ? AND user_id = ?').bind(code, u.id)
      ]);
    } else {
      await db.prepare('DELETE FROM room_bans WHERE host_id = ? AND user_id = ? AND code = ?').bind(me.id, u.id, scopeCode).run();
    }
    return view();
  }

  if (!act && m === 'GET') {
    await touch(db, code, me);
    const since = parseInt(new URL(request.url).searchParams.get('since'), 10);
    return view(Number.isFinite(since) && since >= 0 ? since : -1);
  }
  if (act === 'join' && m === 'POST') {
    await touch(db, code, me);
    return view(0);
  }
  if (m !== 'POST') return err(405, 'Método no permitido');
  const conf = await getConf(db, code);

  if (act === 'state') {
    if (!await canControl(db, code, me, r.host_id, conf)) return err(403, 'Solo el anfitrión y los administradores controlan la música');
    const b = await body();
    // el latido periódico no pisa un cambio que aún no ha visto quien lo envía
    if (b.beat && +b.baseV !== r.v) return json(200, { ok: false, stale: true, v: r.v, now: Date.now() });
    const prev = JSON.parse(r.state);
    const state = { track: b.track === undefined ? prev.track : cleanTrack(b.track), playing: !!b.playing, pos: Math.max(0, +b.pos || 0), at: Date.now(), by: me.username };
    await db.prepare('UPDATE rooms SET state = ?, v = v + 1, updated = ? WHERE code = ?').bind(JSON.stringify(state), Date.now(), code).run();
    await touch(db, code, me);
    return json(200, { ok: true, v: r.v + 1, now: Date.now() });
  }
  // ---- cola compartida
  if (act === 'queue' || act === 'suggest') {
    if (!conf.guestsAdd && !await canControl(db, code, me, r.host_id, conf)) return err(403, 'El anfitrión no deja añadir canciones');
    const e = await addToQueue(db, code, me, (await body()).track);
    return e || view();
  }
  if (act === 'queue/remove') {
    const b = await body();
    const row = await db.prepare('SELECT user_id FROM room_queue WHERE id = ? AND code = ?').bind(+b.qid || 0, code).first();
    if (!row) return view();
    if (row.user_id !== me.id && !await canControl(db, code, me, r.host_id, conf)) return err(403, 'Solo puedes quitar tus canciones');
    await db.prepare('DELETE FROM room_queue WHERE id = ?').bind(+b.qid).run();
    return view();
  }
  if (act === 'queue/pop') {
    if (!await canControl(db, code, me, r.host_id, conf)) return err(403, 'Solo quien controla la música puede hacer esto');
    const row = await db.prepare('SELECT id, user_name, track FROM room_queue WHERE code = ? ORDER BY id LIMIT 1').bind(code).first();
    if (!row) return json(200, { track: null });
    await db.prepare('DELETE FROM room_queue WHERE id = ?').bind(row.id).run();
    return json(200, { track: JSON.parse(row.track), by: row.user_name });
  }
  // ---- reacciones y chat (con un límite para que nadie inunde la sala)
  if (act === 'react' || act === 'chat') {
    const n = await db.prepare('SELECT COUNT(*) AS n FROM room_events WHERE code = ? AND user_name = ? AND created > ?').bind(code, me.username, Date.now() - 10e3).first();
    if (n && n.n >= 12) return err(429, 'Más despacio');
    const b = await body();
    if (act === 'react') {
      if (!EMOJIS.includes(b.emoji)) return err(400, 'Reacción no válida');
      await event(db, code, me, 'react', { emoji: b.emoji });
    } else {
      const text = String(b.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!text) return err(400, 'Mensaje vacío');
      await event(db, code, me, 'chat', { text });
    }
    return json(200, { ok: true });
  }
  if (act === 'conf') {
    if (!host) return err(403, 'Solo el anfitrión puede hacer esto');
    const b = await body();
    const next = { guestsAdd: b.guestsAdd === undefined ? conf.guestsAdd : !!b.guestsAdd, guestsControl: b.guestsControl === undefined ? conf.guestsControl : !!b.guestsControl };
    await db.prepare('INSERT INTO room_conf (code, conf) VALUES (?, ?) ON CONFLICT(code) DO UPDATE SET conf = excluded.conf').bind(code, JSON.stringify(next)).run();
    return view();
  }
  if (act === 'leave') {
    if (host) await dropRoom(db, code);   // los bloqueos de "todas tus salas" se quedan
    else await db.prepare('DELETE FROM room_members WHERE code = ? AND user_id = ?').bind(code, me.id).run();
    return json(200, { ok: true });
  }
  return err(405, 'Método no permitido');
}
