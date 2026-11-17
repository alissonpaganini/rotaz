// Envio ao provedor com as adaptações de parâmetro. Gateway e teste usam esta mesma função, então o botão
// "Testar" tenta exatamente como o tráfego real.
import { providerGate } from './routing.js';
import { send, readText } from './upstream.js';
import { parseUpstreamError } from './translate/common.js';
import { adaptPayload, imageLimitFromError, countImages, withImageLimit } from './pipeline.js';

const ADAPTS = 3;

/**
 * Envia `prep` respeitando a fila do provedor. Em 400/422/413 lê o erro e, quando há um ajuste seguro (menos
 * imagens, outro nome de parâmetro, parâmetro a menos), reenvia. Quando não há, devolve a resposta com
 * `errorBody` já lido. `timeoutMs()` é chamado a cada passo: o teste tem um prazo total que vai acabando.
 */
export async function sendAdapting({ provider: p, prep, signal, timeoutMs, onImageLimit, onAdapt }) {
  let payload = prep.payload;
  const proto = prep.ctx.upstreamProto;
  for (let adapt = 0; ; adapt++) {
    await providerGate.acquire(p, { signal, maxWaitMs: timeoutMs() });
    const up = await send({ url: prep.url, headers: prep.headers, body: payload, timeoutMs: timeoutMs(), allowPrivate: p.allowPrivateNetwork, signal });
    if (up.status !== 400 && up.status !== 422 && up.status !== 413) return up;
    up.errorBody = parseUpstreamError(up.status, await readText(up.stream, 1024 * 1024, timeoutMs()));
    if (adapt >= ADAPTS) return up;
    const message = up.errorBody.message;
    const lim = imageLimitFromError(message);
    if (lim !== null && countImages(payload, proto) > lim) {
      onImageLimit?.(lim);
      payload = withImageLimit(payload, proto, lim);
      continue;
    }
    const next = adaptPayload(payload, message, proto);
    if (!next) return up;
    onAdapt?.(message);
    payload = next;
  }
}
