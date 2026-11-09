// Endpoints públicos do gateway: /v1/messages, /v1/chat/completions, /v1/models, count_tokens.
import { once } from 'node:events';
import { shortId, sha256 } from './crypto.js';
import { timingSafeEqual } from 'node:crypto';
import { buildRoute, KeyPool, providerGate } from './routing.js';
import { prepare, convertResponse, makeStream, usageTokens, adaptPayload, joinUrl, authHeaders, imageLimitFromError, countImages, withImageLimit } from './pipeline.js';
import { send, readText, UpstreamError } from './upstream.js';
import { SSEParser, safeParse, parseUpstreamError, toAnthropicError, toOpenAIError, estimateTokens } from './translate/common.js';
import { TranslationError } from './translate/openai-to-anthropic.js';
import { redact } from './security.js';
import { LocalError, K, tr, resolveLang } from './i18n.js';

export class BodyError extends Error { constructor(status, message) { super(message); this.status = status; } }

export async function readJson(req, maxBytes) {
  if (Number(req.headers['content-length']) > maxBytes) throw new BodyError(413, 'Payload acima do limite configurado.');
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > maxBytes) throw new BodyError(413, 'Payload acima do limite configurado.');
    chunks.push(c);
  }
  const j = safeParse(Buffer.concat(chunks).toString('utf8'));
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new BodyError(400, 'O corpo deve ser um objeto JSON válido.');
  return j;
}

function validate(proto, b) {
  if (!Array.isArray(b.messages) || !b.messages.length) return 'messages deve ser uma lista não vazia.';
  if (b.messages.some((m) => !m || typeof m !== 'object' || typeof m.role !== 'string')) return 'Cada mensagem precisa de role.';
  if (proto === 'anthropic') {
    if (!Number.isInteger(b.max_tokens) || b.max_tokens < 1) return 'max_tokens deve ser um inteiro positivo.';
    if (b.messages.some((m) => !['user', 'assistant', 'system'].includes(m.role))) return 'role deve ser user, assistant ou system.';
  }
  if (b.tools !== undefined && !Array.isArray(b.tools)) return 'tools deve ser uma lista.';
  if (b.temperature !== undefined && b.temperature !== null && typeof b.temperature !== 'number') return 'temperature deve ser numérico.';
  return null;
}

const MAX_429_WAIT = 30000;

/** Tempo pedido pelo provedor: header Retry-After ou frases como "Retry in 12s" / "try again in 2.5 seconds". */
export function retryAfterMs(header, message) {
  const h = Number(header);
  if (Number.isFinite(h) && h > 0) return Math.min(120000, h * 1000);
  const m = /(?:retry|try again)[^0-9]{0,12}(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|seconds?|m|min|minutes?)?\b/i.exec(String(message));
  if (m) {
    const unit = (m[2] ?? 's').toLowerCase();
    const v = Number(m[1]) * (unit.startsWith('ms') || unit.startsWith('milli') ? 1 : unit.startsWith('m') ? 60000 : 1000);
    return Math.min(120000, Math.max(500, v));
  }
  return 10000;
}

