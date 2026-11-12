// Resolve o nome pedido pelo cliente em alvos concretos (provedor + modelo real), na ordem de tentativa.
import { LocalError } from './i18n.js';

const byPriority = (a, b) => a.priority - b.priority;
const usable = (p) => p.enabled && (p.authScheme === 'none' || p.keys.some((k) => k.enabled));

function targetsOf(store, alias, via) {
  const out = [];
  for (const p of [...store.providers].sort(byPriority)) {
    if (!usable(p)) continue;
    const m = p.models.find((x) => x.alias === alias && x.enabled);
    if (m) out.push({ provider: p, model: m, via });
  }
  return out;
}

const TIER_RE = /(opus|sonnet|haiku)/;

export function resolveAlias(store, requested) {
  const r = store.routing;
  const name = String(requested ?? '').toLowerCase().replace(/\[[^\]]*\]$/, '').trim();
  if (store.aliases().includes(name)) return { alias: name, via: 'alias' };
  if (!name || name === 'auto' || name === 'default') return { alias: r.defaultAlias, via: 'default' };
  if (!r.catchAll) return { alias: null, via: 'none' };
  // Claude Code pede modelos pequenos (ex.: claude-haiku-*) em tarefas de fundo, mesmo com outro modelo ativo.
  const tier = TIER_RE.exec(name)?.[1];
  if (tier && r.tiers[tier]) return { alias: r.tiers[tier], via: `tier:${tier}` };
  return { alias: r.defaultAlias, via: 'catch-all' };
}

/**
 * Por que um alias não tem alvo, para o painel explicar e oferecer a ação certa.
 * `reason`: 'no-default' | 'missing' | 'model-off' | 'provider-off' | 'no-key'. `provider`: o primeiro afetado.
 */
export function routeProblem(store, alias) {
  if (!alias) return { reason: 'no-default', alias: null, provider: null };
  const owners = [...store.providers].sort(byPriority).filter((p) => p.models.some((m) => m.alias === alias));
  const info = (reason, p) => ({ reason, alias, provider: p ? { id: p.id, name: p.name } : null });
  if (!owners.length) return info('missing');
  const withModel = owners.filter((p) => p.models.some((m) => m.alias === alias && m.enabled));
  if (!withModel.length) return info('model-off', owners[0]);
  const off = withModel.find((p) => !p.enabled);
  if (off) return info('provider-off', off);
  return info('no-key', withModel[0]);
}

/**
 * Regras (o painel descreve exatamente isto):
 * - Alias desativado, ou sem provedor ativo com chave: nenhum alvo. Desativar nunca é contornado por fallback.
 * - Fallback desligado: só o provedor de maior prioridade para o alias (as chaves dele ainda se revezam).
 * - Fallback ligado: o mesmo alias nos demais provedores, depois o modelo padrão. Nunca um modelo qualquer.
 */
export function buildRoute(store, requested) {
  const { alias, via } = resolveAlias(store, requested);
  if (!alias) return { alias: null, via, targets: [] };
  const primary = targetsOf(store, alias, via);
  if (!primary.length) return { alias, via, targets: [] };
  if (!store.routing.fallbackEnabled) return { alias, via, targets: primary.slice(0, 1) };
  const targets = [primary[0], ...primary.slice(1).map((t) => ({ ...t, via: 'fallback' }))];
  const def = store.routing.defaultAlias;
  if (def && def !== alias) {
    const seen = new Set(targets.map((t) => t.model.id));
    for (const t of targetsOf(store, def, 'fallback')) if (!seen.has(t.model.id)) targets.push(t);
  }
  return { alias, via, targets };
}

/**
 * Fila por provedor: respeita o limite de requisições por minuto configurado e as pausas pedidas
 * pelo próprio provedor (429). Quem chega espera a vez em vez de receber erro.
 */
export class ProviderGate {
  constructor() { this.hist = new Map(); this.pausedUntil = new Map(); }

  waitMs(p, now = Date.now()) {
    const pause = Math.max(0, (this.pausedUntil.get(p.id) ?? 0) - now);
    if (!p.rpm) return pause;
    const h = (this.hist.get(p.id) ?? []).filter((t) => now - t < 60000);
    this.hist.set(p.id, h);
    return Math.max(pause, h.length < p.rpm ? 0 : h[0] + 60000 - now + 10);
  }

  async acquire(p, { signal, maxWaitMs = 300000 } = {}) {
    const start = Date.now();
    for (;;) {
      const now = Date.now();
      const wait = this.waitMs(p, now);
      if (wait <= 0) {
        // Sem await entre a checagem e o registro: duas requisições não pegam a mesma vaga.
        if (p.rpm) this.hist.get(p.id).push(now);
        return now - start;
      }
      if (now - start + wait > maxWaitMs) {
        const e = new LocalError('{0}: limite de requisições atingido e a fila passaria do timeout.', p.name);
        e.kind = 'queue';
        throw e;
      }
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, Math.min(wait, 1000));
        signal?.addEventListener('abort', () => { clearTimeout(t); const e = new Error('cancelado'); e.kind = 'aborted'; reject(e); }, { once: true });
      });
    }
  }

  pause(id, ms) { this.pausedUntil.set(id, Math.max(this.pausedUntil.get(id) ?? 0, Date.now() + ms)); }
}

export const providerGate = new ProviderGate();

/** Rodízio de chaves com quarentena para as que falharam. */
export class KeyPool {
  constructor() { this.cursor = new Map(); this.cool = new Map(); }
  order(p) {
    const keys = p.keys.filter((k) => k.enabled);
    if (!keys.length) return p.authScheme === 'none' ? [null] : [];
    const start = (this.cursor.get(p.id) ?? 0) % keys.length;
    this.cursor.set(p.id, start + 1);
    const rotated = [...keys.slice(start), ...keys.slice(0, start)];
    const now = Date.now();
    const ready = rotated.filter((k) => (this.cool.get(k.id) ?? 0) <= now);
    return ready.length ? ready : rotated;
  }
  penalize(keyId, ms) { if (keyId) this.cool.set(keyId, Date.now() + ms); }
}
