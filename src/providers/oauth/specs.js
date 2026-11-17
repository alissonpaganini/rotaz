// Fichas dos provedores com conta (OAuth). Cada uma diz como entrar, como renovar o token, para onde mandar
// os pedidos e com quais cabeçalhos. O motor (engine.js) faz o resto igual para todos.
//
// Portado do OmniRoute (github.com/cheaper-inference/OmniRoute, licença MIT). Os IDs de cliente são os
// públicos dos apps e CLIs oficiais; vários desses provedores se apresentam como o app oficial, e os termos
// de uso de alguns não permitem esse uso (ver o aviso de cada ficha em `risk`).
import crypto from 'node:crypto';
import os from 'node:os';

// ---------- utilidades ----------

/** Lê e-mail e nome de um id_token (JWT) sem validar a assinatura: só para mostrar a conta no painel. */
export function jwtIdentity(token) {
  const part = typeof token === 'string' ? token.split('.')[1] : null;
  if (!part) return {};
  try {
    const p = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return { email: p.email || p.preferred_username || null, name: p.name || null };
  } catch { return {}; }
}

/** Refresh OAuth padrão (RFC 6749 §6): formulário com client_id e refresh_token. */
const standardRefresh = (tokenUrl, clientId, extraHeaders) => async (cred, http) => {
  const r = await http(tokenUrl, { method: 'POST', headers: { accept: 'application/json', ...(extraHeaders?.(cred) ?? {}) },
    form: { grant_type: 'refresh_token', refresh_token: cred.refreshToken, client_id: clientId } });
  if (r.status !== 200 || !r.json?.access_token) return { error: r.json?.error || `HTTP ${r.status}`, fatal: ['invalid_grant', 'invalid_request'].includes(r.json?.error) };
  return { accessToken: r.json.access_token, refreshToken: r.json.refresh_token || cred.refreshToken, expiresIn: r.json.expires_in };
};

/**
 * Motivo legível de uma recusa do provedor: só os campos de erro (código e descrição), nunca o corpo inteiro,
 * que numa resposta de token poderia ter credenciais.
 */
export function reasonOf(r) {
  const j = r?.json;
  if (!j || typeof j !== 'object') return '';
  const e = j.error;
  const parts = [typeof e === 'string' ? e : e?.code ?? e?.type, j.error_description ?? (typeof e === 'object' ? e?.message : null) ?? j.message ?? j.detail]
    .filter((x) => typeof x === 'string' && x.trim()).map((x) => x.replace(/\s+/g, ' ').trim());
  return [...new Set(parts)].join(': ').slice(0, 200);
}
const withReason = (msg, r) => { const why = reasonOf(r); return why ? `${msg} Motivo: ${why}` : msg; };

const bearer = (c) => ({ authorization: `Bearer ${c.accessToken}` });

// ---------- GitHub Copilot ----------
// Igual à CLI oficial do Copilot (@github/copilot): o token do GitHub vira um token curto do Copilot, e cada
// pedido leva a "impressão digital" da CLI. Modelos Claude vão pelo /v1/messages (formato Anthropic).
const COPILOT_VERSION = '1.0.91';
const machineIds = new Map();
const copilotMachineId = (cred) => {
  if (cred.extra?.machineId) return cred.extra.machineId;
  const key = cred.refreshToken || cred.accessToken || '';
  if (!machineIds.has(key)) machineIds.set(key, crypto.randomUUID());
  return machineIds.get(key);
};
const copilotHeaders = (cred) => ({
  authorization: `Bearer ${cred.extra?.copilotToken}`,
  'copilot-integration-id': 'copilot-developer-cli',
  'editor-version': `copilot/${COPILOT_VERSION}`,
  'user-agent': `copilot/${COPILOT_VERSION} (${process.platform}) term/unknown`,
  'openai-intent': 'conversation-agent',
  'x-interaction-type': 'conversation-user',
  'copilot-harness-id': 'copilot-sdk',
  'x-github-api-version': '2026-08-01',
  'x-client-machine-id': copilotMachineId(cred),
  'x-initiator': 'user',
  'x-interaction-id': crypto.randomUUID(),
});
/** Garante um token do Copilot válido. `apiBase`: api.github.com ou <ghe>/api/v3. */
const copilotReady = (apiBase) => async (cred, http) => {
  const left = Number(cred.extra?.copilotExpiresAt || 0) * 1000 - Date.now();
  if (cred.extra?.copilotToken && left > 120000) return null;
  const base = typeof apiBase === 'function' ? apiBase(cred) : apiBase;
  const r = await http(`${base}/copilot_internal/v2/token`, { headers: {
    authorization: `token ${cred.accessToken}`, accept: 'application/json', 'user-agent': 'GithubCopilot/1.0',
    'editor-version': `copilot/${COPILOT_VERSION}`, 'editor-plugin-version': `copilot/${COPILOT_VERSION}` } });
  if (r.status !== 200 || !r.json?.token) {
    const e = new Error(r.status === 401 || r.status === 403 ? 'A conta do GitHub não tem acesso ao Copilot (ou o acesso foi revogado).' : `GitHub recusou o token do Copilot (HTTP ${r.status}).`);
    e.fatal = r.status === 401;
    throw e;
  }
  // Contas Business/Enterprise usam outro host de API: o próprio GitHub informa qual.
  // No Enterprise o host é da empresa; vem do próprio servidor do GitHub e só vale se for https sem caminho.
  const api = typeof r.json.endpoints?.api === 'string' && /^https:\/\/[\w.-]+(:\d+)?\/?$/.test(r.json.endpoints.api) ? r.json.endpoints.api.replace(/\/$/, '') : 'https://api.githubcopilot.com';
  return { extra: { copilotToken: r.json.token, copilotExpiresAt: r.json.expires_at, copilotApi: api, machineId: copilotMachineId(cred) } };
};
const copilotApi = (cred) => cred.extra?.copilotApi || 'https://api.githubcopilot.com';
const copilotRoute = (model, cred) => (/^claude/i.test(model)
  ? { format: 'anthropic', url: `${copilotApi(cred)}/v1/messages`, headers: { 'anthropic-version': '2023-06-01' } }
  : { format: 'openai', url: `${copilotApi(cred)}/chat/completions` });

