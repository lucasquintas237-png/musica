#!/usr/bin/env node
/* musica-discord.mjs — pone en tu estado de Discord lo que suena en Música:
     «Escuchando <canción>», con el artista, la portada, el tiempo y un botón para escucharla.

   Cómo funciona: cada pocos segundos pregunta a la web qué suena en tu cuenta (API con tu token,
   solo de lectura) y se lo cuenta a la app de Discord de este ordenador por su conexión local
   (Rich Presence). No toca nada más de Discord ni de tu cuenta.

   Uso (necesita Node.js 18 o más nuevo y Discord abierto en el ordenador):
     node musica-discord.mjs                 la primera vez te pide el token y lo guarda
     node musica-discord.mjs ms_xxxxxxxx     con el token directamente
   Para pararlo: Ctrl+C (o cierra la ventana). El estado se quita solo. */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const SITE = process.env.MUSICA_URL || 'https://musica.lucasquintas237.workers.dev';
// id de la aplicación de Discord "Música" (su nombre es lo que sale en «Escuchando a …»)
const APP_ID = process.env.DISCORD_APP_ID || '__DISCORD_APP_ID__';
// el token que pone la web al descargarlo desde Configuración → Discord (si no, se pide)
const BAKED = '__MUSICA_TOKEN__';
const EVERY = 5000;
const CONF = path.join(path.dirname(fileURLToPath(import.meta.url)), 'musica-discord.json');

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------------------------------------------------------- token */
async function getToken() {
  const arg = process.argv.slice(2).find(a => /^ms_[a-f0-9]{40}$/i.test(a));
  if (arg) { save({ token: arg }); return arg; }
  if (process.env.MUSICA_TOKEN) return process.env.MUSICA_TOKEN;
  if (/^ms_[a-f0-9]{40}$/i.test(BAKED)) return BAKED;
  try { const c = JSON.parse(fs.readFileSync(CONF, 'utf8')); if (/^ms_[a-f0-9]{40}$/i.test(c.token || '')) return c.token; } catch (_) {}
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('Crea un token en la web: Configuración → Discord → «Crear token» (o Configuración → API).');
  for (;;) {
    const t = (await rl.question('Pega aquí tu token (ms_...): ')).trim();
    if (/^ms_[a-f0-9]{40}$/i.test(t)) { rl.close(); save({ token: t }); return t; }
    console.log('Ese no parece un token válido.');
  }
}
function save(c) { try { fs.writeFileSync(CONF, JSON.stringify(c), { mode: 0o600 }); } catch (_) {} }

/* ---------------------------------------------------------------- conexión local con Discord (IPC) */
function pipePaths() {
  if (process.platform === 'win32') return Array.from({ length: 10 }, (_, i) => `\\\\?\\pipe\\discord-ipc-${i}`);
  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp';
  const dirs = [base, path.join(base, 'app/com.discordapp.Discord'), path.join(base, 'snap.discord'), '/tmp'];
  return dirs.flatMap(d => Array.from({ length: 10 }, (_, i) => path.join(d, `discord-ipc-${i}`)));
}
const frame = (op, data) => {
  const body = Buffer.from(JSON.stringify(data));
  const h = Buffer.alloc(8); h.writeInt32LE(op, 0); h.writeInt32LE(body.length, 4);
  return Buffer.concat([h, body]);
};
function connectOne(p) {
  return new Promise((res, rej) => {
    const s = net.createConnection(p, () => res(s));
    s.once('error', rej);
  });
}
async function connect() {
  for (const p of pipePaths()) {
    let s;
    try { s = await connectOne(p); } catch (_) { continue; }
    const ok = await new Promise(res => {
      let buf = Buffer.alloc(0);
      const t = setTimeout(() => res(false), 5000);
      s.on('data', d => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 8) {
          const op = buf.readInt32LE(0), len = buf.readInt32LE(4);
          if (buf.length < 8 + len) break;
          let msg = {}; try { msg = JSON.parse(buf.subarray(8, 8 + len).toString()); } catch (_) {}
          buf = buf.subarray(8 + len);
          if (op === 3) s.write(frame(4, msg));                         // ping -> pong
          if (msg.evt === 'READY') { clearTimeout(t); res(true); }
          if (msg.evt === 'ERROR') log('Discord:', msg.data && msg.data.message);
          if (op === 2) { clearTimeout(t); if (msg.message) log('Discord dice:', msg.message); res(false); }   // Discord cerró
        }
      });
      s.once('close', () => { clearTimeout(t); res(false); });
      s.write(frame(0, { v: 1, client_id: APP_ID }));
    });
    if (ok) return s;
    s.destroy();
  }
  return null;
}

