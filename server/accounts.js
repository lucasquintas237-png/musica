/* server/accounts.js — cuentas de usuario (solo nombre y contraseña) y sus datos, en Cloudflare D1.
     POST   /api/auth/register  {username, password}  -> crea la cuenta e inicia sesión
     POST   /api/auth/login     {username, password}  -> inicia sesión (cookie de sesión)
     POST   /api/auth/logout                          -> cierra la sesión
     GET    /api/auth/me                              -> {username} o 401
     GET    /api/data                                 -> {data: {clave: valor}, updated: {clave: ms}}
     PUT    /api/data/<clave>   (JSON)                -> guarda esa clave para el usuario
   Las tablas se crean solas la primera vez. Las contraseñas se guardan con PBKDF2 + sal aleatoria;
   en la base de datos solo se guarda el hash de cada token de sesión. */

const COOKIE = 'ms_session';
const SESSION_DAYS = 180;
// Iteraciones de PBKDF2: el plan gratis de Workers permite poco tiempo de CPU por petición
const ITER = 10000;
const USER_RE = /^[a-z0-9_.-]{3,24}$/i;
// claves que se guardan en la cuenta (el resto, como la cola o la pestaña, es de cada dispositivo)
const KEYS = new Set(['favs', 'playlists', 'history', 'stats', 'searchHist', 'settings', 'lyrOffsets', 'volume', 'shuffle', 'repeat', 'resolved', 'followed', 'seedSongs', 'onboarded']);
const MAX_VALUE = 900 * 1024;

const enc = new TextEncoder();
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
});
const err = (status, msg) => json(status, { error: msg });
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

let ready = null;
export function schema(db) {
  if (!ready) {
    ready = db.batch([
      db.prepare('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, hash TEXT NOT NULL, salt TEXT NOT NULL, iter INTEGER NOT NULL, created INTEGER NOT NULL)'),
      db.prepare('CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL)'),
      db.prepare('CREATE TABLE IF NOT EXISTS userdata (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (user_id, key))')
    ]).catch(e => { ready = null; throw e; });
  }
  return ready;
}

function cookieOf(request) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([a-f0-9]{64})'));
  return m ? m[1] : '';
}
function setCookie(request, token, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

// sesiones ya comprobadas en esta instancia del Worker (evita consultar D1 en cada portada)
const seen = new Map();
const SEEN_MS = 60 * 1000;

export async function currentUser(request, db) {
  const t = cookieOf(request);
  if (!t) return null;
  const c = seen.get(t);
  if (c && c.until > Date.now()) return c.user;
  const row = await db.prepare('SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires > ?')
    .bind(await sha256(t), Date.now()).first();
  if (row) { seen.set(t, { user: row, until: Date.now() + SEEN_MS }); if (seen.size > 500) seen.delete(seen.keys().next().value); }
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

async function readCreds(request) {
  let b;
  try { b = await request.json(); } catch (_) { return null; }
  const username = String(b && b.username || '').trim(), password = String(b && b.password || '');
  return { username, password };
}

export async function handleAccounts(request, env, path) {
  const db = env.DB;
  if (!db) return err(501, 'Las cuentas no están configuradas en este servidor');
  await schema(db);
  const m = request.method;

  if (path === 'auth/register' && m === 'POST') {
    const c = await readCreds(request);
    if (!c) return err(400, 'Datos no válidos');
    if (!USER_RE.test(c.username)) return err(400, 'El nombre debe tener de 3 a 24 caracteres: letras, números, punto, guion o guion bajo');
    if (c.password.length < 6 || c.password.length > 200) return err(400, 'La contraseña debe tener al menos 6 caracteres');
    const salt = randHex(16), hash = await pbkdf2(c.password, salt);
    try {
      const r = await db.prepare('INSERT INTO users (username, hash, salt, iter, created) VALUES (?, ?, ?, ?, ?) RETURNING id, username')
        .bind(c.username, hash, salt, ITER, Date.now()).first();
      return startSession(request, db, r);
    } catch (e) {
      if (/UNIQUE/i.test(String(e && e.message))) return err(409, 'Ese nombre ya está en uso');
      throw e;
    }
  }

  if (path === 'auth/login' && m === 'POST') {
    const c = await readCreds(request);
    if (!c || !c.username || !c.password) return err(400, 'Escribe tu nombre y tu contraseña');
    const u = await db.prepare('SELECT id, username, hash, salt, iter FROM users WHERE username = ?').bind(c.username).first();
    // si el usuario no existe se calcula igualmente un hash para no delatarlo por el tiempo de respuesta
    const h = await pbkdf2(c.password, u ? u.salt : '00'.repeat(16), u ? u.iter : ITER);
    if (!u || !sameHash(h, u.hash)) return err(401, 'Nombre o contraseña incorrectos');
    return startSession(request, db, u);
  }

  if (path === 'auth/logout' && m === 'POST') {
    const t = cookieOf(request);
    if (t) { seen.delete(t); await db.prepare('DELETE FROM sessions WHERE token = ?').bind(await sha256(t)).run(); }
    return json(200, { ok: true }, { 'Set-Cookie': setCookie(request, '', 0) });
  }

  const user = await currentUser(request, db);

  if (path === 'auth/me' && m === 'GET') return user ? json(200, { username: user.username }) : err(401, 'Sin sesión');

  if (!user) return err(401, 'Sin sesión');

  if (path === 'data' && m === 'GET') {
    const { results } = await db.prepare('SELECT key, value, updated FROM userdata WHERE user_id = ?').bind(user.id).all();
    const data = {}, updated = {};
    (results || []).forEach(r => { try { data[r.key] = JSON.parse(r.value); updated[r.key] = r.updated; } catch (_) {} });
    return json(200, { username: user.username, data, updated });
  }

  const dk = path.match(/^data\/([a-zA-Z]{1,32})$/);
  if (dk && m === 'PUT') {
    const key = dk[1];
    if (!KEYS.has(key)) return err(400, 'Clave no permitida');
    const body = await request.text();
    if (body.length > MAX_VALUE) return err(413, 'Demasiados datos');
    try { JSON.parse(body); } catch (_) { return err(400, 'JSON no válido'); }
    const now = Date.now();
    await db.prepare('INSERT INTO userdata (user_id, key, value, updated) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated = excluded.updated')
      .bind(user.id, key, body, now).run();
    return json(200, { ok: true, updated: now });
  }

  return err(404, 'api');
}