export function createGateway({ store, metrics, log, limiter }) {
  const pool = new KeyPool();
  const inflight = { n: 0 };
  const learnedImages = new Map(); // modelId -> limite aprendido com o erro do provedor (em memória)
  const imageLimit = (m) => {
    const vals = [m.maxImages, learnedImages.get(m.id)].filter((v) => Number.isInteger(v));
    return vals.length ? Math.min(...vals) : null;
  };

  // Mensagens para o Claude Code na língua escolhida no painel (ou na do sistema).
  const say = (x) => tr(resolveLang(store.ui.lang), x);
  function sendError(res, proto, status, raw, extra = {}) {
    if (res.headersSent) { res.end(); return; }
    const message = say(raw);
    const body = proto === 'openai' ? toOpenAIError(status, message) : toAnthropicError(status, message);
    res.writeHead(status, { 'content-type': 'application/json', ...extra });
    res.end(JSON.stringify(body));
  }

  function authorized(req) {
    const h = req.headers;
    const presented = h['x-api-key'] || /^Bearer\s+(.+)$/i.exec(h.authorization ?? '')?.[1];
    return !!presented && timingSafeEqual(sha256(presented), store.tokenHash);
  }

  /** Relay de streaming: chunk a chunk, com backpressure, ping e detecção de corte. */
  async function relay(res, up, ctx, abortCtl) {
    const tr = makeStream(ctx);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.flushHeaders();
    res.socket?.setNoDelay(true);
    let last = Date.now();
    let idle = false;
    const write = async (s) => {
      if (!s || res.destroyed) return;
      last = Date.now();
      if (!res.write(s)) await Promise.race([once(res, 'drain'), once(res, 'close')]);
    };
    const timeoutMs = store.server.timeoutMs;
    let idleTimer = setTimeout(() => { idle = true; up.abort(); }, timeoutMs);
    const pinger = setInterval(() => { if (Date.now() - last > 15000 && !res.destroyed) { res.write(tr.ping()); last = Date.now(); } }, 5000);
    const parser = new SSEParser();
    let complete = false;
    let sawFinish = false;
    const isSSE = /event-stream/.test(up.headers['content-type'] ?? '');

    const handle = async (evt) => {
      if (evt.data === '[DONE]') { complete = true; if (tr.passthrough && ctx.clientProto === 'openai') await write('data: [DONE]\n\n'); return; }
      const obj = safeParse(evt.data);
      if (!obj) return;
      if (tr.passthrough) {
        tr.observe(obj);
        await write(evt.event ? `event: ${evt.event}\ndata: ${evt.data}\n\n` : `data: ${evt.data}\n\n`);
        return;
      }
      if (obj.choices?.[0]?.finish_reason) sawFinish = true;
      await write(tr.push(obj));
    };

    try {
      if (!isSSE) {
        // Alguns provedores ignoram stream:true e devolvem JSON; vira um único delta.
        const j = safeParse(await readText(up.stream));
        if (!j) throw new UpstreamError('protocol', 'Resposta inválida do provedor.');
        if (ctx.upstreamProto !== 'openai' || tr.passthrough) throw new UpstreamError('protocol', 'O provedor não respondeu em streaming.');
        const m = j.choices?.[0]?.message ?? {};
        await write(tr.push({ choices: [{ delta: { ...m, tool_calls: m.tool_calls?.map((c, index) => ({ index, ...c })) }, finish_reason: j.choices?.[0]?.finish_reason ?? 'stop' }], usage: j.usage }));
        complete = true;
      } else {
        for await (const chunk of up.stream) {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => { idle = true; up.abort(); }, timeoutMs);
          for (const evt of parser.feed(chunk)) await handle(evt);
          if (res.destroyed) break;
        }
        for (const evt of parser.flush()) await handle(evt);
      }
    } catch (e) {
      log.debug(`stream interrompido: ${e.message}`);
    } finally {
      clearTimeout(idleTimer);
      clearInterval(pinger);
    }
    if (ctx.upstreamProto === 'anthropic') complete = tr.stopped === true;
    else complete = complete || sawFinish;
    if (idle) complete = false;
    if (!res.destroyed) {
      await write(tr.end(complete));
      if (tr.passthrough && !complete) {
        const msg = say(K('A conexão com o provedor terminou antes do fim da resposta.'));
        await write(ctx.clientProto === 'anthropic' ? `event: error\ndata: ${JSON.stringify(toAnthropicError(502, msg))}\n\n` : `data: ${JSON.stringify(toOpenAIError(502, msg))}\n\ndata: [DONE]\n\n`);
      }
      res.end();
    }
    return { usage: tr.finalUsage, complete, clientGone: abortCtl.signal.aborted, upstreamError: tr.upstreamError };
  }

  async function chat(req, res, proto, id) {
    const started = Date.now();
    const srv = store.server;
    let body;
    try { body = await readJson(req, srv.maxBodyMB * 1024 * 1024); }
    catch (e) { return sendError(res, proto, e.status ?? 400, e.status ? e.message : 'Requisição malformada.'); }
    const bad = validate(proto, body);
    if (bad) return sendError(res, proto, 400, bad);

    const route = buildRoute(store, body.model);
    const base = { id, proto, stream: !!body.stream, alias: route.alias ?? String(body.model).slice(0, 80), via: route.via };
    const finish = (e) => {
      metrics.record({ ...base, ms: Date.now() - started, ...e });
      log.info(`${id} ${proto} ${body.stream ? 'stream' : 'sync'} ${String(body.model).slice(0, 60)} -> ${e.providerName ?? '-'}/${e.upstream ?? '-'} ${e.status} ${Date.now() - started}ms`);
    };

    if (!route.alias) {
      const msg = new LocalError('Modelo desconhecido: {0}. Cadastre o alias no painel.', String(body.model).slice(0, 80));
      finish({ status: 404, error: msg.message });
      return sendError(res, proto, 404, msg);
    }
    if (!route.targets.length) {
      const msg = new LocalError('O modelo "{0}" está desativado ou sem provedor ativo com chave. Verifique o painel do gateway.', route.alias);
      finish({ status: 503, error: msg.message });
      return sendError(res, proto, 503, msg, { 'x-should-retry': 'false' });
    }

    const abortCtl = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abortCtl.abort(); });

    let attempts = 0;
    let lastErr = null;
    // Segunda rodada só para 429 com espera curta: melhor aguardar alguns segundos do que falhar no Claude Code.
    for (let round = 0; round < 2; round++) {
    if (round === 1) {
      if (lastErr?.status !== 429 || !(lastErr.waitMs <= MAX_429_WAIT) || abortCtl.signal.aborted) break;
      log.info(`${id} ${lastErr.target.provider.name} pediu para aguardar ${Math.ceil(lastErr.waitMs / 1000)}s; tentando de novo`);
      attempts = 0;
    }
    for (const target of route.targets) {
      const { provider: p, model: m } = target;
      const extraHeaders = store.headersOf(p);
      for (const k of pool.order(p)) {
        if (attempts >= srv.maxAttempts) break;
        attempts++;
        let prep;
        const maxImages = imageLimit(m);
        try {
          prep = prepare(proto, body, target, { key: k ? store.keyValue(p, k) : null, extraHeaders, clientHeaders: req.headers, alias: route.alias, maxImages });
        } catch (e) {
          if (e instanceof TranslationError) { finish({ status: 400, error: e.message }); return sendError(res, proto, 400, e.message); }
          throw e;
        }

        let up;
        let payload = prep.payload;
        try {
          for (let adapt = 0; ; adapt++) {
            await providerGate.acquire(p, { signal: abortCtl.signal, maxWaitMs: srv.timeoutMs });
            up = await send({ url: prep.url, headers: prep.headers, body: payload, timeoutMs: srv.timeoutMs, allowPrivate: p.allowPrivateNetwork, signal: abortCtl.signal });
            if (up.status !== 400 && up.status !== 422 && up.status !== 413) break;
            const text = await readText(up.stream, 1024 * 1024);
            const err = parseUpstreamError(up.status, text);
            if (adapt >= 3) { up.errorBody = err; break; }
            // Modelo que não aceita imagens (ou aceita poucas): aprende o limite e reenvia sem as excedentes.
            const lim = imageLimitFromError(err.message);
            if (lim !== null && countImages(payload, p.type) > lim) {
              learnedImages.set(m.id, Math.min(lim, learnedImages.get(m.id) ?? Infinity));
              log.warn(`${id} ${p.name}/${m.upstream} ${lim === 0 ? 'não aceita imagens' : `aceita no máximo ${lim} imagem(ns)`}; as excedentes serão omitidas daqui em diante`);
              payload = withImageLimit(payload, p.type, lim);
              continue;
            }
            const next = adaptPayload(payload, err.message, p.type);
            if (!next) { up.errorBody = err; break; }
            log.debug(`${id} ajustando parâmetros para ${p.name}: ${err.message}`);
            payload = next;
          }
        } catch (e) {
          if (e.kind === 'aborted') { finish({ status: 499, error: 'Cliente desconectou.', providerId: p.id, providerName: p.name, upstream: m.upstream }); return; }
          if (e.kind === 'queue') { lastErr = { status: 429, message: e.message, said: e, target }; break; }
          const why = e instanceof UpstreamError ? e : K('Falha ao contatar o provedor.');
          const msg = e instanceof UpstreamError ? e.message : why;
          metrics.providerFailure(p.id, 0, msg);
          log.warn(`${id} ${p.name}: ${msg}`);
          const full = new LocalError('{0}: {1}', p.name, why);
          lastErr = { status: e.kind === 'timeout' ? 504 : 502, message: full.message, said: full, target };
          break; // erro de rede não melhora trocando a chave: vai para o próximo alvo
        }

        if (up.status >= 200 && up.status < 300) {
          const meta = { providerId: p.id, providerName: p.name, upstream: m.upstream, ttfb: Date.now() - started, via: target.via };
          res.setHeader('x-gateway-provider', encodeURIComponent(p.name));
          res.setHeader('x-gateway-route', target.via);
          if (body.stream) {
            const r = await relay(res, up, prep.ctx, abortCtl);
            const t = usageTokens(r.usage);
            if (r.clientGone) return finish({ ...meta, status: 499, error: 'Cliente desconectou durante o streaming.', input: t.input, output: t.output });
            if (!r.complete) {
              const msg = r.upstreamError?.message ?? 'Stream interrompido pelo provedor.';
              metrics.providerFailure(p.id, 502, String(msg));
              return finish({ ...meta, status: 502, error: String(msg) });
            }
            return finish({ ...meta, status: 200, input: t.input, output: t.output });
          }
          let out;
          try {
            const text = await readText(up.stream, 64 * 1024 * 1024, srv.timeoutMs);
            const json = safeParse(text);
            if (!json) throw new Error(K('corpo não é JSON'));
            out = convertResponse(json, prep.ctx);
          } catch (e) {
            const said = new LocalError('{0}: resposta fora do protocolo esperado ({1}).', p.name, e);
            metrics.providerFailure(p.id, 502, said.message);
            lastErr = { status: 502, message: said.message, said, target };
            break;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(out));
          const t = usageTokens(out.usage);
          return finish({ ...meta, status: 200, input: t.input, output: t.output });
        }

        const err = up.errorBody ?? parseUpstreamError(up.status, await readText(up.stream, 1024 * 1024).catch(() => ''));
        metrics.providerFailure(p.id, up.status, err.message);
        log.warn(`${id} ${p.name} respondeu ${up.status}: ${err.message}`);
        lastErr = { status: up.status, message: err.message, target, retryAfter: up.headers['retry-after'] };

        if (up.status === 401 || up.status === 403) { pool.penalize(k?.id, 300000); continue; } // próxima chave
        if (up.status === 429) {
          const waitMs = retryAfterMs(up.headers['retry-after'], err.message);
          lastErr.waitMs = waitMs;
          pool.penalize(k?.id, waitMs);
          // Com uma chave só, o limite é do provedor: as próximas requisições esperam na fila em vez de insistir.
          if (p.keys.filter((x) => x.enabled).length <= 1) providerGate.pause(p.id, waitMs);
          continue;
        }
        if (up.status === 402) { pool.penalize(k?.id, 300000); continue; }
        if (up.status === 404 || up.status >= 500) break;  // próximo alvo
        // Erro da própria requisição: outro provedor recusaria igual, e o cliente precisa ver a mensagem.
        finish({ status: up.status, error: err.message, providerId: p.id, providerName: p.name, upstream: m.upstream });
        return sendError(res, proto, up.status, err.message, { 'x-should-retry': 'false' });
      }
      if (attempts >= srv.maxAttempts) break;
    }
    }

    const e = lastErr ?? { status: 502, message: K('Nenhum provedor disponível.') };
    const meta = e.target ? { providerId: e.target.provider.id, providerName: e.target.provider.name, upstream: e.target.model.upstream } : {};
    // 401/403 do provedor não pode virar 401 no Claude Code: ele pediria /login de uma conta que não tem culpa.
    const authFail = e.status === 401 || e.status === 403;
    const status = authFail ? 502 : e.status;
    const message = authFail ? new LocalError('O provedor {0} recusou a credencial (HTTP {1}): {2}', meta.providerName, e.status, e.said ?? e.message) : e.said ?? e.message;
    finish({ ...meta, status, error: message.message ?? message });
    const headers = {};
    if (e.retryAfter || e.waitMs) headers['retry-after'] = String(e.retryAfter ?? Math.ceil(e.waitMs / 1000));
    if (authFail || e.status === 404) headers['x-should-retry'] = 'false';
    sendError(res, proto, status, message, headers);
  }

  function listModels() {
    const r = store.routing;
    const seen = new Map();
    for (const p of [...store.providers].sort((a, b) => a.priority - b.priority)) {
      if (!p.enabled) continue;
      for (const m of p.models) {
        if (m.enabled && !seen.has(m.alias)) seen.set(m.alias, { p, m });
      }
    }
    const rows = [...seen.values()].map(({ p, m }) => ({
      type: 'model', id: m.alias, display_name: m.displayName, created_at: '2025-01-01T00:00:00Z',
      description: `${p.name} · ${m.upstream}`.slice(0, 100),
      object: 'model', created: 1735689600, owned_by: p.name,
    }));
    rows.sort((a, b) => (b.id === r.defaultAlias) - (a.id === r.defaultAlias));
    return rows;
  }

  async function countTokens(req, res) {
    let body;
    try { body = await readJson(req, store.server.maxBodyMB * 1024 * 1024); }
    catch (e) { return sendError(res, 'anthropic', e.status ?? 400, e.message); }
    const target = buildRoute(store, body.model).targets[0];
    if (target?.provider.type === 'anthropic') {
      const p = target.provider;
      const k = pool.order(p)[0];
      try {
        const { model, stream, max_tokens, ...rest } = body;
        const up = await send({
          url: joinUrl(p.baseUrl, 'anthropic', '/count_tokens'), body: { ...rest, model: target.model.upstream }, timeoutMs: 15000, allowPrivate: p.allowPrivateNetwork,
          headers: { ...authHeaders(p, k ? store.keyValue(p, k) : null), ...store.headersOf(p), 'anthropic-version': '2023-06-01', ...(req.headers['anthropic-beta'] && { 'anthropic-beta': req.headers['anthropic-beta'] }) },
        });
        const text = await readText(up.stream, 1024 * 1024);
        if (up.status === 200 && safeParse(text)?.input_tokens !== undefined) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(text);
        }
      } catch { /* cai na estimativa */ }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ input_tokens: estimateTokens([body.system, body.messages, body.tools]) }));
  }

  async function handle(req, res, url) {
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const proto = path.includes('/chat/completions') ? 'openai' : 'anthropic';
    const known = /^\/(v1\/)?(messages(\/count_tokens)?|chat\/completions|models(\/.+)?)$/.test(path);
    if (!known) return false;

    if (!authorized(req)) { sendError(res, proto, 401, 'Token do gateway ausente ou inválido.', { 'x-should-retry': 'false' }); return true; }
    // Desligado pelo painel: recusa tudo, sem tocar nos provedores.
    if (store.server.gatewayEnabled === false) { sendError(res, proto, 503, 'O gateway Rotaz está desligado. Ligue-o no painel para voltar a usar os modelos.', { 'x-should-retry': 'false' }); return true; }
    const ip = req.socket.remoteAddress;
    const rl = `gw:${ip}`;
    if (!limiter.allow(rl, store.server.rateLimitPerMin)) { sendError(res, proto, 429, 'Limite de requisições do gateway atingido.', { 'retry-after': String(limiter.retryAfter(rl)) }); return true; }

    const id = `req_${shortId()}`;
    res.setHeader('request-id', id);
    res.setHeader('x-request-id', id);

    if (req.method === 'GET' && /\/models$/.test(path)) {
      const data = listModels();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data, has_more: false, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null }));
      return true;
    }
    if (req.method === 'GET' && /\/models\/.+$/.test(path)) {
      const wanted = decodeURIComponent(path.split('/').pop());
      const row = listModels().find((m) => m.id === wanted);
      if (!row) { sendError(res, proto, 404, 'Modelo não encontrado.'); return true; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(row));
      return true;
    }
    if (req.method !== 'POST') { sendError(res, proto, 405, 'Método não permitido.', { allow: 'POST' }); return true; }
    if (path.endsWith('/count_tokens')) { await countTokens(req, res); return true; }
    if (/models/.test(path)) { sendError(res, proto, 405, 'Método não permitido.'); return true; }

    if (inflight.n >= store.server.maxConcurrent) { sendError(res, proto, 429, 'Limite de requisições simultâneas atingido.', { 'retry-after': '2' }); return true; }
    inflight.n++;
    metrics.inflight = inflight.n;
    try { await chat(req, res, proto, id); }
    catch (e) {
      log.error(`${id} erro interno: ${e.stack ?? e.message}`);
      metrics.error({ status: 500, message: redact(e.message) });
      sendError(res, proto, 500, 'Erro interno do gateway.');
    } finally { inflight.n--; metrics.inflight = inflight.n; }
    return true;
  }

  return { handle, listModels, pool, learnedImages };
}

