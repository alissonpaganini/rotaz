// Monta a chamada ao provedor e converte a volta. Usado pelo gateway e pelo teste de provedor,
// assim o botão "Testar" exercita exatamente o mesmo caminho do tráfego real.
import { anthropicRequestToOpenAI, openAIResponseToAnthropic, OpenAIToAnthropicStream } from './translate/anthropic-to-openai.js';
import { openAIRequestToAnthropic, anthropicResponseToOpenAI, AnthropicToOpenAIStream } from './translate/openai-to-anthropic.js';
import { anthropicRequestToGemini, geminiResponseToAnthropic } from './translate/anthropic-to-gemini.js';
import { GeminiToAnthropicStream, collectGeminiStream } from './translate/gemini-to-anthropic.js';
import { anthropicRequestToResponses, responsesResponseToAnthropic, collectResponsesStream, ResponsesToAnthropicStream } from './translate/anthropic-to-responses.js';
import { cloudCodeCall } from './providers/antigravity.js';
import { routeFor, forceStreamOf } from './providers/oauth/engine.js';
import { estimateTokens, SSEParser, safeParse, TranslationError } from './translate/common.js';
import { K } from './i18n.js';

const ANTHROPIC_FIELDS = ['messages', 'system', 'max_tokens', 'metadata', 'stop_sequences', 'stream', 'temperature', 'top_k', 'top_p', 'tools', 'tool_choice', 'thinking', 'output_config', 'context_management', 'service_tier'];

export function joinUrl(base, type, suffix = '') {
  const b = base.replace(/\/+$/, '').replace(/\/(chat\/completions|messages)$/, '');
  if (type === 'anthropic') return `${b.endsWith('/v1') ? b : `${b}/v1`}/messages${suffix}`;
  return `${b}/chat/completions`;
}

export function authHeaders(provider, key) {
  const h = {};
  if (key) {
    if (provider.authScheme === 'bearer') h.authorization = `Bearer ${key}`;
    else if (provider.authScheme === 'x-api-key') h['x-api-key'] = key;
    else if (provider.authScheme === 'api-key') h['api-key'] = key;
  }
  return h;
}

function hoistSystem(payload) {
  const inline = payload.messages.filter((m) => m.role === 'system');
  if (!inline.length) return;
  const asBlocks = (c) => (typeof c === 'string' ? [{ type: 'text', text: c }] : c ?? []);
  payload.system = [...asBlocks(payload.system), ...inline.flatMap((m) => asBlocks(m.content))];
  payload.messages = payload.messages.filter((m) => m.role !== 'system');
}

const OMITTED = '[imagem omitida: o modelo configurado não aceita mais imagens nesta requisição]';

/** Percorre do fim para o começo: as imagens mais recentes são as que ficam. */
function eachImage(payload, type, fn) {
  const msgs = payload.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const c = msgs[i].content;
    if (!Array.isArray(c)) continue;
    for (let j = c.length - 1; j >= 0; j--) {
      const b = c[j];
      if (type === 'openai' && b?.type === 'image_url') fn(c, j);
      else if (type === 'anthropic') {
        if (b?.type === 'image') fn(c, j);
        else if (b?.type === 'tool_result' && Array.isArray(b.content)) {
          for (let k = b.content.length - 1; k >= 0; k--) if (b.content[k]?.type === 'image') fn(b.content, k);
        }
      }
    }
  }
}

export function countImages(payload, type) {
  let n = 0;
  eachImage(payload, type, () => { n++; });
  return n;
}

/** Mantém as `limit` imagens mais recentes e troca as demais por um aviso em texto. */
export function withImageLimit(payload, type, limit) {
  const next = structuredClone(payload);
  let kept = 0;
  eachImage(next, type, (arr, idx) => {
    if (kept < limit) { kept++; return; }
    arr[idx] = { type: 'text', text: OMITTED };
  });
  // Provedores só de texto costumam exigir content como string.
  if (type === 'openai') {
    for (const m of next.messages) {
      if (Array.isArray(m.content) && m.content.every((p) => p.type === 'text')) m.content = m.content.map((p) => p.text).join('\n');
    }
  }
  return next;
}

