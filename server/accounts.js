/* server/accounts.js — cuentas de usuario (solo nombre y contraseña) y sus datos, en Cloudflare D1.
     POST   /api/auth/register  {username, password}  -> crea la cuenta e inicia sesión
     POST   /api/auth/login     {username, password}  -> inicia sesión (cookie de sesión)
     POST   /api/auth/logout                          -> cierra la sesión
     POST   /api/auth/logout-all                      -> cierra la sesión en todos los dispositivos
     POST   /api/auth/password  {current, next}       -> cambia la contraseña (y cierra las demás sesiones)
     GET    /api/auth/me                              -> {username} o 401
     GET    /api/data                                 -> {data: {clave: valor}, updated: {clave: ms}}
     PUT    /api/data/<clave>   (JSON)                -> guarda esa clave para el usuario

   Seguridad:
   - Contraseñas: nunca se guardan; se guarda PBKDF2-SHA256 con sal aleatoria por usuario y, si el
     Worker tiene el secreto DATA_KEY, antes se les pasa un HMAC con una "pimienta" secreta (ver
     crypto.js). Las cuentas antiguas se pasan al formato nuevo solas al entrar.
   - Datos de cada cuenta: cifrados con AES-256-GCM (crypto.js) si hay DATA_KEY. Lo antiguo sin
     cifrar se cifra la próxima vez que se lee.
   - Sesiones: token aleatorio de 256 bits en una cookie HttpOnly, Secure, SameSite=Lax; en la
     base de datos solo está su SHA-256.
   - Límite de intentos: 8 contraseñas falladas por cuenta o 30 por conexión cada 15 min;
     5 cuentas nuevas por conexión cada hora. */
import { seal, open, pepper, isEncrypted, keys } from './crypto.js';

const COOKIE = 'ms_session';
const SESSION_DAYS = 180;
// Iteraciones de PBKDF2: el plan gratis de Workers da poco tiempo de CPU por petición; la
// pimienta secreta es lo que de verdad impide probar contraseñas si se filtrara la base de datos
const ITER = 10000;
const USER_RE = /^[a-z0-9_.-]{3,24}$/i;
const MIN_PASS = 8;
// claves que se guardan en la cuenta (el resto, como la cola o la pestaña, es de cada dispositivo)
const KEYS = new Set(['favs', 'playlists', 'history', 'stats', 'searchHist', 'settings', 'lyrOffsets', 'volume', 'shuffle', 'repeat', 'resolved', 'followed', 'seedSongs', 'onboarded', 'disliked']);
const MAX_VALUE = 900 * 1024;

const enc = new TextEncoder();
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
});
const err = (status, msg, headers) => json(status, { error: msg }, headers);
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const randHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

