// Claude Desktop em um clique: grava uma configuração "Rotaz" na biblioteca de inferência de terceiros
// do app (pasta Claude-3p/configLibrary), marca-a como a aplicada e põe o app no modo de terceiros.
//
// Formato observado no app 5.11492 (Windows):
//   Claude-3p/configLibrary/_meta.json        { appliedId, entries: [{ id, name }] }
//   Claude-3p/configLibrary/<id>.json         { inferenceProvider: 'gateway', inferenceGatewayBaseUrl, ... }
//   Claude/claude_desktop_config.json         { deploymentMode: '3p' | '1p', ... } (escolhe o modo ao abrir)
//   Claude/developer_settings.json            { allowDevTools: true } (o "modo de desenvolvedor" do menu Ajuda)
// Os arquivos do usuário nunca são substituídos às cegas: lemos, mesclamos e guardamos o estado anterior
// (entrada aplicada e modo) para o botão Desfazer.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

export const ENTRY_NAME = 'Rotaz';

/** Funcionalidades ligadas junto com o gateway. Todas existem no painel "Configure third-party inference" do app. */
export const FEATURES = {
  modelDiscoveryEnabled: true, // os modelos do Rotaz aparecem no seletor ("Descoberta de modelos")
  modelCatalogEnabled: true, // nomes, descrições e limites certos no seletor ("Metadados do catálogo de modelos")
  modelPrefer1mContext: true, // janela de 1 milhão quando o modelo aguenta
  toolSearchEnabled: true, // ferramentas carregadas sob demanda
  builtinBrowserEnabled: true, // navegador embutido
};

/** Pastas do app: CLAUDE_HOME (testes) ou as do sistema. Lidas a cada chamada, para os testes trocarem o ambiente. */
function roots() {
  const home = process.env.ROTAZ_CLAUDE_HOME;
  if (home) return { app: path.join(home, 'Claude'), thirdParty: [path.join(home, 'Claude-3p')] };
  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    // Versões novas guardam os dados de terceiros em Local; as antigas, em Roaming.
    return { app: path.join(roaming, 'Claude'), thirdParty: [path.join(local, 'Claude-3p'), path.join(roaming, 'Claude-3p')] };
  }
  const base = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  return { app: path.join(base, 'Claude'), thirdParty: [path.join(base, 'Claude-3p')] };
}

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
/** Grava por arquivo temporário e troca de nome: o app nunca lê um JSON pela metade. */
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/** Bibliotecas existentes; sem nenhuma, a primeira da lista (onde o app vai procurar). */
function libraries() {
  const r = roots();
  const found = r.thirdParty.filter((d) => fs.existsSync(d));
  return (found.length ? found : r.thirdParty.slice(0, 1)).map((d) => path.join(d, 'configLibrary'));
}

/**
 * Arquivos do modo de desenvolvedor. O Claude lê developer_settings.json da pasta de dados do modo em uso:
 * Claude/ no modo da conta claude.ai e Claude-3p/ no modo de terceiros. Por isso o modo ligado só em Claude/
 * some depois que o app reinicia no modo de terceiros (comportamento descrito na documentação dele).
 */
function devFiles() {
  const r = roots();
  const found = r.thirdParty.filter((d) => fs.existsSync(d));
  return { app: path.join(r.app, 'developer_settings.json'), thirdParty: (found.length ? found : r.thirdParty.slice(0, 1)).map((d) => path.join(d, 'developer_settings.json')) };
}
/** Chave que o próprio Claude selou (cifrada para este usuário do sistema): não dá para comparar, só reconhecer. */
const SEALED = '__sealed__:v1:';
const isSealed = (v) => typeof v === 'string' && v.trimStart().startsWith(SEALED);

const installed = () => { const r = roots(); return fs.existsSync(r.app) || r.thirdParty.some((d) => fs.existsSync(d)); };
const ourEntry = (meta) => (Array.isArray(meta?.entries) ? meta.entries.find((e) => e?.name === ENTRY_NAME && /^[\w-]{8,64}$/.test(String(e.id))) : null);

/** Quando o Rotaz gravou pela última vez nos arquivos do Claude (o próprio app também grava neles, então a data do arquivo não serve). */
const stampFile = (dataDir) => path.join(dataDir, 'claude-desktop-written.json');
const writtenAt = (dataDir) => Number(readJson(stampFile(dataDir), {})?.at) || 0;

/** A pessoa diz que já fechou e abriu o Claude (onde o Rotaz não consegue conferir sozinho). */
export function acknowledgeReopen(cfg) {
  writeJson(stampFile(cfg.dataDir), { ...readJson(stampFile(cfg.dataDir), {}), reopenedAt: Date.now() });
  return status(cfg);
}

/**
 * Claude Desktop aberto? Devolve a hora em que o processo principal começou (ms), 0 se fechado, null se não dá para saber.
 * Consulta em segundo plano e guarda por alguns segundos: o status continua instantâneo para o painel.
 * Só o app de desktop conta (pastas WindowsApps/Claude_* ou AnthropicClaude); o claude.exe do Claude Code no terminal, não.
 */