/** Lê o limite de imagens a partir da mensagem de erro do provedor; null se o erro não for sobre imagens. */
export function imageLimitFromError(message) {
  const msg = String(message);
  const n = /at most (\d+) images?/i.exec(msg) ?? /(?:maximum|max|up to|limit of) (?:of )?(\d+) images?/i.exec(msg) ?? /(\d+) images? (?:per|at most|maximum)/i.exec(msg);
  if (n) return Number(n[1]);
  if (/multimodal|does not support (?:image|vision)|(?:image|vision)s? (?:input )?(?:is |are )?not (?:supported|enabled|allowed)|image input|unsupported content type.{0,20}image|image_url/i.test(msg)) return 0;
  return null;
}

/** Devolve {url, headers, payload, ctx}. O corpo do cliente nunca escolhe URL, chave nem headers internos. */
export function prepare(clientProto, body, target, opts) {
  const r = buildPrepared(clientProto, body, target, opts);
  if (Number.isInteger(opts.maxImages) && countImages(r.payload, r.ctx.upstreamProto) > opts.maxImages) {
    r.payload = withImageLimit(r.payload, r.ctx.upstreamProto, opts.maxImages);
  }
  return r;
}

function buildPrepared(clientProto, body, target, { key, extraHeaders = {}, clientHeaders = {}, alias }) {
  const { provider: p, model: m } = target;
  // Provedor com conta (src/providers/oauth): vira um provedor OpenAI ou Anthropic "virtual" com o endereço e
  // os cabeçalhos da conta, e os tradutores de sempre fazem o resto. `key` aqui é a conta já pronta.
  if (p.type === 'oauth') {
    if (!key?.accessToken) throw new Error(K('Conta sem token de acesso. Conecte a conta de novo.'));
    const route = routeFor(p, m.upstream, key);
    const virtual = { ...p, type: route.format, baseUrl: route.url, authScheme: 'none' };
    // Os betas que o Claude Code pede são da API da Anthropic; outro provedor recusaria o pedido inteiro.
    const { 'anthropic-beta': _beta, ...client } = clientHeaders;
    const r = buildPrepared(clientProto, body, { provider: virtual, model: m }, { key: null, extraHeaders: { ...extraHeaders, ...route.headers }, clientHeaders: client, alias });
    // Provedor que só aceita streaming: pede em streaming mesmo quando o cliente não pediu; convertBody junta.
    if (forceStreamOf(p) && route.format === 'openai' && !r.payload.stream) r.payload = { ...r.payload, stream: true, stream_options: { include_usage: true } };
    // API Responses: sempre em streaming (o Codex só aceita assim); convertBody junta quando o cliente não pediu.
    if (route.format === 'responses') r.payload = { ...r.payload, stream: true };
    if (route.body) r.payload = route.body(r.payload, { model: m.upstream, cred: key, thinking: r.ctx.thinking });
    return { ...r, url: route.url };
  }
  const t = { upstream: m.upstream, baseUrl: p.baseUrl, maxOutputTokens: m.maxOutputTokens, reasoningEffort: m.reasoningEffort, tokenParam: m.tokenParam };
  const headers = { ...authHeaders(p, key), ...extraHeaders };
  const ctx = { clientProto, upstreamProto: p.type, alias, stream: !!body.stream };
  let payload;

  if (p.type === 'anthropic') {
    headers['anthropic-version'] = clientHeaders['anthropic-version'] || '2023-06-01';
    if (clientProto === 'anthropic') {
      if (clientHeaders['anthropic-beta']) headers['anthropic-beta'] = clientHeaders['anthropic-beta'];
      payload = { model: m.upstream };
      for (const f of ANTHROPIC_FIELDS) if (body[f] !== undefined) payload[f] = body[f];
      // Só a API oficial aceita role=system em messages; endpoints compatíveis recebem isso no campo system.
      if (!/(^|\.)anthropic\.com$/.test(new URL(p.baseUrl).hostname)) hoistSystem(payload);
      if (m.maxOutputTokens && payload.max_tokens > m.maxOutputTokens) payload.max_tokens = m.maxOutputTokens;
    } else {
      payload = openAIRequestToAnthropic(body, t).payload;
      ctx.includeUsage = !!body.stream_options?.include_usage;
    }
  } else if (p.type === 'antigravity') {
    const r = anthropicRequestToGemini(body, t);
    ctx.names = r.names;
    ctx.thinking = r.thinking;
    ctx.inputEstimate = r.inputEstimate;
    const call = cloudCodeCall(key, m.upstream, r.request);
    return { ...call, headers: { ...headers, ...call.headers }, ctx };
  } else if (p.type === 'responses') {
    // Só chega aqui por um provedor com conta (Codex, ChatGPT, Muse Code, Grok Build).
    if (clientProto !== 'anthropic') throw new TranslationError(K('Este provedor só atende pedidos no formato Anthropic, como os do Claude Code.'));
    const r = anthropicRequestToResponses(body, t);
    payload = r.payload;
    ctx.names = r.names;
    ctx.thinking = r.thinking;
    ctx.inputEstimate = estimateTokens([body.system, body.messages]);
    return { url: p.baseUrl, headers, payload, ctx };
  } else if (clientProto === 'anthropic') {
    const r = anthropicRequestToOpenAI(body, t);
    payload = r.payload;
    ctx.names = r.names;
    ctx.thinking = r.thinking;
    ctx.inputEstimate = estimateTokens([body.system, body.messages]);
  } else {
    payload = { ...body, model: m.upstream };
    for (const f of ['max_tokens', 'max_completion_tokens']) {
      if (m.maxOutputTokens && payload[f] > m.maxOutputTokens) payload[f] = m.maxOutputTokens;
    }
  }
  return { url: joinUrl(p.baseUrl, p.type), headers, payload, ctx };
}

