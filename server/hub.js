/* server/hub.js — "RoomHub": un Durable Object por sala para escuchar juntos en tiempo real.
   Cada dispositivo de la sala mantiene un WebSocket abierto con él. El Worker le avisa de cada
   cambio (lo que suena, la cola, reacciones, chat…) y él lo reenvía al momento a todos, sin
   esperar a que pregunten. También responde a "ping" con la hora exacta del servidor, para que
   cada dispositivo calcule su desfase de reloj con precisión.
   Usa la API de hibernación de WebSockets: mientras nadie habla, el objeto no gasta nada.
   No guarda datos: lo que hay que guardar sigue en D1 (cifrado), esto solo reparte avisos.
   Mensajes que manda: {t:'state', state, v} · {t:'event', e} · {t:'refresh'} · {t:'closed'} · {t:'pong', c, s} */
export class RoomHub {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  async fetch(request) {
    const url = new URL(request.url);
    // un dispositivo se conecta (el Worker ya ha comprobado la sesión y que puede entrar)
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Se esperaba un WebSocket', { status: 426 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server, [String(request.headers.get('X-User') || '').toLowerCase()]);
      return new Response(null, { status: 101, webSocket: client });
    }
    // el Worker reparte un aviso a todos los conectados
    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const msg = await request.text();
      const only = url.searchParams.get('user');            // p. ej. para echar a alguien bloqueado
      for (const ws of this.ctx.getWebSockets(only ? only.toLowerCase() : undefined)) {
        try { ws.send(msg); } catch (_) {}
        if (url.searchParams.get('close')) { try { ws.close(4001, 'fuera'); } catch (_) {} }
      }
      return new Response('ok');
    }
    return new Response('no', { status: 404 });
  }

  // reloj: el dispositivo manda su hora (c) y se le devuelve la del servidor (s)
  async webSocketMessage(ws, data) {
    let m;
    try { m = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)); } catch (_) { return; }
    if (m && m.t === 'ping') { try { ws.send(JSON.stringify({ t: 'pong', c: m.c, s: Date.now() })); } catch (_) {} }
  }
  async webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code, 'adiós'); } catch (_) {} }
  async webSocketError(ws) { try { ws.close(1011, 'error'); } catch (_) {} }
}
