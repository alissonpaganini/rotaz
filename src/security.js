// Barreiras de segurança: SSRF, validação de entrada, redação de segredos e rate limiting.
import net from 'node:net';
import dns from 'node:dns';
import { LocalError } from './i18n.js';

// Nunca alcançáveis, nem com "rede local" ligada (metadados de nuvem, link-local, multicast...).
const hardBlock = new net.BlockList();
hardBlock.addSubnet('0.0.0.0', 8, 'ipv4');
hardBlock.addSubnet('169.254.0.0', 16, 'ipv4');
hardBlock.addSubnet('224.0.0.0', 4, 'ipv4');
hardBlock.addSubnet('240.0.0.0', 4, 'ipv4');
hardBlock.addAddress('::', 'ipv6');
hardBlock.addSubnet('fe80::', 10, 'ipv6');
hardBlock.addSubnet('ff00::', 8, 'ipv6');

// Bloqueados por padrão; liberados apenas com `allowPrivateNetwork` no provedor.
const privateBlock = new net.BlockList();
privateBlock.addSubnet('127.0.0.0', 8, 'ipv4');
privateBlock.addSubnet('10.0.0.0', 8, 'ipv4');
privateBlock.addSubnet('172.16.0.0', 12, 'ipv4');
privateBlock.addSubnet('192.168.0.0', 16, 'ipv4');
privateBlock.addSubnet('100.64.0.0', 10, 'ipv4');
privateBlock.addSubnet('198.18.0.0', 15, 'ipv4');
privateBlock.addAddress('::1', 'ipv6');
privateBlock.addSubnet('fc00::', 7, 'ipv6');

function unmap(ip) {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1] : ip;
}

export function ipAllowed(rawIp, allowPrivate) {
  const ip = unmap(String(rawIp).replace(/^\[|\]$/g, ''));
  const fam = net.isIP(ip);
  if (!fam) return false;
  const t = fam === 4 ? 'ipv4' : 'ipv6';
  if (hardBlock.check(ip, t)) return false;
  return allowPrivate || !privateBlock.check(ip, t);
}

export const isLoopbackHost = (h) => {
  const x = String(h).replace(/^\[|\]$/g, '').toLowerCase();
  return x === 'localhost' || x === '::1' || /^127\./.test(x);
};

/** Validação no cadastro. A checagem definitiva acontece a cada conexão, em `safeLookup`. */
export function validateBaseUrl(raw, { allowPrivate = false, selfPort } = {}) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new Error('URL base inválida.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('A URL base deve usar http ou https.');
  if (u.username || u.password) throw new Error('A URL base não pode conter credenciais.');
  if (u.search || u.hash) throw new Error('A URL base não pode conter query string ou fragmento.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !ipAllowed(host, allowPrivate)) throw new Error('Endereço bloqueado pela proteção SSRF. Para redes locais, ative "Permitir rede local".');
  if (!allowPrivate && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal'))) {
    throw new Error('Host local bloqueado pela proteção SSRF. Para redes locais, ative "Permitir rede local".');
  }
  if (u.protocol === 'http:' && !allowPrivate) throw new Error('Use https. Http só é aceito com "Permitir rede local" ativo.');
  if (selfPort && isLoopbackHost(host) && Number(u.port || 80) === Number(selfPort)) throw new Error('A URL base não pode apontar para o próprio gateway.');
  return u.toString().replace(/\/+$/, '');
}

/** Valida o IP resolvido no instante da conexão, o que fecha a janela de DNS rebinding. */
export function safeLookup(allowPrivate) {
  return (host, opts, cb) => {
    dns.lookup(host, { ...opts, all: true }, (err, addrs) => {
      if (err) return cb(err);
      const bad = addrs.find((a) => !ipAllowed(a.address, allowPrivate));
      if (bad) {
        const e = new LocalError('Destino bloqueado pela proteção SSRF ({0})', host);
        e.code = 'SSRF_BLOCKED';
        return cb(e);
      }
      if (opts.all) return cb(null, addrs);
      cb(null, addrs[0].address, addrs[0].family);
    });
  };
}

const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'cookie', 'te', 'trailer', 'keep-alive', 'proxy-authorization', 'proxy-connection']);
export function validateHeaders(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const name = String(k).trim();
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) throw new LocalError('Nome de header inválido: {0}', name.slice(0, 40));
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) throw new LocalError('Header não permitido: {0}', name);
    if (/[\r\n\0]/.test(String(v)) || String(v).length > 4096) throw new LocalError('Valor inválido no header {0}', name);
    out[name] = String(v);
  }
  return out;
}

