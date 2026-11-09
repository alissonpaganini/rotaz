// Painel do Rotaz. JS puro, sem build. Design System "Papel": regras em DESIGN.md.
// Todo texto entra por textContent (nunca innerHTML): dados vindos de provedores não viram HTML.
// Idiomas carregados com import dinâmico: se o servidor for de uma versão anterior (sem /i18n.js), um import
// estático derrubaria o módulo inteiro e a tela ficaria em branco. Assim o painel abre em português.
const fill = (s, a) => s.replace(/\{(\d+)\}/g, (m, i) => (a[i] === undefined ? m : String(a[i])));
const i18n = await import('/i18n.js').catch(() => ({
  LANGS: [{ code: 'pt-BR', name: 'Português (Brasil)' }],
  t: (k, ...a) => fill(k, a),
  tn: (k, ...n) => k.split(/(\{\d+\})/).filter(Boolean).map((p) => { const m = /^\{(\d+)\}$/.exec(p); return m ? n[m[1]] ?? p : p; }),
  setLanguage: async () => 'pt-BR',
  pending: { get: () => null, set() {}, clear() {} },
  current: () => 'pt-BR',
  preference: () => 'auto',
  detect: () => 'pt-BR',
}));
const { LANGS, t: L, tn: Ln, setLanguage, pending: pendingLang, current: currentLang, detect: detectLang } = i18n;
/** Marca textos de tabelas fixas como chaves de tradução; a tradução acontece onde eles aparecem. */
const LK = (s) => s;
// Idioma antes de qualquer texto: escolhido na abertura (ainda sem login) > salvo no painel > o do sistema.
const firstStatus = await fetch('/api/auth/status').then((r) => r.json()).catch(() => ({}));
await setLanguage(pendingLang.get() ?? firstStatus.ui?.lang ?? 'auto');

const root = document.getElementById('app');
const state = { view: 'overview', sub: [], provider: null, tests: {}, timer: null, sel: {}, live: {}, mfilter: {}, aliases: [], bulk: null, catalog: null, seen: new Set() };

// ---------- DOM ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}
const NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) el.setAttribute(k, v);
  el.append(...kids);
  return el;
}
/** Ícones Phosphor (MIT) do sprite local. */
// A versão no endereço descarta cópias antigas do sprite que ficaram no cache (antes, 24 h sem conferir).
// Hoje o servidor revalida por ETag, então ícones novos aparecem sem precisar mudar este número.
const SPRITE = '/vendor/icons.svg?v=2';
/** Logotipo Rotaz (public/logo.svg, vetorizado da arte original). Segue a cor do texto, nos dois temas. */
const wordmark = (cls = '') => svg('svg', { class: `wordmark ${cls}`, viewBox: '0 0 1457 315', role: 'img', 'aria-label': 'Rotaz' },
  svg('use', { href: '/logo.svg#rotaz', width: 1457, height: 315 }));
function icon(name, cls = '') {
  return svg('svg', { class: `ico ${cls}`, 'aria-hidden': 'true', focusable: 'false' }, svg('use', { href: `${SPRITE}#i-${name}` }));
}

// ---------- movimento (Motion, MIT) ----------
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const M = window.Motion;
const EASE = [0.2, 0.8, 0.2, 1];
function animate(el, kf, opts = {}) {
  if (!el || reduced() || !M) return null;
  return M.animate(el, kf, { duration: 0.32, ease: EASE, ...opts });
}
/** Entrada escalonada dos blocos de uma tela. */
function enter(container, selector = ':scope > *') {
  if (reduced() || !M) return;
  const items = [...container.querySelectorAll(selector)].slice(0, 24);
  if (items.length) M.animate(items, { opacity: [0, 1], transform: ['translateY(8px)', 'translateY(0)'] }, { duration: 0.32, ease: EASE, delay: M.stagger(0.04) });
}
/** Números contam até o valor na primeira exibição. */
function countUp(el, to, format) {
  if (reduced() || !M || !(to > 0)) { el.textContent = format(to); return; }
  M.animate(0, to, { duration: 0.8, ease: EASE, onUpdate: (v) => { el.textContent = format(Math.round(v)); } });
}
function growBars(container) {
  if (reduced() || !M) return;
  const bars = [...container.querySelectorAll('.meter > i')];
  if (bars.length) M.animate(bars, { transform: ['scaleX(0)', 'scaleX(1)'] }, { duration: 0.6, ease: EASE, delay: M.stagger(0.03) });
}

// ---------- flutuantes (Floating UI, MIT) ----------
const FUI = window.FloatingUIDOM;
async function place(anchor, floating, placement = 'bottom-end') {
  if (!FUI) return;
  // No app desktop a barra de título cobre o topo (--titlebar-h): a área livre começa abaixo dela,
  // para dicas e menus virarem para baixo em vez de ficarem escondidos sob a barra.
  const top = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--titlebar-h')) || 0) + 8;
  const padding = { top, right: 8, bottom: 8, left: 8 };
  const { x, y } = await FUI.computePosition(anchor, floating, { placement, strategy: 'fixed', middleware: [FUI.offset(6), FUI.flip({ padding }), FUI.shift({ padding })] });
  Object.assign(floating.style, { left: `${x}px`, top: `${y}px` });
}

let openMenu = null;
function closeMenu() { openMenu?.(); openMenu = null; }
/** Menu de ações. itens: [{ label, icon, onClick, danger }] ou 'sep'. */
function menu(anchor, items) {
  closeMenu();
  const el = h('div', { class: 'menu', role: 'menu' }, items.filter(Boolean).map((it) => (it === 'sep' ? h('hr') : h('button', {
    type: 'button', role: 'menuitem', class: it.danger ? 'danger' : undefined, disabled: it.disabled,
    onclick: () => { closeMenu(); it.onClick(); },
  }, it.icon && icon(it.icon), it.label))));
  el.style.left = '-9999px';
  document.body.append(el);
  place(anchor, el);
  animate(el, { opacity: [0, 1], transform: ['translateY(-4px)', 'translateY(0)'] }, { duration: 0.18 });
  const onDoc = (e) => { if (!el.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) closeMenu(); };
  const onKey = (e) => { if (e.key === 'Escape') { closeMenu(); anchor.focus(); } };
  setTimeout(() => document.addEventListener('pointerdown', onDoc), 0);
  document.addEventListener('keydown', onKey);
  openMenu = () => { el.remove(); document.removeEventListener('pointerdown', onDoc); document.removeEventListener('keydown', onKey); };
  el.querySelector('button')?.focus();
}
const moreButton = (items, label = L('Mais ações')) => h('button', { type: 'button', class: 'btn ghost sm icon-only', 'aria-label': label, 'aria-haspopup': 'menu',
  onclick: (e) => menu(e.currentTarget, typeof items === 'function' ? items() : items) }, icon('dots-three'));

// Dicas: qualquer elemento com data-tip.
let tipEl = null;
document.addEventListener('mouseover', (e) => {
  const t = e.target.closest?.('[data-tip]');
  if (!t || !FUI) return;
  tipEl?.remove();
  tipEl = h('div', { class: 'tooltip', role: 'tooltip' }, t.dataset.tip);
  tipEl.style.left = '-9999px';
  document.body.append(tipEl);
  place(t, tipEl, 'top');
  animate(tipEl, { opacity: [0, 1] }, { duration: 0.12 });
  t.addEventListener('mouseleave', () => { tipEl?.remove(); tipEl = null; }, { once: true });
});

// ---------- API ----------
class ApiError extends Error { constructor(s, m) { super(m); this.status = s; } }
async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json', 'x-gateway-csrf': '1', 'x-rotaz-lang': currentLang() }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && !path.startsWith('/api/auth/')) { stopPolling(); boot(); throw new ApiError(401, L('Sessão expirada.')); }
  if (!r.ok) throw new ApiError(r.status, j.error ?? L('Erro {0}', r.status));
  return j;
}

let toastTimer;
function toast(msg, kind = 'info') {
  document.getElementById('toast')?.remove();
  clearTimeout(toastTimer);
  const t = h('div', { id: 'toast', role: 'status' }, icon(kind === 'error' ? 'warning-circle' : 'check-circle'), msg);
  document.body.append(t);
  animate(t, { opacity: [0, 1], transform: ['translate(-50%, 8px)', 'translate(-50%, 0)'] }, { duration: 0.24 });
  toastTimer = setTimeout(() => {
    const a = animate(t, { opacity: [1, 0] }, { duration: 0.2 });
    if (a) a.finished.then(() => t.remove()); else t.remove();
  }, 3200);
}
const fail = (e) => { if (e.status !== 401) toast(e.message, 'error'); };

