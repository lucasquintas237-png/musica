'use strict';
/* discord.js — Configuración → Discord: «Escuchando <canción>» en tu estado de Discord.
   Una web no puede hablar con la app de Discord del ordenador, así que se descarga un programa
   pequeño (discord/musica-discord.mjs, para Node.js) que lleva ya un token tuyo de solo lectura:
   pregunta a la web qué suena y se lo pasa a Discord. */
const Discord = (() => {
  // id público de la aplicación «Música» en el portal de desarrolladores de Discord
  const APP_ID = '';
  const SRC = '/discord/musica-discord.mjs';

  async function download(btn, done) {
    btn.disabled = true;
    try {
      const [tr, sr] = await Promise.all([
        fetch('/api/tokens', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Discord', scope: 'read' }) }),
        fetch(SRC, { cache: 'no-store' })
      ]);
      const tj = await tr.json().catch(() => ({}));
      if (!tr.ok || !/^ms_[a-f0-9]{40}$/.test(tj.token || '')) throw new Error(tj.error || 'No se pudo crear el token');
      if (!sr.ok) throw new Error('No se pudo descargar el programa');
      const code = (await sr.text())
        .replace("'__MUSICA_TOKEN__'", JSON.stringify(tj.token))
        .replace("'__DISCORD_APP_ID__'", JSON.stringify(APP_ID))
        .replace("'https://musica.lucasquintas237.workers.dev'", JSON.stringify(location.origin));
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      const a = document.createElement('a');
      a.href = url; a.download = 'musica-discord.mjs';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      done && done();
    } catch (e) { toast(e.message || 'No se pudo'); }
    btn.disabled = false;
  }

  function open() {
    App.sheet({
      title: 'Discord', sub: 'Tu estado pondrá «Escuchando» con la canción',
      body: box => {
        if (!APP_ID) {
          box.appendChild(el('<p class="dc-p">Aún no está configurada la aplicación de Discord de esta web. Vuelve a mirar dentro de poco.</p>'));
          return;
        }
        const cmd = 'node musica-discord.mjs';
        const w = el(`<div class="dc">
          <ol class="dc-steps">
            <li><b>Ten Discord abierto</b> en el ordenador (la app de escritorio, no la web).</li>
            <li><b>Instala Node.js</b> si no lo tienes: <a href="https://nodejs.org" target="_blank" rel="noopener noreferrer">nodejs.org</a> (la versión LTS).</li>
            <li><b>Descarga el programa.</b> Ya lleva un token tuyo de solo lectura.<div class="dc-row"><button class="btn" type="button" data-dl>${icon('download')}<span>Descargar para Discord</span></button></div></li>
            <li><b>Ábrelo</b> desde la carpeta de descargas con:<div class="dc-cmd"><code></code><button class="icb" type="button" data-copy aria-label="Copiar">${icon('link')}</button></div>
              <small class="muted">En Windows: abre la carpeta Descargas, escribe <code>cmd</code> en la barra de la dirección, pulsa Intro y pega el comando.</small></li>
          </ol>
          <p class="dc-p muted">Déjalo abierto mientras escuchas: cuando suena algo, en Discord sale «Escuchando» con el título, el artista, la portada y el tiempo; en pausa se quita. No compartas el archivo: lleva tu token. Puedes borrar el token cuando quieras en Configuración → API.</p>
        </div>`);
        w.querySelector('code').textContent = cmd;
        w.querySelector('[data-dl]').onclick = e => download(e.currentTarget, () => toast('Descargado. Ahora ábrelo con Node.js'));
        w.querySelector('[data-copy]').onclick = () => navigator.clipboard && navigator.clipboard.writeText(cmd).then(() => toast('Comando copiado'), () => {});
        box.appendChild(w);
      }
    });
  }
  return { open };
})();
window.Discord = Discord;
