'use strict';
/* profile.js — perfiles: foto y descripción.
   - Profile.av(nombre, clase) da el avatar de cualquiera (foto o su inicial). Allá donde salga,
     al pulsarlo se abre su perfil.
   - Tu perfil se edita desde él mismo: foto (la app la recorta en cuadrado, la reduce a 256 px y
     la vuelve a codificar en WebP, así no viajan metadatos como el GPS) y una descripción corta.
   - Las fotos se piden al servidor una vez por persona y se guardan unos minutos en memoria. */
const Profile = (() => {
  const TTL = 5 * 60e3, BIO_MAX = 160;
  const cache = new Map(), inflight = new Map();     // nombre en minúsculas -> {username, bio, avatar, since, t}
  const key = n => String(n || '').toLowerCase();
  const initialOf = n => esc((String(n || '?').trim().charAt(0) || '?').toUpperCase());
  const imgUrl = (n, v) => `/api/profile/${encodeURIComponent(n)}/avatar?v=${encodeURIComponent(v)}`;
  const on = () => !!(window.Account && Account.supported === true && Account.user);

  // HTML del avatar: se puede meter en cualquier plantilla
  function av(name, cls = '') {
    if (!name) return '';
    const c = cache.get(key(name));
    if (!c || Date.now() - c.t > TTL) queue(name);
    const img = c && c.avatar ? `<img class="pf-img" src="${esc(imgUrl(c.username, c.avatar))}" alt="" draggable="false">` : '';
    return `<span class="pf-av ${cls}" data-profile="${esc(name)}" role="button" tabindex="0" aria-label="Perfil de ${esc(name)}"><span class="pf-ini" aria-hidden="true">${initialOf(name)}</span>${img}</span>`;
  }

  // datos de un perfil (con caché y sin pedir dos veces lo mismo a la vez)
  async function get(name, fresh) {
    const k = key(name), c = cache.get(k);
    if (!fresh && c && Date.now() - c.t < TTL) return c;
    if (inflight.has(k)) return inflight.get(k);
    const p = (async () => {
      try {
        const r = await fetch('/api/profile/' + encodeURIComponent(name), { credentials: 'same-origin' });
        if (!r.ok) { const e = new Error(r.status === 404 ? 'No existe esa persona' : 'No se pudo cargar el perfil'); e.status = r.status; throw e; }
        const j = await r.json();
        const v = { username: String(j.username || name), bio: String(j.bio || ''), avatar: j.avatar || null, since: +j.since || 0, me: !!j.me, t: Date.now() };
        cache.set(k, v);
        return v;
      } finally { inflight.delete(k); }
    })();
    inflight.set(k, p);
    return p;
  }

  // los avatares que se pintaron sin saber aún si había foto se completan al llegar los datos
  const pending = new Set();
  let qt = 0;
  function queue(name) {
    if (!on()) return;
    pending.add(name);
    clearTimeout(qt);
    qt = setTimeout(() => {
      const names = [...pending]; pending.clear();
      names.forEach(n => get(n).then(paint).catch(() => {
        // sin datos: se deja la inicial y no se vuelve a preguntar en un rato
        cache.set(key(n), { username: n, bio: '', avatar: null, since: 0, t: Date.now() });
      }));
    }, 60);
  }
  function paint(p) {
    const k = key(p.username);
    $$('.pf-av[data-profile]').forEach(a => {
      if (key(a.dataset.profile) !== k) return;
      const old = a.querySelector('.pf-img');
      if (!p.avatar) { old && old.remove(); return; }
      const src = imgUrl(p.username, p.avatar);
      if (old && old.getAttribute('src') === src) return;
      const im = old || document.createElement('img');
      im.className = 'pf-img'; im.alt = ''; im.draggable = false;
      im.src = src;
      if (!old) a.appendChild(im);
    });
  }
  // si una foto no carga, se queda la inicial
  document.addEventListener('error', e => { const t = e.target; if (t instanceof HTMLImageElement && t.classList.contains('pf-img')) t.remove(); }, true);

  // al pulsar cualquier avatar se abre el perfil
  function fromEvent(e) {
    const a = e.target.closest && e.target.closest('.pf-av[data-profile]');
    if (!a || a.closest('.pf-hero')) return null;
    return a.dataset.profile;
  }
  document.addEventListener('click', e => {
    const n = fromEvent(e);
    if (!n) return;
    e.preventDefault(); e.stopPropagation();
    open(n);
  }, true);
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const n = fromEvent(e);
    if (!n) return;
    e.preventDefault(); e.stopPropagation();
    open(n);
  }, true);

  const monthYear = t => { try { return new Date(t).toLocaleDateString(document.documentElement.lang || 'es', { month: 'long', year: 'numeric' }); } catch (_) { return ''; } };

  /* ---------------------------------------------------------------- vista del perfil */
  function open(name) {
    if (!on()) return toast('Inicia sesión para ver perfiles');
    // lo que tape la vista (hoja de la sala, reproductor a pantalla completa) se cierra antes
    if (!$('#sheet').hidden) App.closeSheet();
    if ($('#player').classList.contains('open')) App.closePlayer();
    // si ya estás viendo ese perfil, no se apila otro igual
    const top = App.views[App.views.length - 1];
    if (top && top.dataset.profile && key(top.dataset.profile) === key(name)) return;
    const v = App.openView('Perfil', box => {
      box.innerHTML = '';
      const sp = App.loading(box);
      get(name, true).then(p => { sp.remove(); render(box, p); }).catch(e => {
        sp.remove();
        box.appendChild(el(`<p class="muted pf-empty">${esc(e.message || 'No se pudo cargar el perfil')}</p>`));
      });
    });
    v.dataset.profile = name;
  }
  function render(box, p) {
    box.innerHTML = '';
    const mine = p.me || key(p.username) === key(Account.user);
    const h = el(`<div class="pf-hero">
      ${av(p.username, 'pf-big')}
      <h1 class="pf-name"></h1>
      <p class="pf-bio"></p>
      ${p.since ? `<p class="muted pf-since">Miembro desde ${esc(monthYear(p.since))}</p>` : ''}
      <div class="pf-actions"></div>
    </div>`);
    h.querySelector('.pf-name').textContent = p.username;
    const bio = h.querySelector('.pf-bio');
    bio.textContent = p.bio || (mine ? 'Aún no has escrito nada sobre ti.' : '');
    bio.classList.toggle('muted', !p.bio);
    bio.hidden = !p.bio && !mine;
    const big = h.querySelector('.pf-big');
    big.removeAttribute('role'); big.removeAttribute('tabindex');
    if (mine) {
      const act = h.querySelector('.pf-actions');
      const ed = el(`<button class="btn" type="button">${icon('edit')}<span>Editar perfil</span></button>`);
      ed.onclick = () => edit(p, () => render(box, cache.get(key(p.username)) || p));
      const ac = el(`<button class="btn tonal" type="button">${icon('person')}<span>Cuenta</span></button>`);
      ac.onclick = () => Account.accountMenu(ac);
      act.append(ed, ac);
    }
    box.appendChild(h);
  }

  /* ---------------------------------------------------------------- editar el tuyo */
  // la foto se rehace en el propio navegador: recorte cuadrado centrado, 256 px, WebP (o JPEG)
  async function encode(file, q = .86) {
    if (!/^image\//.test(file.type || '')) throw new Error('Elige una imagen');
    if (file.size > 25 * 1024 * 1024) throw new Error('La imagen es demasiado grande');
    let src, w, h, done = () => {};
    try { src = await createImageBitmap(file); w = src.width; h = src.height; done = () => src.close && src.close(); }
    catch (_) {
      const url = URL.createObjectURL(file);
      src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('No se pudo leer la imagen')); i.src = url; });
      w = src.naturalWidth; h = src.naturalHeight; done = () => URL.revokeObjectURL(url);
    }
    try {
      if (!w || !h) throw new Error('No se pudo leer la imagen');
      const S = 256, side = Math.min(w, h);
      const cv = document.createElement('canvas'); cv.width = cv.height = S;
      const cx = cv.getContext('2d');
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(src, (w - side) / 2, (h - side) / 2, side, side, 0, 0, S, S);
      const blob = (type, quality) => new Promise(r => cv.toBlob(r, type, quality));
      let b = await blob('image/webp', q);
      if (!b || b.type !== 'image/webp') b = await blob('image/jpeg', q);
      for (let qq = q - .15; b && b.size > 190 * 1024 && qq > .3; qq -= .15) b = await blob(b.type, qq);
      if (!b) throw new Error('No se pudo preparar la imagen');
      return b;
    } finally { done(); }
  }
  async function upload(file) {
    let last;
    // dos intentos con distinta calidad: si el servidor rechaza los bytes, otra codificación vale
    for (const q of [.86, .8]) {
      const b = await encode(file, q);
      const r = await fetch('/api/profile/avatar', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': b.type }, body: b });
      let j = null; try { j = await r.json(); } catch (_) {}
      if (r.ok && j && j.avatar) return j.avatar;
      last = new Error((j && j.error) || 'No se pudo subir la foto');
      if (r.status !== 400) break;
    }
    throw last;
  }

  function edit(p, after) {
    const me = Account.user;
    App.sheet({
      title: 'Editar perfil', sub: 'Lo verán en las salas',
      body: box => {
        const f = el(`<form class="acct-form pf-form">
          <div class="pf-photo">${av(me, 'pf-mid')}
            <div class="pf-photo-btns">
              <label class="btn tonal pf-pick">${icon('image')}<span>Cambiar foto</span><input type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif,image/heic" hidden></label>
              <button type="button" class="btn text pf-del"${p.avatar ? '' : ' hidden'}>Quitar foto</button>
            </div>
          </div>
          <label><span>Descripción</span><textarea name="bio" maxlength="${BIO_MAX}" rows="3" placeholder="Cuéntales qué música te gusta…"></textarea><small class="pf-count"></small></label>
          <p class="acct-err" role="alert" hidden></p>
          <div class="acct-actions"><button type="button" class="btn tonal" data-cancel>Cancelar</button><button class="btn" type="submit">Guardar</button></div>
        </form>`);
        const errBox = f.querySelector('.acct-err'), ta = f.bio, count = f.querySelector('.pf-count');
        const mid = f.querySelector('.pf-mid');
        mid.removeAttribute('role'); mid.removeAttribute('tabindex'); mid.removeAttribute('data-profile');
        const showErr = m => { errBox.textContent = m; errBox.hidden = !m; };
        ta.value = p.bio || '';
        const upd = () => { count.textContent = `${ta.value.length}/${BIO_MAX}`; };
        ta.oninput = upd; upd();
        let picked = null, removed = false, preview = '';
        const setPreview = url => {
          let im = mid.querySelector('.pf-img');
          if (!url) { im && im.remove(); return; }
          if (!im) { im = document.createElement('img'); im.className = 'pf-img'; im.alt = ''; mid.appendChild(im); }
          im.src = url;
        };
        f.querySelector('input[type=file]').onchange = async e => {
          const file = e.target.files && e.target.files[0];
          e.target.value = '';
          if (!file) return;
          showErr('');
          try {
            const b = await encode(file);          // vista previa tal como se subirá
            picked = file; removed = false;
            if (preview) URL.revokeObjectURL(preview);
            preview = URL.createObjectURL(b);
            setPreview(preview);
            f.querySelector('.pf-del').hidden = false;
          } catch (err) { showErr(err.message || 'No se pudo leer la imagen'); }
        };
        f.querySelector('.pf-del').onclick = () => {
          picked = null; removed = true; setPreview('');
          f.querySelector('.pf-del').hidden = true;
        };
        f.querySelector('[data-cancel]').onclick = () => App.closeSheet();
        f.onsubmit = async e => {
          e.preventDefault();
          showErr('');
          const btn = f.querySelector('[type=submit]');
          btn.disabled = true;
          try {
            const c = cache.get(key(me)) || { ...p };
            if (picked) c.avatar = await upload(picked);
            else if (removed && p.avatar) {
              const r = await fetch('/api/profile/avatar', { method: 'DELETE', credentials: 'same-origin' });
              if (!r.ok) throw new Error('No se pudo quitar la foto');
              c.avatar = null;
            }
            if (ta.value.trim() !== (p.bio || '')) {
              const r = await fetch('/api/profile', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bio: ta.value }) });
              let j = null; try { j = await r.json(); } catch (_) {}
              if (!r.ok) throw new Error((j && j.error) || 'No se pudo guardar la descripción');
              c.bio = j.bio;
            }
            c.t = Date.now();
            cache.set(key(me), c);
            if (preview) URL.revokeObjectURL(preview);
            paint(c);
            App.closeSheet();
            toast('Perfil guardado');
            after && after();
          } catch (err) { showErr(err.message || 'No se pudo conectar con el servidor'); btn.disabled = false; }
        };
        box.appendChild(f);
      }
    });
  }

  return { av, open, get, paint };
})();
window.Profile = Profile;