/** Converte corpo não-stream do provedor para o protocolo do cliente. Lança erro se a estrutura for inválida. */
export function convertResponse(json, ctx) {
  const { clientProto, upstreamProto, alias } = ctx;
  if (clientProto === 'anthropic' && upstreamProto === 'openai') return openAIResponseToAnthropic(json, ctx);
  if (clientProto === 'openai' && upstreamProto === 'anthropic') return anthropicResponseToOpenAI(json, ctx);
  // O Cloud Code embrulha a resposta em `response`.
  if (clientProto === 'anthropic' && upstreamProto === 'antigravity') return geminiResponseToAnthropic(json?.response && typeof json.response === 'object' ? json.response : json, { alias, names: ctx.names, thinking: ctx.thinking });
  if (clientProto === 'anthropic' && upstreamProto === 'responses') return responsesResponseToAnthropic(json, { alias, names: ctx.names, thinking: ctx.thinking });
  if (clientProto === 'anthropic' && !Array.isArray(json.content)) throw new Error(K('Resposta sem content'));
  if (clientProto === 'openai' && !Array.isArray(json.choices)) throw new Error(K('Resposta sem choices'));
  return { ...json, model: alias };
}

/**
 * Corpo não-stream do provedor (texto) já convertido para o cliente. O Antigravity só tem o endpoint de
 * streaming, então mesmo um pedido sem stream volta em SSE: aqui os pedaços viram uma resposta única.
 */