async function pbkdf2(password, saltHex, iter = ITER) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
}
function sameHash(a, b) {
  if (a.length !== b.length) return false;
  const x = enc.encode(a), y = enc.encode(b);
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(x, y);
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
// hash de una contraseña: "p1$<hex>" con pimienta si hay secreto; si no, el formato antiguo
async function hashPassword(env, password, salt) {
  const p = await pepper(env, password);
  return p ? 'p1$' + await pbkdf2(p, salt) : await pbkdf2(password, salt);
}
// comprueba la contraseña; dice además si conviene guardarla en el formato nuevo
async function checkPassword(env, password, u) {
  if (u.hash.startsWith('p1$')) {
    const p = await pepper(env, password);
    if (!p) throw new Error('Falta el secreto DATA_KEY en el servidor');
    return { ok: sameHash('p1$' + await pbkdf2(p, u.salt, u.iter), u.hash), upgrade: u.iter !== ITER };
  }
  const ok = sameHash(await pbkdf2(password, u.salt, u.iter), u.hash);
  return { ok, upgrade: ok && (!!(await keys(env)) || u.iter !== ITER) };
}

let ready = null;
export function schema(db) {
  if (!ready) {
    ready = db.batch([
      db.prepare('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, hash TEXT NOT NULL, salt TEXT NOT NULL, iter INTEGER NOT NULL, created INTEGER NOT NULL)'),
      db.prepare('CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL)'),
      db.prepare('CREATE TABLE IF NOT EXISTS userdata (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (user_id, key))'),
      db.prepare('CREATE TABLE IF NOT EXISTS auth_limits (k TEXT PRIMARY KEY, n INTEGER NOT NULL, t INTEGER NOT NULL)')
    ]).catch(e => { ready = null; throw e; });
  }
  return ready;
}

/* ---------------------------------------------------------------- límite de intentos */
const clientIp = request => request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'local';
async function blocked(db, k, max, win) {
  const r = await db.prepare('SELECT n, t FROM auth_limits WHERE k = ?').bind(k).first();
  if (!r || Date.now() - r.t > win) return 0;
  return r.n >= max ? Math.ceil((r.t + win - Date.now()) / 60000) : 0;
}
async function hit(db, k, win) {
  const now = Date.now();
  await db.prepare('INSERT INTO auth_limits (k, n, t) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = CASE WHEN ? - auth_limits.t > ? THEN 1 ELSE auth_limits.n + 1 END, t = CASE WHEN ? - auth_limits.t > ? THEN ? ELSE auth_limits.t END')
    .bind(k, now, now, win, now, win, now).run();
  if (Math.random() < .02) await db.prepare('DELETE FROM auth_limits WHERE t < ?').bind(now - 86400e3).run();
}
const clearHits = (db, k) => db.prepare('DELETE FROM auth_limits WHERE k = ?').bind(k).run();
const FAIL_WIN = 15 * 60e3, REG_WIN = 3600e3;

/* ---------------------------------------------------------------- sesiones */
function cookieOf(request) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([a-f0-9]{64})'));
  return m ? m[1] : '';
}
function setCookie(request, token, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

// sesiones ya comprobadas en esta instancia del Worker (evita consultar D1 en cada petición)
const seen = new Map();
const SEEN_MS = 30 * 1000;

export async function currentUser(request, db) {
  const t = cookieOf(request);
  if (!t) return null;
  const c = seen.get(t);
  if (c && c.until > Date.now()) return c.user;
  const row = await db.prepare('SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires > ?')
    .bind(await sha256(t), Date.now()).first();
  if (row) { seen.set(t, { user: row, until: Date.now() + SEEN_MS }); if (seen.size > 500) seen.delete(seen.keys().next().value); }
  else seen.delete(t);
  return row || null;
}

/* Para el resto de /api/ (búsqueda, letras, portadas...): devuelve null si hay sesión válida
   o la respuesta 401 que hay que enviar. Sin base de datos configurada no se exige nada. */
export async function requireSession(request, env) {
  if (!env.DB) return null;
  await schema(env.DB);
  if (await currentUser(request, env.DB)) return null;
  return err(401, 'Inicia sesión para usar la app');
}

async function startSession(request, db, user) {
  const token = randHex(32);
  const expires = Date.now() + SESSION_DAYS * 864e5;
  await db.prepare('INSERT INTO sessions (token, user_id, expires) VALUES (?, ?, ?)').bind(await sha256(token), user.id, expires).run();
  // limpieza ocasional de sesiones caducadas
  if (Math.random() < .05) await db.prepare('DELETE FROM sessions WHERE expires < ?').bind(Date.now()).run();
  return json(200, { username: user.username }, { 'Set-Cookie': setCookie(request, token, SESSION_DAYS * 86400) });
}

async function readBody(request) {
  try { return await request.json(); } catch (_) { return null; }
}

/* ---------------------------------------------------------------- datos de la cuenta (cifrados) */
const aad = (uid, key) => uid + ':' + key;
export async function readData(env, db, uid, key, def) {
  const r = await db.prepare('SELECT value FROM userdata WHERE user_id = ? AND key = ?').bind(uid, key).first();
  if (!r) return def;
  try { return JSON.parse(await open(env, aad(uid, key), r.value)); } catch (_) { return def; }
}
export async function writeData(env, db, uid, key, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.length > MAX_VALUE) throw Object.assign(new Error('Demasiados datos'), { status: 413 });
  const now = Date.now();
  await db.prepare('INSERT INTO userdata (user_id, key, value, updated) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated = excluded.updated')
    .bind(uid, key, await seal(env, aad(uid, key), text), now).run();
  return now;
}

