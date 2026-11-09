// Rotaz desktop: o mesmo gateway e o mesmo painel da versão de terminal, empacotados com janela e bandeja.
// O servidor roda no processo principal; a janela só abre o painel em 127.0.0.1, sem acesso ao Node.
import { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, shell, dialog, safeStorage, Notification, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Empacotado, o servidor é copiado para ./server; em desenvolvimento, usa o repositório (pasta acima).
const serverRoot = app.isPackaged ? path.join(here, 'server') : path.join(here, '..');
const assets = path.join(here, 'assets');

if (process.env.ROTAZ_USER_DATA) app.setPath('userData', process.env.ROTAZ_USER_DATA); // isolamento em testes
const dataDir = process.env.ROTAZ_DATA ?? path.join(app.getPath('userData'), 'data');
const startHidden = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAsHidden;

let win = null;
let tray = null;
let gateway = null;      // instância própria do servidor
let panelUrl = null;     // URL do painel (própria ou de um Rotaz já rodando)
let quitting = false;
let i18n = null;        // src/i18n.js do servidor: mesmos dicionários do painel
/** Língua da bandeja e dos avisos: a escolhida no painel; no automático, a do sistema. */
const lang = () => (i18n ? i18n.resolveLang(gateway?.store.ui.lang ?? 'auto') : 'pt-BR');
/** Traduz um texto (com {0}, {1}… para os argumentos). Sem os dicionários carregados, fica em português. */
const T = (key, ...args) => (i18n ? i18n.tr(lang(), new i18n.LocalError(key, ...args)) : key.replace(/\{(\d+)\}/g, (m, i) => args[i] ?? m));

if (!app.requestSingleInstanceLock()) app.quit();
const APP_ID = 'dev.rotaz.app'; // = build.appId em package.json
if (process.platform === 'win32') app.setAppUserModelId(APP_ID); // identidade dos avisos no Windows

/**
 * O Windows só mostra um aviso (inclusive o balão da bandeja, que vira notificação no Windows 10 e 11)
 * se houver um atalho no menu Iniciar com o mesmo AppUserModelID do processo. Sem isso, descarta em
 * silêncio. Atualizações por cima de uma instalação antiga mantêm o atalho antigo, que pode ter outro
 * ID (ex.: electron.app.Rotaz): aqui o app confere e corrige o próprio atalho.
 */
function repairStartMenuShortcut() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Rotaz.lnk');
  try {
    if (!fs.existsSync(lnk)) return;
    const s = shell.readShortcutLink(lnk);
    if (path.basename(s.target).toLowerCase() !== 'rotaz.exe' || s.appUserModelId === APP_ID) return;
    shell.writeShortcutLink(lnk, 'update', { appUserModelId: APP_ID });
  } catch { /* atalho ilegível: os avisos podem não aparecer, mas o app segue */ }
}
app.on('second-instance', () => showWindow());

/**
 * Chave mestra. No Windows usa o DPAPI, como a versão de terminal (assim a pasta de dados é a mesma
 * para os dois). No macOS e no Linux, uma chave aleatória guardada pelo cofre do sistema (safeStorage).
 */
function prepareMasterKey() {
  if (process.platform === 'win32' || process.env.GATEWAY_MASTER_KEY) return undefined;
  if (!safeStorage.isEncryptionAvailable()) return undefined; // cai no arquivo 0600 da versão de terminal
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'master.safe');
  let key;
  if (fs.existsSync(file)) key = safeStorage.decryptString(fs.readFileSync(file));
  else {
    key = crypto.randomBytes(32).toString('base64');
    fs.writeFileSync(file, safeStorage.encryptString(key), { mode: 0o600 });
  }
  process.env.GATEWAY_MASTER_KEY = key; // só existe dentro deste processo
  return 'keychain';
}