const SECRET_PATTERNS = [
  /\b(sk|pk|rk)-[A-Za-z0-9_\-*]{12,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bnvapi-[A-Za-z0-9_-]{12,}/g,
  /\bxai-[A-Za-z0-9_-]{12,}/g,
  /\bgsk_[A-Za-z0-9]{12,}/g,
  /\bAIza[A-Za-z0-9_-]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(api[_-]?key|authorization|x-api-key)(["'\s:=]+)[^\s"',}]{6,}/gi,
];
export function redact(text) {
  let s = String(text ?? '');
  for (const p of SECRET_PATTERNS) s = s.replace(p, (m, a, b) => (b !== undefined && /key|auth/i.test(a) ? `${a}${b}[redigido]` : '[redigido]'));
  return s;
}

/** Janela fixa por chave. Limpa a si mesma para não crescer sem limite. */
export class RateLimiter {
  constructor() { this.hits = new Map(); this.t = setInterval(() => this.sweep(), 60000); this.t.unref(); }
  allow(key, perMinute) {
    if (!perMinute) return true;
    const now = Date.now();
    const e = this.hits.get(key);
    if (!e || now >= e.reset) { this.hits.set(key, { n: 1, reset: now + 60000 }); return true; }
    return ++e.n <= perMinute;
  }
  retryAfter(key) { const e = this.hits.get(key); return e ? Math.max(1, Math.ceil((e.reset - Date.now()) / 1000)) : 1; }
  sweep() { const now = Date.now(); for (const [k, e] of this.hits) if (now >= e.reset) this.hits.delete(k); }
}

/** Bloqueio progressivo de login: dobra a espera a cada falha depois da quinta. */
export class LoginGuard {
  constructor() { this.f = new Map(); }
  waitMs(ip) { const e = this.f.get(ip); return e ? Math.max(0, e.until - Date.now()) : 0; }
  fail(ip) {
    const e = this.f.get(ip) || { n: 0, until: 0 };
    e.n++;
    if (e.n >= 5) e.until = Date.now() + Math.min(15 * 60000, 1000 * 2 ** (e.n - 3));
    this.f.set(ip, e);
  }
  ok(ip) { this.f.delete(ip); }
}

export const ALIAS_RE = /^claude-[a-z0-9][a-z0-9._-]{0,62}$/;

// Lista extraída do Claude Desktop 4.16336 (validador `Mo` do app.asar). Ids que a contenham
// são descartados do seletor do Desktop, mesmo com prefixo `claude-`. O CLI não aplica esse filtro.
const DESKTOP_DENY = /ark-code|astron|command-r|deepseek|doubao|gemini|gemma|glm|gpt|grok|hermes|hy3|kimi|lfm|\bling\b|llama|longcat|mimo|minimax|mistral|mixtral|moonshot|nemotron|openai|phi-|qianfan|qwen|tc-code|\bunic\b|yi-|stepfun|step-3|seed-|bytedance|hunyuan|granite|amazon\.nova|nova-|devstral|ministral|ernie|codex|arcee|trinity|abab|phi\d|\bk2\.|\bm2\.|jamba|arctic|solar|mercury|zamba|kat-coder|\bds-|dpsk/;
export function aliasCompat(alias) {
  const a = String(alias).toLowerCase();
  const m = DESKTOP_DENY.exec(a);
  return { cli: /(claude|anthropic)/i.test(a), desktop: !m, blockedBy: m ? m[0] : null };
}
