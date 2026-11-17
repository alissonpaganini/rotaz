// Cliente fala Anthropic Messages (Claude Code); o Cloud Code fala o formato Gemini dentro do envelope.
// Este módulo converte só o conteúdo: `contents`, `systemInstruction`, `generationConfig` e `tools`.
import crypto from 'node:crypto';
import { genId, estimateTokens, toolExtras, ToolNames, blocks, systemText, documentText, REASONING_SIGNATURE } from './common.js';
import { toParametersSchema, safeToolName, sanitizeSystemText } from './gemini-schema.js';

/**
 * Nome de ferramenta aceito pelo Gemini, com o original guardado para a volta. Antes o mapa guardava o nome já
 * trocado (ex.: "mcp__claude-in-chrome__navigate" voltava como "mcp__claude_in_chrome__navigate") e o
 * Claude Code recebia uma ferramenta que não existe.
 */
function toolName(names, raw) {
  const original = String(raw ?? '');
  if (names.toShort.has(original)) return names.toShort.get(original);
  let s = safeToolName(original);
  if (names.toOriginal.has(s) && names.toOriginal.get(s) !== original) s = `${s.slice(0, 55)}_${crypto.createHash('sha256').update(original).digest('hex').slice(0, 8)}`;
  names.toShort.set(original, s);
  names.toOriginal.set(s, original);
  return s;
}

/**
 * Assinatura de raciocínio que o Cloud Code exige de volta nos turnos com functionCall. O histórico
 * que o Claude Code reenvia não tem a original, então a requisição leva este marcador — sem ele o
 * upstream responde 400 "thought_signature is required".
 */
const THOUGHT_SENTINEL = 'skip_thought_signature_validator';


function imagePart(b) {
  const s = b?.source;
  if (s?.type === 'base64' && s.data) return { inlineData: { mimeType: s.media_type || 'image/png', data: s.data } };
  // URL remota: o Gemini não busca, mas aceita a forma fileData em alguns modelos.
  if (s?.type === 'url' && s.url) return { fileData: { mimeType: s.media_type || 'image/png', fileUri: s.url } };
  return null;
}


/** Junta partes de texto num único item: o Gemini recusa `parts` com objeto vazio. */
function pushPart(parts, part) {
  if (!part) return;
  if (part.text !== undefined && !String(part.text).length) return;
  parts.push(part);
}

/** O Gemini recusa dois turnos seguidos com o mesmo `role`: as partes se fundem. */
function addContent(contents, role, parts) {
  if (!parts.length) return;
  const last = contents[contents.length - 1];
  if (last && last.role === role) last.parts.push(...parts);
  else contents.push({ role, parts });
}

function userParts(content, contents) {
  const rest = [];
  const results = [];
  for (const b of blocks(content)) {
    switch (b?.type) {
      case 'tool_result': {
        const texts = [];
        const media = [];
        for (const x of blocks(b.content)) {
          if (x.type === 'text') texts.push(x.text);
          else if (x.type === 'image') { const p = imagePart(x); if (p) media.push(p); }
        }
        const text = texts.join('\n') || (media.length ? '[imagem anexada na mensagem seguinte]' : '');
        // functionResponse.response precisa ser objeto.
        results.push({ functionResponse: { name: b.tool_use_name || b.tool_use_id || 'tool', response: { result: b.is_error ? `[erro da ferramenta] ${text}` : text } } });
        rest.push(...media);
        break;
      }
      case 'text': pushPart(rest, { text: b.text }); break;
      case 'image': pushPart(rest, imagePart(b)); break;
      case 'document': pushPart(rest, { text: documentText(b) }); break;
      default: break;
    }
  }
  // Os resultados de ferramenta vão antes: o modelo espera a resposta colada na chamada.
  addContent(contents, 'user', [...results, ...rest]);
}

function assistantParts(content, contents, names) {
  const parts = [];
  for (const b of blocks(content)) {
    if (b?.type === 'text') { pushPart(parts, { text: b.text }); continue; }
    if (b?.type !== 'tool_use') continue; // thinking não tem equivalente no Cloud Code
    const sig = toolExtras.get(b.id)?.google?.thought_signature ?? THOUGHT_SENTINEL;
    parts.push({
      functionCall: { name: toolName(names, b.name), args: b.input && typeof b.input === 'object' ? b.input : {} },
      thoughtSignature: sig,
    });
  }
  addContent(contents, 'model', parts);
}

function systemInstructionOf(system, extra) {
  const text = [system, ...extra].map(systemText).filter(Boolean).join('\n\n');
  const clean = sanitizeSystemText(text);
  return clean ? { parts: [{ text: clean }] } : undefined;
}

const SAFETY = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
];

