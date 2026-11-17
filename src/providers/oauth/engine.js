// Motor dos provedores com conta (OAuth): login, guarda da conta, renovação e rota de cada pedido.
// As diferenças entre provedores ficam nas fichas (specs.js); aqui o fluxo é o mesmo para todos.
import http from 'node:http';
import crypto from 'node:crypto';
import { send, readText } from '../../upstream.js';
import { safeParse } from '../../translate/common.js';
import { LocalError } from '../../i18n.js';
import { specOf, jwtIdentity } from './specs.js';

/** HTTP simples para as fichas: JSON ou formulário, resposta já lida. */
export async function httpCall(url, { method = 'GET', headers = {}, form, json, timeoutMs = 20000 } = {}) {
  const h = { accept: 'application/json', ...headers };
  let body;
  if (form) { body = new URLSearchParams(form).toString(); h['content-type'] = 'application/x-www-form-urlencoded'; }
  else if (json !== undefined) { body = JSON.stringify(json); h['content-type'] = 'application/json'; }
  const up = await send({ url, method, headers: h, body, timeoutMs });
  const text = await readText(up.stream, 4 * 1024 * 1024, timeoutMs);
  return { status: up.status, text, json: safeParse(text) };
}

const b64url = (b) => b.toString('base64url');

/** Resposta de token (snake_case ou camelCase) no formato da conta guardada. */
function normalizeTokens(t, extra = {}) {
  const id = jwtIdentity(t.id_token ?? t.idToken);
  const expiresIn = Number(t.expires_in ?? t.expiresIn);
  const expiresAt = Number(t.expiresAt) || (Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : 0);
  return {
    accessToken: t.access_token ?? t.accessToken, refreshToken: t.refresh_token ?? t.refreshToken ?? null, expiresAt,
    email: t.email ?? id.email ?? null, name: t.name ?? id.name ?? null, extra,
  };
}

// ---------- login ----------

const logins = new Map(); // state -> { providerId, status, message, email, created }
const LOGIN_TTL = 15 * 60000;
const sweep = () => { const now = Date.now(); for (const [k, v] of logins) if (now - v.created > LOGIN_TTL) { logins.delete(k); v.cleanup?.(); } };

export function loginStatus(state) { return logins.get(state) ?? null; }

