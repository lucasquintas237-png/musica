/* worker.js — la app como Worker de Cloudflare.
   /api/... lo atiende el mismo intermediario que usa Cloudflare Pages (functions/api/[[path]].js);
   todo lo demás (index.html, *.js, iconos...) son archivos estáticos servidos por Cloudflare. */
import { onRequest } from './functions/api/[[path]].js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const path = url.pathname.slice('/api/'.length).split('/');
      return onRequest({ request, params: { path } });
    }
    return env.ASSETS.fetch(request);
  }
};
