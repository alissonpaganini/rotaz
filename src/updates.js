// Verificação de versão nova nas Releases do GitHub. Usada pela versão de terminal e pelo app no macOS
// (no Windows, o app instala sozinho pelo electron-updater, em desktop/main.js).
// Só consulta o GitHub com a opção ligada em Configurações; a consulta envia apenas o IP e a versão (no
// cabeçalho User-Agent), como qualquer acesso a uma página pública. Nada de uso, chaves ou conteúdo.

export const REPO = 'alissonpaganini/rotaz';
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const EVERY_MS = 6 * 3600 * 1000;

/** Compara versões "1.2.3" (aceita "v" na frente). Positivo quando `a` é mais nova. */
export function compareVersions(a, b) {
  const parse = (v) => String(v ?? '').replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

export class UpdateChecker {
  constructor({ store, log, currentVersion, fetchImpl = globalThis.fetch }) {
    this.store = store;
    this.log = log;
    this.current = currentVersion;
    this.fetch = fetchImpl;
    this.state = { latest: null, url: RELEASES_URL, checkedAt: null, error: null };
    this.inflight = null;
  }

  get enabled() { return this.store.server.updateCheck !== false; }

  /** Estado para o painel. `force` consulta de novo mesmo com o resultado recente em cache. */
  async status({ force = false } = {}) {
    if (this.enabled && this.current && (force || !this.state.checkedAt || Date.now() - this.state.checkedAt > EVERY_MS)) await this.check();
    const newer = !!(this.state.latest && this.current && compareVersions(this.state.latest, this.current) > 0);
    return { enabled: this.enabled, current: this.current, ...this.state, newer };
  }

  check() {
    this.inflight ??= (async () => {
      try {
        const r = await this.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
          headers: { accept: 'application/vnd.github+json', 'user-agent': `rotaz/${this.current}` }, signal: AbortSignal.timeout(10000),
        });
        if (r.status === 404) Object.assign(this.state, { latest: null, error: null }); // ainda não há Release publicada
        else if (!r.ok) throw new Error(`HTTP ${r.status}`);
        else {
          const j = await r.json();
          Object.assign(this.state, { latest: String(j.tag_name ?? '').replace(/^v/i, '') || null, url: j.html_url ?? RELEASES_URL, error: null });
        }
      } catch (e) {
        this.state.error = String(e.message ?? e).slice(0, 200);
        this.log?.warn(`verificação de versão falhou: ${this.state.error}`);
      } finally {
        this.state.checkedAt = Date.now();
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}
