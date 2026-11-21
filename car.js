'use strict';
/* car.js — modo coche: pantalla simple con portada grande, título enorme, tres botones gigantes,
   la hora y el progreso. Deslizar a los lados cambia de canción y tocar la portada pausa.
   Mantiene la pantalla encendida (Wake Lock) y, si se puede, pasa a pantalla completa. */
const Car = (() => {
  let ov = null, wake = null, tick = 0, fs = false;

  async function keepAwake() {
    try { wake = navigator.wakeLock ? await navigator.wakeLock.request('screen') : null; } catch (_) { wake = null; }
  }
  // el sistema suelta el Wake Lock al cambiar de pestaña: se vuelve a pedir al volver
  document.addEventListener('visibilitychange', () => { if (ov && document.visibilityState === 'visible') keepAwake(); });

  function render() {
    if (!ov) return;
    const t = App.current;
    const img = ov.querySelector('.car-cover');
    const src = t ? cover(t.cover) || PLACEHOLDER : PLACEHOLDER;
    if (img.getAttribute('src') !== src) img.src = src;
    ov.querySelector('.car-title').textContent = t ? t.title : 'Nada sonando';
    ov.querySelector('.car-artist').textContent = t ? t.artist : '';
  }
  function update() {
    if (!ov) return;
    const d = new Date();
    ov.querySelector('.car-clock').textContent = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    const playing = !!App.state.playing;
    ov.classList.toggle('playing', playing);
    ov.querySelector('.car-play use').setAttribute('href', playing ? '#i-pause' : '#i-play');
    const dur = Player.duration(), cur = Player.time();
    ov.querySelector('.car-bar i').style.width = (dur ? Math.min(100, cur / dur * 100) : 0) + '%';
  }

  async function open() {
    if (ov) return;
    ov = el(`<div id="car" role="dialog" aria-label="Modo coche">
      <div class="car-top"><span class="car-clock"></span><span class="car-label">${icon('car')}Modo coche</span>
        <button class="icb car-close" aria-label="Salir del modo coche">${icon('close')}</button></div>
      <div class="car-main"><img class="car-cover" alt=""><div class="car-txt"><div class="car-title ellipsis"></div><div class="car-artist ellipsis"></div></div>
        <p class="car-hint">Desliza a los lados para cambiar de canción</p></div>
      <div class="car-bar"><i></i></div>
      <div class="car-ctrl">
        <button class="car-b" data-c="prev" aria-label="Anterior">${icon('prev')}</button>
        <button class="car-b car-play" data-c="toggle" aria-label="Reproducir o pausar">${icon('play')}</button>
        <button class="car-b" data-c="next" aria-label="Siguiente">${icon('next')}</button></div></div>`);
    document.body.appendChild(ov);
    ov.querySelector('.car-close').onclick = close;
    ov.querySelectorAll('.car-b').forEach(b => b.onclick = () => {
      ({ prev: () => App.prev(), toggle: () => App.toggle(), next: () => App.next() })[b.dataset.c]();
      if (typeof FX !== 'undefined' && FX.buzz) FX.buzz(15);
    });
    // gestos sobre la portada
    const main = ov.querySelector('.car-main');
    let d = null;
    main.addEventListener('pointerdown', e => { d = { x: e.clientX, y: e.clientY }; });
    main.addEventListener('pointerup', e => {
      if (!d) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y; d = null;
      if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy)) {
        main.classList.remove('swipe-l', 'swipe-r'); void main.offsetWidth;
        main.classList.add(dx < 0 ? 'swipe-l' : 'swipe-r');
        dx < 0 ? App.next() : App.prev();
      } else if (Math.abs(dx) < 12 && Math.abs(dy) < 12) App.toggle();
    });
    addEventListener('keydown', key, true);
    render(); update();
    tick = setInterval(update, 500);
    keepAwake();
    try { if (!document.fullscreenElement && document.documentElement.requestFullscreen) { await document.documentElement.requestFullscreen(); fs = true; } } catch (_) {}
  }
  function key(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
  function close() {
    if (!ov) return;
    clearInterval(tick);
    const o = ov; ov = null;
    o.classList.add('out'); setTimeout(() => o.remove(), 300);
    removeEventListener('keydown', key, true);
    try { wake && wake.release(); } catch (_) {}
    wake = null;
    if (fs && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    fs = false;
  }

  document.addEventListener('DOMContentLoaded', () => {
    App.on('track', render);
    document.addEventListener('click', e => { if (e.target.closest('[data-car]')) open(); });
  }, { once: true });

  return { open, close };
})();
window.Car = Car;
