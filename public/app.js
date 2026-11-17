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
  detect: () => 'pt-BR',
}));
const { LANGS, t: L, tn: Ln, setLanguage, pending: pendingLang, current: currentLang, detect: detectLang } = i18n;
/** Marca textos de tabelas fixas como chaves de tradução; a tradução acontece onde eles aparecem. */
const LK = (s) => s;
// Idioma antes de qualquer texto: escolhido na abertura (ainda sem login) > salvo no painel > o do sistema.
const firstStatus = await fetch('/api/auth/status').then((r) => r.json()).catch(() => ({}));
await setLanguage(pendingLang.get() ?? firstStatus.ui?.lang ?? 'auto');

const root = document.getElementById('app');
// Regras de nome do Claude Code e do Claude Desktop, as mesmas do servidor (public/alias.js).
const { analyzeAlias, aliasSuggestions, bestAlias } = await import('/alias.js').catch(() => ({
  analyzeAlias: (a) => ({ alias: String(a).toLowerCase(), problem: null, valid: true, cli: true, desktop: true, blocked: [] }),
  aliasSuggestions: () => [], bestAlias: () => 'claude-modelo',
}));

const state = { view: 'overview', sub: [], provider: null, tests: {}, timer: null, sel: {}, live: {}, mfilter: {}, aliases: [], runs: new Map(), catalog: null, quota: {}, quotaReloaded: new Set() };

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
const SPRITE = '/vendor/icons.svg?v=4';
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
function menu(anchor, items, placement) {
  closeMenu();
  const el = h('div', { class: 'menu', role: 'menu' }, items.filter(Boolean).map((it) => (it === 'sep' ? h('hr') : h('button', {
    type: 'button', role: 'menuitem', class: it.danger ? 'danger' : undefined, disabled: it.disabled,
    onclick: () => { closeMenu(); it.onClick(); },
  }, it.icon && icon(it.icon), it.label))));
  el.style.left = '-9999px';
  document.body.append(el);
  place(anchor, el, placement);
  animate(el, { opacity: [0, 1], transform: ['translateY(-4px)', 'translateY(0)'] }, { duration: 0.18 });
  const onDoc = (e) => { if (!el.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) closeMenu(); };
  const onKey = (e) => { if (e.key === 'Escape') { closeMenu(); anchor.focus(); } };
  // O clique que abriu o menu ainda está propagando: o fechamento por clique fora só vale a partir do próximo.
  let closed = false;
  setTimeout(() => { if (!closed) document.addEventListener('pointerdown', onDoc); }, 0);
  document.addEventListener('keydown', onKey);
  openMenu = () => { closed = true; el.remove(); document.removeEventListener('pointerdown', onDoc); document.removeEventListener('keydown', onKey); };
  el.querySelector('button')?.focus();
}
const moreButton = (items, label = L('Mais ações')) => h('button', { type: 'button', class: 'btn ghost sm icon-only', 'aria-label': label, 'aria-haspopup': 'menu',
  onclick: (e) => menu(e.currentTarget, typeof items === 'function' ? items() : items) }, icon('dots-three'));

// Dicas: qualquer elemento com data-tip.
let tipEl = null;
let tipFor = null; // elemento da dica aberta: passar por cima dos filhos dele não recria a dica
document.addEventListener('mouseover', (e) => {
  const t = e.target.closest?.('[data-tip]');
  if (!t || !FUI || t === tipFor) return;
  tipEl?.remove();
  tipFor = t;
  tipEl = h('div', { class: 'tooltip', role: 'tooltip' }, t.dataset.tip);
  tipEl.style.left = '-9999px';
  document.body.append(tipEl);
  place(t, tipEl, 'top');
  animate(tipEl, { opacity: [0, 1] }, { duration: 0.12 });
  t.addEventListener('mouseleave', () => { tipEl?.remove(); tipEl = null; tipFor = null; }, { once: true });
});

// ---------- API ----------
class ApiError extends Error { constructor(s, m) { super(m); this.status = s; } }
async function api(method, path, body, { signal } = {}) {
  const r = await fetch(path, { method, signal, headers: { 'content-type': 'application/json', 'x-gateway-csrf': '1', 'x-rotaz-lang': currentLang() }, body: body === undefined ? undefined : JSON.stringify(body) });
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
/** Dinheiro na moeda escolhida; valores pequenos ganham casas para não virarem zero. */
const money = (v, cur = 'USD') => new Intl.NumberFormat(currentLang(), { style: 'currency', currency: cur, minimumFractionDigits: 2, maximumFractionDigits: v > 0 && v < 0.1 ? 4 : 2 }).format(v ?? 0);
/** Preço de modelo em dólar por 1M de tokens, curto: "US$ 0,27 · 1,10". */
const priceText = (m) => `${money(m.priceIn ?? 0)} · ${new Intl.NumberFormat(currentLang(), { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(m.priceOut ?? 0)}`;
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
function dialog({ title, sub, body, submitLabel = L('Salvar'), submit, danger, wide, info }) {
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
  h('div', { class: 'dlg-foot' }, !info && h('button', { type: 'button', class: 'btn', onclick: close }, L('Cancelar')), go));
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
const REPO_URL = 'https://github.com/alissonpaganini/rotaz';
/** Link externo: no app, abre no navegador do sistema (desktop/main.js); no navegador, numa aba nova. */
const openLink = (url) => window.open(url, '_blank', 'noopener,noreferrer');

// ---------- menu da logo ----------
/** A logo é um botão: abre o menu do Rotaz (perfil, ajuda e Sobre). */
function brandButton(cls, size) {
  return h('button', { type: 'button', class: `${cls} brand-btn`, 'aria-haspopup': 'menu', 'aria-label': L('Menu do Rotaz'),
    onclick: (e) => appMenu(e.currentTarget) }, wordmark(size), icon('caret-down', 'brand-caret'));
}
function appMenu(anchor) {
  const authed = !!document.querySelector('.shell'); // backup só com o painel aberto (depois de entrar)
  const up = updateAction(updates.info);
  menu(anchor, [
    up && { label: up.label, icon: 'arrows-clockwise', onClick: up.run },
    up && 'sep',
    { label: L('Exportar perfil…'), icon: 'download-simple', disabled: !authed, onClick: exportProfileDialog },
    { label: L('Importar perfil…'), icon: 'upload-simple', disabled: !authed, onClick: pickProfile },
    'sep',
    { label: L('Documentação'), icon: 'arrow-square-out', onClick: () => openLink(`${SITE_URL}/docs.html`) },
    { label: L('Reportar um problema'), icon: 'warning-circle', onClick: () => openLink(`${REPO_URL}/issues`) },
    { label: L('Sobre o Rotaz'), icon: 'info', onClick: aboutDialog },
  ], 'bottom-start');
}

// ---------- atualizações ----------
// Dois jeitos: no app do Windows, o próprio app baixa e instala (desktop/main.js, modo 'auto'); no terminal e no
// macOS, o servidor consulta as Releases e o painel só avisa, com o link de download (src/updates.js, modo 'notify').
const updates = { info: null, listeners: new Set() };
async function loadUpdate({ force = false } = {}) {
  let u;
  const fromApp = desk?.updateState ? await desk.updateState().catch(() => null) : null;
  if (fromApp?.mode === 'auto') {
    if (force) await desk.updateAction('check').catch(() => {});
    u = { mode: 'auto', enabled: fromApp.enabled, current: fromApp.current, version: fromApp.version, status: fromApp.status, percent: fromApp.percent, error: fromApp.error };
  } else {
    const r = await api(force ? 'POST' : 'GET', force ? '/api/update/check' : '/api/update').catch(() => null);
    if (!r) return updates.info;
    u = { mode: 'notify', enabled: r.enabled, current: r.current, version: r.latest, status: r.error ? 'error' : r.newer ? 'available' : r.checkedAt ? 'none' : 'idle', url: r.url, error: r.error };
  }
  setUpdate(u);
  return u;
}
function setUpdate(u) {
  const was = updates.info?.status;
  updates.info = u;
  for (const b of document.querySelectorAll('.brand-btn')) b.classList.toggle('has-update', u.enabled && ['ready', 'available'].includes(u.status));
  if (u.status === 'ready' && was && was !== 'ready') toast(L('Versão {0} baixada. Reinicie para atualizar.', u.version));
  updateGate(u);
  for (const fn of updates.listeners) fn(u);
}
window.rotazDesktop?.onUpdate?.((st) => { if (st.mode === 'auto') setUpdate({ ...updates.info, mode: 'auto', enabled: updates.info?.enabled ?? true, current: st.current, version: st.version, status: st.status, percent: st.percent, error: st.error }); });
/** Frase de estado da atualização, para Configurações. */
function updateText(u) {
  if (!u) return '';
  if (!u.enabled) return L('Desligado. Você está na versão {0}.', u.current ?? '—');
  return {
    checking: L('Procurando versão nova…'),
    downloading: L('Baixando a versão {0}… {1}%', u.version, u.percent ?? 0),
    ready: L('Versão {0} pronta para instalar.', u.version),
    available: L('Versão {0} disponível. Você está na {1}.', u.version, u.current),
    none: L('Você está na versão mais recente ({0}).', u.current),
    error: L('Não foi possível verificar agora. Tente de novo mais tarde.'),
  }[u.status] ?? L('Versão {0}.', u.current ?? '—');
}
/** A ação que a atualização pede agora: instalar (app) ou baixar (aviso), ou nada. */
function updateAction(u) {
  if (!u?.enabled) return null;
  if (u.status === 'ready') return { label: L('Reiniciar e atualizar para {0}', u.version), run: () => desk.updateAction('install') };
  if (u.status === 'available') return { label: L('Baixar a versão {0}', u.version), run: () => openLink(u.url) };
  return null;
}

/** Salva um arquivo pelo navegador (no app, o sistema pergunta onde guardar). */
function saveFile(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Exportar: o perfil vai sem segredos; com senha, as chaves vão junto, cifradas com ela. */
function exportProfileDialog() {
  const withKeys = h('input', { type: 'checkbox' });
  const pw = h('input', { type: 'password', minlength: 8, autocomplete: 'new-password' });
  const pw2 = h('input', { type: 'password', minlength: 8, autocomplete: 'new-password' });
  const secret = h('div', { class: 'form-grid' }, field(L('Senha do backup'), pw, L('8 caracteres ou mais. Sem ela, não há como recuperar as chaves do arquivo.')), field(L('Repita a senha'), pw2));
  secret.hidden = true;
  withKeys.addEventListener('change', () => { secret.hidden = !withKeys.checked; if (withKeys.checked) pw.focus(); });
  dialog({
    title: L('Exportar perfil'),
    sub: L('Provedores, modelos, rotas, orçamento, aparência e limites num arquivo. A senha do painel e o token do gateway não vão junto.'),
    submitLabel: L('Exportar'),
    body: h('div', { class: 'stack tight' }, h('label', { class: 'check' }, withKeys, L('Incluir as chaves de API, protegidas por uma senha')), secret),
    submit: async () => {
      if (withKeys.checked && pw.value.length < 8) throw new Error(L('A senha do backup precisa de 8 caracteres ou mais.'));
      if (withKeys.checked && pw.value !== pw2.value) throw new Error(L('As senhas não são iguais.'));
      const file = await api('POST', '/api/backup/export', withKeys.checked ? { password: pw.value } : {});
      const d = new Date(), pad = (n) => String(n).padStart(2, '0');
      saveFile(JSON.stringify(file, null, 2), `rotaz-perfil-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`);
      toast(withKeys.checked ? L('Perfil exportado com as chaves') : L('Perfil exportado sem as chaves'));
    },
  });
}

/** Importar: escolhe o arquivo, confere e mostra o que vem nele antes de aplicar. */
function pickProfile() {
  const input = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    input.remove();
    if (!f) return;
    let file;
    try { file = JSON.parse(await f.text()); } catch { toast(L('Este arquivo não é um backup do Rotaz.'), 'error'); return; }
    try { importProfileDialog(file, await api('POST', '/api/backup/inspect', { file })); } catch (e) { fail(e); }
  });
  document.body.append(input);
  input.click();
}

function importProfileDialog(file, info) {
  let mode = 'replace';
  const pw = h('input', { type: 'password', autocomplete: 'off' });
  const modeHint = h('div', { class: 'hint' });
  const paintMode = () => { modeHint.textContent = mode === 'replace'
    ? L('Os provedores, rotas, orçamento, aparência e limites atuais são trocados pelos do arquivo.')
    : L('Os provedores do arquivo entram junto com os atuais. Rotas, orçamento e aparência ficam como estão.'); };
  paintMode();
  const when = info.exportedAt ? new Date(info.exportedAt).toLocaleString(currentLang(), { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  dialog({
    title: L('Importar perfil'),
    sub: L('Exportado em {0}', when),
    submitLabel: L('Importar'),
    body: h('div', { class: 'stack tight' },
      h('div', { class: 'row' }, badge(L('{0} provedor(es)', info.providers)), badge(L('{0} modelo(s)', info.models)),
        info.secrets ? badge(L('Chaves incluídas'), 'pos') : badge(L('Sem chaves'), 'warn')),
      info.secrets && field(L('Senha do backup'), pw, L('Sem a senha, os provedores entram sem as chaves.')),
      field(L('Como importar'), segmented([{ value: 'replace', label: L('Substituir tudo') }, { value: 'merge', label: L('Acrescentar provedores') }], mode, (v) => { mode = v; paintMode(); }, { label: L('Como importar') })),
      modeHint),
    submit: async () => {
      const r = await api('POST', '/api/backup/import', { file, password: pw.value || undefined, mode });
      toast(r.keysImported || !info.secrets ? L('Perfil importado') : L('Perfil importado sem as chaves'));
      // tema, idioma e tudo o mais podem ter mudado: o painel recarrega já com o perfil novo
      setTimeout(() => location.reload(), 600);
    },
  });
  if (info.secrets) pw.focus();
}

async function aboutDialog() {
  const { version } = await api('GET', '/api/auth/status').catch(() => ({}));
  const link = (label, url) => h('a', { class: 'btn ghost sm', href: url, target: '_blank', rel: 'noopener noreferrer' }, label, icon('arrow-square-out'));
  dialog({
    title: L('Sobre o Rotaz'), info: true, submitLabel: L('Fechar'), submit: async () => {},
    body: h('div', { class: 'about' },
      wordmark('wm-auth'),
      h('p', { class: 'small muted' }, version ? L('Versão {0}', version) : null),
      h('p', {}, L('Gateway local que deixa o Claude Code usar modelos de outros provedores.')),
      h('p', { class: 'small muted' }, L('Código aberto, licença MIT. Não é afiliado à Anthropic.')),
      h('div', { class: 'row' }, link(L('Site'), SITE_URL), link('GitHub', REPO_URL), link(L('Documentação'), `${SITE_URL}/docs.html`))),
  });
}

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
        // Primeiro acesso: a configuração guiada vem logo depois da senha.
        history.replaceState(null, '', '/#/start');
        state.firstRun = true; // o guia entra direto, sem esmaecer sobre o painel
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
  [LK('Integração'), [['start', LK('Começar'), 'rocket-launch'], ['client', 'Claude Code', 'terminal-window']]],
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
    brandButton('tb-brand', 'wm-sm'),
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
  const paint = () => { dot.className = `dot ${on ? 'pos' : 'warn'}`; name.textContent = on ? L('Gateway ativo') : L('Gateway desligado'); };
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
      brandButton('brand', 'wm-md'),
      h('div', { class: 'workspace' },
        h('div', { class: 'ws-top' }, dot, h('div', { class: 'ws-text' }, name, h('span', { class: 'ws-sub' }, status?.address ?? location.host)), sw),
        copyToken),
      lists,
      h('div', { class: 'side-foot' },
        themeSeg,
        button(L('Sair'), async () => { await api('POST', '/api/auth/logout', {}); stopPolling(); boot(); }, 'ghost logout', { icon: 'sign-out' }))),
    canvas));
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

function stopPolling() { clearInterval(state.timer); state.timer = null; state.onVisible = null; }

/** Atualização periódica que dorme com a janela escondida (bandeja, minimizada) e acorda na hora em que ela volta. */
function poll(fn, ms) {
  const tick = () => { if (!document.hidden) fn().catch(() => {}); };
  state.timer = setInterval(tick, ms);
  state.onVisible = tick;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) state.onVisible?.(); });

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
/** O provedor tem como autenticar: não precisa de chave, ou tem chave/conta ativa (lista do painel ou do dashboard). */
const hasAccess = (p) => p.authScheme === 'none' || (p.keyCount ?? p.keys?.filter((k) => k.enabled).length ?? 0) > 0;

function providerStatus(p) {
  if (!p.enabled) return [L('Desativado'), ''];
  if (!hasAccess(p)) return [L('Sem chave'), 'warn'];
  if (p.lastErrorAt && (!p.lastOkAt || p.lastErrorAt > p.lastOkAt)) return [L('Com falha'), 'neg'];
  if (p.lastOkAt) return [L('Conectado'), 'pos'];
  return [L('Sem tráfego'), ''];
}