// ---------- formatação ----------
// Números e horas no formato da língua do painel (1.284 em português, 1,284 em inglês, 3.2万 em chinês).
const fmt = (n) => (n ?? 0).toLocaleString(currentLang());
const compact = (n) => (n >= 1e4 ? new Intl.NumberFormat(currentLang(), { notation: 'compact', maximumFractionDigits: 1 }).format(n) : fmt(n));
const ms = (v) => (v ? (v >= 1000 ? `${(v / 1000).toLocaleString(currentLang(), { maximumFractionDigits: 1 })} s` : `${v} ms`) : '—');
const time = (t) => new Date(t).toLocaleTimeString(currentLang(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function ago(t) {
  if (!t) return '—';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return L('agora');
  if (s < 3600) return L('há {0} min', Math.round(s / 60));
  if (s < 86400) return L('há {0} h', Math.round(s / 3600));
  return L('há {0} d', Math.round(s / 86400));
}
function uptime(v) {
  const m = Math.floor(v / 60000);
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
}

// ---------- componentes do design system ----------
/** Folha. `title` pode ser [título, subtítulo]. */
function panel(title, actions, ...body) {
  const [t, sub] = Array.isArray(title) ? title : [title];
  return h('section', { class: 'panel' },
    t && h('div', { class: 'panel-head' }, h('div', { class: 'grow' }, h('h2', {}, t), sub && h('div', { class: 'ph-sub' }, sub)), actions && h('div', { class: 'ph-actions' }, actions)),
    ...body);
}
function pageHead(title, sub, actions, { context, back } = {}) {
  return h('header', { class: 'page-head' },
    h('div', { class: 'ph-text' },
      back && h('a', { class: 'back', href: back[0] }, icon('caret-left'), back[1]),
      context && h('div', { class: 'ph-context' }, context),
      h('h1', {}, title), sub && h('p', {}, sub)),
    actions && h('div', { class: 'ph-actions' }, actions));
}
const button = (label, onclick, cls = '', { icon: ic, ...extra } = {}) => h('button', { type: 'button', class: `btn ${cls}`, onclick, ...extra }, ic && icon(ic), label);
const badge = (text, kind = '', tip) => h('span', { class: `badge ${kind}`, 'data-tip': tip }, text);
const tableEl = (heads, rows) => h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, heads.map((x) => h('th', { class: x?.num ? 'num' : x?.cls, scope: 'col' }, x?.t ?? x)))), h('tbody', {}, rows)));
function stat(label, value, note, { format = fmt, raw } = {}) {
  const v = h('div', { class: 'value' });
  if (raw !== undefined) v.append(raw); else v.dataset.count = String(value);
  v.dataset.format = format === fmt ? 'fmt' : format === compact ? 'compact' : format === ms ? 'ms' : 'fmt';
  if (raw === undefined) v.textContent = format(value);
  return h('div', { class: 'stat' }, h('div', { class: 'label' }, label), v, note && h('div', { class: 'note' }, note));
}
const FORMATS = { fmt, compact, ms };
function animateStats(container) {
  for (const v of container.querySelectorAll('.value[data-count]')) countUp(v, Number(v.dataset.count), FORMATS[v.dataset.format] ?? fmt);
}
function meter(pct, color = 'var(--d1)', label) {
  const i = h('i');
  i.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  i.style.setProperty('--c', color);
  const m = h('div', { class: 'meter' }, i);
  if (label !== undefined) {
    // O contador fica na ponta da barra; em barras curtas, logo depois dela.
    const p = Math.max(0, Math.min(100, pct));
    const b = h('b', { class: p >= 14 ? 'in' : 'out' }, label);
    b.style.left = p >= 14 ? `calc(${p}% - 4px)` : `calc(${p}% + 6px)`;
    m.append(b);
  }
  return m;
}
function toggle(checked, onchange, label) {
  const input = h('input', { type: 'checkbox', checked, 'aria-label': label, role: 'switch', onchange: () => onchange(input.checked) });
  return h('label', { class: 'switch' }, input, h('span'));
}
function field(label, control, hint, cls) {
  const id = `f${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;
  return h('div', { class: `field ${cls ?? ''}` }, h('label', { for: id }, label), control, hint && h('div', { class: 'hint' }, hint));
}
const setting = (title, desc, ctl) => h('div', { class: 'setting' }, h('div', { class: 'txt' }, h('div', {}, title), desc && h('div', { class: 'small' }, desc)), h('div', { class: 'ctl' }, ctl));
function segmented(options, value, onchange, { label, iconsOnly } = {}) {
  const wrap = h('div', { class: `segmented ${iconsOnly ? 'icons' : ''}`, role: 'group', 'aria-label': label });
  const paint = (v) => { for (const b of wrap.children) b.setAttribute('aria-pressed', String(b.dataset.v === v)); };
  for (const o of options) {
    wrap.append(h('button', { type: 'button', 'data-v': o.value, 'aria-label': iconsOnly ? o.label : undefined, 'data-tip': iconsOnly ? o.label : undefined,
      onclick: () => { paint(o.value); onchange(o.value); } }, o.icon && icon(o.icon), !iconsOnly && o.label));
  }
  paint(value);
  return wrap;
}
const notice = (text, kind = '', title) => h('div', { class: `notice ${kind}` }, icon(kind === 'warn' ? 'warning' : 'info'), h('div', { class: 'n-body' }, title && h('div', { class: 'n-title' }, title), h('div', { class: 'small' }, text)));

/** Diálogo modal com formulário. `submit` pode lançar erro, exibido dentro do diálogo. */
function dialog({ title, sub, body, submitLabel = L('Salvar'), submit, danger, wide }) {
  const error = h('div', { class: 'form-error', role: 'alert' });
  const dlg = h('dialog', { class: wide ? 'wide' : undefined });
  const close = () => {
    const a = animate(dlg, { opacity: [1, 0], transform: ['scale(1)', 'scale(.98)'] }, { duration: 0.16 });
    const done = () => { dlg.close(); dlg.remove(); };
    if (a) a.finished.then(done); else done();
  };
  const go = h('button', { type: 'submit', class: `btn ${danger ? 'danger' : 'primary'}` }, submitLabel);
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault();
    error.textContent = '';
    go.disabled = true;
    try { await submit(); close(); } catch (err) { error.textContent = err.message; go.disabled = false; }
  } },
  h('div', { class: 'dlg-head' }, h('h2', {}, title), sub && h('p', { class: 'small' }, sub)),
  h('div', { class: 'dlg-body stack tight' }, body, error),
  h('div', { class: 'dlg-foot' }, h('button', { type: 'button', class: 'btn', onclick: close }, L('Cancelar')), go));
  dlg.append(form);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  document.body.append(dlg);
  dlg.showModal();
  animate(dlg, { opacity: [0, 1], transform: ['scale(.98)', 'scale(1)'] }, { duration: 0.24 });
  return dlg;
}
const confirmDo = (title, text, label, fn) => dialog({ title, body: h('p', { class: 'muted' }, text), submitLabel: label, danger: true, submit: fn });

// ---------- aparência ----------
const PALETTES = [
  { id: 'lavanda', name: LK('Lavanda'), sw: '#b6a6dc' }, { id: 'salvia', name: LK('Sálvia'), sw: '#9fc3ad' }, { id: 'oceano', name: LK('Oceano'), sw: '#9fc0d8' },
  { id: 'rosa', name: LK('Rosa'), sw: '#e4a9c0' }, { id: 'grafite', name: LK('Grafite'), sw: '#bdb7ad' },
];
function applyUi(ui = {}) {
  const theme = ['light', 'dark'].includes(ui.theme) ? ui.theme : 'auto';
  const palette = PALETTES.some((p) => p.id === ui.palette) ? ui.palette : 'lavanda';
  if (theme === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.palette = palette;
  try { localStorage.setItem('rotaz.ui', JSON.stringify({ theme, palette })); } catch { /* sem armazenamento local */ }
  state.ui = { theme, palette, lang: ui.lang ?? 'auto', dashboard: Array.isArray(ui.dashboard) ? ui.dashboard : null };
}
async function saveUi(patch) {
  const next = { ...state.ui, ...patch };
  applyUi(next);
  try { await api('PUT', '/api/ui', next); } catch (e) { fail(e); }
}

// ---------- idioma ----------
/** Lista de idiomas, cada um escrito na própria língua. `auto` acrescenta a opção que segue o sistema. */
function langSelect(value, onchange, { auto = true, cls } = {}) {
  const sys = LANGS.find((l) => l.code === detectLang())?.name;
  const sel = h('select', { class: cls, 'aria-label': L('Idioma'), onchange: () => onchange(sel.value) },
    auto && h('option', { value: 'auto' }, L('Automático ({0})', sys)),
    LANGS.map((l) => h('option', { value: l.code, lang: l.code }, l.name)));
  sel.value = value;
  return sel;
}
/** Salva o idioma e redesenha o painel na nova língua (a página recarrega; a sessão continua). */
async function changeLang(pref) {
  try { await api('PUT', '/api/ui', { lang: pref }); } catch (e) { fail(e); return; }
  pendingLang.clear();
  const a = animate(document.body, { opacity: [1, 0] }, { duration: 0.2 });
  if (a) await a.finished;
  location.reload();
}
/** Redesenha o que está na tela depois de trocar o idioma sem recarregar (na abertura). */
async function rerender() {
  document.querySelector('.titlebar')?.remove();
  await boot();
}

// ---------- privacidade e termos ----------
// Páginas do site de divulgação. No app, links externos abrem no navegador do sistema (desktop/main.js).
const SITE_URL = 'https://rotaz.dev';

// ---------- autenticação ----------
/**
 * Entrada e primeiro acesso: tipografia grande e leve, campos de linha fina e quase nenhum texto.
 * A logo nítida (SVG) no alto, o título, o campo e um botão. A linha do campo se desenha ao focar.
 * Primeiro acesso em duas etapas curtas: por que a senha (três selos), depois a senha.
 */
function authScreen(status) {
  const setupToken = new URLSearchParams(location.hash.slice(1)).get('setup');
  const setup = !status.configured;
  const col = h('div', { class: 'auth-col' });
  const brand = h('div', { class: 'auth-brand' }, wordmark('wm-auth'));
  const dot = () => h('span', { class: 'auth-dot', 'aria-hidden': 'true' });
  const legal = (label, page) => h('a', { class: 'auth-link', href: `${SITE_URL}/${page}`, target: '_blank', rel: 'noopener noreferrer' }, label);
  const foot = h('p', { class: 'auth-foot' }, h('span', {}, L('Painel local')), dot(), h('code', {}, location.host), dot(),
    legal(L('Privacidade'), 'privacidade.html'), dot(), legal(L('Termos'), 'termos.html'));
  root.replaceChildren(h('main', { class: 'auth' }, brand, col, foot));

  // Campo de linha: sem caixa, uma linha fina que vira tinta ao focar (desenhada do centro para as pontas).
  const line = (input, label, extra) => {
    input.setAttribute('aria-label', label);
    input.placeholder = label;
    return h('label', { class: 'lf' }, input, extra);
  };
  const secret = (autocomplete, label) => {
    const input = h('input', { type: 'password', autocomplete, required: true, spellcheck: 'false' });
    const eye = h('button', { type: 'button', class: 'lf-eye', 'aria-label': L('Mostrar senha'), 'aria-pressed': 'false',
      onclick: (e) => {
        e.preventDefault();
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        eye.setAttribute('aria-pressed', String(show));
        eye.setAttribute('aria-label', show ? L('Ocultar senha') : L('Mostrar senha'));
        eye.replaceChildren(icon(show ? 'eye-slash' : 'eye'));
        input.focus();
      } }, icon('eye'));
    return { el: line(input, label, eye), input };
  };
  const note = h('p', { class: 'auth-note', role: 'alert' });
  const say = (text, kind = '') => { note.textContent = text; note.className = `auth-note ${kind}`; };
  const caps = (e) => { if (!note.classList.contains('bad')) say(e.getModifierState?.('CapsLock') ? L('Caps Lock está ligado.') : '', 'warn'); };

  async function show(el, dir = 1) {
    const old = col.firstElementChild;
    if (old) {
      const out = animate(old, { opacity: [1, 0], transform: ['translateX(0)', `translateX(${-20 * dir}px)`] }, { duration: 0.26, ease: [0.4, 0, 1, 1] });
      if (out) await out.finished;
    }
    col.replaceChildren(el);
    if (!reduced() && M) {
      M.animate([...el.children], { opacity: [0, 1], transform: [old ? `translateX(${24 * dir}px)` : 'translateY(14px)', 'translate(0, 0)'] },
        { duration: 0.8, ease: EASE, delay: M.stagger(0.08, { startDelay: old ? 0 : 0.2 }) });
      // as linhas dos campos se desenham do centro para as pontas
      const rules = el.querySelectorAll('.lf');
      rules.forEach((r) => r.style.setProperty('--lf-base', '0'));
      if (rules.length) M.animate([...rules], { '--lf-base': [0, 1] }, { duration: 0.9, ease: EASE, delay: M.stagger(0.1, { startDelay: old ? 0.15 : 0.45 }) });
    }
    el.querySelector('input, .btn.primary')?.focus();
  }
  const shake = (el) => animate(el, { transform: ['translateX(0)', 'translateX(-7px)', 'translateX(6px)', 'translateX(-3px)', 'translateX(0)'] }, { duration: 0.42 });
  const leave = async () => {
    const a = animate(document.querySelector('main.auth'), { opacity: [1, 0], transform: ['scale(1)', 'scale(.985)'] }, { duration: 0.36, ease: [0.4, 0, 1, 1] });
    if (a) await a.finished;
    boot();
  };
  animate(brand, { opacity: [0, 1] }, { duration: 0.9 });
  animate(foot, { opacity: [0, 1] }, { duration: 0.9, delay: 0.6 });

  if (!setup) {
    const pw = secret('current-password', L('Senha'));
    pw.input.addEventListener('keyup', caps);
    pw.input.addEventListener('input', () => note.classList.contains('bad') && say(''));
    const go = h('button', { type: 'submit', class: 'btn primary auth-go' }, L('Entrar'), icon('arrow-right'));
    const form = h('form', { class: 'auth-form', onsubmit: async (e) => {
      e.preventDefault();
      if (!pw.input.value) { pw.input.focus(); return; }
      go.disabled = true;
      try { await api('POST', '/api/auth/login', { password: pw.input.value }); await leave(); }
      catch (x) { say(x.message, 'bad'); go.disabled = false; shake(pw.el); pw.input.select(); }
    } }, pw.el, note, go);
    show(h('div', { class: 'auth-step' }, h('h1', {}, L('Olá de novo.')), form));
    return;
  }

  // Primeiro acesso, etapa 1: por que a senha, em uma frase e três selos.
  const seal = (ic, text) => h('li', {}, icon(ic), text);
  const why = () => h('div', { class: 'auth-step' },
    h('h1', {}, L('Uma senha, só sua.')),
    h('p', { class: 'auth-lead' }, L('Ela guarda o painel e as chaves dos seus provedores.')),
    h('ul', { class: 'auth-seals' }, seal('key', L('Chaves protegidas')), seal('hard-drives', L('Só nesta máquina')), seal('globe', L('Sem conta online'))),
    h('button', { type: 'button', class: 'btn primary auth-go', onclick: () => show(form(), 1) }, L('Criar senha'), icon('arrow-right')));

  // Etapa 2: a senha e a confirmação; os dois requisitos se marcam enquanto se digita.
  const form = () => {
    const code = h('input', { type: 'text', value: setupToken ?? '', autocomplete: 'off', required: true, spellcheck: 'false' });
    const a = secret('new-password', L('Nova senha')), b = secret('new-password', L('Repita a senha'));
    const rule = (text) => h('li', {}, icon('check'), text);
    const rLen = rule(L('10 caracteres ou mais')), rSame = rule(L('Senhas iguais'));
    const go = h('button', { type: 'submit', class: 'btn primary auth-go', disabled: true }, L('Criar e entrar'), icon('arrow-right'));
    const check = () => {
      const len = a.input.value.length >= 10, same = len && a.input.value === b.input.value;
      rLen.classList.toggle('ok', len); rSame.classList.toggle('ok', same);
      go.disabled = !(len && same && (setupToken || code.value.trim()));
      if (note.classList.contains('bad')) say('');
    };
    [a.input, b.input, code].forEach((x) => x.addEventListener('input', check));
    [a.input, b.input].forEach((x) => x.addEventListener('keyup', caps));
    const formEl = h('form', { class: 'auth-form', onsubmit: async (e) => {
      e.preventDefault();
      go.disabled = true;
      try {
        await api('POST', '/api/auth/setup', { token: (setupToken ?? code.value).trim(), password: a.input.value });
        history.replaceState(null, '', '/');
        await leave();
      } catch (x) { say(x.message, 'bad'); check(); shake(formEl); }
    } },
    !setupToken && line(code, L('Código de configuração')),
    a.el, b.el, h('ul', { class: 'auth-rules', 'aria-live': 'polite' }, rLen, rSame), note, go);
    return h('div', { class: 'auth-step' },
      h('button', { type: 'button', class: 'auth-back', 'aria-label': L('Voltar'), onclick: () => show(why(), -1) }, icon('caret-left'), L('Voltar')),
      h('h1', {}, L('Crie sua senha.')),
      formEl);
  };
  show(why());
}

// ---------- estrutura ----------
const NAV = [
  [LK('Gateway'), [['overview', LK('Visão geral'), 'squares-four'], ['providers', LK('Provedores'), 'plugs-connected'], ['routing', LK('Roteamento'), 'path']]],
  [LK('Integração'), [['client', 'Claude Code', 'terminal-window']]],
  [LK('Sistema'), [['settings', LK('Configurações'), 'gear-six'], ['logs', LK('Registros'), 'list-magnifying-glass']]],
];
const VIEW_IDS = NAV.flatMap(([, items]) => items.map(([id]) => id));

// ---------- barra de título do app desktop ----------
const desk = window.rotazDesktop; // só existe dentro do app instalado (desktop/preload.cjs)
const VIEW_LABEL = Object.fromEntries(NAV.flatMap(([, items]) => items.map(([id, label]) => [id, label])));

function mountTitlebar() {
  if (!desk || document.querySelector('.titlebar')) return;
  document.documentElement.classList.add('desktop', `os-${desk.platform}`);
  // Glifos finos de 10 px, no padrão dos controles de janela, desenhados no traço do design system.
  const glyph = (d) => svg('svg', { width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': 'true' }, svg('path', { d, fill: 'none', stroke: 'currentColor', 'stroke-width': 1 }));
  const ctl = (label, cls, draw, fn) => h('button', { type: 'button', class: `tb-btn ${cls}`, 'aria-label': label, title: label, onclick: fn }, draw);
  const maxBtn = ctl(L('Maximizar'), '', glyph('M.5.5h9v9h-9z'), () => desk.toggleMaximize());
  const setMax = (m) => {
    maxBtn.replaceChildren(glyph(m ? 'M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z' : 'M.5.5h9v9h-9z'));
    maxBtn.setAttribute('aria-label', m ? L('Restaurar') : L('Maximizar'));
    maxBtn.title = m ? L('Restaurar') : L('Maximizar');
  };
  desk.onMaximized(setMax);
  desk.isMaximized().then(setMax);
  document.body.prepend(h('header', { class: 'titlebar' },
    h('div', { class: 'tb-brand' }, wordmark('wm-sm')),
    h('span', { class: 'tb-page', id: 'tb-page' }),
    h('div', { class: 'grow' }),
    desk.platform !== 'darwin' && h('div', { class: 'tb-controls' },
      ctl(L('Minimizar'), '', glyph('M0 5.5h10'), () => desk.minimize()),
      maxBtn,
      ctl(L('Fechar'), 'close', glyph('M.5.5l9 9M9.5.5l-9 9'), () => desk.close()))));
}
const setTitle = (text) => { const el = document.getElementById('tb-page'); if (el) el.textContent = text; };

function shell(status) {
  const canvas = h('main', { class: 'canvas', id: 'sheet' });
  const indicator = h('span', { class: 'nav-indicator', 'aria-hidden': 'true' });
  const lists = NAV.map(([group, items]) => [h('div', { class: 'nav-group' }, L(group)), h('div', { class: 'nav-list' }, items.map(([id, label, ic]) => h('a', { class: 'nav', href: `#/${id}`, 'data-view': id }, icon(ic, 'lg'), L(label))))]);
  const themeSeg = segmented([
    { value: 'auto', label: L('Automático'), icon: 'monitor' }, { value: 'light', label: L('Claro'), icon: 'sun' }, { value: 'dark', label: L('Escuro'), icon: 'moon' },
  ], state.ui?.theme ?? 'auto', (v) => saveUi({ theme: v }), { label: L('Tema'), iconsOnly: true });
  themeSeg.classList.add('full');

  // Cartão do gateway: estado, interruptor e atalho para copiar o token sem mostrá-lo.
  let on = status?.gatewayEnabled !== false;
  const dot = h('span', { class: 'dot' });
  const name = h('span', { class: 'ws-name' });
  const paint = () => { dot.className = `dot ${on ? 'pos live' : 'warn'}`; name.textContent = on ? L('Gateway ativo') : L('Gateway desligado'); };
  paint();
  const sw = toggle(on, async (v) => {
    try {
      await api('PUT', '/api/settings', { gatewayEnabled: v });
      on = v;
      paint();
      toast(v ? L('Gateway ligado') : L('Gateway desligado. O Claude Code recebe erro 503 até você religar.'), v ? 'info' : 'error');
      if (state.view === 'overview') route();
    } catch (e) { fail(e); sw.querySelector('input').checked = on; }
  }, L('Ligar ou desligar o gateway'));
  sw.dataset.tip = L('Liga ou desliga o gateway. Desligado, nenhum pedido chega aos provedores.');
  const copyToken = h('button', { type: 'button', class: 'ws-copy', 'data-tip': L('Copia o token que o Claude Code usa para falar com o gateway. Ele não aparece na tela.'),
    onclick: async () => {
      try { const { token } = await api('GET', '/api/client-config'); await navigator.clipboard.writeText(token); toast(L('Token da API copiado')); } catch (e) { fail(e); }
    } }, icon('key'), h('span', { class: 'grow' }, L('Token da API')), h('span', { class: 'ws-mask', 'aria-hidden': 'true' }, '••••••'), icon('copy'));

  root.replaceChildren(h('div', { class: 'shell' },
    h('nav', { class: 'sidebar', 'aria-label': L('Principal') },
      h('div', { class: 'brand' }, wordmark('wm-md')),
      h('div', { class: 'workspace' },
        h('div', { class: 'ws-top' }, dot, h('div', { class: 'ws-text' }, name, h('span', { class: 'ws-sub' }, status?.address ?? location.host)), sw),
        copyToken),
      lists,
      h('div', { class: 'side-foot' },
        themeSeg,
        button(L('Sair'), async () => { await api('POST', '/api/auth/logout', {}); stopPolling(); boot(); }, 'ghost logout', { icon: 'sign-out' }))),
    canvas));
  // O realce da navegação desliza entre os itens.
  for (const list of document.querySelectorAll('.nav-list')) list.prepend(indicator.cloneNode());
}

