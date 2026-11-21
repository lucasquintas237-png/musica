'use strict';
/* glass.js — barra de navegación "Liquid Glass" (el dibujo lo hace liquid.js); es el único
   elemento de cristal de la app. Píldora de selección arrastrable con física: sigue al dedo,
   al soltar va con un muelle a la opción más cercana, se estira con la velocidad (gelatina,
   conservando volumen), goma en los bordes y, al cogerla, se levanta y se vuelve una lente
   limpia con lupa. */
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
      pillH = typeof o.pillH === 'function' ? o.pillH() : (o.pillH || r0.height);
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
      host: wrap, pill, items: tabItems, index, pillH: () => wrap.clientHeight - 8,
      onSelect: (i, changed) => onChange && onChange(tabItems[i].dataset.tab, changed)
    });
    wrap.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight') { tabs.select(tabs.index + 1); tabItems[tabs.index].focus(); }
      if (e.key === 'ArrowLeft') { tabs.select(tabs.index - 1); tabItems[tabs.index].focus(); }
    });
    if (window.Liquid) Liquid.setEnabled(opts.refraction !== false);
  }

  return {
    init, Selector,
    setRefraction(on) { if (window.Liquid) Liquid.setEnabled(on); },
    select: name => { const i = tabItems.findIndex(b => b.dataset.tab === name); if (i >= 0 && tabs) tabs.select(i); },
    get supported() { return !!(window.Liquid && Liquid.supported); },
    get tab() { return tabs && tabItems[tabs.index] && tabItems[tabs.index].dataset.tab; }
  };
})();
window.Glass = Glass;