function statusLine(d) {
  if (d.server.gatewayEnabled === false) return L('O gateway está desligado: o Claude Code recebe erro 503 até você religá-lo na barra lateral.');
  if (!d.providers.length) return L('Nenhum provedor cadastrado ainda.');
  if (!d.active && d.routeIssue?.reason === 'provider-off') return L('Sem rota ativa: o provedor do modelo padrão, {0}, está desligado.', d.routeIssue.provider.name);
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
/**
 * Gasto em dinheiro: o mês em destaque, hoje, os últimos 30 dias em barras, os provedores que mais gastaram
 * e o orçamento. Só conta modelos com preço cadastrado; os demais aparecem como aviso, com o caminho para cadastrar.
 */
/** Faixa no topo da visão geral quando o orçamento chega ao limite: diz o que está acontecendo com os pedidos. */
function budgetNotice(sp) {
  const b = sp?.budget;
  if (!b?.over) return null;
  const what = b.action === 'block' ? L('Os pedidos do Claude Code estão sendo recusados até o fim do período.')
    : b.action === 'switch' ? L('Os pedidos estão indo para {0} até o fim do período.', b.fallbackAlias)
    : L('Os pedidos continuam normalmente; só o aviso está ativo.');
  return h('div', { class: 'budget-notice' }, notice(what, 'warn', L('Limite de gastos atingido')), h('a', { class: 'btn sm', href: '#/settings' }, L('Ajustar limite')));
}

function spendWidget(d) {
  const sp = d.spend;
  const cur = sp?.currency ?? 'USD';
  const b = sp?.budget ?? {};
  const priced = d.providers.some((p) => p.pricedModels > 0);
  const status = b.over ? badge(L('Limite atingido'), 'neg') : b.warn ? badge(L('Perto do limite'), 'warn') : null;
  if (!sp || !priced) {
    return panel([L('Gasto'), L('Neste mês, nos modelos com preço')], null,
      h('div', { class: 'empty-state' }, icon('chart-bar', 'lg'), L('Cadastre o preço dos modelos para ver quanto você gasta.'),
        h('a', { class: 'btn', href: '#/providers' }, L('Abrir provedores'))));
  }
  const max = Math.max(...sp.days.map((x) => x.cost), 0);
  const bars = h('div', { class: 'spend-bars', role: 'img', 'aria-label': L('Gasto por dia nos últimos 30 dias') }, sp.days.map((x) => {
    const i = h('i', { 'data-tip': `${new Date(`${x.day}T12:00:00`).toLocaleDateString(currentLang(), { day: '2-digit', month: 'short' })} · ${money(x.cost, cur)}` });
    i.style.setProperty('--h', max > 0 ? String(Math.max(x.cost > 0 ? 0.04 : 0, x.cost / max)) : '0');
    return i;
  }));
  const limit = (label, pct, value, lim) => lim > 0 && h('div', { class: 'spend-limit' },
    h('div', { class: 'row spread small' }, h('span', { class: 'muted' }, label), h('span', {}, L('{0} de {1}', money(value, cur), money(lim, cur)))),
    meter(Math.min(100, pct ?? 0), pct >= 100 ? 'var(--d2)' : pct >= b.warnAt ? 'var(--d3)' : 'var(--d4)'));
  const top = Object.entries(sp.byProvider).sort((x, y) => y[1] - x[1]).slice(0, 3)
    .map(([id, v]) => [d.providers.find((p) => p.id === id)?.name ?? id, v]);
  return panel([L('Gasto'), L('Neste mês, nos modelos com preço')], status,
    h('div', { class: 'panel-body stack tight' },
      h('div', { class: 'row spread spend-head' }, h('div', { class: 'hero' }, money(sp.month, cur)), h('div', { class: 'small muted' }, L('Hoje: {0}', money(sp.today, cur)))),
      bars,
      limit(L('Limite do dia'), b.dayPct, sp.today, b.daily),
      limit(L('Limite do mês'), b.monthPct, sp.month, b.monthly),
      top.length > 0 && h('div', { class: 'spend-top' }, top.map(([name, v]) => h('div', { class: 'row spread small' }, h('span', { class: 'ellipsis' }, name), h('span', {}, money(v, cur))))),
      sp.unpricedMonth > 0 && h('a', { class: 'small muted spend-note', href: '#/providers' }, icon('info'), L('{0} pedido(s) deste mês sem preço cadastrado não entram na conta.', fmt(sp.unpricedMonth)))));
}

/** Sem rota ativa: diz o motivo (o servidor manda em `routeIssue`) e oferece a ação que resolve. */
function routeEmpty(d) {
  const add = button(L('Adicionar provedor'), addProvider, 'primary');
  const pick = (primary) => h('a', { class: `btn ${primary ? 'primary' : 'ghost'}`, href: '#/routing' }, L(primary ? 'Escolher modelo padrão' : 'Escolher outro modelo'));
  const fix = (label) => h('a', { class: 'btn primary', href: '#/providers' }, label);
  const x = d.routeIssue ?? { reason: 'no-default' };
  const name = x.provider?.name ?? '';
  let text, actions;
  if (!d.providers.length) [text, actions] = [L('Nenhuma rota ativa ainda.'), [add]];
  else if (x.reason === 'provider-off') {
    const on = button(L('Ligar {0}', name), async () => {
      on.disabled = true;
      try { await api('PUT', `/api/providers/${x.provider.id}`, { enabled: true }); toast(L('{0} ligado', name)); } catch (e) { fail(e); }
      route();
    }, 'primary');
    [text, actions] = [L('O modelo padrão, {0}, é do provedor {1}, que está desligado.', x.alias, name), [on, pick(false)]];
  } else if (x.reason === 'no-key') [text, actions] = [L('O modelo padrão, {0}, é do provedor {1}, que está sem chave ativa.', x.alias, name), [fix(L('Abrir provedores')), pick(false)]];
  else if (x.reason === 'model-off') [text, actions] = [L('O modelo padrão, {0}, está desativado.', x.alias), [fix(L('Abrir provedores')), pick(false)]];
  else if (x.reason === 'missing') [text, actions] = [L('O modelo padrão, {0}, não existe mais.', x.alias), [pick(true)]];
  else [text, actions] = [L('Nenhum modelo padrão escolhido.'), [pick(true)]];
  return h('div', { class: 'empty-state' }, h('div', {}, text), h('div', { class: 'row wrap' }, actions));
}

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
      : routeEmpty(d));

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
    })) : h('div', { class: 'empty-state' }, L('Nenhum provedor.'), h('a', { class: 'btn primary', href: '#/start' }, icon('rocket-launch'), L('Começar'))));

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

  const spendPanel = spendWidget(d);

  return {
    route: routePanel,
    success: healthPanel,
    spend: spendPanel,
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
  spend: { title: LK('Gasto'), def: 5, min: 4 },
  stats: { title: LK('Totais'), def: 12, min: 4 },
  requestsHills: { title: LK('Requisições por provedor'), def: 12, min: 5 },
  tokensHills: { title: LK('Tokens por provedor'), def: 6, min: 5 },
  latencyHills: { title: LK('Latência por provedor'), def: 6, min: 5 },
  traffic: { title: LK('Tráfego da última hora'), def: 7, min: 5 },
  providers: { title: LK('Provedores'), def: 5, min: 4 },
  recent: { title: LK('Requisições recentes'), def: 7, min: 5 },
  errors: { title: LK('Erros recentes'), def: 5, min: 3 },
};
const DEFAULT_LAYOUT = [['route', 8], ['success', 4], ['stats', 12], ['spend', 5], ['requestsHills', 7], ['traffic', 7], ['providers', 5], ['recent', 7], ['errors', 5]].map(([id, span]) => ({ id, span }));
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
  let health = null; // setupHealth(): o aviso de configuração que não funciona
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
    // configuração incompleta: nenhum quadro, só os passos em ordem (menos coisa para quem está começando)
    if (health && !health.done && !editing) {
      page.replaceChildren(pageHead(L('Visão geral'), L('Termine a configuração para o Claude começar a usar o Rotaz.')), setupCard(health, () => draw(true)));
      return;
    }
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
    page.replaceChildren(...[
      pageHead(L('Visão geral'), editing ? L('Arraste pela alça para reordenar; as linhas se ajustam sozinhas. A borda direita divide a largura.') : statusLine(data), actions),
      budgetNotice(data.spend),
      grid].filter(Boolean));
    if (!first) for (const v of page.querySelectorAll('.value[data-count]')) v.removeAttribute('data-count');
    requestAnimationFrame(() => layoutLabels(page));
  }

  // Assinatura do que aparece na tela: o tempo ativo conta em minutos e a memória do processo não aparece.
  // Sem mudança, a tela fica como está (redesenhar tudo a cada 4 s custava processamento à toa).
  let sig = '';
  // A checagem da configuração custa 3 pedidos e muda raramente: vai a cada 4 voltas (16 s), o tráfego a cada volta.
  let tick = 0;
  const draw = async (first) => {
    const fresh = first || tick++ % 4 === 0;
    const [d, hl] = await Promise.all([api('GET', '/api/dashboard'), fresh ? setupHealth().catch(() => null) : health]);
    if (state.view !== 'overview' || (editing && !first)) return; // não redesenha no meio de uma edição
    const next = JSON.stringify({ ...d, server: { ...d.server, uptimeMs: Math.floor(d.server.uptimeMs / 60000), rssMB: 0 }, setup: hl && [hl.steps, hl.cd?.checks, hl.cd?.restart, hl.cd?.running, hl.cd?.installed, hl.cd?.canUndo] });
    if (!first && next === sig) return;
    sig = next;
    data = d;
    health = hl;
    render(first);
  };
  await loadPresets().catch(() => {});
  await draw(true);
  poll(() => draw(false), 4000);
}

// ---------- provedores: utilidades ----------
const AUTH_LABEL = { bearer: 'Authorization: Bearer', 'x-api-key': 'x-api-key', 'api-key': 'api-key (Azure)', none: LK('Sem autenticação') };

/** Ordem alfabética pelo nome, no idioma da tela (acentos e maiúsculas não atrapalham). */
const byName = (a, b) => a.name.localeCompare(b.name, currentLang(), { sensitivity: 'base' });

async function loadPresets() {
  if (!state.catalog) {
    // nomes de grupo, avisos e os provedores personalizados vêm do servidor em português
    const c = await api('GET', '/api/presets');
    const presets = c.presets.map((p) => ({ ...p, name: L(p.name), ...(p.note && { note: L(p.note) }) }));
    // Só as contas (OAuth) em ordem alfabética, pelo nome no idioma da tela; os outros grupos mantêm a ordem do servidor.
    const accounts = presets.filter((p) => p.category === 'account').sort(byName);
    let next = 0;
    state.catalog = { categories: c.categories.map((x) => ({ ...x, name: L(x.name) })), presets: presets.map((p) => (p.category === 'account' ? accounts[next++] : p)) };
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
  const type = h('select', {}, h('option', { value: 'openai' }, L('Compatível com OpenAI')), h('option', { value: 'anthropic' }, 'Anthropic Messages'), h('option', { value: 'antigravity' }, L('Google Antigravity (conta Google)')));
  const baseUrl = h('input', { type: 'url', value: init.baseUrl ?? '', required: true, placeholder: 'https://api.exemplo.com/v1', spellcheck: 'false' });
  const auth = h('select', {}, Object.entries(AUTH_LABEL).map(([v, t]) => h('option', { value: v }, L(t))));
  const priority = h('input', { type: 'number', min: 0, max: 1000, value: init.priority ?? 10 });
  const rpm = h('input', { type: 'number', min: 0, max: 100000, value: init.rpm ?? 0 });
  const priv = h('input', { type: 'checkbox', checked: !!init.allowPrivateNetwork });
  const headers = h('textarea', { placeholder: 'X-Header: valor', spellcheck: 'false' });
  const key = h('input', { type: 'password', autocomplete: 'off', placeholder: init.authScheme === 'none' ? L('Não é necessária') : L('Cole a chave de API') });
  type.value = init.type ?? 'openai';
  auth.value = init.authScheme ?? (type.value === 'anthropic' ? 'x-api-key' : 'bearer');
  const keyField = isNew ? field(L('Chave de API'), key, L('Cifrada antes de ir para o disco. O navegador nunca mais a recebe.')) : null;
  // Antigravity não usa URL nem chave: o endpoint é fixo e a autenticação é OAuth no navegador.
  // Provedor com conta (tipo oauth): como o Antigravity, sem URL nem chave; o endereço vem da ficha do provedor.
  const account = init.type === 'oauth';
  // GitHub Enterprise: o login e a API ficam no servidor da empresa.
  const host = account && (init.needsHost || init.accountHost) ? h('input', { type: 'url', value: init.accountHost ?? '', required: true, placeholder: 'https://github.empresa.com', spellcheck: 'false' }) : null;
  if (account) type.append(h('option', { value: 'oauth' }, L('Conta (OAuth)')));
  type.value = init.type ?? 'openai';
  if (account) type.disabled = true;
  const syncOauth = () => {
    const is = type.value === 'antigravity' || account;
    baseUrl.disabled = is;
    auth.disabled = is;
    if (keyField) keyField.style.display = is ? 'none' : '';
    if (is) { baseUrl.value = account ? init.baseUrl : 'https://daily-cloudcode-pa.googleapis.com'; auth.value = 'bearer'; }
  };
  type.addEventListener('change', syncOauth);
  syncOauth();
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
    keyField,
    host ? field(L('Endereço do servidor da empresa'), host, L('O endereço do seu GitHub Enterprise, sem caminho.'), 'full') : field(L('URL base'), baseUrl, init.urlPlaceholder ? L('Troque {0} pelo seu valor.', init.urlPlaceholder) : null, 'full'),
    advanced);
  const read = () => {
    if (init.urlPlaceholder && baseUrl.value.includes(init.urlPlaceholder)) throw new Error(L('Troque {0} na URL base pelo seu valor.', init.urlPlaceholder));
    const isOauth = type.value === 'antigravity' || account;
    const body = { name: name.value, type: account ? 'oauth' : type.value, ...(account && { oauth: init.oauth }), ...(host && { accountHost: host.value.trim() }), baseUrl: account ? init.baseUrl : isOauth ? 'https://daily-cloudcode-pa.googleapis.com' : baseUrl.value, authScheme: isOauth ? 'bearer' : auth.value, priority: Number(priority.value), rpm: Number(rpm.value || 0), allowPrivateNetwork: priv.checked };
    if (headers.value.trim()) {
      body.headers = {};
      for (const l of headers.value.split('\n').filter((x) => x.trim())) {
        const i = l.indexOf(':');
        if (i < 1) throw new Error(L('Header inválido: {0}', l.slice(0, 30)));
        body.headers[l.slice(0, i).trim()] = l.slice(i + 1).trim();
      }
    }
    if (isNew && !isOauth && key.value.trim()) body.keys = [{ label: L('Principal'), key: key.value.trim() }];
    return body;
  };
  return { node, read, focus: () => (init.urlPlaceholder ? baseUrl : init.type === 'antigravity' || account ? name : init.name ? key : name).focus(), hasKey: () => !!key.value.trim() };
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
  const subtitle = (p) => (p.type === 'antigravity' ? L('Conta Google (OAuth)') : p.type === 'oauth' ? L('Conta (OAuth)') : p.category === 'local' ? L('Na sua máquina') : p.type === 'anthropic' ? L('Protocolo Anthropic') : p.category === 'custom' ? L('Qualquer endpoint') : L('Compatível com OpenAI'));
  const card = (p) => h('button', { type: 'button', class: 'pcard', onclick: () => open(p), 'data-tip': p.baseUrl || L('Você informa a URL') },
    providerIcon(p, 'lg'), h('span', { class: 'pcard-text' }, h('span', { class: 'pcard-name' }, p.name), h('span', { class: 'pcard-sub' }, subtitle(p))),
    p.paid && h('span', { class: 'pcard-badge' }, badge(L('Plano pago'), 'warn', PAID_TEXT())),
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
      toast(p.type === 'oauth' ? L('{0} adicionado. Agora conecte a sua conta.', body.name) : p.oauth ? L('{0} adicionado — agora conecte sua conta Google', body.name) : `${body.name} adicionado`);
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
      p.keyUrl && h('a', { class: 'btn', href: p.keyUrl, target: '_blank', rel: 'noopener noreferrer' }, L('Obter chave de API'), icon('arrow-square-out')),
      p.site && h('a', { class: 'btn', href: p.site, target: '_blank', rel: 'noopener noreferrer' }, L('Site do provedor'), icon('arrow-square-out'))),
    p.note && notice(p.note, 'accent'),
    p.paid && notice(PAID_TEXT(), 'warn', L('Precisa de plano pago ativo')),
    // Provedores com conta que se apresentam como o app oficial: o risco fica à vista antes de adicionar.
    p.risk && notice(p.risk, 'warn', L('Atenção aos termos de uso')),
    form));
  f.focus();
}

// ---------- provedores: detalhe ----------
// ---------- alias: onde o nome aparece ----------
const quoteTerms = (t) => t.map((x) => `"${x}"`).join(', ');
function aliasProblem(a) {
  return {
    empty: L('Dê um nome depois de "claude-".'),
    prefix: L('Comece com "claude-": o Claude Code só lista modelos com esse prefixo.'),
    chars: L('Use só letras minúsculas, números, ponto, hífen ou sublinhado.'),
    length: L('Use até 64 caracteres.'),
    taken: L('Este nome já existe neste provedor.'),
  }[a.problem] ?? '';
}
/** Selo de onde o alias aparece: no Claude Code do terminal e no seletor do Claude Desktop, ou só no terminal. */
function reachBadge(alias, suggestion, { strong = false } = {}) {
  const a = analyzeAlias(alias);
  if (!a.valid) return badge(L('Nome inválido'), 'neg', aliasProblem(a));
  if (a.desktop) return badge(L('CLI e Desktop'), strong ? 'pos' : '', L('Aparece no Claude Code do terminal e no seletor do Claude Desktop.'));
  return badge(L('Só CLI'), 'warn', suggestion
    ? L('Funciona no terminal. O seletor do Claude Desktop esconde nomes com {0}; "{1}" funciona nos dois.', quoteTerms(a.blocked), suggestion)
    : L('Funciona no terminal. O seletor do Claude Desktop esconde nomes com {0}.', quoteTerms(a.blocked)));
}

/**
 * Diagnóstico ao vivo do campo de alias e nomes que funcionam no CLI e no Desktop, com um clique para usar.
 * `upstream`: campo do identificador real (as sugestões também partem dele). `original`: nome antes de editar.
 */
function aliasAssist(input, { upstream, taken, original, onPick } = {}) {
  const status = h('div', { class: 'alias-status', role: 'status' });
  const picks = h('div', { class: 'alias-picks' });
  const paint = () => {
    const a = analyzeAlias(input.value, { taken });
    let mark, text;
    if (a.problem) { mark = badge(a.problem === 'taken' ? L('Em uso') : L('Nome inválido'), 'neg'); text = aliasProblem(a); }
    else if (a.desktop) { mark = badge(L('CLI e Desktop'), 'pos'); text = L('Aparece no Claude Code do terminal e no seletor do Claude Desktop. O provedor recebe o identificador real.'); }
    else { mark = badge(L('Só CLI'), 'warn'); text = L('Funciona no terminal, mas o seletor do Claude Desktop esconde nomes com {0}.', quoteTerms(a.blocked)); }
    if (original && !a.problem && a.alias !== original) text += ` ${L('Ao salvar, o roteamento passa para o nome novo; se você fixou o nome antigo no Claude Code, troque lá também.')}`;
    status.replaceChildren(mark, h('span', {}, text));
    const list = a.desktop && !a.problem ? [] : aliasSuggestions(input.value, { upstream: upstream?.value, taken });
    picks.hidden = !list.length;
    picks.replaceChildren(...(list.length ? [h('span', { class: 'small muted' }, L('Funcionam nos dois:')), ...list.map((sg) => button(sg.alias, () => {
      input.value = sg.alias;
      onPick?.(sg.alias);
      input.dispatchEvent(new Event('input'));
      input.focus();
    }, 'sm mono', { 'data-tip': sg.changes.length ? sg.changes.map((c) => `${c.from} → ${c.to}`).join(' · ') : undefined }))] : []));
  };
  input.addEventListener('input', paint);
  upstream?.addEventListener('input', paint);
  paint();
  return h('div', { class: 'alias-assist full' }, status, picks);
}

/** Esforço de raciocínio aceito pelos provedores OpenAI (reasoning_effort). */
const EFFORTS = ['minimal', 'low', 'medium', 'high'];
const effortOptions = () => EFFORTS.map((v) => h('option', { value: v }, v));