function paintNav() {
  for (const list of document.querySelectorAll('.nav-list')) {
    const ind = list.querySelector('.nav-indicator');
    const cur = [...list.querySelectorAll('.nav')].find((a) => a.dataset.view === state.view);
    for (const a of list.querySelectorAll('.nav')) { if (a === cur) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
    if (!ind) continue;
    if (!cur) { ind.style.opacity = '0'; continue; }
    const y = cur.offsetTop;
    if (ind.style.opacity === '0' || !ind.style.transform || reduced() || !M) { ind.style.transform = `translateY(${y}px)`; ind.style.opacity = '1'; }
    else M.animate(ind, { transform: `translateY(${y}px)` }, { duration: 0.28, ease: EASE });
  }
}

function stopPolling() { clearInterval(state.timer); state.timer = null; }

async function route() {
  stopPolling();
  closeMenu();
  const [view, ...sub] = location.hash.replace(/^#\/?/, '').split('/');
  state.view = VIEW_IDS.includes(view) ? view : 'overview';
  state.sub = state.view === view ? sub.map((s) => decodeURIComponent(s)) : [];
  paintNav();
  setTitle(state.view === 'providers' && state.sub[0] === 'new' ? L('Adicionar provedor') : L(VIEW_LABEL[state.view]));
  const sheet = document.getElementById('sheet');
  if (!sheet) return;
  (document.querySelector('html.desktop .shell') ?? window).scrollTo(0, 0);
  try {
    await VIEWS[state.view](sheet);
    const page = sheet.querySelector('.page');
    if (page) { enter(page, page.querySelector('.dash') ? ':scope > header, .dash > .widget' : ':scope > *'); growBars(page); growHills(page); animateStats(page); }
  } catch (e) { fail(e); }
}

// ---------- visão geral ----------
function providerStatus(p) {
  if (!p.enabled) return [L('Desativado'), ''];
  if (!p.keyCount && p.authScheme !== 'none') return [L('Sem chave'), 'warn'];
  if (p.lastErrorAt && (!p.lastOkAt || p.lastErrorAt > p.lastOkAt)) return [L('Com falha'), 'neg'];
  if (p.lastOkAt) return [L('Conectado'), 'pos'];
  return [L('Sem tráfego'), ''];
}

function statusLine(d) {
  if (d.server.gatewayEnabled === false) return L('O gateway está desligado: o Claude Code recebe erro 503 até você religá-lo na barra lateral.');
  if (!d.providers.length) return L('Nenhum provedor cadastrado ainda.');
  if (!d.active) return L('Nenhuma rota ativa: falta um provedor ligado com chave e modelo.');
  const failing = d.providers.filter((p) => providerStatus(p)[0] === L('Com falha'));
  if (failing.length) return L('{0} falhou na última chamada.', failing.map((p) => p.name).join(', '));
  return L('O tráfego do Claude Code está indo para {0}.', d.active.provider);
}

const DATA_COLORS = ['var(--d1)', 'var(--d2)', 'var(--d3)', 'var(--d4)', 'var(--d5)', 'var(--d6)'];

// ---------- gráficos "montanha" ----------
/** Sino suave apoiado na linha de base. */
const bell = (cx, w, hh, base) => `M${cx - w / 2} ${base}C${cx - w * 0.22} ${base} ${cx - w * 0.2} ${base - hh} ${cx} ${base - hh}C${cx + w * 0.2} ${base - hh} ${cx + w * 0.22} ${base} ${cx + w / 2} ${base}Z`;
let clipSeq = 0;

/**
 * Colinas sobrepostas, da maior para a menor, com textura de linhas finas por dentro (sem gradiente).
 * items: [{ label, value, tip }]. Mostra rótulo e valor sobre cada pico e um resumo grande à esquerda.
 */
function hillsChart(items, { format = fmt, summary, empty }) {
  const sorted = items.filter((x) => x.value > 0).sort((a, b) => b.value - a.value);
  if (!sorted.length) return h('div', { class: 'empty-state' }, icon('mountains', 'lg'), empty);
  // Até 5 picos legíveis; o resto vira "Outros", para os rótulos nunca se amontoarem.
  const rest = sorted.slice(5);
  const data = rest.length ? [...sorted.slice(0, 4), { label: `Outros (${rest.length + 1})`, value: sorted.slice(4).reduce((a, x) => a + x.value, 0), tip: sorted.slice(4).map((x) => `${x.label}: ${format(x.value)}`).join(' · ') }].sort((a, b) => b.value - a.value) : sorted;
  const W = 900; const H = 280; const base = H - 1; const room = base - 72;
  const max = data[0].value;
  const n = data.length;
  const hs = data.map((d) => Math.max(16, Math.sqrt(d.value / max) * room));
  const ws = data.map((d) => 190 + 300 * Math.sqrt(d.value / max));
  // Picos em sequência, com sobreposição; o conjunto ocupa do terço esquerdo até a borda direita.
  const x0 = W * 0.42; const lastC = W - ws[n - 1] * 0.42;
  const raw = [0];
  for (let i = 1; i < n; i++) raw.push(raw[i - 1] + (ws[i - 1] + ws[i]) * 0.5);
  const cx = raw.map((r) => (n === 1 ? (x0 + lastC) / 2 : x0 + (r / raw[n - 1]) * (lastC - x0)));
  const id = `hc${++clipSeq}`;
  // Família de curvas: nasce como contorno-fantasma à esquerda e converge para o contorno da colina (t = 1).
  // Fora da colina as linhas são cinza; dentro, recortadas pela forma, ganham a cor dela: o efeito da referência.
  const K = 26;
  const family = (i, t) => bell(cx[i] - ws[i] * 0.5 * (1 - t), ws[i] * (1.55 - 0.55 * t), hs[i] * (1.12 - 0.12 * t), base);
  const ghost = Array.from({ length: K }, (_, j) => svg('path', { class: 'ghost', d: family(0, j / K) }));
  const hills = data.map((d, i) => {
    const clip = `${id}-${i}`;
    const shape = bell(cx[i], ws[i], hs[i], base);
    const lines = Array.from({ length: K }, (_, j) => svg('path', { class: 'contour', d: family(i, j / K) }));
    return svg('g', { class: `hill-g h${(i % 6) + 1}`, 'data-tip': d.tip ?? `${d.label}: ${format(d.value)}` },
      svg('clipPath', { id: clip }, svg('path', { d: shape })),
      svg('path', { class: 'hill', d: shape }),
      svg('g', { 'clip-path': `url(#${clip})` },
        svg('rect', { class: 'shade', x: cx[i] - ws[i] / 2, y: base - hs[i], width: ws[i], height: hs[i], fill: `url(#${id}-shade)` }),
        ...lines,
        svg('rect', { class: 'grain', x: cx[i] - ws[i] / 2, y: base - hs[i], width: ws[i], height: hs[i], filter: `url(#${id}-noise)` })));
  });
  // Rótulos em HTML sobre o desenho: tamanho fixo em qualquer largura; colisões resolvidas em layoutLabels().
  const labels = data.map((d, i) => peakLabel(cx[i] / W, (base - hs[i] - 10) / H, d.label.length > 18 ? `${d.label.slice(0, 17)}…` : d.label, format(d.value)));
  return h('div', { class: 'hills' },
    summary && h('div', { class: 'h-summary' }, h('div', { class: 'label' }, summary.label), h('div', { class: 'value' }, summary.value, summary.unit && h('small', {}, summary.unit)), summary.note && h('div', { class: 'note' }, summary.note)),
    h('div', { class: 'hills-plot' },
      svg('svg', { class: 'chart hills-svg', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': data.map((d) => `${d.label} ${format(d.value)}`).join(', ') }, chartDefs(id), ...ghost, ...hills,
        svg('line', { class: 'baseline', x1: 0, x2: W, y1: base, y2: base })),
      ...labels));
}

/**
 * Granulação e volume dos gráficos montanha. O ruído é um feTurbulence em tons neutros e o sombreado
 * dá a luz da referência (mais claro à esquerda, mais escuro à direita). Exceção aos gradientes: só aqui.
 */
function chartDefs(id) {
  return svg('defs', {},
    svg('filter', { id: `${id}-noise`, x: '0', y: '0', width: '100%', height: '100%', 'color-interpolation-filters': 'sRGB' },
      svg('feTurbulence', { type: 'fractalNoise', baseFrequency: '0.9', numOctaves: '3', seed: '7', stitchTiles: 'stitch', result: 'n' }),
      svg('feColorMatrix', { in: 'n', type: 'matrix', values: '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.4 0.95' })),
    svg('linearGradient', { id: `${id}-shade`, x1: '0', y1: '0', x2: '1', y2: '0.35' },
      svg('stop', { offset: '0', class: 'shade-light' }),
      svg('stop', { offset: '0.45', class: 'shade-mid' }),
      svg('stop', { offset: '1', class: 'shade-dark' })));
}

/** Rótulo de pico ancorado em frações do desenho (0 a 1). */
function peakLabel(fx, fy, name, value) {
  const el = h('div', { class: 'hl' }, h('b', {}, name), value !== undefined && h('span', {}, value));
  el.style.left = `${fx * 100}%`;
  el.style.top = `${Math.max(0.14, fy) * 100}%`;
  return el;
}

/** Desfaz sobreposição de rótulos medindo na tela: o que bater no anterior sobe uma linha; se ainda bater, some (fica na dica). */
function layoutLabels(scope) {
  for (const plot of scope.querySelectorAll('.hills-plot')) {
    const items = [...plot.querySelectorAll('.hl')];
    for (const el of items) { el.style.removeProperty('--lift'); el.classList.remove('hl-hidden'); }
    const placed = [];
    const hit = (a, b) => a.left < b.right + 6 && a.right > b.left - 6 && a.top < b.bottom && a.bottom > b.top;
    for (const el of items.sort((a, b) => parseFloat(a.style.left) - parseFloat(b.style.left))) {
      let r = el.getBoundingClientRect();
      const h0 = r.height + 4;
      // Sobe até dois degraus; só se ainda colidir, some (o valor continua na dica do pico).
      for (let level = 1; level <= 2 && placed.some((p) => hit(r, p)); level++) {
        el.style.setProperty('--lift', `${h0 * level}px`);
        r = el.getBoundingClientRect();
      }
      if (placed.some((p) => hit(r, p))) { el.classList.add('hl-hidden'); continue; }
      placed.push(r);
    }
  }
}

/** Curva suave (Catmull-Rom) que nunca desce abaixo da base. */
function smoothPath(pts, base) {
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]; const p1 = pts[i]; const p2 = pts[i + 1]; const p3 = pts[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, Math.min(base, p1[1] + (p2[1] - p0[1]) / 6)];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, Math.min(base, p2[1] - (p3[1] - p1[1]) / 6)];
    d += `C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${p2[0]} ${p2[1]}`;
  }
  return d;
}

