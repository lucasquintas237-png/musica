'use strict';
/* fx.js — efectos de Android (Material 3 Expressive):
   - ondas (ripple) al pulsar y vibración ligera en el móvil;
   - brillo de carga en las portadas y aparición suave al cargar;
   - colores dinámicos que se funden al cambiar de canción;
   - transformación de contenedor al abrir una vista y "atrás" predictivo al cerrarla;
   - barra superior que aparece al desplazar mientras el título grande se encoge;
   - estiramiento al tirar más allá del borde (Android 12+);
   - entrada escalonada de listas, ecualizador en la canción que suena;
   - deslizar el mini reproductor para pasar de canción. */
const FX = (() => {
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const EMPH = 'cubic-bezier(.05,.7,.1,1)', ACC = 'cubic-bezier(.3,0,.8,.15)';
  const buzz = (ms = 8) => { if (coarse && navigator.vibrate) try { navigator.vibrate(ms); } catch (_) {} };

  /* ---------------------------------------------------------------- ondas al pulsar */
  const RIPPLE = '.btn,.chip,.row,.tile,.set,.icb,.m3-side,.m3-play,.mid,.mi,#sheet .it,.seg button,.btn-group button,#mini,.more,.back,.kpi';
  function ripple(e) {
    if (e.button !== 0 || reduced()) return;
    const host = e.target.closest(RIPPLE);
    if (!host || host.disabled) return;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    let box = host.querySelector(':scope > .rp');
    if (!box) { box = document.createElement('span'); box.className = 'rp'; host.appendChild(box); }
    const r = host.getBoundingClientRect();
    const size = Math.hypot(r.width, r.height) * 2;
    const w = document.createElement('i');
    w.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    box.appendChild(w);
    const t0 = performance.now();
    const end = () => {
      removeEventListener('pointerup', end); removeEventListener('pointercancel', end);
      // la onda termina de crecer antes de desvanecerse
      setTimeout(() => { w.classList.add('out'); setTimeout(() => w.remove(), 450); }, Math.max(0, 260 - (performance.now() - t0)));
    };
    addEventListener('pointerup', end); addEventListener('pointercancel', end);
  }

  /* ---------------------------------------------------------------- portadas: brillo de carga */
  const IMG = 'img.art,.card img,.hero img,.tile .ph img,#n-cover,.p-cover,#mini img,.m3-menu .head img,#sheet .head img';
  function markImg(im) {
    if (!(im instanceof HTMLImageElement) || !im.matches(IMG)) return;
    if (!im.getAttribute('src')) { im.classList.remove('ok', 'wait'); return; }   // sin portada todavía
    const ok = im.complete && im.naturalWidth > 0 && !im.src.startsWith('data:,');
    im.classList.toggle('ok', ok);
    im.classList.toggle('wait', !ok);
  }

  /* ---------------------------------------------------------------- colores que se funden */
  function registerColors() {
    if (!window.CSS || !CSS.registerProperty) return;
    // --bg no se registra: el fondo WebGL lo lee y repintarlo en cada paso de la transición sería caro
    ['primary', 'on-primary', 'primary-container', 'on-primary-container', 'secondary-container', 'on-secondary-container',
      'tertiary-container', 'on-tertiary-container', 'surface', 'surface-c-low', 'surface-c', 'surface-c-high', 'surface-c-highest',
      'on-surface', 'on-surface-variant', 'outline', 'outline-variant', 'inverse-surface', 'inverse-on-surface']
      .forEach(n => { try { CSS.registerProperty({ name: '--' + n, syntax: '<color>', inherits: true, initialValue: 'black' }); } catch (_) {} });
    document.documentElement.classList.add('fx-colors');
  }

  /* ---------------------------------------------------------------- vistas: contenedor y atrás predictivo */
  let lastPress = null;
  function containerIn(v) {
    if (reduced() || !v.animate) return;
    const src = lastPress && performance.now() - lastPress.t < 1500 ? lastPress.r : null;
    const W = innerWidth, H = innerHeight;
    const from = src
      ? `inset(${src.top}px ${W - src.right}px ${H - src.bottom}px ${src.left}px round 28px)`
      : `inset(${H * .08}px ${W * .08}px ${H * .08}px ${W * .08}px round 32px)`;
    v.animate([{ clipPath: from, opacity: .4 }, { clipPath: 'inset(0px 0px 0px 0px round 0px)', opacity: 1 }], { duration: 520, easing: EMPH });
    v.animate([{ transform: 'scale(.98)' }, { transform: 'none' }], { duration: 520, easing: EMPH });
  }

  function patchViews() {
    const open = App.openView;
    App.openView = function (...a) { const v = open.apply(this, a); try { containerIn(v); } catch (_) {} return v; };
    // cerrar con el gesto de "atrás predictivo": la vista se encoge, se redondea y se va hacia un lado
    App.closeView = function () {
      const v = this.views.pop();
      const top = this.views[this.views.length - 1];
      if (top) top.hidden = false;
      const done = () => {
        v && v.remove();
        if (!this.views.length) { $('#view').hidden = true; document.body.classList.remove('in-view'); this.highlight(); }
      };
      if (!v || reduced() || !v.animate) return done();
      if (!top) document.body.classList.remove('in-view');   // que se vea lo de debajo mientras se va
      v.style.zIndex = 5;
      const a = v.animate([
        { transform: 'none', borderRadius: '0px', opacity: 1 },
        { transform: 'translateX(6%) scale(.88)', borderRadius: '36px', opacity: 0 }
      ], { duration: 320, easing: ACC, fill: 'forwards' });
      a.onfinish = done;
    };
  }

  /* ---------------------------------------------------------------- barra superior que se compacta */
  const scrollers = new WeakMap();
  function onScroll(e) {
    const s = e.target;
    if (!(s instanceof Element) || !s.matches('.tab,.view')) return;
    if (scrollers.get(s)) return;
    scrollers.set(s, true);
    requestAnimationFrame(() => {
      scrollers.set(s, false);
      const k = Math.max(0, Math.min(1, s.scrollTop / 72));
      s.style.setProperty('--sc', k.toFixed(3));
      s.classList.toggle('scrolled', s.scrollTop > 64);
      ensureTopbar(s);
    });
  }
  function ensureTopbar(s) {
    if (s.id === 'tab-search') return;           // el buscador ya tiene su barra fija
    const title = (s.querySelector('h1.title') || s.querySelector('.hero h1') || {}).textContent || '';
    if (s.classList.contains('view')) {
      const vt = s.querySelector('.view-top');
      if (!vt) return;
      let t = vt.querySelector('.vt-title');
      if (!t) { t = document.createElement('span'); t.className = 'vt-title ellipsis'; vt.appendChild(t); }
      if (t.textContent !== title) t.textContent = title;
      return;
    }
    let bar = s.querySelector(':scope > .topbar');
    if (!bar) { bar = document.createElement('div'); bar.className = 'topbar'; bar.innerHTML = '<div><span class="ellipsis"></span></div>'; s.prepend(bar); }
    const sp = bar.querySelector('span');
    if (sp.textContent !== title) sp.textContent = title;
  }

  /* ---------------------------------------------------------------- estirar al tirar del borde */
  function overscroll() {
    let st = null;
    document.addEventListener('touchstart', e => {
      const s = e.target.closest && e.target.closest('.tab,.view,.p-panel,#now');
      if (!s || e.touches.length !== 1) { st = null; return; }
      st = { s, y: e.touches[0].clientY, k: 0, el: s.querySelector(':scope > .wrap') || s.firstElementChild };
    }, { passive: true });
    document.addEventListener('touchmove', e => {
      if (!st || !st.el || reduced()) return;
      const { s } = st, dy = e.touches[0].clientY - st.y;
      const atTop = s.scrollTop <= 0, atBot = s.scrollTop + s.clientHeight >= s.scrollHeight - 1;
      let k = 0, origin = 'top';
      if (atTop && dy > 0) k = Math.min(.08, dy / 2400);
      else if (atBot && dy < 0) { k = Math.min(.08, -dy / 2400); origin = 'bottom'; }
      st.k = k;
      st.el.style.transition = 'none';
      st.el.style.transformOrigin = '50% ' + origin;
      st.el.style.transform = k ? `scaleY(${1 + k})` : '';
    }, { passive: true });
    const end = () => {
      if (!st || !st.el) return;
      st.el.style.transition = 'transform .5s cubic-bezier(.34,1.45,.64,1)';
      st.el.style.transform = '';
      st = null;
    };
    document.addEventListener('touchend', end, { passive: true });
    document.addEventListener('touchcancel', end, { passive: true });
  }

  /* ---------------------------------------------------------------- listas: entrada escalonada */
  function stagger(root) {
    if (!root.querySelectorAll) return;
    const SEL = '.list,.tiles,.shelf,.kpis';
    [...(root.matches && root.matches(SEL) ? [root] : []), ...root.querySelectorAll(SEL)].forEach(l => {
      [...l.children].forEach((c, i) => { if (!c.style.getPropertyValue('--i')) c.style.setProperty('--i', Math.min(i, 14)); });
    });
  }

  /* ---------------------------------------------------------------- carruseles con flechas (ratón) */
  function shelves(root) {
    if (!root.querySelectorAll) return;
    [...(root.matches && root.matches('.shelf') ? [root] : []), ...root.querySelectorAll('.shelf')].forEach(s => {
      if (s.parentElement && s.parentElement.classList.contains('shelf-wrap')) return;
      const w = document.createElement('div');
      w.className = 'shelf-wrap';
      s.before(w); w.appendChild(s);
      const mk = (dir, label, ic) => {
        const b = document.createElement('button');
        b.className = 'shelf-arrow ' + dir; b.setAttribute('aria-label', label);
        b.innerHTML = `<svg class="ic"><use href="#i-${ic}"/></svg>`;
        b.onclick = () => s.scrollBy({ left: (dir === 'next' ? 1 : -1) * s.clientWidth * .8, behavior: reduced() ? 'auto' : 'smooth' });
        w.appendChild(b);
        return b;
      };
      const prev = mk('prev', 'Anterior', 'back'), next = mk('next', 'Siguiente', 'back');
      const upd = () => {
        prev.classList.toggle('off', s.scrollLeft < 8);
        next.classList.toggle('off', s.scrollLeft + s.clientWidth > s.scrollWidth - 8);
      };
      s.addEventListener('scroll', upd, { passive: true });
      new ResizeObserver(upd).observe(s);
      upd();
    });
  }

  /* ---------------------------------------------------------------- ecualizador en la canción que suena */
  function patchHighlight() {
    const h = App.highlight;
    App.highlight = function (...a) {
      const r = h.apply(this, a);
      document.querySelectorAll('.row .eq').forEach(x => { if (!x.closest('.row.playing')) x.remove(); });
      document.querySelectorAll('.row.playing').forEach(row => {
        if (row.querySelector('.eq') || !row.querySelector('.art')) return;
        const eq = document.createElement('span');
        eq.className = 'eq'; eq.setAttribute('aria-hidden', 'true');
        eq.innerHTML = '<i></i><i></i><i></i><i></i>';
        row.querySelector('.art').after(eq);
      });
      return r;
    };
  }

  /* ---------------------------------------------------------------- deslizar el mini reproductor */
  function miniSwipe() {
    const mini = document.getElementById('mini'), inner = mini;
    let d = null, block = false;
    mini.addEventListener('pointerdown', e => {
      if (e.target.closest('[data-act]') || e.button !== 0) return;
      d = { id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, on: false };
    });
    mini.addEventListener('pointermove', e => {
      if (!d || e.pointerId !== d.id) return;
      d.dx = e.clientX - d.x;
      if (!d.on && Math.abs(d.dx) > 8 && Math.abs(d.dx) > Math.abs(e.clientY - d.y)) { d.on = true; try { mini.setPointerCapture(d.id); } catch (_) {} }
      if (d.on) {
        const k = d.dx / 180;
        inner.style.transition = 'none';
        inner.style.setProperty('--sx', d.dx * .8 + 'px');
        inner.style.setProperty('--so', (1 - Math.min(.6, Math.abs(k) * .6)).toFixed(3));
      }
    });
    const up = e => {
      if (!d || e.pointerId !== d.id) return;
      const { on, dx } = d; d = null;
      inner.style.transition = '';
      if (!on) return;
      block = true; setTimeout(() => { block = false; }, 50);
      if (Math.abs(dx) > 70) {
        buzz(12);
        const dir = dx < 0 ? 1 : -1;
        inner.style.setProperty('--sx', (dir > 0 ? -60 : 60) + 'px');
        inner.style.setProperty('--so', '0');
        setTimeout(() => {
          dir > 0 ? App.next() : App.prev();
          inner.style.transition = 'none';
          inner.style.setProperty('--sx', (dir > 0 ? 60 : -60) + 'px');
          requestAnimationFrame(() => requestAnimationFrame(() => { inner.style.transition = ''; inner.style.setProperty('--sx', '0px'); inner.style.setProperty('--so', '1'); }));
        }, 160);
      } else { inner.style.setProperty('--sx', '0px'); inner.style.setProperty('--so', '1'); }
    };
    mini.addEventListener('pointerup', up);
    mini.addEventListener('pointercancel', up);
    // que el arrastre no cuente como "abrir el reproductor"
    mini.addEventListener('click', e => { if (block) { e.stopImmediatePropagation(); e.preventDefault(); } }, true);
  }

  /* ---------------------------------------------------------------- arranque */
  registerColors();
  miniSwipe();   // antes que now.js registre su clic en el mini reproductor
  document.addEventListener('pointerdown', e => {
    ripple(e);
    const h = e.target.closest && e.target.closest('.card,.tile,.row,.hero,.btn');
    if (h) lastPress = { r: (h.querySelector('img') || h).getBoundingClientRect(), t: performance.now() };
  }, true);
  document.addEventListener('click', e => {
    if (e.target.closest && e.target.closest('.switch,.set[data-k],.seg button,.btn-group button,[data-act=toggle],[data-act=fav],.tb-item')) buzz(8);
  }, true);
  document.addEventListener('scroll', onScroll, true);
  document.addEventListener('load', e => markImg(e.target), true);
  document.addEventListener('error', e => markImg(e.target), true);
  new MutationObserver(ms => ms.forEach(m => {
    if (m.type === 'attributes') { markImg(m.target); return; }
    m.addedNodes.forEach(n => {
      if (n.nodeType !== 1) return;
      if (n.tagName === 'IMG') markImg(n); else n.querySelectorAll && n.querySelectorAll('img').forEach(markImg);
      stagger(n.parentElement || n);
      shelves(n);
    });
  })).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });

  document.addEventListener('DOMContentLoaded', () => {
    try { patchViews(); patchHighlight(); App.highlight(); overscroll(); } catch (e) { console.warn('FX:', e); }
    document.querySelectorAll('img').forEach(markImg);
    stagger(document.body);
    shelves(document.body);
  }, { once: true });

  return { buzz };
})();
