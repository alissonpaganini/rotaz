// Idiomas do Rotaz, usados pelo painel e pelo servidor (src/i18n.js importa este arquivo). Sem nada de navegador
// nem de Node aqui, para os dois lados lerem a mesma lista e a mesma regra.

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
export const CODES = LANGS.map((l) => l.code);
export const FALLBACK = 'en';

/** Primeiro idioma da lista que o Rotaz tem (aceita 'pt_BR' e 'pt-BR'); sem nenhum, inglês. */
export function detect(list) {
  for (const raw of list ?? []) {
    const tag = String(raw || '').toLowerCase().replace('_', '-');
    const base = tag.split('-')[0];
    if (base === 'pt') return 'pt-BR';
    if (base === 'zh') return 'zh-CN';
    const hit = CODES.find((c) => c.toLowerCase() === tag || c.toLowerCase() === base);
    if (hit) return hit;
  }
  return FALLBACK;
}

/** Troca `{0}`, `{1}`… pelos argumentos; os que faltam ficam como estão. */
export const fill = (s, args) => (args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (args[i] === undefined ? m : String(args[i]))) : s);
