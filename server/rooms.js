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
import { seal, open } from './crypto.js';

/* Cifrado: lo que suena, la cola, el chat y las reacciones se guardan cifrados (AES-256-GCM con
   DATA_KEY, ver crypto.js), cada dato ligado a su sala. Lo antiguo sin cifrar se sigue leyendo. */
let ENV = null, CTX = null;
// aviso en tiempo real a todos los conectados a la sala (si hay Durable Objects; si no, polling)
function notify(code, msg, opts = '') {
  if (!ENV || !ENV.ROOMS) return;
  const p = ENV.ROOMS.get(ENV.ROOMS.idFromName(code)).fetch('https://hub/broadcast' + opts, { method: 'POST', body: JSON.stringify(msg) }).catch(() => {});
  if (CTX && CTX.waitUntil) CTX.waitUntil(p);
}
const sealJ =(code, kind, obj) => seal(ENV, `room:${code}:${kind}`, JSON.stringify(obj));
async function openJ(code, kind, s, def = null) {
  try { return JSON.parse(await open(ENV, `room:${code}:${kind}`, s)); } catch (_) { return def; }
}

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
async function getConf(db, code) {
  const r = await db.prepare('SELECT conf FROM room_conf WHERE code = ?').bind(code).first();
  try { return { ...DEFAULT_CONF, ...(r ? JSON.parse(r.conf) : {}) }; } catch (_) { return { ...DEFAULT_CONF }; }
}
const canControl = async (db, code, me, hostId, conf) => me.id === hostId || conf.guestsControl || await isAdmin(db, code, me.id);
/* Un evento (reacción, mensaje, canción añadida): primero se reparte al momento por tiempo real
   y después se guarda (cifrado) para quien no tenga tiempo real. Lleva una marca única "n" para
   que nadie lo vea dos veces (por tiempo real y al consultar). */
async function event(db, code, me, kind, data) {
  const at = Date.now();
  data = { ...data, n: crypto.randomUUID().slice(0, 12) };
  notify(code, { t: 'event', e: { id: 0, by: me.username, kind, data, at } });
  const save = (async () => db.prepare('INSERT INTO room_events (code, user_name, kind, data, created) VALUES (?, ?, ?, ?, ?)').bind(code, me.username, kind, await sealJ(code, 'event', data), at).run())();
  if (CTX && CTX.waitUntil) CTX.waitUntil(save.catch(() => {})); else await save;
}
// límite de reacciones y mensajes (12 cada 10 s por persona), en memoria: no espera a la base de datos
const hits = new Map();
function tooFast(user) {
  const now = Date.now(), list = (hits.get(user) || []).filter(t => now - t < 10e3);
  list.push(now); hits.set(user, list);
  if (hits.size > 2000) hits.delete(hits.keys().next().value);
  return list.length > 12;
}
const dropRoom = (db, code) => db.batch(ROOM_TABLES.map(t => db.prepare(`DELETE FROM ${t} WHERE code = ?`).bind(code))
  .concat([db.prepare("DELETE FROM room_bans WHERE code = ? AND code <> ''").bind(code), db.prepare('DELETE FROM rooms WHERE code = ?').bind(code)]));

/* Vista de la sala: TODAS las consultas van en un solo viaje a la base de datos (db.batch). Antes
   eran una docena seguidas y, desde Cloudflare, cada consulta de la sala tardaba segundos, así que
   las reacciones y el chat llegaban tarde. "pre" son escrituras que van en el mismo viaje. */
