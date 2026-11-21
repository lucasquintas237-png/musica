// tools/qr-stl.mjs — genera un código QR imprimible en 3D (.stl), sin librerías.
//
// Uso:
//   node tools/qr-stl.mjs <texto-o-url> [opciones]
// Opciones:
//   --ancho 80        lado de la placa en mm (por defecto 80)
//   --base 2          grosor de la placa en mm (por defecto 2)
//   --relieve 1       altura de los cuadritos del QR en mm (por defecto 1)
//   --margen 2        margen blanco alrededor del QR, en módulos (por defecto 2)
//   --ecc M           corrección de errores: L, M, Q o H (por defecto M)
//   --salida qr       nombre base de los archivos (por defecto "qr")
// Crea:
//   <salida>-una-pieza.stl  RECOMENDADO: placa y relieve fundidos en un único cuerpo cerrado; no se
//                           desmonta. Para dos colores basta UN cambio de filamento a la altura de la placa.
//   <salida>-base.stl       solo la placa (para impresoras multicolor, como pieza aparte)
//   <salida>-codigo.stl     solo los cuadritos (piezas sueltas: no imprimir solo)
//   <salida>-vista.svg      vista previa para comprobar el QR con el móvil antes de imprimir
//
// El QR se genera según la norma ISO/IEC 18004 (modo byte, Reed-Solomon, máscaras),
// basado en el algoritmo de referencia de Project Nayuki.

import { writeFileSync } from 'node:fs';

/* ============================================================ QR */
const ECL = { L: 0, M: 1, Q: 2, H: 3 };
const ECL_FORMAT = [1, 0, 3, 2];
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
];
const NUM_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
];
const bit = (x, i) => ((x >>> i) & 1) !== 0;

function rawDataModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) { const n = Math.floor(ver / 7) + 2; r -= (25 * n - 10) * n - 55; if (ver >= 7) r -= 36; }
  return r;
}
const dataCodewords = (ver, e) => Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[e][ver] * NUM_BLOCKS[e][ver];

// Reed-Solomon sobre GF(256) con polinomio 0x11D
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; }
  return z & 0xFF;
}
export function rsDivisor(degree) {
  const r = new Array(degree).fill(0); r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) { r[j] = gfMul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; }
    root = gfMul(root, 0x02);
  }
  return r;
}
export function rsRemainder(data, div) {
  const r = div.map(() => 0);
  for (const b of data) {
    const f = b ^ r.shift(); r.push(0);
    div.forEach((c, i) => { r[i] ^= gfMul(c, f); });
  }
  return r;
}

