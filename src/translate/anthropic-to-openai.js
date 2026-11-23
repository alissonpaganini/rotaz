// Cliente fala Anthropic Messages (Claude Code); provedor fala OpenAI Chat Completions.
import crypto from 'node:crypto';
import { genId, safeParse, FINISH_TO_STOP, ToolNames, toolExtras, blocks, systemText, documentText, REASONING_SIGNATURE, AnthropicStreamWriter } from './common.js';

function imagePart(b) {
  const s = b.source;
  if (s?.type === 'base64') return { type: 'image_url', image_url: { url: `data:${s.media_type};base64,${s.data}` } };
  if (s?.type === 'url') return { type: 'image_url', image_url: { url: s.url } };
  return null;
}

function toolResultContent(b) {
  const texts = [];
  const images = [];
  for (const x of blocks(b.content)) {
    if (x.type === 'text') texts.push(x.text);
    else if (x.type === 'image') { const p = imagePart(x); if (p) images.push(p); }
  }
  const text = texts.join('\n') || (images.length ? '[imagem anexada na mensagem seguinte]' : '');
  return { text: b.is_error ? `[erro da ferramenta] ${text}` : text, images };
}

function convertUser(content, out, names) {
  const parts = [];
  const late = [];
  for (const b of blocks(content)) {
    switch (b?.type) {
      case 'tool_result': {
        const { text, images } = toolResultContent(b);
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: text });
        late.push(...images);
        break;
      }
      case 'text': parts.push({ type: 'text', text: b.text }); break;
      case 'image': { const p = imagePart(b); if (p) parts.push(p); break; }
      case 'document': parts.push({ type: 'text', text: documentText(b) }); break;
      default: break;
    }
  }
  const all = [...late, ...parts];
  if (!all.length) return;
  out.push({ role: 'user', content: all.every((p) => p.type === 'text') ? all.map((p) => p.text).join('\n') : all });
}

function convertAssistant(content, out, names) {
  const texts = [];
  const calls = [];
  let reasoning = '';
  for (const b of blocks(content)) {
    if (b?.type === 'text') texts.push(b.text);
    else if (b?.type === 'tool_use') {
      const call = { id: b.id, type: 'function', function: { name: names.short(b.name), arguments: JSON.stringify(b.input ?? {}) } };
      const extra = toolExtras.get(b.id);
      if (extra) call.extra_content = extra;
      calls.push(call);
    } else if (b?.type === 'thinking' && b.signature === REASONING_SIGNATURE) reasoning += b.thinking;
  }
  if (!texts.length && !calls.length) return;
  const m = { role: 'assistant', content: texts.join('\n') || null };
  if (calls.length) m.tool_calls = calls;
  if (reasoning) m.reasoning_content = reasoning; // só existe se o próprio provedor o emitiu antes
  out.push(m);
}

/** OpenAI recusa tool_calls sem resposta e respostas sem chamada; o histórico compactado pode ter ambos. */
function repairToolPairs(msgs) {
  const out = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'tool') {
      const known = out.some((x) => x.role === 'assistant' && x.tool_calls?.some((c) => c.id === m.tool_call_id));
      out.push(known ? m : { role: 'user', content: `[resultado de ferramenta] ${m.content}` });
      continue;
    }
    out.push(m);
    if (m.role === 'assistant' && m.tool_calls) {
      const answered = new Set();
      let j = i + 1;
      for (; j < msgs.length && msgs[j].role === 'tool'; j++) { answered.add(msgs[j].tool_call_id); out.push(msgs[j]); }
      for (const c of m.tool_calls) if (!answered.has(c.id)) out.push({ role: 'tool', tool_call_id: c.id, content: '[sem resultado]' });
      i = j - 1;
    }
  }
  return out;
}

function convertToolChoice(tc, names) {
  switch (tc?.type) {
    case 'auto': return 'auto';
    case 'any': return 'required';
    case 'none': return 'none';
    case 'tool': return { type: 'function', function: { name: names.short(tc.name) } };
    default: return undefined;
  }
}

