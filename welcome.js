'use strict';
/* welcome.js — bienvenida para quien empieza: elegir artistas favoritos para que el inicio salga
   personalizado desde el primer día. Los elegidos se siguen y sus canciones más populares sirven
   de semilla para las recomendaciones (pesan menos a medida que crece el historial). */
const Welcome = (() => {
  const POPULAR = ['Bad Bunny', 'ROSALÍA', 'Quevedo', 'KAROL G', 'Feid', 'Bizarrap', 'Shakira', 'Rauw Alejandro', 'Peso Pluma', 'Aitana',
    'Myke Towers', 'Duki', 'Morad', 'Mora', 'Taylor Swift', 'The Weeknd', 'Dua Lipa', 'Billie Eilish', 'Ed Sheeran', 'Drake',
    'Coldplay', 'Arctic Monkeys', 'Melendi', 'Estopa', 'Lola Índigo', 'Saiko', 'Milo j', 'Daddy Yankee'];
  let ov = null;

  async function findArtist(name) {
    try { const r = await YTM.search(name, 'artists'); return r[0] ? { id: r[0].browseId, name: r[0].title, cover: r[0].cover } : null; } catch (_) { return null; }
  }

  function open(force) {
    if (ov) return;
    const chosen = new Map(force ? store.get('followed', []).map(a => [a.id, a]) : []);
    ov = el(`<div id="welcome" role="dialog" aria-labelledby="wl-title">
      <div class="wl-in">
        <div class="wl-head"><div class="wl-logo" aria-hidden="true">${icon('note')}</div>
          <h1 id="wl-title">¿Qué música te gusta?</h1>
          <p class="muted">Elige al menos 3 artistas y preparamos tu inicio con música para ti.</p></div>
        <form class="search-box wl-search">${icon('search')}<input type="search" placeholder="Busca otro artista" aria-label="Buscar artista" enterkeyhint="search"></form>
        <div class="wl-grid"></div>
      </div>
      <div class="wl-bar"><button class="btn tonal" data-w="skip" type="button">Ahora no</button><button class="btn" data-w="go" type="button" disabled>Continuar</button></div></div>`);
    document.body.appendChild(ov);
    const grid = ov.querySelector('.wl-grid'), go = ov.querySelector('[data-w=go]');
    const update = () => { go.disabled = chosen.size < 3; go.textContent = chosen.size < 3 ? `Elige ${3 - chosen.size} más` : `Continuar (${chosen.size})`; };
    const card = (a, first) => {
      if (!a || grid.querySelector(`[data-id="${CSS.escape(a.id)}"]`)) return;
      const c = el(`<button class="wl-a" data-id="${esc(a.id)}" type="button" aria-pressed="false"><span class="wl-img"><img src="${esc(cover(a.cover, 226) || PLACEHOLDER)}" alt=""></span><span class="ellipsis">${esc(a.name)}</span></button>`);
      const set = on => { c.classList.toggle('on', on); c.setAttribute('aria-pressed', on); };
      c.onclick = () => { if (chosen.has(a.id)) chosen.delete(a.id); else chosen.set(a.id, a); set(chosen.has(a.id)); update(); if (typeof FX !== 'undefined' && FX.buzz) FX.buzz(8); };
      set(chosen.has(a.id));
      first ? grid.prepend(c) : grid.appendChild(c);
    };
    // los que ya sigues primero, luego los populares (se cargan de 6 en 6)
    chosen.forEach(a => card(a));
    (async () => { for (let i = 0; i < POPULAR.length && ov; i += 6) (await Promise.all(POPULAR.slice(i, i + 6).map(findArtist))).forEach(a => card(a)); })();
    ov.querySelector('.wl-search').onsubmit = async e => {
      e.preventDefault();
      const q = e.target.querySelector('input').value.trim();
      if (!q) return;
      const a = await findArtist(q);
      if (!a) return toast('No se encontró ese artista');
      card(a, true);
      const c = grid.querySelector(`[data-id="${CSS.escape(a.id)}"]`);
      if (c && !chosen.has(a.id)) c.click();
      e.target.querySelector('input').value = '';
    };
    ov.querySelector('[data-w=skip]').onclick = () => { store.set('onboarded', true); close(); };
    go.onclick = async () => {
      go.disabled = true; go.textContent = 'Preparando tu música…';
      const list = [...chosen.values()];
      store.set('followed', [...list, ...store.get('followed', []).filter(f => !chosen.has(f.id))].slice(0, 200));
      // sus canciones más populares como semilla de las recomendaciones
      const seeds = (await Promise.all(list.slice(0, 10).map(a => YTM.artist(a.id).then(r => r.songs.slice(0, 3)).catch(() => [])))).flat();
      store.set('seedSongs', seeds.map(t => clean(t)).slice(0, 30));
      store.set('onboarded', true);
      window.Reco && Reco.invalidate();
      close();
      toast('¡Listo! Tu inicio ya tiene música para ti');
      App.renderHome();
    };
    update();
  }
  function close() { if (!ov) return; const o = ov; ov = null; o.classList.add('out'); setTimeout(() => o.remove(), 300); }

  // primera vez sin historial: se muestra sola (tras iniciar sesión si hace falta)
  function maybeShow() {
    if (document.body.classList.contains('gated')) return setTimeout(maybeShow, 1000);
    if (store.get('onboarded', false) || Library.history().length || Library.favs().length || store.get('followed', []).length) return;
    open(false);
  }
  document.addEventListener('DOMContentLoaded', () => setTimeout(maybeShow, 1200), { once: true });

  return { open: () => open(true) };
})();
window.Welcome = Welcome;