async function roomView(db, code, me, since = -1, pre = []) {
  const now = Date.now();
  const st = [
    ...pre,
    db.prepare('SELECT code, host_id, host_name, state, v FROM rooms WHERE code = ?').bind(code),
    db.prepare('SELECT m.name, m.user_id, a.user_id AS adm FROM room_members m LEFT JOIN room_admins a ON a.code = m.code AND a.user_id = m.user_id WHERE m.code = ? AND m.seen > ? ORDER BY m.seen DESC').bind(code, now - ONLINE),
    db.prepare('SELECT conf FROM room_conf WHERE code = ?').bind(code),
    db.prepare('SELECT 1 AS x FROM room_admins WHERE code = ? AND user_id = ?').bind(code, me.id),
    db.prepare('SELECT id, user_id, user_name, track FROM room_queue WHERE code = ? ORDER BY id LIMIT ?').bind(code, MAX_QUEUE),
    db.prepare('SELECT MAX(id) AS id FROM room_events WHERE code = ?').bind(code),
    db.prepare("SELECT name, code FROM room_bans WHERE host_id = ? AND (code = ? OR code = '') ORDER BY created DESC").bind(me.id, code)
  ];
  // eventos (reacciones, chat, canciones añadidas): since = 'h' al entrar (el chat reciente);
  // un número, los nuevos desde ese evento (0 incluido: sala sin eventos aún)
  if (since === 'h') st.push(db.prepare("SELECT id, user_name, kind, data, created FROM (SELECT * FROM room_events WHERE code = ? AND kind = 'chat' ORDER BY id DESC LIMIT 30) ORDER BY id").bind(code));
  else if (since >= 0) st.push(db.prepare('SELECT id, user_name, kind, data, created FROM room_events WHERE code = ? AND id > ? AND created > ? ORDER BY id LIMIT 60').bind(code, since, now - 120e3));
  const res = await db.batch(st);
  const R = i => (res[pre.length + i] && res[pre.length + i].results) || [];
  const r = R(0)[0];
  if (!r) return null;
  const list = R(1);
  const isHost = r.host_id === me.id;
  let conf = { ...DEFAULT_CONF };
  try { if (R(2)[0]) conf = { ...conf, ...JSON.parse(R(2)[0].conf) }; } catch (_) {}
  const admin = !isHost && R(3).length > 0;
  const room = {
    code, host: r.host_name, isHost, isAdmin: admin, control: isHost || admin || conf.guestsControl, conf,
    v: r.v, state: await openJ(code, 'state', r.state, {}),
    members: list.map(m => m.name),
    people: list.map(m => ({ name: m.name, host: m.user_id === r.host_id, admin: !!m.adm, me: m.user_id === me.id }))
  };
  room.queue = [];
  for (const x of R(4)) { const t = await openJ(code, 'queue', x.track); if (t) room.queue.push({ qid: x.id, by: x.user_name, mine: x.user_id === me.id, track: t }); }
  if (since === 'h' || since >= 0) {
    room.events = [];
    for (const x of R(7)) { const d = await openJ(code, 'event', x.data); if (d) room.events.push({ id: x.id, by: x.user_name, kind: x.kind, data: d, at: x.created }); }
    room.lastEvent = (R(5)[0] && R(5)[0].id) || 0;
  }
  if (isHost) room.bans = R(6).map(x => ({ name: x.name, scope: x.code ? 'room' : 'all' }));
  return room;
}

const touchStmt = (db, code, me) => db.prepare('INSERT INTO room_members (code, user_id, name, seen) VALUES (?, ?, ?, ?) ON CONFLICT(code, user_id) DO UPDATE SET seen = excluded.seen, name = excluded.name')
  .bind(code, me.id, me.username, Date.now());
const touch = (db, code, me) => touchStmt(db, code, me).run();

async function addToQueue(db, code, me, track) {
  const t = cleanTrack(track);
  if (!t) return err(400, 'Canción no válida');
  const n = await db.prepare('SELECT COUNT(*) AS n FROM room_queue WHERE code = ?').bind(code).first();
  if (n && n.n >= MAX_QUEUE) return err(429, 'La cola de la sala está llena');
  await db.prepare('INSERT INTO room_queue (code, user_id, user_name, track, created) VALUES (?, ?, ?, ?, ?)').bind(code, me.id, me.username, await sealJ(code, 'queue', t), Date.now()).run();
  await event(db, code, me, 'add', { title: t.title, artist: t.artist });
  return null;
}

