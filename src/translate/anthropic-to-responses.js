// Cliente fala Anthropic Messages (Claude Code); provedor fala a API Responses da OpenAI
// (Codex, ChatGPT, Muse Code, Grok Build). Pedido, resposta única e streaming.
import { genId, safeParse, ToolNames, blocks, systemText, REASONING_SIGNATURE, AnthropicStreamWriter } from './common.js';


function imageUrl(b) {
  const s = b.source;
  if (s?.type === 'base64') return `data:${s.media_type};base64,${s.data}`;
  if (s?.type === 'url') return s.url;
  return null;
}

function toolOutput(b) {
  const texts = [];
  for (const x of blocks(b.content)) if (x?.type === 'text') texts.push(x.text);
  const text = texts.join('\n') || (blocks(b.content).some((x) => x?.type === 'image') ? '[imagem]' : '');
  return b.is_error ? `[erro da ferramenta] ${text}` : text;
}

/**
 * @param body requisição Anthropic já validada
 * @param t    { upstream, maxOutputTokens, reasoningEffort }
 * Devolve { payload, names, thinking }.
 */
export function anthropicRequestToResponses(body, t) {
  const names = new ToolNames();
  const input = [];
  const sys = [systemText(body.system)];
  for (const m of body.messages) {
    if (m.role === 'system') { sys.push(systemText(m.content)); continue; }
    if (m.role === 'assistant') {
      const text = [];
      const flush = () => { if (text.length) { input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: text.join('\n') }] }); text.length = 0; } };
      for (const b of blocks(m.content)) {
        if (b?.type === 'text' && b.text) text.push(b.text);
        else if (b?.type === 'tool_use') { flush(); input.push({ type: 'function_call', call_id: b.id, name: names.short(b.name), arguments: JSON.stringify(b.input ?? {}) }); }
      }
      flush();
      continue;
    }
    // usuário: resultados de ferramenta viram function_call_output; o resto, uma mensagem
    const parts = [];
    for (const b of blocks(m.content)) {
      if (b?.type === 'tool_result') input.push({ type: 'function_call_output', call_id: b.tool_use_id, output: toolOutput(b) });
      else if (b?.type === 'text' && b.text) parts.push({ type: 'input_text', text: b.text });
      else if (b?.type === 'image') { const u = imageUrl(b); if (u) parts.push({ type: 'input_image', image_url: u }); }
      else if (b?.type === 'document' && b.source?.type === 'text') parts.push({ type: 'input_text', text: b.source.data });
    }
    if (parts.length) input.push({ type: 'message', role: 'user', content: parts });
  }
  // chamadas sem resposta (histórico compactado) quebrariam o pedido: ganham um resultado vazio
  const answered = new Set(input.filter((i) => i.type === 'function_call_output').map((i) => i.call_id));
  for (let i = input.length - 1; i >= 0; i--) {
    const it = input[i];
    if (it.type === 'function_call' && !answered.has(it.call_id)) input.splice(i + 1, 0, { type: 'function_call_output', call_id: it.call_id, output: '[sem resultado]' });
  }

  const payload = { model: t.upstream, input };
  const instructions = sys.filter(Boolean).join('\n\n');
  if (instructions) payload.instructions = instructions;
  let max = body.max_tokens;
  if (t.maxOutputTokens && max > t.maxOutputTokens) max = t.maxOutputTokens;
  if (max) payload.max_output_tokens = max;
  if (body.temperature !== undefined) payload.temperature = body.temperature;
  if (body.top_p !== undefined) payload.top_p = body.top_p;
  const tools = (body.tools || []).filter((x) => x.input_schema && (!x.type || x.type === 'custom'));
  if (tools.length) {
    payload.tools = tools.map((x) => {
      const { $schema, ...parameters } = x.input_schema;
      return { type: 'function', name: names.short(x.name), description: x.description ?? '', parameters, strict: false };
    });
    const tc = body.tool_choice;
    if (tc?.type === 'any') payload.tool_choice = 'required';
    else if (tc?.type === 'none') payload.tool_choice = 'none';
    else if (tc?.type === 'tool') payload.tool_choice = { type: 'function', name: names.short(tc.name) };
    else payload.tool_choice = 'auto';
    payload.parallel_tool_calls = !tc?.disable_parallel_tool_use;
  }
  const thinking = body.thinking?.type === 'enabled' || body.thinking?.type === 'adaptive';
  const effort = t.reasoningEffort || (thinking ? 'medium' : null);
  if (effort) payload.reasoning = { effort, summary: 'auto' };
  if (body.stream) payload.stream = true;
  return { payload, names, thinking };
}

