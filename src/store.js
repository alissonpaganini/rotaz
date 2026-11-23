// Persistência em JSON com escrita atômica. Segredos ficam cifrados; o arquivo nunca guarda texto claro.
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { shortId, randomToken, sha256, hashPassword, verifyPassword } from './crypto.js';
import { ALIAS_RE, validateBaseUrl, validateHeaders, aliasCompat } from './security.js';
import { LocalError, CODES } from './i18n.js';
import { BUDGET_DEFAULTS, CURRENCIES, ACTIONS } from './budget.js';
import { specOf } from './providers/oauth/specs.js';

export const DEFAULTS = {
  version: 1,
  server: {
    host: '127.0.0.1', port: 8787, timeoutMs: 300000, maxBodyMB: 32,
    rateLimitPerMin: 600, maxConcurrent: 32, maxAttempts: 4,
    logLevel: 'info', autoStart: false, openBrowser: true, gatewayEnabled: true, updateCheck: true,
  },
  routing: {
    defaultAlias: null, catchAll: true, fallbackEnabled: true,
    tiers: { opus: null, sonnet: null, haiku: null },
  },
  providers: [],
  gateway: { tokenEnc: null },
  admin: { passHash: null },
  ui: { theme: 'auto', palette: 'lavanda', lang: 'auto', dashboard: null },
  keyCheck: null,
  budget: null, // gasto e orçamento (src/budget.js); null = padrões
};

/** Quadros da visão geral que o painel sabe desenhar. O layout salvo só pode usar estes. */
export const DASHBOARD_WIDGETS = ['route', 'success', 'spend', 'stats', 'requestsHills', 'tokensHills', 'latencyHills', 'traffic', 'providers', 'recent', 'errors'];

function normalizeDashboard(list) {
  if (!Array.isArray(list) || list.length > DASHBOARD_WIDGETS.length) throw new Error('Layout da visão geral inválido.');
  const seen = new Set();
  return list.map((w) => {
    if (!w || !DASHBOARD_WIDGETS.includes(w.id) || seen.has(w.id)) throw new Error('Quadro desconhecido ou repetido no layout.');
    seen.add(w.id);
    const span = Number(w.span);
    if (!Number.isInteger(span) || span < 3 || span > 12) throw new Error('A largura de um quadro vai de 3 a 12 colunas.');
    return { id: w.id, span };
  });
}

const clampNum = (v, min, max, name) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new LocalError('{0} deve estar entre {1} e {2}.', name, min, max);
  return n;
};

const clampInt = (v, min, max, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new LocalError('{0} deve estar entre {1} e {2}.', name, min, max);
  return n;
};

/** Configuração em disco. Emite 'change' depois de cada alteração gravada. */
export class Store extends EventEmitter {
  #aliases = null;
  #headers = new Map(); // headersEnc -> cabeçalhos decifrados

  constructor(dataDir, vault) {
    super();
    this.dataDir = dataDir;
    this.vault = vault;
    this.file = path.join(dataDir, 'config.json');
    this.load();
  }

  load() {
    const exists = fs.existsSync(this.file);
    const disk = exists ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {};
    this.c = {
      ...structuredClone(DEFAULTS), ...disk,
      server: { ...DEFAULTS.server, ...disk.server },
      routing: { ...DEFAULTS.routing, ...disk.routing, tiers: { ...DEFAULTS.routing.tiers, ...disk.routing?.tiers } },
      ui: { ...DEFAULTS.ui, ...disk.ui },
    };
    if (this.c.keyCheck) {
      try { this.vault.decrypt(this.c.keyCheck, 'keycheck'); }
      catch { throw new Error('A chave mestra atual não decifra data/config.json. Nada foi alterado. Restaure a chave mestra original.'); }
    } else this.c.keyCheck = this.vault.encrypt('ok', 'keycheck');
    if (!this.c.gateway.tokenEnc) this.rotateGatewayToken();
    this.cacheToken();
    if (!exists) this.save();
  }

