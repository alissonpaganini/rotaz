// Provedor Antigravity: a conta Google paga do usuário, falando o backend do Google Cloud Code.
// Não usa a API do Gemini nem uma chave estática: guarda um refresh_token OAuth e troca por um
// access_token curto, do mesmo jeito que o Antigravity IDE e o `agy` fazem.
//
// Tudo que é específico deste provedor mora aqui: OAuth, descoberta de projectId, cabeçalhos,
// envelope da requisição e limpeza de schema. O pipeline só chama `credentialFor` e `envelope`.
import crypto from 'node:crypto';
import { send, readText } from '../upstream.js';
import { LocalError } from '../i18n.js';
import { safeParse } from '../translate/common.js';

/**
 * Credenciais públicas do cliente desktop do Antigravity (RFC 8252: app instalado usa PKCE, não
 * segredo). Vêm embutidas no binário oficial. Sobrescrevíveis por ambiente para quem preferir
 * um client próprio no Google Cloud Console.
 */
export const CLIENT_ID = process.env.ANTIGRAVITY_OAUTH_CLIENT_ID || '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET || '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';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo';
const BOOTSTRAP_BASE = 'https://cloudcode-pa.googleapis.com';
const RUNTIME_BASE = 'https://daily-cloudcode-pa.googleapis.com';

/** Sem `openid`: com openid + PKCE o Google trava o consentimento em firstparty/nativeapp. */
export const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
];

const STREAM_URL = `${RUNTIME_BASE}/v1internal:streamGenerateContent?alt=sse`;

// Enum real que o backend espera em `metadata` — string no lugar do número leva 403.
const IDE_TYPE = 9;
const PLUGIN_TYPE_GEMINI = 2;
const PLATFORM = { UNSPECIFIED: 0, DARWIN_AMD64: 1, DARWIN_ARM64: 2, LINUX_AMD64: 3, LINUX_ARM64: 4, WINDOWS_AMD64: 5 };

// O IDE nativo se apresenta como build macOS: o backend espera essa impressão digital,
// independente de onde o Rotaz roda.
const UA = 'antigravity/ide/2.5.5 darwin/arm64';

const POSTEXCHANGE_TIMEOUT_MS = 8000;
const REFRESH_MARGIN_MS = 60000;

/** Refresh em andamento por conta: 20 requisições simultâneas não podem disparar 20 refreshes. */
const inflight = new Map();
/** state -> { codeVerifier, created } do login em andamento. */
const pendingLogins = new Map();

const platformEnum = () => {
  const p = process.platform;
  if (p === 'darwin') return process.arch === 'arm64' ? PLATFORM.DARWIN_ARM64 : PLATFORM.DARWIN_AMD64;
  if (p === 'linux') return process.arch === 'arm64' ? PLATFORM.LINUX_ARM64 : PLATFORM.LINUX_AMD64;
  if (p === 'win32') return PLATFORM.WINDOWS_AMD64;
  return PLATFORM.UNSPECIFIED;
};

/** Identidade de cliente que vai no corpo de loadCodeAssist/onboardUser. */
const metadata = () => ({ ideType: IDE_TYPE, platform: platformEnum(), pluginType: PLUGIN_TYPE_GEMINI });

// ---------- PKCE e URL de autorização ----------

const b64url = (b) => b.toString('base64url');
const sha256b64url = (s) => crypto.createHash('sha256').update(s).digest('base64url');

export function newPkce() {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: sha256b64url(verifier) };
}

export function buildAuthUrl({ redirectUri, state, challenge }) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES.join(' '),
    state,
    access_type: 'offline',
    // Sem `consent` a segunda conta no mesmo navegador herda a sessão da primeira e não vem refresh_token.
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/** Guarda o verificador do login (e o provedor alvo). O state expira em 10 minutos. */
export function rememberLogin(state, verifier, extra = {}) {
  const now = Date.now();
  for (const [k, v] of pendingLogins) if (now - v.created > 600000) pendingLogins.delete(k);
  pendingLogins.set(state, { verifier, ...extra, created: now });
}

export function takeLogin(state) {
  const hit = pendingLogins.get(state);
  pendingLogins.delete(state);
  return hit && Date.now() - hit.created <= 600000 ? hit : null;
}

// ---------- troca e renovação de token ----------

function googleError(text) {
  const j = safeParse(text);
  return j?.error_description || j?.error || String(text || '').slice(0, 300);
}

async function tokenRequest(params) {
  const up = await send({
    url: TOKEN_URL,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
    body: new URLSearchParams(params).toString(),
    timeoutMs: 20000,
  });
  const text = await readText(up.stream, 1024 * 1024);
  if (up.status !== 200) throw new Error(`Google recusou o token (HTTP ${up.status}): ${googleError(text)}`);
  const j = safeParse(text);
  if (!j?.access_token) throw new Error('A resposta do Google não trouxe access_token.');
  return j;
}

