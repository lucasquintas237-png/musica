'use strict';
/* liquid.js — cristal líquido con refracción real (WebGL2), al estilo iOS 26.

   - Un <canvas> WebGL2 a pantalla completa, fijo y DETRÁS de todo el HTML (z-index 0).
   - El fondo (portada desenfocada en tres capas + sombreado) se pinta en un canvas 2D y se
     sube como textura con mipmaps.
   - Cada elemento con data-glass es una forma: en cada fotograma se lee su rectángulo, su
     border-radius (y su escala si tiene transform) y se pasa al shader (máx. 32 formas).
     Atributos opcionales: data-tint="r,g,b,a", data-blur, data-zoom, data-group, data-layer
     (0 normal, 1 flotante), data-opacity, data-refract, data-ab (aberración), data-lens
     (refracción del contenido pintado), data-sel (tiñe el contenido del color de selección).
   - data-glass-paint="--variable-de-color": los iconos y textos de ese elemento se pintan
     también en una textura para que el cristal flotante pueda refractarlos.
   - data-glass-dock: barras fijas de abajo; el contenido que se desplaza se funde antes de
     llegar a ellas (el cristal está detrás del HTML).
   - Dos pasadas: 0 = fondo + cristal de capa 0 → framebuffer con mipmaps; 1 = contenido
     pintado + cristal de capa 1 que refracta esa imagen. Sin capa 1, una sola pasada.
   - Solo se redibuja cuando cambia algo (firma de formas y uniforms). */