const probe = (port) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
    let s = '';
    res.on('data', (c) => { s += c; });
    res.on('end', () => resolve(res.statusCode === 200 && s.includes('"ok"')));
  });
  req.on('error', () => resolve(false));
  req.on('timeout', () => { req.destroy(); resolve(false); });
});

async function startGateway() {
  const { createServer } = await import(pathToFileURL(path.join(serverRoot, 'src', 'index.js')).href);
  i18n = await import(pathToFileURL(path.join(serverRoot, 'src', 'i18n.js')).href);
  // "Automático" no app = idioma do sistema operacional, como o Windows ou o macOS informam
  if (!process.env.ROTAZ_LANG) process.env.ROTAZ_LANG = i18n.detect([...(app.getPreferredSystemLanguages?.() ?? []), app.getLocale()]);
  const { setAutoStartHandler } = await import(pathToFileURL(path.join(serverRoot, 'src', 'autostart.js')).href);
  setAutoStartHandler({
    label: 'Iniciar com o sistema',
    set: (enabled) => { app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true, args: ['--hidden'] }); buildTrayMenu(); },
  });
  const keySourceName = prepareMasterKey();
  const port = process.env.ROTAZ_PORT !== undefined ? Number(process.env.ROTAZ_PORT) : undefined;
  const instance = createServer({ dataDir, port, quiet: true, desktop: true, keySourceName });
  try {
    await instance.listen();
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    const p = instance.store.server.port;
    await instance.close();
    // Já existe um Rotaz (ex.: a versão de terminal) nesta porta: o app abre esse painel em vez de brigar por ela.
    if (await probe(p)) { panelUrl = `http://127.0.0.1:${p}/`; return; }
    throw new i18n.LocalError('A porta {0} está ocupada por outro programa. Feche-o ou troque a porta do Rotaz.', p);
  }
  gateway = instance;
  // Versões anteriores guardavam a ação ao fechar na configuração do gateway: migra uma vez.
  if (prefs.closeAction === undefined && ['tray', 'quit'].includes(instance.store.server.closeAction)) savePrefs({ closeAction: instance.store.server.closeAction });
  // Mudanças feitas pelo painel (ex.: iniciar com o sistema) refletem na hora no menu da bandeja.
  const update = instance.store.updateServer.bind(instance.store);
  instance.store.updateServer = (input) => { const r = update(input); buildTrayMenu(); return r; };
  // Trocar o idioma no painel traduz a bandeja na hora.
  const updateUi = instance.store.updateUi.bind(instance.store);
  instance.store.updateUi = (input) => { const r = updateUi(input); buildTrayMenu(); return r; };
  const { port: actual } = instance.store.server;
  panelUrl = `http://127.0.0.1:${actual}/`;
  // O registro de inicialização segue o que está salvo no painel.
  app.setLoginItemSettings({ openAtLogin: !!instance.store.server.autoStart, openAsHidden: true, args: ['--hidden'] });
}

function createWindow() {
  const mac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 980, minHeight: 640,
    title: 'Rotaz', show: false, autoHideMenuBar: true,
    // A barra de título é desenhada pelo painel. No macOS ficam os botões nativos, embutidos na barra.
    frame: mac,
    ...(mac && { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 13 } }),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#121110' : '#f3f1ec',
    icon: path.join(assets, 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, preload: path.join(here, 'preload.cjs') },
  });
  const sendMax = () => win.webContents.send('rotaz:maximized', win.isMaximized());
  win.on('maximize', sendMax);
  win.on('unmaximize', sendMax);
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]) : null);
  const origin = new URL(panelUrl).origin;
  // A janela só navega dentro do painel; links externos abrem no navegador padrão.
  win.webContents.on('will-navigate', (e, url) => { if (new URL(url).origin !== origin) { e.preventDefault(); openExternal(url); } });
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.on('close', (e) => {
    if (quitting) return;
    // O que fazer ao fechar é escolha do usuário (Configurações → Sistema e segurança).
    // Encerrar: o ícone da bandeja manteria o processo vivo sem janelas, então o app sai explicitamente
    // (will-quit fecha o gateway antes).
    // O quit é adiado: chamado dentro deste mesmo evento (já cancelado), o Electron entenderia que a
    // janela recusou fechar e abortaria o encerramento.
    if (closeAction() === 'quit') { e.preventDefault(); quitting = true; setImmediate(() => app.quit()); return; }
    e.preventDefault();
    win.hide();
    trayNotice();
  });
  win.once('ready-to-show', () => { if (!startHidden) showWindow(); });
  const first = gateway?.setupToken ? `#setup=${gateway.setupToken}` : '';
  win.loadURL(panelUrl + first);
}

