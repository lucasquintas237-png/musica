'use strict';
/* now.js — panel "Ahora suena" (pantallas de 760 px o más): se arrastra por toda la pantalla
   desde la cabecera, se ancla al acercarlo a un borde (y entonces el contenido le deja sitio)
   y se minimiza hacia la barra de navegación, donde queda el mini reproductor.
   También define las formas de Material 3 Expressive (galleta, trébol, pentágono, squircle)
   que usan el botón de reproducir, el indicador de carga y los iconos de las listas. */
const NowPanel = (() => {
  /* ---------------------------------------------------------------- formas M3 Expressive */
  // Todas con el mismo número de puntos para que clip-path pueda transformarse de una a otra.
  const PTS = 64;
  function polygon(rf) {
    const raw = [];
    for (let k = 0; k < PTS; k++) { const a = k / PTS * Math.PI * 2 - Math.PI / 2; raw.push([a, rf(a)]); }
    const m = Math.max(...raw.map(p => p[1]));
    return 'polygon(' + raw.map(([a, r]) => `${(50 + 50 * r / m * Math.cos(a)).toFixed(2)}% ${(50 + 50 * r / m * Math.sin(a)).toFixed(2)}%`).join(',') + ')';
  }
  const cookie = (n, amp) => a => 1 + amp * Math.cos(n * a);
  const squircle = p => a => 1 / Math.pow(Math.pow(Math.abs(Math.cos(a)), p) + Math.pow(Math.abs(Math.sin(a)), p), 1 / p);
  const S = {
    cookie9: polygon(cookie(9, .075)),
    cookie4: polygon(cookie(4, .16)),
    sunny: polygon(cookie(8, .05)),
    pentagon: polygon(cookie(5, .11)),
    circle: polygon(() => 1),
    squircle: polygon(squircle(4))
  };
  const rs = document.documentElement.style;
  Object.entries(S).forEach(([k, v]) => rs.setProperty('--shape-' + k, v));

  /* ---------------------------------------------------------------- panel */
  const $n = id => document.getElementById(id);
  let wave = null;
  const wide = matchMedia('(min-width: 1000px)');

  function renderTrack() {
    const t = App.current;
    const img = $n('n-cover');
    if (!t) {
      img.src = PLACEHOLDER;
      $n('n-title').textContent = 'Nada sonando';
      $n('n-artist').textContent = 'Elige una canción para empezar';
      $n('n-from').textContent = '—';
      document.body.classList.add('now-empty');
      return;
    }
    document.body.classList.remove('now-empty');
    const src = t.cover || PLACEHOLDER;
    if (img.getAttribute('src') !== src) img.src = src;
    $n('n-title').textContent = t.title;
    $n('n-artist').textContent = t.artist + (t.album ? ' — ' + t.album : '');
    $n('n-from').textContent = App.state.from || t.album || t.artist || '—';
    $n('n-dur').textContent = fmt(t.dur);
  }

  function renderFav() {
    const t = App.current, on = !!(t && Library.isFav(t.id));
    const b = $n('n-fav');
    b.classList.toggle('on', on);
    b.querySelector('use').setAttribute('href', on ? '#i-heart-f' : '#i-heart');
  }

  function renderModes() {
    const s = App.state;
    const sh = document.querySelector('#now [data-act=shuffle]'), rp = document.querySelector('#now [data-act=repeat]');
    sh.classList.toggle('on', s.shuffle); sh.setAttribute('aria-pressed', s.shuffle);
    rp.classList.toggle('on', s.repeat !== 'off'); rp.setAttribute('aria-pressed', s.repeat !== 'off');
    rp.querySelector('use').setAttribute('href', s.repeat === 'one' ? '#i-repeat1' : '#i-repeat');
  }

  function renderPlaying() {
    document.body.classList.toggle('is-playing', !!App.state.playing);
    wave && wave.setPlaying(!!App.state.playing);
  }

  function renderVolume() {
    const r = $n('n-vol'), v = App.state.volume;
    if (+r.value !== v) r.value = v;
    r.style.setProperty('--v', v + '%');
  }

  function renderUpNext() {
    const box = $n('n-up');
    const s = App.state;
    const up = s.queue.slice(s.index + 1, s.index + 7);
    box.innerHTML = '';
    if (!up.length) {
      box.appendChild(el(`<div class="empty">${App.current ? (s.autoRadio ? 'Después seguirá sonando música parecida.' : 'No hay más canciones en la cola.') : 'La cola está vacía.'}</div>`));
      return;
    }
    const list = el('<div class="list"></div>');
    up.forEach((t, k) => list.appendChild(App.trackRow(t, s.index + 1 + k, s.queue, { inQueue: true, onClick: (_, i) => App.jump(i) })));
    box.appendChild(list);
    const more = s.queue.length - s.index - 1 - up.length;
    if (more > 0) {
      const b = el(`<button class="chip">Ver toda la cola · ${more + up.length}</button>`);
      b.onclick = () => Features.togglePanel('queue');
      box.appendChild(b);
    }
  }

  /* ---------------------------------------------------------------- mover, anclar y minimizar */
  const GAP = 16, SNAP = 44;
  let pos = store.get('nowPos', { dock: 'left', x: GAP, y: GAP });
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function applyPos(animate) {
    const p = $n('now');
    document.body.classList.toggle('now-left', pos.dock === 'left');
    document.body.classList.toggle('now-right', pos.dock === 'right');
    const W = innerWidth, H = innerHeight, w = p.offsetWidth, h = p.offsetHeight;
    let x, y;
    if (pos.dock === 'left') { x = GAP; y = GAP; }
    else if (pos.dock === 'right') { x = W - w - GAP; y = GAP; }
    else { x = clamp(pos.x, 8, Math.max(8, W - w - 8)); y = clamp(pos.y, 8, Math.max(8, H - h - 8)); }
    p.classList.toggle('snap', !!animate);
    p.style.left = x + 'px'; p.style.top = y + 'px';
    if (animate) setTimeout(() => p.classList.remove('snap'), 600);
  }

  function initDrag() {
    const p = $n('now'), head = p.querySelector('.now-head');
    let d = null;
    head.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('button')) return;
      const r = p.getBoundingClientRect();
      d = { id: e.pointerId, ox: e.clientX - r.left, oy: e.clientY - r.top, sx: e.clientX, sy: e.clientY, moved: false };
      try { head.setPointerCapture(e.pointerId); } catch (_) {}
    });
    head.addEventListener('pointermove', e => {
      if (!d || e.pointerId !== d.id) return;
      if (!d.moved) {
        if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 5) return;
        d.moved = true;
        // al despegarlo de un borde pasa a flotar y el contenido recupera el espacio
        pos = { dock: 'float', x: p.getBoundingClientRect().left, y: p.getBoundingClientRect().top };
        document.body.classList.remove('now-left', 'now-right');
        p.classList.remove('snap');
        p.classList.add('dragging');
      }
      const W = innerWidth, H = innerHeight, w = p.offsetWidth, h = p.offsetHeight;
      pos.x = clamp(e.clientX - d.ox, 8, W - w - 8);
      pos.y = clamp(e.clientY - d.oy, 8, Math.max(8, H - h - 8));
      p.style.left = pos.x + 'px'; p.style.top = pos.y + 'px';
    });
    const up = e => {
      if (!d || e.pointerId !== d.id) return;
      const moved = d.moved; d = null;
      p.classList.remove('dragging');
      if (!moved) return;
      // cerca de un borde se ancla y ocupa todo el alto
      const W = innerWidth, w = p.offsetWidth;
      if (pos.x < SNAP) pos.dock = 'left';
      else if (pos.x + w > W - SNAP) pos.dock = 'right';
      store.set('nowPos', pos);
      applyPos(true);
    };
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
    // doble clic en la cabecera: volver a anclarlo a la izquierda
    head.addEventListener('dblclick', e => { if (e.target.closest('button')) return; pos = { dock: 'left', x: GAP, y: GAP }; store.set('nowPos', pos); applyPos(true); });
    addEventListener('resize', () => applyPos(false));
    applyPos(false);
  }

  // minimizar: el panel se encoge hacia la barra de navegación y queda el mini reproductor
  function setMin(on, animate = true) {
    const p = $n('now'), body = document.body;
    store.set('nowMin', on);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || !p.animate;
    const toBar = () => {
      const r = p.getBoundingClientRect(), t = document.getElementById('tabwrap').getBoundingClientRect();
      return `translate(${(t.left + t.width / 2 - (r.left + r.width / 2)).toFixed(0)}px,${(t.top - (r.top + r.height / 2)).toFixed(0)}px) scale(.12)`;
    };
    if (on) {
      if (!animate || reduced || !wide.matches) { body.classList.add('now-min'); return; }
      const a = p.animate([{ transform: 'none', opacity: 1 }, { transform: toBar(), opacity: 0 }], { duration: 380, easing: 'cubic-bezier(.3,0,.8,.15)' });
      a.onfinish = () => body.classList.add('now-min');
    } else {
      body.classList.remove('now-min');
      applyPos(false);
      if (animate && !reduced && wide.matches) p.animate([{ transform: toBar(), opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 520, easing: 'cubic-bezier(.05,.7,.1,1)' });
    }
  }

  // engancharse a los métodos de App que ya actualizan el reproductor
  function hook(name, fn) {
    const orig = App[name];
    App[name] = function (...a) { const r = orig.apply(this, a); try { fn(); } catch (_) {} return r; };
  }

  function init() {
    wave = M3.Wave($n('n-wave'), f => {
      const d = Player.duration() || (App.current && App.current.dur) || 0;
      if (d) { Player.seek(f * d); $n('n-cur').textContent = fmt(f * d); }
    });
    const act = () => wave.setActive(wide.matches);
    wide.addEventListener ? wide.addEventListener('change', act) : wide.addListener(act);
    act();

    $n('n-vol').addEventListener('input', e => App.setVolume(+e.target.value));
    $n('n-cover').addEventListener('click', () => App.openPlayer());
    $n('n-search').addEventListener('click', () => Glass.select('search'));
    $n('n-min').addEventListener('click', () => setMin(true));
    // con el panel minimizado, tocar el mini reproductor lo vuelve a abrir (en pantallas anchas)
    $n('mini').addEventListener('click', e => {
      if (e.target.closest('[data-act]') || !wide.matches || !document.body.classList.contains('now-min')) return;
      e.stopImmediatePropagation();
      setMin(false);
    }, true);
    initDrag();
    if (store.get('nowMin', false) && App.current) setMin(true, false);

    hook('updateNow', () => { renderTrack(); renderFav(); });
    hook('updatePlaying', renderPlaying);
    hook('updateFav', renderFav);
    hook('updateModes', renderModes);
    hook('setVolume', renderVolume);
    App.on('queue', renderUpNext);
    App.on('library', renderFav);
    App.on('time', ({ cur, dur }) => {
      if (!wave.dragging) { wave.set(dur ? cur / dur : 0); $n('n-cur').textContent = fmt(cur); }
      $n('n-dur').textContent = fmt(dur);
    });
    renderTrack(); renderFav(); renderModes(); renderPlaying(); renderVolume(); renderUpNext();
  }

  // App.init corre en DOMContentLoaded; este archivo se carga después, así que se engancha antes
  document.addEventListener('DOMContentLoaded', () => { try { init(); } catch (e) { console.warn('NowPanel:', e); } }, { once: true });

  return { shapes: S };
})();