const Liquid = (() => {
  const MAX = 32;
  const root = document.documentElement;
  const coarse = matchMedia('(pointer: coarse)').matches;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const SEL = [0x3d / 255, 0x9b / 255, 1];        // color de selección #3d9bff
  const BG_SCALE = .5;                             // el fondo va desenfocado: media resolución basta
  const BLUR = 1.3;                                // desenfoque global (niveles de mipmap)

  let cv = null, gl = null, prog = null, vao = null, U = {};
  let supported = false, ok = false, enabled = true, raf = 0, lastT = 0;
  let W = 0, H = 0, scale = 1, pixW = 0, pixH = 0;
  let bgTex = null, contentTex = null, fbo = null, fboTex = null, fboW = 0, fboH = 0;
  let dim = 0, force = true, dockPx = -1;
  // fondo animado: ondula mientras suena música y late con el BPM (time en s, beat 0-1, amount 0-1)
  const motion = { on: false, playing: false, bpm: 0, songT: 0, at: 0, time: 0, beat: 0, amount: 0, frame: 0 };
  function updateMotion(now, dt) {
    const target = motion.on && motion.playing && !reduced.matches ? 1 : 0;
    motion.amount += (target - motion.amount) * Math.min(1, dt * 1.5);
    if (motion.amount < .003 && !target) { if (motion.amount) { motion.amount = 0; force = true; } return false; }
    motion.time += dt;
    if (motion.bpm && motion.playing) {
      const ph = (motion.songT + (now - motion.at) / 1000) * motion.bpm / 60;
      motion.beat = Math.exp(-(ph - Math.floor(ph)) * 5);
    } else motion.beat *= .9;
    return true;
  }
  const A = new Float32Array(MAX * 4), B = new Float32Array(MAX * 4), T = new Float32Array(MAX * 4),
    C = new Float32Array(MAX * 4), K = new Float32Array(MAX * 4);
  let N = 0, hasL1 = false, prevSig = new Float32Array(0);

  /* ---------------------------------------------------------------- shaders */
  const VS = `#version 300 es
void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2. - 1., 0., 1.); }`;

  const FS = `#version 300 es
precision highp float;
#define MAXS ${MAX}
uniform vec2 uRes, uLight;
uniform float uScale, uPixH, uBgTexel, uDark, uBlur, uDim, uTime, uBeat, uMotion;
uniform vec3 uSel;
uniform sampler2D uBg, uContent, uScene;
uniform int uPass, uTwo, uN, uHasContent;
uniform vec4 uA[MAXS], uB[MAXS], uT[MAXS], uC[MAXS], uK[MAXS];
out vec4 outColor;
vec2 P;

float sdRB(vec2 p, vec2 b, float r) {
  r = min(r, min(b.x, b.y));
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r;
}
float smin(float a, float b, float k) {
  float h = clamp(.5 + .5 * (b - a) / k, 0., 1.);
  return mix(b, a, h) - k * h * (1. - h);
}
float sd(int i, vec2 p) { return sdRB(p - uA[i].xy, uA[i].zw, uB[i].x); }
bool same(int i, int j) { return abs(uB[i].y - uB[j].y) < .5 && abs(uB[i].z - uB[j].z) < .5; }
bool member(int i, int j) { return j == i || (j > i && uB[i].y > .5 && same(i, j)); }

// campo de un cuerpo: una forma suelta o un grupo (las formas del grupo se funden)
float field(int i, vec2 p) {
  float d = sd(i, p);
  if (uB[i].y < .5) return d;
  for (int j = 0; j < MAXS; j++) {
    if (j >= uN) break;
    if (j > i && same(i, j)) d = smin(d, sd(j, p), 24.);
  }
  return d;
}
bool head(int i) {
  if (uB[i].y < .5) return true;
  for (int j = 0; j < MAXS; j++) { if (j >= i) break; if (same(i, j)) return false; }
  return true;
}
bool nearBody(int i) {
  for (int j = 0; j < MAXS; j++) {
    if (j >= uN) break;
    if (member(i, j)) { vec2 e = abs(P - uA[j].xy - vec2(0., 6.)) - uA[j].zw; if (max(e.x, e.y) < 46.) return true; }
  }
  return false;
}

// fondo animado: el brillo de la portada ondula despacio y "late" con cada golpe (BPM)
vec2 bgUV(vec2 uv) {
  if (uMotion <= 0.) return uv;
  float a = .022 * uMotion;
  uv += a * vec2(sin(uTime * .23 + uv.y * 4.1) + .5 * sin(uTime * .11 + uv.x * 7.),
                 cos(uTime * .19 + uv.x * 3.7) + .5 * cos(uTime * .13 + uv.y * 6.));
  uv = .5 + (uv - .5) * (1. - .014 * uBeat * uMotion);
  return clamp(uv, 0., 1.);
}
vec3 bgAt(vec2 uv, float lod) { return textureLod(uBg, bgUV(uv), lod).rgb * (1. + .07 * uBeat * uMotion); }
vec3 src(vec2 q, float lod) {
  vec2 uv = clamp(q / uRes, 0., 1.);
  if (uPass == 1) return textureLod(uScene, vec2(uv.x, 1. - uv.y), lod).rgb;
  return bgAt(uv, lod);
}
// desenfoque: nivel de mipmap + 9 muestras alrededor (L en "niveles" de px CSS)
vec3 blur9(vec2 q, float L) {
  float tau = uPass == 1 ? 1. / uScale : uBgTexel;
  float lod = max(L - log2(tau), 0.);
  float r = exp2(L) * .9;
  vec3 s = src(q, lod) * .2;
  for (int k = 0; k < 8; k++) {
    float a = float(k) * .785398 + .392699;
    s += src(q + vec2(cos(a), sin(a)) * r, lod) * .1;
  }
  return s;
}

vec3 body(int i, vec3 col, float cdim) {
  float d = field(i, P);
  vec2 c = uA[i].xy; float m = min(uA[i].z, uA[i].w);
  vec4 tn = uT[i], cc = uC[i], kk = uK[i]; float zoom = uB[i].w;
  if (uB[i].y > .5) {   // grupo: propiedades mezcladas según la cercanía a cada forma
    float ws = 0.; c = vec2(0.); m = 0.; tn = vec4(0.); cc = vec4(0.); kk = vec4(0.); zoom = 0.;
    for (int j = 0; j < MAXS; j++) {
      if (j >= uN) break;
      if (member(i, j)) {
        float w = exp(-max(sd(j, P), 0.) / 10.) + 1e-4;
        ws += w; c += uA[j].xy * w; m += min(uA[j].z, uA[j].w) * w;
        tn += uT[j] * w; cc += uC[j] * w; kk += uK[j] * w; zoom += uB[j].w * w;
      }
    }
    c /= ws; m /= ws; tn /= ws; cc /= ws; kk /= ws; zoom /= ws;
  }
  float clipA = smoothstep(kk.x - 1., kk.x + 1., P.y) * smoothstep(kk.y, kk.y - 28., P.y);
  float op = cc.x * clipA;
  if (op <= 0.) return col;
  float a = clamp(.5 - d * uScale, 0., 1.);

  // sombra en dos capas: amplia y suave 7px hacia abajo + fina pegada al borde
  float dS = field(i, P - vec2(0., 7.));
  float wide = (1. - smoothstep(-8., 30., dS)) * .2;
  float tight = exp(-max(d, 0.) / 1.6) * .16;
  col *= 1. - (wide + tight) * (1. - a) * op * (uDark > .5 ? 1. : .55);
  if (a <= 0.) return col;

  vec2 e = vec2(1., 0.);
  vec2 g = vec2(field(i, P + e.xy) - field(i, P - e.xy), field(i, P + e.yx) - field(i, P - e.yx));
  vec2 n = dot(g, g) > 1e-8 ? normalize(g) : vec2(0.);
  float depth = max(-d, 0.);
  float Bv = max(min(22., .42 * m), 1.);
  float t = clamp(depth / Bv, 0., 1.), u = 1. - t;
  float bend = 1. - sqrt(max(1. - u * u, 0.));     // perfil circular, máximo en el borde

  float R = cc.z;
  vec2 q = c + (P - c) / max(zoom, .01) - n * bend * .55 * Bv * 1.6 * R;
  float L = uBlur + cc.y + bend * .8;
  float ab = .55 * 10. * bend * R * kk.z;
  vec3 gc = ab > .05
    ? vec3(blur9(q + n * ab, L).r, blur9(q, L).g, blur9(q - n * ab, L).b)
    : blur9(q, L);

  float lum = dot(gc, vec3(.2126, .7152, .0722));
  gc = clamp(mix(vec3(lum), gc, 1.18), 0., 1.) * 1.03 + .02;
  if (uDark < .5) gc = mix(gc, vec3(1.), .22);
  gc = mix(gc, tn.rgb, tn.a);

  // iconos y textos pintados bajo el cristal flotante: nítidos en reposo, refractados al cogerlo
  if (uPass == 1 && uHasContent == 1) {
    vec2 qc = mix(P, q, cc.w);
    vec4 k = texture(uContent, clamp(qc / uRes, 0., 1.)) * cdim;
    gc = gc * (1. - k.a) + (kk.w > .5 ? uSel * k.a : k.rgb);
  }

  if (uDark < .5) gc = mix(gc, vec3(.45), exp(-depth / .6) * .28);   // línea gris fina
  vec2 Ld = normalize(uLight);
  float facing = pow(abs(dot(n, Ld)), 2.5);         // brillan dos esquinas opuestas
  float rim = exp(-depth / .9);
  gc += rim * (.15 + .85 * facing) * (uDark > .5 ? .7 : .85);
  gc += exp(-depth / (Bv * 1.2)) * facing * .12 + u * .02;
  return mix(col, gc, a * op);
}

void main() {
  P = vec2(gl_FragCoord.x, uPixH - gl_FragCoord.y) / uScale;
  float cdim = 1. - uDim * .45;
  vec3 col = uPass == 0
    ? bgAt(clamp(P / uRes, 0., 1.), 0.)
    : textureLod(uScene, vec2(P.x / uRes.x, 1. - P.y / uRes.y), 0.).rgb;
  if (uPass == 1 && uHasContent == 1) { vec4 k = texture(uContent, P / uRes) * cdim; col = col * (1. - k.a) + k.rgb; }
  for (int i = 0; i < MAXS; i++) {
    if (i >= uN) break;
    if (int(uB[i].z + .5) != uPass) continue;
    if (!head(i) || !nearBody(i)) continue;
    col = body(i, col, cdim);
  }
  if (uPass == 0) {
    col *= 1. - uDim * (uDark > .5 ? .35 : .15);
    if (uTwo == 0 && uHasContent == 1) { vec4 k = texture(uContent, P / uRes) * cdim; col = col * (1. - k.a) + k.rgb; }
  }
  outColor = vec4(col, 1.);
}`;

  function compile(type, srcTxt) {
    const s = gl.createShader(type);
    gl.shaderSource(s, srcTxt);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn('Liquid shader:', gl.getShaderInfoLog(s)); return null; }
    return s;
  }

  function makeTex(mips) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    return t;
  }

  function initGL() {
    gl = cv.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'high-performance' });
    if (!gl) return false;
    const vs = compile(gl.VERTEX_SHADER, VS), fs = compile(gl.FRAGMENT_SHADER, FS);
    if (!vs || !fs) return false;
    prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.warn('Liquid link:', gl.getProgramInfoLog(prog)); return false; }
    gl.useProgram(prog);
    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    U = {};
    ['uRes', 'uLight', 'uScale', 'uPixH', 'uBgTexel', 'uDark', 'uBlur', 'uDim', 'uSel', 'uTime', 'uBeat', 'uMotion', 'uBg', 'uContent', 'uScene',
      'uPass', 'uTwo', 'uN', 'uHasContent', 'uA', 'uB', 'uT', 'uC', 'uK'].forEach(n => U[n] = gl.getUniformLocation(prog, n));
    gl.uniform1i(U.uBg, 0); gl.uniform1i(U.uContent, 1); gl.uniform1i(U.uScene, 2);
    bgTex = makeTex(true); contentTex = makeTex(false);
    fbo = null; fboTex = null; fboW = fboH = 0;
    bg.ver++; content.sig = ''; force = true;
    return true;
  }

  /* ---------------------------------------------------------------- fondo (canvas 2D) */
  const bg = { cv: document.createElement('canvas'), layers: [], sig: '', ver: 0, upVer: -1, url: '' };
  let ctxFilter = null;
  function hasCtxFilter() {
    if (ctxFilter === null) { const x = document.createElement('canvas').getContext('2d'); x.filter = 'blur(2px)'; ctxFilter = x.filter === 'blur(2px)'; }
    return ctxFilter;
  }
  const cssVar = (cs, n, d) => (cs.getPropertyValue(n) || '').trim() || d;

  // dibuja la imagen "cover" en un rectángulo, desenfocada y saturada (opcionalmente en círculo)
  function blurred(x, img, rx, ry, rw, rh, blur, sat, alpha, circle, rot) {
    const tw = Math.max(2, Math.ceil(rw)), th = Math.max(2, Math.ceil(rh));
    const t = document.createElement('canvas');
    t.width = tw; t.height = th;
    const tx = t.getContext('2d');
    if (circle) { tx.beginPath(); tx.ellipse(tw / 2, th / 2, tw / 2, th / 2, 0, 0, Math.PI * 2); tx.clip(); }
    const k = Math.max(tw / img.naturalWidth, th / img.naturalHeight);
    const iw = img.naturalWidth * k, ih = img.naturalHeight * k;
    if (rot) { tx.translate(tw / 2, th / 2); tx.rotate(rot); tx.translate(-tw / 2, -th / 2); }
    tx.drawImage(img, (tw - iw) / 2, (th - ih) / 2, iw, ih);
    x.save();
    x.globalAlpha = alpha;
    if (hasCtxFilter()) {
      x.filter = `blur(${blur.toFixed(1)}px) saturate(${sat})`;
      x.drawImage(t, rx, ry, rw, rh);
    } else {
      // sin ctx.filter (Safari antiguo): reducir mucho y ampliar suaviza igual
      const s = Math.max(2, Math.round(Math.min(tw, th) / Math.max(4, blur)));
      const m = document.createElement('canvas');
      m.width = Math.max(2, Math.round(tw / Math.min(tw, th) * s)); m.height = Math.max(2, Math.round(th / Math.min(tw, th) * s));
      const mx = m.getContext('2d'); mx.imageSmoothingQuality = 'high'; mx.drawImage(t, 0, 0, m.width, m.height);
      x.imageSmoothingQuality = 'high';
      x.drawImage(m, rx, ry, rw, rh);
    }
    x.restore();
  }

  function paintLayer(img, w, h, colors) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = colors.bg; x.fillRect(0, 0, w, h);
    if (img) {
      const s = w / W, vmax = Math.max(W, H) * s;
      // las mismas tres capas que #bg en CSS: lejos, medio y cerca
      const fw = w * 1.5 * 1.2, fh = h * 1.5 * 1.2;
      blurred(x, img, (w - fw) / 2, (h - fh) / 2, fw, fh, 110 * s, 1.7, 1, false, 0);
      const m = .9 * vmax;
      blurred(x, img, -.25 * vmax, -.2 * vmax, m, m, 70 * s, 1.5, .75, true, 0);
      const n = .6 * vmax;
      blurred(x, img, w + .15 * vmax - n, h + .1 * vmax - n, n, n, 40 * s, 1.4, .5, true, Math.PI);
    }
    const gr = x.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, colors.top); gr.addColorStop(1, colors.bot);
    x.fillStyle = gr; x.fillRect(0, 0, w, h);
    return c;
  }

  function loadImg(url) {
    return new Promise(res => {
      if (!url) return res(null);
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => res(im);
      im.onerror = () => res(null);
      // por el proxy local: así la imagen es del mismo origen y se puede subir a WebGL
      im.src = /^https?:/i.test(url) ? '/api/img?u=' + encodeURIComponent(url) : url;
    });
  }

  async function setBackground(url) {
    url = url || '';
    bg.url = url;
    const img = await loadImg(url);
    if (bg.url !== url) return;
    bg.layers.push({ img, t0: performance.now(), cache: null, cacheSig: '' });
    if (bg.layers.length > 2) bg.layers.splice(0, bg.layers.length - 2);
    bg.ver++;
  }

  // compone el fondo; devuelve true si ha cambiado
  function updateBg(now, cs) {
    const colors = { bg: cssVar(cs, '--bg', '#0e0e12'), top: cssVar(cs, '--shade-top', 'rgba(0,0,0,.3)'), bot: cssVar(cs, '--shade-bot', 'rgba(0,0,0,.7)') };
    const w = Math.max(2, Math.round(W * BG_SCALE)), h = Math.max(2, Math.round(H * BG_SCALE));
    const sig = [w, h, colors.bg, colors.top, colors.bot].join('|');
    if (!bg.layers.length) bg.layers.push({ img: null, t0: 0, cache: null, cacheSig: '' });
    const fadeMs = reduced.matches ? 1 : 1100;
    const top = bg.layers[bg.layers.length - 1];
    const f = Math.min(1, (now - top.t0) / fadeMs);
    if (f >= 1 && bg.layers.length > 1) { bg.layers.splice(0, bg.layers.length - 1); bg.ver++; }
    const fading = bg.layers.length > 1;
    if (sig === bg.sig && bg.upVer === bg.ver && !fading) return false;
    bg.sig = sig;
    if (bg.cv.width !== w || bg.cv.height !== h) { bg.cv.width = w; bg.cv.height = h; }
    const x = bg.cv.getContext('2d');
    bg.layers.forEach((l, i) => {
      if (l.cacheSig !== sig) { l.cache = paintLayer(l.img, w, h, colors); l.cacheSig = sig; }
      x.globalAlpha = i === 0 ? 1 : f;
      x.drawImage(l.cache, 0, 0);
    });
    x.globalAlpha = 1;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, bgTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bg.cv);
    gl.generateMipmap(gl.TEXTURE_2D);
    bg.upVer = bg.ver;
    return true;
  }

  /* ---------------------------------------------------------------- iconos y textos de las barras */
  const content = { cv: document.createElement('canvas'), sig: '', icons: new Map(), any: false };
  const range = document.createRange();

  function iconImg(id, color) {
    const key = id + '|' + color;
    let im = content.icons.get(key);
    if (!im) {
      const sym = document.getElementById(id);
      if (!sym) return null;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${sym.getAttribute('viewBox') || '0 0 24 24'}" width="96" height="96" style="fill:${color}">${sym.innerHTML}</svg>`;
      im = new Image();
      im.onload = () => { content.sig = ''; };
      im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      content.icons.set(key, im);
    }
    return im.complete && im.naturalWidth ? im : null;
  }

  function paintContent(cs) {
    const ops = [];
    document.querySelectorAll('[data-glass-paint]').forEach(host => {
      if (!visible(host)) return;
      const color = cssVar(cs, host.dataset.glassPaint, '#fff');
      host.querySelectorAll('svg use').forEach(u => {
        const s = u.closest('svg'), r = s.getBoundingClientRect();
        const href = (u.getAttribute('href') || u.getAttribute('xlink:href') || '').replace('#', '');
        if (r.width && href) ops.push(['i', href, r.left, r.top, r.width, r.height, color]);
      });
      const tw = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      for (let t = tw.nextNode(); t; t = tw.nextNode()) {
        const txt = t.data.trim();
        if (!txt) continue;
        range.selectNodeContents(t);
        const r = range.getBoundingClientRect();
        if (!r.width) continue;
        const ps = getComputedStyle(t.parentElement);
        ops.push(['t', txt, r.left, r.top, r.width, r.height, color, `${ps.fontStyle} ${ps.fontWeight} ${ps.fontSize} ${ps.fontFamily}`, ps.letterSpacing]);
      }
    });
    const sig = W + 'x' + H + '@' + scale + JSON.stringify(ops, (k, v) => typeof v === 'number' ? Math.round(v * 20) / 20 : v);
    if (sig === content.sig) return false;
    content.sig = sig;
    content.any = ops.length > 0;
    const c = content.cv;
    if (c.width !== pixW || c.height !== pixH) { c.width = pixW; c.height = pixH; }
    const x = c.getContext('2d');
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.clearRect(0, 0, c.width, c.height);
    x.setTransform(scale, 0, 0, scale, 0, 0);
    let pending = false;
    ops.forEach(o => {
      if (o[0] === 'i') {
        const im = iconImg(o[1], o[6]);
        if (im) x.drawImage(im, o[2], o[3], o[4], o[5]); else pending = true;
      } else {
        x.font = o[7];
        if ('letterSpacing' in x) x.letterSpacing = o[8] === 'normal' ? '0px' : o[8];
        x.fillStyle = o[6];
        x.textBaseline = 'alphabetic';
        const m = x.measureText(o[1]);
        const asc = m.fontBoundingBoxAscent || m.actualBoundingBoxAscent || o[5] * .8;
        const desc = m.fontBoundingBoxDescent || m.actualBoundingBoxDescent || o[5] * .2;
        x.fillText(o[1], o[2], o[3] + (o[5] - asc - desc) / 2 + asc);
      }
    });
    if (pending) content.sig = '';      // repetir cuando carguen los iconos
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, contentTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    return true;
  }

  /* ---------------------------------------------------------------- formas */
  function visible(el) {
    if (el.checkVisibility) return el.checkVisibility({ visibilityProperty: true });
    if (!el.getClientRects().length) return false;
    return getComputedStyle(el).visibility !== 'hidden';
  }
  const num = (v, d) => { const n = parseFloat(v); return isFinite(n) ? n : d; };
  function tintOf(s, dark) {
    if (s) { const p = s.split(',').map(Number); if (p.length >= 4 && p.every(isFinite)) return [p[0] / 255, p[1] / 255, p[2] / 255, p[3]]; }
    return dark ? [.1, .1, .12, .16] : [1, 1, 1, .1];
  }

  function collect(dark) {
    const list = [];
    let dockTop = H;
    document.querySelectorAll('[data-glass]').forEach(el => {
      if (!visible(el)) return;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.bottom < -50 || r.top > H + 50 || r.right < -50 || r.left > W + 50) return;
      // solo cuentan las barras de abajo (en PC la de navegación va arriba)
      if (el.hasAttribute('data-glass-dock') && r.top > H / 2) dockTop = Math.min(dockTop, r.top);
      list.push({ el, r, layer: num(el.dataset.layer, 0) });
    });
    // las barras de abajo marcan dónde se funde el contenido que se desplaza
    const dk = Math.max(0, Math.round(H - dockTop));
    if (dk !== dockPx) { dockPx = dk; root.style.setProperty('--lg-dock', dk + 'px'); }
    list.sort((a, b) => a.layer - b.layer);
    N = Math.min(MAX, list.length);
    hasL1 = false;
    for (let i = 0; i < N; i++) {
      const { el, r, layer } = list[i], d = el.dataset, cs = getComputedStyle(el), o = i * 4;
      const ow = el.offsetWidth || r.width, oh = el.offsetHeight || r.height;
      const sx = r.width / ow, sy = r.height / oh;
      let rad = cs.borderTopLeftRadius || '0';
      rad = rad.endsWith('%') ? parseFloat(rad) / 100 * Math.min(ow, oh) : parseFloat(rad) || 0;
      rad *= Math.min(sx, sy);
      A[o] = r.left + r.width / 2; A[o + 1] = r.top + r.height / 2; A[o + 2] = r.width / 2; A[o + 3] = r.height / 2;
      B[o] = Math.min(rad, r.width / 2, r.height / 2); B[o + 1] = num(d.group, 0); B[o + 2] = layer; B[o + 3] = num(d.zoom, 1);
      const t = tintOf(d.tint, dark);
      T[o] = t[0]; T[o + 1] = t[1]; T[o + 2] = t[2]; T[o + 3] = t[3];
      C[o] = num(d.opacity, 1); C[o + 1] = num(d.blur, 0); C[o + 2] = num(d.refract, 1); C[o + 3] = num(d.lens, 0);
      let top = -1e5, bot = 1e5;
      const sc = el.closest('.tab,.view,[data-glass-clip]');
      if (sc) { const q = sc.getBoundingClientRect(); top = q.top; bot = Math.min(q.bottom, dockTop + 2); }
      K[o] = top; K[o + 1] = bot; K[o + 2] = num(d.ab, 1); K[o + 3] = d.sel != null ? 1 : 0;
      if (layer >= 1) hasL1 = true;
    }
  }

  /* ---------------------------------------------------------------- luz */
  const DEF = [-Math.SQRT1_2, -Math.SQRT1_2];
  const light = { x: DEF[0], y: DEF[1], tx: DEF[0], ty: DEF[1], last: 0 };
  addEventListener('pointermove', e => {
    if (reduced.matches) return;
    const dx = e.clientX - W / 2, dy = e.clientY - H / 2, l = Math.hypot(dx, dy);
    if (l < 1) return;
    light.tx = dx / l; light.ty = dy / l; light.last = performance.now();
  }, { passive: true });
  function updateLight(now, dt) {
    if (now - light.last > 2500) { light.tx = DEF[0]; light.ty = DEF[1]; }
    const k = reduced.matches ? 1 : 1 - Math.exp(-dt * 5);
    light.x += (light.tx - light.x) * k; light.y += (light.ty - light.y) * k;
    const l = Math.hypot(light.x, light.y) || 1;
    light.x /= l; light.y /= l;
  }

  /* ---------------------------------------------------------------- dibujo */
  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, coarse ? 1.6 : 2);
    W = innerWidth; H = innerHeight;
    pixW = Math.max(1, Math.round(W * dpr)); pixH = Math.max(1, Math.round(H * dpr));
    scale = pixW / W;
    if (cv.width !== pixW || cv.height !== pixH) { cv.width = pixW; cv.height = pixH; }
    force = true;
  }

  function ensureFbo() {
    if (fbo && fboW === pixW && fboH === pixH) return;
    if (!fbo) { fbo = gl.createFramebuffer(); fboTex = makeTex(true); }
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, fboTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, pixW, pixH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    fboW = pixW; fboH = pixH;
  }

  function draw(dark) {
    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    gl.uniform2f(U.uRes, W, H);
    gl.uniform1f(U.uScale, scale);
    gl.uniform1f(U.uPixH, pixH);
    gl.uniform1f(U.uBgTexel, 1 / BG_SCALE);
    gl.uniform1f(U.uDark, dark ? 1 : 0);
    gl.uniform1f(U.uBlur, BLUR);
    gl.uniform1f(U.uDim, dim);
    gl.uniform1f(U.uTime, motion.time);
    gl.uniform1f(U.uBeat, motion.beat);
    gl.uniform1f(U.uMotion, motion.amount);
    gl.uniform2f(U.uLight, light.x, light.y);
    gl.uniform3f(U.uSel, SEL[0], SEL[1], SEL[2]);
    gl.uniform1i(U.uN, N);
    gl.uniform1i(U.uHasContent, content.any ? 1 : 0);
    gl.uniform4fv(U.uA, A); gl.uniform4fv(U.uB, B); gl.uniform4fv(U.uT, T); gl.uniform4fv(U.uC, C); gl.uniform4fv(U.uK, K);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, bgTex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, contentTex);
    if (hasL1) {
      ensureFbo();
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, pixW, pixH);
      gl.uniform1i(U.uPass, 0); gl.uniform1i(U.uTwo, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, fboTex);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.viewport(0, 0, pixW, pixH);
      gl.uniform1i(U.uPass, 1);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else {
      gl.viewport(0, 0, pixW, pixH);
      gl.uniform1i(U.uPass, 0); gl.uniform1i(U.uTwo, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  function signature(dark) {
    const n = N * 20 + 10;
    const s = new Float32Array(n);
    s.set(A.subarray(0, N * 4), 0); s.set(B.subarray(0, N * 4), N * 4); s.set(T.subarray(0, N * 4), N * 8);
    s.set(C.subarray(0, N * 4), N * 12); s.set(K.subarray(0, N * 4), N * 16);
    s.set([N, dark ? 1 : 0, dim, light.x, light.y, W, H, scale, hasL1 ? 1 : 0, content.any ? 1 : 0], N * 20);
    let same = s.length === prevSig.length;
    for (let i = 0; same && i < n; i++) if (Math.abs(s[i] - prevSig[i]) > 1e-3) same = false;
    prevSig = s;
    return !same;
  }

  function step(now) {
    if (!ok || !enabled) return;
    const dt = lastT ? Math.min(.1, (now - lastT) / 1000) : 1 / 60;
    lastT = now;
    if (innerWidth !== W || innerHeight !== H || Math.round(W * Math.min(devicePixelRatio || 1, coarse ? 1.6 : 2)) !== pixW) resize();
    const cs = getComputedStyle(root);
    const dark = root.dataset.theme !== 'light';
    updateLight(now, dt);
    // con el fondo animado se redibuja a 30 fotogramas por segundo
    if (updateMotion(now, dt) && (++motion.frame & 1) === 0) force = true;
    collect(dark);
    let changed = updateBg(now, cs);
    if (paintContent(cs)) changed = true;
    if (signature(dark)) changed = true;
    if (changed || force) { force = false; draw(dark); }
  }

  function loop(t) { raf = requestAnimationFrame(loop); step(t); }

  function apply() {
    const on = ok && enabled;
    root.classList.toggle('lg', on);
    if (on) { force = true; if (!raf) raf = requestAnimationFrame(loop); }
    else { cancelAnimationFrame(raf); raf = 0; dockPx = -1; root.style.removeProperty('--lg-dock'); }
  }

  function init() {
    cv = document.createElement('canvas');
    cv.id = 'lg-canvas';
    cv.setAttribute('aria-hidden', 'true');
    const host = document.getElementById('bg');
    host ? host.after(cv) : document.body.prepend(cv);
    // en la pantalla del coche de Assetto Corsa (app MusicaAC) no: le quitaría rendimiento al juego
    if (/MusicaAC\//.test(navigator.userAgent)) supported = ok = false;
    else try { supported = ok = initGL(); } catch (e) { console.warn('Liquid:', e); supported = ok = false; }
    if (ok) resize();
    cv.addEventListener('webglcontextlost', e => { e.preventDefault(); ok = false; apply(); });
    cv.addEventListener('webglcontextrestored', () => { try { ok = initGL(); } catch (_) { ok = false; } if (ok) resize(); apply(); });
    const now = () => { if (ok && enabled) { resize(); step(performance.now()); } };
    addEventListener('resize', now);                      // recolocar en el mismo fotograma
    document.addEventListener('fullscreenchange', now);
    apply();
  }

  init();

  return {
    setBackground,
    setEnabled(on) { enabled = !!on; apply(); },
    setDim(v) { dim = Math.max(0, Math.min(1, v)); },
    // { on, playing, bpm, songT }: estado del fondo animado
    setMotion(o) { Object.assign(motion, o); if ('songT' in o) motion.at = performance.now(); },
    refresh() { force = true; },
    get supported() { return supported; },
    get active() { return ok && enabled; },
    get reducedMotion() { return reduced.matches; }
  };
})();
window.Liquid = Liquid;
