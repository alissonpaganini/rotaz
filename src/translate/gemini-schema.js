// Ajustes que o formato Gemini exige: schema de ferramenta no subconjunto aceito, nomes de ferramenta válidos
// e o system sem a identidade do cliente.

/** Campos de schema que o backend aceita em `functionDeclarations` (subconjunto do Schema do Gemini). */
const SCHEMA_FIELDS = new Set([
  'type', 'format', 'description', 'nullable', 'enum', 'properties', 'required', 'items',
  'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern',
]);

/**
 * O `functionDeclarations` não aceita JSON Schema completo: `$schema`, `additionalProperties`,
 * `const`, uniões de tipo e `anyOf` derrubam a requisição inteira com 400. O que não tem
 * equivalente vira o mais próximo possível, e o que é só anotação é descartado.
 */
export function cleanSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > 12) return undefined;
  const out = {};

  if (Array.isArray(schema.type)) {
    const real = schema.type.filter((t) => t && t !== 'null');
    out.type = real[0] ?? 'string';
    if (schema.type.includes('null')) out.nullable = true;
  } else if (typeof schema.type === 'string') out.type = schema.type;

  for (const union of ['anyOf', 'oneOf']) {
    if (!Array.isArray(schema[union]) || !schema[union].length) continue;
    const variants = schema[union].filter((v) => v && typeof v === 'object' && v.type !== 'null');
    if (schema[union].some((v) => v?.type === 'null')) out.nullable = true;
    // Só literais: vira enum. Tipos diferentes: o proto aceita um tipo só, fica o primeiro.
    const literals = variants.filter((v) => v.const !== undefined || Array.isArray(v.enum));
    if (literals.length === variants.length && literals.length) {
      out.type = typeof (literals[0].const ?? literals[0].enum[0]) === 'string' ? 'string' : (out.type ?? 'string');
      out.type = 'string'; // o backend só aceita enum de texto
      out.enum = variants.flatMap((v) => (Array.isArray(v.enum) ? v.enum : [v.const])).filter((v) => v !== undefined && v !== null).map(String);
    } else {
      const first = cleanSchema(variants[0], depth + 1);
      if (first) Object.assign(out, first);
    }
  }

  if (schema.const !== undefined && schema.const !== null && !out.enum) { out.enum = [String(schema.const)]; out.type = 'string'; }
  if (Array.isArray(schema.enum)) { out.enum = schema.enum.filter((v) => v !== null && v !== undefined).map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))); out.type = 'string'; }
  if (out.enum && !out.type) out.type = 'string';
  if (!out.enum) delete out.enum;

  if (typeof schema.description === 'string' && schema.description) out.description = schema.description.slice(0, 1024);
  if (schema.nullable === true) out.nullable = true;
  // allOf: as partes se somam (propriedades, obrigatórios, tipo).
  if (Array.isArray(schema.allOf)) {
    for (const part of schema.allOf.map((x) => cleanSchema(x, depth + 1)).filter(Boolean)) {
      if (part.properties) out.properties = { ...out.properties, ...part.properties };
      if (part.required) out.required = [...new Set([...(out.required ?? []), ...part.required])];
      out.type ??= part.type;
      out.description ??= part.description;
    }
  }

  if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
    const props = {};
    for (const [name, sub] of Object.entries(schema.properties)) {
      const clean = cleanSchema(sub, depth + 1);
      // Sem tipo (ex.: só $ref) o backend não sabe validar: cai em texto, ou objeto quando tem propriedades.
      props[name] = clean?.type ? clean : { ...clean, type: clean?.properties ? 'object' : 'string' };
    }
    if (Object.keys(props).length) { out.properties = { ...out.properties, ...props }; out.type = 'object'; }
  }
  if (Array.isArray(schema.required) || out.required) {
    const known = Object.keys(out.properties ?? {});
    const all = [...new Set([...(out.required ?? []), ...(Array.isArray(schema.required) ? schema.required : [])])];
    const req = all.filter((r) => typeof r === 'string' && (!known.length || known.includes(r)));
    if (req.length) out.required = req; else delete out.required;
  }

  const items = Array.isArray(schema.items) ? schema.items[0] : schema.items;
  if (items && typeof items === 'object') { const clean = cleanSchema(items, depth + 1); if (clean) out.items = clean.type ? clean : { ...clean, type: clean.properties ? 'object' : 'string' }; }
  if (out.type === 'array' && !out.items) out.items = { type: 'string' };

  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (typeof schema[key] === 'number' && Number.isFinite(schema[key])) out[key] = schema[key];
  }
  // exclusiveMinimum/Maximum não existem no backend (400 "Unknown name"): viram o limite inclusivo mais próximo.
  if (typeof schema.exclusiveMinimum === 'number' && out.minimum === undefined) out.minimum = schema.exclusiveMinimum;
  if (typeof schema.exclusiveMaximum === 'number' && out.maximum === undefined) out.maximum = schema.exclusiveMaximum;
  if (typeof schema.pattern === 'string' && out.type === 'string') out.pattern = schema.pattern;
  // O backend só aceita estes formatos; outro (uri, email, uuid...) volta 400.
  const formats = { string: ['enum', 'date-time'], integer: ['int32', 'int64'], number: ['float', 'double'] }[out.type] ?? [];
  if (typeof schema.format === 'string' && formats.includes(schema.format)) out.format = schema.format;

  // Lista do que o backend conhece. Antes, todo campo fora de uma lista de proibidos passava adiante, e um
  // só desconhecido (ex.: exclusiveMinimum nas ferramentas do Claude Code) derrubava a requisição inteira.
  for (const k of Object.keys(out)) if (!SCHEMA_FIELDS.has(k) || out[k] === undefined) delete out[k];
  return out;
}

/**
 * O backend recusa `parameters` que não declare `type: "object"` na raiz, e um único nome de
 * ferramenta fora da gramática derruba a requisição inteira.
 */
export function toParametersSchema(raw) {
  const clean = cleanSchema(raw) ?? {};
  if (clean.type === 'object') return clean;
  if (clean.properties && typeof clean.properties === 'object') return { ...clean, type: 'object' };
  return { type: 'object', properties: {}, ...(clean.description ? { description: clean.description } : {}) };
}


export function safeToolName(name) {
  const s = String(name ?? '').trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  const withHead = /^[A-Za-z_]/.test(s) ? s : `t_${s}`;
  return withHead.slice(0, 64) || 'tool';
}

// ---------- filtro de identidade ----------

/**
 * O backend responde 429 RESOURCE_EXHAUSTED (falso: não é cota) quando encontra no system prompt
 * o nome de um harness concorrente. Só a frase de identidade sai; o resto da instrução fica.
 */
const COMPETITOR_IDENTITY = [
  /\byou are claude code\b[^\n]*/gi,
  /\byou are a claude agent\b[^\n]*/gi,
  /\byou are an ai assistant created by anthropic\b[^\n]*/gi,
  /\bbuilt on anthropic'?s claude agent sdk\b[^\n]*/gi,
  /\bvocê é (?:o|a) claude code\b[^\n]*/gi,
  /\bvocê é um agente claude\b[^\n]*/gi,
  /\bconstruído sobre o claude agent sdk\b[^\n]*/gi,
];

export function sanitizeSystemText(text) {
  let out = String(text ?? '');
  for (const re of COMPETITOR_IDENTITY) out = out.replace(re, '');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
