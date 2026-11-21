/* server/rooms.js — "Escuchar juntos": salas con código en Cloudflare D1.
   El anfitrión publica qué suena (canción, si está en pausa, posición y la hora del servidor);
   los invitados lo consultan cada pocos segundos y se sincronizan. Los invitados pueden proponer
   canciones, que el anfitrión recoge y añade a su cola.
     POST /api/room                    -> crea una sala (eres el anfitrión)          {code}
     POST /api/room/<code>/join        -> entrar                                       {room}
     GET  /api/room/<code>             -> estado, miembros y hora del servidor         {room, now}
     POST /api/room/<code>/state       -> (anfitrión) publica el estado {track, playing, pos}
     POST /api/room/<code>/suggest     -> (invitado) propone una canción {track}
     POST /api/room/<code>/leave       -> salir (si sale el anfitrión, la sala se cierra)
   Las salas sin actividad durante 6 horas se borran solas. */
import { schema, currentUser } from './accounts.js';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const err = (status, msg) => json(status, { error: msg });
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const IDLE = 6 * 3600e3, ONLINE = 15e3;

let ready = null;
function roomSchema(db) {
  if (!ready) {
    ready = db.batch([
      db.prepare('CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, host_id INTEGER NOT NULL, host_name TEXT NOT NULL, state TEXT NOT NULL, v INTEGER NOT NULL, updated INTEGER NOT NULL)'),
      db.prepare('CREATE TABLE IF NOT EXISTS room_members (code TEXT NOT NULL, user_id INTEGER NOT NULL, name TEXT NOT NULL, seen INTEGER NOT NULL, PRIMARY KEY (code, user_id))'),
      db.prepare('CREATE TABLE IF NOT EXISTS room_suggest (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, user_name TEXT NOT NULL, track TEXT NOT NULL, created INTEGER NOT NULL)')
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

async function roomView(db, code, me) {
  const r = await db.prepare('SELECT code, host_id, host_name, state, v, updated FROM rooms WHERE code = ?').bind(code).first();
  if (!r) return null;
  const now = Date.now();
  const { results } = await db.prepare('SELECT name, user_id, seen FROM room_members WHERE code = ? AND seen > ? ORDER BY seen DESC').bind(code, now - ONLINE).all();
  const room = { code, host: r.host_name, isHost: r.host_id === me.id, v: r.v, state: JSON.parse(r.state), members: (results || []).map(m => m.name) };
  // el anfitrión recoge (y se borran) las propuestas de los invitados
  if (room.isHost) {
    const sg = await db.prepare('SELECT id, user_name, track FROM room_suggest WHERE code = ? ORDER BY id LIMIT 20').bind(code).all();
    room.suggest = (sg.results || []).map(x => ({ by: x.user_name, track: JSON.parse(x.track) }));
    if (room.suggest.length) await db.prepare('DELETE FROM room_suggest WHERE code = ? AND id <= ?').bind(code, sg.results[sg.results.length - 1].id).run();
  }
  return room;
}

async function touch(db, code, me) {
  await db.prepare('INSERT INTO room_members (code, user_id, name, seen) VALUES (?, ?, ?, ?) ON CONFLICT(code, user_id) DO UPDATE SET seen = excluded.seen, name = excluded.name')
    .bind(code, me.id, me.username, Date.now()).run();
}

export async function handleRooms(request, env, path) {
  const db = env.DB;
  if (!db) return err(501, 'Las salas necesitan la base de datos de Cloudflare');
  await schema(db); await roomSchema(db);
  const me = await currentUser(request, db);
  if (!me) return err(401, 'Inicia sesión para escuchar juntos');
  const m = request.method;
  const body = async () => { try { return await request.json(); } catch (_) { return {}; } };

  // limpieza ocasional de salas abandonadas
  if (Math.random() < .05) {
    const old = Date.now() - IDLE;
    await db.batch([
      db.prepare('DELETE FROM room_members WHERE code IN (SELECT code FROM rooms WHERE updated < ?)').bind(old),
      db.prepare('DELETE FROM room_suggest WHERE code IN (SELECT code FROM rooms WHERE updated < ?)').bind(old),
      db.prepare('DELETE FROM rooms WHERE updated < ?').bind(old)
    ]);
  }

  if (path === 'room' && m === 'POST') {
    const b = await body();
    for (let tries = 0; tries < 5; tries++) {
      const code = Array.from(crypto.getRandomValues(new Uint8Array(6)), x => ALPHA[x % ALPHA.length]).join('');
      const state = { track: cleanTrack(b.track), playing: !!b.playing, pos: +b.pos || 0, at: Date.now() };
      try {
        await db.prepare('INSERT INTO rooms (code, host_id, host_name, state, v, updated) VALUES (?, ?, ?, ?, 1, ?)').bind(code, me.id, me.username, JSON.stringify(state), Date.now()).run();
        await touch(db, code, me);
        return json(200, { room: await roomView(db, code, me), now: Date.now() });
      } catch (e) { if (!/UNIQUE/i.test(String(e && e.message))) throw e; }
    }
    return err(500, 'No se pudo crear la sala');
  }

  const mm = path.match(/^room\/([A-Z2-9]{6})(?:\/(join|state|suggest|leave))?$/);
  if (!mm) return err(404, 'api');
  const code = mm[1], act = mm[2] || '';
  const r = await db.prepare('SELECT host_id, v, state FROM rooms WHERE code = ?').bind(code).first();
  if (!r) return err(404, 'Esa sala no existe o ya se cerró');

  if (!act && m === 'GET') {
    await touch(db, code, me);
    return json(200, { room: await roomView(db, code, me), now: Date.now() });
  }
  if (act === 'join' && m === 'POST') {
    await touch(db, code, me);
    return json(200, { room: await roomView(db, code, me), now: Date.now() });
  }
  if (act === 'state' && m === 'POST') {
    if (r.host_id !== me.id) return err(403, 'Solo el anfitrión controla la música');
    const b = await body();
    const prev = JSON.parse(r.state);
    const state = { track: b.track === undefined ? prev.track : cleanTrack(b.track), playing: !!b.playing, pos: Math.max(0, +b.pos || 0), at: Date.now() };
    await db.prepare('UPDATE rooms SET state = ?, v = v + 1, updated = ? WHERE code = ?').bind(JSON.stringify(state), Date.now(), code).run();
    await touch(db, code, me);
    return json(200, { ok: true, v: r.v + 1, now: Date.now() });
  }
  if (act === 'suggest' && m === 'POST') {
    const t = cleanTrack((await body()).track);
    if (!t) return err(400, 'Canción no válida');
    const n = await db.prepare('SELECT COUNT(*) AS n FROM room_suggest WHERE code = ?').bind(code).first();
    if (n && n.n >= 50) return err(429, 'Demasiadas propuestas pendientes');
    await db.prepare('INSERT INTO room_suggest (code, user_name, track, created) VALUES (?, ?, ?, ?)').bind(code, me.username, JSON.stringify(t), Date.now()).run();
    return json(200, { ok: true });
  }
  if (act === 'leave' && m === 'POST') {
    if (r.host_id === me.id) {
      await db.batch([
        db.prepare('DELETE FROM room_members WHERE code = ?').bind(code),
        db.prepare('DELETE FROM room_suggest WHERE code = ?').bind(code),
        db.prepare('DELETE FROM rooms WHERE code = ?').bind(code)
      ]);
    } else await db.prepare('DELETE FROM room_members WHERE code = ? AND user_id = ?').bind(code, me.id).run();
    return json(200, { ok: true });
  }
  return err(405, 'Método no permitido');
}