/** Servidores de retorno em portas fixas (o cliente OAuth do provedor só aceita aquela porta). */
const loopbacks = new Map(); // porta -> { server, handlers: Map(state -> fn) }
function listenLoopback(port, path, state, handler) {
  let lb = loopbacks.get(port);
  if (!lb) {
    const handlers = new Map();
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${port}`);
      const fn = handlers.get(u.searchParams.get('state') ?? '');
      if (u.pathname !== path || !fn) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Login desconhecido ou expirado.'); return; }
      handlers.delete(u.searchParams.get('state'));
      fn(u.searchParams, res);
      if (!handlers.size) setTimeout(() => { if (!handlers.size) { server.close(); loopbacks.delete(port); } }, 2000);
    });
    lb = { server, handlers };
    loopbacks.set(port, lb);
    const ready = new Promise((resolve, reject) => {
      server.once('error', (e) => { loopbacks.delete(port); reject(e.code === 'EADDRINUSE' ? new LocalError('A porta {0} está ocupada por outro programa e o login deste provedor precisa dela. Feche o outro programa e tente de novo.', port) : e); });
      server.listen(port, '127.0.0.1', resolve);
    });
    lb.ready = ready;
  }
  lb.handlers.set(state, handler);
  return lb.ready.then(() => () => { lb.handlers.delete(state); if (!lb.handlers.size) { lb.server.close(); loopbacks.delete(port); } });
}

/**
 * Começa o login de uma conta. `callbackBase`: URL do retorno no próprio Rotaz (para provedores sem porta fixa).
 * `save(cred)` grava a conta e devolve o e-mail; `render(res, state, ok, message)` desenha a página de retorno.
 * Devolve { state, kind: 'browser' | 'device', url, userCode }.
 */
export async function beginLogin({ provider, callbackBase, save, render, log }) {
  const spec = specOf(provider.oauth);
  if (!spec) throw new LocalError('Provedor de conta desconhecido: {0}', provider.oauth);
  sweep();
  const state = spec.login.makeState?.(callbackBase) ?? b64url(crypto.randomBytes(24));
  const entry = { providerId: provider.id, status: 'pending', created: Date.now() };
  logins.set(state, entry);
  const settle = (patch) => Object.assign(entry, patch);
  const finish = async (tokens, extra) => {
    const cred = normalizeTokens(tokens, extra);
    if (!cred.accessToken) throw new Error('O provedor não devolveu o token de acesso.');
    if (spec.login.identity && !cred.email) Object.assign(cred, Object.fromEntries(Object.entries(await spec.login.identity(cred, httpCall).catch(() => ({}))).filter(([, v]) => v)));
    if (spec.ready) { const up = await spec.ready(cred, httpCall); if (up?.extra) cred.extra = { ...cred.extra, ...up.extra }; }
    const email = save(cred);
    settle({ status: 'ok', email, message: null });
    log?.info(`conta conectada em ${provider.name}: ${email ?? '(sem e-mail)'}`);
    return email;
  };
  const fail = (e) => { settle({ status: 'error', message: String(e?.message ?? e).slice(0, 400) }); log?.warn(`login ${provider.oauth} falhou: ${e?.message ?? e}`); };
  const L = spec.login;

  // Navegador com PKCE (porta fixa do cliente oficial ou retorno pelo Rotaz)
  if (L.type === 'pkce' || L.type === 'cline') {
    // Uma "tentativa" = state, verifier e client_id próprios. O provedor pode pedir uma segunda tentativa
    // (ChatGPT: depois do registro, a troca do código pode voltar invalid_grant e o login recomeça com o
    // client_id emitido); o painel continua acompanhando pelo state do começo.
    const cleanups = [];
    entry.cleanup = () => cleanups.forEach((fn) => fn());
    let restarts = 0;
    const attempt = async (attemptState, clientId) => {
      const verifier = b64url(crypto.randomBytes(32));
      const redirectUri = L.port ? `http://127.0.0.1:${L.port}${L.path}` : `${callbackBase}/${state}`;
      let url;
      // Provedores que geram a URL de autorização num pedido próprio (DeepSeek): recebem o desafio PKCE pronto.
      if (L.authorize) {
        url = await L.authorize({ redirectUri, state: attemptState, verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), http: httpCall });
      } else if (L.type === 'pkce') {
        const params = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: L.scope, state: attemptState,
          code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', ...(L.extraParams?.({ callbackBase, clientId }) ?? {}) });
        url = `${L.authorizeUrl}?${params}`;
      } else {
        url = `https://api.cline.bot/api/v1/auth/authorize?${new URLSearchParams({ client_type: 'extension', callback_url: redirectUri, redirect_uri: redirectUri })}`;
      }
      const onCallback = async (q, res) => {
        if (q.get('error')) { fail(q.get('error') === 'access_denied' ? 'O login foi cancelado na tela do provedor.' : `O provedor recusou o login: ${q.get('error_description') || q.get('error')}`); return render(res, state, false, entry.message); }
        try {
          const code = q.get('code');
          if (!code) throw new Error('O provedor não devolveu o código de autorização.');
          const tokens = L.exchange ? await L.exchange({ query: q, code, redirectUri, verifier, clientId, http: httpCall })
            : L.type === 'pkce' ? await exchangePkce(L, code, redirectUri, verifier) : await exchangeCline(code, redirectUri);
          if (tokens?.restartWith && L.port && restarts++ < 2) {
            // Nova tentativa com o client_id emitido: o navegador segue direto para a autorização.
            const next = await attempt(L.makeState?.(callbackBase) ?? b64url(crypto.randomBytes(24)), tokens.restartWith);
            res.writeHead(302, { location: next, 'cache-control': 'no-store' });
            return res.end();
          }
          if (tokens?.restartWith) throw new Error(tokens.message || 'O provedor recusou a troca do código. Comece o login de novo.');
          if (L.type === 'pkce' && L.userinfoUrl && !jwtIdentity(tokens.id_token).email) {
            const u = await httpCall(L.userinfoUrl, { headers: { authorization: `Bearer ${tokens.access_token}` } }).catch(() => null);
            if (u?.json?.email) tokens.email = u.json.email;
          }
          const email = await finish(tokens, L.extra?.(tokens, q, clientId) ?? {});
          render(res, state, true, email);
        } catch (e) { fail(e); render(res, state, false, entry.message); }
      };
      if (L.port) cleanups.push(await listenLoopback(L.port, L.path, attemptState, onCallback));
      else entry.onCallback = onCallback;
      return url;
    };
    const url = await attempt(state, L.clientId);
    return { state, kind: 'browser', url };
  }

  // Código de dispositivo (RFC 8628) ou fluxo próprio do provedor
  if (L.type === 'device' || L.type === 'device-custom') {
    const extra = L.device?.() ?? {};
    const dev = L.type === 'device' ? await startDevice(L, extra) : await L.start(httpCall, provider);
    const afterDevice = (tokens) => L.extra?.(tokens) ?? {};
    const deadline = Date.now() + (Number(dev.expiresIn) || 600) * 1000;
    let interval = Math.max(2, Number(dev.interval) || 5) * 1000;
    const tick = async () => {
      if (entry.status !== 'pending') return;
      if (Date.now() > deadline) return fail('O código expirou. Comece o login de novo.');
      try {
        const r = L.type === 'device' ? await pollDevice(L, dev, extra) : await L.poll(dev, httpCall, provider);
        if (r.slowDown) interval += 5000;
        if (r.error) return fail(r.error);
        if (r.tokens) { await finish(r.tokens, { ...extra, ...afterDevice(r.tokens), ...(r.extra ?? {}) }); return; }
      } catch (e) { return fail(e); }
      entry.timer = setTimeout(tick, interval);
    };
    entry.timer = setTimeout(tick, interval);
    entry.cleanup = () => clearTimeout(entry.timer);
    return { state, kind: 'device', url: dev.urlComplete || dev.url, userCode: dev.userCode };
  }
  throw new LocalError('Este provedor ainda não tem login automático.');
}

