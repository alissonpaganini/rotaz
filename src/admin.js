// API do painel. Só atende loopback, exige sessão e bloqueia CSRF e DNS rebinding.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword, verifyPassword, randomToken, sha256, safeEqual } from './crypto.js';
import { LoginGuard, isLoopbackHost, aliasCompat } from './security.js';
import { readJson } from './gateway.js';
import { testProvider, discoverModels } from './tester.js';
import { buildRoute } from './routing.js';
import { setAutoStart, autoStartSupported, autoStartLabel } from './autostart.js';
import { PRESETS, CATEGORIES } from './presets.js';
import { LocalError, CODES, resolveLang, tr, localizeTest } from './i18n.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/logo.svg': ['logo.svg', 'image/svg+xml', true], '/favicon.svg': ['favicon.svg', 'image/svg+xml', true], '/splash.js': ['splash.js', 'text/javascript; charset=utf-8'], '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'], '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  ...Object.fromEntries(CODES.filter((c) => c !== 'pt-BR').map((c) => [`/i18n/${c}.json`, [`i18n/${c}.json`, 'application/json; charset=utf-8']])) };
const TYPES = { svg: 'image/svg+xml', js: 'text/javascript; charset=utf-8', woff2: 'font/woff2' };
/**
 * Arquivos estáticos permitidos: a lista fixa, logos de provedores, bibliotecas e fontes locais.
 * Nomes restritos por regex e pasta fixa: não há como subir de diretório nem servir outro tipo.
 */
function staticFile(pathname) {
  if (STATIC[pathname]) return STATIC[pathname];
  const m = /^\/(icons|vendor|fonts)\/([a-z0-9.-]{1,60})\.(svg|js|woff2)$/.exec(pathname);
  if (!m || m[2].includes('..')) return null;
  const allowed = { icons: ['svg'], vendor: ['js', 'svg'], fonts: ['woff2'] }[m[1]];
  if (!allowed.includes(m[3])) return null;
  const rel = `${m[1]}/${m[2]}.${m[3]}`;
  return fs.existsSync(path.join(PUBLIC, rel)) ? [rel, TYPES[m[3]], true] : null;
}
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'cross-origin-resource-policy': 'same-origin', 'cache-control': 'no-store',
};
const SESSION_MS = 12 * 3600 * 1000;
const COOKIE = 'gw_session';

class HttpError extends LocalError { constructor(status, key, ...args) { super(key, ...args); this.status = status; } }
/** Idioma de quem chamou o painel: o painel manda o dele; sem isso, o do sistema. */
const reqLang = (req, store) => (CODES.includes(req.headers['x-rotaz-lang']) ? req.headers['x-rotaz-lang'] : resolveLang(store.ui.lang));

