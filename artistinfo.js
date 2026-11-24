'use strict';
/* artistinfo.js — tarjeta "Acerca del artista" (como la de Spotify):
   foto grande, oyentes al mes y suscriptores (YouTube Music), biografía en tu idioma, datos
   (nacimiento o formación, origen, géneros) y enlaces (Wikipedia, Spotify), de Wikidata.
   Sale en la página de cada artista, en el reproductor (botón "Artista") y en el panel
   "Ahora suena" del ordenador. Se guarda una semana en este navegador. */
const ArtistInfo = (() => {
  const LS = 'mz:artistInfo', TTL = 7 * 86400e3, mem = new Map(), inflight = new Map();
  const lang = () => (window.I18n && I18n.lang) || 'es';
  const read = () => { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch (_) { return {}; } };
  function save(k, v) {
    try {
      const all = read(); all[k] = v;
      const keys = Object.keys(all).sort((a, b) => all[b].t - all[a].t);
      keys.slice(40).forEach(x => delete all[x]);          // como mucho 40 artistas guardados
      localStorage.setItem(LS, JSON.stringify(all));
    } catch (_) {}
  }
  const big = u => String(u || '').replace(/=w\d+-h\d+[^/?]*$/, '=w1200-h500-p-l90-rj');

  // datos del artista (ytm: lo que ya se trajo de YouTube Music, para no pedirlo dos veces)
  async function get(id, name, ytm) {
    if (!id) return null;
    const k = id + ':' + lang();
    const m = mem.get(k) || read()[k];
    if (m && Date.now() - m.t < TTL) { mem.set(k, m); return m; }
    if (inflight.has(k)) return inflight.get(k);
    const p = (async () => {
      const a = ytm || await YTM.artist(id);
      const q = new URLSearchParams({ ytm: id, name: a.name || name || '', lang: lang() });
      if (a.channelId) q.set('yt', a.channelId);
      const w = await fetch('/api/artistinfo?' + q, { credentials: 'same-origin' }).then(r => r.ok ? r.json() : {}).catch(() => ({}));
      const ytDesc = String(a.desc || '').trim();
      const v = {
        t: Date.now(), id, name: a.name || name || '', img: big(a.banner) || a.cover || '', cover: a.cover || '',
        listeners: a.listeners || '', subs: a.subs || '',
        bio: (w.wiki && w.wiki.text) || (ytDesc.length > 60 ? ytDesc : ''),
        wiki: w.wiki ? { url: w.wiki.url, lang: w.wiki.lang } : null,
        facts: w.facts || null, spotify: w.spotify || ''
      };
      mem.set(k, v); save(k, v);
      return v;
    })().finally(() => inflight.delete(k));
    inflight.set(k, p);
    return p;
  }

  const fmtDate = d => {
    if (!d) return '';
    try {
      const dt = new Date(Date.UTC(d.y, Math.max(0, (d.m || 1) - 1), d.d || 1));
      const o = d.p >= 11 ? { day: 'numeric', month: 'long', year: 'numeric' } : d.p === 10 ? { month: 'long', year: 'numeric' } : { year: 'numeric' };
      return dt.toLocaleDateString(lang(), { ...o, timeZone: 'UTC' });
    } catch (_) { return String(d.y); }
  };
  const age = (b, dd) => { if (!b || b.p < 11) return 0; const e = dd ? new Date(Date.UTC(dd.y, dd.m - 1, dd.d)) : new Date(); let n = e.getUTCFullYear() - b.y; if (e.getUTCMonth() + 1 < b.m || (e.getUTCMonth() + 1 === b.m && e.getUTCDate() < b.d)) n--; return n; };

  // la tarjeta (compact: versión pequeña para el panel del ordenador)
  function card(v, { compact = false, link = false } = {}) {
    const c = el(`<section class="ai${compact ? ' ai-compact' : ''}">
      <div class="ai-img">${v.img ? `<img src="${esc(v.img)}" alt="" loading="lazy">` : ''}<span class="ai-eyebrow">Acerca del artista</span></div>
      <div class="ai-body">
        <div class="ai-side">
          ${v.listeners ? `<div class="ai-stat"><b>${esc(v.listeners)}</b><span>oyentes mensuales</span></div>` : ''}
          ${v.subs ? `<div class="ai-stat"><b>${esc(v.subs)}</b><span>suscriptores</span></div>` : ''}
        </div>
        <div class="ai-main">
          <h3 class="ai-name"></h3>
          <p class="ai-bio"></p>
          <button class="chip ai-more" type="button" hidden>Leer más</button>
          <div class="ai-facts"></div>
          <div class="ai-links"></div>
        </div>
      </div>
    </section>`);
    c.querySelector('.ai-name').textContent = v.name;
    const bio = c.querySelector('.ai-bio');
    bio.textContent = v.bio || 'No hay biografía de este artista.';
    bio.classList.toggle('muted', !v.bio);
    const more = c.querySelector('.ai-more');
    if (v.bio && v.bio.length > (compact ? 160 : 320)) {
      more.hidden = false;
      bio.classList.add('clamp');
      more.onclick = () => { const open = bio.classList.toggle('clamp'); more.textContent = open ? 'Leer más' : 'Leer menos'; };
    }
    // datos
    const f = v.facts, facts = c.querySelector('.ai-facts');
    if (f) {
      const row = (k, val) => { if (!val) return; const r = el('<div class="ai-fact"><span class="muted"></span><span></span></div>'); r.children[0].textContent = k; r.children[1].textContent = val; facts.appendChild(r); };
      const where = [f.place, f.country].filter((x, i, a) => x && a.indexOf(x) === i).join(', ');
      if (f.born) { const a = age(f.born, f.died); row(f.died ? 'Nació' : 'Nacimiento', fmtDate(f.born) + (a > 0 && !f.died ? ` (${a} años)` : '')); }
      if (f.died) row('Murió', fmtDate(f.died));
      if (f.formed) row('Formación', fmtDate(f.formed));
      row(f.born ? 'Lugar de nacimiento' : 'Origen', where);
      if (f.genres && f.genres.length) {
        const g = el('<div class="ai-genres"></div>');
        f.genres.forEach(x => { const s = el('<span class="ai-genre"></span>'); s.textContent = x; g.appendChild(s); });
        facts.appendChild(g);
      }
    }
    // enlaces
    const links = c.querySelector('.ai-links');
    if (link && v.id) { const b = el(`<button class="btn tonal" type="button">${icon('person')}<span>Ver artista</span></button>`); b.onclick = () => { App.closePlayer && $('#player').classList.contains('open') && App.closePlayer(); Features.openArtist(v.id, { title: v.name, cover: v.cover }); }; links.appendChild(b); }
    if (v.spotify) links.appendChild(el(`<a class="btn tonal" href="https://open.spotify.com/artist/${esc(v.spotify)}" target="_blank" rel="noopener noreferrer">Spotify</a>`));
    if (v.wiki) links.appendChild(el(`<a class="btn tonal" href="${esc(v.wiki.url)}" target="_blank" rel="noopener noreferrer">Wikipedia</a>`));
    if (v.wiki) c.querySelector('.ai-main').appendChild(el('<small class="ai-src muted">Biografía: Wikipedia (CC BY-SA)</small>'));
    return c;
  }

  // en un contenedor: indicador de carga y luego la tarjeta
  async function mount(box, id, name, opts = {}, ytm) {
    box.innerHTML = '';
    if (!id) { if (!opts.compact) box.appendChild(el('<p class="muted ai-none">No hay información de este artista.</p>')); return; }
    box.dataset.aid = id;
    const sp = opts.compact ? null : App.loading(box);
    try {
      const v = await get(id, name, ytm);
      if (box.dataset.aid !== id) return;           // mientras tanto cambió de canción
      sp && sp.remove();
      box.innerHTML = '';
      if (v) box.appendChild(card(v, opts));
    } catch (_) { sp && sp.remove(); if (!opts.compact) box.appendChild(el('<p class="muted ai-none">No se pudo cargar la información del artista.</p>')); }
  }

  /* ---------------------------------------------------------------- reproductor y panel */
  const curArtist = () => { const t = App.current; return t ? { id: t.artistId || '', name: String(t.artist || '').split(/,|&/)[0].trim() } : { id: '', name: '' }; };
  function panel(p) {
    p.classList.remove('synced');
    p.innerHTML = '';
    const box = el('<div class="ai-panel"></div>');
    p.appendChild(box);
    const a = curArtist();
    mount(box, a.id, a.name, { link: true });
  }
  // panel "Ahora suena" (ordenador): debajo de "A continuación"
  function nowPanel() {
    const host = document.getElementById('n-about');
    if (!host) return;
    const a = curArtist();
    if (host.dataset.aid === a.id && host.firstChild) return;
    host.dataset.aid = a.id;
    if (!a.id) { host.innerHTML = ''; return; }
    clearTimeout(nowPanel.t);
    nowPanel.t = setTimeout(() => mount(host, a.id, a.name, { compact: true, link: true }), 1200);
  }
  document.addEventListener('DOMContentLoaded', () => {
    App.on('track', () => {
      nowPanel();
      const p = document.querySelector('#player .p-panel');
      if (p && !p.hidden && p.dataset.kind === 'artist') panel(p);
    });
    setTimeout(nowPanel, 2000);
  }, { once: true });

  return { get, card, mount, panel };
})();
window.ArtistInfo = ArtistInfo;
