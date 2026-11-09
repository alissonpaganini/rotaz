// Cliente fala OpenAI Chat Completions; provedor fala Anthropic Messages.
import { genId, safeParse, STOP_TO_FINISH } from './common.js';

const DEFAULT_MAX_TOKENS = 4096;
export class TranslationError extends Error {}

function imageBlock(url) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
  return { type: 'image', source: { type: 'url', url } };
}

function userBlocks(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  const out = [];
  for (const p of content ?? []) {
    if (p.type === 'text') out.push({ type: 'text', text: p.text });
    else if (p.type === 'image_url') out.push(imageBlock(p.image_url?.url ?? ''));
  }
  return out;
}

const textOf = (c) => (typeof c === 'string' ? c : (c ?? []).map((p) => p.text ?? '').join('\n'));

function assistantBlocks(m) {
  const out = [];
  const t = textOf(m.content);
  if (t) out.push({ type: 'text', text: t });
  for (const c of m.tool_calls ?? []) {
    out.push({ type: 'tool_use', id: c.id, name: c.function?.name, input: safeParse(c.function?.arguments || '{}', {}) ?? {} });
  }
  if (m.function_call) {
    out.push({ type: 'tool_use', id: `call_${m.function_call.name}`, name: m.function_call.name, input: safeParse(m.function_call.arguments || '{}', {}) ?? {} });
  }
  return out;
}

function convertToolChoice(tc, parallelOff) {
  let r;
  if (tc === 'auto' || tc === undefined) r = { type: 'auto' };
  else if (tc === 'required') r = { type: 'any' };
  else if (tc === 'none') r = { type: 'none' };
  else if (tc?.function?.name) r = { type: 'tool', name: tc.function.name };
  else if (typeof tc === 'object' && tc?.name) r = { type: 'tool', name: tc.name };
  else r = { type: 'auto' };
  if (parallelOff && r.type !== 'none') r.disable_parallel_tool_use = true;
  return r;
}

export function openAIRequestToAnthropic(body, t) {
  if (body.n > 1) throw new TranslationError('n > 1 não é suportado por provedores Anthropic.');
  const system = [];
  const msgs = [];
  const add = (role, blocks) => {
    if (!blocks.length) return;
    const last = msgs[msgs.length - 1];
    if (last?.role === role) last.content.push(...blocks); // Anthropic exige alternância de papéis
    else msgs.push({ role, content: blocks });
  };
  for (const m of body.messages) {
    switch (m.role) {
      case 'system':
      case 'developer': system.push(textOf(m.content)); break;
      case 'assistant': add('assistant', assistantBlocks(m)); break;
      case 'tool': add('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: textOf(m.content) }]); break;
      case 'function': add('user', [{ type: 'tool_result', tool_use_id: `call_${m.name}`, content: textOf(m.content) }]); break;
      default: add('user', userBlocks(m.content));
    }
  }
  if (!msgs.length || msgs[0].role !== 'user') msgs.unshift({ role: 'user', content: [{ type: 'text', text: '(continue)' }] });

  // Sem equivalente nativo: o pedido de JSON vira instrução de sistema (ver README, limitações).
  const rf = body.response_format;
  if (rf?.type === 'json_object') system.push('Responda apenas com um objeto JSON válido, sem texto adicional.');
  else if (rf?.type === 'json_schema') system.push(`Responda apenas com JSON válido conforme este schema: ${JSON.stringify(rf.json_schema?.schema ?? {})}`);

  let max = body.max_completion_tokens ?? body.max_tokens ?? t.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
  if (t.maxOutputTokens && max > t.maxOutputTokens) max = t.maxOutputTokens;

  const payload = { model: t.upstream, max_tokens: max, messages: msgs };
  if (system.length) payload.system = system.filter(Boolean).join('\n\n');
  if (body.temperature !== undefined && body.temperature !== null) payload.temperature = Math.min(1, Math.max(0, body.temperature));
  if (body.top_p !== undefined && body.top_p !== null) payload.top_p = body.top_p;
  if (body.stop) payload.stop_sequences = [].concat(body.stop).filter((s) => /\S/.test(s));
  if (body.user) payload.metadata = { user_id: String(body.user).slice(0, 256) };
  if (body.stream) payload.stream = true;

  const fns = body.tools?.filter((x) => x.type === 'function').map((x) => x.function) ?? body.functions ?? [];
  if (fns.length) {
    payload.tools = fns.map((f) => ({ name: f.name, description: f.description ?? '', input_schema: f.parameters ?? { type: 'object', properties: {} } }));
    const legacy = body.function_call && typeof body.function_call === 'object' ? { function: body.function_call } : body.function_call;
    payload.tool_choice = convertToolChoice(body.tool_choice ?? legacy, body.parallel_tool_calls === false);
  }
  return { payload };
}

const usageOf = (u) => {
  const prompt = (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
  const completion = u?.output_tokens ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: u?.cache_read_input_tokens ?? 0 } };
};

