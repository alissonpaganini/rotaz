// Análise de alias: onde o nome aparece (Claude Code no terminal e seletor do Claude Desktop) e sugestões que
// funcionam nos dois. Módulo puro, sem DOM: o painel importa direto e o servidor também (src/security.js).
//
// As duas regras, medidas nos binários (Claude Code 2.1.317 e Claude Desktop 4.16336):
// 1. O Claude Code só lista ids que contêm "claude" ou "anthropic". O prefixo `claude-` resolve.
// 2. O seletor do Claude Desktop esconde ids que citam outros fornecedores (lista abaixo), mesmo com o prefixo.
// Para os dois, o nome precisa do prefixo e de nenhum termo da lista. As sugestões trocam só o necessário:
// cada termo vira uma grafia próxima ("gpt" → "gept", "deepseek" → "deeepseek" ou "deep-seek", "mimo" → "miimo").

export const ALIAS_RE = /^claude-[a-z0-9][a-z0-9._-]{0,62}$/;
export const MAX_ALIAS = 64;
const PREFIX = 'claude-';

// Lista extraída do Claude Desktop 4.16336 (validador `Mo` do app.asar). Revise depois de atualizações do Desktop.
export const DESKTOP_DENY = /ark-code|astron|command-r|deepseek|doubao|gemini|gemma|glm|gpt|grok|hermes|hy3|kimi|lfm|\bling\b|llama|longcat|mimo|minimax|mistral|mixtral|moonshot|nemotron|openai|phi-|qianfan|qwen|tc-code|\bunic\b|yi-|stepfun|step-3|seed-|bytedance|hunyuan|granite|amazon\.nova|nova-|devstral|ministral|ernie|codex|arcee|trinity|abab|phi\d|\bk2\.|\bm2\.|jamba|arctic|solar|mercury|zamba|kat-coder|\bds-|dpsk/;
const DENY_ALL = new RegExp(DESKTOP_DENY.source, 'g');
const VOWEL = /[aeiou]/;
// Cortes naturais das marcas compostas; as demais usam a regra de sílabas.
const SPLITS = { openai: 'open-ai', deepseek: 'deep-seek', moonshot: 'moon-shot', minimax: 'mini-max', nemotron: 'nemo-tron', longcat: 'long-cat', stepfun: 'step-fun',
  bytedance: 'byte-dance', devstral: 'dev-stral', ministral: 'mini-stral', mixtral: 'mix-tral', mistral: 'mis-tral', hunyuan: 'hun-yuan', qianfan: 'qian-fan',
  doubao: 'dou-bao', gemini: 'ge-mini', mercury: 'mer-cury', granite: 'gran-ite', trinity: 'tri-nity', astron: 'as-tron', hermes: 'her-mes', arctic: 'arc-tic' };

/** Termos da lista que aparecem no nome, sem repetição e na ordem em que aparecem. */
export function blockedTerms(alias) {
  return [...new Set(Array.from(String(alias).toLowerCase().matchAll(DENY_ALL), (m) => m[0]))];
}

/**
 * Diagnóstico de um alias. `problem`: 'empty' | 'prefix' | 'chars' | 'length' | 'taken' | null.
 * `cli`: aparece no Claude Code. `desktop`: aparece também no seletor do Claude Desktop.
 */
export function analyzeAlias(raw, { taken } = {}) {
  const alias = String(raw ?? '').trim().toLowerCase();
  const blocked = blockedTerms(alias);
  let problem = null;
  if (!alias || alias === PREFIX || alias === 'claude') problem = 'empty';
  else if (!alias.startsWith(PREFIX)) problem = 'prefix';
  else if (alias.length > MAX_ALIAS) problem = 'length';
  else if (!ALIAS_RE.test(alias)) problem = 'chars';
  else if (taken?.has(alias)) problem = 'taken';
  const valid = !problem || problem === 'taken';
  return { alias, problem, valid, cli: valid, desktop: valid && !blocked.length, blocked };
}

