// Gasto em dinheiro e orçamento. Os preços são em dólar por 1 milhão de tokens, como os provedores publicam;
// a moeda de exibição e a cotação vêm da configuração. Nenhum conteúdo de mensagem passa por aqui.

export const BUDGET_DEFAULTS = { currency: 'USD', rate: 1, daily: 0, monthly: 0, warnAt: 80, action: 'alert', fallbackAlias: null };
export const CURRENCIES = ['USD', 'BRL', 'EUR'];
export const ACTIONS = ['alert', 'switch', 'block'];

/** Custo de um pedido em dólares; null quando o modelo não tem preço cadastrado. */
export function costOf(model, input = 0, output = 0) {
  if (!model) return null;
  const pin = model.priceIn, pout = model.priceOut;
  if ((pin === null || pin === undefined) && (pout === null || pout === undefined)) return null;
  return ((pin ?? 0) * input + (pout ?? 0) * output) / 1e6;
}

const pad = (n) => String(n).padStart(2, '0');
/** Dia e mês no fuso desta máquina: é o "hoje" de quem usa. */
export const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const monthKey = (d = new Date()) => dayKey(d).slice(0, 7);

export class Budget {
  constructor(store, metrics) {
    this.store = store;
    this.metrics = metrics;
    this.listeners = [];
    this.fired = new Set(); // avisos já dados neste período (dia ou mês + nível)
  }

  get config() { return { ...BUDGET_DEFAULTS, ...this.store.c.budget }; }

  /** Gasto do dia e do mês na moeda de exibição, comparado com os limites. */
  state() {
    const c = this.config;
    const level = (spentUsd, limit) => {
      const spent = spentUsd * (c.rate || 1);
      return { spent, limit, pct: limit > 0 ? (spent / limit) * 100 : null };
    };
    const day = level(this.metrics.spentOn(dayKey()), c.daily);
    const month = level(this.metrics.spentIn(monthKey()), c.monthly);
    const over = [day, month].some((v) => v.pct !== null && v.pct >= 100);
    const warn = !over && [day, month].some((v) => v.pct !== null && v.pct >= c.warnAt);
    return { ...c, day, month, over, warn, monthKey: monthKey() };
  }

  /** Depois de cada pedido: avisa uma vez por período ao passar do limiar de aviso e ao chegar ao limite. */
  check() {
    const s = this.state();
    for (const [period, v, key] of [['day', s.day, dayKey()], ['month', s.month, monthKey()]]) {
      if (v.pct === null) continue;
      const level = v.pct >= 100 ? 'over' : v.pct >= s.warnAt ? 'warn' : null;
      if (!level) continue;
      const id = `${period}:${key}:${level}`;
      if (this.fired.has(id)) continue;
      this.fired.add(id);
      for (const fn of this.listeners) {
        try { fn({ period, level, spent: v.spent, limit: v.limit, currency: s.currency, action: s.action }); } catch { /* aviso nunca derruba o gateway */ }
      }
    }
  }

  onAlert(fn) { this.listeners.push(fn); }
}