/** Troca o code do redirect por tokens. O code_verifier fecha o PKCE. */
export function exchangeCode({ code, redirectUri, verifier }) {
  return tokenRequest({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
}

function refreshRequest(refreshToken) {
  return tokenRequest({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refreshToken,
  });
}

// ---------- projectId ----------

const projectIdOf = (data) => {
  const p = data?.cloudaicompanionProject;
  if (typeof p === 'string') return p.trim();
  if (p && typeof p === 'object' && typeof p.id === 'string') return p.id.trim();
  return '';
};

const tierOf = (data) => {
  const t = data?.currentTier?.id ?? data?.allowedTiers?.find?.((x) => x?.isDefault)?.id;
  return typeof t === 'string' && t ? t : 'legacy-tier';
};

async function postJson(url, token, body, timeoutMs = POSTEXCHANGE_TIMEOUT_MS) {
  const up = await send({
    url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': UA },
    body,
    timeoutMs,
  });
  const text = await readText(up.stream, 4 * 1024 * 1024);
  if (up.status !== 200) throw new Error(`HTTP ${up.status}: ${googleError(text)}`);
  return safeParse(text) ?? {};
}

/** Descobre (ou cria) o projeto do Cloud Code. Sem ele todo request volta 404. */
export async function discoverProject(accessToken) {
  const meta = metadata();
  const load = () => postJson(`${BOOTSTRAP_BASE}/v1internal:loadCodeAssist`, accessToken, { metadata: meta });

  let data;
  try { data = await load(); } catch (e) { return { projectId: '', tier: 'legacy-tier', error: e.message }; }

  let projectId = projectIdOf(data);
  let tier = tierOf(data);
  if (projectId) return { projectId, tier };

  // Conta sem projeto: onboardUser cria. A resposta costuma vir done:false (operação longa),
  // então o loadCodeAssist SEMPRE roda de novo — inclusive no caminho de sucesso.
  try {
    const r = await postJson(`${BOOTSTRAP_BASE}/v1internal:onboardUser`, accessToken, { tier_id: tier, metadata: meta });
    projectId = projectIdOf(r);
  } catch { /* segue para a redescoberta */ }

  for (let i = 0; i < 3 && !projectId; i++) {
    // Jitter: um laço apertado parece automação para o backend.
    await new Promise((r) => setTimeout(r, 3000 + Math.random() * 4000));
    try { const again = await load(); projectId = projectIdOf(again); tier = tierOf(again); } catch { break; }
  }
  return { projectId, tier };
}

export async function fetchUserInfo(accessToken) {
  try {
    const up = await send({ url: `${USERINFO_URL}?alt=json`, method: 'GET', headers: { authorization: `Bearer ${accessToken}`, 'user-agent': UA }, timeoutMs: POSTEXCHANGE_TIMEOUT_MS });
    const j = safeParse(await readText(up.stream, 256 * 1024));
    return { email: typeof j?.email === 'string' ? j.email : undefined };
  } catch { return {}; }
}

// ---------- credencial guardada ----------

/**
 * Converte o refresh_token em credencial utilizável. O token fica em cache no registro da conta e
 * só é renovado perto de expirar; refreshes concorrentes da mesma conta compartilham uma promise.
 */
export function refreshCredential(store, provider, keyRecord, stored) {
  const cached = keyRecord.accessEnc && keyRecord.expiresAt > Date.now() + REFRESH_MARGIN_MS;
  if (cached) return Promise.resolve({ token: store.vault.decrypt(keyRecord.accessEnc, `access:${provider.id}:${keyRecord.id}`), projectId: stored.projectId, email: stored.email });

  const running = inflight.get(keyRecord.id);
  if (running) return running;

  const job = (async () => {
    const tokens = await refreshRequest(stored.refreshToken);
    // O Google às vezes devolve um refresh_token novo. Não persistir mata a conta no refresh seguinte.
    const refreshToken = tokens.refresh_token || stored.refreshToken;
    const expiresAt = Date.now() + (Number(tokens.expires_in) || 3600) * 1000;

    let projectId = stored.projectId;
    if (!projectId) {
      const d = await discoverProject(tokens.access_token);
      projectId = d.projectId || '';
    }
    const email = stored.email || (await fetchUserInfo(tokens.access_token)).email || null;

    store.saveCredential(provider.id, keyRecord.id, { refreshToken, projectId, email, accessToken: tokens.access_token, expiresAt });
    return { token: tokens.access_token, projectId, email };
  })().finally(() => inflight.delete(keyRecord.id));

  inflight.set(keyRecord.id, job);
  return job;
}

/** Credencial pronta para uma requisição. É isto que o pipeline recebe no lugar da chave. */
export async function credentialFor(store, provider, keyRecord) {
  const stored = store.credentialOf(provider, keyRecord);
  if (!stored?.refreshToken) throw new LocalError('A conta {0} não tem refresh token. Conecte a conta de novo.', keyRecord.label);
  return refreshCredential(store, provider, keyRecord, stored);
}

/**
 * Recusas do Cloud Code que a pessoa resolve fora do Rotaz, com a orientação do que fazer. Devolve o status do teste
 * e a mensagem, ou null quando o erro não é um desses.
 */
export function explainError(status, message) {
  // O Google trava a conta até ela passar por uma verificação feita no app oficial.
  if (/verify your account/i.test(message)) {
    return { status: 'verify_account', message: new LocalError('O Google pediu para verificar esta conta ("{0}"). Abra o Antigravity oficial com o mesmo e-mail, conclua a verificação que ele mostrar e teste de novo aqui. Enquanto isso, as outras contas conectadas continuam atendendo.', message) };
  }
  // Modelo que a conta não tem no plano: o endereço está certo, o modelo é que não está liberado.
  if (status === 404) {
    return { status: 'model_not_found', message: new LocalError('Este modelo não está liberado no plano desta conta Google. Use outro modelo da lista ou uma conta com o plano que inclui este.') };
  }
  return null;
}

/** A chamada ao Cloud Code para um pedido já no formato Gemini: endereço fixo, cabeçalhos da IDE e envelope da conta. */
export function cloudCodeCall(cred, model, request) {
  if (!cred?.token) throw new LocalError('Credencial Antigravity sem token de acesso.');
  return {
    url: STREAM_URL,
    headers: { authorization: `Bearer ${cred.token}`, 'user-agent': UA },
    payload: envelope({ projectId: cred.projectId, model, request, sessionId: sessionIdFor(cred.email ?? cred.projectId) }),
  };
}

// ---------- sessão e envelope ----------

const FNV_OFFSET = -3750763034362895579n;
const FNV_PRIME = 1099511628211n;

/** sessionId estável por conta: a mesma conta se apresenta como o mesmo dispositivo. */
export function sessionIdFor(accountKey) {
  if (!accountKey) return `-${BigInt(crypto.randomBytes(8).readBigUInt64BE() % 9000000000000000000n).toString()}`;
  let h = FNV_OFFSET;
  for (const byte of Buffer.from(String(accountKey), 'utf8')) {
    h = BigInt.asIntN(64, h ^ BigInt(byte));
    h = BigInt.asIntN(64, h * FNV_PRIME);
  }
  return h.toString();
}

function requestId() {
  return `agent/${crypto.randomUUID()}/${Date.now()}/${crypto.randomUUID()}/2`;
}

/**
 * Envelope do Cloud Code. O corpo do cliente nunca chega cru aqui: `request` já é o formato Gemini.
 */
export function envelope({ projectId, model, request, sessionId }) {
  return {
    project: projectId,
    requestId: requestId(),
    model,
    userAgent: 'antigravity',
    requestType: 'agent',
    request: { ...request, sessionId },
    // Sem `labels`: o backend recusa o campo ("Unknown name labels: Cannot find field", HTTP 400).
  };
}

// ---------- catálogo ----------

/** Lista o que a conta realmente pode usar. Cai no catálogo local quando o endpoint não responde. */
const intOrNull = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

/**
 * Catálogo da conta, modelo a modelo: nome, contexto (`maxTokens`), limite de saída, cota restante
 * (0 a 1, com o horário em que renova) e se o Google marca o modelo como interno (autocompletar etc.).
 */
export async function fetchModelCatalog(cred) {
  for (const base of [RUNTIME_BASE, BOOTSTRAP_BASE]) {
    try {
      const data = await postJson(`${base}/v1internal:fetchAvailableModels`, cred.token, { project: cred.projectId || undefined }, 15000);
      const entries = Object.entries(data?.models ?? {});
      if (!entries.length) continue;
      const rows = {};
      for (const [id, m] of entries) {
        const q = m?.quotaInfo;
        const remaining = typeof q?.remainingFraction === 'number' ? Math.min(1, Math.max(0, q.remainingFraction)) : null;
        rows[id] = {
          name: typeof m?.displayName === 'string' ? m.displayName.slice(0, 80) : null,
          context: intOrNull(m?.maxTokens),
          maxOutput: intOrNull(m?.maxOutputTokens),
          remaining,
          resetAt: typeof q?.resetTime === 'string' && !Number.isNaN(Date.parse(q.resetTime)) ? Date.parse(q.resetTime) : null,
          // Modelos de autocompletar do editor (tab_*) e os chat_* internos não servem para conversa.
          internal: m?.isInternal === true || /^tab_/.test(id),
        };
      }
      return rows;
    } catch { /* tenta o próximo host */ }
  }
  return {};
}

