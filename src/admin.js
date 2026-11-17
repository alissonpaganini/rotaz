// API do painel. Só atende loopback, exige sessão e bloqueia CSRF e DNS rebinding.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomToken, sha256, safeEqual } from './crypto.js';
import { LoginGuard, isLoopbackHost, aliasCompat } from './security.js';
import { readJson } from './gateway.js';
import { testProvider, discoverCatalog } from './tester.js';
import { buildRoute, routeProblem } from './routing.js';
import { setAutoStart, autoStartSupported, autoStartLabel } from './autostart.js';
import { PRESETS, CATEGORIES } from './presets.js';
import { LocalError, CODES, resolveLang, tr, localizeTest } from './i18n.js';
import { dayKey as dayKeyOf } from './budget.js';
import { exportProfile, inspectBackup, importProfile } from './backup.js';
import { UpdateChecker } from './updates.js';
import * as claudeDesktop from './claude-desktop.js';
import { beginLogin, loginStatus, handleCallback } from './providers/oauth/engine.js';
import { newPkce, buildAuthUrl, rememberLogin, takeLogin, exchangeCode, discoverProject, fetchUserInfo, credentialFor, fetchModelCatalog } from './providers/antigravity.js';

/** Versão do Rotaz: o app de desktop informa a dele; no terminal, vem do package.json. */
const PKG_VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version; } catch { return null; } })();
const appVersion = () => process.env.ROTAZ_VERSION || PKG_VERSION;

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/logo.svg': ['logo.svg', 'image/svg+xml', true], '/favicon.svg': ['favicon.svg', 'image/svg+xml', true], '/splash.js': ['splash.js', 'text/javascript; charset=utf-8'], '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'], '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'], '/alias.js': ['alias.js', 'text/javascript; charset=utf-8'], '/langs.js': ['langs.js', 'text/javascript; charset=utf-8'], '/oauth.js': ['oauth.js', 'text/javascript; charset=utf-8'], '/oauth.css': ['oauth.css', 'text/css; charset=utf-8'],
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
const COOKIE_RE = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`);

/** Arquivo do painel em memória com o ETag; relido só quando o arquivo muda no disco. */
const assets = new Map();
function readAsset(file) {
  const full = path.join(PUBLIC, file);
  const { mtimeMs, size } = fs.statSync(full);
  const hit = assets.get(file);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit;
  const data = fs.readFileSync(full);
  const entry = { mtimeMs, size, data, etag: `"${sha256(data).toString('base64url').slice(0, 22)}"` };
  assets.set(file, entry);
  return entry;
}
/** Redirect do Google volta para cá; roda antes do check de sessão (chega sem cookie). */
const OAUTH_CB = '/api/oauth/antigravity/callback';

/** A porta aceita conexões neste endereço? Abre e fecha um servidor de teste. */
function portFree(host, port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ host, port, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

class HttpError extends LocalError { constructor(status, key, ...args) { super(key, ...args); this.status = status; } }
/** Idioma de quem chamou o painel: o painel manda o dele; sem isso, o do sistema. */
const reqLang = (req, store) => (CODES.includes(req.headers['x-rotaz-lang']) ? req.headers['x-rotaz-lang'] : resolveLang(store.ui.lang));

export function createAdmin({ store, metrics, log, limiter, gateway, budget, onRebind, dataDir, masterKeySource, desktop = false }) {
  const sessions = new Map();
  const guard = new LoginGuard();
  const tests = new Map();       // modelId -> último resultado de teste (em memória)
  const discovered = new Map();  // provedor+URL -> lista de modelos do provedor, por 1 h
  const quotas = new Map();      // provedor Antigravity -> cota por modelo, por 1 min
  const updates = new UpdateChecker({ store, log, currentVersion: appVersion() });
  // Primeiro acesso: o código de configuração fica em memória e num arquivo só do usuário, até a senha ser criada.
  const setupFile = path.join(dataDir, 'setup-token.txt');
  const state = { setupToken: null };
  if (!store.hasPassword) {
    state.setupToken = randomToken(18);
    fs.writeFileSync(setupFile, state.setupToken, { mode: 0o600 });
  }

  const json = (res, status, obj, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...headers });
    res.end(JSON.stringify(obj));
  };

  const allowedHosts = () => {
    const p = store.server.port;
    return new Set([`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`]);
  };

  /**
   * Versão cujas novidades o painel deve mostrar agora, ou null. Só depois de uma atualização: quem instala do zero
   * já passa pelas boas-vindas, então a versão dele é marcada como vista sem mostrar nada.
   */
  function newsFor() {
    const v = appVersion();
    const seen = store.ui.seenVersion ?? null;
    if (!v || seen === v || !/^\d+\.\d+\.\d+$/.test(v)) return null;
    // Sem registro de versão vista: quem já tinha provedor veio de uma versão anterior a este controle.
    if (!seen && !store.providers.length) { store.updateUi({ seenVersion: v }); return null; }
    return v;
  }

  function sessionOf(req) {
    const m = COOKIE_RE.exec(req.headers.cookie ?? '');
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
    // O modelo padrão vai com [1m] quando aguenta 1 milhão de tokens: é o que faz o Claude Code usar o contexto todo.
    const def = store.routing.defaultAlias;
    const defaultModel = def ? (models.find((m) => m.id === `${def}[1m]`)?.id ?? def) : 'auto';
    return {
      baseUrl, token,
      cli: { env: { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_MODEL: defaultModel, CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1' } },
      desktop: { inferenceProvider: 'gateway', inferenceGatewayBaseUrl: baseUrl, inferenceGatewayApiKey: token, inferenceGatewayAuthScheme: 'bearer' },
      models: models.map((m) => ({ id: m.id, ...aliasCompat(m.id) })),
    };
  }

  /** Endereço, token e pasta de dados para a configuração do Claude Desktop. */
  const desktopCfg = (c = clientConfig()) => ({ baseUrl: c.baseUrl, token: c.token, dataDir: store.dataDir });
  const desktopState = (st) => ({ ...st, features: Object.keys(claudeDesktop.FEATURES) });
  claudeDesktop.probeReady(); // já começa a consultar o processo do Claude: quando o painel abrir, a resposta está pronta

  /** Gasto para o painel, já na moeda de exibição: hoje, mês, últimos 30 dias, por provedor e o orçamento. */
  function spendSummary(m) {
    const s = budget.state();
    const r = s.rate || 1;
    const keys = Object.keys(m.days).sort();
    const byProvider = {};
    for (const k of keys.filter((k) => k.slice(0, 7) === s.monthKey)) for (const [id, v] of Object.entries(m.days[k].providers)) byProvider[id] = (byProvider[id] ?? 0) + v * r;
    const last30 = [];
    for (let i = 29; i >= 0; i--) { const d = new Date(Date.now() - i * 86400000); const k = dayKeyOf(d); last30.push({ day: k, cost: (m.days[k]?.cost ?? 0) * r }); }
    const unpricedMonth = keys.filter((k) => k.slice(0, 7) === s.monthKey).reduce((n, k) => n + (m.days[k].unpriced ?? 0), 0);
    return { currency: s.currency, rate: r, today: s.day.spent, month: s.month.spent, total: m.cost * r, days: last30, byProvider, unpricedMonth,
      budget: { daily: s.daily, monthly: s.monthly, warnAt: s.warnAt, action: s.action, fallbackAlias: s.fallbackAlias, dayPct: s.day.pct, monthPct: s.month.pct, over: s.over, warn: s.warn } };
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
        avgLatencyMs: s.latencyCount ? Math.round(s.latencySum / s.latencyCount) : 0, lastOkAt: s.lastOkAt ?? null, lastErrorAt: s.lastErrorAt ?? null, lastError: s.lastError ?? null,
        cost: s.cost ?? 0, unpriced: s.unpriced ?? 0, pricedModels: p.models.filter((x) => x.priceIn !== null || x.priceOut !== null).length };
    });
    return {
      server: { status: store.server.gatewayEnabled === false ? 'paused' : 'online', gatewayEnabled: store.server.gatewayEnabled !== false, host: store.server.host, port: store.server.port, uptimeMs: m.uptimeMs, inflight: m.inflight, pid: process.pid, node: process.version, rssMB: Math.round(process.memoryUsage.rss() / 1048576) },
      active: active ? {
        alias: def, provider: active.provider.name, upstream: active.model.upstream, baseUrl: active.provider.baseUrl, presetId: active.provider.presetId ?? null,
        chain: targets.slice(1, 4).map((t) => ({ provider: t.provider.name, upstream: t.model.upstream })),
      } : null,
      routeIssue: active ? null : routeProblem(store, def),
      stats: { requests: m.requests, errors: m.errors, inputTokens: m.inputTokens, outputTokens: m.outputTokens, avgLatencyMs: m.avgLatencyMs },
      providers, minutes: m.minutes, recent: m.recent, errors: m.errorLog,
      spend: spendSummary(m),
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
    ['POST', /^\/api\/providers\/([\w-]+)\/test$/, async (b, [id], lang, signal) => {
      const r = await testProvider(store, id, { modelId: b.modelId, upstream: typeof b.upstream === 'string' ? b.upstream.slice(0, 300) : undefined, keyId: b.keyId, quick: !!b.quick, timeoutMs: Math.min(store.server.timeoutMs, 30000), signal });
      // O último resultado fica com o modelo, para a lista mostrar o estado sem testar de novo.
      if (r.modelId && !b.keyId && r.status !== 'aborted') tests.set(r.modelId, { status: r.status, label: r.label, message: r.message, latencyMs: r.latencyMs ?? null, quick: r.quick, toolsOk: r.toolsOk, at: r.at });
      return localizeTest(lang, r);
    }],
    ['POST', /^\/api\/providers\/([\w-]+)\/discover$/, async (b, [id]) => {
      const p = store.provider(id);
      if (!p) throw new HttpError(404, 'Provedor não encontrado.');
      const key = `${id}|${p.baseUrl}`;
      const hit = discovered.get(key);
      if (hit && !b.refresh && Date.now() - hit.at < 3600000) return { ...hit, cached: true };
      const entry = { ...(await discoverCatalog(store, id)), at: Date.now() };
      discovered.set(key, entry);
      return { ...entry, cached: false };
    }],
    // Cota de cada modelo da conta Google (Antigravity), como o próprio Google informa. Guardada por 1 minuto.
    ['GET', /^\/api\/providers\/([\w-]+)\/quota$/, async (b, [id]) => {
      const p = store.provider(id);
      if (!p) throw new HttpError(404, 'Provedor não encontrado.');
      if (p.type !== 'antigravity') throw new HttpError(400, 'Só provedores Antigravity informam cota.');
      const k = p.keys.find((x) => x.enabled);
      if (!k) throw new HttpError(409, 'Conecte uma conta Google neste provedor.');
      const hit = quotas.get(id);
      if (hit && hit.keyId === k.id && Date.now() - hit.at < 60000) return hit;
      const catalog = await fetchModelCatalog(await credentialFor(store, p, k));
      // Contexto informado pelo Google entra no modelo cadastrado que ainda não tem: modelos importados antes
      // desta versão passam a ir para o Claude Code com [1m] sem precisar importar de novo.
      const fill = p.models.filter((m) => m.contextWindow == null && catalog[m.upstream]?.context);
      if (fill.length) store.transact(() => { for (const m of fill) store.updateModels(p.id, [m.id], { contextWindow: catalog[m.upstream].context }); });
      const entry = {
        at: Date.now(), keyId: k.id, account: k.label,
        models: Object.fromEntries(p.models.map((m) => {
          const c = catalog[m.upstream];
          return [m.id, c ? { remaining: c.remaining, resetAt: c.resetAt, context: c.context } : null];
        })),
      };
      quotas.set(id, entry);
      return entry;
    }],
    ['PUT', /^\/api\/routing$/, (b) => { store.updateRouting(b); return store.routing; }],
    // Backup do perfil (src/backup.js). A senha, quando existe, só cifra as chaves dentro do arquivo.
    ['POST', /^\/api\/backup\/export$/, (b) => exportProfile(store, { password: b.password, appVersion: appVersion() })],
    ['POST', /^\/api\/backup\/inspect$/, (b) => inspectBackup(b.file)],
    ['POST', /^\/api\/backup\/import$/, (b) => { const r = importProfile(store, b.file, { password: b.password, mode: b.mode }); tests.clear(); discovered.clear(); log.info(`perfil importado (${r.mode}): ${r.providers} provedor(es)`); return r; }],
    // Versão nova no GitHub (terminal e macOS; no Windows o app se atualiza sozinho). Respeita a opção em Configurações.
    ['GET', /^\/api\/update$/, () => updates.status()],
    ['POST', /^\/api\/update\/check$/, () => updates.status({ force: true })],
    ['GET', /^\/api\/budget$/, () => ({ ...store.budget, aliases: store.aliases() })],
    ['PUT', /^\/api\/budget$/, (b) => store.updateBudget(b)],
    ['GET', /^\/api\/settings$/, () => ({ server: store.server, autoStartSupported: autoStartSupported(), autoStartLabel: autoStartLabel(), desktop: !!desktop, masterKeySource, logFile: log.file })],
    ['PUT', /^\/api\/settings$/, async (b) => {
      const prev = { host: store.server.host, port: store.server.port };
      const before = `${prev.host}:${prev.port}`;
      // Porta nova ocupada: recusa antes de gravar. Sem isso o servidor fechava a porta atual e não abria a nova.
      const port = b.port === undefined ? store.server.port : Number(b.port);
      if (port !== store.server.port && Number.isInteger(port) && port >= 1024 && port <= 65535 && !(await portFree(b.host ?? store.server.host, port))) {
        throw new HttpError(409, 'A porta {0} já está em uso por outro programa. Escolha outra.', port);
      }
      store.updateServer(b);
      if (b.autoStart !== undefined && autoStartSupported()) setAutoStart(!!b.autoStart, dataDir);
      const rebind = before !== `${store.server.host}:${store.server.port}`;
      if (rebind) { claudeDesktop.refresh(desktopCfg()); setTimeout(() => onRebind(prev), 150); }
      return { ok: true, rebind, port: store.server.port };
    }],
    ['PUT', /^\/api\/ui$/, (b) => store.updateUi(b)],
    ['GET', /^\/api\/client-config$/, () => clientConfig()],
    ['POST', /^\/api\/gateway-token\/rotate$/, () => { store.rotateGatewayToken(); const c = clientConfig(); claudeDesktop.refresh(desktopCfg(c)); return c; }],
    // Claude Desktop em um clique (src/claude-desktop.js): estado, aplicar e desfazer.
    ['GET', /^\/api\/claude-desktop$/, async () => { await claudeDesktop.probeReady(); return desktopState(claudeDesktop.status(desktopCfg())); }],
    ['POST', /^\/api\/claude-desktop\/apply$/, () => { const r = claudeDesktop.apply(desktopCfg()); log.info('Claude Desktop configurado para usar o Rotaz'); return desktopState(r); }],
    ['POST', /^\/api\/claude-desktop\/reopened$/, () => desktopState(claudeDesktop.acknowledgeReopen(desktopCfg()))],
    ['POST', /^\/api\/claude-desktop\/undo$/, () => { const r = claudeDesktop.undo(desktopCfg()); log.info('configuração anterior do Claude Desktop restaurada'); return desktopState(r); }],
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
      if (!store.checkPassword(b.current)) throw new HttpError(403, 'Senha atual incorreta.');
      checkPassword(b.password);
      store.setPassword(b.password);
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
      return json(res, 200, { configured: store.hasPassword, authenticated, ui: store.ui, version: appVersion(), ...(authenticated && { address: `${store.server.host}:${store.server.port}`, gatewayEnabled: store.server.gatewayEnabled !== false, news: newsFor() }) });
    }
    if (req.method !== 'POST') throw new HttpError(405, 'Método não permitido.');
    if (url.pathname === '/api/auth/setup') {
      if (store.hasPassword) throw new HttpError(409, 'O painel já foi configurado.');
      const b = await readJson(req, max);
      if (!state.setupToken || !safeEqual(b.token ?? '', state.setupToken)) throw new HttpError(403, 'Código de configuração inválido.');
      checkPassword(b.password);
      store.setPassword(b.password);
      state.setupToken = null;
      fs.rmSync(setupFile, { force: true });
      log.info('painel configurado');
      return json(res, 200, { ok: true }, { 'set-cookie': newSession() });
    }
    if (url.pathname === '/api/auth/login') {
      const wait = guard.waitMs(ip);
      if (wait) throw new HttpError(429, 'Muitas tentativas. Aguarde {0}s.', Math.ceil(wait / 1000));
      const b = await readJson(req, max);
      if (!store.checkPassword(b.password)) {
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

  // ---------- OAuth Antigravity (login com a conta Google paga) ----------

  /** Andamento de cada login (state -> { status, message, email, providerId, created }), por 15 minutos. */
  const oauthLogins = new Map();
  const sweepLogins = () => { const now = Date.now(); for (const [k, v] of oauthLogins) if (now - v.created > 900000) oauthLogins.delete(k); };
  const settleLogin = (state, patch) => { const l = oauthLogins.get(state); if (l) Object.assign(l, patch); };

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /**
   * Página de retorno do redirect do Google. O navegador chega aqui sem cookie de sessão
   * (navegação cross-site não manda cookie SameSite=Strict); o `state` de uso único guardado
   * no servidor é que protege contra CSRF. O resultado vai num bloco JSON e o /oauth.js avisa
   * a janela que abriu o popup e fecha esta aba.
   */
  function oauthPage(res, status, lang, data) {
    const payload = JSON.stringify(data).replace(/</g, '\\u003c');
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
    // Sem <style> embutido: a CSP só aceita CSS do próprio servidor (style.css com os tokens + oauth.css).
    res.end(`<!doctype html><html lang="${escapeHtml(lang)}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Rotaz</title>
