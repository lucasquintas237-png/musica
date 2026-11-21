'use strict';
/* wrapped.js — "Tu resumen": tus datos de escucha en pantallas tipo historias (minutos, tu canción,
   tu top 5, tus artistas, tu racha, tu hora y tu ritmo) y una tarjeta para compartir o guardar.
   Pantallas: avanzan solas cada 6 s; tocar a la derecha/izquierda para pasar; mantener pulsado
   para pausar; deslizar hacia abajo o la X para cerrar. */
const Wrapped = (() => {
  const SLIDE_MS = 6000;
  const mainArtist = a => (a || '').split(/,|&| y | x | feat\.? /i)[0].trim();
  const fmtH = s => { const h = Math.floor(s / 3600), m = Math.round(s % 3600 / 60); return h ? `${h} h ${m} min` : `${m} min`; };
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

  function data() {
    const s = Library.stats(), plays = Object.values(s.plays || {}).filter(e => e && e.t && e.t.id);
    if (!plays.length) return null;
    const year = new Date().getFullYear();
    const days = Object.entries(s.days || {});
    const yearSecs = days.filter(([d]) => d.startsWith(year + '-')).reduce((a, [, v]) => a + v, 0) || s.total || 0;
    const topSongs = plays.slice().sort((a, b) => (b.n - a.n) || (b.secs - a.secs)).slice(0, 5);
    const art = new Map();
    plays.forEach(e => { const k = mainArtist(e.t.artist); if (!k) return; const a = art.get(k) || { name: k, secs: 0, n: 0, cover: e.t.cover }; a.secs += e.secs || 0; a.n += e.n || 0; art.set(k, a); });
    const topArtists = [...art.values()].sort((a, b) => b.secs - a.secs || b.n - a.n).slice(0, 5);
    const best = days.slice().sort((a, b) => b[1] - a[1])[0];
    // racha: días seguidos con música
    const set = new Set(days.filter(([, v]) => v > 60).map(([d]) => d));
    let streak = 0;
    for (const d of set) {
      const prev = new Date(d); prev.setDate(prev.getDate() - 1);
      if (set.has(prev.toISOString().slice(0, 10))) continue;           // no es el primer día de una racha
      let n = 0; const c = new Date(d);
      while (set.has(c.toISOString().slice(0, 10))) { n++; c.setDate(c.getDate() + 1); }
      streak = Math.max(streak, n);
    }
    const hours = Object.entries(s.hours || {}).sort((a, b) => b[1] - a[1]);
    let bpmAvg = 0;
    try {
      const bc = JSON.parse(localStorage.getItem('mz:bpmCache') || '{}');
      const vals = topSongs.concat(plays.slice(0, 40)).map(e => bc[e.t.id] && bc[e.t.id].bpm).filter(v => v > 0);
      if (vals.length >= 2) bpmAvg = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    } catch (_) {}
    return {
      year, mins: Math.round(yearSecs / 60), songs: plays.length, artists: art.size,
      topSongs, topArtists, best: best && best[1] > 0 ? { day: best[0], secs: best[1] } : null,
      streak, hour: hours.length ? +hours[0][0] : null, bpmAvg
    };
  }

  /* ---------------------------------------------------------------- pantallas */
  function slides(d) {
    const big = (t, sub, cls = '') => `<div class="wr-big ${cls}">${t}</div>${sub ? `<p class="wr-sub">${sub}</p>` : ''}`;
    const cover = (u, cls = '') => `<img class="wr-cover ${cls}" src="${esc(cover0(u))}" alt="">`;
    const top = d.topSongs[0], ta = d.topArtists[0];
    const out = [
      { c: 0, html: `<p class="wr-kicker">Tu resumen musical</p>${big(d.year, 'Esto es lo que has escuchado. Vamos allá.', 'wr-year')}` },
      { c: 1, html: `<p class="wr-kicker">Este año has escuchado</p>${big(`<span data-count="${d.mins}">0</span>`, `minutos de música · ${d.songs} canciones de ${d.artists} artistas`)}` },
      top && { c: 2, html: `<p class="wr-kicker">Tu canción</p>${cover(top.t.cover, 'flower')}<div class="wr-title">${esc(top.t.title)}</div><p class="wr-sub">${esc(top.t.artist)} · ${top.n} ${top.n === 1 ? 'vez' : 'veces'}</p>` },
      d.topSongs.length > 1 && { c: 0, html: `<p class="wr-kicker">Tus 5 canciones</p><ol class="wr-list">${d.topSongs.map((e, i) => `<li style="--i:${i}"><img src="${esc(cover0(e.t.cover, 120))}" alt=""><span><b>${esc(e.t.title)}</b><small>${esc(e.t.artist)}</small></span></li>`).join('')}</ol>` },
      ta && { c: 1, html: `<p class="wr-kicker">Tu artista</p>${cover(ta.cover, 'cookie')}<div class="wr-title">${esc(ta.name)}</div><p class="wr-sub">${fmtH(ta.secs)} juntos</p>${d.topArtists.length > 1 ? `<p class="wr-more">También: ${d.topArtists.slice(1).map(a => esc(a.name)).join(', ')}</p>` : ''}` },
      (d.best || d.streak > 1) && { c: 2, html: `<p class="wr-kicker">Tus días</p>${d.best ? big(new Date(d.best.day).getDate() + ' de ' + MESES[new Date(d.best.day).getMonth()], 'fue tu día con más música: ' + fmtH(d.best.secs), 'wr-mid') : ''}${d.streak > 1 ? `<p class="wr-streak">🔥 Racha de <b>${d.streak} días</b> seguidos</p>` : ''}` },
      d.hour != null && { c: 0, html: `<p class="wr-kicker">Tu hora</p>${big(String(d.hour).padStart(2, '0') + ':00', d.hour < 6 ? 'Lo tuyo es la madrugada' : d.hour < 13 ? 'Empiezas el día con música' : d.hour < 20 ? 'Las tardes suenan mejor' : 'La noche es tu momento')}` },
      d.bpmAvg && { c: 1, html: `<p class="wr-kicker">Tu ritmo</p>${big(d.bpmAvg + '<small> BPM</small>', d.bpmAvg < 90 ? 'Te va lo tranquilo' : d.bpmAvg < 115 ? 'Ritmo de los que mueven la cabeza' : 'Siempre a tope')}<div class="wr-beat" style="--b:${(60 / d.bpmAvg).toFixed(3)}s"></div>` },
      { c: 2, share: true, html: `<p class="wr-kicker">Tu resumen ${d.year}</p><div class="wr-card"></div><div class="wr-actions"><button class="btn" data-w="share">${icon('link')}Compartir</button><button class="btn tonal" data-w="save">${icon('download')}Guardar imagen</button></div>` }
    ];
    return out.filter(Boolean);
  }
  const cover0 = (u, size = 544) => (typeof cover === 'function' ? cover(u, size) : u) || PLACEHOLDER;

  /* ---------------------------------------------------------------- tarjeta para compartir */
  async function cardCanvas(d) {
    const W = 1080, H = 1920, c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d'), cs = getComputedStyle(document.documentElement);
    const col = n => cs.getPropertyValue(n).trim() || '#333';
    const g = x.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, col('--primary-container')); g.addColorStop(1, col('--tertiary-container'));
    x.fillStyle = g; x.fillRect(0, 0, W, H);
    const font = (w, s) => `${w} ${s}px "Google Sans Flex", "Google Sans", Roboto, sans-serif`;
    const fg = col('--on-primary-container');
    x.fillStyle = fg;
    x.font = font(700, 56); x.fillText('Tu resumen musical ' + d.year, 80, 150);
    // portada de tu canción en forma de flor
    const top = d.topSongs[0];
    // portada de tu canción recortada en forma de flor (si no hay portada, la flor de color)
    x.save(); x.beginPath();
    for (let k = 0; k <= 96; k++) { const a = k / 96 * Math.PI * 2, r = 330 * (1 + .09 * Math.cos(8 * a)) / 1.09; const px = W / 2 + r * Math.cos(a), py = 600 + r * Math.sin(a); k ? x.lineTo(px, py) : x.moveTo(px, py); }
    x.clip();
    const src = top && top.t.cover ? cover0(top.t.cover) : '';
    const img = /^https?:/.test(src) ? await new Promise(r => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => r(i); i.onerror = () => r(null); i.src = '/api/img?u=' + encodeURIComponent(src); }) : null;
    if (img) x.drawImage(img, W / 2 - 330, 270, 660, 660);
    else { x.fillStyle = col('--primary'); x.fillRect(W / 2 - 330, 270, 660, 660); }
    x.restore();
    x.fillStyle = fg;
    x.textAlign = 'center';
    x.font = font(800, 150); x.fillText(d.mins.toLocaleString('es-ES'), W / 2, 1110);
    x.font = font(600, 44); x.fillText('minutos escuchados', W / 2, 1175);
    x.textAlign = 'left';
    const col2 = (title, items, X) => {
      x.font = font(700, 38); x.globalAlpha = .75; x.fillText(title, X, 1300); x.globalAlpha = 1;
      x.font = font(600, 40);
      items.slice(0, 5).forEach((s, i) => { let t = `${i + 1}. ${s}`; while (x.measureText(t).width > 440 && t.length > 4) t = t.slice(0, -2) + '…'; x.fillText(t, X, 1370 + i * 64); });
    };
    col2('Canciones', d.topSongs.map(e => e.t.title), 80);
    col2('Artistas', d.topArtists.map(a => a.name), 570);
    x.font = font(600, 34); x.globalAlpha = .7; x.fillText('Música · ' + location.host, 80, H - 90); x.globalAlpha = 1;
    return c;
  }

  /* ---------------------------------------------------------------- visor de historias */
  function open() {
    const d = data();
    if (!d) return toast('Escucha algo de música primero para tener tu resumen');
    const list = slides(d);
    const ov = document.createElement('div');
    ov.id = 'wrapped'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-label', 'Tu resumen musical');
    ov.innerHTML = `<div class="wr-bars">${list.map(() => '<i><b></b></i>').join('')}</div>
      <button class="icb wr-close" aria-label="Cerrar">${icon('close')}</button>
      <div class="wr-stage"></div>`;
    document.body.appendChild(ov);
    const stage = ov.querySelector('.wr-stage'), bars = [...ov.querySelectorAll('.wr-bars b')];
    let i = -1, t0 = 0, paused = false, pauseAt = 0, raf = 0, done = false;

    function show(k) {
      if (k < 0) k = 0;
      if (k >= list.length) return close();
      i = k; t0 = performance.now(); pauseAt = 0;
      const s = list[i];
      ov.dataset.c = s.c;
      stage.innerHTML = `<div class="wr-slide">${s.html}</div>`;
      bars.forEach((b, j) => { b.style.width = j < i ? '100%' : '0%'; });
      // contador animado
      stage.querySelectorAll('[data-count]').forEach(el => {
        const to = +el.dataset.count, st = performance.now();
        const step = n => { const k2 = Math.min(1, (n - st) / 1600); el.textContent = Math.round(to * (1 - Math.pow(1 - k2, 3))).toLocaleString('es-ES'); if (k2 < 1 && !done) requestAnimationFrame(step); };
        requestAnimationFrame(step);
      });
      if (s.share) {
        cardCanvas(d).then(cv => {
          const box = stage.querySelector('.wr-card'); if (!box) return;
          cv.className = 'wr-canvas'; box.appendChild(cv);
          const blob = () => new Promise(r => cv.toBlob(r, 'image/png'));
          stage.querySelector('[data-w=save]').onclick = async e => { e.stopPropagation(); const b = await blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `resumen-musica-${d.year}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 30000); };
          stage.querySelector('[data-w=share]').onclick = async e => {
            e.stopPropagation();
            const b = await blob(), file = new File([b], `resumen-musica-${d.year}.png`, { type: 'image/png' });
            if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: 'Mi resumen musical ' + d.year }); } catch (_) {} }
            else { stage.querySelector('[data-w=save]').click(); toast('Tu navegador no permite compartir: se ha guardado la imagen'); }
          };
        });
      }
    }
    function loop(n) {
      if (done) return;
      if (!paused && i >= 0 && !list[i].share) {
        const k = (n - t0) / SLIDE_MS;
        bars[i].style.width = Math.min(100, k * 100) + '%';
        if (k >= 1) show(i + 1);
      } else if (i >= 0 && list[i].share) bars[i].style.width = '100%';
      raf = requestAnimationFrame(loop);
    }
    function close() {
      if (done) return; done = true; cancelAnimationFrame(raf);
      ov.classList.add('out'); setTimeout(() => ov.remove(), 300);
      removeEventListener('keydown', key, true);
    }
    // tocar: izquierda atrás, derecha adelante; mantener: pausa; deslizar abajo: cerrar
    let down = null;
    ov.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
      paused = true; pauseAt = performance.now();
    });
    ov.addEventListener('pointerup', e => {
      if (!down) return;
      const dy = e.clientY - down.y, held = performance.now() - down.t;
      t0 += performance.now() - pauseAt; paused = false;
      const d0 = down; down = null;
      if (dy > 90) return close();
      if (held < 250 && Math.abs(e.clientX - d0.x) < 20) show(e.clientX < innerWidth * .35 ? i - 1 : i + 1);
    });
    ov.querySelector('.wr-close').onclick = close;
    const key = e => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      if (e.key === 'ArrowRight') { e.stopPropagation(); show(i + 1); }
      if (e.key === 'ArrowLeft') { e.stopPropagation(); show(i - 1); }
    };
    addEventListener('keydown', key, true);
    show(0);
    raf = requestAnimationFrame(loop);
  }

  return { open, data };
})();
window.Wrapped = Wrapped;
