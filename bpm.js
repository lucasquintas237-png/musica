'use strict';
/* bpm.js — BPM (pulsaciones por minuto) de la canción.
   El audio de YouTube no se puede analizar (el reproductor es de otro dominio), así que:
   1. se busca la canción en Deezer y, si tiene el BPM en su ficha, se usa ese;
   2. si no, se analiza el fragmento público de 30 s que ofrece Deezer: se decodifica con Web Audio,
      se calcula la envolvente de ataques (subidas de energía en graves, medios y agudos) y se busca
      la periodicidad más fuerte entre 60 y 200 BPM;
   3. y siempre se puede medir a mano tocando al ritmo (y queda guardado para esa canción). */
const BPM = (() => {
  const KEY = 'mz:bpmCache';
  const cache = (() => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (_) { return {}; } })();
  const save = () => {
    const ks = Object.keys(cache);
    if (ks.length > 1500) ks.slice(0, ks.length - 1500).forEach(k => delete cache[k]);
    try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (_) {}
  };
  const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const mainArtist = s => (s || '').split(/,|&| y | x | feat\.? /i)[0].trim();
  const pending = new Map();

  /* ---------------------------------------------------------------- Deezer */
  async function findDeezer(t) {
    const q = `${mainArtist(t.artist)} ${(t.title || '').replace(/\s*[([].*?[)\]]/g, '')}`.trim();
    const r = await fetch('/api/deezer/search?limit=8&q=' + encodeURIComponent(q));
    if (!r.ok) throw new Error('deezer ' + r.status);
    const list = (await r.json()).data || [];
    const nt = norm(t.title), na = norm(mainArtist(t.artist));
    const ok = x => {
      const xt = norm(x.title_short || x.title), xa = norm(x.artist && x.artist.name);
      return (xt === nt || xt.startsWith(nt) || nt.startsWith(xt)) && (!na || xa.includes(na) || na.includes(xa));
    };
    return list.find(ok) || null;
  }

  /* ---------------------------------------------------------------- análisis del audio */
  async function bandEnvelope(buffer, type, freq, hop) {
    const ctx = new OfflineAudioContext(1, buffer.length, buffer.sampleRate);
    const src = ctx.createBufferSource(); src.buffer = buffer;
    let node = src;
    if (type) { const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = .7; src.connect(f); node = f; }
    node.connect(ctx.destination); src.start();
    const out = (await ctx.startRendering()).getChannelData(0);
    const n = Math.floor(out.length / hop), env = new Float32Array(n);
    for (let i = 0; i < n; i++) { let s = 0; for (let k = i * hop, e = k + hop; k < e; k++) s += out[k] * out[k]; env[i] = Math.log(1e-9 + s / hop); }
    return env;
  }

  // devuelve { bpm, confianza, alternativa }
  async function analyze(arrayBuffer) {
    const tmp = new OfflineAudioContext(1, 1, 44100);
    const buffer = await tmp.decodeAudioData(arrayBuffer);
    const fps = 100, hop = Math.round(buffer.sampleRate / fps);
    const bands = await Promise.all([
      bandEnvelope(buffer, 'lowpass', 150, hop),     // bombo
      bandEnvelope(buffer, 'bandpass', 1000, hop),   // caja, voces
      bandEnvelope(buffer, 'highpass', 5000, hop)    // platos
    ]);
    const n = bands[0].length;
    // ataques: subidas de energía (en escala logarítmica) sumadas por bandas
    const onset = new Float32Array(n);
    for (const b of bands) for (let i = 1; i < n; i++) onset[i] += Math.max(0, b[i] - b[i - 1]);
    // quitar la tendencia (media móvil de medio segundo) y lo negativo
    const W = 25, flux = new Float32Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += onset[i]; if (i >= 2 * W + 1) acc -= onset[i - 2 * W - 1];
      const c = i - W; if (c >= 0) flux[c] = Math.max(0, onset[c] - acc / Math.min(i + 1, 2 * W + 1));
    }
    // autocorrelación en los retardos de 60–200 BPM
    const lagOf = bpm => 60 * fps / bpm;
    const ac = l => {
      const L = Math.floor(l), f = l - L; let s = 0;
      for (let i = 0; i + L + 1 < n; i++) s += flux[i] * (flux[i + L] * (1 - f) + flux[i + L + 1] * f);
      return s;
    };
    let e0 = 0; for (let i = 0; i < n; i++) e0 += flux[i] * flux[i];
    if (e0 <= 0) return null;
    // el pulso se refuerza con sus múltiplos (2 y 4 tiempos) y con el medio tiempo (corcheas);
    // con 12 canciones de BPM conocido esta combinación acertó 9, 2 a la mitad/doble y falló 1
    const comb = l => ac(l) + .5 * ac(2 * l) + .25 * ac(4 * l) + .5 * ac(l / 2);
    const scores = [];
    for (let bpm = 60; bpm <= 200; bpm += .5) {
      const l = lagOf(bpm);
      const s = comb(l) / e0;
      // preferencia suave por los tempos más habituales (centrada en 115 BPM)
      const prior = Math.exp(-.5 * Math.pow(Math.log2(bpm / 115) / .85, 2));
      scores.push({ bpm, raw: s, s: s * prior });
    }
    scores.sort((a, b) => b.s - a.s);
    const best = scores[0];
    // afinar alrededor del mejor con pasos de 0,1 BPM
    let fine = best.bpm, fs = -1;
    for (let b = best.bpm - .6; b <= best.bpm + .6; b += .1) { const s = comb(lagOf(b)); if (s > fs) { fs = s; fine = b; } }
    const bpm = Math.round(fine);
    const half = scores.find(x => Math.abs(x.bpm - bpm / 2) <= 1), dbl = scores.find(x => Math.abs(x.bpm - bpm * 2) <= 1);
    const alt = [half, dbl].filter(Boolean).sort((a, b) => b.raw - a.raw)[0];
    const second = scores.find(x => Math.abs(x.bpm - best.bpm) > 4 && !(alt && Math.abs(x.bpm - alt.bpm) <= 1));
    return { bpm, confianza: second ? Math.min(1, (best.s - second.s) / best.s * 3) : 1, alternativa: alt && alt.raw > best.raw * .6 ? Math.round(alt.bpm) : 0 };
  }

  /* ---------------------------------------------------------------- consulta */
  async function compute(t) {
    const d = await findDeezer(t);
    if (!d) return { bpm: 0, fuente: 'no encontrada' };
    const tr = await (await fetch('/api/deezer/track/' + d.id)).json();
    if (tr.bpm > 0) return { bpm: Math.round(tr.bpm), fuente: 'Deezer' };
    const url = tr.preview || d.preview;
    if (!url) return { bpm: 0, fuente: 'sin fragmento' };
    const r = await fetch('/api/deezer/preview?u=' + encodeURIComponent(url));
    if (!r.ok) throw new Error('fragmento ' + r.status);
    const a = await analyze(await r.arrayBuffer());
    return a ? { bpm: a.bpm, fuente: 'estimado', alternativa: a.alternativa, confianza: +a.confianza.toFixed(2) } : { bpm: 0, fuente: 'sin ritmo' };
  }

  function get(t) {
    if (!t || !t.id) return Promise.resolve(null);
    if (cache[t.id]) return Promise.resolve(cache[t.id]);
    if (pending.has(t.id)) return pending.get(t.id);
    const p = compute(t).then(r => { if (r && r.fuente !== 'error') { cache[t.id] = r; save(); } return r; })
      .catch(() => ({ bpm: 0, fuente: 'error' }))
      .finally(() => pending.delete(t.id));
    pending.set(t.id, p);
    return p;
  }
  function setManual(t, bpm) { cache[t.id] = { bpm: Math.round(bpm), fuente: 'medido a mano' }; save(); refresh(); }
  function clear(t) { delete cache[t.id]; save(); }

  /* ---------------------------------------------------------------- mezcla por ritmo
     Canciones con un BPM parecido (o el doble/la mitad, que se bailan igual) sacadas de la radio de
     la canción y de las de tu historial reciente. Se añaden a la cola según se van encontrando. */
  let mixing = 0;
  async function tempoMix(t) {
    if (!t || !t.id) return;
    const r = await get(t);
    if (!r || !r.bpm) { sheet(t); return toast('No se sabe el BPM de esta canción: mídelo tocando al ritmo'); }
    const target = r.bpm, tok = ++mixing, name = `Ritmo de ${target} BPM`;
    const ok = b => [b, b * 2, b / 2].some(x => Math.abs(x - target) <= Math.max(4, target * .05));
    // si ya suena, sigue sonando; si no, empieza
    const s = App.state;
    if (App.current && (App.current.id === t.id || App.current.vid === t.id)) { s.queue.splice(s.index + 1); s.from = name; App.emit('queue'); }
    else App.playList([t], 0, name);
    toast(`Buscando canciones de unos ${target} BPM…`, 6000);
    const seeds = [t.vid || t.id, ...Library.history().filter(h => h.id !== t.id).slice(0, 2).map(h => h.id)];
    const lists = await Promise.all(seeds.map(id => (window.Reco ? Reco.radio(id) : YTM.radio(id)).catch(() => [])));
    const seen = new Set([t.id, t.vid]), cands = [];
    for (let k = 0; k < 40; k++) for (const l of lists) { const c = l[k]; if (c && !seen.has(c.id)) { seen.add(c.id); cands.push(c); } }
    let found = 0, idx = 0;
    const worker = async () => {
      while (idx < cands.length && found < 20 && tok === mixing) {
        const c = cands[idx++];
        const b = await get(c).catch(() => null);
        if (tok !== mixing || !b || !b.bpm || !ok(b.bpm)) continue;
        found++;
        s.queue.push({ ...c });
        App.emit('queue'); App.saveQueue();
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (tok === mixing) toast(found ? `Mezcla de ritmo: ${found} canciones de unos ${target} BPM` : 'No se encontraron canciones con ese ritmo');
  }

  /* ---------------------------------------------------------------- interfaz */
  const label = r => !r ? '♩ … BPM' : r.bpm ? `♩ ${r.bpm} BPM` : '♩ BPM';
  function chips() { return document.querySelectorAll('.bpm-chip'); }
  async function refresh() {
    const t = App.current;
    chips().forEach(c => { c.hidden = !t; c.textContent = label(null); c.classList.add('loading'); });
    if (!t) return;
    const r = await get(t);
    if (App.current !== t) return;
    chips().forEach(c => {
      c.classList.remove('loading');
      c.textContent = label(r);
      c.title = r && r.bpm ? `BPM: ${r.bpm} (${r.fuente})` : 'BPM desconocido: toca para medirlo';
      c.classList.toggle('est', !!r && r.fuente === 'estimado');
    });
  }

  function sheet(t = App.current) {
    if (!t) return;
    const r = cache[t.id];
    App.sheet({
      title: 'BPM · ' + t.title, sub: t.artist,
      body: box => {
        const info = r && r.bpm
          ? `<div class="bpm-big">${r.bpm}<small>BPM</small></div><p class="muted bpm-src">${r.fuente === 'Deezer' ? 'Dato de Deezer' : r.fuente === 'estimado' ? 'Estimado analizando el fragmento de 30 s de Deezer' + (r.alternativa ? ` · podría ser ${r.alternativa}` : '') : 'Medido a mano'}</p>`
          : `<div class="bpm-big">—<small>BPM</small></div><p class="muted bpm-src">${r ? 'No se pudo calcular (' + esc(r.fuente) + ').' : 'Calculando…'} Puedes medirlo tocando al ritmo.</p>`;
        const el2 = el(`<div class="bpm-sheet">${info}
          <button class="bpm-tap" type="button"><span>Toca al ritmo</span><b>—</b></button>
          <p class="muted bpm-help">Toca el botón (o pulsa la barra espaciadora) siguiendo el pulso unas 8 veces.</p>
          <div class="acct-actions"><button class="btn tonal" data-x="reset" type="button">Calcular de nuevo</button><button class="btn" data-x="save" type="button" disabled>Guardar</button></div>
          ${r && r.bpm ? `<button class="btn tonal bpm-mix" data-x="mix" type="button">${icon('bolt')}Mezcla con este ritmo</button>` : ''}</div>`);
        const tap = el2.querySelector('.bpm-tap'), out = tap.querySelector('b'), saveBtn = el2.querySelector('[data-x=save]');
        let taps = [], measured = 0;
        const hit = e => {
          e && e.preventDefault();
          const now = performance.now();
          if (taps.length && now - taps[taps.length - 1] > 2500) taps = [];
          taps.push(now); taps = taps.slice(-12);
          tap.classList.remove('pulse'); void tap.offsetWidth; tap.classList.add('pulse');
          if (typeof FX !== 'undefined' && FX.buzz) FX.buzz(6);
          if (taps.length >= 3) {
            const iv = []; for (let i = 1; i < taps.length; i++) iv.push(taps[i] - taps[i - 1]);
            iv.sort((a, b) => a - b);
            const med = iv[Math.floor(iv.length / 2)];
            measured = Math.round(60000 / med);
            out.textContent = measured + ' BPM';
            saveBtn.disabled = taps.length < 5;
          }
        };
        tap.addEventListener('pointerdown', hit);
        const key = e => { if (e.code === 'Space' && document.body.contains(tap)) { e.stopPropagation(); hit(e); } else if (!document.body.contains(tap)) removeEventListener('keydown', key, true); };
        addEventListener('keydown', key, true);
        saveBtn.onclick = () => { setManual(t, measured); App.closeSheet(); toast(`BPM guardado: ${measured}`); };
        const mixBtn = el2.querySelector('[data-x=mix]');
        if (mixBtn) mixBtn.onclick = () => { App.closeSheet(); tempoMix(t); };
        el2.querySelector('[data-x=reset]').onclick = async () => {
          clear(t); App.closeSheet(); toast('Calculando el BPM…');
          await refresh(); sheet(t);
        };
        box.appendChild(el2);
      }
    });
    if (!r) get(t).then(() => { if ($('#sheet') && !$('#sheet').hidden && $('#sheet .bpm-sheet')) sheet(t); });
  }

  document.addEventListener('DOMContentLoaded', () => {
    // chip de BPM en el reproductor completo y en el panel "Ahora suena"
    const place = (sel, where) => { const host = document.querySelector(sel); if (!host) return; const c = document.createElement('button'); c.className = 'bpm-chip'; c.hidden = true; c.onclick = e => { e.stopPropagation(); sheet(); }; where(host, c); };
    place('#player .p-info .txt', (h, c) => h.appendChild(c));
    place('#now .now-info .txt', (h, c) => h.appendChild(c));
    App.on('track', refresh);
    if (App.current) refresh();
  }, { once: true });

  return { get, sheet, analyze, refresh, tempoMix };
})();
window.BPM = BPM;
