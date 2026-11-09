// Criptografia em repouso: AES-256-GCM com chave mestra de 32 bytes.
// A chave mestra vem, nesta ordem, de: GATEWAY_MASTER_KEY (env) -> DPAPI do Windows -> arquivo 0600.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PS = (script, input) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
  input, encoding: 'utf8', windowsHide: true, timeout: 30000,
});
const DPAPI = (op) => `Add-Type -AssemblyName System.Security; $i=[Console]::In.ReadToEnd().Trim(); ` +
  `[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${op}([Convert]::FromBase64String($i),$null,'CurrentUser'))`;

function dpapi(op, b64) {
  const r = PS(DPAPI(op), b64);
  if (r.status !== 0 || !r.stdout?.trim()) throw new Error(`DPAPI ${op} falhou`);
  return r.stdout.trim();
}

/** Resolve a chave mestra sem nunca registrá-la. */
export function loadMasterKey(dataDir) {
  const salt = () => {
    const f = path.join(dataDir, 'master.salt');
    if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(16).toString('base64'), { mode: 0o600 });
    return Buffer.from(fs.readFileSync(f, 'utf8'), 'base64');
  };
  const env = process.env.GATEWAY_MASTER_KEY;
  if (env) {
    if (env.length < 32) throw new Error('GATEWAY_MASTER_KEY precisa ter ao menos 32 caracteres.');
    return { key: crypto.scryptSync(env, salt(), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }), source: 'env' };
  }
  if (process.platform === 'win32') {
    const f = path.join(dataDir, 'master.dpapi');
    if (fs.existsSync(f)) return { key: Buffer.from(dpapi('Unprotect', fs.readFileSync(f, 'utf8').trim()), 'base64'), source: 'dpapi' };
    const key = crypto.randomBytes(32);
    fs.writeFileSync(f, dpapi('Protect', key.toString('base64')), { mode: 0o600 });
    return { key, source: 'dpapi' };
  }
  const f = path.join(dataDir, 'master.key');
  if (fs.existsSync(f)) return { key: Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'base64'), source: 'file' };
  const key = crypto.randomBytes(32);
  fs.writeFileSync(f, key.toString('base64'), { mode: 0o600 });
  return { key, source: 'file' };
}

export class Vault {
  constructor(key) { this.key = key; }
  /** `aad` amarra o texto cifrado ao seu contexto: uma chave copiada para outro campo não decifra. */
  encrypt(plain, aad = '') {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${ct.toString('base64')}`;
  }
  decrypt(blob, aad = '') {
    const [v, iv, tag, ct] = String(blob).split('.');
    if (v !== 'v1') throw new Error('formato de segredo desconhecido');
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  }
}

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `s1.${salt.toString('base64')}.${crypto.scryptSync(pw, salt, 32, SCRYPT).toString('base64')}`;
}
export function verifyPassword(pw, stored) {
  const [v, salt, hash] = String(stored).split('.');
  if (v !== 's1') return false;
  const expect = Buffer.from(hash, 'base64');
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64'), 32, SCRYPT);
  return expect.length === got.length && crypto.timingSafeEqual(expect, got);
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
export const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(String(a)), sha256(String(b)));
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const shortId = () => crypto.randomBytes(6).toString('hex');