function modelDialog(p, m, isDefault = false, { alias: presetAlias } = {}) {
  const makeDefault = h('input', { type: 'checkbox', checked: isDefault, disabled: isDefault });
  let dlg;
  const alias = h('input', { type: 'text', value: presetAlias ?? m?.alias ?? state.aliasHint ?? 'claude-', required: true, spellcheck: 'false', autocomplete: 'off' });
  const upstream = h('input', { type: 'text', value: m?.upstream ?? '', required: true, spellcheck: 'false', autocomplete: 'off' });
  const display = h('input', { type: 'text', value: m?.displayName && m.displayName !== m.alias ? m.displayName : '' });
  const maxOut = h('input', { type: 'number', min: 1, value: m?.maxOutputTokens ?? '', placeholder: L('Sem limite') });
  const context = h('input', { type: 'number', min: 1000, max: 10000000, step: 1000, value: m?.contextWindow ?? '', placeholder: L('Não informado') });
  const images = imageSelect(false);
  images.value = m?.maxImages === null || m?.maxImages === undefined ? '' : String(m.maxImages);
  if (![...images.options].some((o) => o.value === images.value)) { images.append(h('option', { value: images.value }, L('Até {0} por requisição', images.value))); images.value = String(m.maxImages); }
  const effort = h('select', {}, h('option', { value: '' }, L('Não enviar')), effortOptions());
  effort.value = m?.reasoningEffort ?? '';
  const param = h('select', {}, ['auto', 'max_tokens', 'max_completion_tokens'].map((v) => h('option', { value: v }, v)));
  param.value = m?.tokenParam ?? 'auto';
  const priceIn = h('input', { type: 'number', min: 0, step: 'any', value: m?.priceIn ?? '', placeholder: L('Sem preço') });
  const priceOut = h('input', { type: 'number', min: 0, step: 'any', value: m?.priceOut ?? '', placeholder: L('Sem preço') });
  // Nomes deste provedor (o mesmo alias em outro provedor é permitido: vira reserva).
  const taken = new Set(p.models.filter((x) => x.id !== m?.id).map((x) => x.alias));
  // Ao adicionar, o alias acompanha o identificador real até a pessoa mexer nele.
  let follow = !m && !presetAlias && /^(claude-?)?$/.test(alias.value);
  alias.addEventListener('input', (e) => { if (e.isTrusted) follow = false; });
  upstream.addEventListener('input', () => {
    if (!follow || !upstream.value.trim()) return;
    alias.value = bestAlias(upstream.value, new Set(taken));
    alias.dispatchEvent(new Event('input'));
  });
  const f = field(L('Alias'), alias, null, 'full');
  f.append(aliasAssist(alias, { upstream, taken, original: m?.alias, onPick: () => { follow = false; } }));
  dlg = dialog({
    title: m ? L('Editar {0}', m.alias) : L('Adicionar modelo em {0}', p.name),
    body: h('div', { class: 'form-grid' }, f,
      field(L('Identificador real no provedor'), upstream, null, 'full'),
      field(L('Nome de exibição'), display), field(L('Limite de saída (tokens)'), maxOut, L('Reduz o max_tokens do Claude Code quando preciso.')),
      field(L('Contexto (tokens)'), context, L('Com 1 milhão ou mais, o Claude Code passa a usar a janela de 1M (no app Claude e no terminal). Abaixo disso, ele usa 200 mil.'), 'full'),
      field(L('Imagens'), images, m?.learnedMaxImages !== null && m?.learnedMaxImages !== undefined ? (m.learnedMaxImages === 0 ? L('Detectado pelo erro do provedor: não aceita imagens. Salvar substitui a detecção.') : L('Detectado pelo erro do provedor: no máximo {0}. Salvar substitui a detecção.', m.learnedMaxImages)) : L('Imagens acima do limite viram um aviso em texto; as mais recentes ficam.'), 'full'),
      p.type === 'openai' && field(L('Esforço de raciocínio'), effort), p.type === 'openai' && field(L('Parâmetro de tokens'), param),
      field(L('Preço de entrada (US$ por 1M de tokens)'), priceIn), field(L('Preço de saída (US$ por 1M de tokens)'), priceOut),
      h('div', { class: 'hint full' }, L('Está na página de preços do provedor. Vazio, o gasto deste modelo não é contado; modelos locais custam 0.')),
      h('label', { class: 'check full' }, makeDefault, L('Usar como modelo padrão'))),
    submit: async () => {
      const saved = await api('POST', `/api/providers/${p.id}/models`, { id: m?.id, alias: alias.value, upstream: upstream.value, displayName: display.value, maxOutputTokens: maxOut.value ? Number(maxOut.value) : null, maxImages: images.value === '' ? null : Number(images.value), imagesTouched: true, priceIn: priceIn.value === '' ? null : Number(priceIn.value), priceOut: priceOut.value === '' ? null : Number(priceOut.value), reasoningEffort: effort.value || null, tokenParam: param.value, contextWindow: context.value === '' ? null : Number(context.value) });
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

/**
 * Login com a conta Google. O servidor cria o login (state + PKCE) e devolve o link do Google; o painel
 * abre esse link fora dele: no app instalado, no navegador do sistema (o Google recusa login em janela
 * embutida); no navegador, num popup. O Google volta para o callback do Rotaz, e o painel acompanha o
 * resultado pelo state, sem depender de popup, cookie ou postMessage.
 */
/**
 * Provedores com conta (GitHub Copilot, xAI, Kimi, Cline...): o mesmo fluxo, com duas formas de entrar.
 * Navegador: igual ao Google. Código de dispositivo: o painel mostra o código, abre a página do provedor e
 * o servidor espera a autorização; nos dois casos o painel acompanha pelo state.
 */
async function connectAccount(p, { onDone } = {}) {
  const isGoogle = p.type === 'antigravity';
  const base = isGoogle ? 'antigravity' : 'account';
  let begin;
  try { begin = await api('POST', `/api/oauth/${base}/begin?provider=${encodeURIComponent(p.id)}`, {}); } catch (e) { fail(e); return; }
  const device = begin.kind === 'device';
  const open = () => window.open(begin.url, desk || device ? '_blank' : 'rotaz-oauth', desk || device ? undefined : 'popup,width=560,height=720');
  open();
  const line = h('p', { class: 'small muted', role: 'status' }, isGoogle ? L('Aguardando o login no Google…') : L('Aguardando a autorização em {0}…', p.name));
  const reopen = button(device ? L('Abrir a página de novo') : L('Abrir o login de novo'), () => open(), 'ghost sm', { icon: 'arrow-square-out' });
  let timer = null;
  const dlg = dialog({
    title: isGoogle ? L('Entre com sua conta Google') : L('Entre com sua conta {0}', p.name),
    sub: device ? L('Na página que abriu, digite este código e autorize. Esta tela atualiza sozinha.')
      : desk ? L('O login abriu no seu navegador. Conclua lá; esta tela atualiza sozinha.') : L('O login abriu numa janela nova. Conclua lá; esta tela atualiza sozinha.'),
    body: h('div', { class: 'stack tight' }, device && begin.userCode && copyLine(L('Código'), begin.userCode), line, h('div', { class: 'row' }, reopen)),
    submitLabel: L('Fechar'), info: true, submit: async () => {},
  });
  const stop = () => { clearTimeout(timer); timer = null; };
  dlg.addEventListener('close', stop);
  const started = Date.now();
  const check = async () => {
    timer = null;
    let s;
    try { s = await api('GET', `/api/oauth/${base}/status?provider=${encodeURIComponent(p.id)}&state=${encodeURIComponent(begin.state)}`); }
    catch (e) { if (e.status === 401) return; s = { status: 'pending' }; }
    if (!dlg.open) return;
    if (s.status === 'ok') {
      dlg.querySelector('form').requestSubmit();
      toast(L('Conta {0} conectada', s.email || (isGoogle ? 'Google' : p.name)));
      if (onDone) onDone(); else route();
      return;
    }
    if (s.status === 'error' || s.status === 'expired') {
      line.textContent = s.message || L('Login não concluído.');
      line.className = 'form-error';
      reopen.remove();
      return;
    }
    // O Google dá 10 minutos para concluir; depois disso o login expira no servidor.
    if (Date.now() - started > 600000) { line.textContent = L('Login inválido ou expirado. Volte ao painel e conecte a conta de novo.'); reopen.remove(); return; }
    timer = setTimeout(check, 1500);
  };
  timer = setTimeout(check, 1500);
}

function testResult(r) {
  if (!r) return null;
  if (r.running) return h('div', { class: 'result', role: 'status' }, h('div', { class: 'r-head' }, icon('circle-notch', 'spinner'), h('span', { class: 'grow' }, L('Testando {0} com uma requisição real…', r.what)), r.stop && button(L('Interromper'), r.stop, 'ghost sm')));
  const ok = r.status === 'functional';
  return h('div', { class: 'result', role: 'status' },
    h('div', { class: 'r-head' }, badge(r.label, ok ? (r.toolsOk === false ? 'warn' : 'pos') : 'neg'),
      r.alias && h('span', { class: 'small muted mono' }, `${r.alias} → ${r.upstream}${r.keyLabel ? ` · ${r.keyLabel}` : ''}`),
      r.latencyMs && h('span', { class: 'small muted' }, ms(r.latencyMs))),
    h('p', { class: 'small' }, r.message),
    r.steps.length > 0 && h('div', { class: 'steps' }, r.steps.map((s) => h('div', { class: `step ${s.ok ? 'ok' : 'bad'}` }, icon(s.ok ? 'check' : 'x'), h('span', {}, s.name), h('span', { class: 'd', 'data-tip': s.detail }, s.detail)))));
}

async function runTest(p, opts, what) {
  const ctrl = new AbortController();
  const t = state.tests[p.id] = { running: true, what, stop: () => ctrl.abort() };
  redrawDetail();
  try { state.tests[p.id] = await api('POST', `/api/providers/${p.id}/test`, opts, { signal: ctrl.signal }); } catch (e) {
    if (state.tests[p.id] === t) state.tests[p.id] = null;
    if (!ctrl.signal.aborted) fail(e); else toast(L('Teste interrompido.'));
  }
  redrawDetail();
}

let redrawDetail = () => {};

function providerDetail(p, routing) {
  const test = state.tests[p.id];
  const isGoogle = p.type === 'antigravity';
  const isOauth = isGoogle || p.type === 'oauth';
  // O Google travou alguma conta até ela ser verificada no app oficial: o teste do provedor ou de um modelo disse isso.
  const verify = isGoogle && [test, ...p.models.map(latestTest)].some((t) => t?.status === 'verify_account');
  const facts = [
    badge(isGoogle ? L('Google Antigravity (OAuth)') : p.type === 'oauth' ? L('Conta (OAuth)') : p.type === 'openai' ? L('Compatível com OpenAI') : 'Anthropic Messages'),
    isOauth ? badge(isGoogle ? L('Conta Google') : L('Login no navegador ou por código')) : badge(L(AUTH_LABEL[p.authScheme])), badge(L('Prioridade {0}', p.priority)),
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
    verify && notice(L('Uma conta Google deste provedor foi travada pelo Google até ser verificada. Para liberar: abra o Antigravity oficial com o mesmo e-mail, faça o que ele pedir (confirmar a conta, aceitar os termos ou validar o telefone) e depois teste de novo aqui. Enquanto isso, desative a conta travada para os pedidos irem direto para as outras. O Google costuma pedir isso quando estranha o uso da conta fora do app dele, e pode voltar a pedir.'), 'warn', L('O Google pediu para verificar a conta')),
    panel([isGoogle ? L('Contas Google') : isOauth ? L('Contas') : L('Chaves de API'),
      isOauth ? L('Login OAuth no navegador; o refresh token fica cifrado e só vira access token na hora do uso')
        : p.authScheme === 'none' ? null : L('Revezam entre si; uma chave com falha fica em pausa')],
      isOauth ? button(isGoogle ? L('Conectar conta Google') : L('Conectar conta'), () => connectAccount(p), 'sm', { icon: 'plus' })
        : p.authScheme !== 'none' ? button(L('Adicionar chave'), () => keyDialog(p), 'sm', { icon: 'plus' }) : null,
      p.authScheme === 'none' && !isOauth ? h('div', { class: 'empty-state' }, L('Este provedor não usa autenticação.'))
        : p.keys.length ? tableEl([L('Identificação'), isOauth ? L('Conta') : L('Final'), L('Ativa'), { t: '', cls: 'actions' }], p.keys.map((k) => h('tr', {},
          h('td', {}, k.label), h('td', { class: 'mono muted' }, k.hint),
          h('td', {}, toggle(k.enabled, async (v) => { await api('PUT', `/api/providers/${p.id}/keys/${k.id}`, { enabled: v }).catch(fail); route(); }, L('Ativar {0}', k.label))),
          h('td', { class: 'actions' }, moreButton([
            { label: isOauth ? L('Testar esta conta') : L('Testar esta chave'), icon: 'flask', onClick: () => runTest(p, { keyId: k.id }, k.label) },
            'sep',
            { label: isOauth ? L('Desconectar conta') : L('Remover chave'), icon: 'trash', danger: true, onClick: () => confirmDo(isOauth ? L('Desconectar {0}', k.label) : L('Remover {0}', k.label), isOauth ? (isGoogle ? L('A conta Google será removida e o refresh token cifrado, apagado.') : L('A conta será removida e os tokens cifrados, apagados.')) : L('A chave cifrada será apagada.'), L('Remover'), async () => { await api('DELETE', `/api/providers/${p.id}/keys/${k.id}`); route(); }) },
          ])))))
          : h('div', { class: 'empty-state' }, isOauth ? L('Nenhuma conta conectada. Sem conta este provedor fica fora das rotas.') : L('Nenhuma chave. Sem chave este provedor fica fora das rotas.'),
            isOauth ? button(isGoogle ? L('Conectar conta Google') : L('Conectar conta'), () => connectAccount(p), 'primary', { icon: 'plus' }) : button(L('Adicionar chave'), () => keyDialog(p), 'primary', { icon: 'plus' }))),
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

// Células da coluna "Último teste" e o texto do progresso, para o teste em massa atualizar só o que mudou.
const live = { cells: new Map(), label: null };
const progressText = (run) => L('Testando {0} de {1}: {2} respondendo, {3} com falha', run.done, run.total, run.ok, run.fail);

/**
 * Testes de modelos em fila, um conjunto por provedor. Pode chamar de novo durante um teste: os modelos novos
 * entram na mesma fila. Interromper cancela a fila e também o que já está no servidor.
 */
function bulkTest(p, ids, full) {
  ids = ids.filter((id) => !state.live[id]?.running);
  if (!ids.length) return;
  const run = state.runs.get(p.id) ?? newRun(p);
  run.queue.push(...ids.map((id) => ({ id, full })));
  run.total += ids.length;
  run.full ||= full;
  for (const id of ids) { run.ids.add(id); state.live[id] = { running: true }; }
  redrawDetail();
  run.pump();
}

function newRun(p) {
  const ctrl = new AbortController();
  const run = { pid: p.id, name: p.name, total: 0, done: 0, ok: 0, fail: 0, active: 0, full: false, cancel: false, ended: false, queue: [], ids: new Set(), dirty: new Set(), frame: 0 };
  state.runs.set(p.id, run);
  // Redesenhar a tela inteira a cada resultado travava listas grandes: muda só a célula do modelo e a contagem,
  // agrupadas num quadro de animação.
  const flush = () => {
    run.frame = 0;
    for (const id of run.dirty) { const c = live.cells.get(id); c?.cell.replaceChildren(testBadge(latestTest(c.m))); }
    run.dirty.clear();
    if (live.label && state.runs.get(state.provider) === run) live.label.textContent = progressText(run);
  };
  const mark = (id) => { run.dirty.add(id); run.frame ||= requestAnimationFrame(flush); };
  const finish = () => {
    if (run.ended || (run.active && !run.cancel) || (run.queue.length && !run.cancel)) return;
    run.ended = true;
    cancelAnimationFrame(run.frame);
    for (const id of run.ids) if (state.live[id]?.running) delete state.live[id];
    state.runs.delete(p.id);
    toast(run.cancel ? L('{0} testado(s): {1} respondendo, {2} com falha. Teste interrompido.', run.done, run.ok, run.fail) : L('{0} testado(s): {1} respondendo, {2} com falha.', run.done, run.ok, run.fail), run.fail ? 'error' : 'info');
    if (state.view === 'providers') redrawDetail();
  };
  const one = async ({ id, full }) => {
    try {
      const r = await api('POST', `/api/providers/${p.id}/test`, { modelId: id, quick: !full }, { signal: ctrl.signal });
      if (run.cancel) return;
      state.live[id] = r;
      if (r.status === 'functional') run.ok++; else run.fail++;
    } catch (e) {
      if (run.cancel) return;
      state.live[id] = { status: 'error', label: L('Erro'), message: e.message, at: Date.now() };
      run.fail++;
    }
    run.done++;
    mark(id);
  };
  // Rápido: quatro por vez; com teste completo na fila, dois (cada um faz três chamadas). O servidor ainda respeita
  // o limite por minuto de cada provedor, e cada teste tem prazo total, então nenhum fica preso.
  run.pump = () => {
    while (!run.cancel && run.queue.length && run.active < (run.full ? 2 : 4)) {
      run.active++;
      one(run.queue.shift()).finally(() => { run.active--; run.pump(); finish(); });
    }
  };
  // Interromper responde na hora: a fila some, as chamadas em andamento são canceladas no navegador e no servidor.
  run.stop = () => {
    if (run.cancel) return;
    run.cancel = true;
    run.queue = [];
    ctrl.abort();
    finish();
  };
  return run;
}

/** Renomeia os aliases "Só CLI" escolhidos para nomes que aparecem também no Claude Desktop. */
function fixForDesktop(p, ids, routing) {
  const names = new Set(p.models.map((x) => x.alias));
  const plan = [];
  for (const m of p.models.filter((x) => ids.includes(x.id) && !analyzeAlias(x.alias).desktop)) {
    names.delete(m.alias);
    const to = aliasSuggestions(m.alias, { upstream: m.upstream, taken: names, max: 1 })[0]?.alias;
    names.add(to ?? m.alias);
    if (to) plan.push({ m, to });
  }
  if (!plan.length) return;
  const pinned = plan.some(({ m }) => m.alias === routing.defaultAlias || Object.values(routing.tiers ?? {}).includes(m.alias));
  dialog({
    title: L('Ajustar {0} alias(es) para o Desktop', plan.length), submitLabel: L('Renomear'),
    sub: L('Os nomes novos aparecem no Claude Code do terminal e no seletor do Claude Desktop.'),
    body: h('div', { class: 'stack tight' },
      h('div', { class: 'rename-list' }, plan.map(({ m, to }) => h('div', { class: 'rename-row' }, h('span', { class: 'mono ellipsis muted', 'data-tip': m.alias }, m.alias), icon('arrow-right'), h('span', { class: 'mono ellipsis', 'data-tip': to }, to)))),
      pinned && notice(L('O roteamento acompanha os nomes novos. Se você fixou algum nome antigo no Claude Code, troque lá também.'), 'accent')),
    submit: async () => {
      for (const { m, to } of plan) await api('POST', `/api/providers/${p.id}/models`, { ...m, alias: to });
      toast(L('{0} alias(es) renomeado(s)', plan.length));
      selOf(p.id).clear();
      route();
    },
  });
}

async function bulkUpdate(p, ids, set, on) {
  try { await api('POST', `/api/providers/${p.id}/models/bulk-update`, { ids, set }); toast(on ? L('{0} modelo(s) ativado(s)', ids.length) : L('{0} modelo(s) desativado(s)', ids.length)); } catch (e) { fail(e); }
  route();
}

function bulkEditDialog(p, ids) {
  const maxOut = h('input', { type: 'number', min: 1, placeholder: L('Manter como está') });
  const noLimit = h('input', { type: 'checkbox' });
  const effort = h('select', {}, h('option', { value: 'keep' }, L('Manter como está')), h('option', { value: '' }, L('Não enviar')), effortOptions());
  const param = h('select', {}, h('option', { value: 'keep' }, L('Manter como está')), ['auto', 'max_tokens', 'max_completion_tokens'].map((v) => h('option', { value: v }, v)));
  const images = imageSelect(true);
  const priceIn = h('input', { type: 'number', min: 0, step: 'any', placeholder: L('Manter como está') });
  const priceOut = h('input', { type: 'number', min: 0, step: 'any', placeholder: L('Manter como está') });
  const context = h('input', { type: 'number', min: 1000, max: 10000000, step: 1000, placeholder: L('Manter como está') });
  dialog({
    title: L('Editar {0} modelo(s)', ids.length), sub: L('Só os campos alterados são aplicados. Alias e identificador real continuam individuais.'),
    submitLabel: L('Aplicar'),
    body: h('div', { class: 'form-grid' },
      field(L('Limite de saída (tokens)'), maxOut), h('label', { class: 'check' }, noLimit, L('Remover o limite')),
      field(L('Imagens'), images, null, 'full'),
      p.type === 'openai' && field(L('Esforço de raciocínio'), effort), p.type === 'openai' && field(L('Parâmetro de tokens'), param),
      field(L('Preço de entrada (US$ por 1M de tokens)'), priceIn), field(L('Preço de saída (US$ por 1M de tokens)'), priceOut),
      field(L('Contexto (tokens)'), context, L('Com 1 milhão ou mais, o Claude Code passa a usar a janela de 1M (no app Claude e no terminal). Abaixo disso, ele usa 200 mil.'), 'full')),
    submit: async () => {
      const set = {};
      if (context.value !== '') set.contextWindow = Number(context.value);
      if (noLimit.checked) set.maxOutputTokens = null; else if (maxOut.value) set.maxOutputTokens = Number(maxOut.value);
      if (p.type === 'openai' && effort.value !== 'keep') set.reasoningEffort = effort.value || null;
      if (p.type === 'openai' && param.value !== 'keep') set.tokenParam = param.value;
      if (images.value !== 'keep') set.maxImages = images.value === '' ? null : Number(images.value);
      if (priceIn.value !== '') set.priceIn = Number(priceIn.value);
      if (priceOut.value !== '') set.priceOut = Number(priceOut.value);
      if (!Object.keys(set).length) throw new Error(L('Altere ao menos um campo.'));
      await api('POST', `/api/providers/${p.id}/models/bulk-update`, { ids, set });
      toast(L('{0} modelo(s) atualizado(s)', ids.length));
      route();
    },
  });
}

/**
 * Importar modelos: a lista do provedor (em cache no servidor por 1 h), com busca, teste antes de escolher e seleção
 * em massa. "Testar visíveis" faz uma chamada curta por modelo, sem cadastrar nada; depois, "Marcar os que respondem"
 * seleciona de uma vez só os que funcionaram. Opções menos usadas (nomes, limite, esforço) ficam dobradas embaixo.
 */
async function importDialog(p, refresh = false) {
  let data;
  try { data = await api('POST', `/api/providers/${p.id}/discover`, { refresh }); } catch (e) { fail(e); return; }
  const existing = new Map(p.models.map((m) => [m.upstream, m.alias]));
  const taken = new Set(state.aliases);
  // 'both': nomes que aparecem no CLI e no Desktop (padrão). 'plain': o nome do provedor, só com o prefixo.
  let naming = 'both';
  const plainAlias = (id, used) => {
    let a = `claude-${id.toLowerCase().replace(/^models\//, '').replace(/[^a-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-._]+|[-._]+$/g, '')}`.slice(0, 64).replace(/[-._]+$/, '');
    for (let n = 2; used.has(a); n++) a = `${a.slice(0, 60)}-${n}`;
    used.add(a);
    return a;
  };
  const nameFor = (id, used) => (naming === 'both' ? bestAlias(id, used) : plainAlias(id, used));
  const rows = [];
  let dlg;
  let show = 'all'; // filtro pelo resultado do teste
  const go = () => dlg?.querySelector('button[type=submit]');
  const isOk = (r) => r.test?.status === 'functional';
  const isFail = (r) => r.test && !r.test.running && r.test.status !== 'functional';

  const tbody = h('tbody');
  for (const id of data.models) {
    const already = existing.get(id);
    const cb = h('input', { type: 'checkbox', disabled: !!already, 'aria-label': L('Selecionar {0}', id) });
    const alias = h('input', { type: 'text', class: 'compact', value: already ?? nameFor(id, taken), disabled: !!already, spellcheck: 'false', 'aria-label': L('Alias de {0}', id) });
    const reach = h('div', { class: 'imp-reach' });
    const testCell = h('td', { class: 'imp-test' });
    const row = { id, cb, alias, already, edited: false, test: null };
    row.paint = () => reach.replaceChildren(...(already ? [badge(L('Já adicionado'))] : analyzeAlias(alias.value).desktop ? []
      : [reachBadge(alias.value, aliasSuggestions(alias.value, { upstream: id, taken, max: 1 })[0]?.alias, { strong: true })]));
    row.paintTest = () => testCell.replaceChildren(already && !row.test ? h('span', { class: 'small muted' }, '—') : testBadge(row.test));
    alias.addEventListener('input', (e) => { if (e.isTrusted) row.edited = true; row.paint(); if (!cb.checked && !already) { cb.checked = true; update(); } });
    cb.addEventListener('change', update);
    row.paint();
    row.paintTest();
    const pr = data.prices?.[id];
    // Antigravity: o Google informa nome, contexto e quais modelos são internos (autocompletar do editor).
    const inf = data.info?.[id];
    const meta = [inf?.name, inf?.context && L('contexto de {0} tokens', compact(inf.context)), pr && L('{0} · {1} por 1M de tokens', money(pr.in ?? 0), money(pr.out ?? 0))].filter(Boolean).join(' · ');
    const idCell = h('td', { class: 'imp-model', 'data-tip': id },
      h('div', { class: 'imp-id' }, h('span', { class: 'mono ellipsis' }, id),
        inf?.internal && badge(L('Interno'), '', L('Modelo de uso interno do Google (autocompletar do editor). Não serve para conversa.'))),
      meta && h('div', { class: 'imp-meta ellipsis' }, meta));
    const tr = h('tr', { class: already ? 'is-added' : undefined, 'data-q': `${id} ${alias.value} ${inf?.name ?? ''}`.toLowerCase() },
      h('td', { class: 'chk' }, cb), idCell, h('td', { class: 'imp-alias' }, alias, reach), testCell);
    tr.addEventListener('click', (e) => { if (already || e.target.closest('input, button, a')) return; cb.checked = !cb.checked; update(); });
    row.tr = tr;
    rows.push(row);
    tbody.append(tr);
  }

  const input = h('input', { type: 'search', placeholder: L('Filtrar por nome, ex.: llama 70b instruct'), 'aria-label': L('Filtrar modelos do provedor') });
  const visible = () => rows.filter((r) => !r.tr.hidden);
  function applyFilter() {
    const terms = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    for (const r of rows) {
      const byText = terms.every((t) => r.tr.dataset.q.includes(t));
      const byTest = show === 'all' || (show === 'ok' && isOk(r)) || (show === 'fail' && isFail(r)) || (show === 'none' && !r.test);
      r.tr.hidden = !(byText && byTest);
    }
    update();
  }
  input.addEventListener('input', applyFilter);

  // ---- teste antes de importar: uma chamada curta por modelo, quatro de cada vez ----
  const ctrl = { abort: null, running: false, done: 0, total: 0 };
  const progress = h('span', { class: 'imp-progress', role: 'status' });
  const testBtn = button('', () => (ctrl.running ? stopTests() : runTests()), '', { icon: 'flask' });
  const okBtn = button('', () => { for (const r of rows) if (!r.already && isOk(r)) r.cb.checked = true; if (show !== 'ok') { show = 'ok'; filterSeg.querySelector('[data-v="ok"]')?.click(); } update(); }, 'imp-okbtn', { icon: 'check-circle' });
  async function runTests() {
    const queue = visible().filter((r) => !r.already && !isOk(r));
    if (!queue.length) return;
    const ac = new AbortController();
    Object.assign(ctrl, { abort: ac, running: true, done: 0, total: queue.length });
    for (const r of queue) { r.test = { running: true }; r.paintTest(); }
    update();
    const worker = async () => {
      while (queue.length && !ac.signal.aborted) {
        const r = queue.shift();
        try { r.test = await api('POST', `/api/providers/${p.id}/test`, { upstream: r.id, quick: true }, { signal: ac.signal }); }
        catch (e) { r.test = ac.signal.aborted ? null : { status: 'error', label: LK('Falha'), message: e.message }; }
        ctrl.done++;
        r.paintTest();
        update();
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
    for (const r of rows) if (r.test?.running) { r.test = null; r.paintTest(); }
    ctrl.running = false;
    update();
    const ok = rows.filter(isOk).length;
    if (!ac.signal.aborted) toast(L('{0} testado(s): {1} respondendo, {2} com falha.', ctrl.done, ok, rows.filter(isFail).length), ok ? 'info' : 'error');
  }
  const stopTests = () => ctrl.abort?.abort();

  const counts = () => ({ all: rows.length, ok: rows.filter(isOk).length, fail: rows.filter(isFail).length, none: rows.filter((r) => !r.test).length });
  const filterSeg = segmented([{ value: 'all', label: L('Todos') }, { value: 'ok', label: L('Respondendo') }, { value: 'fail', label: L('Com falha') }, { value: 'none', label: L('Não testados') }],
    show, (v) => { show = v; applyFilter(); }, { label: L('Mostrar') });
  const counter = h('span', { class: 'imp-count' });

  function update() {
    const n = rows.filter((r) => r.cb.checked).length;
    const vis = visible();
    const c = counts();
    const labels = { all: L('Todos'), ok: L('Respondendo'), fail: L('Com falha'), none: L('Não testados') };
    for (const b of filterSeg.children) b.textContent = `${labels[b.dataset.v]} ${c[b.dataset.v]}`;
    filterSeg.hidden = !c.ok && !c.fail; // os filtros só aparecem depois de algum teste
    counter.textContent = L('{0} visíveis · {1} selecionado(s)', vis.length, n);
    const toTest = vis.filter((r) => !r.already && !isOk(r)).length;
    const neverTested = vis.filter((r) => !r.already && !r.test).length;
    testBtn.replaceChildren(...(ctrl.running ? [icon('circle-notch', 'spinner'), L('Parar teste')]
      : [icon(neverTested ? 'flask' : 'arrows-clockwise'), neverTested ? L('Testar {0} visíveis', toTest) : toTest ? L('Testar de novo os {0} com falha', toTest) : L('Testar visíveis')]));
    testBtn.disabled = !ctrl.running && !toTest;
    progress.textContent = ctrl.running ? L('Testando {0} de {1}', ctrl.done, ctrl.total) : '';
    const okFree = rows.filter((r) => !r.already && isOk(r) && !r.cb.checked).length;
    okBtn.hidden = !okFree;
    okBtn.replaceChildren(icon('check-circle'), L('Marcar os {0} que respondem', okFree));
    if (go()) { go().textContent = n ? L('Adicionar {0}', n) : L('Adicionar'); go().disabled = !n; }
  }

  const pick = (v) => { for (const r of visible()) if (!r.already) r.cb.checked = v; update(); };
  const maxOut = h('input', { type: 'number', min: 1, placeholder: L('Sem limite') });
  const effort = h('select', {}, h('option', { value: '' }, L('Não enviar')), effortOptions());
  const testAfter = h('input', { type: 'checkbox', checked: true });
  // Trocar o estilo refaz os nomes que a pessoa não editou à mão.
  const namingCtl = segmented([{ value: 'both', label: L('Funcionam no CLI e no Desktop') }, { value: 'plain', label: L('Iguais ao provedor') }], naming, (v) => {
    naming = v;
    const used = new Set([...state.aliases, ...rows.filter((r) => r.already || r.edited).map((r) => r.alias.value)]);
    for (const r of rows) if (!r.already && !r.edited) { r.alias.value = nameFor(r.id, used); r.tr.dataset.q = `${r.id} ${r.alias.value} ${data.info?.[r.id]?.name ?? ''}`.toLowerCase(); r.paint(); }
  }, { label: L('Nomes dos aliases') });
  const refreshBtn = h('button', { type: 'button', class: 'btn icon-only', 'aria-label': L('Atualizar lista'), 'data-tip': L('Buscar a lista de novo no provedor'),
    onclick: () => { stopTests(); dlg.close(); dlg.remove(); importDialog(p, true); } }, icon('arrows-clockwise'));
  const selectAll = h('input', { type: 'checkbox', 'aria-label': L('Marcar ou desmarcar os visíveis') });
  selectAll.addEventListener('change', () => pick(selectAll.checked));

  dlg = dialog({
    title: L('Importar modelos de {0}', p.name),
    sub: `${L('{0} modelos no provedor', data.models.length)} · ${data.cached ? L('lista guardada {0}', ago(data.at)) : L('lista recém-buscada')}`,
    wide: true, submitLabel: L('Adicionar'),
    body: h('div', { class: 'imp' },
      h('div', { class: 'imp-top' }, h('div', { class: 'search grow' }, icon('magnifying-glass'), input), refreshBtn),
      h('div', { class: 'imp-bar' },
        h('div', { class: 'imp-bar-test' }, testBtn, okBtn, progress),
        filterSeg),
      h('p', { class: 'imp-hint' }, L('O teste faz uma chamada curta por modelo, sem adicionar nada. Em provedores pagos, gasta um pouco de crédito.')),
      h('div', { class: 'import-list' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', { class: 'chk' }, selectAll), h('th', {}, L('Modelo')), h('th', {}, L('Alias')), h('th', {}, L('Teste')))),
        tbody)),
      h('div', { class: 'imp-sel' }, counter, h('span', { class: 'grow' }), button(L('Marcar visíveis'), () => pick(true), 'ghost sm'), button(L('Desmarcar'), () => pick(false), 'ghost sm')),
      h('details', { class: 'advanced imp-more' }, h('summary', {}, icon('caret-right'), L('Mais opções')),
        h('div', { class: 'imp-opts' },
          h('div', { class: 'field full' }, h('div', { class: 'lbl' }, L('Nomes dos aliases')), namingCtl,
            h('div', { class: 'hint' }, L('O seletor do Claude Desktop esconde nomes que citam outros fornecedores; no CLI, qualquer nome com "claude-" funciona.'))),
          field(L('Limite de saída para todos (tokens)'), maxOut, L('Opcional. Dá para ajustar depois, em massa.')),
          p.type === 'openai' && field(L('Esforço de raciocínio para todos'), effort),
          h('label', { class: 'check full' }, testAfter, L('Testar em seguida os que ainda não foram testados'))))),
    submit: async () => {
      stopTests();
      const chosen = rows.filter((r) => r.cb.checked);
      if (!chosen.length) throw new Error(L('Selecione ao menos um modelo.'));
      const { models } = await api('POST', `/api/providers/${p.id}/models/bulk`, {
        models: chosen.map((r) => ({ alias: r.alias.value.trim().toLowerCase(), upstream: r.id, maxOutputTokens: maxOut.value ? Number(maxOut.value) : data.info?.[r.id]?.maxOutput ?? null, reasoningEffort: effort.value || null,
          displayName: data.info?.[r.id]?.name ?? undefined, contextWindow: data.info?.[r.id]?.context ?? null,
          priceIn: data.prices?.[r.id]?.in ?? null, priceOut: data.prices?.[r.id]?.out ?? null })),
      });
      // quem já foi testado aqui leva o resultado junto; o teste em seguida fica só para os outros
      const tested = new Map(chosen.filter((r) => r.test && !r.test.running).map((r) => [r.id, r.test]));
      for (const m of models) if (tested.has(m.upstream)) state.live[m.id] = { ...tested.get(m.upstream), modelId: m.id };
      toast(L('{0} modelo(s) adicionado(s)', models.length));
      await route();
      const untested = models.filter((m) => !tested.has(m.upstream)).map((m) => m.id);
      if (testAfter.checked && untested.length) bulkTest(p, untested, false);
    },
  });
  dlg.addEventListener('close', stopTests);
  update();
  input.focus();
}

// ---------- cota da conta Google (Antigravity) ----------
function resetText(t) {
  const d = new Date(t);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString(currentLang(), { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString(currentLang(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
/** Selo da cota de um modelo: verde com folga, âmbar abaixo de 30%, rosa abaixo de 10% (como os limites de gasto). */
function quotaBadge(q) {
  if (q === undefined) return h('span', { class: 'small muted' }, '…');
  if (q === null || typeof q.remaining !== 'number') return h('span', { class: 'small muted', 'data-tip': L('O Google não informa cota para este modelo.') }, '—');
  const pct = Math.floor(q.remaining * 100);
  const kind = pct >= 30 ? 'pos' : pct >= 10 ? 'warn' : 'neg';
  const tip = q.resetAt ? L('Cota restante desta conta Google. Renova às {0}.', resetText(q.resetAt)) : L('Cota restante desta conta Google.');
  return badge(`${pct}%`, kind, tip);
}
/** Busca a cota (o servidor guarda por 1 minuto) e preenche as células sem redesenhar a tabela. */
async function loadQuota(p, cells) {
  const cur = state.quota[p.id];
  let entry = cur && Date.now() - cur.at < 60000 ? cur : null;
  if (!entry) {
    try { entry = await api('GET', `/api/providers/${p.id}/quota`); } catch (e) { entry = { at: Date.now(), models: {}, error: e.message }; }
    state.quota[p.id] = entry;
  }
  for (const [id, cell] of cells) cell.replaceChildren(entry.error ? h('span', { class: 'small muted', 'data-tip': entry.error }, '—') : quotaBadge(entry.models?.[id] ?? null));
  // Na primeira leitura o servidor grava o contexto que o Google informou: recarrega uma vez para mostrar o selo 1M.
  const filled = p.models.some((m) => m.contextWindow == null && entry.models?.[m.id]?.context);
  if (filled && !state.quotaReloaded.has(p.id)) { state.quotaReloaded.add(p.id); route(); }
}

function modelsPanel(p, routing) {
  const sel = selOf(p.id);
  for (const id of [...sel]) if (!p.models.some((m) => m.id === id)) sel.delete(id);
  const q = (state.mfilter[p.id] ?? '').toLowerCase();
  const setDefault = async (m) => {
    try { await api('PUT', '/api/routing', { defaultAlias: m.alias }); toast(L('Modelo padrão: {0}', m.alias)); } catch (e) { fail(e); }
    route();
  };
  const names = new Set(p.models.map((x) => x.alias));
  live.cells = new Map();
  live.label = null;
  const isAg = p.type === 'antigravity';
  const quotaCells = new Map();
  const rows = p.models.map((m) => {
    const quotaCell = isAg ? h('td', { class: 'fit' }, quotaBadge(state.quota[p.id]?.models?.[m.id])) : null;
    if (quotaCell) quotaCells.set(m.id, quotaCell);
    // Só CLI: o primeiro nome que funciona nos dois vai no selo e no menu (Renomear para o Desktop).
    const fix = analyzeAlias(m.alias).desktop ? null : aliasSuggestions(m.alias, { upstream: m.upstream, taken: names, max: 1 })[0]?.alias;
    const testCell = h('td', { class: 'fit' }, testBadge(latestTest(m)));
    live.cells.set(m.id, { cell: testCell, m });
    const cb = h('input', { type: 'checkbox', checked: sel.has(m.id), 'aria-label': L('Selecionar {0}', m.alias), onchange: (e) => { if (e.target.checked) sel.add(m.id); else sel.delete(m.id); redrawDetail(); } });
    const text = `${m.alias} ${m.upstream}`.toLowerCase();
    const tr = h('tr', { 'data-q': text, class: q && !text.includes(q) ? 'hidden' : undefined },
      h('td', { class: 'chk' }, cb),
      h('td', {}, h('div', { class: 'row' }, h('span', { class: 'ellipsis', 'data-tip': m.alias }, m.alias), routing.defaultAlias === m.alias && badge(L('Padrão'), 'accent'), reachBadge(m.alias, fix), imagesBadge(m),
        m.contextWindow >= 1000000 && badge('1M', '', L('Contexto de 1 milhão de tokens: o Claude Code recebe este modelo como {0}[1m] e usa a janela toda.', m.alias)),
        (m.priceIn !== null && m.priceIn !== undefined) || (m.priceOut !== null && m.priceOut !== undefined) ? badge(priceText(m), '', L('Entrada · saída, em dólar por 1M de tokens')) : null)),
      h('td', { class: 'mono ellipsis muted', 'data-tip': m.upstream }, m.upstream), quotaCell, testCell,
      h('td', {}, toggle(m.enabled, async (v) => { await api('POST', `/api/providers/${p.id}/models`, { ...m, enabled: v }).catch(fail); route(); }, L('Ativar {0}', m.alias))),
      h('td', { class: 'actions' }, moreButton(() => [
        { label: L('Teste rápido'), icon: 'lightning', disabled: !!state.live[m.id]?.running, onClick: () => bulkTest(p, [m.id], false) },
        { label: L('Teste completo'), icon: 'flask', disabled: !!state.live[m.id]?.running, onClick: () => bulkTest(p, [m.id], true) },
        { label: L('Editar'), icon: 'pencil-simple', onClick: () => modelDialog(p, m, routing.defaultAlias === m.alias) },
        fix && { label: L('Renomear para o Desktop'), icon: 'monitor', onClick: () => modelDialog(p, m, routing.defaultAlias === m.alias, { alias: fix }) },
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
  const run = state.runs.get(p.id) ?? null;
  const one = sel.size === 1 ? p.models.find((x) => sel.has(x.id)) : null;
  if (run) live.label = h('span', {}, progressText(run));
  const cliOnly = [...sel].filter((id) => { const m = p.models.find((x) => x.id === id); return m && !analyzeAlias(m.alias).desktop; });
  // Testes de outros provedores continuam e podem ser interrompidos daqui.
  const others = [...state.runs.values()].filter((r) => r !== run);
  const progress = (run || others.length > 0) && h('div', { class: 'bulkbar', role: 'status' }, icon('circle-notch', 'spinner'),
    run ? live.label : h('span', {}, L('Testando em {0}', others.map((r) => r.name).join(', '))), h('span', { class: 'grow' }),
    button(L('Interromper'), () => { run?.stop(); if (!run) for (const r of others) r.stop(); }, 'ghost sm'));
  const bar = sel.size > 0 && h('div', { class: 'bulkbar' }, h('span', {}, L('{0} selecionado(s)', sel.size)), h('span', { class: 'grow' }),
      one && routing.defaultAlias !== one.alias && button(L('Usar como padrão'), () => setDefault(one), 'ghost sm'),
      button(L('Teste rápido'), () => bulkTest(p, ids(), false), 'ghost sm', { 'data-tip': L('Uma chamada de texto por modelo') }),
      button(L('Teste completo'), () => bulkTest(p, ids(), true), 'ghost sm', { 'data-tip': L('Texto, depois streaming e ferramentas juntos: três chamadas por modelo') }),
      cliOnly.length > 0 && button(L('Ajustar para o Desktop'), () => fixForDesktop(p, cliOnly, routing), 'ghost sm', { 'data-tip': L('Renomeia os aliases Só CLI selecionados para nomes que aparecem também no Claude Desktop') }),
      button(L('Ativar'), () => bulkUpdate(p, ids(), { enabled: true }, true), 'ghost sm'),
      button(L('Desativar'), () => bulkUpdate(p, ids(), { enabled: false }, false), 'ghost sm'),
      button(L('Editar'), () => bulkEditDialog(p, ids()), 'ghost sm'),
      button(L('Remover'), () => confirmDo(L('Remover {0} modelo(s)', sel.size), L('Os aliases selecionados deixam de existir neste provedor.'), L('Remover'), async () => { await api('POST', `/api/providers/${p.id}/models/bulk-delete`, { ids: ids() }); sel.clear(); route(); }), 'ghost sm danger'),
      button('', () => { sel.clear(); redrawDetail(); }, 'ghost sm icon-only', { icon: 'x', 'aria-label': L('Limpar seleção') }));
  if (isAg && p.models.length) {
    if (hasAccess(p)) queueMicrotask(() => loadQuota(p, quotaCells));
    else for (const cell of quotaCells.values()) cell.replaceChildren(quotaBadge(null));
  }
  return panel([L('Modelos'), L('{0} alias(es) apontando para modelos deste provedor', p.models.length)], [
    filter,
    p.models.length > 1 && button(L('Testar todos'), () => bulkTest(p, p.models.filter((m) => m.enabled).map((m) => m.id), false), 'ghost sm', { 'data-tip': L('Teste rápido de todos os modelos ativos. Para testar só alguns, marque-os na tabela.') }),
    button(L('Importar'), () => importDialog(p), 'sm', { icon: 'cloud-arrow-down' }),
    button('', () => modelDialog(p), 'sm icon-only', { icon: 'plus', 'aria-label': L('Adicionar modelo'), 'data-tip': L('Adicionar um modelo') })],
  progress,
  bar,
  p.models.length ? h('div', { class: 'mtable' }, tableEl([{ t: all, cls: 'chk' }, L('Alias'), L('Modelo real'), isAg && L('Cota'), L('Último teste'), L('Ativo'), { t: '', cls: 'actions' }].filter(Boolean), rows.map((r) => r.tr)))
    : h('div', { class: 'empty-state' }, L('Nenhum modelo ainda. Importe vários de uma vez da lista do provedor.'), button(L('Importar do provedor'), () => importDialog(p), 'primary', { icon: 'cloud-arrow-down' })));
}

async function providers(sheet) {
  if (state.sub[0] === 'new') return state.sub[1] ? presetSetup(sheet, state.sub[1]) : catalog(sheet);
  const [{ providers: list, routing, aliases }] = await Promise.all([api('GET', '/api/providers'), loadPresets()]);
  state.aliases = aliases;
  if (!list.some((p) => p.id === state.provider)) state.provider = list[0]?.id ?? null;
  const addBtn = button(L('Adicionar provedor'), addProvider, 'primary', { icon: 'plus' });
  const page = h('div', { class: 'page' }, pageHead(L('Provedores'), list.length === 1 ? L('1 cadastrado. Mudanças valem na próxima requisição, sem reiniciar.') : L('{0} cadastrados. Mudanças valem na próxima requisição, sem reiniciar.', list.length), addBtn));
  sheet.replaceChildren(page);
  if (!list.length) {
    page.append(panel(null, null, h('div', { class: 'empty-state' }, L('Nenhum provedor ainda. Escolha um no catálogo e cole a chave de API; ela é cifrada e não volta ao navegador.'), h('div', { class: 'row wrap' }, h('a', { class: 'btn primary', href: '#/start' }, icon('rocket-launch'), L('Começar')), h('a', { class: 'btn', href: '#/providers/new' }, L('Abrir catálogo'))))));
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
      h('span', { class: 'picon-wrap' }, providerIcon(x, 'sm'), h('span', { class: `dot status ${x.enabled && hasAccess(x) ? 'pos' : ''}`, 'data-tip': x.enabled ? L('Ativo') : L('Desativado') })),
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
    r.defaultAlias && !rows.some(({ p, m }) => m.alias === r.defaultAlias && hasAccess(p))
      && notice(L('O modelo padrão, {0}, não está em nenhum provedor ligado com chave. Pedidos "auto" falham até você ligar o provedor dele ou escolher outro modelo.', r.defaultAlias), 'warn', L('Modelo padrão fora do ar')),
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
// Rótulos do Claude Desktop no idioma do próprio app, tirados dos arquivos de tradução dele (versões 5.1231 e 5.11492).
// O Desktop não tem chinês: lá ele aparece em inglês, e o passo a passo acompanha.
const DESKTOP_UI = {
  'pt-BR': ['Ajuda', 'Solução de problemas', 'Ativar modo de desenvolvedor', 'Desenvolvedor', 'Configurar inferência de terceiros', 'Conexão', 'Tipo de credencial', 'Chave de API estática', 'URL base do gateway', 'Chave de API do gateway', 'Esquema de autenticação do gateway', 'Descoberta de modelos', 'Aplicar alterações', 'Metadados do catálogo de modelos', 'Usar 1M sempre que estiver disponível', 'Modelos', 'Salvar e reiniciar'],
  en: ['Help', 'Troubleshooting', 'Enable Developer Mode', 'Developer', 'Configure Third-Party Inference', 'Connection', 'Credential type', 'Static API key', 'Gateway base URL', 'Gateway API key', 'Gateway auth scheme', 'Model discovery', 'Apply changes', 'Model catalog metadata', 'Use 1M wherever it’s available', 'Models', 'Save & Restart'],
  es: ['Ayuda', 'Solución de problemas', 'Activar modo de desarrollador', 'Desarrollador', 'Configurar inferencia de terceros', 'Conexión', 'Tipo de credencial', 'Clave de API estática', 'URL base del gateway', 'Clave de API de Gateway', 'Esquema de autenticación del gateway', 'Detección de modelos', 'Aplicar cambios', 'Metadatos del catálogo de modelos', 'Usar 1M siempre que esté disponible', 'Modelos', 'Guardar y reiniciar'],
  fr: ['Aide', 'Dépannage', 'Activer le mode développeur', 'Développeur', 'Configurer l’inférence tierce', 'Connexion', 'Type d’identifiant', 'Clé API statique', 'URL de base de la passerelle', 'Clé API de passerelle', 'Schéma d’authentification de la passerelle', 'Découverte de modèles', 'Appliquer les modifications', 'Métadonnées du catalogue de modèles', 'Utiliser 1M partout où c’est disponible', 'Modèles', 'Enregistrer et redémarrer'],
  de: ['Hilfe', 'Fehlerbehebung', 'Entwicklermodus aktivieren', 'Entwickler', 'Drittanbieter-Inferenz konfigurieren', 'Verbindung', 'Typ der Zugangsdaten', 'Statischer API-Schlüssel', 'Gateway-Basis-URL', 'Gateway-API-Schlüssel', 'Gateway-Authentifizierungsschema', 'Modellerkennung', 'Änderungen übernehmen', 'Modellkatalog-Metadaten', '1M überall verwenden, wo verfügbar', 'Modelle', 'Speichern & Neu starten'],
  ja: ['ヘルプ', 'トラブルシューティング', '開発者モードを有効化', '開発者', 'サードパーティ推論を設定', '接続', '認証情報タイプ', '静的 API キー', 'ゲートウェイ ベース URL', 'ゲートウェイ API キー', 'ゲートウェイ認証スキーム', 'モデル検出', '変更を適用', 'モデルカタログのメタデータ', '利用可能な場合は常に 1M を使用', 'モデル', '保存して再起動'],
  ko: ['도움말', '문제 해결', '개발자 모드 활성화', '개발자', '타사 추론 설정', '연결', '자격 증명 유형', '정적 API 키', '게이트웨이 기본 URL', '게이트웨이 API 키', '게이트웨이 인증 방식', '모델 검색', '변경사항 적용', '모델 카탈로그 메타데이터', '사용 가능한 모든 곳에서 1M 사용', '모델', '저장 및 재시작'],
};

/** Passo a passo do Claude Desktop com os nomes que a pessoa vê na tela dele. */
function desktopSteps() {
  const [help, trouble, devMode, dev, thirdParty, conn, credType, staticKey, baseUrl, apiKey, scheme, discovery, apply, catalog, oneM] = DESKTOP_UI[currentLang()] ?? DESKTOP_UI.en;
  const b = (...parts) => h('b', {}, parts.join(' › '));
  return [
    Ln('Menu {0}.', b(help, trouble, devMode)),
    Ln('Menu {0}.', b(dev, thirdParty)),
    Ln('Em {0}, escolha {1}.', b(conn), b('Gateway')),
    Ln('Em {0}, deixe {1}.', b(credType), b(staticKey)),
    Ln('Cole a URL em {0} e o token em {1}.', b(baseUrl), b(apiKey)),
    Ln('Em {0}, escolha {1}.', b(scheme), b('bearer')),
    // O app só usa a janela de 1M dos modelos que a oferecem (contexto de 1 milhão no Rotaz) com esta opção ligada.
    Ln('Ligue também {0}: os modelos com contexto de 1 milhão passam a usar a janela inteira.', b(oneM)),
    Ln('Ligue {0} e {1}, clique em {2} e reinicie o app.', b(discovery), b(catalog), b(apply)),
  ];
}
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
        panel('Claude Desktop', null, h('div', { class: 'panel-body stack tight' }, desktopOneClick(),
          h('details', { class: 'advanced' }, h('summary', {}, icon('caret-right'), L('Configurar à mão')),
            h('ol', { class: 'steps-list' }, ...desktopSteps().map((s) => h('li', {}, h('span', {}, s))))))),
        panel([L('Terminal'), L('Mescle em ~/.claude/settings.json (faça uma cópia antes)')], h('button', { type: 'button', class: 'btn ghost sm icon-only', 'aria-label': L('Copiar'), 'data-tip': L('Copiar com o token'), onclick: async () => { await navigator.clipboard.writeText(cliJson); toast(L('Copiado')); } }, icon('copy')),
          h('div', { class: 'panel-body' }, h('pre', {}, cliJson.replace(c.token, L('<token do gateway>')))))))));
}

// ---------- configurações ----------
/** Configurações → Atualizações: liga e desliga, mostra o estado e oferece verificar, instalar ou baixar. */
function updatesSetting(s) {
  const status = h('div', { class: 'small' });
  const act = h('div', { class: 'row' });
  const desc = () => (updates.info?.mode === 'auto' ? L('Baixa as versões novas do GitHub e instala quando o app reinicia.') : L('Avisa quando há uma versão nova no GitHub.'));
  const descEl = h('div', { class: 'small' }, desc());
  const paint = (u) => {
    if (!descEl.isConnected && descEl.dataset.mounted) { updates.listeners.delete(paint); return; } // a tela saiu
    descEl.textContent = desc();
    status.textContent = updateText(u);
    const a = updateAction(u);
    act.replaceChildren(...[a ? button(a.label, a.run, 'primary sm', { icon: 'arrows-clockwise' })
      : u?.enabled ? button(L('Verificar agora'), async (e) => { e.currentTarget.disabled = true; await loadUpdate({ force: true }); }, 'sm', { icon: 'arrows-clockwise' }) : null].filter(Boolean));
  };
  updates.listeners.add(paint);
  paint(updates.info);
  requestAnimationFrame(() => { descEl.dataset.mounted = '1'; });
  loadUpdate().catch(() => {});
  const sw = toggle(s.updateCheck !== false, async (v) => {
    try { await api('PUT', '/api/settings', { updateCheck: v }); } catch (e) { fail(e); return; }
    await loadUpdate({ force: v });
  }, L('Atualizações automáticas'));
  return h('div', { class: 'setting update-setting' },
    h('div', { class: 'txt' }, h('div', {}, L('Atualizações')), descEl, status, act),
    h('div', { class: 'ctl' }, sw));
}

async function settings(sheet) {
  const [{ server: s, autoStartSupported, autoStartLabel, desktop, masterKeySource, logFile }, bud] = await Promise.all([api('GET', '/api/settings'), api('GET', '/api/budget')]);
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
  // Endereço vindo de --host (ex.: ::1) não está na lista: sem a opção, o campo ficava vazio e salvar era recusado.
  if (![...f.host.options].some((o) => o.value === s.host)) f.host.append(h('option', { value: s.host }, s.host));
  f.host.value = s.host; f.logLevel.value = s.logLevel;
  // Gastos e orçamento: limites na moeda escolhida; os preços dos modelos seguem em dólar e a cotação converte.
  const money0 = (v) => h('input', { type: 'number', min: 0, step: 'any', value: v || '', placeholder: L('Sem limite') });
  const g = {
    currency: h('select', {}, [['USD', L('Dólar (US$)')], ['BRL', L('Real (R$)')], ['EUR', L('Euro (€)')]].map(([v, t]) => h('option', { value: v }, t))),
    rate: h('input', { type: 'number', min: 0.0001, step: 'any', value: bud.rate }),
    daily: money0(bud.daily), monthly: money0(bud.monthly),
    warnAt: h('input', { type: 'number', min: 1, max: 99, value: bud.warnAt }),
    action: h('select', {}, [['alert', L('Só avisar')], ['switch', L('Trocar para outro modelo')], ['block', L('Bloquear os pedidos')]].map(([v, t]) => h('option', { value: v }, t))),
    fallback: aliasSelect(bud.fallbackAlias, bud.aliases, L('Escolha um modelo'), () => {}),
  };
  g.currency.value = bud.currency; g.action.value = bud.action;
  const rateField = field(L('Cotação: 1 dólar vale'), g.rate, L('Atualize quando quiser; os preços dos modelos são em dólar.'));
  const fallbackField = field(L('Modelo de reserva'), g.fallback, L('Use um modelo barato ou local.'), 'full');
  const syncBudget = () => { rateField.hidden = g.currency.value === 'USD'; fallbackField.hidden = g.action.value !== 'switch'; };
  g.currency.addEventListener('change', syncBudget); g.action.addEventListener('change', syncBudget);
  syncBudget();
  const save = async () => {
    try {
      await api('PUT', '/api/budget', { currency: g.currency.value, rate: Number(g.rate.value) || 1, daily: Number(g.daily.value) || 0, monthly: Number(g.monthly.value) || 0,
        warnAt: Number(g.warnAt.value) || 80, action: g.action.value, fallbackAlias: g.fallback.value || null });
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
          field(L('Tentativas por requisição'), f.maxAttempts, L('Soma chaves e fallback.')), field(L('Nível de log'), f.logLevel, logFile))),
        panel([L('Gastos e orçamento'), L('Conta só os modelos com preço cadastrado')], null, h('div', { class: 'panel-body form-grid' },
          field(L('Moeda'), g.currency), rateField,
          field(L('Limite por dia'), g.daily, L('Vazio ou 0: sem limite.')), field(L('Limite por mês'), g.monthly, L('Vazio ou 0: sem limite.')),
          field(L('Avisar ao chegar em (%)'), g.warnAt), field(L('Ao atingir o limite'), g.action),
          fallbackField))),
      h('div', { class: 'c5 stack' },
        panel([L('Aparência'), L('Vale para este painel em qualquer navegador')], null,
          setting(L('Tema'), L('Automático segue o sistema operacional.'), segmented([{ value: 'auto', label: L('Auto') }, { value: 'light', label: L('Claro') }, { value: 'dark', label: L('Escuro') }], state.ui?.theme ?? 'auto', (v) => saveUi({ theme: v }), { label: L('Tema') })),
          setting(L('Paleta'), L('Cor de destaque nos dados e na seleção.'), swatches),
          setting(L('Idioma'), L('O automático segue o idioma do sistema.'), langSelect(state.ui?.lang ?? 'auto', changeLang))),
        panel(L('Sistema e segurança'), null,
          setting(L(autoStartLabel), !autoStartSupported ? L('Disponível no Windows ou no app instalado.') : desktop ? L('Abre minimizado na bandeja ao entrar no sistema.') : L('Roda sem janela, na conta atual.'),
            autoStartSupported ? toggle(s.autoStart, async (v) => {
              try { await api('PUT', '/api/settings', { autoStart: v }); toast(v ? L('Inicialização automática ligada') : L('Inicialização automática desligada')); }
              catch (e) { fail(e); route(); } // o interruptor volta ao estado real
            }, autoStartLabel) : badge(L('Indisponível'))),
          setting(L('Chave mestra'), { dpapi: L('Protegida pelo Windows (DPAPI) e vinculada à sua conta.'), keychain: L('Protegida pelo cofre do sistema (Keychain ou equivalente).'), env: L('Vem da variável GATEWAY_MASTER_KEY.'), file: L('Arquivo local com permissão restrita.') }[masterKeySource], badge(masterKeySource === 'keychain' ? L('Cofre do sistema') : masterKeySource.toUpperCase(), 'pos')),
          closeAction && setting(L('Ao fechar a janela'), closeAction === 'quit' ? (desktop ? L('O app e o gateway encerram juntos.') : L('O app encerra. O gateway da versão de terminal continua rodando.')) : L('O app continua na bandeja e o gateway segue funcionando. Um aviso confirma.'),
            segmented([{ value: 'tray', label: L('Manter na bandeja') }, { value: 'quit', label: L('Encerrar o app') }], closeAction, async (v) => {
              try {
                await desk.setCloseAction(v);
                toast(v === 'quit' ? L('Fechar a janela agora encerra o Rotaz') : L('Fechar a janela agora mantém o Rotaz na bandeja'));
                route();
              } catch (e) { fail(e); }
            }, { label: L('Ao fechar a janela') })),
          setting(L('Senha do painel'), null, button(L('Trocar senha'), pw, 'sm', { icon: 'lock-simple' })),
          updatesSetting(s))))));
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
  const load = async () => {
    const next = (await api('GET', '/api/logs')).lines;
    if (next.length === lines.length && next.at(-1) === lines.at(-1)) return; // nada novo: não reescreve a caixa
    lines = next;
    paint();
  };
  sheet.replaceChildren(h('div', { class: 'page' },
    pageHead(L('Registros'), L('Segredos são redigidos antes de gravar; o conteúdo das mensagens nunca é registrado.'), [
      segmented([{ value: 'all', label: L('Tudo') }, { value: 'warn', label: L('Avisos') }, { value: 'error', label: L('Erros') }], level, (v) => { level = v; paint(); }, { label: L('Filtro') }),
      button('', () => load().catch(fail), 'icon-only', { icon: 'arrows-clockwise', 'aria-label': L('Atualizar'), 'data-tip': L('Atualizar') })]),
    h('section', { class: 'panel' }, h('div', { class: 'panel-body' }, box))));
  await load();
  box.scrollTop = box.scrollHeight;
  poll(load, 5000);
}

// ---------- começar: configuração guiada para quem nunca usou ----------
/** O que o clique liga no Claude Desktop, em palavras simples (as chaves vêm de src/claude-desktop.js). */
const DESKTOP_FEATURES = {
  gateway: LK('O Claude passa a falar com o Rotaz'),
  modelDiscoveryEnabled: LK('Os modelos que você conectar aparecem no seletor do Claude'),
  modelCatalogEnabled: LK('Nome, descrição e limite certos de cada modelo no seletor'),
  modelPrefer1mContext: LK('Conversas longas usam a janela de 1 milhão de tokens quando o modelo aguenta'),
  toolSearchEnabled: LK('Ferramentas carregadas só quando precisa, para sobrar contexto'),
  builtinBrowserEnabled: LK('Navegador embutido no Claude'),
};

/**
 * Claude Desktop em um clique: o que será ligado, o estado e as ações (configurar, desfazer).
 * Usado na tela Começar e na tela Claude Code.
 */
function desktopOneClick() {
  const box = h('div', { class: 'dsk' });
  let busy = false;
  const draw = (s) => {
    const done = s.ok;
    const stale = s.applied && !s.current;
    const state = done ? h('div', { class: 'dsk-state' }, badge(L('Configurado'), 'pos'), h('span', { class: 'small' }, L('Feche e abra o Claude Desktop para começar a usar.')))
      : stale ? h('div', { class: 'dsk-state' }, badge(L('Desatualizado'), 'warn'), h('span', { class: 'small' }, L('O endereço ou o token do Rotaz mudou. Configure de novo.')))
        : !s.installed ? notice(L('Não encontramos o Claude Desktop neste computador. Instale e volte aqui; a configuração também pode ser gravada agora.'), 'warn')
          : null;
    const run = async (path, msg) => {
      if (busy) return;
      busy = true;
      try { draw(await api('POST', path, {})); toast(msg); } catch (e) { fail(e); } finally { busy = false; }
    };
    const go = button(done ? L('Configurar de novo') : L('Configurar com um clique'), () => run('/api/claude-desktop/apply', L('Claude Desktop configurado. Feche e abra o Claude para valer.')), done ? 'lg' : 'primary lg', { icon: done ? 'arrows-clockwise' : 'check' });
    const undo = s.canUndo && button(L('Desfazer'), () => confirmDo(L('Desfazer a configuração do Claude Desktop'), L('O Claude volta à configuração que tinha antes. Os provedores do Rotaz continuam aqui.'), L('Desfazer'),
      async () => { draw(await api('POST', '/api/claude-desktop/undo', {})); toast(L('Configuração anterior do Claude Desktop restaurada')); }), 'ghost lg', { icon: 'arrow-counter-clockwise' });
    const keys = ['gateway', ...(s.features ?? [])].filter((k) => DESKTOP_FEATURES[k]);
    box.replaceChildren(
      h('ul', { class: 'dsk-list' }, keys.map((k) => h('li', {}, icon('check'), h('span', {}, L(DESKTOP_FEATURES[k]))))),
      h('div', { class: 'dsk-side' },
        state,
        h('div', { class: 'row wrap' }, go, undo),
        !done && h('p', { class: 'small' }, s.mode === '3p' ? L('Fica ao lado das configurações que você já tem no Claude. Dá para desfazer aqui.') : L('O Claude passa a usar os modelos do Rotaz no lugar da conta claude.ai. Dá para desfazer aqui.'))));
  };
  api('GET', '/api/claude-desktop').then(draw).catch((e) => box.replaceChildren(notice(e.message, 'warn')));
  return box;
}

/** Contas que só funcionam com plano pago (src/presets.js): o aviso que aparece antes do login. */
const PAID_TEXT = () => L('Para usar este provedor, a conta precisa ter um plano pago ativo. Sem plano, o login até funciona, mas os pedidos são recusados.');

/** Destaques da configuração guiada: os mais simples para quem nunca usou. O resto aparece em "Ver mais". */
const START_ACCOUNTS = ['account-github', 'account-cline', 'account-kilocode', 'antigravity', 'account-codex', 'account-xai-oauth'];
const START_KEYS = ['openrouter', 'gemini', 'openai', 'anthropic', 'deepseek']; // + "Outro endereço": 6, como as contas

// ---------- Claude Desktop: guia visual fiel a cada sistema ----------
// Onde ficam os menus, segundo a documentação do Claude Desktop (claude.com/docs/third-party/claude-desktop):
// no macOS, na barra de menus do sistema (Ajuda › Solução de problemas › Ativar modo de desenvolvedor, depois
// Desenvolvedor › Configurar inferência de terceiros); no Windows, no menu ☰ do canto superior esquerdo da janela.
// O Linux segue o Windows. A janela de configuração (barra lateral de seções, Conexão com o seletor Gateway, os
// cartões de credenciais e de Modelos, Aplicar alterações e Salvar e reiniciar) foi redesenhada da imagem oficial.

/** Sistema mostrado no guia: o desta máquina, até a pessoa escolher outro. */
let guideOS = null;
function hostOS() {
  const p = `${desk?.platform ?? ''} ${navigator.userAgentData?.platform ?? ''} ${navigator.platform ?? ''} ${navigator.userAgent}`;
  return /mac|darwin/i.test(p) ? 'mac' : /linux|x11/i.test(p) && !/android/i.test(p) ? 'linux' : 'win';
}
const currentOS = () => (guideOS ??= hostOS());
const OS_TABS = [{ value: 'win', label: 'Windows' }, { value: 'mac', label: 'macOS' }, { value: 'linux', label: 'Linux' }];
/** Automático ou manual: fica escolhido entre as telas (visão geral e configuração guiada). */
let desktopMode = 'auto';

/** Rótulos do Claude no idioma dele, por nome. */
function claudeLabels() {
  const a = DESKTOP_UI[currentLang()] ?? DESKTOP_UI.en;
  const k = ['help', 'trouble', 'devMode', 'dev', 'thirdParty', 'conn', 'credType', 'staticKey', 'baseUrl', 'apiKey', 'scheme', 'discovery', 'apply', 'catalog', 'oneM', 'models', 'saveRestart'];
  return Object.fromEntries(k.map((x, i) => [x, a[i]]));
}
const SCENE_KEYS = ['developer', 'thirdParty', 'gateway', 'discovery', 'catalog'];

/**
 * Os cinco ajustes, na ordem de quem faz à mão. As chaves batem com status().checks em src/claude-desktop.js.
 * steps(): o caminho escrito para o sistema escolhido; fields(): os valores para copiar.
 */
function desktopItems(cfg, os = currentOS()) {
  const t = claudeLabels();
  const b = (...parts) => h('b', {}, parts.join(' › '));
  const where = (path) => (os === 'mac'
    ? Ln('Na barra de menus do Mac, no alto da tela, abra {0}.', path)
    : Ln('Clique no menu {0} no canto superior esquerdo da janela do Claude e abra {1}.', h('span', { class: 'kbd-ico' }, icon('list')), path));
  return [
    { key: 'developer', title: L('Ligar o modo de desenvolvedor'), why: L('Libera o menu {0} do Claude, onde fica a inferência de terceiros.', t.dev),
      steps: () => [where(b(t.help, t.trouble, t.devMode)), Ln('Confirme se o Claude pedir. O menu {0} aparece logo em seguida.', b(t.dev))] },
    { key: 'thirdParty', title: L('Abrir a inferência de terceiros'), why: L('Faz o Claude mandar as conversas para o Rotaz, e não para a conta claude.ai.'),
      steps: () => [where(b(t.dev, t.thirdParty)), Ln('Na seção {0}, escolha {1} na primeira lista.', b(t.conn), b('Gateway'))] },
    { key: 'gateway', title: L('Preencher endereço, chave e esquema'), why: L('Diz ao Claude onde o Rotaz está e com qual chave entrar. Sem isso, o pedido é recusado.'),
      steps: () => [Ln('Em {0}, escolha {1}.', b(t.credType), b(t.staticKey)), L('Copie cada valor para o campo de mesmo nome:')],
      fields: () => [copyLine(t.baseUrl, cfg.baseUrl), copyLine(t.apiKey, cfg.token, true), copyLine(t.scheme, 'bearer')] },
    { key: 'discovery', title: L('Ligar {0}', t.discovery), why: L('Faz os modelos escolhidos no Rotaz aparecerem no seletor do Claude.'),
      steps: () => [Ln('Desça até o cartão {0} e ligue {1}.', b(t.models), b(t.discovery))] },
    { key: 'catalog', title: L('Ligar {0}', t.catalog), why: L('Mostra o nome, a descrição e o limite certos de cada modelo no seletor.'),
      steps: () => [Ln('Ligue também {0}.', b(t.catalog)), Ln('Clique em {0} e depois em {1}. O Claude reinicia sozinho.', b(t.apply), b(t.saveRestart))] },
  ];
}

/**
 * Cena animada do Claude Desktop no sistema escolhido. play(chaves) encena só esses passos, partindo do estado
 * de quem já fez os anteriores; finish(chaves) mostra o resultado parado. Só transform e opacity.
 */
function claudeScene(port, os, onStep = () => {}) {
  const t = claudeLabels();
  const mac = os === 'mac';
  const bars = (n, cls = '') => Array.from({ length: n }, () => h('i', { class: cls }));
  const item = (label, sub) => h('div', { class: 'cs-item' }, h('span', {}, label), sub && icon('caret-right'));
  const ph = (n) => Array.from({ length: n }, () => h('div', { class: 'cs-item ph' }, h('i')));
  const iTrouble = item(t.trouble, true), iDevMode = item(t.devMode), iThird = item(t.thirdParty);
  const iHelp = item(t.help, true), iDevTop = item(t.dev, true);
  const mHelp = h('span', { class: 'cs-m' }, t.help), mDev = h('span', { class: 'cs-m' }, t.dev);
  const burger = h('span', { class: 'cs-burger' }, icon('list'));
  const menuMain = h('div', { class: 'cs-menu' }, ...ph(3), iDevTop, iHelp); // o menu ☰ (Windows e Linux)
  const menuHelp = h('div', { class: 'cs-menu' }, ...ph(2), iTrouble);
  const menuTrouble = h('div', { class: 'cs-menu' }, ...ph(1), iDevMode);
  const menuDev = h('div', { class: 'cs-menu' }, ...ph(1), iThird);
  const menus = [menuMain, menuHelp, menuTrouble, menuDev];
  const titlebar = mac
    ? h('div', { class: 'cs-title' }, h('span', { class: 'cs-lights' }, h('i'), h('i'), h('i')), h('span', { class: 'cs-name' }, 'Claude'))
    : h('div', { class: 'cs-title' }, burger, h('span', { class: 'cs-name' }, 'Claude'), h('span', { class: 'grow' }), h('span', { class: 'cs-winbtns' }, h('i'), h('i'), h('i')));
  const win = h('div', { class: 'cs-win' }, titlebar,
    h('div', { class: 'cs-app' }, h('div', { class: 'cs-app-side' }, ...bars(4)), h('div', { class: 'cs-app-main' }, h('i', { class: 'w60' }), h('i', { class: 'w80' }), h('div', { class: 'cs-app-input' }))));
  const menubar = mac && h('div', { class: 'cs-menubar' }, h('b', {}, 'Claude'), ...bars(3, 'cs-mb'), mDev, mHelp);

  const field = (text, { mono, sel } = {}) => { const v = h('span', { class: mono ? 'mono' : '' }, text); return { box: h('span', { class: `cs-field${sel ? ' sel' : ''}` }, v, sel && icon('caret-down')), v }; };
  const fProv = field('Gateway', { sel: true });
  const fUrl = field(`http://127.0.0.1:${port}`, { mono: true }), fKind = field(t.staticKey, { sel: true }), fKey = field('••••••••••', { mono: true }), fScheme = field('bearer', { sel: true });
  const sw = () => { const on = h('i', { class: 'cs-sw-on' }), knob = h('b'); return { el: h('span', { class: 'cs-sw' }, on, knob), on, knob }; };
  const sw1 = sw(), sw2 = sw();
  const row = (label, ctl, cls = '') => h('div', { class: `cs-row ${cls}` }, h('span', {}, label), ctl);
  const applyBtn = h('span', { class: 'cs-btn' }, t.apply);
  const cfgWin = h('div', { class: 'cs-cfg' },
    h('div', { class: 'cs-cfg-head' }, t.thirdParty),
    h('div', { class: 'cs-cfg-body' },
      h('div', { class: 'cs-cfg-side' }, h('span', { class: 'on' }, t.conn), ...bars(4)),
      h('div', { class: 'cs-cfg-main' },
        h('div', { class: 'cs-h' }, t.conn), fProv.box,
        h('div', { class: 'cs-card' }, row(t.baseUrl, fUrl.box), row(t.credType, fKind.box), row(t.apiKey, fKey.box), row(t.scheme, fScheme.box)),
        h('div', { class: 'cs-card' }, h('div', { class: 'cs-card-h' }, t.models), row(t.discovery, sw1.el, 'sw'), row(t.catalog, sw2.el, 'sw')))),
    h('div', { class: 'cs-cfg-foot' }, applyBtn));
  const dlgBtn = h('span', { class: 'cs-btn' }, t.saveRestart);
  const dlg = h('div', { class: 'cs-dlg' }, h('i', { class: 'w80' }), h('i', { class: 'w60' }), h('div', { class: 'cs-dlg-foot' }, dlgBtn));
  const done = h('div', { class: 'cs-done' }, icon('check-circle', 'lg'), h('span', {}, L('Claude ligado ao Rotaz')));
  const cursor = svg('svg', { class: 'cs-cursor', viewBox: '0 0 16 20', 'aria-hidden': 'true' }, svg('path', { d: 'M1 1v15l4-4 3 7 3-1.4-3-6.6h6z' }));
  const stage = h('div', { class: `cs-stage ${mac ? 'mac' : 'win'}`, 'aria-hidden': 'true' }, menubar, win, ...menus, cfgWin, dlg, done, cursor);

  const filled = [fUrl, fKind, fKey, fScheme];
  const setSw = (x, on) => { x.on.style.opacity = on ? '1' : '0'; x.knob.style.transform = on ? 'translateX(var(--s-3))' : 'none'; };
  const devShown = (on) => { (mac ? mDev : iDevTop).style.display = on ? '' : 'none'; };
  /** Estado de quem já fez tudo antes de "next" (sem next: tudo feito). */
  function setState(next) {
    const i = next ? SCENE_KEYS.indexOf(next) : SCENE_KEYS.length;
    const past = (k) => SCENE_KEYS.indexOf(k) < i;
    for (const x of stage.querySelectorAll('.hit')) x.classList.remove('hit');
    for (const m of [...menus, dlg]) { m.style.opacity = '0'; m.style.transform = ''; }
    devShown(past('developer'));
    cfgWin.style.opacity = past('thirdParty') && i < SCENE_KEYS.length ? '1' : '0';
    cfgWin.style.transform = 'none';
    fProv.v.style.opacity = past('thirdParty') ? '1' : '0';
    for (const x of filled) x.v.style.opacity = past('gateway') ? '1' : '0';
    setSw(sw1, past('discovery'));
    setSw(sw2, past('catalog'));
    done.style.opacity = i === SCENE_KEYS.length ? '1' : '0';
    done.style.transform = 'none';
    cursor.style.opacity = '0';
  }
  // posição de um menu ao lado (ou abaixo) do item que o abre, medida na hora: acompanha qualquer largura
  const place = (menu, anchor, side) => {
    const s = stage.getBoundingClientRect(), a = anchor.getBoundingClientRect(), w = menu.offsetWidth;
    let x = side === 'below' ? a.left - s.left : a.right - s.left + 2;
    let y = side === 'below' ? a.bottom - s.top + 2 : a.top - s.top - 4;
    // sem espaço ao lado: o submenu desce logo abaixo do item, encostado na direita, sem cobrir o menu de onde saiu
    if (x + w > s.width - 4) {
      x = s.width - w - 4;
      if (side !== 'below') y = a.bottom - s.top + 2;
    }
    menu.style.left = `${Math.max(4, x)}px`;
    menu.style.top = `${y}px`;
  };

  let token = 0;
  function run(tok) {
    const alive = () => { if (tok !== token || !stage.isConnected) throw new Error('parou'); };
    const step = async (p) => { const r = await p; alive(); return r; };
    const wait = (ms) => step(new Promise((r) => setTimeout(r, ms)));
    const to = (target, dur = 0.6) => {
      const s = stage.getBoundingClientRect(), r = target.getBoundingClientRect();
      return step(M.animate(cursor, { transform: `translate(${r.left - s.left + r.width * 0.55}px, ${r.top - s.top + r.height * 0.55}px)` }, { duration: dur, ease: [0.45, 0, 0.2, 1] }).finished);
    };
    const press = async (x) => { x.classList.add('hit'); await step(M.animate(cursor, { scale: [1, 0.86, 1] }, { duration: 0.24 }).finished); };
    const show = (x, from = 'translateY(-4px)') => step(M.animate(x, { opacity: [0, 1], transform: [from, 'translate(0, 0)'] }, { duration: 0.22, ease: EASE }).finished);
    const hide = (x) => step(M.animate(x, { opacity: 0 }, { duration: 0.16 }).finished);
    const fill = (x) => step(M.animate(x.v, { opacity: [0, 1], transform: ['translateX(-4px)', 'translateX(0)'] }, { duration: 0.3 }).finished);
    const flip = (x) => step(Promise.all([M.animate(x.on, { opacity: [0, 1] }, { duration: 0.2 }).finished, M.animate(x.knob, { transform: ['translateX(0)', 'translateX(12px)'] }, { duration: 0.22, ease: EASE }).finished]));
    const closeMenus = () => step(Promise.all(menus.map((m) => (m.style.opacity === '0' ? null : M.animate(m, { opacity: 0 }, { duration: 0.16 }).finished))));
    const openMenu = async (menu, anchor, side) => { place(menu, anchor, side); await show(menu, side === 'below' ? 'translateY(-4px)' : 'translateX(-4px)'); };
    return {
      wait, to,
      async developer() {
        if (mac) { await to(mHelp); await press(mHelp); await openMenu(menuHelp, mHelp, 'below'); }
        else { await to(burger); await press(burger); await openMenu(menuMain, burger, 'below'); await to(iHelp, 0.4); iHelp.classList.add('hit'); await openMenu(menuHelp, iHelp, 'right'); }
        await to(iTrouble, 0.4); iTrouble.classList.add('hit'); await openMenu(menuTrouble, iTrouble, 'right');
        await to(iDevMode, 0.4); await press(iDevMode); await wait(250);
        await closeMenus();
        for (const x of stage.querySelectorAll('.hit')) x.classList.remove('hit');
        devShown(true);
        const target = mac ? mDev : burger;
        target.classList.add('hit');
        await step(M.animate(target, { scale: [1, 1.12, 1] }, { duration: 0.5 }).finished);
      },
      async thirdParty() {
        for (const x of stage.querySelectorAll('.hit')) x.classList.remove('hit');
        if (mac) { await to(mDev); await press(mDev); await openMenu(menuDev, mDev, 'below'); }
        else { await to(burger); await press(burger); await openMenu(menuMain, burger, 'below'); await to(iDevTop, 0.4); iDevTop.classList.add('hit'); await openMenu(menuDev, iDevTop, 'right'); }
        await to(iThird, 0.4); await press(iThird); await wait(200);
        await closeMenus();
        for (const x of stage.querySelectorAll('.hit')) x.classList.remove('hit');
        await step(M.animate(cfgWin, { opacity: [0, 1], transform: ['scale(.97)', 'scale(1)'] }, { duration: 0.32, ease: EASE }).finished);
        await to(fProv.box, 0.5); await press(fProv.box); await fill(fProv);
        fProv.box.classList.remove('hit');
      },
      async gateway() { for (const x of filled) { await to(x.box, 0.4); x.box.classList.add('hit'); await fill(x); x.box.classList.remove('hit'); } },
      async discovery() { await to(sw1.el, 0.45); await press(sw1.el); await flip(sw1); sw1.el.classList.remove('hit'); },
      async catalog() {
        await to(sw2.el, 0.45); await press(sw2.el); await flip(sw2); sw2.el.classList.remove('hit');
        await to(applyBtn, 0.5); await press(applyBtn); await wait(150);
        await show(dlg, 'scale(.96)');
        await to(dlgBtn, 0.45); await press(dlgBtn); await wait(200);
        await step(Promise.all([M.animate(dlg, { opacity: 0 }, { duration: 0.16 }).finished, M.animate(cfgWin, { opacity: 0, transform: 'scale(.98)' }, { duration: 0.2 }).finished]));
        M.animate(cursor, { opacity: 0 }, { duration: 0.3 });
        await step(M.animate(done, { opacity: [0, 1], transform: ['scale(.9)', 'scale(1)'] }, { duration: 0.4, ease: EASE }).finished);
      },
    };
  }
  const after = (keys) => SCENE_KEYS[SCENE_KEYS.indexOf(keys.at(-1)) + 1];
  stage.finish = (keys = SCENE_KEYS) => { token++; setState(after(keys)); onStep(null); };
  stage.play = async (keys = SCENE_KEYS) => {
    const tok = ++token;
    setState(keys[0]);
    if (reduced() || !M) { stage.finish(keys); return; }
    const r = run(tok);
    const s = stage.getBoundingClientRect();
    cursor.style.opacity = '1';
    cursor.style.transform = `translate(${s.width * 0.6}px, ${s.height * 0.8}px)`;
    try {
      for (const k of keys) { onStep(k); await r.wait(350); await r[k](); }
      await r.wait(300);
      M.animate(cursor, { opacity: 0 }, { duration: 0.3 });
      onStep(null);
    } catch { /* outra reprodução começou ou a cena saiu da tela */ }
  };
  setState(SCENE_KEYS[0]);
  return stage;
}

const SCENE_CAPTION = {
  developer: LK('Liga o modo de desenvolvedor'), thirdParty: LK('Abre a inferência de terceiros e escolhe Gateway'),
  gateway: LK('Preenche endereço, chave e esquema'), discovery: LK('Liga a descoberta de modelos'), catalog: LK('Liga os metadados, aplica e reinicia'),
};

/** A cena com legenda e "Ver de novo". keys: os passos encenados (todos, no automático; um só, em cada item do manual). */
function claudePlayer(port, { keys = SCENE_KEYS, onStep = () => {}, autoplay = true } = {}) {
  const box = h('div', { class: 'cs-player' });
  const caption = h('span', { class: 'cs-caption' });
  let scene;
  const step = (k) => {
    onStep(k);
    caption.textContent = k ? (keys.length > 1 ? `${keys.indexOf(k) + 1}/${keys.length} · ${L(SCENE_CAPTION[k])}` : L(SCENE_CAPTION[k]))
      : keys.length > 1 ? L('Pronto. O Rotaz faz tudo isso com um clique.') : L('É assim no seu Claude. Veja de novo quando quiser.');
  };
  const replay = button(L('Ver de novo'), () => scene.play(keys), 'ghost sm', { icon: 'arrow-counter-clockwise' });
  const build = () => { scene = claudeScene(port, currentOS(), step); box.replaceChildren(scene, h('div', { class: 'cs-foot' }, caption, replay)); step(null); };
  build();
  box.play = () => requestAnimationFrame(() => scene.play(keys));
  box.finish = () => scene.finish(keys);
  box.rebuild = () => { build(); box.play(); };
  if (autoplay) box.play();
  return box;
}

/** Traz o elemento para a vista rolando só o contêiner rolável mais próximo (ou a página). */
function revealIn(el) {
  let box = el.parentElement;
  while (box && !(/(auto|scroll)/.test(getComputedStyle(box).overflowY) && box.scrollHeight > box.clientHeight)) box = box.parentElement;
  const view = box ? box.getBoundingClientRect() : { top: 0, bottom: innerHeight };
  const r = el.getBoundingClientRect();
  const pad = 16;
  let dy = 0;
  if (r.bottom > view.bottom - pad) dy = Math.min(r.bottom - view.bottom + pad, r.top - view.top - pad);
  else if (r.top < view.top + pad) dy = r.top - view.top - pad;
  if (dy) (box ?? document.scrollingElement).scrollBy({ top: dy, behavior: reduced() ? 'auto' : 'smooth' });
}

/**
 * Passo a passo manual: um item por ajuste, numerado, conferido ao vivo. Aberto, mostra a cena daquele passo no
 * sistema escolhido e o caminho escrito, com os valores para copiar. Um aberto por vez; os vizinhos deslizam (FLIP).
 */
function desktopChecklist(cfg, port) {
  let openKey = null;
  const rows = desktopItems(cfg).map((it, i) => {
    const mark = h('span', { class: 'chk-mark' }, h('span', { class: 'chk-n' }, String(i + 1)), icon('check'));
    const tag = h('span', { class: 'chk-tag' });
    const body = h('div', { class: 'chk-how' });
    const summary = h('summary', {}, mark, h('span', { class: 'chk-txt' }, h('span', { class: 'chk-title' }, it.title), h('span', { class: 'chk-why' }, it.why)), tag, icon('caret-right'));
    const el = h('details', { class: 'chk', 'data-key': it.key }, summary, body);
    const r = { ...it, el, mark, tag, body };
    summary.addEventListener('click', (e) => { e.preventDefault(); toggle(r); });
    return r;
  });
  const fillBody = (r) => {
    const it = desktopItems(cfg).find((x) => x.key === r.key);
    const player = claudePlayer(port, { keys: [r.key], autoplay: false });
    r.player = player;
    r.body.replaceChildren(h('div', { class: 'chk-how-grid' }, player,
      h('div', { class: 'chk-how-text' },
        h('ol', { class: 'chk-steps' }, it.steps().map((s) => h('li', {}, h('span', {}, s)))),
        it.fields && h('div', { class: 'chk-fields' }, it.fields()))));
    player.play();
  };
  // FLIP: mede antes, muda, e cada item desliza do lugar antigo até o novo
  const flipAround = (mutate) => {
    const before = new Map(rows.map((x) => [x, x.el.getBoundingClientRect().top]));
    mutate();
    if (reduced() || !M) return;
    for (const x of rows) {
      const dy = before.get(x) - x.el.getBoundingClientRect().top;
      if (dy) M.animate(x.el, { transform: [`translateY(${dy}px)`, 'translateY(0)'] }, { duration: 0.32, ease: EASE });
    }
  };
  function toggle(r) {
    const opening = !r.el.open;
    flipAround(() => {
      for (const x of rows) if (x !== r && x.el.open) { x.el.open = false; x.body.replaceChildren(); }
      r.el.open = opening;
      if (opening) fillBody(r); else r.body.replaceChildren();
    });
    openKey = opening ? r.key : null;
    if (opening) {
      animate(r.body, { opacity: [0, 1], transform: ['translateY(-6px)', 'translateY(0)'] }, { duration: 0.32, ease: EASE });
      setTimeout(() => revealIn(r.el), 340);
    }
  }
  const box = h('div', { class: 'chk-list' }, rows.map((r) => r.el));
  box.paint = (cd) => {
    for (const r of rows) {
      const ok = !!cd?.checks?.[r.key];
      r.el.classList.toggle('ok', ok);
      r.tag.replaceChildren(...(ok ? [badge(L('Pronto'), 'pos')] : []));
      r.mark.setAttribute('aria-label', ok ? L('Pronto') : L('Falta'));
    }
  };
  box.openFirstPending = () => { const r = rows.find((x) => !x.el.classList.contains('ok')); if (r && !r.el.open) toggle(r); };
  box.rebuild = () => { const r = rows.find((x) => x.key === openKey); if (r) fillBody(r); };
  return box;
}

/**
 * Claude Desktop, inteiro: escolha entre automático (um clique, com o vídeo do que ele faz) e manual (os cinco
 * passos com as telas do sistema escolhido). getCd/setCd ligam o estado a quem usa (configuração guiada ou visão geral).
 */
function desktopPanel({ cfg, port, getCd, setCd }) {
  const el = h('div', { class: 'dp' });
  const warn = h('div', { class: 'dp-warn' });
  const hint = h('p', { class: 'dp-hint' });
  const content = h('div', { class: 'dp-content' });
  const status = h('div', { class: 'dp-status', role: 'status' });
  let list = null, mini = null, player = null, cta = null;
  const modeSeg = segmented([{ value: 'auto', label: L('Automático'), icon: 'lightning' }, { value: 'manual', label: L('Manual'), icon: 'list' }],
    desktopMode, (v) => { desktopMode = v; draw(); }, { label: L('Como configurar') });
  const osSeg = segmented(OS_TABS, currentOS(), (v) => { guideOS = v; player?.rebuild(); list?.rebuild(); }, { label: L('Seu sistema') });
  const bar = h('div', { class: 'dp-bar' }, modeSeg, h('div', { class: 'dp-os' }, h('span', {}, L('Seu sistema')), osSeg));

  const run = async (path, busyText) => {
    if (cta) { cta.disabled = true; cta.replaceChildren(icon('circle-notch', 'spinner'), busyText); }
    try { const n = await api('POST', path, {}); setCd(n); player?.finish(); paint(); } catch (e) { fail(e); paint(); }
  };
  function draw() {
    list = mini = player = cta = null;
    if (desktopMode === 'auto') {
      const items = desktopItems(cfg);
      mini = h('ul', { class: 'dp-mini' }, items.map((it, i) => h('li', { 'data-key': it.key }, h('span', { class: 'chk-mark' }, h('span', { class: 'chk-n' }, String(i + 1)), icon('check')), h('span', {}, it.title))));
      player = claudePlayer(port, { onStep: (k) => { for (const li of mini.children) li.classList.toggle('playing', li.dataset.key === k); } });
      cta = button(L('Configurar tudo automaticamente'), () => run('/api/claude-desktop/apply', L('Configurando…')), 'primary lg', { icon: 'lightning' });
      content.replaceChildren(h('div', { class: 'dp-auto' }, player, h('div', { class: 'dp-side' }, mini, cta, status)));
    } else {
      list = desktopChecklist(cfg, port);
      content.replaceChildren(list, status);
    }
    paint();
    if (list && !getCd()?.ok) requestAnimationFrame(() => list.openFirstPending());
    animate(content, { opacity: [0, 1], transform: ['translateY(6px)', 'translateY(0)'] }, { duration: 0.3, ease: EASE });
  }
  function paint() {
    const cd = getCd();
    const ok = !!cd?.ok;
    const n = SCENE_KEYS.filter((k) => cd?.checks?.[k]).length;
    hint.textContent = desktopMode === 'auto'
      ? L('Um clique grava os cinco ajustes no Claude, sem menus e sem copiar nada. No fim, você só fecha e abre o Claude.')
      : L('Clique em cada passo para ver onde ele fica no seu sistema. A lista confere o Claude sozinha a cada poucos segundos.');
    warn.replaceChildren(...(cd?.installed && !cd.developer && !cd.ok
      ? [notice(desktopMode === 'auto' ? L('Sem ele, o menu da inferência de terceiros não aparece. O botão abaixo liga sozinho.') : L('Sem ele, o menu da inferência de terceiros não aparece. Comece pelo passo 1.'), 'warn', L('O modo de desenvolvedor do Claude está desligado'))] : []));
    list?.paint(cd);
    if (mini) for (const li of mini.children) li.classList.toggle('ok', !!cd?.checks?.[li.dataset.key]);
    if (cta) {
      cta.disabled = ok;
      cta.className = ok ? 'btn lg' : 'btn primary lg';
      cta.replaceChildren(...(ok ? [icon('check'), L('Configurado')] : [icon('lightning'), L('Configurar tudo automaticamente')]));
    }
    status.replaceChildren(...(ok
      ? [badge(L('Pronto'), 'pos'), h('span', {}, L('Os cinco ajustes estão no Claude.')),
        cd.canUndo && button(L('Desfazer'), () => confirmDo(L('Desfazer a configuração do Claude Desktop'), L('O Claude volta à configuração que tinha antes. Os provedores do Rotaz continuam aqui.'), L('Desfazer'),
          () => run('/api/claude-desktop/undo', L('Desfazendo…'))), 'ghost sm', { icon: 'arrow-counter-clockwise' })]
      : !cd?.installed
        ? [h('span', {}, L('O Claude Desktop não foi encontrado neste computador. Dá para configurar agora e instalar depois.')),
          h('a', { class: 'btn ghost sm', href: 'https://claude.ai/download', target: '_blank', rel: 'noopener noreferrer' }, L('Baixar o Claude'), icon('arrow-square-out'))]
        : [h('span', {}, L('{0} de 5 ajustes prontos.', n))]).filter(Boolean)); // sem Desfazer, o item falso não pode virar texto
  }
  el.append(bar, hint, warn, content);
  draw();
  el.paint = paint;
  return el;
}

/**
 * Saúde da configuração, como passos em ordem: Claude Desktop (se instalado), provedor, modelos e reabrir o Claude.
 * Só o primeiro passo que falta fica liberado; os seguintes esperam. Também decide se o item Começar fica no menu.
 */
/**
 * Situação do Claude Desktop depois de gravar a configuração: 'reopened' (aberto já com ela), 'confirmed' (a pessoa
 * disse que reabriu e o processo não é visível), 'closed' (fechado: vai ler ao abrir) ou 'pending' (aberto desde antes).
 */
const claudeReopen = (cd) => (cd?.running === false ? 'closed'
  : cd?.restart === false ? (cd.running === true ? 'reopened' : 'confirmed') // macOS e Linux: o Rotaz não vê o processo, vale o "Já reabri"
    : 'pending');

async function setupHealth() {
  const [cd, cfg, prov] = await Promise.all([api('GET', '/api/claude-desktop').catch(() => null), api('GET', '/api/client-config').catch(() => null), api('GET', '/api/providers').catch(() => null)]);
  const providers = prov?.providers ?? [];
  const steps = [];
  const desktop = !!cd?.installed;
  if (desktop) steps.push({ key: 'claude', done: !!cd.ok });
  steps.push({ key: 'provider', done: providers.length > 0 });
  steps.push({ key: 'models', done: (cfg?.models?.length ?? 0) > 0 });
  if (desktop) steps.push({ key: 'reopen', done: claudeReopen(cd) !== 'pending' });
  let first = true;
  for (const s of steps) { s.state = s.done ? 'done' : first ? 'current' : 'locked'; if (!s.done) first = false; }
  const done = !!cfg && prov !== null && steps.every((s) => s.done);
  state.setupDone = done;
  paintStartNav();
  return { cd, cfg, providers, steps, done };
}

function paintStartNav() {
  for (const a of document.querySelectorAll('.nav[data-view="start"]')) a.hidden = !!state.setupDone;
  paintNav();
}

/** Estado anterior dos passos: o que acabou de ficar pronto ganha uma animação curta. */
let lastSetupSteps = {};

/**
 * Visão geral enquanto a configuração não funciona: só este cartão, com os passos em ordem.
 * refresh() recarrega a saúde e redesenha (depois de configurar, adicionar provedor etc.).
 */
function setupCard(hl, refresh) {
  const port = (() => { try { return new URL(hl.cfg.baseUrl).port; } catch { return location.port; } })();
  const total = hl.steps.length;
  const ready = hl.steps.filter((s) => s.done).length;
  const os = currentOS();
  const reopenText = () => (hl.cd?.running === false ? L('O Claude está fechado. Abra o Claude Desktop agora: ele já começa usando o Rotaz.')
    : os === 'mac' ? L('Ele só lê a configuração ao abrir. No Mac, escolha Sair no menu Claude, no alto da tela, e abra de novo.')
      : L('Ele só lê a configuração ao abrir. Saia pelo ícone perto do relógio (botão direito, Sair) e abra de novo. Fechar a janela não basta.'));
  const INFO = {
    claude: { icon: 'app-window', title: L('Conectar o Claude Desktop'), why: L('Os cinco ajustes que fazem o Claude mandar as conversas para o Rotaz.'),
      body: () => desktopPanel({ cfg: hl.cfg, port, getCd: () => hl.cd, setCd: (n) => { hl.cd = n; refresh(); } }) },
    provider: { icon: 'plugs-connected', title: L('Adicionar um provedor'), why: L('Quem responde de verdade: uma conta que você já tem ou uma chave de API.'),
      body: () => h('div', { class: 'row wrap' }, button(L('Adicionar provedor'), addProvider, 'primary', { icon: 'plus' })) },
    models: { icon: 'cube', title: L('Escolher os modelos'), why: L('Sem modelos escolhidos, o seletor do Claude fica vazio e os pedidos não têm para onde ir.'),
      body: () => h('div', { class: 'row wrap' }, button(L('Escolher modelos'), () => { const p = hl.providers[0]; if (p) { state.provider = p.id; state.openImportFor = p.id; } location.hash = '#/providers'; }, 'primary', { icon: 'cube' })) },
    reopen: { icon: 'arrows-clockwise', title: L('Fechar e abrir o Claude Desktop'), why: reopenText(),
      body: () => (hl.cd?.restart === null ? h('div', { class: 'row wrap' }, button(L('Já fechei e abri o Claude'), async () => { try { hl.cd = await api('POST', '/api/claude-desktop/reopened', {}); refresh(); } catch (e) { fail(e); } }, 'primary', { icon: 'check' })) : null) },
  };
  const items = hl.steps.map((s, i) => {
    const info = INFO[s.key];
    const mark = h('span', { class: 'sc-mark' }, s.state === 'done' ? icon('check') : s.state === 'locked' ? icon('lock-simple') : h('span', {}, String(i + 1)));
    const sub = s.state === 'done' ? L('Pronto') : s.state === 'locked' ? L('Libera depois do passo {0}.', i) : info.why;
    const li = h('li', { class: `sc-step ${s.state}` },
      mark,
      h('div', { class: 'sc-step-main' },
        h('div', { class: 'sc-step-head' }, h('span', { class: 'sc-step-title' }, info.title)),
        h('p', { class: 'sc-step-sub' }, sub),
        s.state === 'current' && h('div', { class: 'sc-step-body' }, info.body())));
    if (s.done && lastSetupSteps[s.key] === false) animate(mark, { transform: ['scale(.6)', 'scale(1)'], opacity: [0, 1] }, { duration: 0.4, ease: EASE });
    return li;
  });
  lastSetupSteps = Object.fromEntries(hl.steps.map((s) => [s.key, s.done]));
  const progress = h('div', { class: 'sc-progress' }, meter((ready / total) * 100, 'var(--pos)'), h('span', {}, L('{0} de {1} passos', ready, total)));
  return h('section', { class: 'sc' },
    h('div', { class: 'sc-head' }, h('span', { class: 'sc-ico' }, icon('rocket-launch', 'lg')),
      h('div', { class: 'sc-text' }, h('h2', { class: 'sc-title' }, L('Sua configuração ainda não está funcionando')),
        h('p', {}, L('Siga os passos na ordem. Cada um libera o próximo, e a lista se confere sozinha.'))),
      progress),
    h('ol', { class: 'sc-steps' }, items));
}

/** Adicionar provedor para quem não conhece o assunto: o guia só com conta ou chave, provedor e pronto. */
function addProvider() { setupFlow({ step: 1, only: 'provider' }).catch(fail); }

/**
 * Configuração guiada em tela cheia, logo depois da senha (e pelo item Começar):
 * Claude Desktop em um clique com tutorial, a forma de conectar (conta ou chave), o provedor e o fim.
 * Tudo dentro da camada: o login da conta e a chave de API acontecem aqui, sem ir para outra tela.
 */
async function setupFlow({ step = 0, instant = false, only = null } = {}) {
  // só o provedor (botão Adicionar provedor): sem a etapa do Claude Desktop, e o fim leva aos modelos
  const provOnly = only === 'provider';
  if (document.querySelector('.setup-layer')) return;
  const STEPS = ['claude', 'path', 'provider', 'done'];
  let ready = false;
  const layer = h('div', { class: 'splash setup-layer', role: 'dialog', 'aria-modal': 'true', 'aria-label': L('Configuração guiada') });
  const body = h('div', { class: 'onb-body setup-body' });
  const dots = STEPS.map((_, i) => h('span', { class: 'onb-dot', 'aria-hidden': 'true' }));
  const back = button(L('Voltar'), () => ready && go(st.step - 1), 'ghost lg');
  const next = button(L('Continuar'), () => ready && onNext(), 'primary lg onb-next');
  const later = button(provOnly ? L('Fechar') : L('Fazer depois'), () => ready && close(), 'ghost onb-skip');
  const stepTxt = h('span', { class: 'setup-count' });
  const onb = h('div', { class: 'onb setup' },
    h('div', { class: 'onb-top setup-top' }, stepTxt, later),
    body,
    h('div', { class: 'onb-foot' }, h('div', { class: 'onb-dots', role: 'progressbar', 'aria-valuemin': '1', 'aria-valuemax': String(STEPS.length) }, dots), h('div', { class: 'onb-actions' }, back, next)));
  layer.append(onb);
  if (provOnly) dots[0].hidden = true;
  for (const b of [back, next]) b.style.visibility = 'hidden';
  document.body.append(layer);
  root.inert = true;
  if (!instant) animate(layer, { opacity: [0, 1] }, { duration: 0.4 });
  let cd0, presets, added, cfg;
  try {
    [cd0, { presets }, { providers: added }, cfg] = await Promise.all([
      api('GET', '/api/claude-desktop').catch(() => null), loadPresets(), api('GET', '/api/providers'), api('GET', '/api/client-config')]);
  } catch (e) { layer.remove(); root.inert = false; throw e; }
  for (const b of [back, next]) b.style.visibility = '';
  let cd = cd0;
  const port = (() => { try { return new URL(cfg.baseUrl).port; } catch { return location.port; } })();
  const byId = (ids) => ids.map((id) => presets.find((p) => p.id === id)).filter(Boolean);
  const custom = presets.find((p) => p.id === 'custom');
  const PATHS = {
    account: { title: L('Entrar com uma conta'), text: L('Use uma conta que você já tem. O login abre no navegador e o Rotaz guarda o acesso. Sem copiar nada.'),
      icon: 'user-circle', logos: byId(['account-github', 'account-codex', 'account-xai-oauth', 'account-cline']), tag: L('Mais fácil'),
      featured: byId(START_ACCOUNTS).sort(byName), all: presets.filter((p) => p.category === 'account'), heading: L('Escolha a sua conta') },
    key: { title: L('Usar uma chave de API'), text: L('Cole a chave que o provedor gera no site dele. Serve para OpenRouter, Gemini, OpenAI e dezenas de outros.'),
      icon: 'key', logos: byId(['openrouter', 'gemini', 'openai', 'anthropic']), tag: null,
      featured: [...byId(START_KEYS), ...(custom ? [{ ...custom, name: L('Outro endereço') }] : [])],
      all: presets.filter((p) => p.category !== 'account' && p.category !== 'custom'), heading: L('Escolha o provedor') },
  };
  const st = { step, path: null, preset: null, providerId: null, providerName: null, more: false, query: '' };
  let stopLogin = () => {};
  // Verificação ao vivo: o Claude é conferido a cada poucos segundos; a página aberta decide o que redesenhar.
  let onLive = () => {};
  const live = setInterval(async () => {
    if (!document.querySelector('.setup-layer')) { clearInterval(live); return; }
    if (document.hidden || (st.step !== 0 && st.step !== 3)) return;
    try {
      const n = await api('GET', '/api/claude-desktop');
      if (JSON.stringify(n) !== JSON.stringify(cd)) { cd = n; onLive(); }
    } catch { /* sessão ou servidor fora: tenta de novo na próxima */ }
  }, 2500);


  const head = (title, text) => [h('h2', { class: 'onb-title' }, title), text && h('p', { class: 'onb-text' }, text)];

  // ---- 1. Claude Desktop: automático (um clique, com o vídeo) ou manual (as telas do sistema, passo a passo) ----
  const pageClaude = () => {
    const panel = desktopPanel({ cfg, port, getCd: () => cd, setCd: (n) => { cd = n; paintControls(); } });
    onLive = () => { panel.paint(); paintControls(); };
    return h('div', { class: 'onb-page setup-page wide setup-claude-page' }, ...head(L('Conecte o Claude Desktop'), L('O Claude precisa de cinco ajustes para usar outros modelos. Deixe o Rotaz fazer tudo com um clique, ou siga o passo a passo com as telas do seu sistema.')), panel);
  };

  // ---- 2. conta ou chave ----
  const pagePath = () => {
    const card = (id) => {
      const p = PATHS[id];
      return h('button', { type: 'button', class: 'path-card', 'aria-pressed': String(st.path === id), onclick: () => { st.path = id; st.preset = null; st.more = false; st.query = ''; go(2); } },
        h('span', { class: 'path-logos' }, p.logos.map((x) => providerIcon(x, 'md'))),
        h('span', { class: 'path-title' }, icon(p.icon, 'lg'), p.title, p.tag && badge(p.tag, 'accent')),
        h('span', { class: 'path-text' }, p.text),
        h('span', { class: 'path-go' }, L('Ver provedores'), icon('arrow-right')));
    };
    const help = h('div', { class: 'path-help' }, icon('info'),
      h('div', {},
        h('b', {}, L('Não sabe qual escolher?')),
        h('p', {}, L('Conta é como entrar no site do serviço: você faz login e o Rotaz guarda o acesso, sem copiar nada.')),
        h('p', {}, L('Chave de API é um código que o provedor gera no site dele. Você copia de lá e cola aqui; o Rotaz mostra onde pegar.'))));
    const catalog = provOnly && h('button', { type: 'button', class: 'btn ghost path-catalog', onclick: () => { close(); location.hash = '#/providers/new'; } }, L('Já sei o que quero: abrir o catálogo completo'), icon('arrow-right'));
    return h('div', { class: 'onb-page setup-page wide' },
      ...head(provOnly ? L('Como você quer conectar?') : L('De onde vêm os modelos?'), provOnly ? L('Escolha o jeito mais fácil para você. Os dois funcionam igual depois de conectados.') : L('O Claude continua o mesmo; muda quem responde. Escolha como você quer conectar o primeiro provedor.')),
      h('div', { class: 'path-grid' }, card('account'), card('key')), help, catalog);
  };

  // ---- 3. provedor: lista e, ao escolher, o login ou a chave ali mesmo ----
  const pageProvider = () => {
    const P = PATHS[st.path];
    if (st.preset) return st.path === 'account' ? accountView(st.preset) : keyView(st.preset);
    const input = h('input', { type: 'search', value: st.query, placeholder: L('Buscar provedor'), 'aria-label': L('Buscar provedor') });
    const grid = h('div', { class: 'pgrid setup-grid' });
    const more = h('div', { class: 'setup-more' });
    const addedIds = new Set(added.map((p) => presetOf(p)?.id).filter(Boolean));
    const tile = (p) => h('button', { type: 'button', class: 'pcard', onclick: () => { st.preset = p; render(); } },
      providerIcon(p, 'lg'), h('span', { class: 'pcard-text' }, h('span', { class: 'pcard-name' }, p.name)),
      p.paid && !addedIds.has(p.id) && h('span', { class: 'pcard-badge' }, badge(L('Plano pago'), 'warn', PAID_TEXT())),
      addedIds.has(p.id) && h('span', { class: 'pcard-badge' }, badge(L('Adicionado'), 'pos')));
    const draw = () => {
      const q = st.query.trim().toLowerCase();
      const list = q ? P.all.filter((p) => `${p.name} ${p.id}`.toLowerCase().includes(q)) : st.more ? P.all : P.featured;
      grid.replaceChildren(...(list.length ? list.map(tile) : [h('p', { class: 'muted setup-empty' }, L('Nada encontrado para "{0}".', st.query))]));
      const rest = P.all.length - P.featured.filter((p) => p.category !== 'custom').length;
      more.replaceChildren(...(!q && !st.more && rest > 0 ? [button(L('Ver mais provedores ({0})', rest), () => { st.more = true; draw(); enter(grid, '.pcard'); }, 'ghost', { icon: 'caret-down' })]
        : !q && st.more ? [button(L('Mostrar menos'), () => { st.more = false; draw(); }, 'ghost', { icon: 'caret-up' })] : []));
    };
    input.addEventListener('input', () => { st.query = input.value; draw(); });
    draw();
    return h('div', { class: 'onb-page setup-page wide' }, ...head(P.heading, st.path === 'account' ? L('Clique no serviço onde você já tem conta. O login abre no navegador.') : L('Clique no provedor. Mostramos onde pegar a chave e você cola aqui.')),
      h('div', { class: 'search setup-search' }, icon('magnifying-glass'), input), grid, more);
  };

  const providerHead = (p) => h('div', { class: 'setup-prov' }, providerIcon(p, 'xl'),
    h('div', { class: 'setup-prov-text' }, h('h2', { class: 'onb-title' }, p.name), p.note && h('p', { class: 'onb-text' }, p.note)));
  const chooseOther = () => button(L('Escolher outro'), () => { stopLogin(); st.preset = null; render(); }, 'ghost', { icon: 'caret-left' });

  // garante o provedor cadastrado (sem duplicar) e devolve o id
  const ensureProvider = async (p, extra = {}) => {
    const have = added.find((x) => presetOf(x)?.id === p.id);
    if (have && !extra.keys) return have;
    const body = { name: p.name, type: p.type, ...(p.type === 'oauth' && { oauth: p.oauth }), baseUrl: p.baseUrl, authScheme: p.authScheme ?? (p.type === 'anthropic' ? 'x-api-key' : 'bearer'),
      priority: 10, rpm: p.rpm ?? 0, allowPrivateNetwork: !!p.allowPrivateNetwork, presetId: p.category === 'custom' ? null : p.id, ...extra };
    const { id } = await api('POST', '/api/providers', body);
    const made = { ...body, id };
    added.push(made);
    return made;
  };

  const accountView = (p) => {
    const line = h('div', { class: 'setup-wait', role: 'status' });
    const codeBox = h('div', { class: 'setup-code' });
    const go1 = button(L('Entrar com {0}', p.name), () => start(), 'primary lg', { icon: 'arrow-square-out' });
    const start = async () => {
      go1.disabled = true;
      line.replaceChildren(icon('circle-notch', 'spinner'), h('span', {}, L('Abrindo o login…')));
      try {
        if (p.needsHost) throw new Error(L('Este provedor precisa do endereço da sua empresa. Configure em Provedores, depois desta etapa.'));
        const prov = await ensureProvider(p);
        const isGoogle = prov.type === 'antigravity';
        const base = isGoogle ? 'antigravity' : 'account';
        const begin = await api('POST', `/api/oauth/${base}/begin?provider=${encodeURIComponent(prov.id)}`, {});
        const device = begin.kind === 'device';
        const open = () => window.open(begin.url, desk || device ? '_blank' : 'rotaz-oauth', desk || device ? undefined : 'popup,width=560,height=720');
        open();
        codeBox.replaceChildren(...(device && begin.userCode ? [h('span', { class: 'small' }, L('Na página que abriu, digite este código:')), h('code', { class: 'setup-usercode' }, begin.userCode),
          button(L('Copiar'), async () => { await navigator.clipboard.writeText(begin.userCode); toast(L('Copiado')); }, 'ghost sm', { icon: 'copy' })] : []));
        line.replaceChildren(icon('circle-notch', 'spinner'), h('span', {}, L('Aguardando a autorização em {0}…', p.name)), button(L('Abrir de novo'), open, 'ghost sm', { icon: 'arrow-square-out' }));
        let timer = null, alive = true;
        const started = Date.now();
        stopLogin = () => { alive = false; clearTimeout(timer); };
        const check = async () => {
          if (!alive) return;
          let s;
          try { s = await api('GET', `/api/oauth/${base}/status?provider=${encodeURIComponent(prov.id)}&state=${encodeURIComponent(begin.state)}`); } catch { s = { status: 'pending' }; }
          if (!alive) return;
          if (s.status === 'ok') {
            stopLogin();
            st.providerId = prov.id; st.providerName = s.email ? `${p.name} (${s.email})` : p.name;
            go(3);
            return;
          }
          if (s.status === 'error' || s.status === 'expired' || Date.now() - started > 600000) {
            stopLogin();
            line.replaceChildren(icon('warning-circle'), h('span', { class: 'form-error' }, s.message || L('Login não concluído.')));
            go1.disabled = false;
            return;
          }
          timer = setTimeout(check, 1500);
        };
        timer = setTimeout(check, 1500);
      } catch (e) {
        line.replaceChildren(icon('warning-circle'), h('span', { class: 'form-error' }, e.message));
        go1.disabled = false;
      }
    };
    return h('div', { class: 'onb-page setup-page' }, providerHead(p),
      p.paid && notice(PAID_TEXT(), 'warn', L('Precisa de plano pago ativo')),
      p.risk && notice(p.risk, 'warn', L('Atenção aos termos de uso')),
      h('div', { class: 'setup-cta' }, go1, line, codeBox), chooseOther());
  };

  const keyView = (p) => {
    const isCustom = p.category === 'custom';
    const key = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: L('Cole a chave de API'), 'aria-label': L('Chave de API') });
    const url = isCustom ? h('input', { type: 'url', spellcheck: 'false', placeholder: 'https://api.exemplo.com/v1', 'aria-label': L('URL base') }) : null;
    const err = h('div', { class: 'form-error', role: 'alert' });
    const save = button(L('Conectar'), async () => {
      err.textContent = '';
      if (isCustom && !/^https?:\/\//.test(url.value.trim())) { err.textContent = L('Informe a URL base, começando com http:// ou https://.'); url.focus(); return; }
      if (!key.value.trim() && p.authScheme !== 'none') { err.textContent = L('Cole a chave de API.'); key.focus(); return; }
      save.disabled = true;
      try {
        const prov = await ensureProvider(isCustom ? { ...p, name: new URL(url.value.trim()).host, baseUrl: url.value.trim() } : p,
          key.value.trim() ? { keys: [{ label: L('Principal'), key: key.value.trim() }] } : {});
        key.value = '';
        st.providerId = prov.id; st.providerName = prov.name;
        go(3);
      } catch (e) { err.textContent = e.message; save.disabled = false; }
    }, 'primary lg', { icon: 'plug' });
    const form = h('form', { class: 'setup-form', onsubmit: (e) => { e.preventDefault(); save.click(); } },
      p.keyUrl && h('div', { class: 'setup-hint' }, h('span', {}, L('Ainda não tem a chave? Ela é gerada no site do provedor.')),
        h('a', { class: 'btn', href: p.keyUrl, target: '_blank', rel: 'noopener noreferrer' }, L('Obter chave de API'), icon('arrow-square-out'))),
      url && field(L('URL base'), url, L('O endereço do serviço, compatível com OpenAI.')),
      p.authScheme !== 'none' && field(L('Chave de API'), key, L('Cifrada antes de ir para o disco. O navegador nunca mais a recebe.')),
      err, save);
    requestAnimationFrame(() => (url ?? key).focus());
    return h('div', { class: 'onb-page setup-page' }, providerHead(p), form, chooseOther());
  };

  // ---- 4. pronto: o resumo e o último passo, fechar e abrir o Claude (conferido ao vivo quando dá) ----
  const pageDone = () => {
    const prov = st.providerId && added.find((x) => x.id === st.providerId);
    const summary = h('ol', { class: 'tut-steps setup-summary' });
    const row = (on, title, sub) => h('li', { class: on ? 'done' : '' }, h('span', { class: 'tut-mark' }, icon(on ? 'check' : 'minus')), h('span', { class: 'tut-txt' }, h('span', {}, title), sub && h('span', { class: 'tut-path' }, sub)));
    const paintDone = () => {
      const ok = !!cd?.ok;
      const reopened = ok && claudeReopen(cd) === 'reopened';
      summary.replaceChildren(...[
        !provOnly && row(ok, L('Claude Desktop configurado'), ok ? L('Os cinco ajustes estão gravados no Claude.') : L('Pulado. Dá para fazer depois pelo aviso da visão geral.')),
        row(!!prov, prov ? L('{0} conectado', st.providerName) : L('Nenhum provedor ainda'), prov ? L('Conta ou chave guardada e cifrada nesta máquina.') : null),
        !provOnly && ok && row(reopened, reopened ? L('Claude reaberto com a configuração nova') : L('Feche e abra o Claude Desktop'),
          reopened ? L('Tudo certo: ele já lê o Rotaz.')
            : cd.running === false ? L('O Claude está fechado. Abra quando terminar aqui.')
              : L('Ele só lê a configuração ao abrir. Saia pelo ícone perto do relógio (botão direito, Sair) e abra de novo. Fechar a janela não basta.'))].filter(Boolean)); // replaceChildren escreveria "false" como texto
    };
    paintDone();
    onLive = paintDone;
    return h('div', { class: 'onb-page setup-page' },
      h('div', { class: 'onb-art setup-done-art' }, h('span', { class: 'setup-done-chain' },
        providerIcon({ icon: 'anthropic', name: 'Claude' }, 'lg'), icon('arrow-right'), h('span', { class: 'picon lg setup-rotaz' }, wordmark('wm-sm')), icon('arrow-right'),
        prov ? providerIcon(prov, 'lg') : h('span', { class: 'picon lg mono-icon' }, '?'))),
      ...head(prov ? (provOnly ? L('Provedor conectado') : L('Tudo pronto')) : L('Quase lá'), prov ? L('Falta só escolher quais modelos de {0} aparecem no Claude.', st.providerName) : L('Você pode conectar um provedor quando quiser, em Provedores.')),
      summary);
  };

  const PAGE = [pageClaude, pagePath, pageProvider, pageDone];
  function paintControls() {
    dots.forEach((d, i) => d.setAttribute('aria-current', i === st.step ? 'step' : 'false'));
    stepTxt.textContent = provOnly ? L('Etapa {0} de {1}', st.step, STEPS.length - 1) : L('Etapa {0} de {1}', st.step + 1, STEPS.length);
    back.hidden = st.step === (provOnly ? 1 : 0) || st.step === 3;
    next.hidden = provOnly && st.step < 3;
    const claudeOk = !!cd?.ok;
    if (st.step === 0) { next.textContent = claudeOk ? L('Continuar') : L('Pular esta etapa'); next.className = `btn lg onb-next${claudeOk ? ' primary' : ''}`; }
    else if (st.step === 1 || st.step === 2) { next.textContent = L('Pular esta etapa'); next.className = 'btn lg onb-next'; }
    else { next.textContent = st.providerId ? L('Escolher modelos') : L('Ir para o painel'); next.className = 'btn primary lg onb-next'; }
    later.hidden = st.step === 3;
  }
  function onNext() {
    if (st.step === 0) return go(1);
    // pular "De onde vêm os modelos?" é pular o provedor: sem conta nem chave escolhida, a lista não tem o que mostrar
    if (st.step === 1 || st.step === 2) return go(3);
    close(st.providerId);
  }
  function render(dir = 1) {
    onLive = () => {};
    const el = PAGE[st.step]();
    body.replaceChildren(el);
    // uma etapa anterior pode ter deixado algum contêiner rolado (um passo aberto no manual): tudo volta ao topo
    layer.scrollTop = 0;
    onb.scrollTop = 0;
    paintControls();
    if (!reduced() && M) M.animate([...el.children], { opacity: [0, 1], transform: [`translateX(${28 * dir}px)`, 'translateX(0)'] }, { duration: 0.5, ease: EASE, delay: M.stagger(0.06) });
    body.scrollTop = 0;
  }
  let busy = false;
  async function go(i) {
    if (busy || i < 0 || i >= STEPS.length) return;
    busy = true;
    stopLogin();
    const dir = i >= st.step ? 1 : -1;
    const old = body.firstElementChild;
    const out = animate(old, { opacity: [1, 0], transform: ['translateX(0)', `translateX(${-24 * dir}px)`] }, { duration: 0.22, ease: [0.4, 0, 1, 1] });
    try {
      if (out) await out.finished;
      if (i === 1) st.preset = null;
      if (i === 2 && !PATHS[st.path]) i = 1; // a lista de provedores só existe depois de escolher conta ou chave
      st.step = i;
      render(dir);
    } catch (e) {
      // nunca deixar o guia vazio e travado: a etapa anterior volta à tela e o erro aparece
      if (old) { old.style.opacity = ''; old.style.transform = ''; if (!old.isConnected) body.replaceChildren(old); }
      fail(e);
    } finally { busy = false; }
  }
  function close(providerId) {
    stopLogin();
    clearInterval(live);
    removeEventListener('keydown', keys, true);
    const end = () => {
      layer.remove(); root.inert = false;
      if (providerId) { state.provider = providerId; state.openImportFor = providerId; location.hash = '#/providers'; if (state.view === 'providers') route(); }
      else route();
    };
    const a = animate(layer, { opacity: [1, 0], transform: ['scale(1)', 'scale(1.01)'] }, { duration: 0.4 });
    if (a) a.finished.then(end); else end();
  }
  function keys(e) {
    if (e.key === 'Escape' && !document.querySelector('dialog[open]')) { e.preventDefault(); close(); }
  }
  addEventListener('keydown', keys, true);
  render();
  ready = true;
}

/** Começar (menu): abre a configuração guiada por cima da visão geral. */
async function start(sheet) {
  history.replaceState(null, '', '#/overview');
  state.view = 'overview';
  paintNav();
  setTitle(L(VIEW_LABEL.overview));
  // O guia abre antes da visão geral: a camada entra na tela já neste quadro e o painel nunca aparece sozinho.
  const instant = !!state.firstRun;
  state.firstRun = false;
  setupFlow({ instant }).catch(fail);
  await overview(sheet);
}

const VIEWS = { overview, providers, routing, client, settings, logs, start };


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

  const pg = pager(layer, PAGES, {
    finalLabel: L('Começar'),
    onClose: () => { layer.remove(); root.inert = false; document.querySelector('#app input')?.focus(); },
  });

  // da saudação para a primeira página: a cena recua e some, as boas-vindas entram
  const leave = [animate(stage, { opacity: [1, 0], transform: ['scale(1)', 'scale(.97)'] }, { duration: 0.5 }), animate(foot, { opacity: [1, 0] }, { duration: 0.3 })];
  await Promise.all(leave.filter(Boolean).map((a) => a.finished));
  stage.remove(); foot.remove();
  pg.start();
}

/**
 * Páginas em sequência numa camada de tela cheia (boas-vindas e novidades): arte, título e texto centrados; pontos
 * e botões embaixo; Pular no canto. Uma página pode ter `play(el)`, a animação da arte depois que ela entra.
 */
function pager(layer, PAGES, { finalLabel, onClose }) {
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
    next.textContent = index === PAGES.length - 1 ? finalLabel : L('Continuar');
  };
  // entrada da página: arte, título e texto chegam do lado da navegação, escalonados; a arte ainda sobe por dentro
  const enterPage = (el, dir) => {
    const play = PAGES[index].play;
    if (reduced() || !M) return;
    M.animate([...el.children], { opacity: [0, 1], transform: [`translateX(${36 * dir}px)`, 'translateX(0)'] }, { duration: 0.6, ease: EASE, delay: M.stagger(0.07) });
    if (play) { play(el.querySelector('.onb-art')); return; }
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
    const a = animate(layer, { opacity: [1, 0], transform: ['scale(1)', 'scale(1.01)'] }, { duration: 0.6 });
    if (a) a.finished.then(onClose); else onClose();
  }
  function keys(e) {
    if (e.key === 'ArrowRight') { e.preventDefault(); go(index + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(index - 1); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  }
  return {
    start() {
      const first = page(0);
      body.append(first);
      paintControls();
      layer.append(onb);
      addEventListener('keydown', keys, true);
      animate(onb.querySelector('.onb-foot'), { opacity: [0, 1], transform: ['translateY(8px)', 'translateY(0)'] }, { duration: 0.6, delay: 0.25 });
      enterPage(first, 1);
      next.focus();
    },
  };
}

// ---------- novidades da versão ----------
/** Anima as peças da arte em sequência: cada uma entra depois da anterior. */
const inTurn = (els, keyframes, { at = 0.3, gap = 0.2, duration = 0.45 } = {}) => {
  if (!els.length || reduced() || !M) return null;
  return M.animate([...els], keyframes, { duration, ease: EASE, delay: M.stagger(gap, { startDelay: at }) });
};

/**
 * Páginas de novidades por versão, mostradas uma vez depois de atualizar. Cada uma tem uma cena curta (só
 * `transform` e `opacity`, sem repetir) que mostra a novidade acontecendo; com movimento reduzido, a cena aparece pronta.
 */
const NEWS = {
  '1.2.0': () => {
    const P = (icon, name) => providerIcon({ icon, name }, 'lg');
    return [
      { title: L('Claude Desktop pronto em um clique'),
        text: L('O Rotaz liga o modo de desenvolvedor, aponta o Claude Desktop para o gateway e confere cada ajuste ao vivo. No fim, é só fechar e abrir o Claude.'),
        art: () => h('div', { class: 'wn-card' }, [L('Modo de desenvolvedor'), L('Inferência de terceiros'), L('Endereço e chave do Rotaz'), L('Descoberta de modelos'), L('Catálogo de modelos')]
          .map((t) => h('div', { class: 'wn-row' }, h('span', { class: 'wn-mark' }, icon('check')), h('span', {}, t)))),
        play: (art) => {
          inTurn(art.querySelectorAll('.wn-row'), { opacity: [0.35, 1] }, { at: 0.35, gap: 0.28, duration: 0.3 });
          inTurn(art.querySelectorAll('.wn-mark'), { opacity: [0, 1], transform: ['scale(.4)', 'scale(1)'] }, { at: 0.45, gap: 0.28, duration: 0.35 });
        } },
      { title: L('Entre com a sua conta'),
        text: L('GitHub Copilot, ChatGPT, Kimi, Cline, Google Antigravity e outros entram pelo login da própria conta, sem copiar chave de API. A lista de modelos vem junto.'),
        art: () => h('div', { class: 'wn-stack' },
          h('div', { class: 'onb-providers' }, P('github', 'GitHub'), P('openai', 'ChatGPT'), P('kimi', 'Kimi'), P('cline', 'Cline'), P('gemini', 'Google')),
          h('span', { class: 'wn-tag' }, icon('key'), L('Sem chave de API'))),
        play: (art) => {
          inTurn(art.querySelectorAll('.picon'), { opacity: [0, 1], transform: ['translateY(16px) scale(.9)', 'translateY(0) scale(1)'] }, { at: 0.25, gap: 0.12, duration: 0.5 });
          inTurn(art.querySelectorAll('.wn-tag'), { opacity: [0, 1], transform: ['translateY(8px)', 'translateY(0)'] }, { at: 1.1 });
        } },
      { title: L('Importe e teste tudo de uma vez'),
        text: L('Traga a lista de modelos do provedor, teste todos juntos e adicione só os que respondem. Quando o Google trava uma conta ou um modelo fica fora do plano, o Rotaz diz o que fazer.'),
        art: () => h('div', { class: 'wn-card' }, ['claude-gemini-flash', 'claude-deepseek', 'claude-kimi'].map((alias, i) => h('div', { class: 'wn-row wn-test' },
          h('code', {}, alias),
          h('span', { class: 'wn-badges' }, h('span', { class: 'badge' }, L('Testando')), h('span', { class: 'badge pos' }, L('Responde · {0} ms', 640 + i * 170)))))),
        play: (art) => {
          const rows = [...art.querySelectorAll('.wn-badges')];
          inTurn(rows.map((r) => r.firstElementChild), { opacity: [1, 0] }, { at: 0.7, gap: 0.45, duration: 0.25 });
          inTurn(rows.map((r) => r.lastElementChild), { opacity: [0, 1], transform: ['scale(.9)', 'scale(1)'] }, { at: 0.8, gap: 0.45, duration: 0.35 });
        } },
      { title: L('Um Rotaz por vez'),
        text: L('Abrir um segundo Rotaz não briga mais pela mesma porta: ele avisa e traz a janela do que já está aberto. O instalador agora tem etapas, com licença e escolha da pasta.'),
        art: () => h('div', { class: 'wn-windows' },
          h('div', { class: 'wn-win a' }, h('div', { class: 'wn-bar' }, wordmark('wn-logo')), h('span', { class: 'wn-line' }), h('span', { class: 'wn-line short' })),
          h('div', { class: 'wn-win b' }, h('div', { class: 'wn-bar' }, wordmark('wn-logo')), h('span', { class: 'wn-lock' }, icon('lock-simple')))),
        play: (art) => {
          if (reduced() || !M) return;
          const [a, b] = art.querySelectorAll('.wn-win');
          M.animate(a, { opacity: [0, 1], transform: ['scale(.96)', 'scale(1)'] }, { duration: 0.45, ease: EASE, delay: 0.2 });
          M.animate(b, { opacity: [0, 1, 1, 0.45], transform: ['translateX(48px)', 'translateX(0)', 'translateX(0)', 'translateX(12px)'] }, { duration: 1.6, ease: EASE, delay: 0.6, times: [0, 0.3, 0.6, 1] });
          M.animate(art.querySelector('.wn-lock'), { opacity: [0, 1], transform: ['scale(.5)', 'scale(1)'] }, { duration: 0.4, ease: EASE, delay: 1.5 });
        } },
    ];
  },
};

/** Depois de atualizar, as novidades da versão aparecem uma vez, por cima do painel. */
async function whatsNew(version) {
  const pages = NEWS[version]?.();
  if (!pages?.length || document.querySelector('.splash')) return; // abertura ou atualização obrigatória na tela
  const layer = h('div', { class: 'splash news', role: 'dialog', 'aria-modal': 'true', 'aria-label': L('Novidades do Rotaz {0}', version) });
  document.body.append(layer);
  root.inert = true;
  api('PUT', '/api/ui', { seenVersion: version }).catch(() => {});
  pages[0] = { ...pages[0], title: h('span', {}, h('span', { class: 'wn-kicker' }, L('Novidades do Rotaz {0}', version)), pages[0].title) };
  pager(layer, pages, { finalLabel: L('Começar a usar'), onClose: () => { layer.remove(); root.inert = false; } }).start();
}

// ---------- atualização obrigatória ----------
/**
 * No app instalado, uma versão nova trava o painel até atualizar. No Windows o app baixa sozinho e o botão reinicia
 * já na versão nova; no macOS e no Linux o botão baixa o instalador. O gateway continua atendendo até reiniciar.
 * Com as atualizações desligadas em Configurações o Rotaz nem consulta, então nada aparece.
 */
let gate = null;
function updateGate(u) {
  const due = !!desk && u?.enabled && !!u.version && (u.mode === 'auto' ? ['downloading', 'ready'].includes(u.status) : u.status === 'available');
  if (!due) return;
  if (!gate) {
    const g = { title: h('h2', { class: 'onb-title' }), text: h('p', { class: 'onb-text' }), bar: h('div', { class: 'gate-meter' }), status: h('p', { class: 'small muted' }), act: h('div', { class: 'gate-act' }), key: '' };
    const card = h('div', { class: 'gate-card' }, h('span', { class: 'gate-ico' }, icon('arrows-clockwise')), g.title, g.text, g.bar, g.status, g.act);
    g.layer = h('div', { class: 'splash upd-gate', role: 'alertdialog', 'aria-modal': 'true' }, h('div', { class: 'gate' }, card));
    document.querySelector('.splash.news')?.remove(); // a atualização vem antes das novidades
    document.body.append(g.layer);
    root.inert = true;
    animate(card, { opacity: [0, 1], transform: ['scale(.98)', 'scale(1)'] }, { duration: 0.32 });
    gate = g;
  }
  const ready = u.mode === 'auto' && u.status === 'ready';
  gate.layer.setAttribute('aria-label', L('Atualização obrigatória'));
  gate.title.textContent = L('Atualize o Rotaz para continuar');
  gate.text.textContent = L('A versão {0} está disponível e a atualização é obrigatória. Provedores, modelos, chaves e configurações continuam do jeito que estão.', u.version);
  gate.bar.replaceChildren(...(u.mode === 'auto' && !ready ? [meter(u.percent ?? 0)] : []));
  gate.status.textContent = u.mode !== 'auto' ? L('Baixe o instalador e instale por cima. Os seus dados ficam.')
    : ready ? L('Pronto. O Rotaz fecha, instala e abre de novo em alguns segundos.') : L('Baixando a versão nova: {0}%', u.percent ?? 0);
  const key = `${u.mode}:${ready}`;
  if (gate.key === key) return;
  gate.key = key;
  const act = u.mode === 'auto'
    ? button(L('Reiniciar e atualizar'), () => desk.updateAction('install'), 'primary lg', { disabled: !ready, icon: 'arrows-clockwise' })
    : button(L('Baixar a versão {0}', u.version), () => openLink(u.url), 'primary lg', { icon: 'download-simple' });
  gate.act.replaceChildren(act);
  if (ready || u.mode !== 'auto') act.focus();
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
  setupHealth().catch(() => {});
  loadUpdate().catch(() => {});
  route();
  if (s.news) whatsNew(s.news);
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