/** Cordilheira do tráfego da última hora: requisições e, na frente, erros. */
function ridgeChart(minutes) {
  const W = 900; const H = 240; const n = 60; const base = H - 1; const room = base - 54;
  const now = Math.floor(Date.now() / 60000);
  const by = new Map(minutes.map((m) => [m.m, m]));
  const raw = Array.from({ length: n }, (_, i) => by.get(now - (n - 1 - i)) ?? { requests: 0, errors: 0 });
  const total = raw.reduce((a, d) => a + d.requests, 0);
  if (!total) return h('div', { class: 'empty-state' }, icon('chart-line', 'lg'), L('Nenhuma requisição na última hora. A cordilheira aparece assim que o Claude Code usar o gateway.'));
  const errors = raw.reduce((a, d) => a + d.errors, 0);
  // Média móvel curta: dá forma de relevo sem esconder o pico real, que vai no rótulo.
  const soft = (k) => raw.map((_, i) => { const w = raw.slice(Math.max(0, i - 1), i + 2); return w.reduce((a, d) => a + d[k], 0) / w.length; });
  const req = soft('requests'); const err = soft('errors');
  const max = Math.max(1, ...req);
  const x = (i) => (i / (n - 1)) * W;
  const pts = (arr, k = 1) => arr.map((v, i) => [x(i), base - (v / max) * room * k]);
  const area = (arr, k) => `${smoothPath(pts(arr, k), base)}L${W} ${base}L0 ${base}Z`;
  const id = `rc${++clipSeq}`;
  // Linhas que acompanham o relevo: cópias da crista deslocadas para a esquerda e para cima, recortadas pela área.
  const family = (t) => smoothPath(pts(req).map(([px0, py0]) => [px0 + 36 * (1 - t), base - (base - py0) * (0.08 + 0.92 * t)]), base);
  const contour = Array.from({ length: 28 }, (_, j) => svg('path', { class: 'contour', d: family(j / 28) }));
  const plotBox = (cls, fill, filter) => svg('rect', { class: cls, x: 0, y: base - room - 4, width: W, height: room + 5, fill, filter });
  const peakI = raw.reduce((b, d, i) => (d.requests > raw[b].requests ? i : b), 0);
  const peak = raw[peakI].requests;
  const px = x(peakI); const py = base - (req[peakI] / max) * room;
  const dot = h('span', { class: 'peak-dot' });
  dot.style.left = `${(px / W) * 100}%`;
  dot.style.top = `${(py / H) * 100}%`;
  return h('div', { class: 'hills ridge' },
    h('div', { class: 'h-summary static' }, h('div', { class: 'value' }, fmt(total), h('small', {}, L('requisições na última hora'))), h('div', { class: 'note' }, errors ? L('{0} com erro, em rosa à frente', fmt(errors)) : L('nenhum erro'))),
    h('div', { class: 'hills-plot' },
      svg('svg', { class: 'chart hills-svg', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': L('{0} requisições e {1} erros na última hora', total, errors) },
        chartDefs(id),
        svg('clipPath', { id }, svg('path', { d: area(req, 1) })),
        svg('clipPath', { id: `${id}-e` }, svg('path', { d: area(err, 1) })),
        svg('g', { class: 'hill-g h1', 'data-tip': L('{0} requisições na última hora', fmt(total)) }, svg('path', { class: 'hill', d: area(req, 1) }),
          svg('g', { 'clip-path': `url(#${id})` }, plotBox('shade', `url(#${id}-shade)`), ...contour, plotBox('grain', undefined, `url(#${id}-noise)`))),
        errors > 0 && svg('g', { class: 'hill-g h2', 'data-tip': L('{0} erros', fmt(errors)) }, svg('path', { class: 'hill', d: area(err, 1) }),
          svg('g', { 'clip-path': `url(#${id}-e)` }, plotBox('grain', undefined, `url(#${id}-noise)`))),
        svg('line', { class: 'baseline', x1: 0, x2: W, y1: base, y2: base })),
      dot,
      peakLabel(Math.min(0.94, Math.max(0.06, px / W)), (py - 12) / H, L('pico de {0}/min', peak))),
    h('div', { class: 'chart-foot' }, h('span', {}, L('há 60 min')), h('span', {}, L('há 30 min')), h('span', {}, L('agora'))));
}

function growHills(container) {
  if (reduced() || !M) return;
  const g = [...container.querySelectorAll('.hill-g')];
  if (g.length) M.animate(g, { transform: ['scaleY(0)', 'scaleY(1)'] }, { duration: 0.7, ease: EASE, delay: M.stagger(0.06) });
  const l = [...container.querySelectorAll('.hl, .peak-dot, .h-summary')];
  if (l.length) M.animate(l, { opacity: [0, 1] }, { duration: 0.4, delay: 0.35 });
}

// ---------- quadros da visão geral ----------
function overviewParts(d) {
  const okRate = d.stats.requests ? ((d.stats.requests - d.stats.errors) / d.stats.requests) * 100 : null;
  const totalReq = Math.max(1, d.providers.reduce((a, p) => a + p.requests, 0));
  const routePanel =panel([L('Rota ativa'), L('Para onde vai um pedido "auto" do Claude Code')], h('a', { class: 'btn ghost sm', href: '#/routing' }, L('Alterar')),
    d.active ? h('div', { class: 'panel-body' },
      h('div', { class: 'route' },
        h('div', { class: 'node main' }, h('div', { class: 'label' }, L('Alias no Claude Code')), h('div', { class: 'val', 'data-tip': d.active.alias }, d.active.alias)),
        h('span', { class: 'arrow' }, icon('arrow-right', 'lg')),
        h('div', { class: 'node' }, h('div', { class: 'label' }, L('Provedor')), h('div', { class: 'with-icon' }, providerIcon({ name: d.active.provider, baseUrl: d.active.baseUrl, presetId: d.active.presetId }, 'sm'), h('div', { class: 'val' }, d.active.provider))),
        h('span', { class: 'arrow' }, icon('arrow-right', 'lg')),
        h('div', { class: 'node' }, h('div', { class: 'label' }, L('Modelo real')), h('div', { class: 'val mono', 'data-tip': d.active.upstream }, d.active.upstream))),
      h('div', { class: 'chain' }, icon('stack'), d.active.chain?.length
        ? [L('Se falhar, tenta'), ...d.active.chain.map((c) => badge(`${c.provider} · ${c.upstream}`))]
        : L('Sem alternativa de fallback para este alias.')))
      : h('div', { class: 'empty-state' }, L('Nenhuma rota ativa ainda.'), h('a', { class: 'btn primary', href: d.providers.length ? '#/routing' : '#/providers/new' }, d.providers.length ? L('Escolher modelo padrão') : L('Adicionar provedor'))));

  const healthPanel = panel([L('Taxa de sucesso'), L('Desde que o gateway iniciou')], null,
    h('div', { class: 'panel-body stack tight' },
      h('div', { class: 'hero' }, okRate === null ? '—' : `${okRate.toLocaleString(currentLang(), { maximumFractionDigits: 1 })}%`),
      meter(okRate ?? 0, okRate === null ? 'var(--surface-3)' : okRate >= 95 ? 'var(--d4)' : okRate >= 80 ? 'var(--d3)' : 'var(--d2)'),
      h('div', { class: 'small muted' }, d.stats.requests ? L('{0} de {1} requisições sem erro', fmt(d.stats.requests - d.stats.errors), fmt(d.stats.requests)) : L('Sem requisições ainda'))));

  const providersPanel = panel([L('Provedores'), L('Parcela do tráfego e estado da última chamada')], h('a', { class: 'btn ghost sm', href: '#/providers' }, L('Ver todos')),
    d.providers.length ? h('div', { class: 'panel-body' }, [...d.providers].sort((a, b) => b.requests - a.requests).slice(0, 5).map((p, i) => {
      const [t, c] = providerStatus(p);
      // Duas faixas: identidade e estado em cima, a parcela do tráfego embaixo, na largura toda.
      return h('div', { class: 'prov-row' },
        h('div', { class: 'row' }, providerIcon(p, 'sm'),
          h('div', { class: 'grow' }, h('div', { class: 'ellipsis', 'data-tip': p.name }, p.name), h('div', { class: 'small muted' }, L('{0} de latência média', ms(p.avgLatencyMs)))),
          badge(t, c, p.lastError?.message)),
        meter((p.requests / totalReq) * 100, DATA_COLORS[i % DATA_COLORS.length], `${fmt(p.requests)} req`));
    })) : h('div', { class: 'empty-state' }, L('Nenhum provedor.'), h('a', { class: 'btn primary', href: '#/providers/new' }, L('Adicionar provedor'))));

  const recentPanel = panel(L('Requisições recentes'), null, d.recent.length ? tableEl([L('Hora'), L('Alias'), L('Modelo real'), { t: L('Status'), num: 1 }, { t: L('Duração'), num: 1 }, { t: L('Tokens'), num: 1 }],
    d.recent.slice(0, 7).map((r) => h('tr', {}, h('td', { class: 'muted' }, time(r.at)), h('td', { class: 'ellipsis', 'data-tip': r.provider ? `${r.alias} via ${r.provider}` : r.alias }, r.alias),
      h('td', {}, h('div', { class: 'row' }, h('span', { class: 'mono ellipsis' }, r.model ?? '—'), r.via === 'fallback' && badge('fallback', 'warn', L('O alvo principal falhou e outro modelo respondeu.')))),
      h('td', { class: 'num' }, badge(String(r.status), r.status < 400 ? 'pos' : 'neg')), h('td', { class: 'num' }, ms(r.ms)), h('td', { class: 'num' }, r.input + r.output ? fmt(r.input + r.output) : '—'))))
    : h('div', { class: 'empty-state' }, L('As requisições aparecem aqui assim que o Claude Code usar o gateway.')));

  const errorsPanel = panel(L('Erros recentes'), d.errors.length ? moreButton([{ label: L('Limpar métricas'), icon: 'broom', danger: true, onClick: () => confirmDo(L('Limpar métricas'), L('Zera contadores e o histórico de erros. Provedores e chaves não são afetados.'), L('Limpar'), async () => { await api('POST', '/api/stats/reset', {}); route(); }) }]) : null,
    d.errors.length ? h('div', { class: 'panel-body stack tight' }, d.errors.slice(0, 5).map((e) => h('div', { class: 'tile' },
      h('div', { class: 'row spread' }, h('div', { class: 'row' }, badge(e.status ? String(e.status) : L('rede'), 'neg'), h('span', { class: 'small' }, e.provider ?? L('Gateway'))), h('span', { class: 'small muted' }, ago(e.at))),
      h('p', { class: 'small muted', style: undefined }, L(e.message)))))
      : h('div', { class: 'empty-state' }, icon('check-circle', 'lg'), L('Nenhum erro registrado.')));

  const tokens = (p) => p.inputTokens + p.outputTokens;
  const reqTotal = d.providers.reduce((a, p) => a + p.requests, 0);
  const tokTotal = d.providers.reduce((a, p) => a + tokens(p), 0);
  const latList = d.providers.filter((p) => p.avgLatencyMs > 0);
  const latAvg = latList.length ? Math.round(latList.reduce((a, p) => a + p.avgLatencyMs * p.requests, 0) / Math.max(1, latList.reduce((a, p) => a + p.requests, 0))) : 0;
  const pct = (v, t) => `${Math.round((v / Math.max(1, t)) * 100)}%`;

  return {
    route: routePanel,
    success: healthPanel,
    stats: h('section', { class: 'panel stats', 'aria-label': L('Totais') },
      stat(L('Requisições'), d.stats.requests, d.server.inflight ? L('{0} em andamento', d.server.inflight) : L('nenhuma em andamento'), { format: compact }),
      stat(L('Latência média'), d.stats.avgLatencyMs, L('até a resposta completa'), { format: ms }),
      stat(L('Tokens de entrada'), d.stats.inputTokens, L('enviados aos provedores'), { format: compact }),
      stat(L('Tokens de saída'), d.stats.outputTokens, L('gerados pelos modelos'), { format: compact })),
    requestsHills: panel([L('Requisições por provedor'), L('Desde que o gateway iniciou')], null, h('div', { class: 'panel-body' },
      hillsChart(d.providers.map((p) => ({ label: p.name, value: p.requests, tip: L('{0}: {1} requisições ({2})', p.name, fmt(p.requests), pct(p.requests, reqTotal)) })), {
        format: compact, empty: L('Sem requisições ainda.'), summary: { label: L('Resumo'), value: compact(reqTotal), unit: L('requisições'), note: L('em {0} provedor(es)', d.providers.filter((p) => p.requests).length) } }))),
    tokensHills: panel([L('Tokens por provedor'), L('Entrada e saída somadas')], null, h('div', { class: 'panel-body' },
      hillsChart(d.providers.map((p) => ({ label: p.name, value: tokens(p), tip: L('{0}: {1} entrada · {2} saída', p.name, compact(p.inputTokens), compact(p.outputTokens)) })), {
        format: compact, empty: L('Os provedores ainda não informaram consumo de tokens.'), summary: { label: L('Resumo'), value: compact(tokTotal), unit: L('tokens'), note: L('total consumido') } }))),
    latencyHills: panel([L('Latência por provedor'), L('Tempo médio até a resposta completa')], null, h('div', { class: 'panel-body' },
      hillsChart(latList.map((p) => ({ label: p.name, value: p.avgLatencyMs, tip: L('{0}: {1} em média', p.name, ms(p.avgLatencyMs)) })), {
        format: ms, empty: L('Sem medições de latência ainda.'), summary: { label: L('Média geral'), value: ms(latAvg), note: L('ponderada por requisições') } }))),
    traffic: panel([L('Tráfego'), L('Última hora, por minuto')], null, h('div', { class: 'panel-body' }, ridgeChart(d.minutes))),
    providers: providersPanel,
    recent: recentPanel,
    errors: errorsPanel,
  };
}

/** Catálogo de quadros: título (para o menu de adicionar), largura padrão e mínima em colunas (de 12). */
const WIDGETS = {
  route: { title: LK('Rota ativa'), def: 8, min: 4 },
  success: { title: LK('Taxa de sucesso'), def: 4, min: 3 },
  stats: { title: LK('Totais'), def: 12, min: 4 },
  requestsHills: { title: LK('Requisições por provedor'), def: 12, min: 5 },
  tokensHills: { title: LK('Tokens por provedor'), def: 6, min: 5 },
  latencyHills: { title: LK('Latência por provedor'), def: 6, min: 5 },
  traffic: { title: LK('Tráfego da última hora'), def: 7, min: 5 },
  providers: { title: LK('Provedores'), def: 5, min: 4 },
  recent: { title: LK('Requisições recentes'), def: 7, min: 5 },
  errors: { title: LK('Erros recentes'), def: 5, min: 3 },
};
const DEFAULT_LAYOUT = [['route', 8], ['success', 4], ['stats', 12], ['requestsHills', 12], ['traffic', 7], ['providers', 5], ['recent', 7], ['errors', 5]].map(([id, span]) => ({ id, span }));
/*
 * Encaixe automático: a grade tem 12 colunas e cada linha fica sempre cheia, sem buraco à direita.
 * As linhas saem da mesma regra do CSS grid (um quadro que não cabe desce para a próxima linha).
 */
const COLS = 12;
const minOf = (w) => WIDGETS[w.id].min;
function rowsOf(layout) {
  const rows = [];
  let row = []; let sum = 0;
  for (const w of layout) {
    if (row.length && sum + w.span > COLS) { rows.push(row); row = []; sum = 0; }
    row.push(w); sum += w.span;
  }
  if (row.length) rows.push(row);
  return rows;
}
/** Ajusta uma linha para somar 12: encolhe quem está mais largo que o padrão, estica quem está mais estreito. */
function fitRow(row) {
  const ratio = (w) => w.span / WIDGETS[w.id].def;
  let sum = row.reduce((a, w) => a + w.span, 0);
  while (sum > COLS) {
    const c = row.filter((w) => w.span > minOf(w)).sort((a, b) => ratio(b) - ratio(a))[0];
    if (!c) break; // nem no mínimo cabem: o último desce na normalização
    c.span--; sum--;
  }
  while (sum < COLS) {
    const c = [...row].sort((a, b) => ratio(a) - ratio(b))[0];
    c.span++; sum++;
  }
}
/** Garante linhas cheias. Repete porque encolher pode reagrupar as linhas seguintes. */
function normalizeLayout(layout) {
  for (const w of layout) w.span = Math.max(minOf(w), Math.min(COLS, Math.round(w.span) || WIDGETS[w.id].def));
  for (let i = 0; i < 4; i++) {
    const rows = rowsOf(layout);
    if (rows.every((r) => r.reduce((a, w) => a + w.span, 0) === COLS)) break;
    rows.forEach(fitRow);
  }
  return layout;
}
const currentLayout = () => normalizeLayout((state.ui?.dashboard ?? DEFAULT_LAYOUT).filter((w) => WIDGETS[w.id]).map((w) => ({ ...w })));

async function overview(sheet) {
  const page = h('div', { class: 'page' });
  sheet.replaceChildren(page);
  let editing = false;
  let data = null;
  let layout = currentLayout();
  let saveTimer;
  const persist = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => saveUi({ dashboard: layout }), 250); };

  /** FLIP: os quadros deslizam até a nova posição em vez de pular. */
  const flip = (mutate) => {
    const before = new Map([...page.querySelectorAll('.widget')].map((el) => [el.dataset.id, el.getBoundingClientRect()]));
    mutate();
    if (reduced() || !M) return;
    for (const el of page.querySelectorAll('.widget')) {
      const a = before.get(el.dataset.id);
      if (!a) { M.animate(el, { opacity: [0, 1], transform: ['scale(.98)', 'scale(1)'] }, { duration: 0.28, ease: EASE }); continue; }
      const b = el.getBoundingClientRect();
      const dx = a.left - b.left; const dy = a.top - b.top;
      if (dx || dy) M.animate(el, { transform: [`translate(${dx}px, ${dy}px)`, 'translate(0, 0)'] }, { duration: 0.32, ease: EASE });
    }
  };

  /** Atualiza larguras na tela sem redesenhar (usado durante o arraste da borda). */
  const paintSpans = () => {
    for (const x of layout) {
      const el = page.querySelector(`.widget[data-id="${x.id}"]`);
      if (!el) continue;
      el.style.gridColumn = `span ${x.span}`;
      const size = el.querySelector('.w-size');
      if (size) size.textContent = `${x.span}/12`;
    }
  };
  const commit = () => { normalizeLayout(layout); persist(); flip(render); };

  function decorate(el, w) {
    const def = WIDGETS[w.id];
    const handle = h('button', { type: 'button', class: 'w-handle', 'aria-label': L('Mover {0}', L(def.title)), 'data-tip': L('Arraste para mudar a ordem') }, icon('dots-six-vertical'));
    handle.addEventListener('pointerdown', () => { el.draggable = true; });
    el.addEventListener('dragstart', (e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', w.id); el.classList.add('dragging'); });
    el.addEventListener('dragend', () => { el.draggable = false; el.classList.remove('dragging'); for (const x of page.querySelectorAll('.drop-before, .drop-after')) x.classList.remove('drop-before', 'drop-after'); });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      el.classList.toggle('drop-after', after);
      el.classList.toggle('drop-before', !after);
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
    // Soltar ao lado de outro quadro: entra na linha dele, e a linha se reajusta para caber.
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = e.dataTransfer.getData('text/plain');
      const after = el.classList.contains('drop-after');
      el.classList.remove('drop-before', 'drop-after');
      if (!from || from === w.id) return;
      const rows = rowsOf(layout);
      const src = rows.find((r) => r.some((x) => x.id === from));
      const dst = rows.find((r) => r.includes(w));
      if (!src || !dst) return;
      const item = src.find((x) => x.id === from);
      src.splice(src.indexOf(item), 1);
      dst.splice(dst.indexOf(w) + (after ? 1 : 0), 0, item);
      if (src.length && src !== dst) fitRow(src); // a linha de origem estica para fechar o buraco
      fitRow(dst); // a de destino encolhe para o novo quadro caber
      layout = rows.flat();
      commit();
    });
    // Puxar a borda direita: o vizinho de linha cede ou ganha a diferença, e a linha continua cheia.
    const grip = h('div', { class: 'w-resize', 'aria-hidden': 'true', 'data-tip': L('Puxe para esticar ou encolher') });
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const grid = el.parentElement.getBoundingClientRect();
      const gap = parseFloat(getComputedStyle(el.parentElement).columnGap) || 20;
      const col = (grid.width - gap * (COLS - 1)) / COLS;
      const left = el.getBoundingClientRect().left;
      el.classList.add('resizing');
      const move = (ev) => {
        const row = rowsOf(layout).find((r) => r.includes(w));
        const i = row.indexOf(w);
        const nb = row[i + 1] ?? row[i - 1];
        let s = Math.max(def.min, Math.min(COLS, Math.round((ev.clientX - left + gap) / (col + gap))));
        if (nb) { const total = w.span + nb.span; s = Math.min(s, total - minOf(nb)); nb.span = total - s; }
        w.span = s;
        paintSpans();
      };
      const up = () => {
        grip.removeEventListener('pointermove', move);
        el.classList.remove('resizing');
        // Sozinho na linha e encolhido: se o próximo quadro cabe no espaço, ele sobe para o lado.
        const rows = rowsOf(layout);
        const r = rows.findIndex((x) => x.includes(w));
        const free = COLS - rows[r].reduce((a, x) => a + x.span, 0);
        const next = rows[r + 1]?.[0];
        if (free > 0 && next && minOf(next) <= free) next.span = free;
        commit();
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up, { once: true });
    });
    const tools = h('div', { class: 'w-tools' }, handle, h('span', { class: 'w-title' }, L(def.title)),
      h('span', { class: 'w-size', 'data-tip': L('Largura em colunas') }, `${w.span}/12`),
      h('button', { type: 'button', class: 'btn ghost sm icon-only danger', 'aria-label': L('Remover {0}', L(def.title)), 'data-tip': L('Remover da visão geral'), onclick: () => { layout = layout.filter((x) => x.id !== w.id); commit(); } }, icon('x')));
    el.append(tools, grip);
  }

  function render(first) {
    const parts = overviewParts(data);
    const hidden = Object.keys(WIDGETS).filter((id) => !layout.some((w) => w.id === id));
    const actions = editing ? [
      button(L('Adicionar quadro'), (e) => menu(e.currentTarget, hidden.map((id) => ({ label: L(WIDGETS[id].title), icon: 'plus', onClick: () => { layout.push({ id, span: WIDGETS[id].def }); commit(); } }))), '', { icon: 'plus', disabled: !hidden.length }),
      button(L('Restaurar padrão'), () => { layout = DEFAULT_LAYOUT.map((w) => ({ ...w })); saveUi({ dashboard: null }); flip(render); }, 'ghost', { icon: 'arrow-counter-clockwise' }),
      button(L('Concluir'), () => { editing = false; render(); }, 'primary', { icon: 'check' }),
    ] : [
      data.server.gatewayEnabled === false ? badge(L('Gateway desligado'), 'warn') : badge(L('Ativo há {0}', uptime(data.server.uptimeMs)), 'pos'),
      button(L('Personalizar'), () => { editing = true; render(); }, 'ghost', { icon: 'sliders-horizontal' }),
    ];
    const grid = h('div', { class: `dash ${editing ? 'editing' : ''}` });
    for (const w of layout) {
      const el = h('div', { class: 'widget', 'data-id': w.id }, parts[w.id]);
      el.style.gridColumn = `span ${w.span}`;
      if (editing) decorate(el, w);
      grid.append(el);
    }
    if (!layout.length) grid.append(h('div', { class: 'widget dash-empty' }, h('div', { class: 'empty-state' }, L('Nenhum quadro na visão geral.'), button(L('Adicionar quadro'), (e) => menu(e.currentTarget, hidden.map((id) => ({ label: L(WIDGETS[id].title), icon: 'plus', onClick: () => { layout.push({ id, span: WIDGETS[id].def }); commit(); } }))), 'primary', { icon: 'plus' }))));
    page.replaceChildren(
      pageHead(L('Visão geral'), editing ? L('Arraste pela alça para reordenar; as linhas se ajustam sozinhas. A borda direita divide a largura.') : statusLine(data), actions),
      grid);
    if (!first) for (const v of page.querySelectorAll('.value[data-count]')) v.removeAttribute('data-count');
    requestAnimationFrame(() => layoutLabels(page));
  }

  const draw = async (first) => {
    const d = await api('GET', '/api/dashboard');
    if (state.view !== 'overview' || (editing && !first)) return; // não redesenha no meio de uma edição
    data = d;
    render(first);
  };
  await loadPresets().catch(() => {});
  await draw(true);
  state.timer = setInterval(() => draw(false).catch(() => {}), 4000);
}

// ---------- provedores: utilidades ----------
const AUTH_LABEL = { bearer: 'Authorization: Bearer', 'x-api-key': 'x-api-key', 'api-key': 'api-key (Azure)', none: LK('Sem autenticação') };

async function loadPresets() {
  if (!state.catalog) {
    // nomes de grupo, avisos e os provedores personalizados vêm do servidor em português
    const c = await api('GET', '/api/presets');
    state.catalog = { categories: c.categories.map((x) => ({ ...x, name: L(x.name) })), presets: c.presets.map((p) => ({ ...p, name: L(p.name), ...(p.note && { note: L(p.note) }) })) };
  }
  return state.catalog;
}

/** Provedor cadastrado -> preset de origem (pelo id salvo ou pelo host da URL). */
function presetOf(p) {
  const list = state.catalog?.presets ?? [];
  if (p.presetId) { const hit = list.find((x) => x.id === p.presetId); if (hit) return hit; }
  let host;
  try { host = new URL(p.baseUrl).host; } catch { return null; }
  return list.find((x) => { try { return x.baseUrl && new URL(x.baseUrl).host === host && (!p.type || x.type === p.type); } catch { return false; } }) ?? null;
}

