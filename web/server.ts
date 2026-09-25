// Explicit host for terminal WebSockets. Never import runtime.ts or construct ControlPlane here.
import { createServer } from 'node:http';
import next from 'next';
import { WebSocketServer } from 'ws';
import { terminalHost } from './src/server/terminal-gateway.ts';
const args = process.argv.slice(2);
const dev = args.includes('--dev');
const portFlag = args.indexOf('--port');
const port = Number(portFlag < 0 ? 8787 : args[portFlag + 1]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid loopback port.');
const bridge = terminalHost(); bridge.active = true;
const app = next({ dev, hostname: '127.0.0.1', port });
const handle = app.getRequestHandler();
await app.prepare();
const upgrade = app.getUpgradeHandler();
const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
const server = createServer((request, response) => {
  if (bridge.closing) { response.writeHead(503); response.end(); return; }
  void handle(request, response).catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
});
server.on('upgrade', (request, socket, head) => {
  if (request.url === '/api/v1/terminals/socket') {
    if (bridge.closing || sockets.clients.size >= 16 || !bridge.gateway?.authorize(request.headers.origin, request.headers.host)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    sockets.handleUpgrade(request, socket, head, ws => bridge.gateway!.connect(ws));
  } else if (dev && request.url?.startsWith('/_next/')) void upgrade(request, socket, head);
  else socket.destroy();
});
await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
console.log(`AltCLI ${dev ? 'development' : 'production'} host listening on loopback port ${port}.`);
async function shutdown() {
  if (bridge.closing) return;
  bridge.closing = true;
  const force = setTimeout(() => process.exit(1), 30_000); force.unref();
  await bridge.gateway?.shutdown();
  for (const socket of sockets.clients) socket.terminate();
  sockets.close();
  await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
  await app.close(); clearTimeout(force);
}
process.once('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });
process.once('SIGINT', () => { void shutdown().then(() => process.exit(0)); });