  /**
   * Endereço vindo da linha de comando (--host, --port, ROTAZ_PORT): vale nesta execução, mas o arquivo continua
   * com o que foi salvo pelo painel. Antes, a primeira alteração qualquer gravava a porta temporária (até a 0).
   */
  override({ host, port } = {}) {
    for (const [k, v] of [['host', host], ['port', port]]) {
      if (v === undefined) continue;
      this.saved ??= {};
      if (!(k in this.saved)) this.saved[k] = this.c.server[k];
      this.c.server[k] = v;
    }
  }

  save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    const data = this.saved ? { ...this.c, server: { ...this.c.server, ...this.saved } } : this.c;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    // No Windows, antivírus e indexador seguram o arquivo por instantes: o rename falha com EPERM/EBUSY.
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, this.file); return; } catch (e) {
        if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
          fs.rmSync(tmp, { force: true });
          throw new LocalError('Não foi possível gravar a configuração ({0}). Nada foi alterado.', e.code);
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (i + 1));
      }
    }
  }

  /**
   * Toda alteração passa por aqui: ou valida e grava, ou a memória volta ao estado anterior.
   * Sem isso, um erro no meio deixava a mudança valendo só em memória até o próximo reinício.
   */
  transact(fn) {
    if (this.inTx) return fn();
    const snapshot = structuredClone(this.c);
    this.inTx = true;
    let r;
    try {
      r = fn();
      this.save();
    } catch (e) {
      this.c = snapshot;
      this.cacheToken();
      throw e;
    } finally { this.inTx = false; this.#aliases = null; }
    this.emit('change');
    return r;
  }

  /** Alterações administrativas (senha etc.), com o mesmo rollback. */
  update(fn) { return this.transact(() => fn(this.c)); }

  // Token que o Claude Code usa para falar com o gateway.
  rotateGatewayToken() {
    return this.transact(() => {
      const t = `gw-${randomToken(32)}`;
      this.c.gateway.tokenEnc = this.vault.encrypt(t, 'gateway-token');
      this.cacheToken();
      return t;
    });
  }
  cacheToken() { this.tokenHash = sha256(this.gatewayToken()); }
  /** O token apresentado pelo Claude Code confere com o do gateway (comparação em tempo constante). */
  checkGatewayToken(presented) { return !!presented && timingSafeEqual(sha256(presented), this.tokenHash); }

  // Senha do painel.
  get hasPassword() { return !!this.c.admin.passHash; }
  checkPassword(password) { return this.hasPassword && verifyPassword(String(password ?? ''), this.c.admin.passHash); }
  setPassword(password) { this.transact(() => { this.c.admin.passHash = hashPassword(password); }); }
  gatewayToken() { return this.vault.decrypt(this.c.gateway.tokenEnc, 'gateway-token'); }

  get server() { return this.c.server; }
  get routing() { return this.c.routing; }
  get ui() { return this.c.ui; }

  updateUi(input) {
    const theme = input.theme ?? this.ui.theme;
    const palette = input.palette ?? this.ui.palette;
    if (!['auto', 'light', 'dark'].includes(theme)) throw new Error('Tema inválido.');
    if (!['lavanda', 'salvia', 'oceano', 'rosa', 'grafite'].includes(palette)) throw new Error('Paleta inválida.');
    // Idioma: 'auto' segue o sistema; senão, um dos códigos disponíveis.
    const lang = input.lang ?? this.ui.lang ?? 'auto';
    if (lang !== 'auto' && !CODES.includes(lang)) throw new Error('Idioma inválido.');
    let dashboard = this.ui.dashboard ?? null;
    if (input.dashboard !== undefined) dashboard = input.dashboard === null ? null : normalizeDashboard(input.dashboard);
    // Última versão cujas novidades a pessoa já viu (o painel mostra as da versão nova uma vez, depois de atualizar).
    let seenVersion = this.ui.seenVersion ?? null;
    if (input.seenVersion !== undefined && input.seenVersion !== null) {
      if (!/^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(String(input.seenVersion))) throw new Error('Versão inválida.');
      seenVersion = String(input.seenVersion);
    }
    this.transact(() => { this.c.ui = { theme, palette, lang, dashboard, seenVersion }; });
    return this.c.ui;
  }
  get providers() { return this.c.providers; }
  removeAllProviders() { this.transact(() => { this.c.providers = []; }); }
  provider(id) { return this.c.providers.find((p) => p.id === id); }

  normalizeProvider(input, existing) {
    const name = String(input.name ?? existing?.name ?? '').trim();
    if (!name || name.length > 60) throw new Error('Informe um nome de até 60 caracteres.');
    const type = input.type ?? existing?.type ?? 'openai';
    if (!['openai', 'anthropic', 'antigravity', 'oauth'].includes(type)) throw new Error('Tipo de provedor inválido.');
    // oauth: qual ficha de provedor com conta (src/providers/oauth/specs.js) este provedor usa.
    const oauth = type === 'oauth' ? String(input.oauth ?? existing?.oauth ?? '') : null;
    const spec = type === 'oauth' ? specOf(oauth) : null;
    if (type === 'oauth' && !spec) throw new LocalError('Provedor de conta desconhecido: {0}', oauth.slice(0, 40));
    const allowPrivateNetwork = !!(input.allowPrivateNetwork ?? existing?.allowPrivateNetwork);
    // Provedores com conta não têm URL base configurável: o endpoint é fixo e a credencial vem do OAuth.
    const baseUrl = type === 'antigravity'
      ? 'https://daily-cloudcode-pa.googleapis.com'
      : type === 'oauth' ? spec.chatUrl
      : validateBaseUrl(input.baseUrl ?? existing?.baseUrl, { allowPrivate: allowPrivateNetwork, selfPort: this.server.port });
    const authScheme = type === 'antigravity' || type === 'oauth'
      ? 'bearer'
      : input.authScheme ?? existing?.authScheme ?? (type === 'anthropic' ? 'x-api-key' : 'bearer');
    if (!['bearer', 'x-api-key', 'api-key', 'none'].includes(authScheme)) throw new Error('Esquema de autenticação inválido.');
    // GitHub Enterprise e afins: o login e a API ficam no servidor da empresa, informado pela pessoa.
    const accountHost = spec?.needsHost
      ? validateBaseUrl(input.accountHost ?? existing?.accountHost ?? '', { allowPrivate: allowPrivateNetwork, selfPort: this.server.port }).replace(/\/+$/, '')
      : null;
    return {
      id: existing?.id ?? shortId(), name, type, ...(oauth && { oauth }), ...(accountHost && { accountHost }), baseUrl, authScheme, allowPrivateNetwork,
      enabled: !!(input.enabled ?? existing?.enabled ?? true),
      priority: clampInt(input.priority ?? existing?.priority ?? 10, 0, 1000, 'Prioridade'),
      rpm: clampInt(input.rpm ?? existing?.rpm ?? 0, 0, 100000, 'Limite de requisições por minuto'),
      presetId: /^[a-z0-9-]{1,40}$/.test(input.presetId ?? '') ? input.presetId : existing?.presetId ?? null,
      keys: existing?.keys ?? [],
      headersEnc: existing?.headersEnc ?? null,
      models: existing?.models ?? [],
    };
  }

  addProvider(input) {
    return this.transact(() => {
      const p = this.normalizeProvider(input);
      this.c.providers.push(p);
      if (input.headers) this.setHeaders(p, input.headers);
      for (const k of input.keys ?? []) this.addKey(p.id, k);
      for (const m of input.models ?? []) this.upsertModel(p.id, m);
      return p;
    });
  }

  updateProvider(id, input) {
    return this.transact(() => {
      const p = this.provider(id);
      if (!p) throw new Error('Provedor não encontrado.');
      Object.assign(p, this.normalizeProvider(input, p));
      if (input.headers !== undefined) this.setHeaders(p, input.headers);
      return p;
    });
  }

  removeProvider(id) {
    this.transact(() => {
      const n = this.c.providers.length;
      this.c.providers = this.c.providers.filter((p) => p.id !== id);
      if (n === this.c.providers.length) throw new Error('Provedor não encontrado.');
      this.dropDanglingRoutes();
    });
  }

  setHeaders(p, headers) {
    const clean = validateHeaders(headers);
    p.headersEnc = Object.keys(clean).length ? this.vault.encrypt(JSON.stringify(clean), `headers:${p.id}`) : null;
  }
  /** Cabeçalhos extras do provedor, decifrados uma vez por versão (o gateway lê a cada pedido). */
  headersOf(p) {
    if (!p.headersEnc) return {};
    let h = this.#headers.get(p.headersEnc);
    if (!h) {
      h = Object.freeze(JSON.parse(this.vault.decrypt(p.headersEnc, `headers:${p.id}`)));
      if (this.#headers.size > 200) this.#headers.clear();
      this.#headers.set(p.headersEnc, h);
    }
    return h;
  }

  addKey(providerId, input) { return this.transact(() => this.#addKey(providerId, input)); }
  #addKey(providerId, { label, key }) {
    const p = this.provider(providerId);
    if (!p) throw new Error('Provedor não encontrado.');
    const v = String(key ?? '').trim();
    if (!v || v.length > 4096 || /[\r\n\s]/.test(v)) throw new Error('Chave de API inválida.');
    const id = shortId();
    p.keys.push({ id, label: String(label ?? '').trim().slice(0, 40) || `Chave ${p.keys.length + 1}`, enabled: true,
      hint: v.length >= 12 ? `…${v.slice(-4)}` : '…', enc: this.vault.encrypt(v, `key:${p.id}:${id}`), addedAt: Date.now() });
    return id;
  }
  keyValue(p, k) { return this.vault.decrypt(k.enc, `key:${p.id}:${k.id}`); }
  updateKey(providerId, keyId, { enabled, label }) {
    this.transact(() => {
      const k = this.provider(providerId)?.keys.find((x) => x.id === keyId);
      if (!k) throw new Error('Chave não encontrada.');
      if (enabled !== undefined) k.enabled = !!enabled;
      if (label !== undefined) k.label = String(label).trim().slice(0, 40) || k.label;
    });
  }
  removeKey(providerId, keyId) {
    this.transact(() => {
      const p = this.provider(providerId);
      if (!p || !p.keys.some((k) => k.id === keyId)) throw new Error('Chave não encontrada.');
      p.keys = p.keys.filter((k) => k.id !== keyId);
    });
  }

  // ---- credenciais OAuth (antigravity) ----
  /**
   * Uma conta Google é guardada como um item de `keys`, para o rodízio de contas reaproveitar o
   * KeyPool que já existe. O que fica cifrado é o refresh_token + projectId + email.
   */
  addCredential(providerId, { label, refreshToken, projectId, email }) {
    return this.transact(() => {
      const p = this.provider(providerId);
      if (!p) throw new Error('Provedor não encontrado.');
      if (p.type !== 'antigravity') throw new Error('Este provedor não usa conta OAuth.');
      const rt = String(refreshToken ?? '').trim();
      if (!rt || rt.length > 4096 || /[\r\n\s]/.test(rt)) throw new Error('Refresh token inválido.');
      const id = shortId();
      const name = String(label ?? '').trim().slice(0, 40) || email || `Conta ${p.keys.length + 1}`;
      p.keys.push({
        id, label: name.slice(0, 40), enabled: true,
        hint: email ? `…${email.split('@')[0].slice(-6)}@${email.split('@')[1] ?? ''}`.slice(0, 40) : '…oauth',
        enc: this.vault.encrypt(JSON.stringify({ refreshToken: rt, projectId: String(projectId ?? ''), email: email ?? null }), `oauth:${p.id}:${id}`),
        accessEnc: null, expiresAt: 0, addedAt: Date.now(),
      });
      return id;
    });
  }

  // ---- contas de provedores OAuth genéricos (src/providers/oauth) ----
  /** Guarda uma conta conectada: tokens e dados do provedor ficam cifrados num pacote só. Devolve o e-mail. */
  addOAuthAccount(providerId, cred) {
    return this.transact(() => {
      const p = this.provider(providerId);
      if (!p || p.type !== 'oauth') throw new Error('Este provedor não usa conta OAuth.');
      const token = String(cred?.accessToken ?? '');
      if (!token || token.length > 16384) throw new Error('Token de acesso inválido.');
      const id = shortId();
      const email = cred.email ? String(cred.email).slice(0, 120) : null;
      p.keys.push({ id, label: (email || cred.name || `Conta ${p.keys.length + 1}`).slice(0, 40), enabled: true,
        hint: email ? `…${email.split('@')[0].slice(-6)}${email.includes('@') ? `@${email.split('@')[1]}` : ''}`.slice(0, 40) : '…oauth',
        enc: this.vault.encrypt(JSON.stringify({ ...cred, email }), `oauthx:${p.id}:${id}`), addedAt: Date.now() });
      return email;
    });
  }
  oauthAccount(provider, keyRecord) {
    if (!keyRecord?.enc) return null;
    try { return JSON.parse(this.vault.decrypt(keyRecord.enc, `oauthx:${provider.id}:${keyRecord.id}`)); } catch { return null; }
  }
  saveOAuthAccount(providerId, keyId, cred) {
    const p = this.provider(providerId);
    const k = p?.keys.find((x) => x.id === keyId);
    if (!p || !k) return;
    this.transact(() => { k.enc = this.vault.encrypt(JSON.stringify(cred), `oauthx:${p.id}:${k.id}`); });
  }

  credentialOf(provider, keyRecord) {
    if (!keyRecord?.enc) return null;
    try { return JSON.parse(this.vault.decrypt(keyRecord.enc, `oauth:${provider.id}:${keyRecord.id}`)); } catch { return null; }
  }

  /** Grava o resultado do refresh: token novo, eventual refresh_token rotacionado e projectId. */
  saveCredential(providerId, keyId, { refreshToken, projectId, email, accessToken, expiresAt }) {
    const p = this.provider(providerId);
    const k = p?.keys.find((x) => x.id === keyId);
    if (!p || !k) return;
    this.transact(() => {
      k.enc = this.vault.encrypt(JSON.stringify({ refreshToken, projectId: projectId ?? '', email: email ?? null }), `oauth:${p.id}:${k.id}`);
      k.accessEnc = accessToken ? this.vault.encrypt(accessToken, `access:${p.id}:${k.id}`) : null;
      k.expiresAt = Number(expiresAt) || 0;
      if (email) k.label = k.label.includes('@') || /^Conta \d+$/.test(k.label) ? String(email).slice(0, 40) : k.label;
    });
  }

  /** Limpa o cache de access token: força o próximo request a renovar. */
  forgetAccessToken(provider, keyRecord) {
    this.transact(() => {
      const k = this.provider(provider.id)?.keys.find((x) => x.id === keyRecord.id);
      if (!k) return;
      k.accessEnc = null;
      k.expiresAt = 0;
    });
  }

  upsertModel(providerId, input) { return this.transact(() => this.#upsertModel(providerId, input)); }
  #upsertModel(providerId, input) {
    const p = this.provider(providerId);
    if (!p) throw new Error('Provedor não encontrado.');
    const alias = String(input.alias ?? '').trim().toLowerCase();
    if (!ALIAS_RE.test(alias)) throw new Error('O alias deve começar com "claude-" e usar apenas a-z, 0-9, ponto, hífen ou sublinhado.');
    const upstream = String(input.upstream ?? '').trim();
    if (!upstream || upstream.length > 200 || /[\r\n]/.test(upstream)) throw new Error('Informe o identificador real do modelo no provedor.');
    const existing = input.id ? p.models.find((m) => m.id === input.id) : null;
    if (p.models.some((m) => m.alias === alias && m.id !== existing?.id)) throw new Error('Este alias já existe neste provedor.');
    const effort = input.reasoningEffort || null;
    if (effort && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(effort)) throw new Error('Esforço de raciocínio inválido.');
    const tokenParam = input.tokenParam || 'auto';
    if (!['auto', 'max_tokens', 'max_completion_tokens'].includes(tokenParam)) throw new Error('Parâmetro de tokens inválido.');
    const maxOutputTokens = input.maxOutputTokens ? clampInt(input.maxOutputTokens, 1, 2000000, 'Limite de saída') : null;
    // null = sem limite próprio (o gateway ainda aprende com os erros do provedor); 0 = nunca enviar imagens.
    const maxImages = input.maxImages === null || input.maxImages === undefined || input.maxImages === '' ? null : clampInt(input.maxImages, 0, 100, 'Limite de imagens');
    // preço em dólares por 1 milhão de tokens; vazio = sem preço (o gasto desse modelo não é contado)
    const price = (v, name) => (v === null || v === undefined || v === '' ? null : clampNum(v, 0, 10000, name));
    const priceIn = price(input.priceIn, 'Preço de entrada');
    const priceOut = price(input.priceOut, 'Preço de saída');
    // Contexto do modelo em tokens (ex.: 1.000.000). Ausente no pedido = mantém o que já estava (vem do catálogo do provedor).
    const ctxIn = 'contextWindow' in input ? input.contextWindow : existing?.contextWindow;
    const contextWindow = ctxIn === null || ctxIn === undefined || ctxIn === '' ? null : clampInt(ctxIn, 1000, 10000000, 'Contexto');
    const m = { id: existing?.id ?? shortId(), alias, upstream, displayName: String(input.displayName ?? '').trim().slice(0, 80) || alias,
      enabled: !!(input.enabled ?? existing?.enabled ?? true), maxOutputTokens, maxImages, reasoningEffort: effort, tokenParam, priceIn, priceOut, contextWindow };
    const oldAlias = existing && existing.alias !== alias ? existing.alias : null;
    if (existing) Object.assign(existing, m); else p.models.push(m);
    // Renomear leva junto as referências (padrão, níveis, reserva do orçamento) se nenhum outro modelo usa o nome antigo.
    if (oldAlias && !this.aliases().includes(oldAlias)) this.#renameRoutes(oldAlias, alias);
    if (!this.routing.defaultAlias) this.routing.defaultAlias = alias;
    this.dropDanglingRoutes();
    return m;
  }
  /** Adiciona vários de uma vez: ou todos entram, ou nenhum (o erro cita o modelo). */
  addModels(providerId, list) {
    if (!Array.isArray(list) || !list.length) throw new Error('Selecione ao menos um modelo.');
    if (list.length > 500) throw new Error('No máximo 500 modelos por vez.');
    return this.transact(() => list.map((m) => {
      try {
        return this.#upsertModel(providerId, { alias: m.alias, upstream: m.upstream, displayName: m.displayName, maxOutputTokens: m.maxOutputTokens, maxImages: m.maxImages, reasoningEffort: m.reasoningEffort, tokenParam: m.tokenParam, priceIn: m.priceIn, priceOut: m.priceOut, contextWindow: m.contextWindow ?? null });
      } catch (e) { throw new LocalError('{0}: {1}', String(m.alias || m.upstream).slice(0, 80), e); }
    }));
  }

  /** Aplica os mesmos campos a vários modelos. Só os campos presentes em `set` mudam. */
  updateModels(providerId, ids, set = {}) {
    const p = this.provider(providerId);
    if (!p) throw new Error('Provedor não encontrado.');
    if (!Array.isArray(ids) || !ids.length) throw new Error('Selecione ao menos um modelo.');
    const fields = ['enabled', 'maxOutputTokens', 'maxImages', 'reasoningEffort', 'tokenParam', 'priceIn', 'priceOut', 'contextWindow'].filter((f) => f in set);
    if (!fields.length) throw new Error('Nada para alterar.');
    this.transact(() => {
      for (const id of ids) {
        const m = p.models.find((x) => x.id === id);
        if (!m) throw new Error('Modelo não encontrado.');
        const patch = Object.fromEntries(fields.map((f) => [f, set[f]]));
        this.#upsertModel(providerId, { ...m, ...patch });
      }
    });
  }

  removeModels(providerId, ids) {
    this.transact(() => {
      const p = this.provider(providerId);
      if (!p) throw new Error('Provedor não encontrado.');
      const drop = new Set(ids ?? []);
      if (!drop.size) throw new Error('Selecione ao menos um modelo.');
      p.models = p.models.filter((m) => !drop.has(m.id));
      this.dropDanglingRoutes();
    });
  }

  removeModel(providerId, modelId) {
    this.transact(() => {
      const p = this.provider(providerId);
      if (!p || !p.models.some((m) => m.id === modelId)) throw new Error('Modelo não encontrado.');
      p.models = p.models.filter((m) => m.id !== modelId);
      this.dropDanglingRoutes();
    });
  }

  /** Aliases cadastrados. Fora de uma alteração, calculado uma vez até a próxima mudança (o roteamento lê a cada pedido). */
  aliases() {
    const compute = () => [...new Set(this.c.providers.flatMap((p) => p.models.map((m) => m.alias)))];
    if (this.inTx) return compute();
    return (this.#aliases ??= compute());
  }
  #renameRoutes(from, to) {
    const r = this.routing;
    if (r.defaultAlias === from) r.defaultAlias = to;
    for (const t of Object.keys(r.tiers)) if (r.tiers[t] === from) r.tiers[t] = to;
    if (this.c.budget?.fallbackAlias === from) this.c.budget.fallbackAlias = to;
  }

  dropDanglingRoutes() {
    const all = new Set(this.aliases());
    const r = this.routing;
    if (r.defaultAlias && !all.has(r.defaultAlias)) r.defaultAlias = this.aliases()[0] ?? null;
    for (const t of Object.keys(r.tiers)) if (r.tiers[t] && !all.has(r.tiers[t])) r.tiers[t] = null;
    // o modelo de reserva do orçamento sumiu: volta a só avisar
    const b = this.c.budget;
    if (b?.fallbackAlias && !all.has(b.fallbackAlias)) { b.fallbackAlias = null; if (b.action === 'switch') b.action = 'alert'; }
  }

  // ---- configurações ----
  updateRouting(input) {
    const all = new Set(this.aliases());
    const check = (a) => { if (a && !all.has(a)) throw new LocalError('Alias desconhecido: {0}', String(a).slice(0, 70)); return a || null; };
    const next = structuredClone(this.routing);
    if (input.defaultAlias !== undefined) next.defaultAlias = check(input.defaultAlias);
    if (input.catchAll !== undefined) next.catchAll = !!input.catchAll;
    if (input.fallbackEnabled !== undefined) next.fallbackEnabled = !!input.fallbackEnabled;
    for (const t of ['opus', 'sonnet', 'haiku']) if (input.tiers?.[t] !== undefined) next.tiers[t] = check(input.tiers[t]);
    this.transact(() => { this.c.routing = next; });
  }

  get budget() { return { ...BUDGET_DEFAULTS, ...this.c.budget }; }
  /** Orçamento como gravado (null quando nunca foi configurado), para o backup. */
  get savedBudget() { return this.c.budget ? { ...this.c.budget } : null; }
  resetBudget() { this.transact(() => { this.c.budget = null; }); }
  updateBudget(input) {
    const b = this.budget;
    const next = { ...b };
    if (input.currency !== undefined) {
      if (!CURRENCIES.includes(input.currency)) throw new Error('Moeda inválida.');
      next.currency = input.currency;
    }
    if (input.rate !== undefined) next.rate = clampNum(input.rate, 0.0001, 100000, 'Cotação');
    if (next.currency === 'USD') next.rate = 1;
    if (input.daily !== undefined) next.daily = clampNum(input.daily || 0, 0, 10000000, 'Limite diário');
    if (input.monthly !== undefined) next.monthly = clampNum(input.monthly || 0, 0, 10000000, 'Limite mensal');
    if (input.warnAt !== undefined) next.warnAt = clampInt(input.warnAt, 1, 99, 'Aviso');
    if (input.action !== undefined) {
      if (!ACTIONS.includes(input.action)) throw new Error('Ação inválida.');
      next.action = input.action;
    }
    if (input.fallbackAlias !== undefined) {
      if (input.fallbackAlias && !this.aliases().includes(input.fallbackAlias)) throw new LocalError('Alias desconhecido: {0}', String(input.fallbackAlias).slice(0, 70));
      next.fallbackAlias = input.fallbackAlias || null;
    }
    if (next.action === 'switch' && !next.fallbackAlias) throw new Error('Escolha o modelo para onde os pedidos vão quando o limite for atingido.');
    this.transact(() => { this.c.budget = next; });
    return next;
  }

  updateServer(input) {
    const s = this.server;
    const next = { ...s };
    if (input.host !== undefined) {
      if (!['127.0.0.1', '::1', 'localhost', '0.0.0.0', '::'].includes(input.host) && !/^(\d{1,3}\.){3}\d{1,3}$/.test(input.host)) throw new Error('Endereço de escuta inválido.');
      next.host = input.host;
    }
    if (input.port !== undefined) next.port = clampInt(input.port, 1024, 65535, 'Porta');
    if (input.timeoutMs !== undefined) next.timeoutMs = clampInt(input.timeoutMs, 1000, 3600000, 'Timeout');
    if (input.maxBodyMB !== undefined) next.maxBodyMB = clampInt(input.maxBodyMB, 1, 256, 'Limite de payload');
    if (input.rateLimitPerMin !== undefined) next.rateLimitPerMin = clampInt(input.rateLimitPerMin, 0, 100000, 'Limite de requisições');
    if (input.maxConcurrent !== undefined) next.maxConcurrent = clampInt(input.maxConcurrent, 1, 1000, 'Concorrência');
    if (input.maxAttempts !== undefined) next.maxAttempts = clampInt(input.maxAttempts, 1, 10, 'Tentativas');
    if (input.logLevel !== undefined) {
      if (!['error', 'warn', 'info', 'debug'].includes(input.logLevel)) throw new Error('Nível de log inválido.');
      next.logLevel = input.logLevel;
    }
    if (input.autoStart !== undefined) next.autoStart = !!input.autoStart;
    if (input.openBrowser !== undefined) next.openBrowser = !!input.openBrowser;
    if (input.gatewayEnabled !== undefined) next.gatewayEnabled = !!input.gatewayEnabled;
    if (input.updateCheck !== undefined) next.updateCheck = !!input.updateCheck;
    // Endereço da linha de comando só passa a ser gravado quando o painel muda esse campo de fato.
    const kept = this.saved && { ...this.saved };
    const changed = ['host', 'port'].filter((k) => next[k] !== s[k]);
    try {
      this.transact(() => {
        Object.assign(this.c.server, next);
        for (const k of changed) if (this.saved) delete this.saved[k];
      });
    } catch (e) { if (kept) this.saved = kept; throw e; }
  }

  /** Visão segura para o navegador: nenhum segredo sai daqui. */
  publicProviders() {
    return this.c.providers.map((p) => ({
      id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl, authScheme: p.authScheme, enabled: p.enabled, priority: p.priority,
      allowPrivateNetwork: p.allowPrivateNetwork, rpm: p.rpm ?? 0, presetId: p.presetId ?? null, oauth: p.oauth ?? null, accountHost: p.accountHost ?? null,
      headerNames: Object.keys(this.headersOf(p)),
      keys: p.keys.map(({ id, label, enabled, hint, addedAt }) => ({ id, label, enabled, hint, addedAt })),
      models: p.models.map((m) => ({ ...m, compat: aliasCompat(m.alias) })),
    }));
  }
}