/** Ícone do provedor num quadrado claro, como ícone de app. Sem logo, as iniciais. */
function providerIcon(item, size = 'md') {
  const ic = item.icon ?? presetOf(item)?.icon;
  if (ic) return h('span', { class: `picon ${size}` }, h('img', { src: `/icons/${ic}.svg`, alt: '', loading: 'lazy', decoding: 'async' }));
  const initials = String(item.name ?? '?').replace(/\(.*?\)/g, '').trim().split(/[\s.-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  let hash = 0;
  for (const c of String(item.name)) hash = (hash * 31 + c.charCodeAt(0)) % 360;
  const el = h('span', { class: `picon ${size} mono-icon`, 'aria-hidden': 'true' }, initials);
  el.style.setProperty('--hue', String(hash));
  return el;
}

/** Campos do provedor: cadastro (tela) e edição (diálogo). */
function providerFields(init, { isNew }) {
  const name = h('input', { type: 'text', value: init.name ?? '', required: true, maxlength: 60 });
  const type = h('select', {}, h('option', { value: 'openai' }, L('Compatível com OpenAI')), h('option', { value: 'anthropic' }, 'Anthropic Messages'));
  const baseUrl = h('input', { type: 'url', value: init.baseUrl ?? '', required: true, placeholder: 'https://api.exemplo.com/v1', spellcheck: 'false' });
  const auth = h('select', {}, Object.entries(AUTH_LABEL).map(([v, t]) => h('option', { value: v }, L(t))));
  const priority = h('input', { type: 'number', min: 0, max: 1000, value: init.priority ?? 10 });
  const rpm = h('input', { type: 'number', min: 0, max: 100000, value: init.rpm ?? 0 });
  const priv = h('input', { type: 'checkbox', checked: !!init.allowPrivateNetwork });
  const headers = h('textarea', { placeholder: 'X-Header: valor', spellcheck: 'false' });
  const key = h('input', { type: 'password', autocomplete: 'off', placeholder: init.authScheme === 'none' ? L('Não é necessária') : L('Cole a chave de API') });
  type.value = init.type ?? 'openai';
  auth.value = init.authScheme ?? (type.value === 'anthropic' ? 'x-api-key' : 'bearer');
  const advanced = h('details', { class: 'advanced' }, h('summary', {}, icon('caret-right'), L('Opções avançadas')),
    h('div', { class: 'form-grid' },
      field(L('Protocolo'), type), field(L('Autenticação'), auth),
      field(L('Prioridade'), priority, L('Menor número é tentado primeiro no fallback.')),
      field(L('Limite (requisições por minuto)'), rpm, L('0 = sem limite. Acima dele, as requisições esperam na fila em vez de receber 429.')),
      h('label', { class: 'check full' }, priv, L('Permitir rede local (servidores na sua máquina ou na sua rede)')),
      field(init.headerNames?.length ? L('Headers extras (atuais: {0})', init.headerNames.join(', ')) : L('Headers extras'), headers, init.headerNames ? L('Em branco mantém os atuais. Valores ficam cifrados.') : L('Opcional, um por linha. Valores ficam cifrados.'), 'full')));
  if (!isNew) advanced.open = true;
  const node = h('div', { class: 'form-grid' },
    field(L('Nome'), name, isNew ? L('Como o provedor aparece no painel.') : null, isNew ? '' : 'full'),
    isNew && field(L('Chave de API'), key, L('Cifrada antes de ir para o disco. O navegador nunca mais a recebe.')),
    field(L('URL base'), baseUrl, init.urlPlaceholder ? L('Troque {0} pelo seu valor.', init.urlPlaceholder) : null, 'full'),
    advanced);
  const read = () => {
    if (init.urlPlaceholder && baseUrl.value.includes(init.urlPlaceholder)) throw new Error(L('Troque {0} na URL base pelo seu valor.', init.urlPlaceholder));
    const body = { name: name.value, type: type.value, baseUrl: baseUrl.value, authScheme: auth.value, priority: Number(priority.value), rpm: Number(rpm.value || 0), allowPrivateNetwork: priv.checked };
    if (headers.value.trim()) {
      body.headers = {};
      for (const l of headers.value.split('\n').filter((x) => x.trim())) {
        const i = l.indexOf(':');
        if (i < 1) throw new Error(L('Header inválido: {0}', l.slice(0, 30)));
        body.headers[l.slice(0, i).trim()] = l.slice(i + 1).trim();
      }
    }
    if (isNew && key.value.trim()) body.keys = [{ label: L('Principal'), key: key.value.trim() }];
    return body;
  };
  return { node, read, focus: () => (init.urlPlaceholder ? baseUrl : init.name ? key : name).focus(), hasKey: () => !!key.value.trim() };
}

function providerDialog(existing) {
  const f = providerFields(existing, { isNew: false });
  dialog({ title: L('Editar {0}', existing.name), body: f.node, submit: async () => { await api('PUT', `/api/providers/${existing.id}`, f.read()); route(); } });
}

// ---------- catálogo ----------
function readView() { try { return localStorage.getItem('rotaz.catalogView') === 'list' ? 'list' : 'grid'; } catch { return 'grid'; } }
function saveView(v) { try { localStorage.setItem('rotaz.catalogView', v); } catch { /* fica só nesta sessão */ } }

async function catalog(sheet) {
  const [{ presets, categories }, { providers: added }] = await Promise.all([loadPresets(), api('GET', '/api/providers')]);
  const addedIds = new Set(added.map((p) => presetOf(p)?.id).filter(Boolean));
  let view = state.catalogView ?? readView();
  let cat = 'all';
  const input = h('input', { type: 'search', placeholder: L('Buscar entre {0} provedores', presets.length), 'aria-label': L('Buscar provedor') });
  const search = h('div', { class: 'search' }, icon('magnifying-glass'), input);
  const body = h('div', { class: 'stack' });
  const open = (p) => { location.hash = `#/providers/new/${p.id}`; };
  const subtitle = (p) => (p.category === 'local' ? L('Na sua máquina') : p.type === 'anthropic' ? L('Protocolo Anthropic') : p.category === 'custom' ? L('Qualquer endpoint') : L('Compatível com OpenAI'));
  const card = (p) => h('button', { type: 'button', class: 'pcard', onclick: () => open(p), 'data-tip': p.baseUrl || L('Você informa a URL') },
    providerIcon(p, 'lg'), h('span', { class: 'pcard-text' }, h('span', { class: 'pcard-name' }, p.name), h('span', { class: 'pcard-sub' }, subtitle(p))),
    addedIds.has(p.id) && h('span', { class: 'pcard-badge' }, badge(L('Adicionado'), 'pos')));
  const row = (p) => h('button', { type: 'button', class: 'prow', onclick: () => open(p) },
    providerIcon(p, 'sm'),
    h('span', { class: 'prow-main' }, h('span', { class: 'prow-name' }, p.name), h('span', { class: 'prow-url mono' }, p.baseUrl || L('Você informa a URL'))),
    h('span', { class: 'prow-sub' }, subtitle(p)),
    addedIds.has(p.id) ? badge(L('Adicionado'), 'pos') : h('span'),
    h('span', { class: 'chev' }, icon('caret-right')));
  const draw = (animateIn) => {
    const q = input.value.trim().toLowerCase();
    const match = (p) => (cat === 'all' || p.category === cat) && (!q || `${p.name} ${p.baseUrl} ${p.id}`.toLowerCase().includes(q));
    const groups = categories.map((c) => ({ c, items: presets.filter((p) => p.category === c.id && match(p)) })).filter((g) => g.items.length);
    if (!groups.length) { body.replaceChildren(h('div', { class: 'empty-state' }, L('Nada encontrado para "{0}".', input.value), h('a', { class: 'btn', href: '#/providers/new/custom' }, L('Usar endpoint personalizado')))); return; }
    body.replaceChildren(...groups.map(({ c, items }) => h('section', { class: 'catalog-group' },
      h('h2', {}, c.name, h('span', { class: 'count' }, String(items.length))),
      view === 'grid' ? h('div', { class: 'pgrid' }, items.map(card)) : h('div', { class: 'plist-rows panel' }, items.map(row)))));
    if (animateIn) enter(body, view === 'grid' ? '.pcard' : '.prow');
  };
  input.addEventListener('input', () => draw(false));
  const viewSeg = segmented([{ value: 'grid', label: L('Grade'), icon: 'squares-four' }, { value: 'list', label: L('Lista'), icon: 'list' }], view,
    (v) => { view = v; state.catalogView = v; saveView(v); draw(true); }, { label: L('Modo de exibição'), iconsOnly: true });
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': L('Categoria') },
    [{ id: 'all', name: L('Todos') }, ...categories].map((c) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(c.id === cat),
      onclick: (e) => { cat = c.id; for (const b of chips.children) b.setAttribute('aria-pressed', String(b === e.currentTarget)); draw(true); } }, c.name)));
  sheet.replaceChildren(h('div', { class: 'page' },
    pageHead(L('Adicionar provedor'), L('Escolha um provedor. URL e protocolo já vêm preenchidos; você só cola a chave.'), viewSeg, { back: ['#/providers', L('Provedores')] }),
    h('div', { class: 'catalog-tools' }, search, chips),
    body));
  draw(false);
  input.focus();
}

async function presetSetup(sheet, presetId) {
  const { presets, categories } = await loadPresets();
  const p = presets.find((x) => x.id === presetId);
  if (!p) { location.hash = '#/providers/new'; return; }
  const custom = p.category === 'custom';
  const f = providerFields({ ...p, name: custom ? '' : p.name }, { isNew: true });
  const importAfter = h('input', { type: 'checkbox', checked: true });
  const error = h('div', { class: 'form-error', role: 'alert' });
  const go = h('button', { type: 'submit', class: 'btn primary' }, icon('plus'), L('Adicionar provedor'));
  const form = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault();
    error.textContent = '';
    go.disabled = true;
    try {
      const body = { ...f.read(), presetId: custom ? null : p.id };
      const { id } = await api('POST', '/api/providers', body);
      state.provider = id;
      state.aliasHint = p.alias;
      if (importAfter.checked && (f.hasKey() || body.authScheme === 'none')) state.openImportFor = id;
      toast(`${body.name} adicionado`);
      location.hash = '#/providers';
    } catch (x) { error.textContent = x.message; go.disabled = false; }
  } },
  h('section', { class: 'panel' }, h('div', { class: 'panel-body' }, f.node)),
  h('label', { class: 'check' }, importAfter, L('Em seguida, abrir a lista de modelos do provedor para importar')),
  error,
  h('div', { class: 'row' }, go, h('a', { class: 'btn ghost', href: '#/providers/new' }, L('Escolher outro'))));
  sheet.replaceChildren(h('div', { class: 'page narrow' },
    h('a', { class: 'back', href: '#/providers/new' }, icon('caret-left'), L('Todos os provedores')),
    h('div', { class: 'setup-head' }, providerIcon(p, 'xl'),
      h('div', { class: 'sh-text' }, h('h1', {}, custom ? L('Provedor {0}', p.name.toLowerCase()) : p.name),
        h('p', { class: 'muted' }, `${categories.find((c) => c.id === p.category)?.name ?? ''}${p.baseUrl ? ` · ${new URL(p.baseUrl).host}` : ''}`)),
      p.keyUrl && h('a', { class: 'btn', href: p.keyUrl, target: '_blank', rel: 'noopener noreferrer' }, L('Obter chave de API'), icon('arrow-square-out'))),
    p.note && notice(p.note, 'accent'),
    form));
  f.focus();
}

// ---------- provedores: detalhe ----------
function compatBadge(c) {
  return c.desktop ? null : badge(L('Só CLI'), 'warn', L('O seletor do Claude Desktop descarta ids que contêm "{0}". No terminal funciona.', c.blockedBy));
}

function modelDialog(p, m, discovered = [], isDefault = false) {
  const makeDefault = h('input', { type: 'checkbox', checked: isDefault, disabled: isDefault });
  let dlg;
  const alias = h('input', { type: 'text', value: m?.alias ?? state.aliasHint ?? 'claude-', required: true, spellcheck: 'false', autocomplete: 'off' });
  const listId = 'discovered-models';
  const upstream = h('input', { type: 'text', value: m?.upstream ?? '', required: true, spellcheck: 'false', list: listId, autocomplete: 'off' });
  const datalist = h('datalist', { id: listId }, discovered.map((x) => h('option', { value: x })));
  const display = h('input', { type: 'text', value: m?.displayName && m.displayName !== m.alias ? m.displayName : '' });
  const maxOut = h('input', { type: 'number', min: 1, value: m?.maxOutputTokens ?? '', placeholder: L('Sem limite') });
  const images = imageSelect(false);
  images.value = m?.maxImages === null || m?.maxImages === undefined ? '' : String(m.maxImages);
  if (![...images.options].some((o) => o.value === images.value)) { images.append(h('option', { value: images.value }, L('Até {0} por requisição', images.value))); images.value = String(m.maxImages); }
  const effort = h('select', {}, h('option', { value: '' }, L('Não enviar')), ['minimal', 'low', 'medium', 'high'].map((v) => h('option', { value: v }, v)));
  effort.value = m?.reasoningEffort ?? '';
  const param = h('select', {}, ['auto', 'max_tokens', 'max_completion_tokens'].map((v) => h('option', { value: v }, v)));
  param.value = m?.tokenParam ?? 'auto';
  const hint = h('div', { class: 'hint' });
  const updateHint = () => {
    const bad = window.DESKTOP_DENY?.exec(alias.value.toLowerCase())?.[0];
    hint.textContent = bad ? L('O seletor do Claude Desktop descarta ids com "{0}". Funciona no terminal.', bad) : L('Nome público que o Claude Code vê. O provedor recebe o identificador real.');
  };
  alias.addEventListener('input', updateHint);
  updateHint();
  const f = field(L('Alias'), alias, null, 'full');
  f.append(hint);
  dlg = dialog({
    title: m ? L('Editar {0}', m.alias) : L('Adicionar modelo em {0}', p.name),
    body: h('div', { class: 'form-grid' }, f,
      field(L('Identificador real no provedor'), upstream, discovered.length ? L('{0} modelos encontrados: comece a digitar.', discovered.length) : null, 'full'), datalist,
      field(L('Nome de exibição'), display), field(L('Limite de saída (tokens)'), maxOut, L('Reduz o max_tokens do Claude Code quando preciso.')),
      field(L('Imagens'), images, m?.learnedMaxImages !== null && m?.learnedMaxImages !== undefined ? (m.learnedMaxImages === 0 ? L('Detectado pelo erro do provedor: não aceita imagens. Salvar substitui a detecção.') : L('Detectado pelo erro do provedor: no máximo {0}. Salvar substitui a detecção.', m.learnedMaxImages)) : L('Imagens acima do limite viram um aviso em texto; as mais recentes ficam.'), 'full'),
      p.type === 'openai' && field(L('Esforço de raciocínio'), effort), p.type === 'openai' && field(L('Parâmetro de tokens'), param),
      h('label', { class: 'check full' }, makeDefault, L('Usar como modelo padrão'))),
    submit: async () => {
      const saved = await api('POST', `/api/providers/${p.id}/models`, { id: m?.id, alias: alias.value, upstream: upstream.value, displayName: display.value, maxOutputTokens: maxOut.value ? Number(maxOut.value) : null, maxImages: images.value === '' ? null : Number(images.value), imagesTouched: true, reasoningEffort: effort.value || null, tokenParam: param.value });
      if (makeDefault.checked && !isDefault) await api('PUT', '/api/routing', { defaultAlias: saved.alias });
      state.aliasHint = null;
      route();
    },
  });
}

function keyDialog(p) {
  const label = h('input', { type: 'text', maxlength: 40, placeholder: L('Chave {0}', p.keys.length + 1) });
  const key = h('input', { type: 'password', autocomplete: 'off', required: true });
  dialog({ title: L('Nova chave em {0}', p.name), sub: L('Várias chaves se revezam e cobrem umas às outras quando uma falha.'), submitLabel: L('Adicionar'),
    body: h('div', { class: 'stack tight' }, field(L('Identificação'), label), field(L('Chave de API'), key, L('Cifrada antes de ir para o disco. O navegador nunca mais a recebe.'))),
    submit: async () => { await api('POST', `/api/providers/${p.id}/keys`, { label: label.value, key: key.value }); route(); } });
}

function testResult(r) {
  if (!r) return null;
  if (r.running) return h('div', { class: 'result', role: 'status' }, h('div', { class: 'r-head' }, icon('circle-notch', 'spinner'), h('span', {}, L('Testando {0} com uma requisição real…', r.what))));
  const ok = r.status === 'functional';
  return h('div', { class: 'result', role: 'status' },
    h('div', { class: 'r-head' }, badge(r.label, ok ? (r.toolsOk === false ? 'warn' : 'pos') : 'neg'),
      r.alias && h('span', { class: 'small muted mono' }, `${r.alias} → ${r.upstream}${r.keyLabel ? ` · ${r.keyLabel}` : ''}`),
      r.latencyMs && h('span', { class: 'small muted' }, ms(r.latencyMs))),
    h('p', { class: 'small' }, r.message),
    r.steps.length > 0 && h('div', { class: 'steps' }, r.steps.map((s) => h('div', { class: `step ${s.ok ? 'ok' : 'bad'}` }, icon(s.ok ? 'check' : 'x'), h('span', {}, s.name), h('span', { class: 'd', 'data-tip': s.detail }, s.detail)))));
}

async function runTest(p, opts, what) {
  state.tests[p.id] = { running: true, what };
  redrawDetail();
  try { state.tests[p.id] = await api('POST', `/api/providers/${p.id}/test`, opts); } catch (e) { state.tests[p.id] = null; fail(e); }
  redrawDetail();
}

let redrawDetail = () => {};