/** Retorno do navegador pelo próprio Rotaz (provedores sem porta fixa). */
export function handleCallback(state, query, res, render) {
  const entry = logins.get(state);
  if (!entry?.onCallback) return render(res, state, false, 'Login inválido ou expirado. Volte ao painel e conecte a conta de novo.');
  const fn = entry.onCallback;
  entry.onCallback = null; // uso único
  return fn(query, res);
}

async function exchangePkce(L, code, redirectUri, verifier) {
  const r = await httpCall(L.tokenUrl, { method: 'POST', form: { grant_type: 'authorization_code', client_id: L.clientId, code, redirect_uri: redirectUri, code_verifier: verifier } });
  if (r.status !== 200 || !r.json?.access_token) throw new Error(`O provedor recusou a troca do código (HTTP ${r.status}): ${(r.json?.error_description || r.json?.error || r.text).toString().slice(0, 200)}`);
  return r.json;
}

/** Cline: o código é um JSON em base64 com os tokens; se não for, troca no endpoint deles. */
async function exchangeCline(code, redirectUri) {
  try {
    let s = code;
    try { s = decodeURIComponent(s); } catch { /* já decodificado */ }
    const decoded = Buffer.from(s, 'base64').toString('utf8');
    const j = JSON.parse(decoded.slice(0, decoded.lastIndexOf('}') + 1));
    if (!j.accessToken) throw new Error('sem token');
    return { accessToken: j.accessToken, refreshToken: j.refreshToken, email: j.email, name: [j.firstName, j.lastName].filter(Boolean).join(' ') || null, expiresAt: j.expiresAt ? Date.parse(j.expiresAt) : 0 };
  } catch {
    const r = await httpCall('https://api.cline.bot/api/v1/auth/token', { method: 'POST', json: { grant_type: 'authorization_code', code, client_type: 'extension', redirect_uri: redirectUri } });
    const d = r.json?.data ?? r.json;
    if (r.status !== 200 || !d?.accessToken) throw new Error(`O Cline recusou a troca do código (HTTP ${r.status}).`);
    return { accessToken: d.accessToken, refreshToken: d.refreshToken, email: d.userInfo?.email ?? null, expiresAt: d.expiresAt ? Date.parse(d.expiresAt) : 0 };
  }
}

async function startDevice(L, extra) {
  const r = await httpCall(L.deviceCodeUrl, { method: 'POST', headers: L.headers?.(extra) ?? {}, form: { client_id: L.clientId, ...(L.scope && { scope: L.scope }), ...(L.form ?? {}) } });
  if (r.status !== 200 || !r.json?.device_code) throw new Error(`O provedor recusou o início do login (HTTP ${r.status}): ${(r.json?.error_description || r.text).toString().slice(0, 200)}`);
  return { deviceCode: r.json.device_code, userCode: r.json.user_code, url: r.json.verification_uri, urlComplete: r.json.verification_uri_complete, expiresIn: r.json.expires_in, interval: r.json.interval };
}