export function usesCompletionTokens(upstreamModel, baseUrl = '') {
  return /^(o\d|gpt-5)/i.test(upstreamModel) || (/api\.openai\.com/.test(baseUrl) && !/^gpt-(3|4)/i.test(upstreamModel));
}

/**
 * @param body requisição Anthropic já validada
 * @param t    {upstream, baseUrl, maxOutputTokens, reasoningEffort, tokenParam}
 */
export function anthropicRequestToOpenAI(body, t) {
  const names = new ToolNames();
  const msgs = [];
  // Claude Code 2.1.3xx envia role=system dentro de messages, às vezes como última mensagem. Vários
  // provedores recusam isso, então essas instruções sobem para a mensagem de sistema inicial.
  const sys = [systemText(body.system)];
  for (const m of body.messages) {
    if (m.role === 'system') sys.push(systemText(m.content));
    else if (m.role === 'assistant') convertAssistant(m.content, msgs, names);
    else convertUser(m.content, msgs, names);
  }
  const system = sys.filter(Boolean).join('\n\n');

  const payload = { model: t.upstream, messages: [...(system ? [{ role: 'system', content: system }] : []), ...repairToolPairs(msgs)] };

  let max = body.max_tokens;
  if (t.maxOutputTokens && max > t.maxOutputTokens) max = t.maxOutputTokens;
  const param = t.tokenParam && t.tokenParam !== 'auto' ? t.tokenParam
    : usesCompletionTokens(t.upstream, t.baseUrl) ? 'max_completion_tokens' : 'max_tokens';
  if (max) payload[param] = max;

  if (body.temperature !== undefined) payload.temperature = body.temperature;
  if (body.top_p !== undefined) payload.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) payload.stop = body.stop_sequences.slice(0, 4);
  const rawEffort = typeof body.output_config?.effort === 'string' ? body.output_config.effort.trim().toLowerCase() : null;
  const clientEffort = rawEffort === 'max' || rawEffort === 'ultracode' || rawEffort === 'xhigh' ? 'high' : rawEffort;
  if (clientEffort || t.reasoningEffort) payload.reasoning_effort = clientEffort || t.reasoningEffort;
  // Claude Code envia um user_id longo e identificável; o provedor recebe apenas um hash estável.
  if (body.metadata?.user_id) payload.user = crypto.createHash('sha256').update(String(body.metadata.user_id)).digest('hex').slice(0, 32);

  const tools = (body.tools || []).filter((x) => x.input_schema && (!x.type || x.type === 'custom'));
  if (tools.length) {
    payload.tools = tools.map((x) => {
      const { $schema, ...parameters } = x.input_schema;
      return { type: 'function', function: { name: names.short(x.name), description: x.description ?? '', parameters } };
    });
    const choice = convertToolChoice(body.tool_choice, names);
    if (choice !== undefined) payload.tool_choice = choice;
    if (body.tool_choice?.disable_parallel_tool_use) payload.parallel_tool_calls = false;
  }
  if (body.stream) {
    payload.stream = true;
    payload.stream_options = { include_usage: true };
  }
  return { payload, names, thinking: body.thinking?.type === 'enabled' || body.thinking?.type === 'adaptive' };
}

function mapUsage(u) {
  const cached = u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens ?? 0;
  return {
    input_tokens: Math.max(0, (u?.prompt_tokens ?? 0) - cached),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
    output_tokens: u?.completion_tokens ?? 0,
  };
}

const reasoningOf = (m) => m?.reasoning_content ?? (typeof m?.reasoning === 'string' ? m.reasoning : '') ?? '';

