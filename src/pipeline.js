// Monta a chamada ao provedor e converte a volta. Usado pelo gateway e pelo teste de provedor,
// assim o botão "Testar" exercita exatamente o mesmo caminho do tráfego real.
import { anthropicRequestToOpenAI, openAIResponseToAnthropic, OpenAIToAnthropicStream } from './translate/anthropic-to-openai.js';
import { openAIRequestToAnthropic, anthropicResponseToOpenAI, AnthropicToOpenAIStream } from './translate/openai-to-anthropic.js';
import { estimateTokens } from './translate/common.js';
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

// ---------- imagens ----------
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
  if (Number.isInteger(opts.maxImages) && countImages(r.payload, target.provider.type) > opts.maxImages) {
    r.payload = withImageLimit(r.payload, target.provider.type, opts.maxImages);
  }
  return r;
}

function buildPrepared(clientProto, body, target, { key, extraHeaders = {}, clientHeaders = {}, alias }) {
  const { provider: p, model: m } = target;
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
  if (clientProto === 'anthropic' && !Array.isArray(json.content)) throw new Error(K('Resposta sem content'));
  if (clientProto === 'openai' && !Array.isArray(json.choices)) throw new Error(K('Resposta sem choices'));
  return { ...json, model: alias };
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

export function makeStream(ctx) {
  const { clientProto, upstreamProto } = ctx;
  if (clientProto === 'anthropic' && upstreamProto === 'openai') return new OpenAIToAnthropicStream(ctx);
  if (clientProto === 'openai' && upstreamProto === 'anthropic') return new AnthropicToOpenAIStream(ctx);
  return new Sniffer(clientProto, ctx.alias);
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