/* ---------------------------------------------------------------- qué suena */
async function nowPlaying(token) {
  const r = await fetch(SITE + '/api/v1/now', { headers: { Authorization: 'Bearer ' + token } });
  if (r.status === 401) throw Object.assign(new Error('El token no es válido o se ha borrado'), { fatal: true });
  if (!r.ok) throw new Error('La web respondió ' + r.status);
  return r.json();
}
const cut = (s, n) => { s = String(s || '').trim(); if (s.length < 2) s = (s + '  ').slice(0, 2); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const bigCover = u => String(u || '').replace(/=w\d+-h\d+[^/]*$/, '=w512-h512-l90-rj').replace(/\/(mq|sd|default)default\.jpg/, '/hqdefault.jpg');
function activityOf(np) {
  const t = np.track;
  const start = Date.now() - (np.position || 0) * 1000;
  const a = {
    type: 2,                      // «Escuchando»
    status_display_type: 2,       // en la lista de miembros sale el título: «Escuchando <canción>»
    details: cut(t.title, 128),
    state: cut(t.artist, 128),
    assets: { large_text: cut(t.album || t.title, 128) },
    buttons: [{ label: 'Escuchar en YouTube Music', url: 'https://music.youtube.com/watch?v=' + t.id }],
    instance: false
  };
  if (t.cover && /^https:\/\//.test(t.cover)) a.assets.large_image = bigCover(t.cover);
  if (np.duration) a.timestamps = { start: Math.round(start), end: Math.round(start + np.duration * 1000) };
  return a;
}

/* ---------------------------------------------------------------- bucle */
async function main() {
  if (!/^\d{17,20}$/.test(APP_ID)) { console.error('Falta el id de la aplicación de Discord (DISCORD_APP_ID).'); process.exit(1); }
  const token = await getToken();
  log('Música → Discord. Ctrl+C para parar.');
  let sock = null, last = '', nonce = 0, warned = false;
  const set = activity => {
    if (!sock) return;
    sock.write(frame(1, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity }, nonce: String(++nonce) }));
  };
  const stop = () => { try { set(null); } catch (_) {} setTimeout(() => process.exit(0), 300); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);

  for (;;) {
    if (!sock) {
      sock = await connect();
      if (!sock) { if (!warned) { log('No encuentro Discord abierto en este ordenador; lo sigo intentando…'); warned = true; } await sleep(15000); continue; }
      warned = false; last = '';
      log('Conectado con Discord');
      sock.once('close', () => { log('Discord se ha cerrado'); sock = null; });
    }
    try {
      const np = await nowPlaying(token);
      if (np.online && np.playing && np.track && np.track.id) {
        const key = np.track.id + ':' + Math.round((Date.now() / 1000 - (np.position || 0)) / 3);   // cambia si saltas a otro punto
        if (key !== last) { set(activityOf(np)); last = key; log('♪', np.track.title, '—', np.track.artist); }
      } else if (last !== 'off') { set(null); last = 'off'; log(np.online ? 'En pausa' : 'La app de Música está cerrada'); }
    } catch (e) {
      log(e.message);
      if (e.fatal) { try { fs.unlinkSync(CONF); } catch (_) {} log('Vuelve a descargarlo desde la web (Configuración → Discord).'); stop(); return; }
    }
    await sleep(EVERY);
  }
}
main();