async function pollDevice(L, dev, extra) {
  const r = await httpCall(L.tokenUrl, { method: 'POST', headers: L.headers?.(extra) ?? {},
    form: { client_id: L.clientId, device_code: dev.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' } });
  const j = r.json ?? {};
  if (j.access_token) return { tokens: j };
  if (j.error === 'authorization_pending') return { pending: true };
  if (j.error === 'slow_down') return { pending: true, slowDown: true };
  if (j.error === 'access_denied') return { error: 'O login foi recusado na tela do provedor.' };
  if (j.error === 'expired_token') return { error: 'O código expirou. Comece o login de novo.' };
  return { error: `O provedor recusou o login (HTTP ${r.status}): ${j.error_description || j.error || r.text.slice(0, 160)}` };
}

// ---------- uso da conta ----------

const inflight = new Map();

/** Conta pronta para um pedido: renova o token perto de expirar e faz o preparo próprio do provedor. */
export function oauthCredential(store, provider, keyRecord) {
  const id = `${provider.id}:${keyRecord.id}`;
  if (inflight.has(id)) return inflight.get(id);
  const job = (async () => {
    const spec = specOf(provider.oauth);
    let cred = store.oauthAccount(provider, keyRecord);
    if (!spec || !cred?.accessToken) throw new LocalError('A conta {0} precisa ser conectada de novo.', keyRecord.label);
    let changed = false;
    if (cred.expiresAt && cred.expiresAt - Date.now() < 60000) {
      if (!spec.refresh || !cred.refreshToken) throw new LocalError('O acesso da conta {0} expirou. Conecte a conta de novo.', keyRecord.label);
      const r = await spec.refresh(cred, httpCall);
      if (r.error) throw r.fatal ? new LocalError('O provedor recusou renovar o acesso da conta {0}. Conecte a conta de novo.', keyRecord.label) : new LocalError('Não foi possível renovar o acesso da conta {0}: {1}', keyRecord.label, r.error);
      cred = { ...cred, accessToken: r.accessToken, refreshToken: r.refreshToken ?? cred.refreshToken,
        expiresAt: r.expiresAt || (Number(r.expiresIn) > 0 ? Date.now() + Number(r.expiresIn) * 1000 : 0), extra: r.extra ? { ...cred.extra, ...r.extra } : cred.extra };
      changed = true;
    }
    if (spec.ready) {
      const up = await spec.ready(cred, httpCall);
      if (up?.extra) { cred = { ...cred, extra: { ...cred.extra, ...up.extra } }; changed = true; }
    }
    if (changed) store.saveOAuthAccount(provider.id, keyRecord.id, cred);
    return cred;
  })().finally(() => inflight.delete(id));
  inflight.set(id, job);
  return job;
}

/** Depois de um 401/403: o próximo pedido renova o token antes de usar. */
export function forgetOAuth(store, provider, keyRecord) {
  const cred = store.oauthAccount(provider, keyRecord);
  if (!cred) return;
  const extra = { ...cred.extra };
  delete extra.copilotToken;
  delete extra.apiKey; // Muse Code: a chave cunhada é refeita no próximo pedido
  store.saveOAuthAccount(provider.id, keyRecord.id, { ...cred, expiresAt: cred.refreshToken ? 1 : cred.expiresAt, extra });
}

/** Para onde vai um pedido deste modelo, em que formato e com quais cabeçalhos. */
export function routeFor(provider, model, cred) {
  const spec = specOf(provider.oauth);
  const r = spec.route?.(model, cred) ?? { format: spec.format, url: spec.chatUrl };
  return { format: r.format, url: r.url, headers: { ...spec.headers(cred), ...(r.headers ?? {}) }, body: spec.body };
}

/** Pedido da lista de modelos da conta, ou a lista embutida quando o provedor não publica uma. */
export function modelsRequest(provider, cred) {
  const spec = specOf(provider.oauth);
  if (spec.catalog) return { catalog: spec.catalog };
  return spec.models?.(cred) ?? (spec.modelsUrl ? { url: spec.modelsUrl, headers: spec.headers(cred) } : null);
}

/**
 * Ajustes finais do pedido, depois da tradução e antes do envio: chamadas que o provedor exige antes de cada
 * pedido (ex.: Freebuff abre uma sessão) e o corpo e os cabeçalhos que elas devolvem.
 */
export async function beforeRequest(provider, model, cred, prep) {
  const spec = specOf(provider.oauth);
  if (!spec?.beforeRequest) return prep;
  const r = await spec.beforeRequest({ cred, model, payload: prep.payload, http: httpCall });
  return { ...prep, payload: r.payload ?? prep.payload, headers: { ...prep.headers, ...(r.headers ?? {}) } };
}

export const forceStreamOf = (provider) => !!specOf(provider.oauth)?.forceStream;
