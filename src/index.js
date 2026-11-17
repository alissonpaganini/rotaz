#!/usr/bin/env node
// Rotaz: gateway local + painel em um único processo, sem dependências externas.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Vault, loadMasterKey } from './crypto.js';
import { Store } from './store.js';
import { Metrics } from './metrics.js';
import { Budget } from './budget.js';
import { createLogger } from './logger.js';
import { RateLimiter } from './security.js';
import { createGateway } from './gateway.js';
import { createAdmin } from './admin.js';
import { migrateAutoStart } from './autostart.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param desktop       true quando roda dentro do app Electron
 * @param keySourceName como o painel descreve a origem da chave mestra (ex.: 'keychain' no app desktop)
 */
export function createServer({ dataDir, host, port, quiet = false, desktop = false, keySourceName }) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const { key, source } = loadMasterKey(dataDir);
  const store = new Store(dataDir, new Vault(key));
  store.override({ host: host || undefined, port });

  const log = createLogger(dataDir, () => store.server.logLevel, { console: !quiet });
  const metrics = new Metrics(path.join(dataDir, 'stats.json'));
  const limiter = new RateLimiter();
  const budget = new Budget(store, metrics);
  const gateway = createGateway({ store, metrics, log, limiter, budget });

  let server;
  const admin = createAdmin({ store, metrics, log, limiter, gateway, budget, dataDir, masterKeySource: keySourceName ?? source, desktop,
    onRebind: (prev) => rebind(prev).catch((e) => log.error(`não foi possível voltar a escutar: ${e.stack ?? e.message}`)) });

  const onRequest = async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://gateway.local'); }
    catch { res.writeHead(400); return res.end(); }
    try {
      if (url.pathname === '/health' || url.pathname === '/api/hello') { // /api/hello: sonda do Claude Code
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"status":"ok"}');
      }
      if (await admin.handle(req, res, url)) return;
      if (await gateway.handle(req, res, url)) return;
      if (req.method === 'HEAD') { res.writeHead(200); return res.end(); }
      log.debug(`rota desconhecida: ${req.method} ${url.pathname}`);
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"not_found_error","message":"Rota não encontrada."}}');
    } catch (e) {
      log.error(`erro não tratado: ${e.stack ?? e}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"api_error","message":"Erro interno do gateway."}}');
    }
  };

  const make = () => {
    const s = http.createServer({ maxHeaderSize: 32 * 1024, requestTimeout: 120000, headersTimeout: 20000, keepAliveTimeout: 65000 }, onRequest);
    s.on('clientError', (err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
    return s;
  };

  const listen = () => new Promise((resolve, reject) => {
    server = make();
    server.once('error', reject);
    server.listen(store.server.port, store.server.host, () => {
      server.off('error', reject);
      store.server.port = server.address().port;
      resolve();
    });
  });

  /** Troca de endereço pelo painel. Se o novo não abrir, volta ao anterior (`prev`), que acabou de ser liberado. */
  async function rebind(prev) {
    const old = server;
    old.closeIdleConnections();
    await new Promise((r) => { old.close(r); setTimeout(() => { old.closeAllConnections(); r(); }, 1000); });
    try { await listen(); }
    catch (e) {
      if (!prev) throw e;
      log.error(`não foi possível escutar em ${store.server.host}:${store.server.port} (${e.code ?? e.message}); voltando para ${prev.host}:${prev.port}`);
      // Sem validar de novo: o endereço anterior já estava em uso (e pode ter vindo da linha de comando, fora dos limites do painel).
      store.update((c) => { c.server.host = prev.host; c.server.port = prev.port; });
      await listen();
    }
    log.info(`escutando em ${store.server.host}:${store.server.port}`);
  }

  const close = async () => {
    metrics.flush();
    clearInterval(metrics.t);
    clearInterval(limiter.t);
    server?.closeAllConnections();
    await new Promise((r) => (server?.listening ? server.close(r) : r()));
    await log.close();
  };

  return { store, metrics, budget, log, gateway, listen, close, keySource: source, setupFile: admin.setupFile, get setupToken() { return admin.setupToken(); } };
}

function openBrowser(url) {
  try {
    const cmd = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch { /* sem navegador disponível: a URL já está no console */ }
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const dataDir = path.resolve(arg('--data') ?? process.env.GATEWAY_DATA_DIR ?? path.join(ROOT, 'data'));
  const app = createServer({ dataDir, host: arg('--host'), port: arg('--port') ? Number(arg('--port')) : undefined });
  try { await app.listen(); }
  catch (e) {
    console.error(e.code === 'EADDRINUSE' ? `A porta ${app.store.server.port} já está em uso. Use --port ou encerre o outro processo.` : e.message);
    process.exit(1);
  }
  const { host, port } = app.store.server;
  const shown = ['0.0.0.0', '::'].includes(host) ? '127.0.0.1' : host;
  const panel = `http://${shown}:${port}/`;
  app.log.info(`Rotaz em ${panel} (chave mestra: ${app.keySource})`);
  migrateAutoStart(app.store.server.autoStart, dataDir);
  if (app.setupToken) console.log(`\nPrimeiro acesso: abra ${panel}#setup=${app.setupToken}\nO código também está em ${app.setupFile}\n`);
  if (process.argv.includes('--open')) openBrowser(app.setupToken ? `${panel}#setup=${app.setupToken}` : panel);

  const stop = async () => { await app.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
