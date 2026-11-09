// Utilidades compartilhadas pela camada de tradução.
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { redact } from '../security.js';

export const genId = (prefix) => `${prefix}${crypto.randomBytes(12).toString('hex')}`;

export function safeParse(s, fallback = null) {
  try { return JSON.parse(s); } catch { return fallback; }
}

export const FINISH_TO_STOP = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', function_call: 'tool_use', content_filter: 'refusal' };
export const STOP_TO_FINISH = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls', refusal: 'content_filter', pause_turn: 'stop', model_context_window_exceeded: 'length' };

/**
 * OpenAI exige nomes de função com até 64 caracteres em [a-zA-Z0-9_-]; ferramentas MCP do Claude Code
 * passam disso. Encurta de forma determinística e guarda o mapa reverso para restaurar a resposta.
 */
export class ToolNames {
  constructor() { this.toShort = new Map(); this.toOriginal = new Map(); }
  short(name) {
    const n = String(name);
    if (this.toShort.has(n)) return this.toShort.get(n);
    let s = n;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(n)) {
      const hash = crypto.createHash('sha256').update(n).digest('hex').slice(0, 8);
      s = `${n.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 55)}_${hash}`;
    }
    this.toShort.set(n, s);
    this.toOriginal.set(s, n);
    return s;
  }
  original(s) { return this.toOriginal.get(s) ?? s; }
}

/**
 * Gemini (compatível com OpenAI) devolve `extra_content.google.thought_signature` em cada chamada de
 * ferramenta e exige recebê-la de volta no turno seguinte. O Claude Code não conhece esse campo, então
 * o gateway guarda a assinatura pelo id da chamada e a reinsere no histórico.
 */
class LRU {
  constructor(max) { this.max = max; this.m = new Map(); }
  get(k) { const v = this.m.get(k); if (v !== undefined) { this.m.delete(k); this.m.set(k, v); } return v; }
  set(k, v) { this.m.delete(k); this.m.set(k, v); if (this.m.size > this.max) this.m.delete(this.m.keys().next().value); }
}
export const toolExtras = new LRU(20000);

/** Parser SSE incremental: aceita pedaços arbitrários, inclusive caracteres UTF-8 partidos. */
export class SSEParser {
  constructor() { this.dec = new StringDecoder('utf8'); this.buf = ''; }
  feed(chunk) {
    this.buf += typeof chunk === 'string' ? chunk : this.dec.write(chunk);
    const out = [];
    let m;
    while ((m = /\r\n\r\n|\n\n|\r\r/.exec(this.buf))) {
      const evt = parseBlock(this.buf.slice(0, m.index));
      this.buf = this.buf.slice(m.index + m[0].length);
      if (evt) out.push(evt);
    }
    return out;
  }
  flush() {
    const evt = parseBlock(this.buf);
    this.buf = '';
    return evt ? [evt] : [];
  }
}

function parseBlock(raw) {
  let event = null;
  const data = [];
  for (const line of raw.split(/\r\n|\n|\r/)) {
    if (!line || line[0] === ':') continue;
    const c = line.indexOf(':');
    const f = c < 0 ? line : line.slice(0, c);
    const v = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
    if (f === 'event') event = v;
    else if (f === 'data') data.push(v);
  }
  return data.length ? { event, data: data.join('\n') } : null;
}

export const sse = (event, obj) => `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;

const ANTHROPIC_TYPES = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error', 500: 'api_error', 502: 'api_error', 503: 'api_error', 504: 'timeout_error', 529: 'overloaded_error' };
const OPENAI_TYPES = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 413: 'invalid_request_error', 429: 'rate_limit_error' };

export const anthropicErrorType = (s) => ANTHROPIC_TYPES[s] ?? (s >= 500 ? 'api_error' : 'invalid_request_error');

/** Normaliza qualquer corpo de erro de provedor para {status, message, code}. */
export function parseUpstreamError(status, text) {
  const j = safeParse(text);
  const e = Array.isArray(j) ? j[0]?.error : j?.error;
  const message = (typeof e === 'string' ? e : e?.message) ?? j?.message ?? j?.detail ?? (String(text || '').slice(0, 300) || `Provedor respondeu HTTP ${status}`);
  return { status, message: redact(String(message)).slice(0, 2000), code: (typeof e === 'object' && (e?.code ?? e?.type)) || null };
}

export const toAnthropicError = (status, message) => ({ type: 'error', error: { type: anthropicErrorType(status), message } });
export const toOpenAIError = (status, message, code = null) => ({
  error: { message, type: OPENAI_TYPES[status] ?? (status >= 500 ? 'server_error' : 'invalid_request_error'), param: null, code },
});

/** Estimativa local, usada em count_tokens e quando o provedor não informa consumo. */
export function estimateTokens(value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.ceil(s.length / 3.6);
}
