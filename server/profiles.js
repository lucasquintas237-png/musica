/* server/profiles.js — perfiles: foto y descripción.
     GET    /api/profile/<nombre>          -> {username, bio, avatar (versión o null), since}
     GET    /api/profile/<nombre>/avatar   -> la foto (imagen)
     PUT    /api/profile                   -> {bio} cambia tu descripción
     PUT    /api/profile/avatar            -> cuerpo = la imagen (WebP o JPEG) cambia tu foto
     DELETE /api/profile/avatar            -> quita tu foto

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
import { schema, currentUser } from './accounts.js';
import { seal, open } from './crypto.js';

const MAX_BYTES = 200 * 1024, MAX_SIDE = 1024, BIO_MAX = 160;
const USER_RE = /^[a-z0-9_.-]{3,24}$/i;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const err = (status, msg) => json(status, { error: msg });

let ready = null;
function profileSchema(db) {
  if (!ready) ready = db.prepare('CREATE TABLE IF NOT EXISTS profiles (user_id INTEGER PRIMARY KEY, bio TEXT, avatar TEXT, avatar_type TEXT, avatar_v INTEGER, updated INTEGER NOT NULL)').run().catch(e => { ready = null; throw e; });
  return ready;
}

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
    const bio = cleanBio(b.bio);
    await db.prepare('INSERT INTO profiles (user_id, bio, updated) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET bio = excluded.bio, updated = excluded.updated')
      .bind(me.id, bio ? await seal(env, me.id + ':bio', bio) : '', Date.now()).run();
    return json(200, { ok: true, bio });
  }
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
  const mm = path.match(/^profile\/([^/]{1,40})(\/avatar)?$/);
  if (!mm || m !== 'GET') return err(404, 'api');
  let name;
  try { name = decodeURIComponent(mm[1]); } catch (_) { return err(400, 'Nombre no válido'); }
  if (!USER_RE.test(name)) return err(404, 'No existe esa persona');
  const u = await db.prepare('SELECT u.id, u.username, u.created, p.bio, p.avatar_v, p.avatar_type' + (mm[2] ? ', p.avatar' : '') + ' FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.username = ?').bind(name).first();
  if (!u) return err(404, 'No existe esa persona');

  if (mm[2]) {
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
  return json(200, { username: u.username, bio, avatar: u.avatar_v || null, since: u.created, me: u.id === me.id });
}