// Controles da janela pedidos pela barra de título do painel. Só aceita a janela do app e o painel local.
const fromPanel = (e) => win && e.sender === win.webContents && panelUrl && new URL(e.senderFrame.url).origin === new URL(panelUrl).origin;
ipcMain.on('rotaz:window', (e, action) => {
  if (!fromPanel(e)) return;
  if (action === 'minimize') win.minimize();
  else if (action === 'toggle-maximize') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
  else if (action === 'close') win.close(); // o handler de close manda para a bandeja
});
ipcMain.handle('rotaz:is-maximized', (e) => (fromPanel(e) ? win.isMaximized() : false));

function openExternal(url) {
  try { if (/^https?:$/.test(new URL(url).protocol)) shell.openExternal(url); } catch { /* URL inválida: ignora */ }
}

// A janela abre sempre maximizada na primeira vez que aparece (também quando o app começou escondido na bandeja).
let shownOnce = false;
function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (!shownOnce) { shownOnce = true; win.maximize(); }
  win.show();
  win.focus();
}

/**
 * Preferências do próprio app (não do gateway): ficam em userData/desktop.json. Assim valem também quando
 * o app abre um Rotaz que já estava rodando, como a versão de terminal.
 */
const prefsFile = path.join(app.getPath('userData'), 'desktop.json');
let prefs = (() => {
  try { return JSON.parse(fs.readFileSync(prefsFile, 'utf8')) ?? {}; } catch { return {}; }
})();
function savePrefs(patch) {
  const next = { ...prefs, ...patch };
  fs.mkdirSync(path.dirname(prefsFile), { recursive: true });
  const tmp = `${prefsFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, prefsFile); // gravação atômica
  prefs = next;
  buildTrayMenu();
}
const closeAction = () => (prefs.closeAction === 'quit' ? 'quit' : 'tray');
function setCloseAction(value) {
  if (!['tray', 'quit'].includes(value)) throw new Error('Ação ao fechar inválida.');
  savePrefs({ closeAction: value });
}
// Abertura animada: só na primeira vez que o app abre. ROTAZ_SPLASH=always mostra sempre (para testar).
ipcMain.handle('rotaz:splash', (e, seen) => {
  if (!fromPanel(e)) throw new Error('Origem não autorizada.');
  if (seen === true) { savePrefs({ splashSeen: true }); return false; }
  return process.env.ROTAZ_SPLASH === 'always' || !prefs.splashSeen;
});
ipcMain.handle('rotaz:close-action', (e, value) => {
  if (!fromPanel(e)) throw new Error('Origem não autorizada.');
  if (value !== undefined) setCloseAction(value);
  return closeAction();
});

/**
 * Aviso que sai do ícone da bandeja ao fechar a janela: o app continua aberto e o gateway funcionando.
 * No Windows é o balão da própria bandeja; no macOS e no Linux, uma notificação do sistema.
 */
// O aviso é esporádico: no primeiro fechamento e depois no máximo uma vez a cada 7 dias.
// A data fica em desktop.json, então vale entre reinícios do app. ROTAZ_NOTICE_EVERY_MS ajusta o intervalo em testes.
const NOTICE_EVERY_MS = Number(process.env.ROTAZ_NOTICE_EVERY_MS) || 7 * 24 * 60 * 60 * 1000;
function trayNotice() {
  let last = Number(prefs.lastTrayNoticeAt) || 0;
  if (last > Date.now()) last = 0; // relógio ajustado para trás: não silencia o aviso para sempre
  if (Date.now() - last < NOTICE_EVERY_MS) { debug('aviso omitido: já mostrado recentemente'); return; }
  savePrefs({ lastTrayNoticeAt: Date.now() });
  const title = T('O Rotaz continua aberto');
  const content = gateway?.store.server.gatewayEnabled === false
    ? T('O app segue na bandeja, com o gateway desligado. Clique no ícone para abrir ou use Sair do Rotaz para encerrar.')
    : T('O gateway segue funcionando na bandeja. Clique no ícone para abrir ou use Sair do Rotaz para encerrar.');
  const icon = nativeImage.createFromPath(path.join(assets, 'icon.png'));
  const balloon = () => { if (process.platform === 'win32' && tray) tray.displayBalloon({ title, content, icon, largeIcon: false, noSound: true }); };
  if (!Notification.isSupported()) { debug('notificação não suportada: balão'); balloon(); return; }
  // Notificação nativa (no Windows, um aviso com o ícone e o nome do Rotaz). Se o sistema recusar, cai no balão.
  const n = new Notification({ title, body: content, icon, silent: true });
  n.on('show', () => debug('notificação exibida'));
  n.on('failed', (_e, err) => { debug(`notificação recusada: ${err}`); balloon(); });
  n.on('click', showWindow);
  n.show();
  debug(`notificação enviada (AUMID ${APP_ID})`);
}

// Diagnóstico dos avisos: ROTAZ_DEBUG_NOTICE=1 grava em userData/notice-debug.log. Sem dados sensíveis.
function debug(msg) {
  if (!process.env.ROTAZ_DEBUG_NOTICE) return;
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'notice-debug.log'), `${new Date().toISOString()} ${msg}\n`); } catch { /* ignora */ }
}

function buildTrayMenu() {
  if (!tray) return;
  const running = gateway ? T('Gateway ativo em {0}', new URL(panelUrl).host) : T('Conectado ao Rotaz em {0}', new URL(panelUrl).host);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: T('Abrir Rotaz'), click: showWindow },
    { label: running, enabled: false },
    { type: 'separator' },
    { label: T('Iniciar com o sistema'), type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, enabled: !!gateway,
      click: (item) => { gateway.store.updateServer({ autoStart: item.checked }); app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true, args: ['--hidden'] }); } },
    { label: T('Ao fechar a janela'), submenu: [
      { label: T('Manter na bandeja'), type: 'radio', checked: closeAction() === 'tray', click: () => setCloseAction('tray') },
      { label: T('Encerrar o Rotaz'), type: 'radio', checked: closeAction() === 'quit', click: () => setCloseAction('quit') },
    ] },
    { label: T('Abrir pasta de dados'), enabled: !!gateway, click: () => shell.openPath(dataDir) },
    { type: 'separator' },
    { label: T('Sair do Rotaz'), click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  const file = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  const img = nativeImage.createFromPath(path.join(assets, file));
  if (process.platform === 'darwin') img.setTemplateImage(true);
  tray = new Tray(img);
  tray.setToolTip('Rotaz');
  tray.on('click', showWindow);
  buildTrayMenu();
}

app.whenReady().then(async () => {
  repairStartMenuShortcut();
  try { await startGateway(); } catch (e) {
    dialog.showErrorBox(T('Rotaz não conseguiu iniciar'), i18n ? i18n.tr(lang(), e) : e.message);
    app.exit(1);
    return;
  }
  createTray();
  createWindow();
  app.on('activate', showWindow); // macOS: clique no ícone do Dock
});

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { /* continua na bandeja */ });
app.on('will-quit', async (e) => {
  if (!gateway) return;
  e.preventDefault();
  const g = gateway;
  gateway = null;
  try { await g.close(); } finally { app.exit(0); }
});
