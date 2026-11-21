/* worker.js — la app como Worker de Cloudflare.
   /api/auth/... y /api/data... son las cuentas de usuario (server/accounts.js, base de datos D1);
   /api/v1/... es la API pública con token (server/api.js);
   el resto de /api/... lo atiende el mismo intermediario que usa Cloudflare Pages (functions/api/[[path]].js);
   todo lo demás (index.html, *.js, iconos...) son archivos estáticos servidos por Cloudflare. */
import { onRequest } from './functions/api/[[path]].js';
import { handleAccounts, requireSession } from './server/accounts.js';
import { handleRooms } from './server/rooms.js';
import { handleApi } from './server/api.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const p = url.pathname.slice('/api/'.length);
      // API pública con token (v1) y lo que la app necesita para ella: tokens, qué suena, órdenes
      if (/^(v1|tokens|presence|remote)(\/|$)/.test(p)) return handleApi(request, env, p);
      // escuchar juntos (salas)
      if (/^room(\/|$)/.test(p)) {
        try { return await handleRooms(request, env, p); }
        catch (e) { return new Response(JSON.stringify({ error: 'Error del servidor: ' + (e && e.message || e) }), { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } }); }
      }
      // cuentas y datos de usuario (base de datos D1)
      if (/^(auth\/|data(\/|$))/.test(p)) {
        try { return await handleAccounts(request, env, p); }
        catch (e) { return new Response(JSON.stringify({ error: 'Error del servidor: ' + (e && e.message || e) }), { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } }); }
      }
      // todo lo demás (búsqueda, letras, Spotify, portadas) exige haber iniciado sesión
      try { const denied = await requireSession(request, env); if (denied) return denied; }
      catch (e) { return new Response(JSON.stringify({ error: 'Error del servidor: ' + (e && e.message || e) }), { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } }); }
      return onRequest({ request, params: { path: p.split('/') } });
    }
    return env.ASSETS.fetch(request);
  }
};
