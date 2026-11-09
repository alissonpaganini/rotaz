// Log em arquivo com rotação simples. Toda linha passa pela redação de segredos.
import fs from 'node:fs';
import path from 'node:path';
import { redact } from './security.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const MAX = 5 * 1024 * 1024;

export function createLogger(dir, getLevel, { console: toConsole = true } = {}) {
  const file = path.join(dir, 'gateway.log');
  const open = () => fs.createWriteStream(file, { flags: 'a', mode: 0o600 }).on('error', () => { /* falha de log não derruba o gateway */ });
  let stream = open();
  let size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  const write = (level, msg) => {
    if (LEVELS[level] > LEVELS[getLevel()]) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${redact(msg)}\n`;
    if (toConsole) process.stdout.write(line);
    stream.write(line);
    size += line.length;
    if (size > MAX) {
      stream.end();
      try { fs.renameSync(file, `${file}.1`); } catch { /* arquivo em uso */ }
      stream = open();
      size = 0;
    }
  };
  return { file, close: () => new Promise((r) => stream.end(r)), error: (m) => write('error', m), warn: (m) => write('warn', m), info: (m) => write('info', m), debug: (m) => write('debug', m) };
}
