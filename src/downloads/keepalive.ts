import type { EventEmitter } from "node:events";

export interface KeepAliveSocket extends EventEmitter { ping(): void; terminate(): void }

/**
 * Reverse proxies (nginx's proxy_read_timeout) close a WebSocket when the upstream stays
 * silent. The browser microphone socket only ever receives, so ping it periodically, and
 * drop peers that stop answering instead of holding their slot forever.
 */
export function startKeepAlive(socket: KeepAliveSocket, intervalMs = 25000): NodeJS.Timeout {
  let alive = true;
  socket.on("pong", () => { alive = true; });
  const timer = setInterval(() => {
    if (!alive) { socket.terminate(); return; }
    alive = false;
    try { socket.ping(); } catch { socket.terminate(); }
  }, intervalMs);
  timer.unref();
  socket.once("close", () => clearInterval(timer));
  return timer;
}