export function convertBody(text, ctx) {
  if (ctx.upstreamProto === 'antigravity' && !/^\s*[{[]/.test(text)) {
    const parser = new SSEParser();
    const chunks = [...parser.feed(text), ...parser.flush()].map((e) => safeParse(e.data)).filter((o) => o && typeof o === 'object');
    if (!chunks.length) throw new Error(K('corpo não é JSON'));
    const failed = chunks.map((c) => (c.response ?? c).error).find(Boolean);
    if (failed) throw new Error(String(failed.message ?? failed));
    return collectGeminiStream(chunks, { alias: ctx.alias, names: ctx.names, thinking: ctx.thinking });
  }
  // OpenAI em SSE no lugar de JSON: o provedor só responde em streaming (CodeBuddy, WorkBuddy) ou ignorou
  // o stream:false. Os pedaços viram um chat.completion único antes da tradução de sempre.
  if (ctx.upstreamProto === 'responses' && !/^\s*[{[]/.test(text)) {
    const parser = new SSEParser();
    const events = [...parser.feed(text), ...parser.flush()].filter((e) => e.data !== '[DONE]').map((e) => safeParse(e.data)).filter((o) => o && typeof o === 'object');
    if (!events.length) throw new Error(K('corpo não é JSON'));
    return convertResponse(collectResponsesStream(events), ctx);
  }
  if (ctx.upstreamProto === 'openai' && /^\s*(data|event|:)/.test(text)) {
    const parser = new SSEParser();
    const chunks = [...parser.feed(text), ...parser.flush()].filter((e) => e.data !== '[DONE]').map((e) => safeParse(e.data)).filter((o) => o && typeof o === 'object');
    if (!chunks.length) throw new Error(K('corpo não é JSON'));
    const failed = chunks.find((c) => c.error)?.error;
    if (failed) throw new Error(String(failed.message ?? failed));
    return convertResponse(collectOpenAIStream(chunks), ctx);
  }
  const json = safeParse(text);
  if (!json) throw new Error(K('corpo não é JSON'));
  return convertResponse(json, ctx);
}

/** Junta pedaços de chat.completion.chunk num chat.completion: texto, raciocínio, ferramentas por índice e uso. */
export function collectOpenAIStream(chunks) {
  let content = '', reasoning = '', finish = null, usage, id, model;
  const calls = new Map();
  for (const c of chunks) {
    id ??= c.id; model ??= c.model;
    if (c.usage) usage = c.usage;
    const ch = c.choices?.[0];
    if (!ch) continue;
    const d = ch.delta ?? ch.message ?? {};
    if (typeof d.content === 'string') content += d.content;
    if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
    for (const tc of d.tool_calls ?? []) {
      const k = tc.index ?? calls.size;
      const t = calls.get(k) ?? { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
      if (tc.id) t.id = tc.id;
      if (tc.function?.name) t.function.name += tc.function.name;
      if (tc.function?.arguments) t.function.arguments += tc.function.arguments;
      calls.set(k, t);
    }
    if (ch.finish_reason) finish = ch.finish_reason;
  }
  const message = { role: 'assistant', content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (calls.size) message.tool_calls = [...calls.values()];
  return { id, object: 'chat.completion', model, choices: [{ index: 0, message, finish_reason: finish ?? (calls.size ? 'tool_calls' : 'stop') }], usage };
}

/** Sem tradução: repassa os bytes e apenas lê o consumo de tokens. */
class Sniffer {
  constructor(proto, alias) { this.proto = proto; this.alias = alias; this.usage = {}; this.passthrough = true; this.stopped = false; }
  observe(o) {
    if (this.proto === 'anthropic') {
      if (o.type === 'message_start') Object.assign(this.usage, o.message?.usage);
      else if (o.type === 'message_delta') Object.assign(this.usage, o.usage);
      else if (o.type === 'message_stop') this.stopped = true;
    } else if (o.usage) this.usage = o.usage;
  }
  get finalUsage() { return this.usage; }
  end() { return ''; }
  ping() { return this.proto === 'anthropic' ? 'event: ping\ndata: {"type":"ping"}\n\n' : ': ping\n\n'; }
}

function makeTranslator(ctx) {
  const { clientProto, upstreamProto } = ctx;
  if (clientProto === 'anthropic' && upstreamProto === 'openai') return new OpenAIToAnthropicStream(ctx);
  if (clientProto === 'openai' && upstreamProto === 'anthropic') return new AnthropicToOpenAIStream(ctx);
  if (clientProto === 'anthropic' && upstreamProto === 'antigravity') return new GeminiToAnthropicStream({ alias: ctx.alias, names: ctx.names, thinking: ctx.thinking, inputEstimate: ctx.inputEstimate });
  if (clientProto === 'anthropic' && upstreamProto === 'responses') return new ResponsesToAnthropicStream({ alias: ctx.alias, names: ctx.names, thinking: ctx.thinking, inputEstimate: ctx.inputEstimate });
  return new Sniffer(clientProto, ctx.alias);
}

/**
 * A resposta em streaming do provedor, já no protocolo do cliente. O gateway e o teste leem por aqui, então
 * a regra de "a resposta chegou inteira" de cada protocolo fica num lugar só.
 */
export class StreamRelay {
  constructor(ctx) { this.ctx = ctx; this.tr = makeTranslator(ctx); this.sawDone = false; this.sawFinish = false; }
  get passthrough() { return this.tr.passthrough === true; }
  get finalUsage() { return this.tr.finalUsage; }
  get upstreamError() { return this.tr.upstreamError; }
  ping() { return this.tr.ping(); }
  end(complete) { return this.tr.end(complete); }

  /** Um evento SSE do provedor; devolve o texto para o cliente. */
  feed(evt) {
    if (evt.data === '[DONE]') { this.sawDone = true; return this.passthrough && this.ctx.clientProto === 'openai' ? 'data: [DONE]\n\n' : ''; }
    const obj = safeParse(evt.data);
    if (!obj) return '';
    if (this.passthrough) {
      this.tr.observe(obj);
      return evt.event ? `event: ${evt.event}\ndata: ${evt.data}\n\n` : `data: ${evt.data}\n\n`;
    }
    if (obj.choices?.[0]?.finish_reason) this.sawFinish = true;
    return this.tr.push(obj);
  }

  /** Provedor OpenAI que ignorou stream:true e respondeu em JSON: a resposta inteira vira um único pedaço. */
  single(json) {
    const m = json.choices?.[0]?.message ?? {};
    this.sawDone = true;
    return this.tr.push({ choices: [{ delta: { ...m, tool_calls: m.tool_calls?.map((c, index) => ({ index, ...c })) }, finish_reason: json.choices?.[0]?.finish_reason ?? 'stop' }], usage: json.usage });
  }

  /** O fim normal de cada protocolo: message_stop (Anthropic), finishReason (Gemini), response.completed (Responses), [DONE] ou finish_reason (OpenAI). */
  isComplete() {
    const up = this.ctx.upstreamProto;
    if (up === 'anthropic') return this.tr.stopped === true;
    if (up === 'antigravity') return !!this.tr.finish;
    if (up === 'responses') return this.tr.completed === true;
    return this.sawDone || this.sawFinish;
  }
}

export function usageTokens(u) {
  if (!u) return { input: 0, output: 0 };
  if (u.prompt_tokens !== undefined) return { input: u.prompt_tokens, output: u.completion_tokens ?? 0 };
  return { input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0 };
}

/**
 * Provedores divergem em detalhes de parâmetro. A partir da mensagem de erro 400, devolve um payload
 * ajustado para nova tentativa, ou null se não houver ajuste seguro.
 */
export function adaptPayload(payload, message, upstreamProto) {
  if (upstreamProto !== 'openai') return null;
  const msg = String(message).toLowerCase();
  const next = { ...payload };
  const tok = next.max_tokens !== undefined ? 'max_tokens' : next.max_completion_tokens !== undefined ? 'max_completion_tokens' : null;
  if (tok && msg.includes('max_tokens') && msg.includes('max_completion_tokens') && tok === 'max_tokens') {
    next.max_completion_tokens = next.max_tokens;
    delete next.max_tokens;
    return next;
  }
  const limit = /(?:at most|maximum(?: value)?(?: of| is)?|less than or equal to|<=)\s*(\d{3,})/.exec(msg) ?? /\[\s*\d+\s*,\s*(\d{3,})\s*\]/.exec(msg);
  if (tok && limit && /token/.test(msg) && Number(limit[1]) < next[tok]) { next[tok] = Number(limit[1]); return next; }
  for (const f of ['stream_options', 'parallel_tool_calls', 'reasoning_effort', 'user', 'top_p', 'temperature', 'stop']) {
    if (next[f] !== undefined && msg.includes(f)) { delete next[f]; return next; }
  }
  return null;
}