const proc = { at: 0, since: null, busy: false, pending: null };
const probes = () => !process.env.ROTAZ_CLAUDE_HOME && process.platform === 'win32';
function claudeStarted() {
  if (!probes()) return null;
  if (!proc.busy && Date.now() - proc.at > 4000) {
    proc.busy = true;
    let done;
    proc.pending = new Promise((r) => { done = r; });
    const ps = "Get-Process -Name claude -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*WindowsApps*Claude_*' -or $_.Path -like '*AnthropicClaude*' } | ForEach-Object { [DateTimeOffset]::new($_.StartTime).ToUnixTimeMilliseconds() }";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 8000, windowsHide: true }, (err, out) => {
      proc.busy = false;
      proc.at = Date.now();
      if (err) proc.since = null;
      else { const t = String(out).split(/\s+/).map(Number).filter((n) => n > 0); proc.since = t.length ? Math.min(...t) : 0; }
      done();
    });
  }
  return proc.since;
}

/**
 * Espera a primeira consulta ao processo do Claude (no máximo `maxMs`). Sem ela, o primeiro estado diria "não sei
 * se o Claude precisa ser reaberto" e a visão geral mostraria o passo pendente por um instante, até a resposta chegar.
 * Depois da primeira, devolve na hora: o resultado fica guardado e é renovado em segundo plano.
 */
export function probeReady(maxMs = 3000) {
  if (!probes()) return Promise.resolve();
  claudeStarted();
  if (proc.at) return Promise.resolve();
  return Promise.race([proc.pending, new Promise((r) => { setTimeout(r, maxMs).unref?.(); })]);
}

/**
 * Estado para o painel, item por item, na ordem em que a pessoa faria à mão:
 *   developer   modo de desenvolvedor (Ajuda > Solução de problemas)
 *   thirdParty  o app no modo de terceiros, com a configuração do Rotaz aplicada
 *   gateway     endereço, chave e esquema de autenticação deste gateway
 *   discovery   "Descoberta de modelos"; catalog: "Metadados do catálogo de modelos"
 * restart: o Claude está aberto desde antes da última gravação (precisa fechar e abrir); null quando não dá para saber.
 */
/**
 * O que faz o Claude usar o Rotaz. O modo de desenvolvedor fica de fora: ele só libera o menu para mexer à mão
 * na configuração, e o Claude usa a configuração gravada com ou sem ele.
 */
const FUNCTIONAL = ['thirdParty', 'gateway', 'discovery', 'catalog'];

export function status(cfg) {
  const libs = libraries();
  const r = roots();
  const appCfgFile = path.join(r.app, 'claude_desktop_config.json');
  const mode = readJson(appCfgFile, {})?.deploymentMode ?? null;
  let applied = false, present = false, current = false, entry = null;
  for (const lib of libs) {
    const meta = readJson(path.join(lib, '_meta.json'), null);
    const e = ourEntry(meta);
    if (!e) continue;
    present = true;
    const file = path.join(lib, `${e.id}.json`);
    const c = readJson(file, {});
    // Salvo pela janela do Claude, o token fica selado: vale o endereço, porque o conteúdo não dá para ler.
    const here = c.inferenceGatewayBaseUrl === cfg.baseUrl && (c.inferenceGatewayApiKey === cfg.token || isSealed(c.inferenceGatewayApiKey));
    if (here) current = true;
    // a entrada aplicada é a que vale; sem ela, a primeira encontrada
    if (meta.appliedId === e.id) { applied = true; entry = c; } else if (!entry) entry = c;
  }
  const df = devFiles();
  const devOn = (f) => readJson(f, {})?.allowDevTools === true;
  // vale o arquivo do modo em uso: no de terceiros, o de Claude-3p
  const developer = mode === '3p' ? df.thirdParty.some(devOn) : devOn(df.app);
  const scheme = entry?.inferenceGatewayAuthScheme ?? 'bearer';
  const checks = {
    developer,
    thirdParty: applied && mode === '3p',
    gateway: current && entry?.inferenceProvider === 'gateway' && (scheme === 'bearer' || scheme === 'x-api-key'),
    // o app trata a ausência como ligada (é o padrão dele); só "false" explícito desliga
    discovery: !!entry && entry.modelDiscoveryEnabled !== false,
    catalog: !!entry && entry.modelCatalogEnabled !== false,
  };
  const since = claudeStarted();
  const written = writtenAt(cfg.dataDir);
  // Sem como ver o processo (macOS, Linux), vale a confirmação da pessoa ("Já reabri") depois da última gravação.
  const ack = Number(readJson(stampFile(cfg.dataDir), {})?.reopenedAt) || 0;
  const restart = since === null ? (written > 0 && ack >= written ? false : null) : since > 0 && written > 0 && since < written;
  return { installed: installed(), present, applied: applied && mode === '3p', current, mode, developer, checks, ok: FUNCTIONAL.every((k) => checks[k]),
    running: since === null ? null : since > 0, restart, written, scheme, canUndo: !!readJson(backupFile(cfg.dataDir), null) };
}