// ---------- reescrita ----------
/** Grafia próxima de um termo bloqueado. `style`: 'vowel' (dobra uma vogal) ou 'split' (hífen entre as sílabas). */
function respell(term, style) {
  // "k2.5" e "m2.5": o ponto depois do número é o que casa; vira hífen.
  if (/^[km]2\.$/.test(term)) return `${term.slice(0, 2)}-`;
  if (style === 'tail') {
    // dobra a última consoante do meio ("kimi" → "kimmi", "gpt" → "gppt"): alternativa à primeira grafia.
    // Precisa ser no meio: dobrar a última letra deixaria o termo inteiro ("kimi" dentro de "kimii").
    for (let k = term.length - 2; k > 0; k--) if (/[a-z]/.test(term[k]) && !VOWEL.test(term[k])) return `${term.slice(0, k + 1)}${term[k]}${term.slice(k + 1)}`;
    return null;
  }
  if (style === 'split') {
    if (SPLITS[term]) return SPLITS[term];
    if (!/^[a-z]{6,}$/.test(term)) return null;
    // corta entre sílabas (vogal|consoante ou consoante|consoante), o mais perto do meio
    let best = -1;
    for (let k = 2; k <= term.length - 2; k++) {
      const ok = !VOWEL.test(term[k]) && (VOWEL.test(term[k - 1]) || !VOWEL.test(term[k - 1]));
      if (ok && (best < 0 || Math.abs(k - term.length / 2) < Math.abs(best - term.length / 2))) best = k;
    }
    return best < 0 ? null : `${term.slice(0, best)}-${term.slice(best)}`;
  }
  // dobra uma vogal: de preferência a primeira que não abre a palavra e ainda não é dupla ("moonshot" → "moonshoot",
  // "openai" → "opeenai"); se todas já forem duplas, a primeira ("deepseek" → "deeepseek"). Sem vogal, põe um "e".
  const single = (k) => term[k - 1] !== term[k] && term[k + 1] !== term[k];
  let i = -1;
  for (let k = 1; k < term.length && i < 0; k++) if (VOWEL.test(term[k]) && single(k)) i = k;
  for (let k = 1; k < term.length && i < 0; k++) if (VOWEL.test(term[k])) i = k;
  if (i < 0 && VOWEL.test(term[0])) i = 0;
  return i < 0 ? `${term[0]}e${term.slice(1)}` : `${term.slice(0, i + 1)}${term[i]}${term.slice(i + 1)}`;
}

/** Troca cada termo bloqueado até o nome passar. Devolve o nome e o que mudou. */
function rewrite(alias, style) {
  let s = alias;
  const changes = [];
  for (let n = 0; n < 16; n++) {
    DESKTOP_DENY.lastIndex = 0;
    const m = DESKTOP_DENY.exec(s);
    if (!m) return { alias: s, changes };
    const to = respell(m[0], style) ?? respell(m[0], 'vowel');
    const next = s.slice(0, m.index) + to + s.slice(m.index + m[0].length);
    if (next === s) break;
    changes.push({ from: m[0], to });
    s = next;
  }
  return blockedTerms(s).length ? null : { alias: s, changes };
}

/** Nome em formato válido: minúsculas, prefixo, só a-z 0-9 . _ -, até 64 caracteres sem cortar no meio de palavra. */
function tidy(raw) {
  let s = String(raw ?? '').toLowerCase().trim().replace(/[^a-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-._]+|[-._]+$/g, '');
  if (!s.startsWith(PREFIX)) s = PREFIX + s.replace(/^claude[-._]?/, '');
  if (s.length > MAX_ALIAS) {
    const cut = s.slice(0, MAX_ALIAS);
    const at = cut.lastIndexOf('-');
    s = at > PREFIX.length + 2 ? cut.slice(0, at) : cut;
  }
  s = s.replace(/[-._]+$/, '');
  return s.length > PREFIX.length ? s : null;
}