// ---------- Kimi Code ----------
const KIMI_CLI_VERSION = '2.1.1';
const kimiIdentity = (cred) => {
  const x = cred.extra ?? {};
  const clean = (v) => String(v ?? 'unknown').replace(/[^\x20-\x7e]/g, '').trim() || 'unknown';
  return {
    'x-msh-platform': 'kimi_code_cli', 'x-msh-version': KIMI_CLI_VERSION,
    'x-msh-device-name': clean(x.deviceName), 'x-msh-device-model': clean(x.deviceModel),
    'x-msh-os-version': clean(x.osVersion), 'x-msh-device-id': clean(x.deviceId),
  };
};
const kimiDevice = () => ({ deviceId: crypto.randomUUID(), deviceName: os.hostname(), deviceModel: `${os.type()} ${os.arch()}`, osVersion: os.release() });

// Versão informada ao Cline nos cabeçalhos do protocolo (o OmniRoute manda a dele, 3.8.x).
const CLINE_CLIENT_VERSION = '3.8.54';
// Lista pública do seletor do Cline: { recommended, free, clinePass }.
const CLINE_RECOMMENDED_URL = 'https://api.cline.bot/api/v1/ai/cline/recommended-models';

// ---------- fichas ----------
export const SPECS = {
  openference: {
    name: 'Openference', site: 'https://openference.com', format: 'openai',
    chatUrl: 'https://api.openference.com/v1/chat/completions', modelsUrl: 'https://api.openference.com/v1/models',
    note: 'Conta Openference; o plano grátis inclui Qwen3.8 27B e Llama 3.2 3B.',
    risk: 'Usa o cliente OAuth que o Openference registrou para o OmniRoute.',
    login: { type: 'pkce', clientId: 'omniroute', authorizeUrl: 'https://openference.com/app/oauth/authorize', tokenUrl: 'https://openference.com/oauth/token',
      scope: 'openid profile email model:invoke offline_access', port: 56123, path: '/callback', userinfoUrl: 'https://openference.com/oauth/userinfo' },
    refresh: standardRefresh('https://openference.com/oauth/token', 'omniroute'),
    headers: bearer,
  },

  'xai-oauth': {
    name: 'xAI (Grok)', site: 'https://x.ai', format: 'openai',
    chatUrl: 'https://api.x.ai/v1/chat/completions', modelsUrl: 'https://api.x.ai/v1/models',
    note: 'Conta xAI para a API oficial (api.x.ai), como o Grok 4.5.',
    risk: 'Usa o cliente OAuth da CLI do Grok; a xAI pode restringir esse uso.',
    login: { type: 'pkce', clientId: 'b1a00492-073a-47ea-816f-4c329264a828', authorizeUrl: 'https://auth.x.ai/oauth2/authorize', tokenUrl: 'https://auth.x.ai/oauth2/token',
      scope: 'openid profile email offline_access grok-cli:access api:access', port: 56121, path: '/callback',
      extraParams: () => ({ nonce: crypto.randomBytes(16).toString('hex'), plan: 'generic', referrer: 'cli-proxy-api' }) },
    refresh: standardRefresh('https://auth.x.ai/oauth2/token', 'b1a00492-073a-47ea-816f-4c329264a828'),
    headers: bearer,
  },

  kilocode: {
    name: 'Kilo Code', site: 'https://kilo.ai', format: 'openai',
    chatUrl: 'https://api.kilo.ai/api/openrouter/chat/completions', modelsUrl: 'https://api.kilo.ai/api/openrouter/models',
    note: 'Conta Kilo Code (entrada por código). O token não expira.',
    risk: 'O OmniRoute marca risco de uso da assinatura por proxy.',
    login: {
      type: 'device-custom',
      async start(http) {
        const r = await http('https://api.kilo.ai/api/device-auth/codes', { method: 'POST', json: {} });
        if (r.status === 429) throw new Error('Muitos pedidos de login pendentes. Tente de novo em alguns minutos.');
        if (r.status !== 200 && r.status !== 201) throw new Error(`O Kilo Code recusou o início do login (HTTP ${r.status}).`);
        return { deviceCode: r.json.code, userCode: r.json.code, url: r.json.verificationUrl, expiresIn: r.json.expiresIn || 300, interval: 3 };
      },
      async poll(dev, http) {
        const r = await http(`https://api.kilo.ai/api/device-auth/codes/${encodeURIComponent(dev.deviceCode)}`);
        if (r.status === 202) return { pending: true };
        if (r.status === 403) return { error: 'O login foi recusado na tela do Kilo Code.' };
        if (r.status === 410) return { error: 'O código expirou. Comece o login de novo.' };
        if (r.status !== 200) return { error: `O Kilo Code respondeu HTTP ${r.status}.` };
        if (r.json?.status === 'approved' && r.json.token) return { tokens: { accessToken: r.json.token, email: r.json.userEmail ?? null } };
        return { pending: true };
      },
    },
    headers: bearer,
  },

  cline: {
    name: 'Cline', site: 'https://cline.bot', format: 'openai',
    chatUrl: 'https://api.cline.bot/api/v1/chat/completions',
    // O Cline só atende em streaming: sem ele devolve corpo vazio ("generateText is not implemented").
    forceStream: true,
    // Como o OmniRoute: o catálogo completo (só saída de texto, sem os cline-pass/*) mais a lista pública de
    // recomendados, cujo balde "free" traz os gratuitos de verdade (cline-free/*). As variantes ":free" do
    // catálogo completo passam pelo OpenRouter e costumam esbarrar em limite ou saldo.
    models: (c) => ({
      url: 'https://api.cline.bot/api/v1/ai/cline/models', headers: SPECS.cline.headers(c),
      filter: (x) => !String(x?.id ?? '').startsWith('cline-pass/') && (!x?.architecture?.modality || String(x.architecture.modality).toLowerCase().split('->')[1]?.trim() === 'text'),
      also: { url: CLINE_RECOMMENDED_URL, pick: (j) => ({ free: j?.free, other: j?.recommended }) },
    }),
    note: 'Conta Cline (os modelos do plano e os gratuitos do Cline).',
    risk: 'Usa o login da extensão do Cline; o OmniRoute marca risco de uso da assinatura por proxy.',
    login: { type: 'cline' },
    refresh: async (cred, http) => {
      const r = await http('https://api.cline.bot/api/v1/auth/refresh', { method: 'POST', json: { refreshToken: cred.refreshToken, grantType: 'refresh_token', clientType: 'extension' } });
      const d = r.json?.data ?? r.json;
      // Como o OmniRoute: só invalid_grant/invalid_request pedem novo login; o resto é passageiro.
      const code = typeof r.json?.error === 'string' ? r.json.error : r.json?.error?.code;
      if (r.status !== 200 || !d?.accessToken) return { error: code || `HTTP ${r.status}`, fatal: code === 'invalid_grant' || code === 'invalid_request' };
      return { accessToken: d.accessToken, refreshToken: d.refreshToken || cred.refreshToken, expiresAt: d.expiresAt ? Date.parse(d.expiresAt) : undefined };
    },
    // O token da conta vai com o prefixo "workos:" e o Cline exige os cabeçalhos do protocolo dele;
    // sem eles responde "Unauthorized: ... latest version of Cline".
    headers: (c) => ({
      authorization: `Bearer ${String(c.accessToken).startsWith('workos:') ? c.accessToken : `workos:${c.accessToken}`}`,
      'http-referer': 'https://cline.bot', 'x-title': 'Cline', 'user-agent': `Cline/${CLINE_CLIENT_VERSION}`,
      'x-is-multiroot': 'false', 'x-client-type': 'rotaz', 'x-client-version': CLINE_CLIENT_VERSION,
      'x-platform': process.platform, 'x-platform-version': process.version, 'x-core-version': CLINE_CLIENT_VERSION,
    }),
  },

  github: {
    name: 'GitHub Copilot', site: 'https://github.com/features/copilot', format: 'openai',
    chatUrl: 'https://api.githubcopilot.com/chat/completions',
    note: 'Assinatura do GitHub Copilot (entrada por código). Modelos Claude usam o formato Anthropic.',
    risk: 'Se apresenta como a CLI oficial do Copilot.',
    login: { type: 'device', clientId: 'Iv1.b507a08c87ecfe98', deviceCodeUrl: 'https://github.com/login/device/code', tokenUrl: 'https://github.com/login/oauth/access_token', scope: 'read:user',
      async identity(tokens, http) { const r = await http('https://api.github.com/user', { headers: { authorization: `token ${tokens.accessToken}`, accept: 'application/json', 'user-agent': 'GithubCopilot/1.0' } }); return { email: r.json?.email || r.json?.login || null, name: r.json?.name || r.json?.login || null }; } },
    ready: copilotReady('https://api.github.com'),
    route: copilotRoute,
    models: (cred) => ({ url: `${copilotApi(cred)}/models`, headers: copilotHeaders(cred) }),
    headers: copilotHeaders,
  },

  'kimi-coding': {
    name: 'Kimi Code', site: 'https://www.kimi.com/code', format: 'anthropic',
    chatUrl: 'https://api.kimi.com/coding/v1/messages?beta=true', modelsUrl: 'https://api.kimi.com/coding/v1/models',
    note: 'Kimi Coding Plan pela conta Kimi (entrada por código). Fala o formato Anthropic.',
    risk: 'Se apresenta como a Kimi Code CLI.',
    login: { type: 'device', clientId: '17e5f671-d194-4dfb-9706-5516cb48c098', deviceCodeUrl: 'https://auth.kimi.com/api/oauth/device_authorization', tokenUrl: 'https://auth.kimi.com/api/oauth/token',
      device: kimiDevice, headers: (extra) => kimiIdentity({ extra }) },
    refresh: standardRefresh('https://auth.kimi.com/api/oauth/token', '17e5f671-d194-4dfb-9706-5516cb48c098', kimiIdentity),
    headers: (c) => ({ 'x-api-key': c.accessToken, 'anthropic-version': '2023-06-01', 'user-agent': `kimi-code-cli/${KIMI_CLI_VERSION}`, ...kimiIdentity(c) }),
  },
};
// ---------- DeepSeek (conta da plataforma) ----------
// Como o DeepSeek Harness (github.com/deepseek-ai/deepseek-harness, MIT): o login começa num pedido à plataforma
// (auth-api/v0/dsh/auth_init, com PKCE), a pessoa autoriza no navegador, o retorno chega numa porta local e
// auth_exchange devolve um token de conta. O token vai no cabeçalho x-dsh-auth-token para a API Messages da
// DeepSeek. Não é gratuito: cada pedido é cobrado do saldo da conta (recarga ou bônus promocional).
const DSH_VERSION = '0.2.2-rc.3';
const DSH_PLATFORM = 'https://platform.deepseek.com';
const DSH_AGENT = `deepseek-harness/${DSH_VERSION} (+https://github.com/deepseek-ai/deepseek-harness)`;
/** Os cinco cabeçalhos de cliente que a plataforma espera do DeepSeek Harness na versão web. */
const dshClient = () => ({ 'x-client-bundle-id': '', 'x-client-platform': 'web', 'x-client-version': DSH_VERSION, 'x-client-locale': 'en_US',
  'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60) });
/** Identificador estável desta máquina, como o do Harness (um UUID guardado por dispositivo). */
const dshDevice = (() => { const h = crypto.createHash('sha256').update(`rotaz-dsh:${os.hostname()}:${os.userInfo().username}`).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; })();
/** Pedido à plataforma: envelope { code: 0, data: { biz_code: 0, biz_data } }; qualquer outra coisa é recusa. */
async function dshCall(http, method, body) {
  const r = await http(`${DSH_PLATFORM}/auth-api/v0/dsh/${method}`, { method: 'POST', headers: dshClient(), json: body });
  const d = r.json?.data;
  if (r.status !== 200 || r.json?.code !== 0 || d?.biz_code !== 0) {
    throw new Error(withReason(`A DeepSeek recusou o login (${method}, HTTP ${r.status}${d?.biz_code ? `, código ${d.biz_code}` : ''}).`, r));
  }
  return d.biz_data;
}
SPECS.deepseek = {
  name: 'DeepSeek Platform', site: 'https://platform.deepseek.com', format: 'anthropic',
  chatUrl: 'https://api.deepseek.com/anthropic/v1/messages', modelsUrl: 'https://api.deepseek.com/models',
  catalog: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  note: 'Conta da plataforma da DeepSeek, como no DeepSeek Harness. Cada pedido é cobrado do saldo da conta (recarga ou bônus).',
  risk: 'Se apresenta como o DeepSeek Harness, o app oficial da DeepSeek.',
  login: {
    type: 'pkce', port: 3080, path: '/oauth/callback',
    authorize: async ({ redirectUri, state, challenge, http }) => {
      const d = await dshCall(http, 'auth_init', { code_challenge: challenge, code_challenge_method: 'S256', state, redirect_uri: redirectUri, locale: 'en_US', login_source: 'web' });
      // só abre no navegador uma página da própria plataforma
      if (typeof d?.authorize_url !== 'string' || !d.authorize_url.startsWith(`${DSH_PLATFORM}/`)) throw new Error('A DeepSeek devolveu um endereço de login inesperado.');
      return d.authorize_url;
    },
    exchange: async ({ code, redirectUri, verifier, http }) => {
      const d = await dshCall(http, 'auth_exchange', { code, code_verifier: verifier, redirect_uri: redirectUri,
        device_id: dshDevice, device_model: `${os.platform()}-${os.arch()}`, os_version: `${os.type()} ${os.release()}` });
      if (typeof d?.token !== 'string' || !d.token) throw new Error('A DeepSeek não devolveu o token da conta.');
      return { access_token: d.token, email: typeof d.user?.email === 'string' ? d.user.email : null, name: d.user?.id_profile?.name ?? null };
    },
  },
  headers: (c) => ({ 'x-dsh-auth-token': c.accessToken, 'anthropic-version': '2023-06-01', 'user-agent': DSH_AGENT }),
};

// ---------- Tencent: CodeBuddy CN, CodeBuddy Intl e WorkBuddy ----------
// Mesmo mecanismo nos três: o login pede um "state", a pessoa autoriza no site e o Rotaz consulta o token
// pelo state. Só aceitam pedidos em streaming (sem streaming voltam o erro 11101).
const buddyAuthHeaders = (ua, domain) => ({ 'user-agent': ua, 'x-requested-with': 'XMLHttpRequest', 'x-domain': domain, 'x-no-authorization': 'true', 'x-no-user-id': 'true', 'x-product': 'SaaS' });
const buddy = ({ name, site, base, domain, platform, ua, chatHeaders, note, catalog }) => ({
  name, site, format: 'openai', chatUrl: `${base}/v2/chat/completions`, forceStream: true, note, catalog,
  risk: 'Se apresenta como o app oficial da Tencent; o OmniRoute marca risco de uso da assinatura por proxy.',
  login: {
    type: 'device-custom',
    async start(http) {
      const r = await http(`${base}/v2/plugin/auth/state?platform=${encodeURIComponent(platform)}`, { method: 'POST', headers: buddyAuthHeaders(ua, domain), json: { platform } });
      if (r.json?.code !== 0 || !r.json.data?.state) throw new Error(`${name} recusou o início do login: ${r.json?.msg || `HTTP ${r.status}`}`);
      return { deviceCode: String(r.json.data.state), url: String(r.json.data.authUrl || r.json.data.url || ''), expiresIn: 600, interval: 5 };
    },
    async poll(dev, http) {
      const r = await http(`${base}/v2/plugin/auth/token?state=${encodeURIComponent(dev.deviceCode)}`, { headers: { ...buddyAuthHeaders(ua, domain), 'x-no-enterprise-id': 'true', 'x-no-department-info': 'true' } });
      if (r.json?.code === 0 && r.json.data?.accessToken) return { tokens: { accessToken: r.json.data.accessToken, refreshToken: r.json.data.refreshToken || null, expiresIn: r.json.data.expiresIn || 86400 } };
      return { pending: true };
    },
  },
  refresh: async (cred, http) => {
    const r = await http(`${base}/v2/plugin/auth/token/refresh`, { method: 'POST', json: {},
      headers: { 'user-agent': ua, 'x-requested-with': 'XMLHttpRequest', 'x-domain': domain, 'x-refresh-token': cred.refreshToken, 'x-auth-refresh-source': 'plugin', 'x-product': 'SaaS' } });
    if (r.json?.code !== 0 || !r.json.data?.accessToken) return { error: r.json?.msg || `HTTP ${r.status}`, fatal: r.status === 401 };
    return { accessToken: r.json.data.accessToken, refreshToken: r.json.data.refreshToken || cred.refreshToken, expiresIn: r.json.data.expiresIn || 86400 };
  },
  headers: (c) => ({ authorization: `Bearer ${c.accessToken}`, ...chatHeaders }),
});
const BUDDY_UA = '2.108.1';
SPECS['codebuddy-cn'] = buddy({ name: 'CodeBuddy CN', site: 'https://copilot.tencent.com', base: 'https://copilot.tencent.com', domain: 'copilot.tencent.com', platform: 'CLI',
  ua: `CLI/${BUDDY_UA} CodeBuddy/${BUDDY_UA}`, note: 'Tencent CodeBuddy (China): GLM, Kimi, MiniMax, DeepSeek e Hunyuan.',
  chatHeaders: { 'user-agent': `CLI/${BUDDY_UA} CodeBuddy/${BUDDY_UA}`, 'x-product': 'SaaS', 'x-ide-type': 'CLI', 'x-ide-name': 'CLI', 'x-requested-with': 'XMLHttpRequest', 'x-codebuddy-request': '1' },
  catalog: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4.1-flash', 'deepseek-v3-2-volc', 'minimax-m2.5', 'minimax-m2.7', 'minimax-m3-pay', 'glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.2', 'glm-5.1', 'glm-5.0', 'glm-5.0-turbo', 'glm-5v-turbo', 'glm-4.7', 'glm-4.6', 'glm-4.6v', 'kimi-k3-2', 'kimi-k2.8-preview', 'kimi-k2.7', 'kimi-k2.6', 'kimi-k2.5', 'kimi-k2-thinking', 'hy3', 'hy3-x', 'hy4-preview', 'hy4-preview-x', 'hunyuan-chat'] });
SPECS['codebuddy-intl'] = buddy({ name: 'CodeBuddy Intl', site: 'https://www.codebuddy.ai', base: 'https://www.codebuddy.ai', domain: 'www.codebuddy.ai', platform: 'ide',
  ua: `IDE/${BUDDY_UA} CodeBuddy/${BUDDY_UA}`, note: 'CodeBuddy internacional (codebuddy.ai): GPT, Gemini, GLM, Kimi, MiniMax e Hunyuan.',
  chatHeaders: { 'user-agent': `IDE/${BUDDY_UA} CodeBuddy/${BUDDY_UA}`, 'x-product': 'SaaS', 'x-ide-type': 'IDE', 'x-ide-name': 'IDE', 'x-requested-with': 'XMLHttpRequest', 'x-codebuddy-request': '1' },
  catalog: ['hy4-preview', 'hy3', 'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4', 'gpt-5.3-codex', 'gemini-3.5-flash', 'glm-5v-turbo', 'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'minimax-m3', 'kimi-k3', 'kimi-k2.7', 'kimi-k2.6', 'deepseek-v4.1-flash'] });
const WB = '5.5.6';
SPECS.workbuddy = buddy({ name: 'WorkBuddy', site: 'https://www.workbuddy.ai', base: 'https://www.workbuddy.ai', domain: 'www.workbuddy.ai', platform: 'CLI',
  ua: `WorkBuddy/${WB}`, note: 'Tencent WorkBuddy. A lista de modelos não é pública: adicione o modelo pelo identificador.',
  chatHeaders: { 'user-agent': `WorkBuddy/${WB}`, 'x-product': 'SaaS', 'x-ide-type': 'WorkBuddy', 'x-ide-name': 'WorkBuddy', 'x-ide-version': WB, 'x-requested-with': 'XMLHttpRequest', 'x-domain': 'www.workbuddy.ai', 'x-agent-intent': 'craft', 'x-agent-purpose': 'conversation', 'x-agent-type': 'main' } });

// ---------- Freebuff (plano gratuito do Codebuff) ----------
// Antes de cada pedido abre uma "sessão" e uma "execução de agente", como a CLI faz; o token não renova.
const FREEBUFF_AGENTS = {
  'deepseek/deepseek-v4-flash': 'base2-free-deepseek-flash', 'deepseek/deepseek-v4-pro': 'base2-free-deepseek', 'openai/gpt-5.6-luna': 'base2-free-luna',
  'minimax/minimax-m3': 'base2-free-minimax-m3', 'mimo/mimo-v2.5': 'base2-free-mimo', 'z-ai/glm-5.2': 'base2-free-glm', 'crof/kimi-k3-eco': 'base2-free-kimi-k3-eco',
  'anthropic/claude-fable-5': 'base2-free-fable', 'meta/muse-spark-1.2-contributor': 'base2-free-muse-spark',
};
SPECS.freebuff = {
  name: 'Freebuff', site: 'https://freebuff.com', format: 'openai', chatUrl: 'https://www.codebuff.com/api/v1/chat/completions', catalog: Object.keys(FREEBUFF_AGENTS),
  note: 'Plano gratuito do Codebuff. O acesso não renova: quando vencer, conecte a conta de novo.',
  risk: 'Se apresenta como a CLI do Codebuff; o OmniRoute marca risco de uso da assinatura por proxy.',
  login: {
    type: 'device-custom',
    async start(http) {
      const fingerprintId = `codebuff-cli-${crypto.randomBytes(6).toString('base64url').slice(0, 8)}`;
      const r = await http('https://freebuff.com/api/auth/cli/code', { method: 'POST', json: { fingerprintId } });
      if (r.status !== 200 || typeof r.json?.loginUrl !== 'string' || typeof r.json?.fingerprintHash !== 'string') throw new Error(`O Freebuff recusou o início do login (HTTP ${r.status}).`);
      const expiresAt = String(r.json.expiresAt ?? '');
      const ms = /^\d+$/.test(expiresAt) ? Number(expiresAt) : Date.parse(expiresAt);
      return { deviceCode: JSON.stringify({ fingerprintId, fingerprintHash: r.json.fingerprintHash, expiresAt }), url: r.json.loginUrl, expiresIn: Number.isFinite(ms) ? Math.max(60, Math.round((ms - Date.now()) / 1000)) : 300, interval: 5 };
    },
    async poll(dev, http) {
      const q = JSON.parse(dev.deviceCode);
      const r = await http(`https://freebuff.com/api/auth/cli/status?${new URLSearchParams(q)}`);
      const u = r.json?.user;
      if (u?.authToken) return { tokens: { accessToken: u.authToken, email: u.email ?? null, name: u.name ?? null } };
      return { pending: true };
    },
  },
  headers: (c) => ({ authorization: `Bearer ${c.accessToken}`, 'user-agent': 'ai-sdk/openai-compatible/1.0.25/codebuff', accept: 'application/json, text/event-stream' }),
  /** Sessão e execução de agente antes do pedido; o corpo ganha o prompt do "Buffy" e os metadados do Codebuff. */
  async beforeRequest({ cred, model, payload, http }) {
    const auth = { authorization: `Bearer ${cred.accessToken}`, 'user-agent': 'codebuff/0.1.0 (darwin-arm64)' };
    const agentId = FREEBUFF_AGENTS[model] || 'base2-free';
    const s = await http('https://www.codebuff.com/api/v1/freebuff/session', { method: 'POST', headers: { ...auth, 'x-freebuff-model': model }, json: {} });
    if (s.status !== 200) { const e = new Error(`O Freebuff recusou abrir a sessão (HTTP ${s.status}).`); e.status = s.status; throw e; }
    const run = await http('https://www.codebuff.com/api/v1/agent-runs', { method: 'POST', headers: auth, json: { action: 'START', agentId } }).catch(() => null);
    const runId = run?.json?.runId || '';
    const messages = Array.isArray(payload.messages) ? [...payload.messages] : [];
    if (!(messages[0]?.role === 'system' && typeof messages[0].content === 'string' && messages[0].content.startsWith('You are Buffy'))) messages.unshift({ role: 'system', content: 'You are Buffy, the strategic coding assistant.' });
    const clientId = Array.from({ length: 13 }, () => '0123456789abcdefghijklmnopqrstuvwxyz'[crypto.randomInt(36)]).join('');
    return {
      payload: { ...payload, messages, codebuff_metadata: { run_id: runId, cost_mode: 'free', client_id: clientId, freebuff_instance_id: s.json?.instanceId || '' } },
      headers: { 'x-freebuff-instance-id': s.json?.instanceId || '', 'x-codebuff-agent-id': agentId, ...(runId && { 'x-codebuff-run-id': runId }) },
    };
  },
};

// ---------- GitHub Enterprise Copilot ----------
// Igual ao GitHub Copilot, no servidor da empresa (endereço informado ao adicionar o provedor).
SPECS['ghe-copilot'] = {
  ...SPECS.github, name: 'GitHub Enterprise Copilot', site: 'https://docs.github.com/enterprise-server', needsHost: true,
  note: 'Copilot da empresa no GitHub Enterprise. Informe o endereço do seu GitHub Enterprise (ex.: https://github.empresa.com).',
  login: {
    type: 'device-custom',
    async start(http, provider) {
      const host = provider.accountHost;
      const r = await http(`${host}/login/device/code`, { method: 'POST', form: { client_id: 'Iv1.b507a08c87ecfe98', scope: 'read:user' } });
      if (r.status !== 200 || !r.json?.device_code) throw new Error(`O GitHub Enterprise recusou o início do login (HTTP ${r.status}).`);
      return { deviceCode: r.json.device_code, userCode: r.json.user_code, url: r.json.verification_uri, expiresIn: r.json.expires_in, interval: r.json.interval, host };
    },
    async poll(dev, http) {
      const r = await http(`${dev.host}/login/oauth/access_token`, { method: 'POST', form: { client_id: 'Iv1.b507a08c87ecfe98', device_code: dev.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' } });
      const j = r.json ?? {};
      if (j.access_token) {
        const u = await http(`${dev.host}/api/v3/user`, { headers: { authorization: `token ${j.access_token}`, 'user-agent': 'GithubCopilot/1.0' } }).catch(() => null);
        return { tokens: { accessToken: j.access_token, email: u?.json?.email || u?.json?.login || null, name: u?.json?.name || null }, extra: { gheUrl: dev.host } };
      }
      if (j.error === 'authorization_pending') return { pending: true };
      if (j.error === 'slow_down') return { pending: true, slowDown: true };
      return { error: j.error_description || j.error || `HTTP ${r.status}` };
    },
  },
  ready: copilotReady((cred) => `${cred.extra.gheUrl}/api/v3`),
};

// ClinePass: mesmo login e endpoint do Cline; a assinatura libera os modelos cline-pass/*.
SPECS.clinepass = { ...SPECS.cline, name: 'ClinePass', site: 'https://cline.bot/cline-pass',
  // Só o balde da assinatura (cline-pass/*) da lista pública.
  models: () => ({ url: CLINE_RECOMMENDED_URL, headers: { accept: 'application/json' }, pick: (j) => (Array.isArray(j?.clinePass) ? j.clinePass : []).filter((x) => String(x?.id ?? '').startsWith('cline-pass/')) }),
  note: 'Assinatura ClinePass (US$ 9,99/mês, 10 modelos abertos), pela conta Cline.' };

// ---------- API Responses (OpenAI): Codex, ChatGPT, Muse Code e Grok Build ----------
// O pedido sai traduzido por translate/anthropic-to-responses.js; `body` faz o acabamento que cada um exige.

/** "gpt-5.5-high" -> modelo "gpt-5.5" com esforço "high". */
const EFFORT_SUFFIX = /^(.+)-(none|minimal|low|medium|high|xhigh)$/;
const splitEffort = (model) => { const m = EFFORT_SUFFIX.exec(model); return m ? { model: m[1], effort: m[2] } : { model, effort: null }; };
const pick = (obj, keys) => Object.fromEntries(Object.entries(obj).filter(([k]) => keys.has(k)));
const jwtClaims = (token) => {
  const part = typeof token === 'string' ? token.split('.')[1] : null;
  if (!part) return {};
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { return {}; }
};

// Codex CLI: assinatura do ChatGPT pelo backend do Codex (chatgpt.com/backend-api/codex).
const CODEX_CLIENT = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_VERSION = '0.165.0';
const codexAccount = (t) => {
  for (const tok of [t.id_token ?? t.idToken, t.access_token ?? t.accessToken]) {
    const id = jwtClaims(tok)['https://api.openai.com/auth']?.chatgpt_account_id;
    if (id) return String(id);
  }
  return null;
};
const CODEX_FIELDS = new Set(['model', 'input', 'instructions', 'tools', 'tool_choice', 'stream', 'store', 'reasoning', 'include', 'parallel_tool_calls', 'text', 'prompt_cache_key', 'service_tier']);
SPECS.codex = {
  name: 'OpenAI Codex', site: 'https://chatgpt.com/codex', format: 'responses', chatUrl: 'https://chatgpt.com/backend-api/codex/responses',
  catalog: ['gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-astra'],
  note: 'Assinatura do ChatGPT (Plus, Pro, Business) pelo login do Codex. Esforço de raciocínio pelo sufixo: gpt-5.5-high, -low, -xhigh.',
  risk: 'Se apresenta como o Codex CLI oficial; a OpenAI pode restringir esse uso.',
  login: { type: 'pkce', clientId: CODEX_CLIENT, authorizeUrl: 'https://auth.openai.com/oauth/authorize', tokenUrl: 'https://auth.openai.com/oauth/token',
    scope: 'openid profile email offline_access', port: 1455, path: '/auth/callback',
    extraParams: () => ({ id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'codex_cli_rs', prompt: 'login' }),
    extra: (t) => ({ accountId: codexAccount(t) }) },
  refresh: async (cred, http) => {
    const r = await http('https://auth.openai.com/oauth/token', { method: 'POST', form: { grant_type: 'refresh_token', refresh_token: cred.refreshToken, client_id: CODEX_CLIENT, scope: 'openid profile email' } });
    if (r.status !== 200 || !r.json?.access_token) return { error: r.json?.error?.message || r.json?.error || `HTTP ${r.status}`, fatal: ['invalid_grant', 'refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated'].includes(r.json?.error?.code ?? r.json?.error) };
    const accountId = codexAccount(r.json);
    return { accessToken: r.json.access_token, refreshToken: r.json.refresh_token || cred.refreshToken, expiresIn: r.json.expires_in, ...(accountId && { extra: { accountId } }) };
  },
  headers: (c) => ({
    authorization: `Bearer ${c.accessToken}`, accept: 'text/event-stream', version: CODEX_VERSION, originator: 'codex_cli_rs',
    'user-agent': `codex_cli_rs/${CODEX_VERSION} (Windows 10.0.26200; x86_64) unknown`, session_id: crypto.randomUUID(),
    ...(c.extra?.accountId && { 'chatgpt-account-id': c.extra.accountId }),
  }),
  body(payload) {
    const { model, effort } = splitEffort(payload.model);
    const out = pick(payload, CODEX_FIELDS);
    return { ...out, model, instructions: out.instructions || 'You are a ChatGPT agent.', store: false, stream: true,
      include: ['reasoning.encrypted_content'], reasoning: { effort: effort ?? payload.reasoning?.effort ?? 'medium', summary: 'auto' } };
  },
};

// Sign in with ChatGPT: a API oficial (api.openai.com/v1/responses) cobrando do plano do ChatGPT. O cliente é
// registrado na hora pela OpenAI (client_id oaiapp_* volta no retorno do login) e guardado com a conta.
const SIWC_RESOURCE = 'https://api.openai.com/v1';
const SIWC_PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const siwcHostId = `urn:uuid:${(() => { const h = crypto.createHash('sha256').update(`rotaz-siwc:${os.hostname()}:${os.userInfo().username}`).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; })()}`;
const SIWC_OMIT = ['background', 'conversation', 'max_output_tokens', 'max_tokens', 'max_completion_tokens', 'max_tool_calls', 'metadata', 'moderation', 'prompt', 'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id'];
SPECS.chatgpt = {
  name: 'ChatGPT', site: 'https://chatgpt.com', format: 'responses', chatUrl: 'https://api.openai.com/v1/responses', modelsUrl: 'https://api.openai.com/v1/models',
  note: 'Entrar com o ChatGPT: a API oficial da OpenAI cobrando do seu plano. Na tela de login, permita o uso do plano.',
  risk: 'Usa o registro de agentes da OpenAI (Sign in with ChatGPT) em nome do Rotaz; o uso conta no limite do seu plano.',
  login: {
    type: 'pkce', clientId: 'dynamic_agent_client', authorizeUrl: 'https://auth.openai.com/api/accounts/authorize', tokenUrl: 'https://auth.openai.com/api/accounts/oauth/token',
    scope: `openid profile email offline_access resource.invoke ${SIWC_PLAN_SCOPE}`, port: 1455, path: '/auth/callback', // o registro dinâmico só aceita a porta do Codex
    makeState: (callbackBase) => {
      let origin = 'http://127.0.0.1';
      try { origin = new URL(callbackBase).origin; } catch { /* sem painel: retorno local */ }
      return `siwc.${Buffer.from(origin).toString('base64url')}.${crypto.randomBytes(32).toString('base64url')}`;
    },
    // agent_name_hint só no primeiro registro (client_id dynamic_agent_client); depois vai o client_id emitido.
    extraParams: ({ clientId }) => ({ ...(clientId === 'dynamic_agent_client' && { agent_name_hint: 'Rotaz' }), ext_agent_host_id: siwcHostId, resource: SIWC_RESOURCE, nonce: crypto.randomBytes(32).toString('base64url') }),
    async exchange({ query, code, redirectUri, verifier, clientId: attemptClient, http }) {
      const issued = attemptClient !== 'dynamic_agent_client' ? attemptClient : null;
      const returned = query.get('client_id');
      if (issued && returned && returned !== issued) throw new Error('O ChatGPT devolveu outro registro do aplicativo. Comece o login de novo.');
      const clientId = issued || returned;
      if (!clientId || !/^oaiapp_[\w-]+$/.test(clientId)) throw new Error('O ChatGPT não devolveu o registro do aplicativo. Comece o login de novo.');
      const r = await http('https://auth.openai.com/api/accounts/oauth/token', { method: 'POST', form: { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: SIWC_RESOURCE } });
      // Documentado pela OpenAI: invalid_grant na troca -> descartar o código e autorizar de novo com o client_id emitido.
      if (r.json?.error === 'invalid_grant' || r.json?.error?.code === 'invalid_grant') return { restartWith: clientId, message: withReason(`O ChatGPT recusou a troca do código (HTTP ${r.status}).`, r) };
      if (r.status !== 200 || !r.json?.access_token) throw new Error(withReason(`O ChatGPT recusou a troca do código (HTTP ${r.status}).`, r));
      if (!String(r.json.scope ?? '').split(/\s+/).includes(SIWC_PLAN_SCOPE)) throw new Error('O uso do plano do ChatGPT não foi permitido. Comece o login de novo e permita o uso do plano.');
      return r.json;
    },
    extra: (t, q, clientId) => ({ clientId: clientId !== 'dynamic_agent_client' ? clientId : q.get('client_id') }),
  },
  refresh: async (cred, http) => {
    const r = await http('https://auth.openai.com/api/accounts/oauth/token', { method: 'POST', form: { grant_type: 'refresh_token', refresh_token: cred.refreshToken, client_id: cred.extra?.clientId ?? '', resource: SIWC_RESOURCE } });
    const code = typeof r.json?.error === 'string' ? r.json.error : r.json?.error?.code;
    if (r.status !== 200 || !r.json?.access_token) return { error: code || `HTTP ${r.status}`, fatal: ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused', 'invalid_client'].includes(code) };
    return { accessToken: r.json.access_token, refreshToken: r.json.refresh_token || cred.refreshToken, expiresIn: r.json.expires_in };
  },
  headers: (c) => ({ authorization: `Bearer ${c.accessToken}`, accept: 'text/event-stream', 'user-agent': 'Rotaz' }),
  body(payload) {
    const { model, effort } = splitEffort(payload.model);
    const out = { ...payload, model, store: false, stream: true };
    for (const k of SIWC_OMIT) delete out[k];
    if (effort) out.reasoning = { ...out.reasoning, effort, summary: 'auto' };
    // Ferramentas do cliente vão como um item "additional_tools" no começo do input, como o SDK oficial faz.
    if (Array.isArray(out.tools)) {
      const own = out.tools.filter((t) => t.type === 'function' || t.type === 'custom');
      out.tools = out.tools.filter((t) => t.type !== 'function' && t.type !== 'custom');
      if (!out.tools.length) delete out.tools;
      if (own.length) out.input = [{ type: 'additional_tools', tools: own }, ...(out.input ?? [])];
    }
    return out;
  },
};

// Muse Code (Meta): login por código em auth.meta.com; o token do dispositivo (dca:) é trocado por uma chave
// de API própria do Muse Code, que é a que vai nos pedidos. Sem a chave (ou depois de um 401), ela é refeita.
const MUSE_AUTH_UA = 'muse-code/1.0.2';
const MUSE_CLIENT = '1031625952748946';
const museUA = () => {
  const osName = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform;
  const cpu = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch;
  return `muse-build/1.4.14 (non-interactive; ${osName}-${cpu}; build dec7d7497fecdad135ec5835a8161dbc92e55b58)`;
};
const uuidV7 = () => {
  const b = crypto.randomBytes(16);
  b.writeUIntBE(Date.now(), 0, 6);
  b[6] = (b[6] & 0x0f) | 0x70; b[8] = (b[8] & 0x3f) | 0x80;
  const x = b.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
};
async function museMint(dca, http) {
  const r = await http('https://api.meta.ai/muse-code/key', { method: 'POST', headers: { authorization: `Bearer ${dca}`, 'user-agent': MUSE_AUTH_UA }, json: { dca_token: dca } });
  const key = String(r.json?.api_key ?? r.json?.apiKey ?? '').trim();
  if (r.status !== 200 || !key) { const e = new Error(withReason(`O Muse Code não entregou a chave de acesso (HTTP ${r.status}).`, r)); e.status = r.status; throw e; }
  const base = String(r.json.base_url ?? r.json.baseUrl ?? '').replace(/\/+$/, '');
  return { apiKey: key, baseUrl: /^https:\/\/[\w.-]+\.meta\.ai(\/[\w./-]*)?$/.test(base) ? base : 'https://api.meta.ai/v1',
    email: r.json.user_email ?? r.json.email ?? null, name: r.json.user_full_name ?? r.json.name ?? null };
}
const museBase = (c) => c.extra?.baseUrl || 'https://api.meta.ai/v1';
SPECS['muse-code'] = {
  name: 'Muse Code', site: 'https://www.meta.ai', format: 'responses', chatUrl: 'https://api.meta.ai/v1/responses',
  note: 'Muse Code da Meta pela conta Meta (entrada por código).',
  risk: 'Se apresenta como o cliente oficial do Muse Code; a Meta pode restringir esse uso.',
  login: {
    type: 'device-custom',
    async start(http) {
      const r = await http('https://auth.meta.com/oidc/device/authorization/', { method: 'POST', headers: { 'user-agent': MUSE_AUTH_UA }, form: { client_id: MUSE_CLIENT } });
      const j = r.json ?? {};
      const deviceCode = j.device_code ?? j.deviceCode;
      if (r.status !== 200 || !deviceCode) throw new Error(`A Meta recusou o início do login (HTTP ${r.status}).`);
      return { deviceCode, userCode: j.user_code ?? j.userCode, url: j.verification_uri ?? j.verificationUri, urlComplete: j.verification_uri_complete ?? j.verificationUriComplete,
        expiresIn: j.expires_in ?? j.expiresIn ?? 900, interval: j.interval ?? 5 };
    },
    async poll(dev, http) {
      const r = await http('https://auth.meta.com/oidc/device/token/', { method: 'POST', headers: { 'user-agent': MUSE_AUTH_UA },
        form: { client_id: MUSE_CLIENT, device_code: dev.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' } });
      const j = r.json ?? {};
      const dca = String(j.access_token ?? j.accessToken ?? '').trim();
      if (dca) {
        // Sem expiresIn: a chave cunhada não vence; um 401 faz o Rotaz cunhar outra com o mesmo token.
        // Se a Meta não cunhar a chave, a conta fica salva e os pedidos usam o próprio token do dispositivo,
        // como o OmniRoute faz; o motivo da recusa fica guardado para aparecer no painel e no teste.
        const k = await museMint(dca, http).catch((e) => ({ failed: e.message }));
        if (k.failed) return { tokens: { accessToken: dca }, extra: { mintError: k.failed, mintTriedAt: Date.now() } };
        return { tokens: { accessToken: dca, email: k.email, name: k.name }, extra: { apiKey: k.apiKey, baseUrl: k.baseUrl, mintError: null } };
      }
      const err = j.error ?? j.error_code;
      if (err === 'authorization_pending' || r.status === 428) return { pending: true };
      if (err === 'slow_down') return { pending: true, slowDown: true };
      if (err === 'access_denied') return { error: 'O login foi recusado na tela da Meta.' };
      if (err === 'expired_token') return { error: 'O código expirou. Comece o login de novo.' };
      if (r.status >= 500 || r.status === 0) return { pending: true };
      return { error: `A Meta recusou o login (HTTP ${r.status}): ${j.error_description || err || ''}`.trim() };
    },
  },
  async ready(cred, http) {
    if (cred.extra?.apiKey) return null;
    // Uma tentativa a cada 10 minutos; no meio-tempo vai o token do dispositivo.
    if (Date.now() - Number(cred.extra?.mintTriedAt || 0) < 600000) return null;
    const k = await museMint(cred.accessToken, http).catch((e) => ({ failed: e.message }));
    if (k.failed) return { extra: { mintError: k.failed, mintTriedAt: Date.now() } };
    return { extra: { apiKey: k.apiKey, baseUrl: k.baseUrl, mintError: null, mintTriedAt: 0 } };
  },
  route: (model, c) => ({ format: 'responses', url: `${museBase(c)}/responses` }),
  models: (c) => ({ url: `${museBase(c)}/models`, headers: SPECS['muse-code'].headers(c) }),
  headers: (c) => {
    const s = uuidV7();
    return { authorization: `Bearer ${c.extra?.apiKey || c.accessToken}`, accept: 'text/event-stream', 'user-agent': museUA(), 'x-client-id': 'tbh:exec',
      'x-tbh-session-id': s, 'x-meta-ai-gateway-session-id': s, 'x-tbh-thread-id': s, 'x-tbh-root-session-id': s, 'x-tbh-agent-role': 'main',
      traceparent: `00-${crypto.randomBytes(16).toString('hex')}-${crypto.randomBytes(8).toString('hex')}-01` };
  },
  body: (payload) => ({ ...payload, prompt_cache_retention: '24h' }),
};

// Grok Build (xAI): a assinatura do Grok pelo proxy da CLI (cli-chat-proxy.grok.com), login por código.
const GROK_CLIENT = 'b1a00492-073a-47ea-816f-4c329264a828';
const GROK_VERSION = '1.0.41';
const GROK_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
SPECS['grok-cli'] = {
  name: 'Grok Build', site: 'https://x.ai', format: 'responses', chatUrl: 'https://cli-chat-proxy.grok.com/v1/responses', modelsUrl: 'https://cli-chat-proxy.grok.com/v1/models',
  note: 'Assinatura do Grok (SuperGrok, X Premium) pela CLI Grok Build (entrada por código).',
  risk: 'Se apresenta como a CLI oficial do Grok; a xAI pode restringir esse uso.',
  login: { type: 'device', clientId: GROK_CLIENT, deviceCodeUrl: 'https://auth.x.ai/oauth2/device/code', tokenUrl: 'https://auth.x.ai/oauth2/token',
    scope: 'openid profile email offline_access grok-cli:access api:access conversations:read conversations:write workspaces:read workspaces:write',
    form: { referrer: 'grok-build' }, headers: () => ({ 'x-grok-client-version': GROK_VERSION, 'x-grok-client-surface': 'ui' }) },
  refresh: standardRefresh('https://auth.x.ai/oauth2/token', GROK_CLIENT, () => ({ 'x-grok-client-version': GROK_VERSION, 'x-grok-client-surface': 'ui' })),
  route: (model) => ({ format: 'responses', url: 'https://cli-chat-proxy.grok.com/v1/responses', headers: { 'x-grok-model-override': splitEffort(model).model } }),
  headers: (c) => ({
    authorization: `Bearer ${c.accessToken}`, accept: 'text/event-stream', 'user-agent': `grok-shell/${GROK_VERSION} (${process.platform === 'win32' ? 'windows' : process.platform}; ${process.arch === 'x64' ? 'x86_64' : process.arch})`,
    'x-grok-client-version': GROK_VERSION, 'x-grok-client-identifier': 'grok-shell', 'x-grok-client-mode': 'headless',
    'x-xai-token-auth': 'xai-grok-cli', 'x-authenticateresponse': 'authenticate-response',
  }),
  body(payload) {
    const { model, effort } = splitEffort(payload.model);
    const { presence_penalty, frequency_penalty, top_logprobs, reasoning_effort, ...out } = payload;
    const e = effort ?? payload.reasoning?.effort;
    return { ...out, model, store: false, stream: true, include: ['reasoning.encrypted_content'], reasoning: { effort: GROK_EFFORTS.has(e) ? e : 'high', summary: 'auto' } };
  },
};

export const specOf = (id) => (Object.hasOwn(SPECS, id) ? SPECS[id] : null);