export function formatBits(e, mask) {
  const data = (ECL_FORMAT[e] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}
export function versionBits(ver) {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
  return (ver << 12) | rem;
}
export function alignmentPositions(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2, size = ver * 4 + 17;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const r = [6];
  for (let pos = size - 7; r.length < n; pos -= step) r.splice(1, 0, pos);
  return r;
}

export function makeQR(text, eclName = 'M') {
  let e = ECL[eclName];
  const bytes = [...new TextEncoder().encode(text)];
  // versión más pequeña en la que cabe
  let ver = 1, cap;
  for (; ver <= 40; ver++) {
    cap = dataCodewords(ver, e) * 8;
    if (4 + (ver < 10 ? 8 : 16) + bytes.length * 8 <= cap) break;
  }
  if (ver > 40) throw new Error('El texto es demasiado largo para un QR');
  // si sobra sitio, subir la corrección de errores sin cambiar de versión
  for (const hi of [1, 2, 3]) if (hi > e && 4 + (ver < 10 ? 8 : 16) + bytes.length * 8 <= dataCodewords(ver, hi) * 8) e = hi;
  cap = dataCodewords(ver, e) * 8;

  // datos: modo byte (0100) + longitud + bytes + terminador + relleno
  const bb = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1); };
  put(4, 4); put(bytes.length, ver < 10 ? 8 : 16); bytes.forEach(b => put(b, 8));
  put(0, Math.min(4, cap - bb.length));
  put(0, (8 - bb.length % 8) % 8);
  for (let pad = 0xEC; bb.length < cap; pad ^= 0xEC ^ 0x11) put(pad, 8);
  const data = [];
  for (let i = 0; i < bb.length; i += 8) data.push(parseInt(bb.slice(i, i + 8).join(''), 2));

  // corrección de errores por bloques y entrelazado
  const nb = NUM_BLOCKS[e][ver], eccLen = ECC_PER_BLOCK[e][ver];
  const raw = Math.floor(rawDataModules(ver) / 8);
  const numShort = nb - raw % nb, shortLen = Math.floor(raw / nb);
  const div = rsDivisor(eccLen), blocks = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const all = [];
  for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= numShort) all.push(b[i]); });

  // matriz
  const size = ver * 4 + 17;
  const mod = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setF = (x, y, d) => { mod[y][x] = d; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) setF(x, y, d !== 2 && d !== 4);
    }
  }
  const ap = alignmentPositions(ver), n = ap.length;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setF(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const drawFormat = mask => {
    const b = formatBits(e, mask);
    for (let i = 0; i <= 5; i++) setF(8, i, bit(b, i));
    setF(8, 7, bit(b, 6)); setF(8, 8, bit(b, 7)); setF(7, 8, bit(b, 8));
    for (let i = 9; i < 15; i++) setF(14 - i, 8, bit(b, i));
    for (let i = 0; i < 8; i++) setF(size - 1 - i, 8, bit(b, i));
    for (let i = 8; i < 15; i++) setF(8, size - 15 + i, bit(b, i));
    setF(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    const b = versionBits(ver);
    for (let i = 0; i < 18; i++) { const a = size - 11 + i % 3, c = Math.floor(i / 3); setF(a, c, bit(b, i)); setF(c, a, bit(b, i)); }
  }
  // colocar los datos en zigzag
  let k = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - v : v;
      if (!fn[y][x] && k < all.length * 8) { mod[y][x] = bit(all[k >>> 3], 7 - (k & 7)); k++; }
    }
  }
  const masks = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0,
    (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0
  ];
  const applyMask = m => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && masks[m](x, y)) mod[y][x] = !mod[y][x]; };
  // elegir la máscara con menos penalización (reglas de la norma)
  const penalty = () => {
    let p = 0, dark = 0;
    const lines = [];
    for (let i = 0; i < size; i++) { lines.push(mod[i]); lines.push(mod.map(r => r[i])); }
    for (const l of lines) {
      let run = 1;
      for (let i = 1; i <= size; i++) {
        if (i < size && l[i] === l[i - 1]) run++;
        else { if (run >= 5) p += run - 2; run = 1; }
      }
      // patrón parecido a un buscador: 1011101 con 4 claros a un lado
      const s = l.map(v => v ? 1 : 0).join('');
      for (const pat of ['10111010000', '00001011101']) for (let i = s.indexOf(pat); i >= 0; i = s.indexOf(pat, i + 1)) p += 40;
    }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
      const c = mod[y][x];
      if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) p += 3;
    }
    mod.forEach(r => r.forEach(v => { if (v) dark++; }));
    const total = size * size;
    p += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return p;
  };
  let best = 0, bestP = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m); drawFormat(m);
    const p = penalty();
    if (p < bestP) { bestP = p; best = m; }
    applyMask(m);
  }
  applyMask(best); drawFormat(best);
  return { size, modules: mod, version: ver, ecl: 'LMQH'[e], mask: best };
}

/* ============================================================ STL */
function stlBoxes(boxes) {
  // STL binario: 12 triángulos por caja
  const tris = [];
  for (const [x0, y0, z0, x1, y1, z1] of boxes) {
    const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    const f = [[0, 2, 1, 0, 0, -1], [0, 3, 2, 0, 0, -1], [4, 5, 6, 0, 0, 1], [4, 6, 7, 0, 0, 1], [0, 1, 5, 0, -1, 0], [0, 5, 4, 0, -1, 0],
      [1, 2, 6, 1, 0, 0], [1, 6, 5, 1, 0, 0], [2, 3, 7, 0, 1, 0], [2, 7, 6, 0, 1, 0], [3, 0, 4, -1, 0, 0], [3, 4, 7, -1, 0, 0]];
    for (const [a, b, c, nx, ny, nz] of f) tris.push([nx, ny, nz, v[a], v[b], v[c]]);
  }
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.write('QR imprimible - tools/qr-stl.mjs', 0, 'ascii');
  buf.writeUInt32LE(tris.length, 80);
  let o = 84;
  for (const [nx, ny, nz, a, b, c] of tris) {
    for (const val of [nx, ny, nz, ...a, ...b, ...c]) { buf.writeFloatLE(val, o); o += 4; }
    buf.writeUInt16LE(0, o); o += 2;
  }
  return buf;
}

/* Un único cuerpo cerrado: la placa y el relieve fundidos en una sola malla (mapa de alturas).
   Cada celda es una columna de altura "placa" o "placa + relieve"; solo hay paredes donde cambia
   la altura y en el borde, así que no hay piezas sueltas que se despeguen al sacarlo. */