const usageOf = (u) => {
  const cached = u?.input_tokens_details?.cached_tokens ?? 0;
  return { input_tokens: Math.max(0, (u?.input_tokens ?? 0) - cached), cache_creation_input_tokens: 0, cache_read_input_tokens: cached, output_tokens: u?.output_tokens ?? 0 };
};

const stopOf = (r, sawTool) => (sawTool ? 'tool_use'
  : r?.status === 'incomplete' ? (r.incomplete_details?.reason === 'max_output_tokens' ? 'max_tokens' : 'end_turn') : 'end_turn');

/** Resposta Responses (objeto `response`) para mensagem Anthropic. */
export function responsesResponseToAnthropic(r, { alias, names, thinking }) {
  const res = r?.response && typeof r.response === 'object' && Array.isArray(r.response.output) ? r.response : r;
  if (!Array.isArray(res?.output)) throw new Error('Resposta sem output');
  if (res.error) throw new Error(String(res.error.message ?? res.error));
  const content = [];
  let reasoning = '';
  for (const item of res.output) {
    if (item.type === 'reasoning') reasoning += (item.summary ?? []).map((s) => s.text ?? '').join('\n');
    else if (item.type === 'message') {
      const text = (item.content ?? []).map((c) => (c.type === 'output_text' ? c.text : c.type === 'refusal' ? c.refusal : '')).join('');
      if (text) content.push({ type: 'text', text });
    } else if (item.type === 'function_call') {
      content.push({ type: 'tool_use', id: item.call_id || genId('toolu_'), name: names.original(item.name), input: safeParse(item.arguments || '{}', {}) ?? {} });
    }
  }
  if (reasoning && thinking) content.unshift({ type: 'thinking', thinking: reasoning, signature: REASONING_SIGNATURE });
  const sawTool = content.some((b) => b.type === 'tool_use');
  return { id: genId('msg_'), type: 'message', role: 'assistant', model: alias, content, stop_reason: stopOf(res, sawTool), stop_sequence: null, usage: usageOf(res.usage) };
}

/** Junta os eventos SSE de um stream Responses: o `response.completed` traz a resposta inteira. */
export function collectResponsesStream(events) {
  const done = events.find((e) => ['response.completed', 'response.incomplete'].includes(e.type))?.response;
  if (done) return done;
  const failed = events.find((e) => e.type === 'response.failed' || e.type === 'error');
  if (failed) throw new Error(String(failed.response?.error?.message ?? failed.error?.message ?? failed.message ?? 'O provedor interrompeu a resposta.'));
  // sem o evento final: monta pelo que chegou
  const output = events.filter((e) => e.type === 'response.output_item.done').map((e) => e.item);
  return { output, status: 'incomplete' };
}

/**
 * Máquina de estados: eventos Responses -> eventos Anthropic. Blocos saem em sequência (texto, raciocínio e
 * cada chamada de ferramenta abrem e fecham em ordem); o fim normal é `response.completed`.
 */
export class ResponsesToAnthropicStream extends AnthropicStreamWriter {
  constructor(opts) {
    super(opts);
    this.tools = new Map(); // output_index -> { id, name }
    this.sawTool = false;
    this.completed = false;
    this.response = null;
  }

  push(e) {
    let s = this.start();
    switch (e?.type) {
      case 'response.output_text.delta': return s + this.textDelta('text', e.delta);
      case 'response.refusal.delta': return s + this.textDelta('text', e.delta);
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        return this.thinking ? s + this.textDelta('thinking', e.delta) : s;
      case 'response.output_item.added':
        if (e.item?.type === 'function_call') {
          const tool = { id: e.item.call_id || genId('toolu_'), name: this.names.original(e.item.name) };
          this.tools.set(e.output_index, tool);
          this.sawTool = true;
          return s + this.openBlock(tool, { type: 'tool_use', id: tool.id, name: tool.name, input: {} });
        }
        return s;
      case 'response.function_call_arguments.delta': {
        const tool = this.tools.get(e.output_index);
        if (!tool || this.open !== tool || !e.delta) return s;
        return s + this.argDelta(e.delta);
      }
      case 'response.output_item.done':
        if (e.item?.type === 'function_call' && this.open === this.tools.get(e.output_index)) return s + this.closeOpen();
        return s;
      case 'response.completed':
      case 'response.incomplete':
        this.completed = true;
        this.response = e.response ?? null;
        return s;
      case 'response.failed':
        this.upstreamError = { message: e.response?.error?.message ?? 'O provedor interrompeu a resposta.' };
        return s;
      case 'error':
        this.upstreamError = { message: e.message ?? e.error?.message ?? 'Erro do provedor.' };
        return s;
      default: return s;
    }
  }

  end(complete) {
    return this.close(complete, () => ({ usage: this.response?.usage ? usageOf(this.response.usage) : this.estimatedUsage(), stop: stopOf(this.response, this.sawTool) }));
  }
}
