/* functions/api/[[path]].js — intermediario de la app en Cloudflare Pages (hace lo mismo que
   serve.ps1 en el PC). El navegador no puede llamar directamente a estos servicios (CORS), así
   que la web llama a /api/... en su propio dominio y esta función reenvía la petición:
     POST /api/ytm/{search|next|browse|player|music/get_search_suggestions}  -> YouTube Music
     GET  /api/lrc/{get|search}?...                                          -> LRCLIB (letras)
     GET  /api/spotify/{playlist|album|track}/ID                             -> página embed de Spotify
     GET  /api/img?u=https://...                                             -> portadas (para leer sus colores)
     GET  /api/deezer/{search?q=|track/ID|preview?u=}                        -> Deezer (BPM y fragmentos de 30 s)
   Los archivos estáticos (index.html, *.js...) los sirve Cloudflare Pages directamente. */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const YTM_EP = /^(search|next|browse|player|music\/get_search_suggestions)$/;
const IMG_HOST = /(^|\.)(ytimg\.com|googleusercontent\.com|ggpht\.com|scdn\.co|spotifycdn\.com)$/;

const text = (status, body) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' } });

// Reenvía la respuesta tal cual, con la caché indicada (como hace serve.ps1)
async function pass(upstream, cache) {
  const r = await upstream;
  const h = new Headers();
  // páginas de otras webs (Apple, Spotify) se devuelven como texto: la app solo las lee, y así
  // nunca pueden ejecutarse como página dentro de nuestro dominio
  let type = r.headers.get('Content-Type') || 'application/octet-stream';
  if (/html|xml|javascript|svg/i.test(type)) type = 'text/plain; charset=utf-8';
  h.set('Content-Type', type);
  h.set('Content-Security-Policy', "default-src 'none'; sandbox");
  h.set('Cache-Control', r.ok ? cache : 'no-cache');
  let status = r.status;
  if (![200, 204, 400, 403, 404, 500].includes(status)) status = 502;
  return new Response(r.body, { status, headers: h });
}

export async function onRequest({ request, params }) {
  const url = new URL(request.url);
  const path = (Array.isArray(params.path) ? params.path : [params.path || '']).join('/');

  try {
    // --- YouTube Music (API interna youtubei) ---
    if (path.startsWith('ytm/')) {
      const ep = path.slice(4);
      if (!YTM_EP.test(ep)) return text(404, 'api');
      if (request.method !== 'POST') return text(405, 'POST');
      const body = await request.arrayBuffer();
      return pass(fetch(`https://music.youtube.com/youtubei/v1/${ep}?prettyPrint=false`, {
        method: 'POST', body,
        headers: {
          'Content-Type': 'application/json', 'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
          'Origin': 'https://music.youtube.com', 'Referer': 'https://music.youtube.com/',
          'X-Youtube-Client-Name': '67', 'X-Youtube-Client-Version': '1.20241106.01.00'
        }
      }), 'no-cache');
    }

    // --- Letras (LRCLIB) ---
    const lrc = path.match(/^lrc\/(get|search)$/);
    if (lrc) {
      return pass(fetch(`https://lrclib.net/api/${lrc[1]}${url.search}`, {
        headers: { 'Lrclib-Client': 'MusicaLocal/1.0 (Cloudflare Pages)', 'User-Agent': UA }
      }), 'public, max-age=86400');
    }

    // --- Deezer: búsqueda, datos de canción (BPM) y fragmentos de 30 s para medir el BPM ---
    if (path === 'deezer/search') {
      return pass(fetch(`https://api.deezer.com/search${url.search}`, { headers: { 'User-Agent': UA } }), 'public, max-age=86400');
    }
    const dz = path.match(/^deezer\/(track|playlist|album)\/(\d{1,15})(\/tracks)?$/);
    if (dz) return pass(fetch(`https://api.deezer.com/${dz[1]}/${dz[2]}${dz[3] || ''}${url.search}`, { headers: { 'User-Agent': UA } }), 'public, max-age=3600');
    // Apple Music: página pública de una lista o álbum (para importarla)
    if (path === 'apple') {
      let u;
      try { u = new URL(url.searchParams.get('u') || ''); } catch (_) { return text(400, 'url'); }
      if (u.protocol !== 'https:' || u.hostname !== 'music.apple.com') return text(400, 'url');
      return pass(fetch(u.href, { headers: { 'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9' } }), 'public, max-age=3600');
    }
    if (path === 'deezer/preview') {
      let u;
      try { u = new URL(url.searchParams.get('u') || ''); } catch (_) { return text(400, 'url'); }
      if (u.protocol !== 'https:' || !/(^|\.)dzcdn\.net$/.test(u.hostname)) return text(403, 'host');
      return pass(fetch(u.href, { headers: { 'User-Agent': UA } }), 'public, max-age=86400');
    }

    // --- Spotify (página embed pública de una lista, álbum o canción) ---
    const sp = path.match(/^spotify\/(playlist|album|track)\/([A-Za-z0-9]{10,40})$/);
    if (sp) {
      return pass(fetch(`https://open.spotify.com/embed/${sp[1]}/${sp[2]}`, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'es-ES,es;q=0.9' }
      }), 'public, max-age=600');
    }

    // --- Portadas (mismo origen para poder leer sus colores) ---
    if (path === 'img') {
      let u;
      try { u = new URL(url.searchParams.get('u') || ''); } catch (_) { return text(400, 'url'); }
      if (u.protocol !== 'https:') return text(400, 'url');
      if (!IMG_HOST.test(u.hostname)) return text(403, 'host');
      return pass(fetch(u.href, { headers: { 'User-Agent': UA }, cf: { cacheTtl: 604800, cacheEverything: true } }), 'public, max-age=604800');
    }

    return text(404, 'api');
  } catch (e) {
    console.error('proxy', path, e);
    return text(502, 'No se pudo conectar con el servicio');
  }
}