<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/oauth.css">
<main class="oauth-result ${data.ok ? 'ok' : 'bad'}"><h1>${escapeHtml(tr(lang, data.title))}</h1><p>${escapeHtml(tr(lang, data.message))}</p><p class="oauth-hint">${escapeHtml(tr(lang, 'Pode fechar esta aba e voltar ao Rotaz.'))}</p></main>
<script type="application/json" id="oauth-result">${payload}</script>
<script src="/oauth.js"></script>`);
  }

  /** Callback do Google: troca o code (PKCE) por tokens e guarda a conta no provedor. Sem sessão. */
  async function oauthCallback(req, res, url) {
    const lang = resolveLang(store.ui.lang);
    const q = url.searchParams;
    const state = q.get('state') ?? '';
    // O painel acompanha pelo state: o erro aparece lá também, não só nesta aba.
    const fail = (status, message) => {
      const msg = String(message).slice(0, 500);
      settleLogin(state, { status: 'error', message: msg });
      oauthPage(res, status, lang, { ok: false, title: 'Não foi possível conectar', message: msg });
    };
    if (q.get('error')) {
      takeLogin(state);
      return fail(400, q.get('error') === 'access_denied' ? 'O login foi cancelado na tela do Google.' : `O Google recusou o login: ${q.get('error_description') || q.get('error')}`);
    }
    const code = q.get('code');
    const login = takeLogin(state);
    // Sem state válido não existe verificador PKCE: a troca do code nem chegaria a acontecer.
    if (!code || !login) return fail(400, 'Login inválido ou expirado. Volte ao painel e conecte a conta de novo.');
    const p = store.provider(login.providerId);
    if (!p || p.type !== 'antigravity') return fail(404, 'O provedor Antigravity não existe mais.');
    try {
      // O redirect_uri tem que ser idêntico ao enviado na autorização: mesmo host que o navegador usou.
      const redirectUri = `http://${req.headers.host}${OAUTH_CB}`;
      const tokens = await exchangeCode({ code, redirectUri, verifier: login.verifier });
      if (!tokens.refresh_token) throw new Error('O Google não devolveu o refresh token. Refaz o login aceitando o consentimento.');
      const d = await discoverProject(tokens.access_token);
      const email = (await fetchUserInfo(tokens.access_token)).email ?? null;
      const keyId = store.addCredential(p.id, { label: email ?? 'Conta Google', refreshToken: tokens.refresh_token, projectId: d.projectId, email });
      // Guarda o access token já emitido: a próxima requisição não precisa renovar na hora.
      store.saveCredential(p.id, keyId, { refreshToken: tokens.refresh_token, projectId: d.projectId, email, accessToken: tokens.access_token, expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000 });
      log.info(`conta Google conectada em ${p.name}: ${email ?? '(sem e-mail)'} · project ${d.projectId || 'pendente'}`);
      const message = d.projectId
        ? new LocalError('{0} agora alimenta o provedor {1}.', email ?? 'A conta Google', p.name)
        : new LocalError('{0} conectada. O projeto do Cloud Code ainda está sendo criado e aparece em alguns minutos.', email ?? 'A conta Google');
      settleLogin(state, { status: 'ok', email, message: message.message });
      oauthPage(res, 200, lang, { ok: true, providerId: p.id, email, title: 'Conta conectada', message });
    } catch (e) {
      log.warn(`oauth antigravity falhou: ${e.message}`);
      fail(500, e.message);
    }
  }

  /**
   * Rotas de OAuth com sessão.
   * - begin (POST): cria state + PKCE e devolve o link do Google. O painel abre esse link fora dele: no app
   *   instalado, no navegador do sistema (o Google recusa login em janela embutida); no navegador, num popup.
   *   Antes era um GET que redirecionava, mas o navegador do sistema não tem o cookie do painel e recebia 401.
   * - status (GET): com `state`, o andamento daquele login (pending, ok, error), que o painel consulta até
   *   terminar; sem `state`, as contas conectadas.
   */
  // ---------- provedores com conta (src/providers/oauth): GitHub Copilot, xAI, Kimi, Cline... ----------

  /** O retorno do provedor (porta fixa ou rota do Rotaz) termina sempre na página de resultado do Rotaz. */
  const accountRender = (origin) => (res, state) => {
    res.writeHead(302, { location: `${origin}/api/oauth/account/done/${encodeURIComponent(state)}`, 'cache-control': 'no-store' });
    res.end();
  };

  /** Sem sessão: o navegador volta do provedor (ou da porta fixa) sem o cookie do painel; o state protege. */
  function accountPublicRoute(req, res, url) {
    const lang = resolveLang(store.ui.lang);
    const [, , , , step, state = ''] = url.pathname.split('/'); // /api/oauth/account/<callback|done>/<state>
    if (step === 'callback') return handleCallback(decodeURIComponent(state), url.searchParams, res, accountRender(`http://${req.headers.host}`));
    const l = loginStatus(decodeURIComponent(state));
    if (!l) return oauthPage(res, 400, lang, { ok: false, title: 'Não foi possível conectar', message: 'Login inválido ou expirado. Volte ao painel e conecte a conta de novo.' });
    if (l.status === 'ok') return oauthPage(res, 200, lang, { ok: true, title: 'Conta conectada', message: new LocalError('{0} conectada.', l.email ?? 'A conta') });
    return oauthPage(res, l.status === 'error' ? 400 : 202, lang, { ok: false, title: l.status === 'error' ? 'Não foi possível conectar' : 'Concluindo o login…', message: l.message ?? 'Volte ao Rotaz: a tela atualiza sozinha.' });
  }

  /** Com sessão: começar o login (navegador ou código de dispositivo) e acompanhar o andamento. */
  async function accountRoute(req, res, url) {
    const lang = reqLang(req, store);
    const p = store.provider(url.searchParams.get('provider') ?? '');
    if (!p || p.type !== 'oauth') throw new HttpError(404, 'Provedor com conta não encontrado.');
    if (url.pathname === '/api/oauth/account/begin' && req.method === 'POST') {
      const origin = `http://${req.headers.host}`;
      const r = await beginLogin({ provider: p, callbackBase: `${origin}/api/oauth/account/callback`, save: (cred) => store.addOAuthAccount(p.id, cred), render: accountRender(origin), log });
      log.info(`login de conta iniciado em ${p.name} (${r.kind})`);
      return json(res, 200, r);
    }
    if (url.pathname === '/api/oauth/account/status' && req.method === 'GET') {
      const l = loginStatus(url.searchParams.get('state') ?? '');
      if (!l || l.providerId !== p.id) return json(res, 200, { status: 'expired', message: tr(lang, 'Login inválido ou expirado. Volte ao painel e conecte a conta de novo.') });
      return json(res, 200, { status: l.status, email: l.email ?? null, message: l.message ? tr(lang, l.message) : null });
    }
    throw new HttpError(404, 'Rota não encontrada.');
  }

  async function oauthRoute(req, res, url) {
    if (url.pathname.startsWith('/api/oauth/account/')) return accountRoute(req, res, url);
    const p = store.provider(url.searchParams.get('provider') ?? '');
    if (!p || p.type !== 'antigravity') throw new HttpError(404, 'Provedor Antigravity não encontrado.');
    if (url.pathname === '/api/oauth/antigravity/begin' && req.method === 'POST') {
      const { verifier, challenge } = newPkce();
      const state = randomToken(24);
      rememberLogin(state, verifier, { providerId: p.id });
      oauthLogins.set(state, { status: 'pending', providerId: p.id, created: Date.now() });
      sweepLogins();
      const redirectUri = `http://${req.headers.host}${OAUTH_CB}`;
      log.info(`oauth antigravity iniciado para ${p.name}`);
      return json(res, 200, { url: buildAuthUrl({ redirectUri, state, challenge }), state });
    }
    if (url.pathname === '/api/oauth/antigravity/status' && req.method === 'GET') {
      const state = url.searchParams.get('state');
      if (state) {
        const l = oauthLogins.get(state);
        if (!l || l.providerId !== p.id) return json(res, 200, { status: 'expired', message: tr(reqLang(req, store), 'Login inválido ou expirado. Volte ao painel e conecte a conta de novo.') });
        return json(res, 200, { status: l.status, email: l.email ?? null, message: l.message ? tr(reqLang(req, store), l.message) : null });
      }
      return json(res, 200, { ok: true, provider: { id: p.id, name: p.name }, accounts: p.keys.map((k) => ({ id: k.id, label: k.label, hint: k.hint, enabled: k.enabled })) });
    }
    throw new HttpError(404, 'Rota não encontrada.');
  }

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
        const { data, etag } = readAsset(file);
        // Ícones, fontes e bibliotecas: o navegador guarda, mas confere a cada carga (ETag). Assim um sprite
        // novo, com ícones acrescentados, aparece na hora em vez de ficar um dia preso no cache.
        if (cacheable) {
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
      // O callback do OAuth chega sem cookie de sessão (redirect cross-site); o state de uso único
      // guardado no servidor em rememberLogin é a proteção CSRF — sem ele o code não é trocado.
      if (url.pathname === OAUTH_CB) { await oauthCallback(req, res, url); return true; }
      if (/^\/api\/oauth\/account\/(callback|done)\/[^/]*$/.test(url.pathname) && req.method === 'GET') { await accountPublicRoute(req, res, url); return true; }
      if (!sessionOf(req)) throw new HttpError(401, 'Sessão expirada.');
      if (url.pathname.startsWith('/api/oauth/')) { await oauthRoute(req, res, url); return true; }

      for (const [method, re, fn] of routes) {
        const m = re.exec(url.pathname);
        if (!m || method !== req.method) continue;
        const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(req, 1024 * 1024);
        // Se o painel desistir (fechou a aba, interrompeu o teste), o trabalho em andamento é cancelado.
        const ac = new AbortController();
        res.on('close', () => { if (!res.writableEnded) ac.abort(); });
        json(res, 200, await fn(body, m.slice(1), reqLang(req, store), ac.signal));
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

  return { handle, setupToken: () => state.setupToken, setupFile };
}