export function anthropicResponseToOpenAI(r, { alias }) {
  if (!Array.isArray(r.content)) throw new Error('Resposta sem content');
  let text = '';
  let reasoning = '';
  const calls = [];
  for (const b of r.content) {
    if (b.type === 'text') text += b.text;
    else if (b.type === 'thinking') reasoning += b.thinking;
    else if (b.type === 'tool_use') calls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
  }
  const message = { role: 'assistant', content: text || null, refusal: null };
  if (reasoning) message.reasoning_content = reasoning;
  if (calls.length) message.tool_calls = calls;
  return {
    id: `chatcmpl-${r.id ?? genId('')}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: alias,
    choices: [{ index: 0, message, finish_reason: STOP_TO_FINISH[r.stop_reason] ?? 'stop', logprobs: null }],
    usage: usageOf(r.usage),
  };
}

export class AnthropicToOpenAIStream {
  constructor({ alias, includeUsage }) {
    Object.assign(this, { alias, includeUsage });
    this.id = `chatcmpl-${genId('')}`;
    this.created = Math.floor(Date.now() / 1000);
    this.tool = -1;
    this.usage = {};
    this.finished = false;
    this.stopped = false;
    this.upstreamError = null;
  }
  chunk(delta, finish = null, extra = {}) {
    return `data: ${JSON.stringify({ id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.alias,
      choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }], ...extra })}\n\n`;
  }
  push(e) {
    switch (e.type) {
      case 'message_start':
        Object.assign(this.usage, e.message?.usage);
        return this.chunk({ role: 'assistant', content: '' });
      case 'content_block_start':
        if (e.content_block?.type === 'tool_use') {
          this.tool++;
          return this.chunk({ tool_calls: [{ index: this.tool, id: e.content_block.id, type: 'function', function: { name: e.content_block.name, arguments: '' } }] });
        }
        return '';
      case 'content_block_delta': {
        const d = e.delta;
        if (d?.type === 'text_delta') return this.chunk({ content: d.text });
        if (d?.type === 'thinking_delta') return this.chunk({ reasoning_content: d.thinking });
        if (d?.type === 'input_json_delta') return this.chunk({ tool_calls: [{ index: this.tool, function: { arguments: d.partial_json } }] });
        return '';
      }
      case 'message_delta':
        Object.assign(this.usage, e.usage);
        this.stopReason = e.delta?.stop_reason;
        return this.chunk({}, STOP_TO_FINISH[this.stopReason] ?? 'stop');
      case 'message_stop': this.stopped = true; return '';
      case 'error': this.upstreamError = e.error; return '';
      default: return '';
    }
  }
  end(complete) {
    if (this.finished) return '';
    this.finished = true;
    if (this.upstreamError || !complete || !this.stopped) {
      const message = this.upstreamError?.message ?? 'A conexão com o provedor terminou antes do fim da resposta.';
      return `data: ${JSON.stringify({ error: { message: String(message).slice(0, 1000), type: 'server_error', code: null } })}\n\ndata: [DONE]\n\n`;
    }
    this.finalUsage = this.usage;
    const tail = this.includeUsage
      ? `data: ${JSON.stringify({ id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.alias, choices: [], usage: usageOf(this.usage) })}\n\n` : '';
    return `${tail}data: [DONE]\n\n`;
  }
  ping() { return ': ping\n\n'; }
}
