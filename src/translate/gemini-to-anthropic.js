// Stream do Cloud Code (formato Gemini) vira a sequência de eventos que o cliente Anthropic espera.
// O upstream manda cada pedaço como `data: {"response": {...}}`; `push` recebe o objeto já parseado.
import { genId, sse, toolExtras, AnthropicStreamWriter, REASONING_SIGNATURE } from './common.js';
import { usageOf, stopReasonOf } from './anthropic-to-gemini.js';

/** O envelope do Cloud Code embrulha o payload em `response`; alguns hosts devolvem direto. */
const unwrap = (o) => (o && typeof o === 'object' && o.response && typeof o.response === 'object' ? o.response : o);

/**
 * Máquina de estados Gemini -> Anthropic. Blocos saem em sequência: texto, raciocínio e cada
 * chamada de ferramenta abrem e fecham em ordem, porque o cliente não aceita blocos intercalados.
 */
export class GeminiToAnthropicStream extends AnthropicStreamWriter {
  constructor(opts) {
    super(opts);
    this.finish = null;
    this.usage = null;
    this.sawTool = false;
  }

  /** O Gemini entrega a chamada inteira de uma vez: abre, despeja o JSON e fecha. */
  toolBlock(fc, signature) {
    const id = (typeof fc.id === 'string' && fc.id) || genId('toolu_');
    const name = this.names.original(fc.name);
    const args = fc.args && typeof fc.args === 'object' ? fc.args : {};
    const json = JSON.stringify(args);
    this.sawTool = true;
    if (signature) toolExtras.set(id, { google: { thought_signature: signature } });

    let s = this.openBlock({ id, name }, { type: 'tool_use', id, name, input: {} });
    if (json && json !== '{}') s += this.argDelta(json);
    this.open = null;
    return s + sse('content_block_stop', { type: 'content_block_stop', index: this.index });
  }

  push(chunk) {
    let s = this.start();
    const o = unwrap(chunk);
    if (!o || typeof o !== 'object') return s;
    if (o.error) {
      this.upstreamError = { message: o.error.message ?? String(o.error), type: o.error.status ?? 'api_error' };
      return s;
    }
    if (o.usageMetadata) this.usage = o.usageMetadata;

    const candidate = o.candidates?.[0];
    if (!candidate) return s;

    for (const part of candidate.content?.parts ?? []) {
      if (part.functionCall?.name) { s += this.toolBlock(part.functionCall, part.thoughtSignature); continue; }
      if (typeof part.text !== 'string' || !part.text) continue;
      // `thought: true` é o raciocínio do modelo: vira bloco thinking, nunca texto visível.
      if (part.thought) { if (this.thinking) s += this.textDelta('thinking', part.text); continue; }
      s += this.textDelta('text', part.text);
    }
    if (candidate.finishReason) this.finish = String(candidate.finishReason).toUpperCase();
    return s;
  }

  end(complete) {
    return this.close(complete, () => ({
      usage: this.usage ? usageOf(this.usage) : this.estimatedUsage(),
      stop: this.sawTool ? 'tool_use' : stopReasonOf(this.finish),
    }));
  }

}

/**
 * Junta um stream inteiro numa resposta única, para quando o cliente pediu `stream: false`.
 * Reaproveita o mesmo estado: monta os blocos na ordem em que chegariam ao vivo.
 */
export function collectGeminiStream(chunks, ctx) {
  const content = [];
  let text = '';
  let reasoning = '';
  const calls = [];
  let usage = null;
  let finish = null;

  for (const chunk of chunks) {
    const o = unwrap(chunk);
    if (!o || typeof o !== 'object') continue;
    if (o.usageMetadata) usage = o.usageMetadata;
    const candidate = o.candidates?.[0];
    if (!candidate) continue;
    for (const part of candidate.content?.parts ?? []) {
      if (part.functionCall?.name) {
        const id = part.functionCall.id || genId('toolu_');
        calls.push({ type: 'tool_use', id, name: ctx.names.original(part.functionCall.name), input: part.functionCall.args ?? {} });
        if (part.thoughtSignature) toolExtras.set(id, { google: { thought_signature: part.thoughtSignature } });
        continue;
      }
      if (typeof part.text !== 'string' || !part.text) continue;
      if (part.thought) reasoning += part.text;
      else text += part.text;
    }
    if (candidate.finishReason) finish = String(candidate.finishReason).toUpperCase();
  }

  if (reasoning && ctx.thinking) content.push({ type: 'thinking', thinking: reasoning, signature: REASONING_SIGNATURE });
  if (text) content.push({ type: 'text', text });
  content.push(...calls);

  return {
    id: genId('msg_'),
    type: 'message',
    role: 'assistant',
    model: ctx.alias,
    content,
    stop_reason: calls.length ? 'tool_use' : stopReasonOf(finish),
    stop_sequence: null,
    usage: usageOf(usage),
  };
}

