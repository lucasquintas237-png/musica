/* worker.js — la app como Worker de Cloudflare.
   /api/auth/... y /api/data... son las cuentas de usuario (server/accounts.js, base de datos D1);
   /api/v1/... es la API pública con token (server/api.js);
   el resto de /api/... lo atiende el mismo intermediario que usa Cloudflare Pages (functions/api/[[path]].js);
   todo lo demás (index.html, *.js, iconos...) son archivos estáticos servidos por Cloudflare.

   Seguridad común a todo:
   - Cabeceras: política de contenido (CSP) que solo deja cargar scripts de la propia web y de
     YouTube, sin marcos de otras webs, sin "sniffing" de tipos, HSTS y permisos del navegador
     mínimos.
   - CSRF: las peticiones que cambian algo (POST/PUT/DELETE) con la cookie de sesión solo se
     aceptan si vienen de esta misma web (cabecera Origin). La API pública v1 usa token, no cookie.
   - Los errores internos no se envían al navegador (solo un mensaje genérico). */
import { onRequest } from './functions/api/[[path]].js';
import { handleAccounts, requireSession } from './server/accounts.js';
import { handleRooms } from './server/rooms.js';
import { handleApi } from './server/api.js';
import { handleProfiles } from './server/profiles.js';

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://www.youtube.com https://s.ytimg.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "connect-src 'self' wss://musica.lucasquintas237.workers.dev",
  "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups'
};
function secure(res, request, isPage) {
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY)) r.headers.set(k, v);
  if (new URL(request.url).protocol === 'https:') r.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (isPage) r.headers.set('Content-Security-Policy', CSP);
  return r;
}
const fail = (status, msg) => new Response(JSON.stringify({ error: msg }), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

async function api(request, env, p, ctx) {
  // API pública con token (v1): su propio control de acceso y CORS
  if (/^v1(\/|$)/.test(p)) return handleApi(request, env, p);
  // CSRF: lo que cambia algo con la cookie solo puede venir de esta web
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const origin = request.headers.get('Origin');
    if (origin && origin !== new URL(request.url).origin) return fail(403, 'Petición de otra web rechazada');
  }
  try {
    // la app con la API: tokens, qué suena, órdenes a distancia
    if (/^(tokens|presence|remote)(\/|$)/.test(p)) return await handleApi(request, env, p);
    // escuchar juntos (salas)
    if (/^room(\/|$)/.test(p)) return await handleRooms(request, env, p, ctx);
    // perfiles (foto y descripción)
    if (/^profile(\/|$)/.test(p)) return await handleProfiles(request, env, p);
    // cuentas y datos de usuario (base de datos D1)
    if (/^(auth\/|data(\/|$))/.test(p)) return await handleAccounts(request, env, p);
    // todo lo demás (búsqueda, letras, Spotify, portadas) exige haber iniciado sesión
    const denied = await requireSession(request, env);
    if (denied) return denied;
  } catch (e) {
    console.error('api', p, e);
    return fail(e && e.status || 500, e && e.status ? e.message : 'Error del servidor');
  }
  return onRequest({ request, params: { path: p.split('/') } });
}

// sala en tiempo real (un Durable Object por sala)
export { RoomHub } from './server/hub.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const res = await api(request, env, url.pathname.slice('/api/'.length), ctx);
      // la respuesta que abre un WebSocket se devuelve tal cual (copiarla rompería la conexión)
      return res.status === 101 ? res : secure(res, request, false);
    }
    const res = await env.ASSETS.fetch(request);
    return secure(res, request, (res.headers.get('Content-Type') || '').includes('text/html'));
  }
};
