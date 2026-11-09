// Idiomas do painel. As chaves são o próprio texto em português; cada língua tem um dicionário em
// /i18n/<código>.json (texto em português -> tradução). Sem tradução, o texto em português aparece.
// A escolha vale nesta ordem: escolhida na abertura (ainda sem login) > salva no painel > idioma do sistema.

/** Línguas disponíveis, cada uma com o nome na própria língua. */
export const LANGS = [
  { code: 'pt-BR', name: 'Português (Brasil)' },
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
  { code: 'zh-CN', name: '简体中文' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'de', name: 'Deutsch' },
  { code: 'fr', name: 'Français' },
];
const CODES = LANGS.map((l) => l.code);
export const FALLBACK = 'en';

/** Idioma do sistema mais próximo dos disponíveis; sem nenhum, inglês. */
export function detect(list = navigator.languages?.length ? navigator.languages : [navigator.language]) {
  for (const raw of list ?? []) {
    const tag = String(raw || '').toLowerCase();
    const base = tag.split('-')[0];
    if (base === 'pt') return 'pt-BR';
    if (base === 'zh') return 'zh-CN';
    const hit = CODES.find((c) => c.toLowerCase() === tag || c.toLowerCase() === base);
    if (hit) return hit;
  }
  return FALLBACK;
}

/** 'auto' vira o idioma do sistema; um código desconhecido também. */
export const resolve = (pref) => (CODES.includes(pref) ? pref : detect());

const PENDING = 'rotaz-lang';
/** Escolha feita antes do login (na abertura): fica no navegador até poder ser salva no painel. */
export const pending = {
  get() { try { const v = localStorage.getItem(PENDING); return v === 'auto' || CODES.includes(v) ? v : null; } catch { return null; } },
  set(v) { try { localStorage.setItem(PENDING, v); } catch { /* sem armazenamento */ } },
  clear() { try { localStorage.removeItem(PENDING); } catch { /* sem armazenamento */ } },
};

const state = { pref: 'auto', lang: 'pt-BR', dict: {} };
export const current = () => state.lang;
export const preference = () => state.pref;
/** Locale para números e datas. */
export const locale = () => state.lang;

/** Carrega o dicionário da língua (o português não precisa de arquivo). */
export async function setLanguage(pref) {
  const lang = resolve(pref);
  let dict = {};
  if (lang !== 'pt-BR') {
    try { dict = await (await fetch(`/i18n/${lang}.json`)).json(); } catch { dict = {}; }
  }
  Object.assign(state, { pref: pref || 'auto', lang, dict });
  document.documentElement.lang = lang;
  return lang;
}

const fill = (s, args) => (args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (args[i] === undefined ? m : String(args[i]))) : s);

/** Traduz um texto. `{0}`, `{1}`… recebem os argumentos. */
export function t(key, ...args) {
  return fill(state.dict[key] ?? key, args);
}

/** Como t(), mas os argumentos podem ser elementos: devolve uma lista de textos e nós, na ordem da língua. */
export function tn(key, ...nodes) {
  const s = state.dict[key] ?? key;
  const out = [];
  let last = 0;
  for (const m of s.matchAll(/\{(\d+)\}/g)) {
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(nodes[Number(m[1])] ?? m[0]);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