function generationConfig(body, t) {
  let max = body.max_tokens ?? t.maxOutputTokens ?? 8192;
  if (t.maxOutputTokens && max > t.maxOutputTokens) max = t.maxOutputTokens;
  // Só o que o cliente pediu: topK/topP inventados aqui (40 e 1.0) não valem para todos os modelos do plano.
  const cfg = { maxOutputTokens: max };
  if (typeof body.top_p === 'number') cfg.topP = body.top_p;
  if (typeof body.top_k === 'number') cfg.topK = body.top_k;
  if (body.temperature !== undefined && body.temperature !== null) cfg.temperature = Math.min(2, Math.max(0, body.temperature));
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) cfg.stopSequences = body.stop_sequences.slice(0, 4);

  // Raciocínio: o Gemini usa orçamento de tokens, não um rótulo. `thinking` do Anthropic vem em tokens.
  const budget = body.thinking?.type === 'enabled'
    ? Number(body.thinking.budget_tokens) || Math.min(8192, Math.floor(max / 2))
    : 0;
  if (budget > 0) {
    cfg.thinkingConfig = { thinkingBudget: budget, includeThoughts: true };
    // O upstream rejeita maxOutputTokens <= thinkingBudget.
    if (cfg.maxOutputTokens <= budget) cfg.maxOutputTokens = budget + 1;
  }
  return cfg;
}

function toolConfig(body, names) {
  const tc = body.tool_choice;
  if (!tc) return undefined;
  if (tc.type === 'none') return { functionCallingConfig: { mode: 'NONE' } };
  if (tc.type === 'any') return { functionCallingConfig: { mode: 'ANY' } };
  if (tc.type === 'tool') return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [toolName(names, tc.name)] } };
  return { functionCallingConfig: { mode: 'AUTO' } };
}

/**
 * @param body requisição Anthropic já validada
 * @param t    { upstream, maxOutputTokens, reasoningEffort }
 * @returns { request, names, thinking, inputEstimate }
 */
export function anthropicRequestToGemini(body, t) {
  const names = new ToolNames();
  const contents = [];
  const inlineSystem = [];

  for (const m of body.messages ?? []) {
    if (m.role === 'system') { inlineSystem.push(m.content); continue; }
    if (m.role === 'assistant') assistantParts(m.content, contents, names);
    else userParts(m.content, contents, names);
  }

  // O Cloud Code exige que a conversa comece e termine com o usuário.
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: '(continue)' }] });
  if (contents[0].role !== 'user') contents.unshift({ role: 'user', parts: [{ text: '(continue)' }] });
  if (contents[contents.length - 1].role !== 'user') contents.push({ role: 'user', parts: [{ text: '(continue)' }] });

  const systemInstruction = systemInstructionOf(body.system, inlineSystem);

  const request = { contents, generationConfig: generationConfig(body, t) };
  if (systemInstruction) request.systemInstruction = systemInstruction;

  const tools = (body.tools ?? []).filter((x) => x?.input_schema && (!x.type || x.type === 'custom'));
  if (tools.length) {
    request.tools = [{
      functionDeclarations: tools.map((x) => ({
        name: toolName(names, x.name),
        description: String(x.description ?? '').slice(0, 1024),
        parameters: toParametersSchema(x.input_schema),
      })),
    }];
    const cfg = toolConfig(body, names);
    if (cfg) request.toolConfig = cfg;
  }

  return {
    request,
    names,
    thinking: body.thinking?.type === 'enabled' || body.thinking?.type === 'adaptive',
    inputEstimate: estimateTokens([body.system, body.messages, body.tools]),
  };
}

/** Resposta não-streaming: um objeto Gemini já montado vira a mensagem Anthropic. */
export function geminiResponseToAnthropic(response, { alias, names, thinking }) {
  const candidate = response?.candidates?.[0];
  if (!candidate) throw new Error('Resposta sem candidates');
  const content = [];
  const calls = [];
  let text = '';
  let reasoning = '';

  for (const part of candidate.content?.parts ?? []) {
    if (part.functionCall?.name) {
      const id = part.functionCall.id || genId('toolu_');
      calls.push({ type: 'tool_use', id, name: names.original(part.functionCall.name), input: part.functionCall.args ?? {} });
      if (part.thoughtSignature) toolExtras.set(id, { google: { thought_signature: part.thoughtSignature } });
      continue;
    }
    if (typeof part.text === 'string') {
      if (part.thought) reasoning += part.text;
      else text += part.text;
    }
  }

  if (reasoning && thinking) content.push({ type: 'thinking', thinking: reasoning, signature: REASONING_SIGNATURE });
  if (text) content.push({ type: 'text', text });
  content.push(...calls);

  const usage = usageOf(response.usageMetadata);
  return {
    id: genId('msg_'),
    type: 'message',
    role: 'assistant',
    model: alias,
    content,
    stop_reason: calls.length ? 'tool_use' : stopReasonOf(candidate.finishReason),
    stop_sequence: null,
    usage,
  };
}

const FINISH = { STOP: 'end_turn', MAX_TOKENS: 'max_tokens', SAFETY: 'refusal', RECITATION: 'refusal', OTHER: 'end_turn', MALFORMED_FUNCTION_CALL: 'end_turn' };
/** finishReason do Gemini como stop_reason Anthropic. */
export const stopReasonOf = (r) => FINISH[String(r ?? '').toUpperCase()] ?? 'end_turn';

export function usageOf(um) {
  if (!um) return { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
  return {
    input_tokens: Number(um.promptTokenCount ?? 0),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: Number(um.cachedContentTokenCount ?? 0),
    output_tokens: Number(um.candidatesTokenCount ?? 0) + Number(um.thoughtsTokenCount ?? 0),
  };
}

