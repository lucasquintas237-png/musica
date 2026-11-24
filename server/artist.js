/* server/artist.js — ficha "Acerca del artista" con datos abiertos.
     GET /api/artistinfo?yt=<canal de YouTube>&ytm=<id del artista en YT Music>&name=<nombre>&lang=es|gl|ca|eu|en
   - Busca al artista en Wikidata: primero por su canal de YouTube (P2397, sin ambigüedad) y si no,
     por su nombre exacto entre quienes tienen ficha de Spotify o MusicBrainz (es decir, músicos).
   - De Wikidata saca: nacimiento / formación, origen, géneros, su id de Spotify (para el enlace)
     y el artículo de Wikipedia en tu idioma, del que se trae la introducción (biografía).
   - Todo se guarda una semana en la caché de Cloudflare (los datos cambian poco).
   Los números de Spotify (oyentes, seguidores, puesto mundial) no están en ninguna fuente abierta:
   solo en su API privada, que no se usa. Los oyentes y suscriptores los pone la app desde
   YouTube Music. Los textos de Wikipedia son CC BY-SA: la app enlaza el artículo. */
const UA = 'MusicaApp/1.0 (artist info; Cloudflare Worker)';
const LANGS = ['es', 'gl', 'ca', 'eu', 'en'];
const CH_RE = /^UC[\w-]{22}$/;
const json = (status, body, cache) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache || 'no-store' } });

async function get(url, type = 'json') {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: type === 'json' ? 'application/json' : '*/*' }, signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw new Error('upstream ' + r.status);
  return r.json();
}
const sparql = q => get('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q)).then(j => (j.results && j.results.bindings) || []);
const qid = v => { const m = String(v || '').match(/(Q\d{1,12})$/); return m ? m[1] : ''; };
// texto seguro para meterlo en una consulta SPARQL (entre comillas)
const lit = s => '"' + String(s).replace(/[\\"\n\r\t]/g, ' ').slice(0, 100) + '"';

async function findEntity(yt, name) {
  const chans = yt.filter(c => CH_RE.test(c));
  if (chans.length) {
    const b = await sparql(`SELECT ?it WHERE { VALUES ?c { ${chans.map(lit).join(' ')} } ?it wdt:P2397 ?c . } LIMIT 1`).catch(() => []);
    if (b[0]) return qid(b[0].it.value);
  }
  if (name) {
    const n = lit(name);
    const b = await sparql(`SELECT ?it ?sl WHERE { VALUES ?n { ${['es', 'en', 'ca', 'gl', 'eu', 'mul'].map(l => n + '@' + l).join(' ')} }
      ?it rdfs:label ?n . { ?it wdt:P1902 [] } UNION { ?it wdt:P434 [] } . ?it wikibase:sitelinks ?sl } ORDER BY DESC(?sl) LIMIT 1`).catch(() => []);
    if (b[0]) return qid(b[0].it.value);
  }
  return '';
}

const claim = (e, p) => ((e.claims && e.claims[p]) || []).filter(c => c.mainsnak && c.mainsnak.datavalue).map(c => c.mainsnak.datavalue.value);
const year = v => { const m = v && v.time && v.time.match(/^[+-](\d{4})-(\d\d)-(\d\d)/); return m ? { y: +m[1], m: +m[2], d: +m[3], p: v.precision } : null; };

async function labels(ids, lang) {
  if (!ids.length) return {};
  const j = await get(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels&languages=${lang}|es|en&ids=${ids.slice(0, 40).join('|')}`).catch(() => ({}));
  const out = {};
  Object.entries(j.entities || {}).forEach(([k, v]) => { const l = v.labels || {}; out[k] = (l[lang] || l.es || l.en || {}).value || ''; });
  return out;
}

async function wikiIntro(lang, title) {
  const j = await get(`https://${lang}.wikipedia.org/w/api.php?action=query&format=json&prop=extracts&exintro=1&explaintext=1&redirects=1&titles=${encodeURIComponent(title)}`);
  const pg = Object.values((j.query && j.query.pages) || {})[0];
  let t = String((pg && pg.extract) || '').replace(/\n{2,}/g, '\n\n').trim();
  if (t.length > 1800) t = t.slice(0, 1800).replace(/\s+\S*$/, '') + '…';
  return t;
}

async function build(yt, name, lang) {
  const id = await findEntity(yt, name);
  if (!id) return { found: false };
  const e = ((await get(`https://www.wikidata.org/wiki/Special:EntityData/${id}.json`)).entities || {})[id];
  if (!e) return { found: false };
  const born = year(claim(e, 'P569')[0]), died = year(claim(e, 'P570')[0]), formed = year(claim(e, 'P571')[0]);
  const place = claim(e, 'P19').map(v => v.id)[0] || claim(e, 'P740').map(v => v.id)[0] || '';
  const country = claim(e, 'P27').map(v => v.id)[0] || claim(e, 'P495').map(v => v.id)[0] || '';
  const genres = claim(e, 'P136').map(v => v.id).slice(0, 5);
  const L = await labels([place, country, ...genres].filter(Boolean), lang);
  // artículo de Wikipedia: tu idioma, si no español, si no inglés
  let wiki = null;
  for (const l of [lang, 'es', 'en']) {
    const sl = e.sitelinks && e.sitelinks[l + 'wiki'];
    if (!sl) continue;
    const text = await wikiIntro(l, sl.title).catch(() => '');
    if (text) { wiki = { lang: l, title: sl.title, url: `https://${l}.wikipedia.org/wiki/${encodeURIComponent(sl.title.replace(/ /g, '_'))}`, text }; break; }
  }
  const spotify = claim(e, 'P1902').find(v => /^[A-Za-z0-9]{22}$/.test(v)) || '';
  return {
    found: true, qid: id, wiki, spotify,
    facts: {
      born: born && !formed ? born : null, died, formed,
      place: L[place] || '', country: L[country] || '',
      genres: genres.map(g => L[g]).filter(Boolean)
    }
  };
}

export async function handleArtist(request) {
  const u = new URL(request.url);
  const yt = [u.searchParams.get('yt'), u.searchParams.get('ytm')].filter(Boolean).map(String);
  const name = String(u.searchParams.get('name') || '').trim().slice(0, 100);
  const lang = LANGS.includes(u.searchParams.get('lang')) ? u.searchParams.get('lang') : 'es';
  if (!yt.some(c => CH_RE.test(c)) && !name) return json(400, { error: 'Falta el artista' });
  // caché de Cloudflare (una semana); la clave no lleva datos de la persona
  const key = new Request(`https://cache.musica/artistinfo/v1/${lang}/${yt.filter(c => CH_RE.test(c)).join(',')}/${encodeURIComponent(name.toLowerCase())}`);
  const cache = typeof caches !== 'undefined' && caches.default;
  if (cache) { const hit = await cache.match(key); if (hit) return hit; }
  let data;
  try { data = await build(yt, name, lang); } catch (_) { return json(502, { error: 'No se pudo consultar Wikipedia' }); }
  const res = json(200, data, 'public, max-age=' + (data.found ? 604800 : 86400));
  if (cache) await cache.put(key, res.clone()).catch(() => {});
  return res;
}
