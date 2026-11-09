// Inicialização automática.
// Modo terminal (Windows): um .vbs na pasta Inicializar, sem janela e sem privilégios elevados.
// App desktop: o próprio app registra um handler nativo (Windows e macOS) via setAutoStartHandler.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { K } from './i18n.js';

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js');
const startupDir = () => path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const startupFile = () => path.join(startupDir(), 'Rotaz.vbs');
const legacyFile = () => path.join(startupDir(), 'ClaudeProxyGateway.vbs'); // nome antigo do projeto

let handler = null;
/** O app desktop troca o mecanismo: { set(enabled), label }. */
export function setAutoStartHandler(h) { handler = h; }

export const autoStartSupported = () => !!handler || (process.platform === 'win32' && !!process.env.APPDATA);
export const autoStartLabel = () => handler?.label ?? K('Iniciar com o Windows');

/** Quem tinha a inicialização ligada com o nome antigo passa para o novo, sem mexer no painel. */
export function migrateAutoStart(enabled, dataDir) {
  if (handler || process.platform !== 'win32' || !process.env.APPDATA || !fs.existsSync(legacyFile())) return;
  fs.rmSync(legacyFile(), { force: true });
  if (enabled) setAutoStart(true, dataDir);
}

export function setAutoStart(enabled, dataDir) {
  if (handler) { handler.set(!!enabled); return; }
  const f = startupFile();
  fs.rmSync(legacyFile(), { force: true });
  if (!enabled) { fs.rmSync(f, { force: true }); return; }
  const q = (s) => `""${s}""`;
  const cmd = `${q(process.execPath)} ${q(ENTRY)} --data ${q(path.resolve(dataDir))}`;
  fs.writeFileSync(f, `CreateObject("WScript.Shell").Run "${cmd}", 0, False\r\n`);
}
