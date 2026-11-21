'use strict';
/* m3.js — Material 3 Expressive: color dinámico sacado de la portada,
   fondo de tres capas desenfocadas y barra de progreso ondulada. */
const M3 = (() => {
  const root = document.documentElement;
  let enabled = true;
  let last = null;          // {h,s,l} del último color extraído
  let lastCover = '';

  function rgb2hsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l];
    const d = mx - mn, s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
    let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }

  // Busca el tono "con más presencia" de la portada, premiando los colores saturados.
  function extract(url) {
    return new Promise(resolve => {
      if (!url) return resolve(null);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const N = 40, c = document.createElement('canvas');
          c.width = c.height = N;
          const x = c.getContext('2d', { willReadFrequently: true });
          x.drawImage(img, 0, 0, N, N);
          const d = x.getImageData(0, 0, N, N).data;
          const B = 24, buckets = Array.from({ length: B }, () => ({ w: 0, sx: 0, sy: 0, s: 0, l: 0 }));
          let gw = 0, gl = 0;
          for (let i = 0; i < d.length; i += 4) {
            const [h, s, l] = rgb2hsl(d[i], d[i + 1], d[i + 2]);
            gw++; gl += l;
            if (l < .08 || l > .94 || s < .12) continue;
            const w = s * s * (1 - Math.abs(l - .5) * 1.3) + .02;
            const b = buckets[Math.floor(h / (360 / B)) % B];
            const rad = h * Math.PI / 180;
            b.w += w; b.sx += Math.cos(rad) * w; b.sy += Math.sin(rad) * w; b.s += s * w; b.l += l * w;
          }
          // sumar vecinos para no partir un tono entre dos cubos
          let best = null, bw = 0;
          buckets.forEach((b, i) => {
            const n = buckets[(i + 1) % B], p = buckets[(i + B - 1) % B];
            const w = b.w + (n.w + p.w) * .5;
            if (w > bw) { bw = w; best = b; }
          });
          if (!best || best.w < 2) return resolve({ h: last ? last.h : 220, s: .06, l: gl / gw });
          let h = Math.atan2(best.sy, best.sx) * 180 / Math.PI; if (h < 0) h += 360;
          resolve({ h, s: best.s / best.w, l: best.l / best.w });
        } catch (e) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = '/api/img?u=' + encodeURIComponent(url);
    });
  }

  function isDark() { return root.dataset.theme !== 'light'; }

  // Paleta tonal de Material 3 (aproximación HSL a los tonos de primario, secundario,
  // terciario y las superficies, todas teñidas con el tono de la portada)
  function applyColor(c) {
    if (!c || !enabled) c = { h: 214, s: .7, l: .5 };
    last = c;
    const h = Math.round(c.h), s = Math.round(Math.min(90, Math.max(c.s < .1 ? 8 : 38, c.s * 100)));
    const s2 = Math.round(s * .38), s3 = Math.round(s * .55), sn = Math.min(14, Math.round(s * .2)), t = (h + 60) % 360;
    const hsl = (hh, ss, ll, a) => a == null ? `hsl(${hh} ${ss}% ${ll}%)` : `hsl(${hh} ${ss}% ${ll}% / ${a})`;
    const dark = isDark();
    const v = dark ? {
      'primary': hsl(h, s, 80), 'on-primary': hsl(h, Math.min(s, 70), 18), 'primary-container': hsl(h, Math.min(s, 55), 30), 'on-primary-container': hsl(h, s, 91),
      'secondary-container': hsl(h, s2, 26), 'on-secondary-container': hsl(h, s2, 90),
      'tertiary-container': hsl(t, s3, 28), 'on-tertiary-container': hsl(t, s3, 91),
      'surface': hsl(h, sn, 6.5), 'surface-c-low': hsl(h, sn, 9.5), 'surface-c': hsl(h, sn, 11.5), 'surface-c-high': hsl(h, sn, 15), 'surface-c-highest': hsl(h, sn, 19),
      'on-surface': hsl(h, sn, 91), 'on-surface-variant': hsl(h, sn, 76), 'outline': hsl(h, sn, 57), 'outline-variant': hsl(h, sn, 29),
      'inverse-surface': hsl(h, sn, 90), 'inverse-on-surface': hsl(h, sn, 18),
      'shade-top': hsl(h, sn, 6.5, .72), 'shade-bot': hsl(h, sn, 6.5, .95)
    } : {
      'primary': hsl(h, s, 38), 'on-primary': '#fff', 'primary-container': hsl(h, s, 90), 'on-primary-container': hsl(h, Math.min(s, 70), 14),
      'secondary-container': hsl(h, s2 + 10, 87), 'on-secondary-container': hsl(h, s2, 15),
      'tertiary-container': hsl(t, s3, 88), 'on-tertiary-container': hsl(t, s3, 15),
      'surface': hsl(h, sn + 20, 98), 'surface-c-low': hsl(h, sn + 14, 95.5), 'surface-c': hsl(h, sn + 12, 93.5), 'surface-c-high': hsl(h, sn + 10, 91), 'surface-c-highest': hsl(h, sn + 8, 88.5),
      'on-surface': hsl(h, sn, 11), 'on-surface-variant': hsl(h, sn, 30), 'outline': hsl(h, sn, 48), 'outline-variant': hsl(h, sn, 80),
      'inverse-surface': hsl(h, sn, 19), 'inverse-on-surface': hsl(h, sn + 10, 95),
      'shade-top': hsl(h, sn + 20, 98, .7), 'shade-bot': hsl(h, sn + 20, 98, .95)
    };
    // negro puro (OLED) y alto contraste, por encima de la paleta
    const opt = typeof store !== 'undefined' ? store.get('settings', {}) : {};
    if (dark && opt.amoled) Object.assign(v, {
      'surface': '#000000', 'surface-c-low': '#0b0b0d', 'surface-c': '#111114', 'surface-c-high': '#18181c', 'surface-c-highest': '#222228',
      'shade-top': 'rgba(0,0,0,.82)', 'shade-bot': 'rgba(0,0,0,.97)'
    });
    if (opt.contrast) Object.assign(v, { 'on-surface-variant': v['on-surface'], 'outline-variant': v['outline'] });
    Object.entries(v).forEach(([k, val]) => root.style.setProperty('--' + k, val));
    root.style.setProperty('--bg', v.surface);
    const meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.content = v.surface;
  }

  /* Menú de Material 3 que sale del botón pulsado (escala desde su esquina). */
  let menuState = null;
  function closeMenu(after) {
    const m = menuState;
    if (!m) { after && after(); return; }
    menuState = null;
    m.box.classList.remove('in');
    m.box.classList.add('out');
    removeEventListener('keydown', m.onKey, true);
    removeEventListener('resize', m.onResize);
    const done = () => { m.scrim.remove(); m.box.remove(); after && after(); };
    matchMedia('(prefers-reduced-motion: reduce)').matches ? done() : setTimeout(done, 150);
  }
  function menu(btn, { title, sub, img, items = [] }) {
    if (menuState) { const m = menuState; menuState = null; m.scrim.remove(); m.box.remove(); }
    const e = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const scrim = document.createElement('div');
    scrim.className = 'm3-scrim';
    const box = document.createElement('div');
    box.className = 'm3-menu';
    box.setAttribute('role', 'menu');
    if (title) box.innerHTML = `<div class="head">${img ? `<img src="${e(img)}" alt="">` : ''}<div class="ellipsis"><b class="ellipsis">${e(title)}</b><span class="muted ellipsis">${e(sub || '')}</span></div></div>`;
    items.filter(Boolean).forEach((it, i) => {
      const b = document.createElement('button');
      b.className = 'mi'; b.setAttribute('role', 'menuitem'); b.style.setProperty('--i', i);
      b.innerHTML = `<svg class="ic"><use href="#i-${e(it.icon || 'note')}"/></svg><span class="ellipsis">${e(it.label)}</span>`;
      b.onclick = () => closeMenu(it.fn);
      box.appendChild(b);
    });
    document.body.append(scrim, box);

    // sitio: pegado al botón, por debajo si cabe y si no por encima; sin tapar la barra
    const vw = innerWidth, vh = innerHeight, br = btn.getBoundingClientRect();
    const tb = document.getElementById('tabwrap');
    const tr = tb && tb.getBoundingClientRect();
    const botMax = tr && tr.top > vh / 2 ? Math.min(vh - 12, tr.top - 8) : vh - 12;   // en PC la barra va arriba
    const w = box.offsetWidth, h = Math.min(box.scrollHeight, botMax - 12);
    box.style.maxHeight = h + 'px';
    const x = Math.max(12, Math.min(br.right - w, vw - 12 - w));
    const below = br.bottom + 4 + h <= botMax;
    const y = below ? br.bottom + 4 : Math.max(12, br.top - 4 - h);
    box.style.left = x + 'px'; box.style.top = y + 'px';
    box.style.transformOrigin = `${Math.max(0, Math.min(w, br.left + br.width / 2 - x))}px ${below ? 0 : h}px`;

    const onKey = ev => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeMenu(); btn.focus && btn.focus(); }
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const its = [...box.querySelectorAll('.mi')], k = its.indexOf(document.activeElement);
        const n = ev.key === 'ArrowDown' ? (k + 1) % its.length : (k - 1 + its.length) % its.length;
        its[n] && its[n].focus();
      }
    };
    // en el móvil la barra del navegador cambia el alto al desplazar: solo se cierra si cambia el ancho
    const w0 = innerWidth;
    const onResize = () => { if (innerWidth !== w0) closeMenu(); };
    menuState = { box, scrim, onKey, onResize };
    scrim.addEventListener('pointerdown', ev => { ev.preventDefault(); closeMenu(); });
    addEventListener('keydown', onKey, true);
    addEventListener('resize', onResize);
    requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('in')));
    setTimeout(() => { const f = box.querySelector('.mi'); f && f.focus({ preventScroll: true }); }, 80);
  }

  // Fondo: portada desenfocada en tres capas (fondo, medio, cerca) con fundido al cambiar
  function setBackdrop(host, url) {
    if (!host) return;
    const set = document.createElement('div');
    set.className = 'bg-set';
    if (url && enabled) {
      const u = `url("${url.replace(/"/g, '%22')}")`;
      set.innerHTML = `<div class="bg-layer far"></div><div class="bg-layer mid"></div><div class="bg-layer near"></div>`;
      set.querySelectorAll('.bg-layer').forEach(l => l.style.backgroundImage = u);
    }
    const shade = document.createElement('div');
    shade.className = 'bg-shade';
    set.appendChild(shade);
    const old = [...host.children];
    host.appendChild(set);
    const pre = new Image();
    const show = () => requestAnimationFrame(() => requestAnimationFrame(() => {
      set.classList.add('on');
      setTimeout(() => old.forEach(o => o.remove()), 1200);
    }));
    if (url && enabled) { pre.onload = pre.onerror = show; pre.src = url; } else show();
  }

  async function setCover(url) {
    lastCover = url || '';
    setBackdrop(document.getElementById('bg'), url);
    if (window.Liquid) Liquid.setBackground(enabled ? url : '');
    setBackdrop(document.querySelector('#player .pbg'), url);
    const c = await extract(url);
    if (url === lastCover) applyColor(c);
  }

  function setEnabled(on) {
    enabled = !!on;
    setCover(lastCover);
  }

  /* Barra de progreso ondulada: la parte reproducida es una onda que se mueve
     mientras suena y se aplana al pausar; el resto es una línea recta. */
  function Wave(el, onSeek) {
    el.innerHTML = '<svg aria-hidden="true"><path class="rest"/><path class="played"/><rect class="thumb" width="4" height="22" rx="2"/></svg>';
    const played = el.querySelector('.played'), rest = el.querySelector('.rest'), thumb = el.querySelector('.thumb');
    let prog = 0, playing = false, amp = 0, phase = 0, drag = false, raf = 0, active = true, lastT = 0;
    const LAMBDA = 30, AMP = 3.2, GAP = 7;

    function draw(t) {
      raf = 0;
      const dt = Math.min(50, t - (lastT || t)); lastT = t;
      const W = el.clientWidth, H = el.clientHeight, cy = H / 2;
      const target = playing && !drag ? AMP : 0;
      amp += (target - amp) * Math.min(1, dt / 90);
      if (playing) phase += dt * .0055;
      const x = Math.max(2, Math.min(W - 2, prog * W));
      const end = x - GAP;
      let d = '';
      if (end > 2) {
        for (let px = 2; px <= end; px += 2) {
          // la onda se atenúa en los extremos para que no "salte" en el inicio y junto al pulgar
          const fade = Math.min(1, (px - 2) / 10, (end - px) / 10 + .2);
          const y = cy + Math.sin(px / LAMBDA * Math.PI * 2 - phase) * amp * fade;
          d += (d ? 'L' : 'M') + px.toFixed(1) + ' ' + y.toFixed(2);
        }
        d += 'L' + end.toFixed(1) + ' ' + cy;
      }
      played.setAttribute('d', d);
      rest.setAttribute('d', x + GAP < W - 2 ? `M${(x + GAP).toFixed(1)} ${cy}L${W - 2} ${cy}` : '');
      thumb.setAttribute('x', (x - 2).toFixed(1));
      thumb.setAttribute('y', cy - 11);
      if (active && (playing || amp > .02)) raf = requestAnimationFrame(draw);
      else lastT = 0;
    }
    const kick = () => { if (!raf) raf = requestAnimationFrame(draw); };

    const frac = e => { const r = el.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
    el.addEventListener('pointerdown', e => { drag = true; el.setPointerCapture(e.pointerId); prog = frac(e); kick(); });
    el.addEventListener('pointermove', e => { if (drag) { prog = frac(e); kick(); } });
    const up = e => { if (!drag) return; drag = false; prog = frac(e); kick(); onSeek && onSeek(prog); };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', () => { drag = false; kick(); });
    addEventListener('resize', kick);

    return {
      set(p) { if (!drag) { prog = isFinite(p) ? p : 0; kick(); } },
      get dragging() { return drag; },
      setPlaying(b) { playing = !!b; kick(); },
      setActive(b) { active = !!b; kick(); }
    };
  }

  return {
    setCover, applyColor: () => applyColor(last), setEnabled, Wave, extract, menu, closeMenu,
    get menuOpen() { return !!menuState; }, get enabled() { return enabled; }
  };
})();
