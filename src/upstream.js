// Cliente HTTP para os provedores: conexões reutilizáveis, sem seguir redirects, com SSRF checado por conexão.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { ipAllowed, safeLookup } from './security.js';
import { LocalError } from './i18n.js';

const opts = { keepAlive: true, keepAliveMsecs: 30000, maxSockets: 64, maxFreeSockets: 16, scheduling: 'lifo' };
const agents = {
  'https:false': new https.Agent(opts), 'https:true': new https.Agent(opts),
  'http:false': new http.Agent(opts), 'http:true': new http.Agent(opts),
};

/** Falha ao falar com o provedor. A mensagem leva chave e argumentos para ser traduzida na borda. */
export class UpstreamError extends LocalError {
  constructor(kind, key, ...args) { super(key, ...args); this.kind = kind; }
}

function classify(err) {
  if (err.code === 'SSRF_BLOCKED') return new UpstreamError('blocked', err.key ?? err.message, ...(err.args ?? []));
  if (['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL'].includes(err.code)) return new UpstreamError('dns', 'Host do provedor não encontrado.');
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'].includes(err.code)) return new UpstreamError('connection', 'Falha de conexão com o provedor ({0}).', err.code);
  if (/CERT|SSL|TLS/i.test(err.code ?? '')) return new UpstreamError('tls', 'Falha de TLS com o provedor ({0}).', err.code);
  return new UpstreamError('connection', 'Falha de conexão com o provedor.');
}

/** Resolve quando os headers chegam; `stream` é o corpo (já descomprimido). */
export function send({ url, method = 'POST', headers = {}, body, timeoutMs, allowPrivate = false, signal }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && !ipAllowed(host, allowPrivate)) return reject(new UpstreamError('blocked', 'Destino bloqueado pela proteção SSRF.'));
    const lib = u.protocol === 'https:' ? https : http;
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = lib.request(u, {
      method,
      agent: agents[`${u.protocol}${!!allowPrivate}`],
      lookup: safeLookup(allowPrivate),
      headers: { accept: 'application/json, text/event-stream', 'accept-encoding': 'gzip, br', 'user-agent': 'rotaz/1.0',
        ...(data && { 'content-type': 'application/json', 'content-length': data.length }), ...headers },
    });
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } };
    const timer = setTimeout(() => { fail(new UpstreamError('timeout', 'Sem resposta do provedor em {0}s.', Math.round(timeoutMs / 1000))); req.destroy(); }, timeoutMs);
    const onAbort = () => { fail(new UpstreamError('aborted', 'Requisição cancelada pelo cliente.')); req.destroy(); };
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    req.on('error', (e) => fail(e instanceof UpstreamError ? e : classify(e)));
    req.on('response', (res) => {
      if (settled) { res.destroy(); return; }
      settled = true;
      clearTimeout(timer);
      const enc = res.headers['content-encoding'];
      let stream = res;
      if (enc === 'gzip' || enc === 'br') {
        // Z_SYNC_FLUSH evita segurar eventos SSE dentro do descompressor.
        stream = enc === 'gzip' ? zlib.createGunzip({ flush: zlib.constants.Z_SYNC_FLUSH }) : zlib.createBrotliDecompress({ flush: zlib.constants.BROTLI_OPERATION_FLUSH });
        res.on('error', (e) => stream.destroy(e));
        res.pipe(stream);
      }
      resolve({ status: res.statusCode, headers: res.headers, stream, abort: () => { res.destroy(); stream.destroy(); } });
    });
    if (data) req.write(data);
    req.end();
  });
}

export async function readText(stream, limit = 8 * 1024 * 1024, timeoutMs = 300000) {
  const chunks = [];
  let size = 0;
  const timer = setTimeout(() => stream.destroy(new UpstreamError('timeout', 'Tempo esgotado lendo a resposta do provedor.')), timeoutMs);
  try {
    for await (const c of stream) {
      size += c.length;
      if (size > limit) { stream.destroy(); throw new UpstreamError('protocol', 'Resposta do provedor excede o limite.'); }
      chunks.push(c);
    }
  } finally { clearTimeout(timer); }
  return Buffer.concat(chunks).toString('utf8');
}