const backupFile = (dataDir) => path.join(dataDir, 'claude-desktop-backup.json');

/** Grava a configuração do Rotaz, aplica e liga o modo de terceiros. Devolve o novo estado. */
export function apply(cfg, { activate = true } = {}) {
  const r = roots();
  const appCfgFile = path.join(r.app, 'claude_desktop_config.json');
  const appCfg = readJson(appCfgFile, {});
  // Estado anterior, para o Desfazer: só na primeira aplicação (reaplicar não apaga o original).
  const df = devFiles();
  const devPaths = [df.app, ...df.thirdParty];
  const backup = readJson(backupFile(cfg.dataDir), null) ?? { deploymentMode: appCfg.deploymentMode ?? null, applied: {}, dev: {} };
  backup.dev ??= {};
  for (const f of devPaths) if (!(f in backup.dev)) backup.dev[f] = readJson(f, {}).allowDevTools ?? null;
  for (const lib of libraries()) {
    const metaFile = path.join(lib, '_meta.json');
    const meta = readJson(metaFile, { entries: [] });
    if (!Array.isArray(meta.entries)) meta.entries = [];
    let e = ourEntry(meta);
    if (!e) { e = { id: crypto.randomUUID(), name: ENTRY_NAME }; meta.entries.push(e); }
    if (!(lib in backup.applied)) backup.applied[lib] = meta.appliedId === e.id ? null : (meta.appliedId ?? null);
    const file = path.join(lib, `${e.id}.json`);
    // Mescla: o que o usuário mudou à mão no app continua; endereço, token e as funcionalidades são do Rotaz.
    writeJson(file, {
      ...readJson(file, {}),
      ...(activate ? FEATURES : {}),
      inferenceProvider: 'gateway', inferenceCredentialKind: 'static', inferenceGatewayAuthScheme: 'bearer',
      inferenceGatewayBaseUrl: cfg.baseUrl, inferenceGatewayApiKey: cfg.token, deploymentDisplayName: ENTRY_NAME,
    });
    if (activate) meta.appliedId = e.id;
    writeJson(metaFile, meta);
  }
  writeJson(stampFile(cfg.dataDir), { at: Date.now() });
  if (activate) {
    writeJson(backupFile(cfg.dataDir), backup);
    if (appCfg.deploymentMode !== '3p') writeJson(appCfgFile, { ...appCfg, deploymentMode: '3p' });
    // Modo de desenvolvedor ligado, como quem segue os menus à mão: deixa o menu Desenvolvedor visível no app.
    // nas duas pastas: vale agora (modo da conta) e depois que o app reiniciar no modo de terceiros
    for (const f of devPaths) { const d = readJson(f, {}); if (d.allowDevTools !== true) writeJson(f, { ...d, allowDevTools: true }); }
  }
  return status(cfg);
}

/** Endereço ou token mudaram (porta, troca de token): atualiza a configuração do Rotaz se ela existir. */
export function refresh(cfg) {
  try { if (status(cfg).present) apply(cfg, { activate: false }); } catch { /* o app pode estar sem permissão; o painel mostra o estado */ }
}

/** Volta a configuração que estava aplicada antes e o modo anterior. A entrada do Rotaz fica na biblioteca, sem uso. */
export function undo(cfg) {
  const b = readJson(backupFile(cfg.dataDir), null);
  if (!b) return status(cfg);
  for (const [lib, prev] of Object.entries(b.applied ?? {})) {
    const metaFile = path.join(lib, '_meta.json');
    const meta = readJson(metaFile, null);
    if (!meta) continue;
    if (prev && meta.entries?.some((e) => e.id === prev)) meta.appliedId = prev; else delete meta.appliedId;
    writeJson(metaFile, meta);
  }
  const r = roots();
  const appCfgFile = path.join(r.app, 'claude_desktop_config.json');
  const appCfg = readJson(appCfgFile, null);
  if (appCfg) {
    if (b.deploymentMode) appCfg.deploymentMode = b.deploymentMode; else delete appCfg.deploymentMode;
    writeJson(appCfgFile, appCfg);
  }
  // backups antigos guardavam só o arquivo de Claude/
  const prevDev = b.dev ?? ('allowDevTools' in b ? { [path.join(r.app, 'developer_settings.json')]: b.allowDevTools } : {});
  for (const [f, prev] of Object.entries(prevDev)) {
    const d = readJson(f, null);
    if (!d) continue;
    if (prev === null || prev === undefined) delete d.allowDevTools; else d.allowDevTools = prev;
    if (Object.keys(d).length) writeJson(f, d); else fs.rmSync(f, { force: true });
  }
  fs.rmSync(backupFile(cfg.dataDir), { force: true });
  writeJson(stampFile(cfg.dataDir), { at: Date.now() });
  return status(cfg);
}