export function heightmapTris(H, cell, zBase) {
  const rows = H.length, cols = H[0].length, tris = [];
  const add = (q, out) => {
    // dos triángulos por cuadrilátero, orientados hacia "out"
    const [a, b, c] = q, u = b.map((v, i) => v - a[i]), w = c.map((v, i) => v - a[i]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0) q = [q[0], q[3], q[2], q[1]];
    tris.push([out, q[0], q[1], q[2]], [out, q[0], q[2], q[3]]);
  };
  const X = i => i * cell, Y = j => j * cell;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const h = H[j][i], x0 = X(i), x1 = X(i + 1), y0 = Y(j), y1 = Y(j + 1);
    add([[x0, y0, h], [x1, y0, h], [x1, y1, h], [x0, y1, h]], [0, 0, 1]);       // arriba
    add([[x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0]], [0, 0, -1]);      // abajo
    // paredes con la celda de la derecha y la de arriba (o con el borde)
    const side = (h2, pts, dir) => {
      if (h2 === h) return;
      const lo = Math.min(h, h2), hi = Math.max(h, h2), out = h > h2 ? dir : dir.map(v => -v);
      // en el borde (h2 = 0) se parte en tramos para que las aristas coincidan con las vecinas
      const levels = h2 === 0 && h > zBase ? [0, zBase, h] : [lo, hi];
      for (let k = 0; k < levels.length - 1; k++) add([[...pts[0], levels[k]], [...pts[1], levels[k]], [...pts[1], levels[k + 1]], [...pts[0], levels[k + 1]]], out);
    };
    side(i + 1 < cols ? H[j][i + 1] : 0, [[x1, y0], [x1, y1]], [1, 0, 0]);
    side(j + 1 < rows ? H[j + 1][i] : 0, [[x0, y1], [x1, y1]], [0, 1, 0]);
    if (i === 0) side(0, [[x0, y0], [x0, y1]], [-1, 0, 0]);
    if (j === 0) side(0, [[x0, y0], [x1, y0]], [0, -1, 0]);
  }
  return tris;
}

function stlTris(tris) {
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.write('QR imprimible (una pieza) - tools/qr-stl.mjs', 0, 'ascii');
  buf.writeUInt32LE(tris.length, 80);
  let o = 84;
  for (const [n, a, b, c] of tris) {
    for (const val of [...n, ...a, ...b, ...c]) { buf.writeFloatLE(val, o); o += 4; }
    buf.writeUInt16LE(0, o); o += 2;
  }
  return buf;
}

/* ============================================================ programa */
function args(argv) {
  const o = { ancho: 80, base: 2, relieve: 1, margen: 2, ecc: 'M', salida: 'qr', texto: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2), v = argv[++i]; o[k] = ['ecc', 'salida'].includes(k) ? v : parseFloat(v); }
    else o.texto = a;
  }
  return o;
}

const isMain = !!process.argv[1] && /qr-stl\.mjs$/.test(process.argv[1]);
if (isMain && process.argv.length > 2) {
  const o = args(process.argv.slice(2));
  if (!o.texto) { console.error('Indica el texto o la URL: node tools/qr-stl.mjs https://...'); process.exit(1); }
  const qr = makeQR(o.texto, String(o.ecc).toUpperCase());
  o.margen = Math.max(1, Math.round(o.margen));
  const n = qr.size + o.margen * 2, m = o.ancho / n;     // tamaño de cada módulo en mm
  // mapa de alturas (fila 0 abajo en el modelo; la fila 0 del QR queda arriba)
  const H = Array.from({ length: n }, (_, j) => Array.from({ length: n }, (_, i) => {
    const qx = i - o.margen, qy = n - 1 - j - o.margen;
    const dark = qx >= 0 && qy >= 0 && qx < qr.size && qy < qr.size && qr.modules[qy][qx];
    return dark ? o.base + o.relieve : o.base;
  }));
  const base = [[0, 0, 0, o.ancho, o.ancho, o.base]];
  // cuadritos oscuros: se unen los que van seguidos en cada fila para que el archivo sea ligero
  const code = [];
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y][x]) continue;
      let x2 = x; while (x2 + 1 < qr.size && qr.modules[y][x2 + 1]) x2++;
      const X0 = (x + o.margen) * m, X1 = (x2 + 1 + o.margen) * m;
      const Y1 = o.ancho - (y + o.margen) * m, Y0 = Y1 - m;   // la fila 0 del QR queda arriba
      code.push([X0, Y0, o.base, X1, Y1, o.base + o.relieve]);
      x = x2;
    }
  }
  writeFileSync(o.salida + '-base.stl', stlBoxes(base));
  writeFileSync(o.salida + '-codigo.stl', stlBoxes(code));
  writeFileSync(o.salida + '-una-pieza.stl', stlTris(heightmapTris(H, m, o.base)));
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="600" height="600" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/>`;
  qr.modules.forEach((row, y) => row.forEach((d, x) => { if (d) svg += `<rect x="${x + o.margen}" y="${y + o.margen}" width="1" height="1"/>`; }));
  writeFileSync(o.salida + '-vista.svg', svg + '</svg>');
  console.log(`QR versión ${qr.version} (${qr.size}×${qr.size} módulos), corrección ${qr.ecl}, máscara ${qr.mask}`);
  console.log(`Placa ${o.ancho}×${o.ancho}×${o.base} mm, módulo de ${m.toFixed(2)} mm, relieve ${o.relieve} mm (${code.length} piezas unidas)`);
  console.log(`Archivos: ${o.salida}-una-pieza.stl (recomendado), ${o.salida}-base.stl, ${o.salida}-codigo.stl, ${o.salida}-vista.svg`);
  console.log(`Para dos colores con una sola pieza: un único cambio de filamento a ${o.base} mm de altura.`);
}
