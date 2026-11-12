// Métricas em memória com persistência periódica. Nenhum conteúdo de mensagem é guardado aqui.
import fs from 'node:fs';
import { redact } from './security.js';
import { dayKey } from './budget.js';

// cost: dólares gastos (só pedidos de modelos com preço); unpriced: pedidos com tokens de modelos sem preço
const blank = () => ({ requests: 0, errors: 0, inputTokens: 0, outputTokens: 0, latencySum: 0, latencyCount: 0, cost: 0, unpriced: 0 });
const blankDay = () => ({ cost: 0, requests: 0, unpriced: 0, providers: {} });

export class Metrics {
  constructor(file) {
    this.file = file;
    this.startedAt = Date.now();
    this.totals = blank();
    this.providers = {};
    this.errors = [];
    this.recent = [];
    this.minutes = [];
    this.days = {}; // 'AAAA-MM-DD' -> gasto do dia, guardado por 62 dias
    this.inflight = 0;
    this.dirty = false;
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      Object.assign(this, { totals: { ...blank(), ...d.totals }, providers: d.providers ?? {}, errors: d.errors ?? [], minutes: d.minutes ?? [], days: d.days ?? {} });
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

  day(key = dayKey()) {
    if (!this.days[key]) {
      this.days[key] = blankDay();
      const keys = Object.keys(this.days).sort();
      for (const k of keys.slice(0, Math.max(0, keys.length - 62))) delete this.days[k];
    }
    return this.days[key];
  }
  /** Dólares gastos num dia ('AAAA-MM-DD') ou num mês ('AAAA-MM'). */
  spentOn(key) { return this.days[key]?.cost ?? 0; }
  spentIn(prefix) { return Object.entries(this.days).reduce((sum, [k, d]) => sum + (k.startsWith(prefix) ? d.cost : 0), 0); }

  /** Fim de uma requisição do cliente, com ou sem sucesso. `cost` em dólares, ou null sem preço. */
  record(e) {
    const ok = e.status < 400;
    const inT = e.input ?? 0;
    const outT = e.output ?? 0;
    const b = this.bucket();
    const priced = typeof e.cost === 'number' && e.cost > 0;
    const unpriced = e.cost === null && inT + outT > 0 ? 1 : 0;
    if (priced || unpriced || e.providerId) {
      const d = this.day();
      d.requests++;
      if (priced) { d.cost += e.cost; if (e.providerId) d.providers[e.providerId] = (d.providers[e.providerId] ?? 0) + e.cost; }
      d.unpriced += unpriced;
    }
    for (const s of [this.totals, e.providerId ? this.provider(e.providerId) : null]) {
      if (!s) continue;
      s.requests++;
      if (priced) s.cost = (s.cost ?? 0) + e.cost;
      s.unpriced = (s.unpriced ?? 0) + unpriced;
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
    this.recent.unshift({ at: Date.now(), id: e.id, alias: e.alias, provider: e.providerName, model: e.upstream, status: e.status, ms: e.ms, ttfb: e.ttfb, input: inT, output: outT, cost: typeof e.cost === 'number' ? e.cost : null, stream: !!e.stream, proto: e.proto, via: e.via });
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
      cost: t.cost ?? 0, unpriced: t.unpriced ?? 0, days: this.days,
    };
  }

  reset() {
    Object.assign(this, { totals: blank(), providers: {}, errors: [], recent: [], minutes: [], days: {}, dirty: true });
    this.flush();
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ totals: this.totals, providers: this.providers, errors: this.errors, minutes: this.minutes, days: this.days }));
      fs.renameSync(tmp, this.file);
    } catch { this.dirty = true; }
  }
}