export function openAIResponseToAnthropic(r, { alias, names, thinking }) {
  const choice = r.choices?.[0];
  if (!choice) throw new Error('Resposta sem choices');
  const m = choice.message ?? {};
  const content = [];
  const reasoning = reasoningOf(m);
  if (reasoning && thinking) content.push({ type: 'thinking', thinking: reasoning, signature: REASONING_SIGNATURE });
  const text = typeof m.content === 'string' ? m.content
    : Array.isArray(m.content) ? m.content.map((p) => p.text ?? '').join('') : '';
  if (text) content.push({ type: 'text', text });
  if (m.refusal && !text) content.push({ type: 'text', text: m.refusal });
  const calls = m.tool_calls ?? (m.function_call ? [{ id: genId('toolu_'), function: m.function_call }] : []);
  for (const c of calls) {
    if (c.id && c.extra_content) toolExtras.set(c.id, c.extra_content);
    content.push({ type: 'tool_use', id: c.id || genId('toolu_'), name: names.original(c.function?.name), input: safeParse(c.function?.arguments || '{}', {}) ?? {} });
  }
  const stop = calls.length ? 'tool_use' : FINISH_TO_STOP[choice.finish_reason] ?? 'end_turn';
  return { id: genId('msg_'), type: 'message', role: 'assistant', model: alias, content, stop_reason: stop, stop_sequence: null, usage: mapUsage(r.usage) };
}

/**
 * Máquina de estados: chunks OpenAI -> eventos Anthropic. Blocos saem estritamente em sequência;
 * chamadas paralelas intercaladas ficam em buffer e saem completas na ordem de chegada.
 */
export class OpenAIToAnthropicStream extends AnthropicStreamWriter {
  constructor(opts) {
    super(opts);
    this.tools = [];
    this.byIndex = new Map();
    this.finish = null;
    this.usage = null;
  }

  startTool(t) {
    t.started = true;
    return this.openBlock(t, { type: 'tool_use', id: t.id, name: this.names.original(t.name), input: {} });
  }

  toolDelta(tc) {
    const key = tc.index ?? 0;
    let t = this.byIndex.get(key);
    // Gemini repete index 0 em chamadas paralelas e diferencia apenas pelo id.
    if (!t || (tc.id && t.id && tc.id !== t.id)) {
      t = { id: tc.id || genId('toolu_'), name: '', buf: '', started: false, done: false };
      this.byIndex.set(key, t);
      this.tools.push(t);
    }
    if (tc.function?.name) t.name += tc.function.name;
    if (tc.extra_content) toolExtras.set(t.id, tc.extra_content);
    const args = tc.function?.arguments ?? '';
    const idle = this.open === null || typeof this.open === 'string';
    let s = '';
    if (!t.started && t.name && idle) s += this.startTool(t);
    if (this.open === t) {
      const out = t.buf + args;
      t.buf = '';
      if (out) s += this.argDelta(out);
    } else t.buf += args;
    return s;
  }

  push(c) {
    let s = this.start();
    if (c.error) { this.upstreamError = c.error; return s; }
    if (c.usage) this.usage = c.usage;
    const ch = c.choices?.[0];
    if (!ch) return s;
    const d = ch.delta ?? {};
    const reasoning = reasoningOf(d);
    if (reasoning && this.thinking) s += this.textDelta('thinking', reasoning);
    if (typeof d.content === 'string' && d.content) s += this.textDelta('text', d.content);
    if (d.refusal) s += this.textDelta('text', d.refusal);
    for (const tc of d.tool_calls ?? []) s += this.toolDelta(tc);
    if (d.function_call) s += this.toolDelta({ index: 0, function: d.function_call });
    if (ch.finish_reason) this.finish = ch.finish_reason;
    return s;
  }

  end(complete) {
    return this.close(complete, () => {
      // Ferramentas que chegaram sem nome a tempo de abrir o bloco: saem agora, inteiras.
      let before = '';
      for (const t of this.tools) {
        if (t.started) continue;
        before += this.startTool(t);
        if (t.buf) before += this.argDelta(t.buf);
        t.buf = '';
        before += this.closeOpen();
      }
      return { before, usage: this.usage ? mapUsage(this.usage) : this.estimatedUsage(), stop: this.tools.length ? 'tool_use' : FINISH_TO_STOP[this.finish] ?? 'end_turn' };
    });
  }
}
