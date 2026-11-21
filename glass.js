'use strict';
/* glass.js — controles "Liquid Glass" al estilo iOS 26 (el dibujo lo hace liquid.js).
   - Píldora de selección arrastrable con física para la barra de pestañas y los selectores
     segmentados: sigue al dedo, al soltar va con un muelle tipo iOS a la opción más cercana,
     se estira con la velocidad (gelatina, conservando volumen), goma en los bordes y, al
     cogerla, se levanta y se vuelve una lente limpia con lupa.
   - Menús que nacen de un botón: la forma crece desde el botón como cápsula y acaba en
     cristal blanco esmerilado; las opciones se enfocan. Al cerrar, todo al revés. */
const Glass = (() => {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const dark = () => document.documentElement.dataset.theme !== 'light';
  // goma: (1 - 1/(d·0.55/dim + 1))·dim
  const rubber = (d, dim) => (1 - 1 / (d * .55 / dim + 1)) * dim;

  // muelle amortiguado (k rigidez, z amortiguación; 1 = crítico)
  function spring(s, t, k, z, h) {
    const a = -k * (s.x - t) - 2 * z * Math.sqrt(k) * s.v;
    s.v += a * h; s.x += s.v * h;
  }

  const SPR = {
    drag: { k: 2600, z: 1 },      // seguir al dedo casi 1:1
    snap: { k: 273, z: .72 },     // al soltar, tipo iOS
    stretch: { k: 630, z: .42 },  // gelatina
    lift: { k: 320, z: .8 }
  };

  /* ================================================================ píldora de selección */
  function Selector(o) {
    const host = o.host, pill = o.pill;
    let items = o.items, index = clamp(o.index || 0, 0, items.length - 1);
    let centers = [], widths = [], hostW = 0, cy = 0, pillH = 0;
    const pos = { x: 0, v: 0 }, sx = { x: 1, v: 0 }, lift = { x: 0, v: 0 }, py = { x: 0, v: 0 };
    let target = 0, yTarget = 0, liftT = 0, grabbed = false, drag = null, raf = 0, lastT = 0, pulse = 0, placed = false;

    function measure() {
      const hr = host.getBoundingClientRect();
      hostW = hr.width;
      if (!hostW) return false;
      centers = items.map(b => { const r = b.getBoundingClientRect(); return r.left - hr.left + r.width / 2; });
      widths = items.map(b => b.getBoundingClientRect().width - (o.shrink || 0));
      const r0 = items[0].getBoundingClientRect();
      cy = r0.top - hr.top + r0.height / 2;
      pillH = o.pillH || r0.height;
      return true;
    }
    // el ancho cambia de forma continua entre opciones de distinto ancho
    function widthAt(x) {
      if (x <= centers[0]) return widths[0];
      for (let i = 0; i < centers.length - 1; i++) {
        if (x <= centers[i + 1]) return lerp(widths[i], widths[i + 1], (x - centers[i]) / (centers[i + 1] - centers[i] || 1));
      }
      return widths[widths.length - 1];
    }
    function nearest(x) {
      let best = 0;
      centers.forEach((c, i) => { if (Math.abs(c - x) < Math.abs(centers[best] - x)) best = i; });
      return best;
    }
    function edge(t) {
      const lo = centers[0], hi = centers[centers.length - 1];
      if (t < lo) return lo - rubber(lo - t, hostW);
      if (t > hi) return hi + rubber(t - hi, hostW);
      return t;
    }

    function render() {
      if (!centers.length) return;
      const l = clamp(lift.x, 0, 1.2), s = Math.max(.6, sx.x);
      const w = widthAt(pos.x) * (1 + .2 * l) * s;
      const h = pillH * (1 + .32 * l) / Math.pow(s, .75);
      const st = pill.style;
      st.left = (pos.x - w / 2).toFixed(2) + 'px';
      st.top = (cy + py.x - h / 2).toFixed(2) + 'px';
      st.width = w.toFixed(2) + 'px';
      st.height = h.toFixed(2) + 'px';
      st.borderRadius = (h / 2).toFixed(2) + 'px';
      // en reposo: esmerilada; al cogerla: lente limpia (sin desenfoque ni tinte, con lupa)
      const lc = clamp(l, 0, 1), speed = smooth(250, 1150, Math.abs(pos.v));
      const ta = (dark() ? .1 : .5) * (1 - lc);
      const d = pill.dataset;
      d.tint = `255,255,255,${ta.toFixed(3)}`;
      d.blur = lerp(1.2, -3, lc).toFixed(3);
      d.zoom = (1 + .3 * lc).toFixed(3);
      d.refract = lerp(.6, 1, lc).toFixed(3);
      d.ab = lerp(1, .45, lc).toFixed(3);
      d.lens = Math.max(lc, speed).toFixed(3);
      pill.classList.toggle('lifted', lc > .3);
    }

    function tick(t) {
      raf = 0;
      let dt = lastT ? (t - lastT) / 1000 : 1 / 60;
      lastT = t;
      dt = Math.min(dt, 1 / 20);
      if (reduced()) {
        pos.x = target; pos.v = 0; sx.x = 1; sx.v = 0; lift.x = liftT; lift.v = 0; py.x = yTarget; py.v = 0;
      } else {
        const steps = Math.ceil(dt * 240), h = dt / steps;
        for (let i = 0; i < steps; i++) {
          const c = grabbed ? SPR.drag : SPR.snap;
          spring(pos, target, c.k, c.z, h);
          spring(py, yTarget, c.k, c.z, h);
          spring(lift, liftT, SPR.lift.k, SPR.lift.z, h);
          const sT = 1 + .34 * Math.tanh(Math.max(Math.abs(pos.v) - 320, 0) / 2400);
          spring(sx, sT, SPR.stretch.k, SPR.stretch.z, h);
        }
      }
      render();
      const settled = Math.abs(pos.x - target) < .05 && Math.abs(pos.v) < 2 && Math.abs(lift.x - liftT) < .002 &&
        Math.abs(lift.v) < .01 && Math.abs(sx.x - 1) < .0005 && Math.abs(sx.v) < .01 && Math.abs(py.x - yTarget) < .05;
      if (!settled || drag) raf = requestAnimationFrame(tick);
      else { pos.x = target; pos.v = 0; sx.x = 1; sx.v = 0; lift.x = liftT; lift.v = 0; py.x = yTarget; py.v = 0; render(); lastT = 0; }
    }
    const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };

    function select(i, emit = true, animate = true) {
      if (!placed) layout();
      i = clamp(i, 0, items.length - 1);
      const changed = i !== index;
      index = i;
      target = centers[i] != null ? centers[i] : 0;
      items.forEach((b, j) => { b.setAttribute('aria-selected', j === i ? 'true' : 'false'); b.classList.toggle('on', j === i); });
      if (!animate) { pos.x = target; pos.v = 0; render(); } else kick();
      if (emit && o.onSelect) o.onSelect(i, changed);
    }

    function lx(e) { return e.clientX - host.getBoundingClientRect().left; }
    function onDown(e) {
      if (e.button !== 0 || !centers.length) return;
      const x = lx(e);
      const onPill = Math.abs(x - pos.x) < widthAt(pos.x) / 2 + 4;
      drag = { id: e.pointerId, x0: x, y0: e.clientY, off: pos.x - x, onPill, moved: false, vx: 0, lx: x, lt: e.timeStamp };
      try { host.setPointerCapture(e.pointerId); } catch (_) {}
      clearTimeout(pulse);
      if (onPill) { grabbed = true; liftT = 1; target = pos.x; }
      kick();
    }
    function onMove(e) {
      if (!drag || e.pointerId !== drag.id) return;
      const x = lx(e), dx = x - drag.x0, dy = e.clientY - drag.y0;
      const dtm = Math.max(1, e.timeStamp - drag.lt);
      drag.vx = lerp(drag.vx, (x - drag.lx) / dtm * 1000, .5); drag.lx = x; drag.lt = e.timeStamp;
      if (!drag.moved && Math.abs(dx) > 6) {
        drag.moved = true;
        if (!drag.onPill) { grabbed = true; liftT = 1; drag.off = 0; }   // la píldora salta al dedo
      }
      if (grabbed) {
        target = edge(x + drag.off);
        yTarget = Math.sign(dy) * rubber(Math.abs(dy), 9);
        kick();
      }
    }
    function onUp(e) {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag; drag = null;
      let i;
      if (grabbed) {
        grabbed = false;
        if (d.moved) pos.v = d.vx;                          // hereda la velocidad del dedo
        i = nearest(pos.x + clamp(pos.v, -1600, 1600) * .06);
        liftT = 0;
      } else {
        i = nearest(lx(e));
        liftT = 1;                                          // tocar: se levanta mientras viaja
        pulse = setTimeout(() => { liftT = 0; kick(); }, 150);
      }
      yTarget = 0;
      select(i);
    }
    function onCancel() { if (!drag) return; drag = null; grabbed = false; liftT = 0; yTarget = 0; select(index, false); }

    function layout() {
      if (!measure()) return;
      placed = true;
      target = centers[index];
      if (!raf) { pos.x = target; pos.v = 0; }
      render();
    }

    host.addEventListener('pointerdown', onDown);
    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerup', onUp);
    host.addEventListener('pointercancel', onCancel);
    items.forEach((b, i) => b.addEventListener('click', e => { if (e.detail === 0) select(i); }));   // teclado
    if ('ResizeObserver' in window) new ResizeObserver(() => layout()).observe(host);
    addEventListener('resize', layout);
    layout();
    select(index, false, false);

    return { select, layout, get index() { return index; } };
  }

  /* ================================================================ barra de pestañas */
  let tabs = null, wrap = null, tabItems = [], onChange = null;

  function init(opts = {}) {
    wrap = document.getElementById('tabwrap');
    const base = wrap.querySelector('.tb-base');
    const pill = wrap.querySelector('.tb-pill');
    tabItems = [...base.querySelectorAll('.tb-item')];
    onChange = opts.onChange;
    const setW = () => wrap.style.setProperty('--item-w', (wrap.clientWidth - 8) / tabItems.length + 'px');
    setW();
    addEventListener('resize', setW);
    const index = Math.max(0, tabItems.findIndex(b => b.dataset.tab === opts.tab));
    tabs = Selector({
      host: wrap, pill, items: tabItems, index, pillH: 54,
      onSelect: (i, changed) => onChange && onChange(tabItems[i].dataset.tab, changed)
    });
    wrap.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight') { tabs.select(tabs.index + 1); tabItems[tabs.index].focus(); }
      if (e.key === 'ArrowLeft') { tabs.select(tabs.index - 1); tabItems[tabs.index].focus(); }
    });
    if (window.Liquid) Liquid.setEnabled(opts.refraction !== false);
  }

  /* ================================================================ selector segmentado */
  function segmented(el, onSelect) {
    if (!el || el._seg) return el && el._seg;
    const items = [...el.querySelectorAll('button')];
    let pill = el.querySelector('.seg-pill');
    if (!pill) { pill = document.createElement('div'); pill.className = 'seg-pill'; el.prepend(pill); }
    pill.setAttribute('data-glass', ''); pill.dataset.layer = '1';
    el.setAttribute('data-glass', ''); el.dataset.refract = '.4';   // el carril también es cristal
    el.setAttribute('role', 'tablist');
    items.forEach(b => b.setAttribute('role', 'tab'));
    const index = Math.max(0, items.findIndex(b => b.classList.contains('on')));
    el._seg = Selector({ host: el, pill, items, index, onSelect: (i, changed) => changed && onSelect && onSelect(i, items[i]) });
    return el._seg;
  }

  /* ================================================================ menú que nace de un botón */
  let menu = null;

  function closeMenu(after) {
    if (!menu) { after && after(); return; }
    menu.after = after || menu.after;
    menu.open = false;
    menu.kick();
  }

  function openMenu(btn, { title, sub, img, items = [] }) {
    if (menu) { menu.finish(); }
    const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const scrim = document.createElement('div');
    scrim.className = 'lg-menu-scrim';
    const shape = document.createElement('div');
    shape.className = 'lg-menu-shape';
    shape.setAttribute('data-glass', ''); shape.dataset.layer = '1';
    const box = document.createElement('div');
    box.className = 'lg-menu';
    box.setAttribute('role', 'menu');
    box.innerHTML = `<div class="lg-menu-in">${title ? `<div class="head">${img ? `<img src="${esc(img)}" alt="">` : ''}<div class="ellipsis"><b class="ellipsis">${esc(title)}</b><span class="muted ellipsis">${esc(sub || '')}</span></div></div>` : ''}</div>`;
    const inner = box.firstChild;
    items.filter(Boolean).forEach(it => {
      const b = document.createElement('button');
      b.className = 'it'; b.setAttribute('role', 'menuitem');
      b.innerHTML = `<svg class="ic"><use href="#i-${esc(it.icon || 'note')}"/></svg><span>${esc(it.label)}</span>`;
      b.onclick = () => closeMenu(it.fn);
      inner.appendChild(b);
    });
    document.body.append(scrim, shape, box);

    // tamaño y sitio final
    const vw = innerWidth, vh = innerHeight;
    const dock = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lg-dock')) || 0;
    const topMin = 12 + (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-top')) || 0);
    const botMax = vh - Math.max(dock, 12) - 8;
    const fw = Math.min(290, vw - 24);
    box.style.width = fw + 'px';
    const fh = Math.min(inner.scrollHeight, botMax - topMin);
    box.style.height = fh + 'px';
    const br = btn.getBoundingClientRect();
    let fx = clamp(br.right - fw, 12, vw - 12 - fw);
    let fy = br.bottom + 8 + fh <= botMax ? br.bottom + 8 : br.top - 8 - fh;
    fy = clamp(fy, topMin, botMax - fh);
    box.style.left = fx + 'px'; box.style.top = fy + 'px';

    const icon = btn.querySelector('svg') || btn;
    const app = [document.getElementById('app'), document.getElementById('view'), document.getElementById('now')];
    const docked = [document.getElementById('mini'), document.getElementById('tabwrap')];
    const p = { x: 0, v: 0 };
    let raf = 0, lastT = 0;
    const m = { open: true, after: null };
    menu = m;

    function frame(t) {
      raf = 0;
      let dt = lastT ? (t - lastT) / 1000 : 1 / 60;
      lastT = t; dt = Math.min(dt, 1 / 20);
      const goal = m.open ? 1 : 0;
      if (reduced()) { p.x = goal; p.v = 0; }
      else {
        const c = m.open ? { k: 250, z: .74 } : { k: 440, z: 1 };   // abrir ≈0,4 s con rebote mínimo; cerrar ≈0,3 s
        const steps = Math.ceil(dt * 240), h = dt / steps;
        for (let i = 0; i < steps; i++) spring(p, goal, c.k, c.z, h);
      }
      paint(p.x);
      const done = Math.abs(p.x - goal) < .002 && Math.abs(p.v) < .02;
      if (!done) raf = requestAnimationFrame(frame);
      else if (!m.open) finish();
      else paint(1);
    }
    function kick() { if (!raf) { lastT = 0; raf = requestAnimationFrame(frame); } }

    function paint(v) {
      const q = Math.max(0, v);
      // el ancho va por delante y la altura después
      const wf = q < 1 ? 1 - Math.pow(1 - q, 1.7) : q, hf = q < 1 ? Math.pow(q, 1.2) : q;
      const w = lerp(br.width, fw, wf), h = Math.max(1, lerp(br.height, fh, hf));
      const cx = lerp(br.left + br.width / 2, fx + fw / 2, wf), cyy = lerp(br.top + br.height / 2, fy + fh / 2, hf);
      const r = lerp(Math.min(w, h) / 2, Math.min(28, w / 2, h / 2), smooth(.55, 1, q));
      const s = shape.style;
      s.left = (cx - w / 2).toFixed(2) + 'px'; s.top = (cyy - h / 2).toFixed(2) + 'px';
      s.width = w.toFixed(2) + 'px'; s.height = h.toFixed(2) + 'px'; s.borderRadius = r.toFixed(2) + 'px';
      // cristal transparente con mucha refracción mientras crece; al final, esmerilado blanco
      const f = smooth(.62, 1, q);
      const d = shape.dataset;
      d.tint = dark() ? `46,46,52,${(.84 * f).toFixed(3)}` : `255,255,255,${(.86 * f).toFixed(3)}`;
      d.blur = lerp(0, 3, f).toFixed(3);
      d.refract = lerp(1.7, .12, f).toFixed(3);
      d.ab = lerp(1.2, .3, f).toFixed(3);
      d.opacity = clamp(q * 4, 0, 1).toFixed(3);
      shape.style.setProperty('--f', f.toFixed(3));
      // opciones quietas en su sitio, recortadas por la forma; empiezan desenfocadas y un 9 % más grandes
      const l = cx - w / 2 - fx, tp = cyy - h / 2 - fy;
      box.style.clipPath = `inset(${tp.toFixed(1)}px ${(fw - l - w).toFixed(1)}px ${(fh - tp - h).toFixed(1)}px ${l.toFixed(1)}px round ${r.toFixed(1)}px)`;
      const c = smooth(.18, 1, q);
      inner.style.filter = c < .999 ? `blur(${(9 * (1 - c)).toFixed(2)}px)` : '';
      inner.style.transform = `scale(${(1.09 - .09 * c).toFixed(4)})`;
      inner.style.opacity = smooth(.05, .5, q).toFixed(3);
      // el icono del botón se desenfoca y desaparece
      const ic = clamp(q * 2.2, 0, 1);
      icon.style.filter = ic > .001 ? `blur(${(5 * ic).toFixed(2)}px)` : '';
      icon.style.opacity = (1 - ic).toFixed(3);
      // atenuar (y vaciar bajo el menú) el contenido HTML, que está encima del cristal
      const dimv = clamp(q, 0, 1);
      if (window.Liquid) Liquid.setDim(dimv);
      const a = (1 - .5 * dimv).toFixed(3);
      if (window.Liquid && Liquid.active) {
        // máscara con un agujero con la forma del menú, en coordenadas de cada capa
        app.forEach(el => {
          if (!el) return;
          const er = el.getBoundingClientRect();
          if (!er.width || !er.height) return;
          const X = cx - w / 2 - er.left, Y = cyy - h / 2 - er.top, rr = r, EW = er.width, EH = er.height;
          const path = `M0 0H${EW}V${EH}H0Z M${X + rr} ${Y}H${X + w - rr}A${rr} ${rr} 0 0 1 ${X + w} ${Y + rr}V${Y + h - rr}A${rr} ${rr} 0 0 1 ${X + w - rr} ${Y + h}H${X + rr}A${rr} ${rr} 0 0 1 ${X} ${Y + h - rr}V${Y + rr}A${rr} ${rr} 0 0 1 ${X + rr} ${Y}Z`;
          const url = `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${EW}' height='${EH}'><path fill-rule='evenodd' fill='black' fill-opacity='${a}' d='${path}'/></svg>`)}")`;
          el.style.maskImage = el.style.webkitMaskImage = url; el.style.maskSize = el.style.webkitMaskSize = '100% 100%';
        });
      } else app.forEach(el => { if (el) el.style.opacity = a; });
      docked.forEach(el => { if (el) el.style.opacity = a; });
    }

    function finish() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      scrim.remove(); shape.remove(); box.remove();
      icon.style.filter = ''; icon.style.opacity = '';
      app.forEach(el => { if (el) { el.style.maskImage = el.style.webkitMaskImage = ''; el.style.maskSize = el.style.webkitMaskSize = ''; el.style.opacity = ''; } });
      docked.forEach(el => { if (el) el.style.opacity = ''; });
      if (window.Liquid) Liquid.setDim(0);
      removeEventListener('keydown', onKey, true);
      if (menu === m) menu = null;
      const fn = m.after; m.after = null;
      fn && fn();
    }
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeMenu(); } }

    m.kick = kick; m.finish = finish;
    scrim.addEventListener('pointerdown', e => { e.preventDefault(); closeMenu(); });
    addEventListener('keydown', onKey, true);
    paint(0);
    kick();
    setTimeout(() => { const f = box.querySelector('.it'); f && f.focus({ preventScroll: true }); }, 60);
  }

  return {
    init, segmented, Selector,
    menu: openMenu, closeMenu,
    get menuOpen() { return !!menu; },
    setRefraction(on) { if (window.Liquid) Liquid.setEnabled(on); },
    select: name => { const i = tabItems.findIndex(b => b.dataset.tab === name); if (i >= 0 && tabs) tabs.select(i); },
    get supported() { return !!(window.Liquid && Liquid.supported); },
    get tab() { return tabs && tabItems[tabs.index] && tabItems[tabs.index].dataset.tab; }
  };
})();
window.Glass = Glass;
