// Teste de provedor: requisição real ao modelo configurado, pelo mesmo pipeline do tráfego do Claude Code.
import { prepare, convertResponse, makeStream, adaptPayload, joinUrl, authHeaders } from './pipeline.js';
import { send, readText } from './upstream.js';
import { providerGate } from './routing.js';
import { SSEParser, safeParse, parseUpstreamError } from './translate/common.js';
import { K, M, LocalError } from './i18n.js';

const LABELS = {
  functional: K('Funcional'), auth_failed: K('Falha de autenticação'), invalid_endpoint: K('Endpoint inválido'), model_not_found: K('Modelo inexistente'),
  timeout: K('Timeout'), protocol_error: K('Erro de protocolo'), connection_failed: K('Falha de conexão'), rate_limited: K('Limite ou saldo do provedor'),
  provider_error: K('Erro do provedor'), blocked: K('Bloqueado pela proteção SSRF'), no_key: K('Sem chave cadastrada'), no_model: K('Sem modelo configurado'),
};

function classifyHttp(status, message) {
  const m = message.toLowerCase();
  const modelHint = /model/.test(m) && /(not found|does not exist|not exist|unknown|invalid|no such|not available|unsupported|not supported)/.test(m);
  if (status === 401 || status === 403) return 'auth_failed';
  if (modelHint && status < 500) return 'model_not_found';
  if (status === 404 || status === 405) return 'invalid_endpoint';
  if (status === 402 || status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_error';
  return 'protocol_error';
}

const PROMPT = { messages: [{ role: 'user', content: 'Reply with exactly one word: OK' }], max_tokens: 512 };
const TOOL = { name: 'get_status', description: 'Returns the status of a service.', input_schema: { type: 'object', properties: { service: { type: 'string' } }, required: ['service'] } };

async function call(target, prep, timeoutMs) {
  let payload = prep.payload;
  for (let i = 0; ; i++) {
    await providerGate.acquire(target.provider, { maxWaitMs: Math.max(timeoutMs, 120000) }); // o teste em massa também respeita o limite
    const up = await send({ url: prep.url, headers: prep.headers, body: payload, timeoutMs, allowPrivate: target.provider.allowPrivateNetwork });
    if (up.status === 400 || up.status === 422) {
      const err = parseUpstreamError(up.status, await readText(up.stream, 1024 * 1024));
      const next = i < 3 ? adaptPayload(payload, err.message, target.provider.type) : null;
      if (next) { payload = next; continue; }
      return { ...up, err };
    }
    return up;
  }
}

/** Consome o stream pelo tradutor real e confere a sequência de eventos Anthropic. */
async function streamCheck(target, opts, timeoutMs) {
  const prep = prepare('anthropic', { ...PROMPT, stream: true }, target, opts);
  const up = await call(target, prep, timeoutMs);
  if (up.status !== 200) { if (up.stream && !up.err) up.stream.resume(); return { ok: false, detail: `HTTP ${up.status}` }; }
  const tr = makeStream(prep.ctx);
  const parser = new SSEParser();
  let out = '';
  let complete = false;
  for await (const c of up.stream) {
    for (const e of parser.feed(c)) {
      if (e.data === '[DONE]') { complete = true; continue; }
      const o = safeParse(e.data);
      if (!o) continue;
      if (tr.passthrough) { tr.observe(o); out += `event: ${e.event}\n`; } else {
        if (o.choices?.[0]?.finish_reason) complete = true;
        out += tr.push(o);
      }
    }
  }
  if (tr.passthrough) complete = tr.stopped; else out += tr.end(complete);
  const seq = [...out.matchAll(/^event: (\w+)/gm)].map((m) => m[1]).filter((x) => x !== 'ping');
  const ok = seq[0] === 'message_start' && seq.includes('content_block_delta') && seq.at(-1) === 'message_stop';
  return { ok, detail: ok ? M('{0} eventos, sequência válida', seq.length) : M('sequência inválida: {0}', seq.slice(0, 6).join(', ') || K('vazia')) };
}

async function toolCheck(target, opts, timeoutMs) {
  const body = { messages: [{ role: 'user', content: 'Check the status of the service named "api" using the tool.' }], max_tokens: 512, tools: [TOOL], tool_choice: { type: 'any' } };
  const prep = prepare('anthropic', body, target, opts);
  const up = await call(target, prep, timeoutMs);
  if (up.status !== 200) { if (up.stream && !up.err) up.stream.resume(); return { ok: false, detail: up.err?.message?.slice(0, 160) ?? `HTTP ${up.status}` }; }
  const r = convertResponse(safeParse(await readText(up.stream)) ?? {}, prep.ctx);
  const use = r.content.find((b) => b.type === 'tool_use');
  return use?.name === TOOL.name ? { ok: true, detail: M('chamou {0}', use.name) } : { ok: false, detail: K('modelo não chamou a ferramenta') };
}

/** `quick`: uma única chamada de texto, para testar muitos modelos gastando pouco. */
export async function testProvider(store, providerId, { modelId, keyId, timeoutMs = 30000, quick = false } = {}) {
  const p = store.provider(providerId);
  if (!p) throw new Error(K('Provedor não encontrado.'));
  const m = modelId ? p.models.find((x) => x.id === modelId) : p.models.find((x) => x.enabled) ?? p.models[0];
  const k = keyId ? p.keys.find((x) => x.id === keyId) : p.keys.find((x) => x.enabled);
  const steps = [];
  const step = (name, ok, detail = '') => steps.push({ name, ok, detail });
  const result = (status, message, extra = {}) => ({
    status, label: LABELS[status], message, provider: p.name, modelId: m?.id ?? null, quick, alias: m?.alias ?? null, upstream: m?.upstream ?? null, keyLabel: k?.label ?? null, steps, at: Date.now(), ...extra,
  });
  if (!m) return result('no_model', K('Cadastre ao menos um modelo neste provedor.'));
  if (!k && p.authScheme !== 'none') return result('no_key', K('Cadastre ao menos uma chave de API neste provedor.'));

  const target = { provider: p, model: m };
  const opts = { key: k ? store.keyValue(p, k) : null, extraHeaders: store.headersOf(p), alias: m.alias };
  const prep = prepare('anthropic', PROMPT, target, opts);
  const started = Date.now();
  let up;
  try { up = await call(target, prep, timeoutMs); }
  catch (e) {
    step(K('Conectividade'), false, e);
    const status = { timeout: 'timeout', blocked: 'blocked' }[e.kind] ?? 'connection_failed';
    return result(status, e, { latencyMs: Date.now() - started });
  }
  const latencyMs = Date.now() - started;
  step(K('Conectividade'), true, new URL(prep.url).host);

  if (up.status < 200 || up.status >= 300) {
    const err = up.err ?? parseUpstreamError(up.status, await readText(up.stream, 1024 * 1024).catch(() => ''));
    const status = classifyHttp(up.status, err.message);
    step(K('Autenticação'), status !== 'auth_failed', status === 'auth_failed' ? K('credencial recusada') : K('aceita'));
    step(K('Resposta HTTP'), false, `HTTP ${up.status}`);
    return result(status, err.message, { httpStatus: up.status, latencyMs });
  }
  step(K('Autenticação'), true, p.authScheme === 'none' ? K('sem autenticação') : M('chave {0}', k.hint));
  step(K('Resposta HTTP'), true, `HTTP ${up.status}`);

  let text;
  try { text = await readText(up.stream, 8 * 1024 * 1024, timeoutMs); }
  catch (e) { step(K('Estrutura da resposta'), false, e); return result('timeout', e, { latencyMs }); }
  const json = safeParse(text);
  if (!json) {
    step(K('Estrutura da resposta'), false, K('corpo não é JSON'));
    return result(/<html/i.test(text) ? 'invalid_endpoint' : 'protocol_error', K('O provedor não devolveu JSON. Confira a URL base.'), { latencyMs });
  }
  let msg;
  try { msg = convertResponse(json, prep.ctx); }
  catch (e) { step(K('Estrutura da resposta'), false, e); return result('protocol_error', M('Resposta fora do protocolo: {0}', e), { latencyMs }); }
  step(K('Estrutura da resposta'), true, p.type === 'openai' ? K('chat.completion válido') : K('message válido'));

  const sample = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  if (!sample) {
    step(K('Conteúdo gerado'), false, M('vazio (stop_reason={0})', msg.stop_reason));
    return result('protocol_error', K('O modelo respondeu sem texto. Modelos de raciocínio podem precisar de mais tokens de saída.'), { latencyMs });
  }
  step(K('Conteúdo gerado'), true, sample.slice(0, 80));
  step(K('Latência'), true, `${latencyMs} ms`);
  if (quick) return result('functional', K('Teste rápido: o modelo respondeu. Streaming e ferramentas não foram verificados.'), { latencyMs, sample, usage: msg.usage });

  let s;
  try { s = await streamCheck(target, opts, timeoutMs); } catch (e) { s = { ok: false, detail: e }; }
  step(K('Tradução: streaming'), s.ok, s.detail);
  let t;
  try { t = await toolCheck(target, opts, timeoutMs); } catch (e) { t = { ok: false, detail: e }; }
  step(K('Tradução: ferramentas'), t.ok, t.detail);

  // O Claude Code depende de streaming e ferramentas: sem isso o provedor responde, mas não serve para ele.
  if (!s.ok) return result('protocol_error', M('Texto funciona, mas o streaming falhou: {0}', s.detail), { latencyMs, sample });
  const message = t.ok ? K('Requisição real concluída pelo pipeline do gateway.') : M('Funciona, mas sem chamada de ferramentas ({0}). O Claude Code depende disso.', t.detail);
  return result('functional', message, { latencyMs, sample, toolsOk: t.ok, usage: msg.usage });
}

/** Lê a lista de modelos do provedor para facilitar o cadastro. */
export async function discoverModels(store, providerId) {
  const p = store.provider(providerId);
  if (!p) throw new Error(K('Provedor não encontrado.'));
  const k = p.keys.find((x) => x.enabled);
  if (!k && p.authScheme !== 'none') throw new Error(K('Cadastre uma chave antes de buscar modelos.'));
  const url = p.type === 'anthropic' ? joinUrl(p.baseUrl, 'anthropic').replace(/\/messages$/, '/models?limit=1000') : joinUrl(p.baseUrl, 'openai').replace(/\/chat\/completions$/, '/models');
  const headers = { ...authHeaders(p, k ? store.keyValue(p, k) : null), ...store.headersOf(p), ...(p.type === 'anthropic' && { 'anthropic-version': '2023-06-01' }) };
  const up = await send({ url, method: 'GET', headers, timeoutMs: 15000, allowPrivate: p.allowPrivateNetwork });
  const text = await readText(up.stream, 16 * 1024 * 1024);
  if (up.status !== 200) throw new LocalError('O provedor respondeu HTTP {0}: {1}', up.status, parseUpstreamError(up.status, text).message);
  const j = safeParse(text);
  const list = j?.data ?? j?.models ?? (Array.isArray(j) ? j : null);
  if (!Array.isArray(list)) throw new Error(K('O provedor não devolveu uma lista de modelos.'));
  return list.map((x) => (typeof x === 'string' ? x : x.id ?? x.name)).filter(Boolean).map((x) => String(x).replace(/^models\//, '')).sort().slice(0, 1000);
}