function providerDetail(p, routing) {
  const test = state.tests[p.id];
  const facts = [
    badge(p.type === 'openai' ? L('Compatível com OpenAI') : 'Anthropic Messages'), badge(L(AUTH_LABEL[p.authScheme])), badge(L('Prioridade {0}', p.priority)),
    badge(p.rpm ? L('Até {0} req/min', p.rpm) : L('Sem limite de req/min')), p.allowPrivateNetwork && badge(L('Rede local')), p.headerNames.length > 0 && badge(L('{0} header(s) extra', p.headerNames.length)),
  ];
  return h('div', { class: 'stack' },
    h('section', { class: 'panel' },
      h('div', { class: 'detail-head' }, providerIcon(p, 'md'),
        h('div', { class: 'dh-text' }, h('h2', {}, p.name), h('div', { class: 'small muted mono ellipsis', 'data-tip': p.baseUrl }, p.baseUrl)),
        h('div', { class: 'row' },
          h('span', { class: 'small muted' }, p.enabled ? L('Ativo') : L('Desativado')),
          toggle(p.enabled, async (v) => { await api('PUT', `/api/providers/${p.id}`, { enabled: v }).catch(fail); route(); }, L('Provedor ativo')),
          button(L('Testar'), () => runTest(p, {}, p.name), 'primary', { disabled: test?.running, icon: 'flask' }),
          moreButton([
            { label: L('Editar provedor'), icon: 'pencil-simple', onClick: () => providerDialog(p) },
            'sep',
            { label: L('Remover provedor'), icon: 'trash', danger: true, onClick: () => confirmDo(L('Remover {0}', p.name), L('Apaga o provedor, as chaves cifradas e os modelos. Rotas que dependem dele deixam de existir.'), L('Remover'), async () => { await api('DELETE', `/api/providers/${p.id}`); state.provider = null; delete state.tests[p.id]; route(); }) },
          ]))),
      h('div', { class: 'facts' }, facts),
      testResult(test)),
    panel([L('Chaves de API'), p.authScheme === 'none' ? null : L('Revezam entre si; uma chave com falha fica em pausa')], p.authScheme !== 'none' ? button(L('Adicionar chave'), () => keyDialog(p), 'sm', { icon: 'plus' }) : null,
      p.authScheme === 'none' ? h('div', { class: 'empty-state' }, L('Este provedor não usa autenticação.'))
        : p.keys.length ? tableEl([L('Identificação'), L('Final'), L('Ativa'), { t: '', cls: 'actions' }], p.keys.map((k) => h('tr', {},
          h('td', {}, k.label), h('td', { class: 'mono muted' }, k.hint),
          h('td', {}, toggle(k.enabled, async (v) => { await api('PUT', `/api/providers/${p.id}/keys/${k.id}`, { enabled: v }).catch(fail); route(); }, L('Ativar {0}', k.label))),
          h('td', { class: 'actions' }, moreButton([
            { label: L('Testar esta chave'), icon: 'flask', onClick: () => runTest(p, { keyId: k.id }, k.label) },
            'sep',
            { label: L('Remover chave'), icon: 'trash', danger: true, onClick: () => confirmDo(L('Remover {0}', k.label), L('A chave cifrada será apagada.'), L('Remover'), async () => { await api('DELETE', `/api/providers/${p.id}/keys/${k.id}`); route(); }) },
          ])))))
          : h('div', { class: 'empty-state' }, L('Nenhuma chave. Sem chave este provedor fica fora das rotas.'), button(L('Adicionar chave'), () => keyDialog(p), 'primary', { icon: 'plus' }))),
    modelsPanel(p, routing));
}

function imageSelect(withKeep) {
  return h('select', {},
    withKeep && h('option', { value: 'keep' }, L('Manter como está')),
    h('option', { value: '' }, L('Automático (aprende com o erro do provedor)')),
    h('option', { value: '0' }, L('Não enviar imagens (modelo só de texto)')),
    [1, 4, 8, 16, 32].map((n) => h('option', { value: String(n) }, L('Até {0} por requisição', n))));
}

function imagesBadge(m) {
  const lim = [m.maxImages, m.learnedMaxImages].filter((v) => Number.isInteger(v));
  if (!lim.length) return null;
  const n = Math.min(...lim);
  const auto = !Number.isInteger(m.maxImages) || m.learnedMaxImages < m.maxImages;
  return badge(n === 0 ? L('Sem imagens') : L('Até {0} imagens', n), '', auto ? L('Detectado pelo erro do provedor. Ajuste em Editar.') : L('Configurado no modelo.'));
}

// ---------- modelos em massa ----------
const selOf = (pid) => (state.sel[pid] ??= new Set());