export async function handleRooms(request, env, path, ctx) {
  const db = env.DB;
  if (!db) return err(501, 'Las salas necesitan la base de datos de Cloudflare');
  ENV = env; CTX = ctx || null;
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
        await db.prepare('INSERT INTO rooms (code, host_id, host_name, state, v, updated) VALUES (?, ?, ?, ?, 1, ?)').bind(code, me.id, me.username, await sealJ(code, 'state', state), Date.now()).run();
        return json(200, { room: await roomView(db, code, me, 'h', [touchStmt(db, code, me)]), now: Date.now() });
      } catch (e) { if (!/UNIQUE/i.test(String(e && e.message))) throw e; }
    }
    return err(500, 'No se pudo crear la sala');
  }

  const mm = path.match(/^room\/([A-Z2-9]{6})(?:\/(join|state|suggest|leave|admin|ban|unban|queue|queue\/remove|queue\/pop|react|chat|conf|ws))?$/);
  if (!mm) return err(404, 'api');
  const code = mm[1], act = mm[2] || '';
  // la sala y si estás bloqueado, en una sola consulta
  // la sala, si estás bloqueado, sus ajustes y si eres administrador: todo en una sola consulta
  const r = await db.prepare(`SELECT host_id, v, state,
      (SELECT 1 FROM room_bans b WHERE b.host_id = rooms.host_id AND b.user_id = ? AND (b.code = rooms.code OR b.code = '')) AS banned,
      (SELECT conf FROM room_conf c WHERE c.code = rooms.code) AS conf,
      (SELECT 1 FROM room_admins a WHERE a.code = rooms.code AND a.user_id = ?) AS adm
    FROM rooms WHERE code = ?`).bind(me.id, me.id, code).first();
  if (!r) return err(404, 'Esa sala no existe o ya se cerró');
  const host = r.host_id === me.id;
  if (!host && act !== 'leave' && r.banned) {
    await db.prepare('DELETE FROM room_members WHERE code = ? AND user_id = ?').bind(code, me.id).run();
    return err(403, 'No puedes entrar en esta sala');
  }
  const view = async (since = -1, pre = []) => json(200, { room: await roomView(db, code, me, since, pre), now: Date.now() });

  // conexión en tiempo real: se abre el WebSocket con el Durable Object de la sala
  if (act === 'ws') {
    if (!env.ROOMS) return err(501, 'Sin tiempo real en este servidor');
    if (request.headers.get('Upgrade') !== 'websocket') return err(426, 'Se esperaba un WebSocket');
    const h = new Headers(request.headers);
    h.set('X-User', me.username);
    return env.ROOMS.get(env.ROOMS.idFromName(code)).fetch(new Request('https://hub/ws', { headers: h }));
  }

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
    // a quien se bloquea se le cierra la conexión (al volver a preguntar verá que no puede entrar)
    if (act === 'ban') notify(code, { t: 'refresh' }, '?user=' + encodeURIComponent(u.username) + '&close=1');
    notify(code, { t: 'refresh' });
    return view();
  }

  if (!act && m === 'GET') {
    const since = parseInt(new URL(request.url).searchParams.get('since'), 10);
    return view(Number.isFinite(since) && since >= 0 ? since : -1, [touchStmt(db, code, me)]);
  }
  if (act === 'join' && m === 'POST') { notify(code, { t: 'refresh' }); return view('h', [touchStmt(db, code, me)]); }
  if (m !== 'POST') return err(405, 'Método no permitido');
  let conf = { ...DEFAULT_CONF };
  try { if (r.conf) conf = { ...conf, ...JSON.parse(r.conf) }; } catch (_) {}
  // quién controla la música, sin más consultas
  const ctl = host || conf.guestsControl || !!r.adm;

  if (act === 'state') {
    if (!ctl) return err(403, 'Solo el anfitrión y los administradores controlan la música');
    const b = await body();
    // el latido periódico no pisa un cambio que aún no ha visto quien lo envía
    if (b.beat && +b.baseV !== r.v) return json(200, { ok: false, stale: true, v: r.v, now: Date.now() });
    const prev = await openJ(code, 'state', r.state, {});
    // "at" = instante (hora del servidor) en que quien manda midió la posición; si su reloj no
    // parece fiable, la hora de llegada
    const now = Date.now(), posAt = +b.posAt;
    const at = posAt && Math.abs(posAt - now) < 5000 ? Math.min(posAt, now) : now;
    const state = { track: b.track === undefined ? prev.track : cleanTrack(b.track), playing: !!b.playing, pos: Math.max(0, +b.pos || 0), at, by: me.username };
    // primero se reparte (al momento) y luego se guarda
    notify(code, { t: 'state', state, v: r.v + 1 });
    await db.batch([
      db.prepare('UPDATE rooms SET state = ?, v = v + 1, updated = ? WHERE code = ?').bind(await sealJ(code, 'state', state), now, code),
      touchStmt(db, code, me)
    ]);
    return json(200, { ok: true, v: r.v + 1, now: Date.now() });
  }
  // ---- cola compartida
  if (act === 'queue' || act === 'suggest') {
    if (!conf.guestsAdd && !ctl) return err(403, 'El anfitrión no deja añadir canciones');
    const e = await addToQueue(db, code, me, (await body()).track);
    if (!e) notify(code, { t: 'refresh' });
    return e || view();
  }
  if (act === 'queue/remove') {
    const b = await body();
    const row = await db.prepare('SELECT user_id FROM room_queue WHERE id = ? AND code = ?').bind(+b.qid || 0, code).first();
    if (!row) return view();
    if (row.user_id !== me.id && !ctl) return err(403, 'Solo puedes quitar tus canciones');
    await db.prepare('DELETE FROM room_queue WHERE id = ?').bind(+b.qid).run();
    notify(code, { t: 'refresh' });
    return view();
  }
  if (act === 'queue/pop') {
    if (!ctl) return err(403, 'Solo quien controla la música puede hacer esto');
    const row = await db.prepare('SELECT id, user_name, track FROM room_queue WHERE code = ? ORDER BY id LIMIT 1').bind(code).first();
    if (!row) return json(200, { track: null });
    await db.prepare('DELETE FROM room_queue WHERE id = ?').bind(row.id).run();
    notify(code, { t: 'refresh' });
    return json(200, { track: await openJ(code, 'queue', row.track), by: row.user_name });
  }
  // ---- reacciones y chat (con un límite para que nadie inunde la sala)
  if (act === 'react' || act === 'chat') {
    if (tooFast(me.id + ':' + code)) return err(429, 'Más despacio');
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
    notify(code, { t: 'refresh' });
    return view();
  }
  if (act === 'leave') {
    if (host) { await dropRoom(db, code); notify(code, { t: 'closed' }); }   // los bloqueos de "todas tus salas" se quedan
    else { await db.prepare('DELETE FROM room_members WHERE code = ? AND user_id = ?').bind(code, me.id).run(); notify(code, { t: 'refresh' }); }
    return json(200, { ok: true });
  }
  return err(405, 'Método no permitido');
}
