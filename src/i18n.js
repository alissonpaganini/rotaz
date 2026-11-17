// Idiomas do lado do servidor: os mesmos dicionários do painel (public/i18n/<código>.json), com o texto em
// português como chave. Mensagens com valores variáveis viajam como chave + argumentos e só viram texto na
// borda (resposta do painel, erro do gateway), já na língua de quem vai ler.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODES, detect, fill } from '../public/langs.js';

export { CODES, detect };

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'i18n');

/** Idioma do sistema operacional, como o Node o vê. O do sistema não muda com o processo rodando; ROTAZ_LANG o app define na partida. */
const osLocale = Intl.DateTimeFormat().resolvedOptions().locale;
export const systemLang = () => detect([process.env.ROTAZ_LANG, osLocale, process.env.LANG].filter(Boolean));

/** Preferência salva ('auto' ou um código) para o idioma efetivo. */
export const resolveLang = (pref) => (CODES.includes(pref) ? pref : systemLang());

const cache = new Map();
function dict(lang) {
  if (lang === 'pt-BR' || !CODES.includes(lang)) return {};
  if (!cache.has(lang)) {
    try { cache.set(lang, JSON.parse(fs.readFileSync(path.join(DIR, `${lang}.json`), 'utf8'))); } catch { cache.set(lang, {}); }
  }
  return cache.get(lang);
}

/** Marca um texto fixo como chave de tradução (para a extração), sem traduzir aqui. */
export const K = (s) => s;

/** Erro com chave e argumentos: a mensagem em português continua em `message` (registros, testes). */
export class LocalError extends Error {
  constructor(key, ...args) {
    super(fill(key, args.map((a) => (a instanceof Error ? a.message : a?.k ? fill(a.k, a.a ?? []) : a))));
    this.key = key;
    this.args = args;
  }
}
/** Mensagem com chave e argumentos, para dados (resultado de teste) e não para erros. */
export const M = (key, ...args) => ({ k: key, a: args });

/** Traduz um texto, um erro ou uma mensagem {k, a}. Argumentos que também são chaves são traduzidos. */
export function tr(lang, x) {
  if (x === null || x === undefined) return x;
  const d = dict(lang);
  const arg = (a) => (a instanceof Error || (a && typeof a === 'object' && 'k' in a) ? tr(lang, a) : typeof a === 'string' ? d[a] ?? a : a);
  if (x instanceof LocalError) return fill(d[x.key] ?? x.key, x.args.map(arg));
  if (x instanceof Error) return d[x.message] ?? x.message;
  if (typeof x === 'object' && 'k' in x) return fill(d[x.k] ?? x.k, (x.a ?? []).map(arg));
  return typeof x === 'string' ? d[x] ?? x : x;
}

/** Traduz os campos de texto de um resultado de teste (rótulo, mensagem, passos). */
export function localizeTest(lang, r) {
  if (!r) return r;
  return {
    ...r,
    label: tr(lang, r.label),
    message: tr(lang, r.message),
    ...(r.steps && { steps: r.steps.map((s) => ({ ...s, name: tr(lang, s.name), detail: tr(lang, s.detail) })) }),
  };
}