export function createAdmin({ store, metrics, log, limiter, gateway, setupToken, onRebind, dataDir }) {
  const sessions = new Map();
  const guard = new LoginGuard();
  const tests = new Map();       // modelId -> último resultado de teste (em memória)
  const discovered = new Map();  // provedor+URL -> lista de modelos do provedor, por 1 h
  const state = { setupToken };

  const json = (res, status, obj, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...headers });
    res.end(JSON.stringify(obj));
  };

  const allowedHosts = () => {
    const p = store.server.port;
    return new Set([`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`]);
  };

  function sessionOf(req) {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie ?? '');
    if (!m) return null;
    const key = sha256(m[1]).toString('hex');
    const s = sessions.get(key);
    if (!s || s.expires < Date.now()) { sessions.delete(key); return null; }
    s.expires = Date.now() + SESSION_MS;
    return key;
  }

  function newSession() {
    const token = randomToken(32);
    sessions.set(sha256(token).toString('hex'), { expires: Date.now() + SESSION_MS });
    return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`;
  }

  function clientConfig() {
    const s = store.server;
    const host = ['0.0.0.0', '::'].includes(s.host) ? '127.0.0.1' : s.host.includes(':') ? `[${s.host}]` : s.host;
    const baseUrl = `http://${host}:${s.port}`;
    const token = store.gatewayToken();
    const models = gateway.listModels();
    return {
      baseUrl, token,
      cli: { env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_MODEL: store.routing.defaultAlias ?? 'auto', CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1' } },
      desktop: { inferenceProvider: 'gateway', inferenceGatewayBaseUrl: baseUrl, inferenceGatewayApiKey: token, inferenceGatewayAuthScheme: 'bearer' },
      models: models.map((m) => ({ id: m.id, ...aliasCompat(m.id) })),
    };
  }

  function dashboard() {
    const m = metrics.snapshot();
    const def = store.routing.defaultAlias;
    const targets = def ? buildRoute(store, def).targets : [];
    const active = targets[0] ?? null;
    const providers = store.publicProviders().map((p) => {
      const s = m.providers[p.id] ?? {};
      return { id: p.id, name: p.name, enabled: p.enabled, priority: p.priority, type: p.type, authScheme: p.authScheme, keyCount: p.keys.filter((k) => k.enabled).length, modelCount: p.models.length,
        requests: s.requests ?? 0, errors: s.errors ?? 0, inputTokens: s.inputTokens ?? 0, outputTokens: s.outputTokens ?? 0,
        avgLatencyMs: s.latencyCount ? Math.round(s.latencySum / s.latencyCount) : 0, lastOkAt: s.lastOkAt ?? null, lastErrorAt: s.lastErrorAt ?? null, lastError: s.lastError ?? null };
    });
    return {
      server: { status: store.server.gatewayEnabled === false ? 'paused' : 'online', gatewayEnabled: store.server.gatewayEnabled !== false, host: store.server.host, port: store.server.port, uptimeMs: m.uptimeMs, inflight: m.inflight, pid: process.pid, node: process.version, rssMB: Math.round(process.memoryUsage.rss() / 1048576) },
      active: active ? {
        alias: def, provider: active.provider.name, upstream: active.model.upstream, baseUrl: active.provider.baseUrl, presetId: active.provider.presetId ?? null,
        chain: targets.slice(1, 4).map((t) => ({ provider: t.provider.name, upstream: t.model.upstream })),
      } : null,
      stats: { requests: m.requests, errors: m.errors, inputTokens: m.inputTokens, outputTokens: m.outputTokens, avgLatencyMs: m.avgLatencyMs },
      providers, minutes: m.minutes, recent: m.recent, errors: m.errorLog,
    };
  }

  const routes = [
    ['GET', /^\/api\/dashboard$/, () => dashboard()],
    ['POST', /^\/api\/stats\/reset$/, () => { metrics.reset(); return { ok: true }; }],
    ['GET', /^\/api\/presets$/, () => ({ presets: PRESETS, categories: CATEGORIES })],
    ['GET', /^\/api\/providers$/, (b, params, lang) => ({
      providers: store.publicProviders().map((p) => ({ ...p, models: p.models.map((m) => ({ ...m, lastTest: localizeTest(lang, tests.get(m.id)) ?? null, learnedMaxImages: gateway.learnedImages.get(m.id) ?? null })) })),
      routing: store.routing, aliases: store.aliases(),
    })],
    ['POST', /^\/api\/providers$/, (b) => ({ id: store.addProvider(b).id })],
    ['PUT', /^\/api\/providers\/([\w-]+)$/, (b, [id]) => { store.updateProvider(id, b); return { ok: true }; }],
    ['DELETE', /^\/api\/providers\/([\w-]+)$/, (b, [id]) => { store.removeProvider(id); return { ok: true }; }],
    ['POST', /^\/api\/providers\/([\w-]+)\/keys$/, (b, [id]) => ({ id: store.addKey(id, b) })],
    ['PUT', /^\/api\/providers\/([\w-]+)\/keys\/([\w-]+)$/, (b, [id, k]) => { store.updateKey(id, k, b); return { ok: true }; }],
    ['DELETE', /^\/api\/providers\/([\w-]+)\/keys\/([\w-]+)$/, (b, [id, k]) => { store.removeKey(id, k); return { ok: true }; }],
    ['POST', /^\/api\/providers\/([\w-]+)\/models$/, (b, [id]) => {
      const m = store.upsertModel(id, b);
      // Salvar o limite de imagens explicitamente substitui o que o gateway aprendeu sozinho.
      if ('maxImages' in b && b.imagesTouched) gateway.learnedImages.delete(m.id);
      return m;
    }],
    ['DELETE', /^\/api\/providers\/([\w-]+)\/models\/([\w-]+)$/, (b, [id, m]) => { store.removeModel(id, m); return { ok: true }; }],
    ['POST', /^\/api\/providers\/([\w-]+)\/models\/bulk$/, (b, [id]) => ({ models: store.addModels(id, b.models) })],
    ['POST', /^\/api\/providers\/([\w-]+)\/models\/bulk-update$/, (b, [id]) => { store.updateModels(id, b.ids, b.set); return { ok: true }; }],
    ['POST', /^\/api\/providers\/([\w-]+)\/models\/bulk-delete$/, (b, [id]) => { store.removeModels(id, b.ids); for (const m of b.ids) tests.delete(m); return { ok: true }; }],
    ['POST', /^\/api\/providers\/([\w-]+)\/test$/, async (b, [id], lang) => {
      const r = await testProvider(store, id, { modelId: b.modelId, keyId: b.keyId, quick: !!b.quick, timeoutMs: Math.min(store.server.timeoutMs, 60000) });
      // O último resultado fica com o modelo, para a lista mostrar o estado sem testar de novo.
      if (r.modelId && !b.keyId) tests.set(r.modelId, { status: r.status, label: r.label, message: r.message, latencyMs: r.latencyMs ?? null, quick: r.quick, toolsOk: r.toolsOk, at: r.at });
      return localizeTest(lang, r);
    }],
    ['POST', /^\/api\/providers\/([\w-]+)\/discover$/, async (b, [id]) => {
      const p = store.provider(id);
      if (!p) throw new HttpError(404, 'Provedor não encontrado.');
      const key = `${id}|${p.baseUrl}`;
      const hit = discovered.get(key);
      if (hit && !b.refresh && Date.now() - hit.at < 3600000) return { ...hit, cached: true };
      const entry = { models: await discoverModels(store, id), at: Date.now() };
      discovered.set(key, entry);
      return { ...entry, cached: false };
    }],
    ['PUT', /^\/api\/routing$/, (b) => { store.updateRouting(b); return store.routing; }],
    ['GET', /^\/api\/settings$/, () => ({ server: store.server, autoStartSupported: autoStartSupported(), autoStartLabel: autoStartLabel(), desktop: !!state.desktop, masterKeySource: state.masterKeySource, logFile: log.file })],
    ['PUT', /^\/api\/settings$/, (b) => {
      const before = `${store.server.host}:${store.server.port}`;
      store.updateServer(b);
      if (b.autoStart !== undefined && autoStartSupported()) setAutoStart(!!b.autoStart, dataDir);
      const rebind = before !== `${store.server.host}:${store.server.port}`;
      if (rebind) setTimeout(onRebind, 150);
      return { ok: true, rebind, port: store.server.port };
    }],
    ['PUT', /^\/api\/ui$/, (b) => store.updateUi(b)],
    ['GET', /^\/api\/client-config$/, () => clientConfig()],
    ['POST', /^\/api\/gateway-token\/rotate$/, () => { store.rotateGatewayToken(); return clientConfig(); }],
    ['GET', /^\/api\/logs$/, () => {
      try {
        const size = fs.statSync(log.file).size;
        const fd = fs.openSync(log.file, 'r');
        const n = Math.min(size, 64 * 1024);
        const buf = Buffer.alloc(n);
        fs.readSync(fd, buf, 0, n, size - n);
        fs.closeSync(fd);
        return { lines: buf.toString('utf8').split('\n').slice(-300) };
      } catch { return { lines: [] }; }
    }],
    ['POST', /^\/api\/password$/, (b) => {
      if (!verifyPassword(b.current ?? '', store.c.admin.passHash)) throw new HttpError(403, 'Senha atual incorreta.');
      checkPassword(b.password);
      store.update((c) => { c.admin.passHash = hashPassword(b.password); });
      sessions.clear();
      return { ok: true };
    }],
  ];

  function checkPassword(pw) {
    if (typeof pw !== 'string' || pw.length < 10 || pw.length > 200) throw new HttpError(400, 'A senha deve ter entre 10 e 200 caracteres.');
  }

  async function authRoute(req, res, url, ip) {
    const max = 64 * 1024;
    if (url.pathname === '/api/auth/status') {
      // Tema e paleta não são sensíveis: vêm junto para a tela de login já sair com a aparência escolhida.
      const authenticated = !!sessionOf(req);
      return json(res, 200, { configured: !!store.c.admin.passHash, authenticated, ui: store.ui, ...(authenticated && { address: `${store.server.host}:${store.server.port}`, gatewayEnabled: store.server.gatewayEnabled !== false }) });
    }
    if (req.method !== 'POST') throw new HttpError(405, 'Método não permitido.');
    if (url.pathname === '/api/auth/setup') {
      if (store.c.admin.passHash) throw new HttpError(409, 'O painel já foi configurado.');
      const b = await readJson(req, max);
      if (!state.setupToken || !safeEqual(b.token ?? '', state.setupToken)) throw new HttpError(403, 'Código de configuração inválido.');
      checkPassword(b.password);
      store.update((c) => { c.admin.passHash = hashPassword(b.password); });
      state.setupToken = null;
      fs.rmSync(path.join(dataDir, 'setup-token.txt'), { force: true });
      log.info('painel configurado');
      return json(res, 200, { ok: true }, { 'set-cookie': newSession() });
    }
    if (url.pathname === '/api/auth/login') {
      const wait = guard.waitMs(ip);
      if (wait) throw new HttpError(429, 'Muitas tentativas. Aguarde {0}s.', Math.ceil(wait / 1000));
      const b = await readJson(req, max);
      if (!store.c.admin.passHash || !verifyPassword(b.password ?? '', store.c.admin.passHash)) {
        guard.fail(ip);
        log.warn('tentativa de login inválida');
        throw new HttpError(401, 'Senha incorreta.');
      }
      guard.ok(ip);
      return json(res, 200, { ok: true }, { 'set-cookie': newSession() });
    }
    if (url.pathname === '/api/auth/logout') {
      const k = sessionOf(req);
      if (k) sessions.delete(k);
      return json(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }
    throw new HttpError(404, 'Rota não encontrada.');
  }

  /** Retorna true quando a requisição pertence ao painel. */
  async function handle(req, res, url) {
    const isApi = url.pathname.startsWith('/api/');
    const asset = isApi ? null : staticFile(url.pathname);
    if (!isApi && !asset) return false;

    const ip = req.socket.remoteAddress ?? '';
    try {
      // Painel restrito à própria máquina, mesmo que o gateway escute em outra interface.
      if (!isLoopbackHost(ip.replace(/^::ffff:/, ''))) throw new HttpError(403, 'Painel disponível apenas nesta máquina.');
      // Host fora da lista indica DNS rebinding.
      if (!allowedHosts().has(req.headers.host)) throw new HttpError(403, 'Host não permitido.');

      if (!isApi) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método não permitido.');
        const [file, type, cacheable] = asset;
        const data = fs.readFileSync(path.join(PUBLIC, file));
        // Ícones, fontes e bibliotecas: o navegador guarda, mas confere a cada carga (ETag). Assim um sprite
        // novo, com ícones acrescentados, aparece na hora em vez de ficar um dia preso no cache.
        if (cacheable) {
          const etag = `"${sha256(data).toString('base64url').slice(0, 22)}"`;
          const headers = { 'content-type': type, ...SECURITY_HEADERS, 'cache-control': 'private, no-cache', etag };
          if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return true; }
          res.writeHead(200, headers);
          res.end(req.method === 'HEAD' ? undefined : data);
          return true;
        }
        res.writeHead(200, { 'content-type': type, ...SECURITY_HEADERS });
        res.end(req.method === 'HEAD' ? undefined : data);
        return true;
      }

      if (!limiter.allow(`admin:${ip}`, 600)) throw new HttpError(429, 'Muitas requisições.');

      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        if (origin && !allowedHosts().has(origin.replace(/^https?:\/\//, ''))) throw new HttpError(403, 'Origem não permitida.');
        const site = req.headers['sec-fetch-site'];
        if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'Origem não permitida.');
        // Header próprio força preflight CORS, que nunca é aceito: páginas de terceiros não conseguem enviar.
        if (req.headers['x-gateway-csrf'] !== '1') throw new HttpError(403, 'Proteção CSRF: header ausente.');
      }

      if (url.pathname.startsWith('/api/auth/')) { await authRoute(req, res, url, ip); return true; }
      if (!sessionOf(req)) throw new HttpError(401, 'Sessão expirada.');

      for (const [method, re, fn] of routes) {
        const m = re.exec(url.pathname);
        if (!m || method !== req.method) continue;
        const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(req, 1024 * 1024);
        json(res, 200, await fn(body, m.slice(1), reqLang(req, store)));
        return true;
      }
      throw new HttpError(404, 'Rota não encontrada.');
    } catch (e) {
      const status = e.status ?? 400;
      if (status >= 500) log.error(`painel: ${e.stack}`);
      else if (req.method !== 'GET' && status !== 401) log.warn(`painel ${req.method} ${url.pathname} recusado (${status}): ${e.message}`);
      json(res, status, { error: tr(reqLang(req, store), e) });
      return true;
    }
  }

  return { handle, state };
}
