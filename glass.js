'use strict';
/* glass.js — barra flotante "Liquid Glass" al estilo iOS 26.
   - Refracción en directo con CSS backdrop-filter (en Chromium, además, un filtro SVG
     con mapa de desplazamiento: bisel, aumento y dispersión cromática).
   - Píldora que se desliza entre pestañas y se puede arrastrar.
   - Bajo la píldora, el icono se ve azul (#0A84FF) solo en la parte cubierta: dentro de la
     píldora hay una copia azul de la fila de iconos, alineada con la de abajo, y la fila de
     abajo tiene un "agujero" (máscara) justo donde está la píldora.
   - Al cogerla, la lente crece (1,33× de ancho), aumenta lo que hay debajo (1,25×) y se
     estira un poco en la dirección del movimiento (máx. 7 %), con muelles amortiguados. */
const Glass = (() => {
  // Medidas y parámetros (medidos contra iOS real y el kit de Figma)
  const P = {
    inset: 4,            // margen entre la barra y la cápsula
    pillH: 54,           // alto de la cápsula
    pressW: 1.33,        // ancho de la lente al cogerla
    pressH: 1.16,        // alto de la lente al cogerla
    mag: 1.25,           // aumento de la lente
    bevel: 9,            // ancho del bisel (px)
    refraction: .7,
    dispersion: .2,      // ±20 % entre canales R y B
    frost: 6,            // esmerilado de la barra
    light: .25,          // luz de canto
    stretchMax: .07,     // estiramiento máximo (antes se estiraba demasiado)
    stretchPerPx: 1 / 28000, // estiramiento por px/s de velocidad
    squash: .5           // cuánto se estrecha en vertical al estirarse
  };
  // Muelles: rigidez k y amortiguación z (1 = sin rebote)
  const SPR = {
    snap:  { k: 380, z: .86 },  // ir a una pestaña
    drag:  { k: 1100, z: 1 },   // seguir al dedo
    press: { k: 520, z: .7 },   // crecer/encoger la lente (un pelín de rebote)
    stretch: { k: 700, z: 1 }
  };

  let wrap, bar, base, pill, lens, clone, items = [], N = 0;
  let W = 0, H = 62, itemW = 0, index = 0, onChange = null;
  const pos = { x: 0, v: 0, t: 0, mode: 'snap' };
  const press = { x: 0, v: 0, t: 0 };
  const stretch = { x: 0, v: 0, t: 0 };
  let raf = 0, lastT = 0, drag = null, pulseTimer = 0;
  let refract = false, filt = null;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const center = i => P.inset + itemW * (i + .5);

  function isChromium() {
    const ua = navigator.userAgent;
    return /Chrom(e|ium)\/\d+/.test(ua) && !/iPhone|iPad|iPod/.test(ua);
  }

  /* ---------- mapas de desplazamiento para el filtro SVG ---------- */
  // Cápsula/rectángulo redondeado: devuelve dataURL y escala para feDisplacementMap
  function makeMap(w, h, r, kind) {
    w = Math.max(2, Math.round(w)); h = Math.max(2, Math.round(h));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(w, h), d = img.data;
    const cx = w / 2, cy = h / 2, hx = w / 2, hy = h / 2;
    const dx = new Float32Array(w * h), dy = new Float32Array(w * h);
    let max = 1e-6;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const px = x + .5 - cx, py = y + .5 - cy, i = y * w + x;
      if (kind === 'mag') {
        // aumento: se muestrea más cerca del centro
        dx[i] = -px; dy[i] = -py;
      } else {
        const qx = Math.abs(px) - (hx - r), qy = Math.abs(py) - (hy - r);
        const out = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
        const sdf = out + Math.min(Math.max(qx, qy), 0) - r;   // < 0 dentro
        const dist = -sdf;
        if (dist <= 0 || dist >= P.bevel) continue;
        let nx, ny;
        if (qx > 0 && qy > 0) { const l = Math.hypot(qx, qy) || 1; nx = qx / l * Math.sign(px); ny = qy / l * Math.sign(py); }
        else if (qx > qy) { nx = Math.sign(px); ny = 0; }
        else { nx = 0; ny = Math.sign(py); }
        const t = 1 - dist / P.bevel;
        const bend = t * t * (3 - 2 * t);               // suave hacia dentro, fuerte en el canto
        // el canto comprime hacia dentro lo que hay debajo (lente convexa); se muestrea hacia
        // el interior para no leer fuera del cristal, que daría bordes de colores
        dx[i] = -nx * bend; dy[i] = -ny * bend;
      }
      max = Math.max(max, Math.abs(dx[i]), Math.abs(dy[i]));
    }
    for (let i = 0; i < w * h; i++) {
      d[i * 4] = 128 + Math.round(127 * dx[i] / max);
      d[i * 4 + 1] = 128 + Math.round(127 * dy[i] / max);
      d[i * 4 + 2] = 128; d[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    // desplazamiento máximo en px
    const px = kind === 'mag' ? Math.max(hx, hy) * (1 - 1 / P.mag) : P.bevel * 1.6 * P.refraction;
    return { url: cv.toDataURL(), scale: 2 * px, w, h };
  }

  function filterSVG(id, w, h, r, blur, withMag) {
    const b = makeMap(w, h, r, 'bevel');
    const m = withMag ? makeMap(w, h, r, 'mag') : null;
    const s = b.scale, D = P.dispersion;
    const keep = c => ({ r: '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0', g: '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0', b: '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0' }[c]);
    return {
      bevel: s, mag: m ? m.scale : 0,
      html: `<filter id="${id}" x="0" y="0" width="${b.w}" height="${b.h}" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
  <feGaussianBlur in="SourceGraphic" stdDeviation="${blur}" result="src"/>
  <feImage href="${b.url}" x="0" y="0" width="${b.w}" height="${b.h}" preserveAspectRatio="none" result="bm"/>
  ${m ? `<feImage href="${m.url}" x="0" y="0" width="${m.w}" height="${m.h}" preserveAspectRatio="none" result="mm"/>
  <feDisplacementMap data-k="mag" in="src" in2="mm" scale="0" xChannelSelector="R" yChannelSelector="G" result="mg"/>` : ''}
  <feDisplacementMap data-k="r" in="${m ? 'mg' : 'src'}" in2="bm" scale="${s * (1 + D)}" xChannelSelector="R" yChannelSelector="G" result="dr"/>
  <feColorMatrix in="dr" type="matrix" values="${keep('r')}" result="cr"/>
  <feDisplacementMap data-k="g" in="${m ? 'mg' : 'src'}" in2="bm" scale="${s}" xChannelSelector="R" yChannelSelector="G" result="dg"/>
  <feColorMatrix in="dg" type="matrix" values="${keep('g')}" result="cg"/>
  <feDisplacementMap data-k="b" in="${m ? 'mg' : 'src'}" in2="bm" scale="${s * (1 - D)}" xChannelSelector="R" yChannelSelector="G" result="db"/>
  <feColorMatrix in="db" type="matrix" values="${keep('b')}" result="cb"/>
  <feBlend in="cr" in2="cg" mode="screen" result="rg"/>
  <feBlend in="rg" in2="cb" mode="screen"/>
</filter>`
    };
  }

  function buildFilters() {
    const defs = document.getElementById('glass-defs');
    if (!defs) return;
    if (!refract) {
      defs.innerHTML = '';
      bar.style.backdropFilter = bar.style.webkitBackdropFilter = '';
      pill.style.backdropFilter = pill.style.webkitBackdropFilter = '';
      pill.classList.add('glass');
      filt = null;
      return;
    }
    const fb = filterSVG('g-bar', W, H, H / 2, P.frost / 2, false);
    const fp = filterSVG('g-pill', itemW, P.pillH, P.pillH / 2, .6, true);
    defs.innerHTML = fb.html + fp.html;
    bar.style.backdropFilter = 'url(#g-bar) saturate(1.8)';
    pill.classList.remove('glass');
    pill.style.backdropFilter = 'url(#g-pill) saturate(1.5) brightness(1.04)';
    // Si el navegador no acepta url() en backdrop-filter, se queda el desenfoque de la hoja de estilos
    if (!pill.style.backdropFilter) pill.classList.add('glass');
    const f = defs.querySelector('#g-pill');
    filt = {
      bevel: fp.bevel, mag: fp.mag,
      nodes: { mag: f.querySelector('[data-k=mag]'), r: f.querySelector('[data-k=r]'), g: f.querySelector('[data-k=g]'), b: f.querySelector('[data-k=b]') },
      lastP: -1
    };
  }

  /* ---------- dibujo ---------- */
  function render() {
    const p = press.x, s = Math.max(0, stretch.x);
    const sxs = (1 + (P.pressW - 1) * p) * (1 + s);
    const sys = (1 + (P.pressH - 1) * p) * (1 - s * P.squash);
    const cx = pos.x, cy = P.inset + P.pillH / 2;
    pill.style.transform = `translate3d(${(cx - itemW / 2).toFixed(2)}px,0,0) scale(${sxs.toFixed(4)},${sys.toFixed(4)})`;
    // copia azul: alineada con la fila de abajo y aumentada m× alrededor del centro de la lente
    const m = 1 + (P.mag - 1) * clamp(p, 0, 1.2);
    const kx = m / sxs, ky = m / sys;
    const tx = itemW / 2 - kx * cx, ty = P.pillH / 2 - ky * cy;
    clone.style.transform = `translate3d(${tx.toFixed(2)}px,${ty.toFixed(2)}px,0) scale(${kx.toFixed(4)},${ky.toFixed(4)})`;
    // agujero en la fila de abajo donde está la lente
    const half = itemW * sxs / 2 - .5, a = cx - half, b = cx + half;
    base.style.setProperty('--hole', `linear-gradient(90deg,#000 ${(a - 1).toFixed(1)}px,transparent ${a.toFixed(1)}px,transparent ${b.toFixed(1)}px,#000 ${(b + 1).toFixed(1)}px)`);
    pill.classList.toggle('press', p > .25);
    if (filt && Math.abs(filt.lastP - p) > .004) {
      filt.lastP = p;
      const pc = clamp(p, 0, 1.15);
      const bv = filt.bevel * (.35 + .65 * pc);
      filt.nodes.mag && filt.nodes.mag.setAttribute('scale', (filt.mag * pc).toFixed(2));
      filt.nodes.r.setAttribute('scale', (bv * (1 + P.dispersion)).toFixed(2));
      filt.nodes.g.setAttribute('scale', bv.toFixed(2));
      filt.nodes.b.setAttribute('scale', (bv * (1 - P.dispersion)).toFixed(2));
    }
  }

  function spring(s, c, dt) {
    const k = c.k, damp = 2 * c.z * Math.sqrt(k);
    const a = -k * (s.x - s.t) - damp * s.v;
    s.v += a * dt; s.x += s.v * dt;
  }

  function tick(t) {
    raf = 0;
    let dt = lastT ? (t - lastT) / 1000 : 1 / 60;
    lastT = t;
    dt = Math.min(dt, 1 / 20);
    const steps = Math.ceil(dt / (1 / 240)), h = dt / steps;
    for (let i = 0; i < steps; i++) {
      spring(pos, pos.mode === 'drag' ? SPR.drag : SPR.snap, h);
      spring(press, SPR.press, h);
      stretch.t = clamp(Math.abs(pos.v) * P.stretchPerPx, 0, P.stretchMax);
      spring(stretch, SPR.stretch, h);
    }
    render();
    const settled = Math.abs(pos.x - pos.t) < .05 && Math.abs(pos.v) < 2 &&
      Math.abs(press.x - press.t) < .002 && Math.abs(press.v) < .01 && Math.abs(stretch.x) < .0005;
    if (!settled || drag) raf = requestAnimationFrame(tick);
    else { pos.x = pos.t; press.x = press.t; stretch.x = 0; pos.v = press.v = stretch.v = 0; render(); lastT = 0; }
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };

  /* ---------- interacción ---------- */
  function select(i, emit = true, animate = true) {
    i = clamp(i, 0, N - 1);
    const changed = i !== index;
    index = i;
    pos.t = center(i); pos.mode = 'snap';
    if (!animate) { pos.x = pos.t; pos.v = 0; render(); }
    items.forEach((b, j) => b.setAttribute('aria-selected', j === i ? 'true' : 'false'));
    kick();
    if (emit && onChange) onChange(items[i].dataset.tab, changed);
  }

  function localX(e) { return e.clientX - wrap.getBoundingClientRect().left; }
  function rubber(t) {
    const lo = center(0), hi = center(N - 1);
    if (t < lo) return lo - (lo - t) * .28;
    if (t > hi) return hi + (t - hi) * .28;
    return t;
  }

  function onDown(e) {
    if (e.button !== 0) return;
    const x = localX(e);
    const onPill = Math.abs(x - pos.x) < itemW / 2 + 4;
    drag = { id: e.pointerId, x0: x, c0: pos.x, onPill, moved: false };
    try { wrap.setPointerCapture(e.pointerId); } catch (_) {}
    clearTimeout(pulseTimer);
    if (onPill) { press.t = 1; pos.mode = 'drag'; pos.t = pos.x; }
    kick();
  }
  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const x = localX(e), dx = x - drag.x0;
    if (!drag.moved && Math.abs(dx) > 6) {
      drag.moved = true;
      if (!drag.onPill) { press.t = 1; pos.mode = 'drag'; drag.c0 = x - dx; drag.follow = true; }
    }
    if (drag.moved || drag.onPill) {
      const target = drag.follow ? x : drag.c0 + dx;
      pos.t = rubber(target);
      kick();
    }
  }
  function onUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    const x = localX(e);
    let i;
    if (d.moved || d.onPill) {
      // proyecta un poco la velocidad para que un "lanzamiento" corto cambie de pestaña
      const proj = pos.x + clamp(pos.v, -1500, 1500) * .08;
      i = Math.round((proj - P.inset - itemW / 2) / itemW);
    } else {
      i = Math.floor((x - P.inset) / itemW);
    }
    press.t = d.moved || d.onPill ? 0 : 1;
    if (!(d.moved || d.onPill)) pulseTimer = setTimeout(() => { press.t = 0; kick(); }, 160); // tocar: la lente "salta" mientras viaja
    select(i);
  }

  function layout() {
    W = wrap.clientWidth; H = wrap.clientHeight || 62;
    itemW = (W - 2 * P.inset) / N;
    wrap.style.setProperty('--item-w', itemW + 'px');
    pos.x = pos.t = center(index);
    buildFilters();
    render();
  }

  function init(opts = {}) {
    wrap = document.getElementById('tabwrap');
    bar = wrap.querySelector('.tb-bar');
    base = wrap.querySelector('.tb-base');
    pill = wrap.querySelector('.tb-pill');
    lens = pill.querySelector('.tb-lens');
    clone = base.cloneNode(true);
    clone.className = 'tb-row tb-active';
    clone.setAttribute('aria-hidden', 'true');
    clone.querySelectorAll('button').forEach(b => { b.tabIndex = -1; b.removeAttribute('role'); });
    lens.appendChild(clone);
    items = [...base.querySelectorAll('.tb-item')];
    N = items.length;
    onChange = opts.onChange;
    refract = opts.refraction !== false && isChromium();
    index = Math.max(0, items.findIndex(b => b.dataset.tab === opts.tab));
    wrap.style.setProperty('--glass-light', P.light);

    wrap.addEventListener('pointerdown', onDown);
    wrap.addEventListener('pointermove', onMove);
    wrap.addEventListener('pointerup', onUp);
    wrap.addEventListener('pointercancel', e => { if (drag) { drag = null; press.t = 0; select(index, false); } });
    // teclado: Enter/Espacio en un botón (los clics de ratón ya los gestiona el puntero)
    items.forEach((b, i) => b.addEventListener('click', e => { if (e.detail === 0) select(i); }));
    wrap.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight') { select(index + 1); items[index].focus(); }
      if (e.key === 'ArrowLeft') { select(index - 1); items[index].focus(); }
    });
    let rt = 0;
    addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(layout, 120); });
    layout();
    select(index, false, false);
  }

  function setRefraction(on) { refract = !!on && isChromium(); buildFilters(); render(); }

  return {
    init, setRefraction, P,
    select: name => { const i = items.findIndex(b => b.dataset.tab === name); if (i >= 0) select(i); },
    get supported() { return isChromium(); },
    get tab() { return items[index] && items[index].dataset.tab; }
  };
})();
