/* server/crypto.js — cifrado de los datos de las cuentas y "pimienta" de las contraseñas.

   Todo sale de UN secreto del Worker, DATA_KEY, que se guarda en Cloudflare (Configuración del
   Worker → Variables y secretos), nunca en el código ni en la base de datos. De él se derivan
   (HKDF-SHA256) dos claves independientes:
     - AES-256-GCM para cifrar los datos de cada cuenta (favoritas, listas, historial, estadísticas,
       búsquedas, ajustes…) y lo que suena ahora. Cada valor lleva su propio vector aleatorio y va
       ligado a su usuario y su clave (AAD), así no se puede copiar el dato de una cuenta a otra.
     - HMAC-SHA256 como "pimienta" de las contraseñas: aunque alguien se llevara la base de
       datos, sin el secreto no podría probar contraseñas contra los hashes.
   Sin DATA_KEY la app sigue funcionando como antes (sin cifrar) para no dejar a nadie fuera.
   ¡No cambies ni borres DATA_KEY una vez puesto! Sin él no se pueden leer los datos cifrados ni
   entrar en las cuentas con contraseña protegida. */
const enc = new TextEncoder(), dec = new TextDecoder();
const PREFIX = 'e1:';
const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

let cache = { src: null, keys: null };
export async function keys(env) {
  const secret = env && env.DATA_KEY;
  if (!secret || String(secret).length < 16) return null;
  if (cache.src === secret) return cache.keys;
  const base = await crypto.subtle.importKey('raw', enc.encode(String(secret)), 'HKDF', false, ['deriveKey']);
  const derive = (info, alg, usages) => crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('musica/v1'), info: enc.encode(info) }, base, alg, false, usages);
  const k = {
    aes: await derive('datos', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
    pepper: await derive('contraseñas', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign'])
  };
  cache = { src: secret, keys: k };
  return k;
}

export const isEncrypted = v => typeof v === 'string' && v.startsWith(PREFIX);

// texto -> "e1:<base64(iv + cifrado)>"  (sin clave: se devuelve igual)
export async function seal(env, aad, text) {
  const k = await keys(env);
  if (!k) return text;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, k.aes, enc.encode(text)));
  const out = new Uint8Array(iv.length + ct.length); out.set(iv); out.set(ct, iv.length);
  return PREFIX + b64(out);
}
// al revés; los valores antiguos sin cifrar se devuelven tal cual
export async function open(env, aad, value) {
  if (!isEncrypted(value)) return value;
  const k = await keys(env);
  if (!k) throw new Error('Faltan las claves para leer los datos cifrados (DATA_KEY)');
  const raw = unb64(value.slice(PREFIX.length));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12), additionalData: enc.encode(aad) }, k.aes, raw.subarray(12));
  return dec.decode(pt);
}

// contraseña -> HMAC con la pimienta (hex); null si no hay secreto
export async function pepper(env, password) {
  const k = await keys(env);
  if (!k) return null;
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k.pepper, enc.encode(password)));
  return [...sig].map(b => b.toString(16).padStart(2, '0')).join('');
}