/**
 * Nome a partir do identificador real. `compact` tira o que só ocupa espaço: a organização ("nvidia/"),
 * datas de versão ("-20250514", "-2024-08-06") e "-instruct".
 */
export function slugFromUpstream(upstream, { compact = false } = {}) {
  let s = String(upstream ?? '').toLowerCase().trim().replace(/^models\//, '');
  if (!s) return null;
  if (compact) {
    s = s.slice(s.lastIndexOf('/') + 1) || s;
    s = s.replace(/[-_.]?20\d{2}-?[01]\d-?[0-3]\d(?=$|[-_.:])/g, '').replace(/-instruct(?=$|[-_.:])/g, '');
  }
  return tidy(s.replace(/[/:@]+/g, '-'));
}

const memo = new Map();
/**
 * Até `max` nomes que funcionam no CLI e no Desktop, do mais parecido com o digitado ao mais curto.
 * `input`: o que a pessoa digitou (pode estar vazio). `upstream`: identificador real, para propor a partir dele.
 * `taken`: nomes já usados (o sufixo "-2", "-3" evita conflito). Cada item: { alias, changes: [{ from, to }] }.
 */
export function aliasSuggestions(input, { upstream = '', taken = null, max = 3 } = {}) {
  const key = `${input}\u0000${upstream}\u0000${max}`;
  let base = memo.get(key);
  if (!base) {
    const seeds = [];
    const typed = tidy(input);
    if (typed && typed !== PREFIX.slice(0, -1)) seeds.push(typed);
    // o nome compacto basta; o completo (com organização e data) só quando o compacto não sai
    if (upstream) seeds.push(slugFromUpstream(upstream, { compact: true }) ?? slugFromUpstream(upstream));
    base = [];
    const seen = new Set([String(input ?? '').trim().toLowerCase()]);
    const perSeed = seeds.filter(Boolean).map((seed) => ['vowel', 'split', 'tail'].map((style) => {
      const r = rewrite(seed, style);
      // cortar o tamanho pode criar um termo novo ("-lingo" → "-ling"): passa de novo pela reescrita
      const fixed = r && (tidy(r.alias) === r.alias ? r : rewrite(tidy(r.alias) ?? '', style));
      return fixed && ALIAS_RE.test(fixed.alias) ? { alias: fixed.alias, changes: fixed === r ? r.changes : [...r.changes, ...fixed.changes] } : null;
    }).filter(Boolean));
    // Intercala as origens (o digitado e o identificador real): a primeira de cada vem antes das variações.
    for (let i = 0; i < 3; i++) for (const list of perSeed) {
      const c = list[i];
      if (c && !seen.has(c.alias)) { seen.add(c.alias); base.push(c); }
    }
    if (memo.size > 500) memo.clear();
    memo.set(key, base);
  }
  const out = [];
  for (const s of base) {
    if (out.length >= max) break;
    const alias = unique(s.alias, taken);
    if (alias && !out.some((o) => o.alias === alias)) out.push({ ...s, alias });
  }
  return out;
}

/** Acrescenta "-2", "-3"... quando o nome já existe. */
function unique(alias, taken) {
  if (!taken?.has(alias)) return alias;
  for (let n = 2; n < 100; n++) {
    const tail = `-${n}`;
    const a = alias.slice(0, MAX_ALIAS - tail.length).replace(/[-._]+$/, '') + tail;
    if (!taken.has(a) && !blockedTerms(a).length) return a;
  }
  return null;
}

/** O melhor nome para um modelo importado: funciona nos dois e não conflita. Reserva o nome em `taken`. */
export function bestAlias(upstream, taken) {
  const a = aliasSuggestions('', { upstream, taken, max: 1 })[0]?.alias ?? unique('claude-modelo', taken) ?? 'claude-modelo';
  taken?.add(a);
  return a;
}