export async function handleAccounts(request, env, path) {
  const db = env.DB;
  if (!db) return err(501, 'Las cuentas no están configuradas en este servidor');
  await schema(db);
  const m = request.method, ip = clientIp(request);

  if (path === 'auth/register' && m === 'POST') {
    const wait = await blocked(db, 'r:' + ip, 5, REG_WIN);
    if (wait) return err(429, `Demasiadas cuentas nuevas desde esta conexión. Prueba en ${wait} min`);
    const b = await readBody(request);
    const username = String(b && b.username || '').trim(), password = String(b && b.password || '');
    if (!USER_RE.test(username)) return err(400, 'El nombre debe tener de 3 a 24 caracteres: letras, números, punto, guion o guion bajo');
    if (password.length < MIN_PASS || password.length > 200) return err(400, `La contraseña debe tener al menos ${MIN_PASS} caracteres`);
    if (password.toLowerCase() === username.toLowerCase()) return err(400, 'La contraseña no puede ser tu nombre');
    const salt = randHex(16), hash = await hashPassword(env, password, salt);
    try {
      const r = await db.prepare('INSERT INTO users (username, hash, salt, iter, created) VALUES (?, ?, ?, ?, ?) RETURNING id, username')
        .bind(username, hash, salt, ITER, Date.now()).first();
      await hit(db, 'r:' + ip, REG_WIN);
      return startSession(request, db, r);
    } catch (e) {
      if (/UNIQUE/i.test(String(e && e.message))) return err(409, 'Ese nombre ya está en uso');
      throw e;
    }
  }

  if (path === 'auth/login' && m === 'POST') {
    const b = await readBody(request);
    const username = String(b && b.username || '').trim(), password = String(b && b.password || '');
    if (!username || !password || password.length > 200) return err(400, 'Escribe tu nombre y tu contraseña');
    const ku = 'u:' + username.toLowerCase(), ki = 'i:' + ip;
    const wait = Math.max(await blocked(db, ku, 8, FAIL_WIN), await blocked(db, ki, 30, FAIL_WIN));
    if (wait) return err(429, `Demasiados intentos. Espera ${wait} min y vuelve a probar`);
    const u = await db.prepare('SELECT id, username, hash, salt, iter FROM users WHERE username = ?').bind(username).first();
    // si el usuario no existe se calcula igualmente un hash para no delatarlo por el tiempo de respuesta
    const res = u ? await checkPassword(env, password, u) : (await pbkdf2(password, '00'.repeat(16)), { ok: false });
    if (!res.ok) {
      await hit(db, ku, FAIL_WIN); await hit(db, ki, FAIL_WIN);
      return err(401, 'Nombre o contraseña incorrectos');
    }
    await clearHits(db, ku);
    // cuentas antiguas: se guarda la contraseña en el formato nuevo (con pimienta, sal nueva)
    if (res.upgrade) {
      const salt = randHex(16);
      await db.prepare('UPDATE users SET hash = ?, salt = ?, iter = ? WHERE id = ?').bind(await hashPassword(env, password, salt), salt, ITER, u.id).run();
    }
    return startSession(request, db, u);
  }

  if (path === 'auth/logout' && m === 'POST') {
    const t = cookieOf(request);
    if (t) { seen.delete(t); await db.prepare('DELETE FROM sessions WHERE token = ?').bind(await sha256(t)).run(); }
    return json(200, { ok: true }, { 'Set-Cookie': setCookie(request, '', 0) });
  }

  const user = await currentUser(request, db);

  if (path === 'auth/me' && m === 'GET') return user ? json(200, { username: user.username, encrypted: !!(await keys(env)) }) : err(401, 'Sin sesión');

  if (!user) return err(401, 'Sin sesión');

  if (path === 'auth/logout-all' && m === 'POST') {
    await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run();
    seen.clear();
    return json(200, { ok: true }, { 'Set-Cookie': setCookie(request, '', 0) });
  }

  if (path === 'auth/password' && m === 'POST') {
    const ku = 'u:' + user.username.toLowerCase();
    const wait = await blocked(db, ku, 8, FAIL_WIN);
    if (wait) return err(429, `Demasiados intentos. Espera ${wait} min y vuelve a probar`);
    const b = await readBody(request);
    const cur = String(b && b.current || ''), next = String(b && b.next || '');
    if (next.length < MIN_PASS || next.length > 200) return err(400, `La contraseña nueva debe tener al menos ${MIN_PASS} caracteres`);
    if (next.toLowerCase() === user.username.toLowerCase()) return err(400, 'La contraseña no puede ser tu nombre');
    const u = await db.prepare('SELECT id, username, hash, salt, iter FROM users WHERE id = ?').bind(user.id).first();
    if (!(await checkPassword(env, cur, u)).ok) { await hit(db, ku, FAIL_WIN); return err(401, 'La contraseña actual no es correcta'); }
    const salt = randHex(16);
    const t = await sha256(cookieOf(request));
    await db.batch([
      db.prepare('UPDATE users SET hash = ?, salt = ?, iter = ? WHERE id = ?').bind(await hashPassword(env, next, salt), salt, ITER, user.id),
      // se cierran las demás sesiones (por si alguien más la conocía); esta sigue abierta
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').bind(user.id, t)
    ]);
    seen.clear();
    return json(200, { ok: true });
  }

  if (path === 'data' && m === 'GET') {
    const { results } = await db.prepare('SELECT key, value, updated FROM userdata WHERE user_id = ?').bind(user.id).all();
    const data = {}, updated = {}, migrate = [];
    const canSeal = !!(await keys(env));
    for (const r of results || []) {
      try {
        data[r.key] = JSON.parse(await open(env, aad(user.id, r.key), r.value));
        updated[r.key] = r.updated;
        // lo guardado antes de activar el cifrado se cifra ahora
        if (canSeal && !isEncrypted(r.value)) migrate.push(db.prepare('UPDATE userdata SET value = ? WHERE user_id = ? AND key = ? AND updated = ?').bind(await seal(env, aad(user.id, r.key), r.value), user.id, r.key, r.updated));
      } catch (_) {}
    }
    if (migrate.length) await db.batch(migrate);
    return json(200, { username: user.username, data, updated });
  }

  const dk = path.match(/^data\/([a-zA-Z]{1,32})$/);
  if (dk && m === 'PUT') {
    const key = dk[1];
    if (!KEYS.has(key)) return err(400, 'Clave no permitida');
    const body = await request.text();
    if (body.length > MAX_VALUE) return err(413, 'Demasiados datos');
    try { JSON.parse(body); } catch (_) { return err(400, 'JSON no válido'); }
    return json(200, { ok: true, updated: await writeData(env, db, user.id, key, body) });
  }

  return err(404, 'api');
}
