'use strict';
/* share.js — compartir una lista con un enlace. La lista viaja dentro del propio enlace
   (comprimida con deflate y en base64url, tras "#lista="), así que no hace falta servidor:
   quien lo abre ve la lista y puede reproducirla o guardarla en sus listas. */
const Share = (() => {
  const toB64u = bytes => { let s = ''; bytes.forEach(b => { s += String.fromCharCode(b); }); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const fromB64u = s => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, c => c.charCodeAt(0)); };
  async function pipe(bytes, stream) {
    const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    return new Uint8Array(await out.arrayBuffer());
  }

  async function encode(name, tracks) {
    const data = { v: 1, n: name, t: tracks.slice(0, 300).map(t => [t.id || '', t.title || '', t.artist || '', t.dur || 0]) };
    const packed = await pipe(new TextEncoder().encode(JSON.stringify(data)), new CompressionStream('deflate-raw'));
    return location.origin + location.pathname + '#lista=' + toB64u(packed);
  }
  async function decode(code) {
    const raw = await pipe(fromB64u(code), new DecompressionStream('deflate-raw'));
    const d = JSON.parse(new TextDecoder().decode(raw));
    return {
      name: String(d.n || 'Lista compartida').slice(0, 120),
      tracks: (d.t || []).map(([id, title, artist, dur]) => ({
        id: /^[\w-]{11}$/.test(id) ? id : '', title: String(title || ''), artist: String(artist || ''), dur: +dur || 0,
        artistId: '', album: '', albumId: '', cover: /^[\w-]{11}$/.test(id) ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : ''
      })).filter(t => t.title)
    };
  }

  async function share(name, tracks) {
    if (!tracks.length) return toast('La lista está vacía');
    let url;
    try { url = await encode(name, tracks); } catch (_) { return toast('Este navegador no puede crear el enlace'); }
    if (navigator.share) {
      try { await navigator.share({ title: name, text: `Escucha mi lista «${name}»`, url }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(url); toast('Enlace copiado: compártelo con quien quieras'); }
    catch (_) { App.prompt('Copia este enlace', url, () => {}); }
  }

  function openShared(d) {
    App.openView(d.name, box => {
      box.appendChild(el(`<div class="hero"><img src="${esc(d.tracks[0] && d.tracks[0].cover || PLACEHOLDER)}" alt=""><div class="meta"><h1>${esc(d.name)}</h1><div class="muted">Lista compartida · ${d.tracks.length} canciones</div><div class="actions"></div></div></div>`));
      const a = $('.actions', box);
      const b1 = el(`<button class="btn">${icon('play')}Reproducir</button>`); b1.onclick = () => App.playList(d.tracks, 0, d.name);
      const b2 = el(`<button class="btn tonal">${icon('lib')}Guardar en mis listas</button>`);
      b2.onclick = () => { const pl = Library.createPlaylist(d.name, d.tracks, { source: 'compartida' }); toast(`Guardada «${pl.name}»`); b2.disabled = true; };
      a.append(b1, b2);
      box.appendChild(App.trackList(d.tracks, { from: d.name }));
    });
  }

  // al abrir un enlace con "#lista=" (si hay que iniciar sesión, espera a que se entre)
  async function checkHash() {
    const m = location.hash.match(/^#lista=([\w-]+)/);
    if (!m) return;
    if (document.body.classList.contains('gated')) return setTimeout(checkHash, 800);
    history.replaceState(null, '', location.pathname + location.search);
    try { openShared(await decode(m[1])); } catch (_) { toast('El enlace de la lista no es válido'); }
  }
  document.addEventListener('DOMContentLoaded', () => setTimeout(checkHash, 400), { once: true });
  addEventListener('hashchange', checkHash);

  return { share, encode, decode };
})();
window.Share = Share;
