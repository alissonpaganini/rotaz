// Backup do perfil: provedores, modelos, rotas, orçamento, aparência e limites, num arquivo JSON portátil.
// As chaves de API só entram se quem exporta escolher uma senha: elas saem cifradas com ela (AES-256-GCM, chave
// derivada por scrypt), porque a chave mestra desta máquina não vale em outra. Senha do painel, token do gateway,
// métricas e registros nunca entram.
import crypto from 'node:crypto';
import { LocalError } from './i18n.js';

export const BACKUP_KIND = 'rotaz-backup';
export const BACKUP_VERSION = 1;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MODEL_FIELDS = ['alias', 'upstream', 'displayName', 'enabled', 'maxOutputTokens', 'maxImages', 'reasoningEffort', 'tokenParam', 'priceIn', 'priceOut'];
const SERVER_FIELDS = ['timeoutMs', 'maxBodyMB', 'rateLimitPerMin', 'maxConcurrent', 'maxAttempts', 'logLevel'];

const keyFrom = (password, salt) => crypto.scryptSync(String(password), salt, 32, SCRYPT);

function seal(obj, password) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(password, salt), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { kdf: 'scrypt', cipher: 'aes-256-gcm', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function open(box, password) {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(password, Buffer.from(box.salt, 'base64')), Buffer.from(box.iv, 'base64'));
    d.setAuthTag(Buffer.from(box.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8'));
  } catch { throw new LocalError('Senha do backup incorreta.'); }
}

/** Monta o arquivo de backup. Com `password`, as chaves e os headers extras vão cifrados com ela. */
export function exportProfile(store, { password, appVersion } = {}) {
  if (password !== undefined && password !== null && password !== '' && String(password).length < 8) throw new LocalError('A senha do backup precisa de 8 caracteres ou mais.');
  const withSecrets = !!password;
  const secrets = { keys: {}, headers: {} };
  const providers = store.providers.map((p, i) => {
    if (withSecrets) {
      p.keys.forEach((k, j) => { secrets.keys[`${i}:${j}`] = store.keyValue(p, k); });
      const h = store.headersOf(p);
      if (h && Object.keys(h).length) secrets.headers[i] = h;
    }
    return {
      name: p.name, type: p.type, baseUrl: p.baseUrl, authScheme: p.authScheme, allowPrivateNetwork: p.allowPrivateNetwork,
      enabled: p.enabled, priority: p.priority, rpm: p.rpm, presetId: p.presetId ?? null,
      keys: p.keys.map((k) => ({ label: k.label, enabled: k.enabled })),
      models: p.models.map((m) => Object.fromEntries(MODEL_FIELDS.map((f) => [f, m[f] ?? null]))),
    };
  });
  const { tiers, ...routing } = store.routing;
  return {
    kind: BACKUP_KIND, version: BACKUP_VERSION, app: appVersion ?? null, exportedAt: new Date().toISOString(),
    config: {
      providers,
      routing: { ...routing, tiers: { ...tiers } },
      budget: store.c.budget ? { ...store.c.budget } : null,
      ui: { ...store.ui },
      server: Object.fromEntries(SERVER_FIELDS.map((f) => [f, store.server[f]])),
    },
    secrets: withSecrets ? seal(secrets, password) : null,
  };
}

/** Resumo para mostrar antes de importar. Também confere se o arquivo é um backup do Rotaz. */
export function inspectBackup(file) {
  if (!file || file.kind !== BACKUP_KIND || !file.config || !Array.isArray(file.config.providers)) throw new LocalError('Este arquivo não é um backup do Rotaz.');
  if (file.version > BACKUP_VERSION) throw new LocalError('Este backup é de uma versão mais nova do Rotaz. Atualize o app para importar.');
  return {
    providers: file.config.providers.length,
    models: file.config.providers.reduce((n, p) => n + (p.models?.length ?? 0), 0),
    keys: file.config.providers.reduce((n, p) => n + (p.keys?.length ?? 0), 0),
    secrets: !!file.secrets, exportedAt: file.exportedAt ?? null, app: file.app ?? null,
  };
}

/**
 * Aplica um backup numa transação só: ou entra tudo, ou nada muda.
 * - `replace`: troca provedores, rotas, orçamento, aparência e limites pelos do arquivo.
 * - `merge`: acrescenta os provedores do arquivo e mantém o resto como está.
 * Sem a senha, os provedores entram sem chaves (é só cadastrá-las depois).
 */
export function importProfile(store, file, { password, mode = 'replace' } = {}) {
  const info = inspectBackup(file);
  if (!['replace', 'merge'].includes(mode)) throw new LocalError('Modo de importação inválido.');
  const secrets = file.secrets && password ? open(file.secrets, password) : null;
  const cfg = file.config;
  store.transact(() => {
    if (mode === 'replace') store.c.providers = [];
    cfg.providers.forEach((p, i) => {
      const keys = secrets ? (p.keys ?? []).map((k, j) => ({ label: k.label, key: secrets.keys[`${i}:${j}`], enabled: k.enabled !== false })).filter((k) => k.key) : [];
      const added = store.addProvider({ ...p, keys: keys.map(({ label, key }) => ({ label, key })), headers: secrets?.headers?.[i], models: p.models ?? [] });
      // chaves pausadas no perfil de origem continuam pausadas
      keys.forEach((k, j) => { if (!k.enabled) store.updateKey(added.id, added.keys[j].id, { enabled: false }); });
    });
    if (mode === 'replace') {
      if (cfg.routing) store.updateRouting(cfg.routing);
      store.c.budget = null;
      if (cfg.budget) store.updateBudget(cfg.budget);
      if (cfg.ui) store.updateUi(cfg.ui);
      if (cfg.server) store.updateServer(Object.fromEntries(SERVER_FIELDS.filter((f) => cfg.server[f] !== undefined).map((f) => [f, cfg.server[f]])));
    }
  });
  return { ...info, keysImported: !!secrets, mode };
}
