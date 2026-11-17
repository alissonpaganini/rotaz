// O que muda por tipo de credencial: como o item de `keys` vira credencial, como esquecer o acesso recusado,
// o que fazer antes de cada pedido e o que dizer quando falta conta. Gateway, teste e catálogo usam só isto.
import { K } from '../i18n.js';
import { credentialFor, explainError } from './antigravity.js';
import { oauthCredential, forgetOAuth, beforeRequest } from './oauth/engine.js';

const API_KEY = {
  credential: (store, p, k) => (k ? store.keyValue(p, k) : null),
  forget() {},
  before: async (p, upstream, cred, prep) => prep,
  /** Erro do provedor que a pessoa resolve fora do Rotaz: { status do teste, mensagem com a orientação } ou null. */
  explain: () => null,
  missing: K('Cadastre ao menos uma chave de API neste provedor.'),
  missingForModels: K('Cadastre uma chave antes de buscar modelos.'),
};

const BY_TYPE = {
  antigravity: {
    ...API_KEY,
    credential: credentialFor,
    explain: explainError,
    forget: (store, p, k) => store.forgetAccessToken(p, k),
    missing: K('Conecte uma conta Google neste provedor.'),
    missingForModels: K('Conecte uma conta Google antes de buscar modelos.'),
  },
  oauth: {
    credential: oauthCredential,
    forget: forgetOAuth,
    before: beforeRequest,
    explain: () => null,
    missing: K('Conecte uma conta neste provedor.'),
    missingForModels: K('Conecte uma conta antes de buscar modelos.'),
  },
};

export const accountOf = (provider) => BY_TYPE[provider.type] ?? API_KEY;