function suggestAlias(upstream, taken) {
  const piece = upstream.toLowerCase().replace(/^models\//, '').replace(/[^a-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-._]+|[-._]+$/g, '');
  let base = /^claude-[a-z0-9]/.test(piece) ? piece : `claude-${piece}`;
  base = base.slice(0, 64).replace(/[-._]+$/, '');
  if (!/^claude-[a-z0-9]/.test(base)) base = 'claude-modelo';
  let a = base;
  for (let n = 2; taken.has(a); n++) a = `${base.slice(0, 60)}-${n}`;
  taken.add(a);
  return a;
}

function latestTest(m) {
  const a = state.live[m.id];
  const b = m.lastTest;
  if (!a) return b;
  if (a.running || !b) return a;
  return (a.at ?? 0) >= (b.at ?? 0) ? a : b;
}

function testBadge(t) {
  if (!t) return h('span', { class: 'small muted' }, L('Não testado'));
  if (t.running) return h('span', { class: 'row small muted' }, icon('circle-notch', 'spinner'), L('Testando'));
  const ok = t.status === 'functional';
  const text = ok ? `${t.quick ? L('Responde') : t.toolsOk === false ? L('Sem ferramentas') : L('Funcional')} · ${ms(t.latencyMs)}` : (t.label ? L(t.label) : L('Falha'));
  return badge(text, ok ? (t.toolsOk === false ? 'warn' : 'pos') : 'neg', `${t.message ?? ''}${t.at ? ` (${ago(t.at)})` : ''}`);
}

async function bulkTest(p, ids, full) {
  if (state.bulk || !ids.length) return;
  const run = state.bulk = { pid: p.id, total: ids.length, done: 0, ok: 0, fail: 0, cancel: false };
  const queue = [...ids];
  for (const id of ids) state.live[id] = { running: true };
  redrawDetail();
  const worker = async () => {
    while (queue.length && !run.cancel) {
      const id = queue.shift();
      try {
        const r = await api('POST', `/api/providers/${p.id}/test`, { modelId: id, quick: !full });
        state.live[id] = r;
        if (r.status === 'functional') run.ok++; else run.fail++;
      } catch (e) {
        state.live[id] = { status: 'error', label: L('Erro'), message: e.message, at: Date.now() };
        run.fail++;
      }
      run.done++;
      redrawDetail();
    }
  };
  // Duas por vez: rápido sem estourar o limite dos provedores (a fila do servidor também ajuda).
  await Promise.all(Array.from({ length: Math.min(2, ids.length) }, worker));
  for (const id of queue) delete state.live[id];
  state.bulk = null;
  toast(run.cancel ? L('{0} testado(s): {1} respondendo, {2} com falha. Teste interrompido.', run.done, run.ok, run.fail) : L('{0} testado(s): {1} respondendo, {2} com falha.', run.done, run.ok, run.fail), run.fail ? 'error' : 'info');
  route();
}

async function bulkUpdate(p, ids, set, on) {
  try { await api('POST', `/api/providers/${p.id}/models/bulk-update`, { ids, set }); toast(on ? L('{0} modelo(s) ativado(s)', ids.length) : L('{0} modelo(s) desativado(s)', ids.length)); } catch (e) { fail(e); }
  route();
}

function bulkEditDialog(p, ids) {
  const maxOut = h('input', { type: 'number', min: 1, placeholder: L('Manter como está') });
  const noLimit = h('input', { type: 'checkbox' });
  const effort = h('select', {}, h('option', { value: 'keep' }, L('Manter como está')), h('option', { value: '' }, L('Não enviar')), ['minimal', 'low', 'medium', 'high'].map((v) => h('option', { value: v }, v)));
  const param = h('select', {}, h('option', { value: 'keep' }, L('Manter como está')), ['auto', 'max_tokens', 'max_completion_tokens'].map((v) => h('option', { value: v }, v)));
  const images = imageSelect(true);
  dialog({
    title: L('Editar {0} modelo(s)', ids.length), sub: L('Só os campos alterados são aplicados. Alias e identificador real continuam individuais.'),
    submitLabel: L('Aplicar'),
    body: h('div', { class: 'form-grid' },
      field(L('Limite de saída (tokens)'), maxOut), h('label', { class: 'check' }, noLimit, L('Remover o limite')),
      field(L('Imagens'), images, null, 'full'),
      p.type === 'openai' && field(L('Esforço de raciocínio'), effort), p.type === 'openai' && field(L('Parâmetro de tokens'), param)),
    submit: async () => {
      const set = {};
      if (noLimit.checked) set.maxOutputTokens = null; else if (maxOut.value) set.maxOutputTokens = Number(maxOut.value);
      if (p.type === 'openai' && effort.value !== 'keep') set.reasoningEffort = effort.value || null;
      if (p.type === 'openai' && param.value !== 'keep') set.tokenParam = param.value;
      if (images.value !== 'keep') set.maxImages = images.value === '' ? null : Number(images.value);
      if (!Object.keys(set).length) throw new Error(L('Altere ao menos um campo.'));
      await api('POST', `/api/providers/${p.id}/models/bulk-update`, { ids, set });
      toast(L('{0} modelo(s) atualizado(s)', ids.length));
      route();
    },
  });
}

/** Lista do provedor com seleção múltipla. A lista fica em cache no servidor por 1 h. */
async function importDialog(p, refresh = false) {
  let data;
  try { data = await api('POST', `/api/providers/${p.id}/discover`, { refresh }); } catch (e) { fail(e); return; }
  const existing = new Map(p.models.map((m) => [m.upstream, m.alias]));
  const taken = new Set(state.aliases);
  const rows = [];
  const counter = h('span', { class: 'small muted' });
  let dlg;
  const go = () => dlg?.querySelector('button[type=submit]');
  const update = () => {
    const n = rows.filter((r) => r.cb.checked).length;
    const vis = rows.filter((r) => !r.tr.classList.contains('hidden')).length;
    counter.textContent = L('{0} no provedor · {1} visíveis · {2} selecionado(s)', data.models.length, vis, n);
    if (go()) { go().textContent = n ? L('Adicionar {0}', n) : L('Adicionar'); go().disabled = !n; }
  };
  const tbody = h('tbody');
  for (const id of data.models) {
    const already = existing.get(id);
    const cb = h('input', { type: 'checkbox', disabled: !!already, 'aria-label': L('Selecionar {0}', id) });
    const alias = h('input', { type: 'text', class: 'compact', value: already ?? suggestAlias(id, taken), disabled: !!already, spellcheck: 'false', 'aria-label': L('Alias de {0}', id) });
    const cell = h('span');
    const paint = () => {
      const bad = window.DESKTOP_DENY.exec(alias.value.toLowerCase())?.[0];
      cell.replaceChildren(already ? badge(L('Já adicionado')) : bad ? badge(L('Só CLI'), 'warn', L('O seletor do Desktop descarta ids com "{0}". Funciona no terminal.', bad)) : badge(L('CLI e Desktop'), 'pos'));
    };
    alias.addEventListener('input', () => { paint(); if (!cb.checked && !already) { cb.checked = true; update(); } });
    cb.addEventListener('change', update);
    paint();
    const tr = h('tr', { 'data-q': `${id} ${alias.value}`.toLowerCase() }, h('td', { class: 'chk' }, cb), h('td', { class: 'mono ellipsis', 'data-tip': id }, id), h('td', {}, alias), h('td', {}, cell));
    rows.push({ id, cb, alias, tr, already });
    tbody.append(tr);
  }
  const input = h('input', { type: 'search', placeholder: L('Filtrar por nome, ex.: llama 70b instruct'), 'aria-label': L('Filtrar modelos do provedor') });
  input.addEventListener('input', () => {
    const terms = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    for (const r of rows) r.tr.classList.toggle('hidden', !terms.every((t) => r.tr.dataset.q.includes(t)));
    update();
  });
  const pick = (v) => { for (const r of rows) if (!r.already && !r.tr.classList.contains('hidden')) r.cb.checked = v; update(); };
  const maxOut = h('input', { type: 'number', min: 1, placeholder: L('Sem limite') });
  const effort = h('select', {}, h('option', { value: '' }, L('Não enviar')), ['minimal', 'low', 'medium', 'high'].map((v) => h('option', { value: v }, v)));
  const testAfter = h('input', { type: 'checkbox', checked: true });
  dlg = dialog({
    title: L('Importar modelos de {0}', p.name), sub: data.cached ? L('Lista guardada {0}.', ago(data.at)) : L('Lista recém-buscada no provedor.'),
    wide: true, submitLabel: L('Adicionar'),
    body: h('div', { class: 'stack tight' },
      h('div', { class: 'row' }, h('div', { class: 'search grow' }, icon('magnifying-glass'), input),
        button(L('Marcar visíveis'), () => pick(true), 'ghost'), button(L('Desmarcar'), () => pick(false), 'ghost'),
        button(L('Atualizar lista'), () => { dlg.close(); dlg.remove(); importDialog(p, true); }, 'ghost', { icon: 'arrows-clockwise' })),
      counter,
      h('div', { class: 'import-list' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', { class: 'chk' }), h('th', {}, L('Modelo real')), h('th', {}, L('Alias')), h('th', {}, L('Disponível em')))), tbody)),
      h('div', { class: 'form-grid' },
        field(L('Limite de saída para todos (tokens)'), maxOut, L('Opcional. Dá para ajustar depois, em massa.')),
        p.type === 'openai' && field(L('Esforço de raciocínio para todos'), effort)),
      h('label', { class: 'check' }, testAfter, L('Testar os adicionados em seguida (teste rápido, uma chamada por modelo)'))),
    submit: async () => {
      const chosen = rows.filter((r) => r.cb.checked);
      if (!chosen.length) throw new Error(L('Selecione ao menos um modelo.'));
      const { models } = await api('POST', `/api/providers/${p.id}/models/bulk`, {
        models: chosen.map((r) => ({ alias: r.alias.value.trim().toLowerCase(), upstream: r.id, maxOutputTokens: maxOut.value ? Number(maxOut.value) : null, reasoningEffort: effort.value || null })),
      });
      toast(L('{0} modelo(s) adicionado(s)', models.length));
      await route();
      if (testAfter.checked) bulkTest(p, models.map((m) => m.id), false);
    },
  });
  update();
  input.focus();
}

function modelsPanel(p, routing) {
  const sel = selOf(p.id);
  for (const id of [...sel]) if (!p.models.some((m) => m.id === id)) sel.delete(id);
  const q = (state.mfilter[p.id] ?? '').toLowerCase();
  const busy = !!state.bulk;
  const setDefault = async (m) => { await api('PUT', '/api/routing', { defaultAlias: m.alias }).catch(fail); toast(L('Modelo padrão: {0}', m.alias)); route(); };
  const rows = p.models.map((m) => {
    const cb = h('input', { type: 'checkbox', checked: sel.has(m.id), 'aria-label': L('Selecionar {0}', m.alias), onchange: (e) => { if (e.target.checked) sel.add(m.id); else sel.delete(m.id); redrawDetail(); } });
    const text = `${m.alias} ${m.upstream}`.toLowerCase();
    const tr = h('tr', { 'data-q': text, class: q && !text.includes(q) ? 'hidden' : undefined },
      h('td', { class: 'chk' }, cb),
      h('td', {}, h('div', { class: 'row' }, h('span', { class: 'ellipsis', 'data-tip': m.alias }, m.alias), routing.defaultAlias === m.alias && badge(L('Padrão'), 'accent'), compatBadge(m.compat), imagesBadge(m))),
      h('td', { class: 'mono ellipsis muted', 'data-tip': m.upstream }, m.upstream), h('td', {}, testBadge(latestTest(m))),
      h('td', {}, toggle(m.enabled, async (v) => { await api('POST', `/api/providers/${p.id}/models`, { ...m, enabled: v }).catch(fail); route(); }, L('Ativar {0}', m.alias))),
      h('td', { class: 'actions' }, moreButton(() => [
        { label: L('Teste completo'), icon: 'flask', disabled: busy, onClick: () => bulkTest(p, [m.id], true) },
        { label: L('Editar'), icon: 'pencil-simple', onClick: () => modelDialog(p, m, [], routing.defaultAlias === m.alias) },
        routing.defaultAlias !== m.alias && { label: L('Usar como padrão'), icon: 'star', onClick: () => setDefault(m) },
        'sep',
        { label: L('Remover'), icon: 'trash', danger: true, onClick: () => confirmDo(L('Remover {0}', m.alias), L('O alias deixa de existir neste provedor.'), L('Remover'), async () => { await api('DELETE', `/api/providers/${p.id}/models/${m.id}`); route(); }) },
      ])));
    return { m, tr };
  });
  const visible = () => rows.filter((r) => !r.tr.classList.contains('hidden')).map((r) => r.m.id);
  const all = h('input', { type: 'checkbox', 'aria-label': L('Selecionar todos os visíveis'), onchange: (e) => { for (const id of visible()) { if (e.target.checked) sel.add(id); else sel.delete(id); } redrawDetail(); } });
  all.checked = visible().length > 0 && visible().every((id) => sel.has(id));
  const ids = () => [...sel];
  const filter = p.models.length > 6 && h('div', { class: 'search' }, icon('magnifying-glass'), h('input', { type: 'search', class: 'compact', placeholder: L('Filtrar modelos'), value: state.mfilter[p.id] ?? '', 'aria-label': L('Filtrar modelos'),
    oninput: (e) => {
      state.mfilter[p.id] = e.target.value;
      const t = e.target.value.toLowerCase();
      for (const r of rows) r.tr.classList.toggle('hidden', !!t && !r.tr.dataset.q.includes(t));
      all.checked = visible().length > 0 && visible().every((id) => sel.has(id));
    } }));
  const run = state.bulk?.pid === p.id ? state.bulk : null;
  const one = sel.size === 1 ? p.models.find((x) => sel.has(x.id)) : null;
  const bar = run ? h('div', { class: 'bulkbar', role: 'status' }, icon('circle-notch', 'spinner'), h('span', {}, L('Testando {0} de {1}: {2} respondendo, {3} com falha', run.done, run.total, run.ok, run.fail)), h('span', { class: 'grow' }), button(L('Interromper'), () => { run.cancel = true; }, 'ghost sm'))
    : sel.size > 0 && h('div', { class: 'bulkbar' }, h('span', {}, `${sel.size} selecionado(s)`), h('span', { class: 'grow' }),
      one && routing.defaultAlias !== one.alias && button(L('Usar como padrão'), () => setDefault(one), 'ghost sm'),
      button(L('Teste rápido'), () => bulkTest(p, ids(), false), 'ghost sm', { 'data-tip': L('Uma chamada de texto por modelo') }),
      button(L('Teste completo'), () => bulkTest(p, ids(), true), 'ghost sm', { 'data-tip': L('Texto, streaming e ferramentas: três chamadas por modelo') }),
      button(L('Ativar'), () => bulkUpdate(p, ids(), { enabled: true }, true), 'ghost sm'),
      button(L('Desativar'), () => bulkUpdate(p, ids(), { enabled: false }, false), 'ghost sm'),
      button(L('Editar'), () => bulkEditDialog(p, ids()), 'ghost sm'),
      button(L('Remover'), () => confirmDo(L('Remover {0} modelo(s)', sel.size), L('Os aliases selecionados deixam de existir neste provedor.'), L('Remover'), async () => { await api('POST', `/api/providers/${p.id}/models/bulk-delete`, { ids: ids() }); sel.clear(); route(); }), 'ghost sm danger'),
      button('', () => { sel.clear(); redrawDetail(); }, 'ghost sm icon-only', { icon: 'x', 'aria-label': L('Limpar seleção') }));
  return panel([L('Modelos'), L('{0} alias(es) apontando para modelos deste provedor', p.models.length)], [
    filter,
    p.models.length > 1 && button(L('Testar todos'), () => bulkTest(p, p.models.filter((m) => m.enabled).map((m) => m.id), false), 'ghost sm', { disabled: busy, 'data-tip': L('Teste rápido de todos os modelos ativos') }),
    button(L('Importar'), () => importDialog(p), 'sm', { icon: 'cloud-arrow-down' }),
    button('', () => modelDialog(p), 'sm icon-only', { icon: 'plus', 'aria-label': L('Adicionar modelo'), 'data-tip': L('Adicionar um modelo') })],
  bar,
  p.models.length ? h('div', { class: 'mtable' }, tableEl([{ t: all, cls: 'chk' }, L('Alias'), L('Modelo real'), L('Último teste'), L('Ativo'), { t: '', cls: 'actions' }], rows.map((r) => r.tr)))
    : h('div', { class: 'empty-state' }, L('Nenhum modelo ainda. Importe vários de uma vez da lista do provedor.'), button(L('Importar do provedor'), () => importDialog(p), 'primary', { icon: 'cloud-arrow-down' })));
}

async function providers(sheet) {
  if (state.sub[0] === 'new') return state.sub[1] ? presetSetup(sheet, state.sub[1]) : catalog(sheet);
  const [{ providers: list, routing, aliases }] = await Promise.all([api('GET', '/api/providers'), loadPresets()]);
  state.aliases = aliases;
  if (!list.some((p) => p.id === state.provider)) state.provider = list[0]?.id ?? null;
  const addBtn = h('a', { class: 'btn primary', href: '#/providers/new' }, icon('plus'), L('Adicionar provedor'));
  const page = h('div', { class: 'page' }, pageHead(L('Provedores'), list.length === 1 ? L('1 cadastrado. Mudanças valem na próxima requisição, sem reiniciar.') : L('{0} cadastrados. Mudanças valem na próxima requisição, sem reiniciar.', list.length), addBtn));
  sheet.replaceChildren(page);
  if (!list.length) {
    page.append(panel(null, null, h('div', { class: 'empty-state' }, L('Nenhum provedor ainda. Escolha um no catálogo e cole a chave de API; ela é cifrada e não volta ao navegador.'), h('a', { class: 'btn primary', href: '#/providers/new' }, L('Abrir catálogo')))));
    return;
  }
  if (state.openImportFor) {
    const target = list.find((x) => x.id === state.openImportFor);
    state.openImportFor = null;
    if (target) setTimeout(() => importDialog(target), 0);
  }
  const detail = h('div', { class: 'grow' });
  const items = h('div', { class: 'plist' });
  redrawDetail = () => {
    const p = list.find((x) => x.id === state.provider);
    items.replaceChildren(...[...list].sort((a, b) => a.priority - b.priority).map((x) => h('button', { type: 'button', class: 'pitem', 'aria-current': x.id === state.provider ? 'true' : 'false', onclick: () => { if (state.provider !== x.id) { state.provider = x.id; redrawDetail(); enter(detail.firstChild); } } },
      h('span', { class: 'picon-wrap' }, providerIcon(x, 'sm'), h('span', { class: `dot status ${x.enabled && (x.keys.some((k) => k.enabled) || x.authScheme === 'none') ? 'pos' : ''}`, 'data-tip': x.enabled ? L('Ativo') : L('Desativado') })),
      h('span', { class: 'grow' }, h('div', { class: 'p-name ellipsis' }, x.name), h('div', { class: 'sub' }, L('{0} modelo(s) · {1} chave(s)', x.models.length, x.keys.length))))));
    detail.replaceChildren(providerDetail(p, routing));
  };
  page.append(h('div', { class: 'split' }, h('section', { class: 'panel', 'aria-label': L('Lista de provedores') }, items), detail));
  redrawDetail();
}

// ---------- roteamento ----------
function aliasSelect(value, aliases, none, onchange) {
  const s = h('select', { onchange: () => onchange(s.value) }, h('option', { value: '' }, none), aliases.map((a) => h('option', { value: a }, a)));
  s.value = value ?? '';
  return s;
}

async function routing(sheet) {
  const [{ routing: r, aliases, providers: list }] = await Promise.all([api('GET', '/api/providers'), loadPresets()]);
  const save = async (body) => { try { await api('PUT', '/api/routing', body); toast(L('Roteamento atualizado')); } catch (e) { fail(e); } route(); };
  const rows = list.flatMap((p) => p.models.filter((m) => p.enabled && m.enabled).map((m) => ({ p, m }))).sort((a, b) => a.p.priority - b.p.priority);
  sheet.replaceChildren(h('div', { class: 'page' },
    pageHead(L('Roteamento'), L('Escolha qual modelo responde. A troca vale na próxima requisição, sem tocar no Claude Code.')),
    !r.defaultAlias && aliases.length > 0 && notice(L('Pedidos "auto" e as tarefas de fundo do Claude Code (claude-haiku-*) recebem erro 404 até você escolher um modelo padrão.'), 'warn', L('Nenhum modelo padrão')),
    h('div', { class: 'cols' },
      h('div', { class: 'c7 stack' },
        panel([L('Comportamento'), L('Como o gateway escolhe o modelo de cada pedido')], null,
          setting(L('Modelo padrão'), L('Responde a "auto" e a qualquer nome claude-* sem alias próprio.'), aliasSelect(r.defaultAlias, aliases, L('Nenhum'), (v) => save({ defaultAlias: v }))),
          setting(L('Aceitar nomes desconhecidos'), L('Desligado, nomes sem alias recebem erro 404. O Claude Code pede modelos como claude-haiku-* em tarefas de fundo.'), toggle(r.catchAll, (v) => save({ catchAll: v }), L('Aceitar nomes desconhecidos'))),
          setting(L('Fallback automático'), L('Se o alvo falhar antes de responder, tenta o mesmo alias em outro provedor e depois o modelo padrão. Desligado, só o provedor de maior prioridade responde. Desativados nunca são usados.'), toggle(r.fallbackEnabled, (v) => save({ fallbackEnabled: v }), L('Fallback automático')))),
        panel([L('Famílias de modelo'), L('Mande tarefas de fundo para um modelo mais barato')], null,
          ...['opus', 'sonnet', 'haiku'].map((t) => setting(h('span', { class: 'mono' }, `claude-${t}-*`), null, aliasSelect(r.tiers[t], aliases, L('Usar o padrão'), (v) => save({ tiers: { [t]: v } })))))),
      h('div', { class: 'c5' }, panel([L('Ordem de tentativa'), L('Modelos ativos, por prioridade do provedor')], h('a', { class: 'btn ghost sm', href: '#/providers' }, L('Prioridades')),
        rows.length ? h('div', { class: 'panel-body stack tight' }, rows.map(({ p, m }) => h('div', { class: 'row' },
          providerIcon(p, 'sm'),
          h('div', { class: 'grow' }, h('div', { class: 'row' }, h('span', { class: 'ellipsis' }, m.alias), r.defaultAlias === m.alias && badge(L('Padrão'), 'accent')), h('div', { class: 'small muted mono ellipsis' }, `${p.name} · ${m.upstream}`)),
          badge(`P${p.priority}`, '', L('Prioridade do provedor'))))) : h('div', { class: 'empty-state' }, L('Nenhum modelo ativo.')))))));
}

// ---------- Claude Code ----------
function copyLine(label, value, secret) {
  const code = h('code', {}, secret ? '•'.repeat(32) : value);
  let shown = !secret;
  const eye = secret && h('button', { type: 'button', class: 'btn ghost sm icon-only', 'aria-label': L('Mostrar'), 'data-tip': L('Mostrar ou ocultar'),
    onclick: (e) => { shown = !shown; code.textContent = shown ? value : '•'.repeat(32); e.currentTarget.replaceChildren(icon(shown ? 'eye-slash' : 'eye')); } }, icon('eye'));
  return h('div', { class: 'field' }, h('div', { class: 'lbl' }, label), h('div', { class: 'copy-line' }, code, eye,
    h('button', { type: 'button', class: 'btn ghost sm icon-only', 'aria-label': L('Copiar'), 'data-tip': L('Copiar'), onclick: async () => { await navigator.clipboard.writeText(value); toast(L('Copiado')); } }, icon('copy'))));
}

async function client(sheet) {
  const c = await api('GET', '/api/client-config');
  const hidden = c.models.filter((m) => !m.desktop);
  const cliJson = JSON.stringify(c.cli, null, 2);
  sheet.replaceChildren(h('div', { class: 'page' },
    pageHead('Claude Code', L('Configure uma vez. Depois disso a troca de provedor acontece só neste painel.')),
    h('div', { class: 'cols' },
      h('div', { class: 'c6 stack' },
        panel([L('Endereço e token'), L('O token dá acesso ao gateway, não às chaves dos provedores')], moreButton([{ label: L('Trocar token'), icon: 'arrows-clockwise', danger: true, onClick: () => confirmDo(L('Trocar token do gateway'), L('O token atual para de funcionar na hora. Você precisará atualizar o Claude Code.'), L('Trocar'), async () => { await api('POST', '/api/gateway-token/rotate', {}); route(); }) }]),
          h('div', { class: 'panel-body stack tight' }, copyLine(L('URL base'), c.baseUrl), copyLine(L('Token do gateway'), c.token, true))),
        panel([L('Aliases publicados'), L('O que o Claude Code enxerga em /v1/models')], null,
          hidden.length > 0 && h('div', { class: 'panel-body' }, notice(hidden.length === 1 ? L('O seletor do Claude Desktop descarta ids que citam outros fornecedores, mesmo com o prefixo claude-. Esse alias continua funcionando no terminal e como modelo padrão.') : L('O seletor do Claude Desktop descarta ids que citam outros fornecedores, mesmo com o prefixo claude-. Esses aliases continuam funcionando no terminal e como modelo padrão.'), 'warn')),
          c.models.length ? tableEl([L('Alias'), L('Terminal'), L('Seletor do Desktop')], c.models.map((m) => h('tr', {}, h('td', { class: 'mono' }, m.id), h('td', {}, badge(L('Aparece'), 'pos')), h('td', {}, m.desktop ? badge(L('Aparece'), 'pos') : badge(L('Oculto por "{0}"', m.blockedBy), 'warn')))))
            : h('div', { class: 'empty-state' }, L('Nenhum alias publicado.')))),
      h('div', { class: 'c6 stack' },
        panel('Claude Desktop', null, h('div', { class: 'panel-body' }, h('ol', { class: 'steps-list' },
          h('li', {}, h('span', {}, Ln('Menu {0}.', h('b', {}, 'Help › Troubleshooting › Enable Developer Mode')))),
          h('li', {}, h('span', {}, Ln('Menu {0}.', h('b', {}, 'Developer › Configure Third-Party Inference')))),
          h('li', {}, h('span', {}, Ln('Em {0}, escolha {1}.', h('b', {}, 'Inference provider'), h('b', {}, 'Gateway')))),
          h('li', {}, h('span', {}, Ln('Cole a URL em {0} e o token em {1}. Esquema: bearer.', h('b', {}, 'Gateway base URL'), h('b', {}, 'Gateway API key')))),
          h('li', {}, h('span', {}, Ln('Deixe {0} ligado, aplique e reinicie o app.', h('b', {}, 'Model discovery'))))))),
        panel([L('Terminal'), L('Mescle em ~/.claude/settings.json (faça uma cópia antes)')], h('button', { type: 'button', class: 'btn ghost sm icon-only', 'aria-label': L('Copiar'), 'data-tip': L('Copiar com o token'), onclick: async () => { await navigator.clipboard.writeText(cliJson); toast(L('Copiado')); } }, icon('copy')),
          h('div', { class: 'panel-body' }, h('pre', {}, cliJson.replace(c.token, L('<token do gateway>')))))))));
}

// ---------- configurações ----------
async function settings(sheet) {
  const { server: s, autoStartSupported, autoStartLabel, desktop, masterKeySource, logFile } = await api('GET', '/api/settings');
  // A ação ao fechar é do app instalado (desktop/preload.cjs), não do gateway: aparece sempre que o painel
  // está dentro do app, mesmo quando ele abriu um Rotaz de terminal.
  const closeAction = desk?.getCloseAction ? await desk.getCloseAction().catch(() => null) : null;
  const num = (v, min, max) => h('input', { type: 'number', value: v, min, max });
  const f = {
    host: h('select', {}, h('option', { value: '127.0.0.1' }, L('127.0.0.1 (só esta máquina)')), h('option', { value: '0.0.0.0' }, L('0.0.0.0 (rede local)'))),
    port: num(s.port, 1024, 65535), timeoutS: num(s.timeoutMs / 1000, 1, 3600), maxBodyMB: num(s.maxBodyMB, 1, 256),
    rateLimitPerMin: num(s.rateLimitPerMin, 0, 100000), maxConcurrent: num(s.maxConcurrent, 1, 1000), maxAttempts: num(s.maxAttempts, 1, 10),
    logLevel: h('select', {}, ['error', 'warn', 'info', 'debug'].map((v) => h('option', { value: v }, v))),
  };
  f.host.value = s.host; f.logLevel.value = s.logLevel;
  const save = async () => {
    try {
      const r = await api('PUT', '/api/settings', { host: f.host.value, port: Number(f.port.value), timeoutMs: Number(f.timeoutS.value) * 1000, maxBodyMB: Number(f.maxBodyMB.value), rateLimitPerMin: Number(f.rateLimitPerMin.value), maxConcurrent: Number(f.maxConcurrent.value), maxAttempts: Number(f.maxAttempts.value), logLevel: f.logLevel.value });
      if (r.rebind) { toast(L('Servidor mudando de porta…')); setTimeout(() => { location.href = `http://127.0.0.1:${r.port}/#/settings`; }, 1800); } else toast(L('Configurações salvas'));
    } catch (e) { fail(e); }
  };
  const pw = () => {
    const cur = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
    const nw = h('input', { type: 'password', required: true, minlength: 10, autocomplete: 'new-password' });
    dialog({ title: L('Trocar senha do painel'), body: h('div', { class: 'stack tight' }, field(L('Senha atual'), cur), field(L('Nova senha'), nw, L('Mínimo de 10 caracteres.'))),
      submit: async () => { await api('POST', '/api/password', { current: cur.value, password: nw.value }); boot(); } });
  };
  const swatches = h('div', { class: 'swatches', role: 'group', 'aria-label': L('Paleta') }, PALETTES.map((pal) => {
    const b = h('button', { type: 'button', class: 'swatch', 'aria-label': L(pal.name), 'data-tip': L(pal.name), 'aria-pressed': String(state.ui?.palette === pal.id),
      onclick: () => { for (const x of swatches.children) x.setAttribute('aria-pressed', String(x === b)); saveUi({ palette: pal.id }); } });
    b.style.setProperty('--sw', pal.sw);
    return b;
  }));
  sheet.replaceChildren(h('div', { class: 'page' },
    pageHead(L('Configurações'), L('Aparência, rede, limites e segurança do gateway.'), button(L('Salvar alterações'), save, 'primary')),
    h('div', { class: 'cols' },
      h('div', { class: 'c7 stack' },
        panel([L('Servidor'), L('Mudanças de porta religam o servidor e exigem atualizar o Claude Code')], null, h('div', { class: 'panel-body form-grid' },
          field(L('Endereço de escuta'), f.host, L('O painel continua restrito a esta máquina em qualquer opção.')), field(L('Porta'), f.port))),
        panel([L('Limites'), L('Protegem o gateway e os provedores contra excesso')], null, h('div', { class: 'panel-body form-grid' },
          field(L('Timeout do provedor (s)'), f.timeoutS, L('Sem resposta por esse tempo, a chamada falha.')), field(L('Tamanho máximo da requisição (MB)'), f.maxBodyMB),
          field(L('Requisições por minuto'), f.rateLimitPerMin, L('0 desliga o limite.')), field(L('Requisições simultâneas'), f.maxConcurrent),
          field(L('Tentativas por requisição'), f.maxAttempts, L('Soma chaves e fallback.')), field(L('Nível de log'), f.logLevel, logFile)))),
      h('div', { class: 'c5 stack' },
        panel([L('Aparência'), L('Vale para este painel em qualquer navegador')], null,
          setting(L('Tema'), L('Automático segue o sistema operacional.'), segmented([{ value: 'auto', label: L('Auto') }, { value: 'light', label: L('Claro') }, { value: 'dark', label: L('Escuro') }], state.ui?.theme ?? 'auto', (v) => saveUi({ theme: v }), { label: L('Tema') })),
          setting(L('Paleta'), L('Cor de destaque nos dados e na seleção.'), swatches),
          setting(L('Idioma'), L('O automático segue o idioma do sistema.'), langSelect(state.ui?.lang ?? 'auto', changeLang))),
        panel(L('Sistema e segurança'), null,
          setting(L(autoStartLabel), !autoStartSupported ? L('Disponível no Windows ou no app instalado.') : desktop ? L('Abre minimizado na bandeja ao entrar no sistema.') : L('Roda sem janela, na conta atual.'),
            autoStartSupported ? toggle(s.autoStart, async (v) => { await api('PUT', '/api/settings', { autoStart: v }).catch(fail); toast(v ? L('Inicialização automática ligada') : L('Inicialização automática desligada')); }, autoStartLabel) : badge(L('Indisponível'))),
          setting(L('Chave mestra'), { dpapi: L('Protegida pelo Windows (DPAPI) e vinculada à sua conta.'), keychain: L('Protegida pelo cofre do sistema (Keychain ou equivalente).'), env: L('Vem da variável GATEWAY_MASTER_KEY.'), file: L('Arquivo local com permissão restrita.') }[masterKeySource], badge(masterKeySource === 'keychain' ? L('Cofre do sistema') : masterKeySource.toUpperCase(), 'pos')),
          closeAction && setting(L('Ao fechar a janela'), closeAction === 'quit' ? (desktop ? L('O app e o gateway encerram juntos.') : L('O app encerra. O gateway da versão de terminal continua rodando.')) : L('O app continua na bandeja e o gateway segue funcionando. Um aviso confirma.'),
            segmented([{ value: 'tray', label: L('Manter na bandeja') }, { value: 'quit', label: L('Encerrar o app') }], closeAction, async (v) => {
              try {
                await desk.setCloseAction(v);
                toast(v === 'quit' ? L('Fechar a janela agora encerra o Rotaz') : L('Fechar a janela agora mantém o Rotaz na bandeja'));
                route();
              } catch (e) { fail(e); }
            }, { label: L('Ao fechar a janela') })),
          setting(L('Senha do painel'), null, button(L('Trocar senha'), pw, 'sm', { icon: 'lock-simple' })))))));
}

// ---------- registros ----------
async function logs(sheet) {
  const box = h('pre', { class: 'logbox' });
  let level = 'all';
  let lines = [];
  const paint = () => {
    const shown = level === 'all' ? lines : lines.filter((l) => (level === 'warn' ? / (WARN|ERROR) / : / ERROR /).test(l));
    const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
    box.textContent = shown.join('\n') || L('Nada para mostrar.');
    if (stick) box.scrollTop = box.scrollHeight;
  };
  const load = async () => { lines = (await api('GET', '/api/logs')).lines; paint(); };
  sheet.replaceChildren(h('div', { class: 'page' },
    pageHead(L('Registros'), L('Segredos são redigidos antes de gravar; o conteúdo das mensagens nunca é registrado.'), [
      segmented([{ value: 'all', label: L('Tudo') }, { value: 'warn', label: L('Avisos') }, { value: 'error', label: L('Erros') }], level, (v) => { level = v; paint(); }, { label: L('Filtro') }),
      button('', () => load().catch(fail), 'icon-only', { icon: 'arrows-clockwise', 'aria-label': L('Atualizar'), 'data-tip': L('Atualizar') })]),
    h('section', { class: 'panel' }, h('div', { class: 'panel-body' }, box))));
  await load();
  box.scrollTop = box.scrollHeight;
  state.timer = setInterval(() => load().catch(() => {}), 5000);
}

const VIEWS = { overview, providers, routing, client, settings, logs };

// Mesma lista do servidor (src/security.js), para o aviso imediato ao digitar o alias.
window.DESKTOP_DENY = /ark-code|astron|command-r|deepseek|doubao|gemini|gemma|glm|gpt|grok|hermes|hy3|kimi|lfm|\bling\b|llama|longcat|mimo|minimax|mistral|mixtral|moonshot|nemotron|openai|phi-|qianfan|qwen|tc-code|\bunic\b|yi-|stepfun|step-3|seed-|bytedance|hunyuan|granite|amazon\.nova|nova-|devstral|ministral|ernie|codex|arcee|trinity|abab|phi\d|\bk2\.|\bm2\.|jamba|arctic|solar|mercury|zamba|kat-coder|\bds-|dpsk/;

// ---------- abertura e boas-vindas (app instalado, primeira vez) ----------
/**
 * Abertura animada em canvas (public/splash.js): tubos de tinta formam a logo, um tubo sai pela direita, a câmera
 * vai junto e os tubos escrevem "Olá, bem-vindo". A cena para aí, com o botão Próximo; ele abre as boas-vindas.
 * Só no app instalado e só na primeira vez. Clique ou tecla durante a cena pulam para o fim dela.
 * As cores vêm dos tokens a cada quadro: segue o tema (e a troca do tema do sistema) no meio da animação.
 * Com movimento reduzido, a saudação aparece pronta.
 */
async function splash() {
  if (!desk?.shouldShowSplash || !(await desk.shouldShowSplash().catch(() => false))) return;
  desk.markSplashSeen().catch(() => {});
  const canvas = h('canvas', { 'aria-hidden': 'true' });
  const stage = h('div', { class: 'splash-stage' }, canvas);
  const layer = h('div', { class: 'splash', role: 'dialog', 'aria-modal': 'true', 'aria-label': L('Boas-vindas ao Rotaz') }, stage);
  document.body.append(layer);
  root.inert = true; // nada do painel por baixo recebe foco ou teclas enquanto a abertura está na tela

  const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const isDark = (hex) => { const n = parseInt(hex.replace('#', '').slice(0, 6), 16); return ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 < 128; };
  const colors = () => { const ground = token('--bg'), ink = token('--ink'); return { ground, ink, dark: isDark(ground) }; };
  let render = null, ended = false, fallback = null;
  const paint = (t) => {
    const dpr = Math.min(2, devicePixelRatio || 1), w = Math.round(canvas.clientWidth * dpr), hh = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== hh) { canvas.width = w; canvas.height = hh; }
    render?.(t);
  };
  const repaint = () => paint(render?.duration ?? 0);
  const skipKey = (e) => { if (!e.repeat) { e.preventDefault(); end(); } };

  // fim da cena: a saudação fica parada e aparece o botão Próximo
  function end() {
    if (ended) return;
    ended = true;
    removeEventListener('keydown', skipKey, true);
    layer.removeEventListener('click', end);
    repaint();
    const onResize = () => { repaint(); settle(false); };
    addEventListener('resize', onResize);
    const next = button(L('Próximo'), () => { removeEventListener('resize', onResize); onboarding(layer, stage, foot); }, 'primary lg splash-next');
    // a língua já vem escolhida pelo sistema; trocar aqui reescreve a saudação e vale para o resto do app
    const lang = langSelect(currentLang(), async (code) => {
      pendingLang.set(code);
      await setLanguage(code);
      rerender(); // o que está por baixo (barra de título, tela de entrada) já muda junto
      next.textContent = L('Próximo');
      lang.setAttribute('aria-label', L('Idioma'));
      layer.setAttribute('aria-label', L('Boas-vindas ao Rotaz'));
      if (fallback) { fallback.textContent = L('Olá, bem-vindo'); return; }
      try { render = (await import('/splash.js')).RotazSplash(canvas, { colors, greeting: L('Olá, bem-vindo') }); } catch { return; }
      repaint();
      animate(canvas, { opacity: [0.2, 1] }, { duration: 0.6 });
    }, { auto: false, cls: 'splash-lang' });
    const foot = h('div', { class: 'splash-foot' }, h('label', { class: 'splash-lang-wrap' }, icon('globe'), lang), next);
    layer.append(foot);
    // Saudação, idioma e botão formam um bloco só, centrado em qualquer tamanho de janela: a cena sobe metade
    // da altura dos controles e eles ficam logo abaixo da saudação (medida na escala em que a cena está).
    const GAP = 40, HALF = 64; // HALF: meia altura da saudação na composição de 1920 × 1080
    function settle(first) {
      const fit = Math.min(stage.clientWidth / 1920, stage.clientHeight / 1080);
      const shift = Math.round((GAP + foot.offsetHeight) / 2);
      const y = `translateY(${-shift}px)`;
      if (first) animate(stage, { transform: ['translateY(0px)', y] }, { duration: 0.8 });
      stage.style.transform = y;
      foot.style.top = `${Math.round(stage.offsetTop + stage.clientHeight / 2 - shift + HALF * fit + GAP)}px`;
    }
    settle(true);
    animate(foot, { opacity: [0, 1], transform: ['translateY(8px)', 'translateY(0)'] }, { duration: 0.6 });
    next.focus();
  }

  try { ({ RotazSplash: render } = await import('/splash.js')); render = render(canvas, { colors, greeting: L('Olá, bem-vindo') }); } catch { render = null; }
  if (!render) { fallback = h('p', { class: 'onb-title splash-fallback' }, L('Olá, bem-vindo')); stage.append(fallback); end(); return; }
  if (reduced()) { end(); return; }
  layer.addEventListener('click', end);
  addEventListener('keydown', skipKey, true);
  const start = performance.now();
  const frame = (now) => {
    if (ended) return;
    const t = (now - start) / 1000;
    paint(Math.min(t, render.duration));
    if (t >= render.duration) end(); else requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** Boas-vindas em páginas, no lugar da saudação: arte, título e texto centrados; pontos e botões embaixo. */
async function onboarding(layer, stage, foot) {
  const status = await api('GET', '/api/auth/status').catch(() => ({}));
  const P = (icon, name) => providerIcon({ icon, name }, 'lg');
  const PAGES = [
    { title: L('Qualquer modelo no Claude Code'),
      text: L('Conecte OpenAI, Gemini, DeepSeek, modelos locais e dezenas de outros provedores. O Claude Code continua o mesmo; o Rotaz traduz cada pedido no caminho.'),
      art: () => h('div', { class: 'onb-providers' }, P('openai', 'OpenAI'), P('gemini', 'Gemini'), P('deepseek', 'DeepSeek'), P('qwen', 'Qwen'), P('ollama', 'Ollama')) },
    { title: L('Você decide a rota'),
      text: L('Escolha qual provedor atende cada modelo. Com o fallback ligado, se um provedor falhar antes de responder, o pedido segue para o próximo da lista.'),
      art: () => h('div', { class: 'onb-route' },
        h('div', { class: 'onb-route-row' }, h('code', {}, 'claude-sonnet'), icon('arrow-right'), P('deepseek', 'DeepSeek'), h('span', {}, 'DeepSeek')),
        h('div', { class: 'onb-route-row alt' }, h('span', { class: 'onb-route-if' }, L('se falhar')), icon('arrow-right'), P('openrouter', 'OpenRouter'), h('span', {}, 'OpenRouter'))) },
    { title: L('Suas chaves ficam aqui'),
      text: L('As chaves de API são cifradas nesta máquina e nunca voltam para a tela. O painel é protegido por uma senha que só você conhece.'),
      art: () => h('div', { class: 'onb-key' }, icon('lock-simple', 'onb-key-ico'), h('code', {}, 'sk-••••••••••••••••'), h('span', { class: 'onb-key-tag' }, icon('shield-check'), 'cifrada')) },
    { title: L('Pronto para começar'),
      text: status.configured
        ? L('Entre com sua senha, adicione um provedor e aponte o Claude Code para o Rotaz. Leva um minuto.')
        : L('Crie a senha do painel, adicione um provedor e aponte o Claude Code para o Rotaz. Leva um minuto.'),
      art: () => h('pre', { class: 'onb-code' }, h('code', {}, `ANTHROPIC_BASE_URL=${location.origin}\nclaude`)) },
  ];

  let index = 0, busy = false;
  const body = h('div', { class: 'onb-body' });
  const dots = PAGES.map((_, i) => h('button', { type: 'button', class: 'onb-dot', 'aria-label': L('Página {0} de {1}', i + 1, PAGES.length), onclick: () => go(i) }));
  const back = button(L('Voltar'), () => go(index - 1), 'ghost lg');
  const next = button(L('Continuar'), () => (index === PAGES.length - 1 ? close() : go(index + 1)), 'primary lg onb-next');
  const skip = button(L('Pular'), () => close(), 'ghost onb-skip');
  const onb = h('div', { class: 'onb' }, h('div', { class: 'onb-top' }, skip), body,
    h('div', { class: 'onb-foot' }, h('div', { class: 'onb-dots' }, dots), h('div', { class: 'onb-actions' }, back, next)));

  const page = (i) => {
    const p = PAGES[i];
    return h('div', { class: 'onb-page' }, h('div', { class: 'onb-art' }, p.art()), h('h2', { class: 'onb-title' }, p.title), h('p', { class: 'onb-text' }, p.text));
  };
  const paintControls = () => {
    dots.forEach((d, i) => d.setAttribute('aria-current', i === index ? 'step' : 'false'));
    back.hidden = index === 0; // na primeira página, Continuar ocupa a largura toda
    next.textContent = index === PAGES.length - 1 ? L('Começar') : L('Continuar');
  };
  // entrada da página: arte, título e texto chegam do lado da navegação, escalonados; a arte ainda sobe por dentro
  const enterPage = (el, dir) => {
    if (reduced() || !M) return;
    M.animate([...el.children], { opacity: [0, 1], transform: [`translateX(${36 * dir}px)`, 'translateX(0)'] }, { duration: 0.6, ease: EASE, delay: M.stagger(0.07) });
    const bits = el.querySelectorAll('.onb-art .picon, .onb-art .onb-route-row, .onb-art .onb-key > *, .onb-art .onb-code');
    if (bits.length) M.animate([...bits], { opacity: [0, 1], transform: ['translateY(12px) scale(.96)', 'translateY(0) scale(1)'] }, { duration: 0.7, ease: EASE, delay: M.stagger(0.06, { startDelay: 0.12 }) });
  };
  async function go(i) {
    if (busy || i === index || i < 0 || i >= PAGES.length) return;
    busy = true;
    const dir = i > index ? 1 : -1, old = body.firstElementChild;
    const out = animate(old, { opacity: [1, 0], transform: ['translateX(0)', `translateX(${-28 * dir}px)`] }, { duration: 0.28, ease: [0.4, 0, 1, 1] });
    if (out) await out.finished;
    index = i;
    const el = page(i);
    body.replaceChildren(el);
    paintControls();
    enterPage(el, dir);
    busy = false;
  }
  function close() {
    removeEventListener('keydown', keys, true);
    const done = async () => {
      layer.remove(); root.inert = false;
      document.querySelector('#app input')?.focus();
    };
    const a = animate(layer, { opacity: [1, 0], transform: ['scale(1)', 'scale(1.01)'] }, { duration: 0.6 });
    if (a) a.finished.then(done); else done();
  }
  function keys(e) {
    if (e.key === 'ArrowRight') { e.preventDefault(); go(index + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(index - 1); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  }

  // da saudação para a primeira página: a cena recua e some, as boas-vindas entram
  const leave = [animate(stage, { opacity: [1, 0], transform: ['scale(1)', 'scale(.97)'] }, { duration: 0.5 }), animate(foot, { opacity: [1, 0] }, { duration: 0.3 })];
  await Promise.all(leave.filter(Boolean).map((a) => a.finished));
  stage.remove(); foot.remove();
  const first = page(0);
  body.append(first);
  paintControls();
  layer.append(onb);
  addEventListener('keydown', keys, true);
  animate(onb.querySelector('.onb-foot'), { opacity: [0, 1], transform: ['translateY(8px)', 'translateY(0)'] }, { duration: 0.6, delay: 0.25 });
  enterPage(first, 1);
  next.focus();
}

async function boot() {
  mountTitlebar();
  const s = await api('GET', '/api/auth/status');
  applyUi(s.ui);
  if (!s.authenticated) { setTitle(s.configured ? L('Entrar') : L('Primeiro acesso')); authScreen(s); return; }
  // idioma escolhido na abertura, antes de existir sessão: agora é salvo no painel
  const chosen = pendingLang.get();
  if (chosen) { await api('PUT', '/api/ui', { lang: chosen }).catch(() => {}); pendingLang.clear(); s.ui = { ...s.ui, lang: chosen }; applyUi(s.ui); }
  shell(s);
  route();
}

window.addEventListener('hashchange', () => { if (document.getElementById('sheet')) route(); });
let relayout;
window.addEventListener('resize', () => { paintNav(); clearTimeout(relayout); relayout = setTimeout(() => layoutLabels(document), 120); });

// A barra de rolagem só aparece enquanto o usuário mexe o mouse ou rola, e some 1,2 s depois.
let scrollHide;
const revealScroll = () => {
  document.documentElement.classList.add('show-scroll');
  clearTimeout(scrollHide);
  scrollHide = setTimeout(() => document.documentElement.classList.remove('show-scroll'), 1200);
};
for (const ev of ['wheel', 'mousemove', 'touchmove', 'keydown']) window.addEventListener(ev, revealScroll, { passive: true });
window.addEventListener('scroll', revealScroll, { passive: true, capture: true });
splash();
boot().catch((e) => root.replaceChildren(h('main', { class: 'auth' }, h('p', {}, L('Não foi possível abrir o painel: {0}', e.message)))));
