'use strict';
/* refract.js — cristal líquido POR ENCIMA del contenido (refracta lo que pasa por detrás).
   La barra de navegación, su píldora y un marco fino alrededor de toda la pantalla usan
   backdrop-filter con un filtro SVG de desplazamiento: un mapa (generado aquí en un canvas)
   desvía los píxeles de lo que hay detrás cerca de los bordes, como el canto de una lente.
   Encima, brillos en el filo (CSS). Funciona en navegadores Chromium (Chrome, Edge, Android);
   en el resto queda como cristal desenfocado. El fondo animado lo sigue pintando liquid.js. */
const Refract = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  // refracción real solo donde backdrop-filter acepta filtros SVG (Chromium)
  const ok = !!window.chrome && !!(window.CSS && CSS.supports && CSS.supports('backdrop-filter', 'url(#a) blur(1px)'));
  let svg = null, enabled = true, frameOn = true;
  const root = document.documentElement;

  function defs() {
    if (svg) return svg.firstChild;
    svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    svg.appendChild(document.createElementNS(NS, 'defs'));
    document.body.appendChild(svg);
    return svg.firstChild;
  }

  /* Mapa de desplazamiento de un rectángulo redondeado de w×h (radio r): dentro de la franja
     "bezel" junto al borde, cada píxel apunta hacia dentro (R = x, G = y; 128 = sin mover) con
     más fuerza cuanto más cerca del filo. Así lo de detrás se comprime y se curva en el canto. */
  function roundedMap(w, h, r, bezel, sides) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d'), img = ctx.createImageData(w, h), d = img.data;
    const hw = w / 2, hh = h / 2;
    r = Math.min(r, hw, hh);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = x + .5 - hw, py = y + .5 - hh;
        let inside, nx, ny;
        if (sides) {
          // franja del marco de la pantalla: solo cuenta la distancia al borde de la pantalla
          if (sides.t) { inside = y; nx = 0; ny = -1; }
          else if (sides.b) { inside = h - 1 - y; nx = 0; ny = 1; }
          else if (sides.l) { inside = x; nx = -1; ny = 0; }
          else { inside = w - 1 - x; nx = 1; ny = 0; }
        } else {
          // distancia al borde del rectángulo redondeado y normal hacia fuera
          const qx = Math.abs(px) - (hw - r), qy = Math.abs(py) - (hh - r);
          let dist;
          if (qx > 0 && qy > 0) { const l = Math.hypot(qx, qy) || 1; dist = l - r; nx = qx / l * Math.sign(px); ny = qy / l * Math.sign(py); }
          else if (qx > qy) { dist = qx - r; nx = Math.sign(px); ny = 0; }
          else { dist = qy - r; nx = 0; ny = Math.sign(py); }
          inside = -dist;
        }
        let m = 0;
        if (inside < bezel) { const t = 1 - Math.max(0, inside) / bezel; m = t * t * (3 - 2 * t); }
        const i = (y * w + x) * 4;
        d[i] = 128 - nx * m * 127; d[i + 1] = 128 - ny * m * 127; d[i + 2] = 128; d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL();
  }

  // crea (o rehace) el filtro SVG para un elemento de ese tamaño
  function filter(id, w, h, r, o) {
    const df = defs();
    let f = df.querySelector('#' + id);
    if (!f) { f = document.createElementNS(NS, 'filter'); f.id = id; df.appendChild(f); }
    f.setAttribute('x', 0); f.setAttribute('y', 0); f.setAttribute('width', w); f.setAttribute('height', h);
    f.setAttribute('filterUnits', 'userSpaceOnUse'); f.setAttribute('primitiveUnits', 'userSpaceOnUse');
    f.setAttribute('color-interpolation-filters', 'sRGB');
    const map = roundedMap(w, h, r, o.bezel || Math.min(w, h), o.sides);
    // aberración cromática: el rojo y el azul se desvían un poco distinto
    const ab = o.ab || 0;
    f.innerHTML = `<feImage href="${map}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="m"/>
      <feGaussianBlur in="SourceGraphic" stdDeviation="${o.blur || 0}" result="s"/>
      <feDisplacementMap in="s" in2="m" scale="${o.scale * (1 + ab)}" xChannelSelector="R" yChannelSelector="G" result="dr"/>
      <feDisplacementMap in="s" in2="m" scale="${o.scale}" xChannelSelector="R" yChannelSelector="G" result="dg"/>
      <feDisplacementMap in="s" in2="m" scale="${o.scale * (1 - ab)}" xChannelSelector="R" yChannelSelector="G" result="db"/>
      <feColorMatrix in="dr" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r"/>
      <feColorMatrix in="dg" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g"/>
      <feColorMatrix in="db" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b"/>
      <feBlend in="r" in2="g" mode="screen" result="rg"/><feBlend in="rg" in2="b" mode="screen"/>`;
    return `url(#${id})`;
  }

  /* Elementos de cristal: se les pone el filtro y se rehace al cambiar de tamaño */
  const items = [];
  function watch(el, id, opts) {
    const it = { el, id, opts, w: 0, h: 0 };
    items.push(it);
    const ro = new ResizeObserver(() => refresh(it));
    ro.observe(el);
    refresh(it);
  }
  function refresh(it) {
    const w = Math.round(it.el.offsetWidth), h = Math.round(it.el.offsetHeight);
    if (!w || !h) return;
    const live = ok && enabled && (it.opts.frame ? frameOn : true);
    if (!live) { it.el.style.removeProperty('backdrop-filter'); it.el.style.removeProperty('-webkit-backdrop-filter'); it.w = 0; return; }
    if (w === it.w && h === it.h) return;
    it.w = w; it.h = h;
    const r = typeof it.opts.radius === 'function' ? it.opts.radius() : it.opts.radius;
    // el desplazamiento nunca puede ir a buscar píxeles fuera del propio cristal (si no, salen
    // franjas de color en el canto): como mucho, lo que mide de grueso
    const thick = it.opts.sides ? Math.min(w, h) : Math.min(w, h) / 2;
    const o = { ...it.opts, scale: Math.min(it.opts.scale, 1.6 * (thick - 1) / (1 + (it.opts.ab || 0))) };
    const f = filter(it.id, w, h, r, o) + (it.opts.extra ? ' ' + it.opts.extra : '');
    it.el.style.setProperty('backdrop-filter', f);
  }
  const refreshAll = () => items.forEach(it => { it.w = 0; refresh(it); });

  /* marco de cristal alrededor de toda la pantalla: cuatro franjas finas en los bordes */
  function frame() {
    const f = document.createElement('div');
    f.id = 'lg-frame';
    f.setAttribute('aria-hidden', 'true');
    f.innerHTML = '<i class="e t"></i><i class="e b"></i><i class="e l"></i><i class="e r"></i>';
    document.body.appendChild(f);
    const side = { t: { t: 1 }, b: { b: 1 }, l: { l: 1 }, r: { r: 1 } };
    f.querySelectorAll('.e').forEach(e => {
      const k = [...e.classList].find(c => side[c]);
      watch(e, 'lgf-edge-' + k, { frame: true, radius: 0, scale: 26, blur: .6, ab: .25, sides: side[k], extra: 'saturate(1.25)' });
    });
    return f;
  }

  function init(opts = {}) {
    enabled = opts.refraction !== false;
    frameOn = opts.frame !== false;
    root.classList.toggle('cg-refract', ok && enabled);
    root.classList.toggle('cg-frame', frameOn);
    const bar = document.querySelector('#tabwrap .tb-bar'), pill = document.querySelector('#tabwrap .tb-pill');
    if (bar) watch(bar, 'lgf-bar', { radius: () => bar.offsetHeight / 2, bezel: 16, scale: 34, blur: 2.2, ab: .2, extra: 'saturate(1.5) brightness(1.04)' });
    if (pill) watch(pill, 'lgf-pill', { radius: () => pill.offsetHeight / 2, bezel: 14, scale: 30, blur: .4, ab: .3, extra: 'saturate(1.4) brightness(1.12)' });
    frame();
  }

  return {
    init,
    get supported() { return ok; },
    setEnabled(on) { enabled = on; root.classList.toggle('cg-refract', ok && on); refreshAll(); },
    setFrame(on) { frameOn = on; root.classList.toggle('cg-frame', on); refreshAll(); }
  };
})();
window.Refract = Refract;
