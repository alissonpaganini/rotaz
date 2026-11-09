// Métricas em memória com persistência periódica. Nenhum conteúdo de mensagem é guardado aqui.
import fs from 'node:fs';
import { redact } from './security.js';

const blank = () => ({ requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, latencySum: 0, latencyCount: 0 });

export class Metrics {
  constructor(file) {
    this.file = file;
    this.startedAt = Date.now();
    this.totals = blank();
    this.providers = {};
    this.errors = [];
    this.recent = [];
    this.minutes = [];
    this.inflight = 0;
    this.dirty = false;
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      Object.assign(this, { totals: { ...blank(), ...d.totals }, providers: d.providers ?? {}, errors: d.errors ?? [], minutes: d.minutes ?? [] });
    } catch { /* primeira execução */ }
    this.t = setInterval(() => this.flush(), 30000);
    this.t.unref();
  }

  provider(id) { return (this.providers[id] ??= { ...blank(), lastOkAt: null, lastErrorAt: null, lastError: null }); }

  bucket() {
    const m = Math.floor(Date.now() / 60000);
    let b = this.minutes[this.minutes.length - 1];
    if (!b || b.m !== m) {
      b = { m, requests: 0, errors: 0, tokens: 0, latencySum: 0 };
      this.minutes.push(b);
      if (this.minutes.length > 180) this.minutes.shift();
    }
    return b;
  }

  /** Fim de uma requisição do cliente, com ou sem sucesso. */
  record(e) {
    const ok = e.status < 400;
    const inT = e.input ?? 0;
    const outT = e.output ?? 0;
    const b = this.bucket();
    for (const s of [this.totals, e.providerId ? this.provider(e.providerId) : null]) {
      if (!s) continue;
      s.requests++;
      if (!ok) s.errors++;
      s.inputTokens += inT;
      s.outputTokens += outT;
      if (ok) { s.latencySum += e.ms; s.latencyCount++; }
    }
    b.requests++;
    b.tokens += inT + outT;
    if (ok) b.latencySum += e.ms; else b.errors++;
    if (e.providerId) {
      const p = this.provider(e.providerId);
      if (ok) p.lastOkAt = Date.now();
    }
    this.recent.unshift({ at: Date.now(), id: e.id, alias: e.alias, provider: e.providerName, model: e.upstream, status: e.status, ms: e.ms, ttfb: e.ttfb, input: inT, output: outT, stream: !!e.stream, proto: e.proto, via: e.via });
    if (this.recent.length > 100) this.recent.pop();
    if (!ok) this.error({ status: e.status, alias: e.alias, provider: e.providerName, message: e.error });
    this.dirty = true;
  }

  error(x) {
    const message = redact(x.message ?? 'Erro desconhecido').slice(0, 500);
    this.errors.unshift({ at: Date.now(), status: x.status ?? 0, alias: x.alias ?? null, provider: x.provider ?? null, message });
    if (this.errors.length > 200) this.errors.pop();
    this.dirty = true;
  }

  /** Falha de um alvo, mesmo que o fallback tenha salvado a requisição. */
  providerFailure(id, status, message) {
    const p = this.provider(id);
    p.lastErrorAt = Date.now();
    p.lastError = { status, message: redact(message).slice(0, 300) };
    this.dirty = true;
  }

  snapshot() {
    const t = this.totals;
    const recentMin = this.minutes.slice(-60);
    return {
      uptimeMs: Date.now() - this.startedAt, inflight: this.inflight,
      requests: t.requests, errors: t.errors, inputTokens: t.inputTokens, outputTokens: t.outputTokens,
      avgLatencyMs: t.latencyCount ? Math.round(t.latencySum / t.latencyCount) : 0,
      providers: this.providers, minutes: recentMin, recent: this.recent.slice(0, 30), errorLog: this.errors.slice(0, 50),
    };
  }

  reset() {
    Object.assign(this, { totals: blank(), providers: {}, errors: [], recent: [], minutes: [], dirty: true });
    this.flush();
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ totals: this.totals, providers: this.providers, errors: this.errors, minutes: this.minutes }));
      fs.renameSync(tmp, this.file);
    } catch { this.dirty = true; }
  }
}
