// Catálogo de provedores. Só preenche o formulário; nada é ativado sem chave do usuário.
// Endpoints conferidos em 07/11/2026: cada um respondeu (401 sem chave ou 200) no caminho usado pelo gateway.
// `icon` aponta para public/icons/<icon>.svg; sem ícone, o painel desenha as iniciais.
// `urlPlaceholder`: a URL tem uma parte que o usuário precisa trocar (recurso, conta).
// K() marca os textos que o painel traduz (nomes de grupo, avisos).
import { K } from './i18n.js';

export const CATEGORIES = [
  { id: 'main', name: K('Principais') },
  { id: 'fast', name: K('Inferência e nuvem') },
  { id: 'aggregator', name: K('Agregadores') },
  { id: 'asia', name: K('China e Ásia') },
  { id: 'anthropic', name: K('Compatíveis com Anthropic') },
  { id: 'local', name: K('Na sua máquina') },
  { id: 'custom', name: K('Personalizado') },
];

const local = { authScheme: 'none', allowPrivateNetwork: true, category: 'local' };
const anth = { type: 'anthropic', authScheme: 'x-api-key', category: 'anthropic' };

export const PRESETS = [
  // Principais
  { id: 'openai', name: 'OpenAI', category: 'main', type: 'openai', baseUrl: 'https://api.openai.com/v1', icon: 'openai', keyUrl: 'https://platform.openai.com/api-keys', alias: 'claude-gpt' },
  { id: 'anthropic', name: 'Anthropic', category: 'main', type: 'anthropic', baseUrl: 'https://api.anthropic.com', authScheme: 'x-api-key', icon: 'anthropic', keyUrl: 'https://console.anthropic.com/settings/keys', alias: 'claude-anthropic' },
  { id: 'gemini', name: 'Google Gemini', category: 'main', type: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', icon: 'gemini', keyUrl: 'https://aistudio.google.com/apikey', alias: 'claude-gemini' },
  { id: 'deepseek', name: 'DeepSeek', category: 'main', type: 'openai', baseUrl: 'https://api.deepseek.com/v1', icon: 'deepseek', keyUrl: 'https://platform.deepseek.com/api_keys', alias: 'claude-deepseek' },
  { id: 'xai', name: 'xAI Grok', category: 'main', type: 'openai', baseUrl: 'https://api.x.ai/v1', icon: 'xai', keyUrl: 'https://console.x.ai', alias: 'claude-grok' },
  { id: 'mistral', name: 'Mistral', category: 'main', type: 'openai', baseUrl: 'https://api.mistral.ai/v1', icon: 'mistral', keyUrl: 'https://console.mistral.ai/api-keys', alias: 'claude-mistral' },
  { id: 'nvidia', name: 'NVIDIA NIM', category: 'main', type: 'openai', baseUrl: 'https://integrate.api.nvidia.com/v1', icon: 'nvidia', keyUrl: 'https://build.nvidia.com', alias: 'claude-nvidia', rpm: 35 },

  // Inferência e nuvem
  { id: 'groq', name: 'Groq', category: 'fast', type: 'openai', baseUrl: 'https://api.groq.com/openai/v1', icon: 'groq', keyUrl: 'https://console.groq.com/keys', alias: 'claude-groq', rpm: 30 },
  { id: 'cerebras', name: 'Cerebras', category: 'fast', type: 'openai', baseUrl: 'https://api.cerebras.ai/v1', icon: 'cerebras', keyUrl: 'https://cloud.cerebras.ai', alias: 'claude-cerebras', rpm: 30 },
  { id: 'sambanova', name: 'SambaNova', category: 'fast', type: 'openai', baseUrl: 'https://api.sambanova.ai/v1', icon: 'sambanova', keyUrl: 'https://cloud.sambanova.ai/apis', alias: 'claude-sambanova' },
  { id: 'together', name: 'Together AI', category: 'fast', type: 'openai', baseUrl: 'https://api.together.xyz/v1', icon: 'together', keyUrl: 'https://api.together.ai/settings/api-keys', alias: 'claude-together' },
  { id: 'fireworks', name: 'Fireworks AI', category: 'fast', type: 'openai', baseUrl: 'https://api.fireworks.ai/inference/v1', icon: 'fireworks', keyUrl: 'https://app.fireworks.ai/settings/users/api-keys', alias: 'claude-fireworks' },
  { id: 'deepinfra', name: 'DeepInfra', category: 'fast', type: 'openai', baseUrl: 'https://api.deepinfra.com/v1/openai', icon: 'deepinfra', keyUrl: 'https://deepinfra.com/dash/api_keys', alias: 'claude-deepinfra' },
  { id: 'hyperbolic', name: 'Hyperbolic', category: 'fast', type: 'openai', baseUrl: 'https://api.hyperbolic.xyz/v1', icon: 'hyperbolic', keyUrl: 'https://app.hyperbolic.xyz/settings', alias: 'claude-hyperbolic' },
  { id: 'novita', name: 'Novita AI', category: 'fast', type: 'openai', baseUrl: 'https://api.novita.ai/v3/openai', icon: 'novita', keyUrl: 'https://novita.ai/settings/key-management', alias: 'claude-novita' },
  { id: 'nebius', name: 'Nebius AI Studio', category: 'fast', type: 'openai', baseUrl: 'https://api.studio.nebius.com/v1', icon: 'nebius', keyUrl: 'https://studio.nebius.com', alias: 'claude-nebius' },
  { id: 'inception', name: 'Inception Mercury', category: 'fast', type: 'openai', baseUrl: 'https://api.inceptionlabs.ai/v1', icon: 'inception', keyUrl: 'https://platform.inceptionlabs.ai', alias: 'claude-mercury' },
  { id: 'venice', name: 'Venice AI', category: 'fast', type: 'openai', baseUrl: 'https://api.venice.ai/api/v1', icon: 'venice', keyUrl: 'https://venice.ai/settings/api', alias: 'claude-venice' },
  { id: 'chutes', name: 'Chutes', category: 'fast', type: 'openai', baseUrl: 'https://llm.chutes.ai/v1', icon: 'chutes', keyUrl: 'https://chutes.ai/app/api', alias: 'claude-chutes' },
  { id: 'perplexity', name: 'Perplexity', category: 'fast', type: 'openai', baseUrl: 'https://api.perplexity.ai', icon: 'perplexity', keyUrl: 'https://www.perplexity.ai/settings/api', alias: 'claude-perplexity', note: K('Não lista modelos pela API: cadastre o id manualmente (ex.: sonar-pro).') },
  { id: 'cohere', name: 'Cohere', category: 'fast', type: 'openai', baseUrl: 'https://api.cohere.ai/compatibility/v1', icon: 'cohere', keyUrl: 'https://dashboard.cohere.com/api-keys', alias: 'claude-cohere' },
  { id: 'huggingface', name: 'Hugging Face', category: 'fast', type: 'openai', baseUrl: 'https://router.huggingface.co/v1', icon: 'huggingface', keyUrl: 'https://huggingface.co/settings/tokens', alias: 'claude-hf' },
  { id: 'github', name: 'GitHub Models', category: 'fast', type: 'openai', baseUrl: 'https://models.github.ai/inference', icon: 'github', keyUrl: 'https://github.com/settings/tokens', alias: 'claude-github', rpm: 10, note: K('Use um token do GitHub com permissão "models". Os planos gratuitos têm limites baixos.') },
  { id: 'azure', name: 'Azure OpenAI', category: 'fast', type: 'openai', baseUrl: 'https://SEU-RECURSO.openai.azure.com/openai/v1', urlPlaceholder: 'SEU-RECURSO', authScheme: 'api-key', icon: 'azure', keyUrl: 'https://portal.azure.com', alias: 'claude-azure', note: K('Troque SEU-RECURSO pelo nome do seu recurso no Azure. O modelo é o nome do deployment.') },
  { id: 'cloudflare', name: 'Cloudflare Workers AI', category: 'fast', type: 'openai', baseUrl: 'https://api.cloudflare.com/client/v4/accounts/SEU-ACCOUNT-ID/ai/v1', urlPlaceholder: 'SEU-ACCOUNT-ID', icon: 'cloudflare', keyUrl: 'https://dash.cloudflare.com/profile/api-tokens', alias: 'claude-workers', note: K('Troque SEU-ACCOUNT-ID pelo id da sua conta Cloudflare.') },

  // Agregadores
  { id: 'openrouter', name: 'OpenRouter', category: 'aggregator', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', icon: 'openrouter', keyUrl: 'https://openrouter.ai/keys', alias: 'claude-openrouter' },
  { id: 'vercel', name: 'Vercel AI Gateway', category: 'aggregator', type: 'openai', baseUrl: 'https://ai-gateway.vercel.sh/v1', icon: 'vercel', keyUrl: 'https://vercel.com/docs/ai-gateway', alias: 'claude-vercel' },
  { id: 'requesty', name: 'Requesty', category: 'aggregator', type: 'openai', baseUrl: 'https://router.requesty.ai/v1', keyUrl: 'https://app.requesty.ai', alias: 'claude-requesty' },

  // China e Ásia
  { id: 'moonshot', name: 'Moonshot Kimi', category: 'asia', type: 'openai', baseUrl: 'https://api.moonshot.ai/v1', icon: 'kimi', keyUrl: 'https://platform.moonshot.ai/console/api-keys', alias: 'claude-kimi' },
  { id: 'zai', name: 'Z.ai GLM', category: 'asia', type: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4', icon: 'zai', keyUrl: 'https://z.ai/manage-apikey/apikey-list', alias: 'claude-glm' },
  { id: 'zhipu', name: 'Zhipu BigModel', category: 'asia', type: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', icon: 'zhipu', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys', alias: 'claude-zhipu' },
  { id: 'qwen', name: 'Alibaba Qwen', category: 'asia', type: 'openai', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', icon: 'qwen', keyUrl: 'https://bailian.console.alibabacloud.com', alias: 'claude-qwen' },
  { id: 'minimax', name: 'MiniMax', category: 'asia', type: 'openai', baseUrl: 'https://api.minimax.io/v1', icon: 'minimax', keyUrl: 'https://www.minimax.io/platform', alias: 'claude-minimax' },
  { id: 'stepfun', name: 'StepFun', category: 'asia', type: 'openai', baseUrl: 'https://api.stepfun.com/v1', icon: 'stepfun', keyUrl: 'https://platform.stepfun.com', alias: 'claude-stepfun' },
  { id: 'siliconflow', name: 'SiliconFlow', category: 'asia', type: 'openai', baseUrl: 'https://api.siliconflow.com/v1', icon: 'siliconflow', keyUrl: 'https://cloud.siliconflow.com/account/ak', alias: 'claude-siliconflow' },
  { id: 'qianfan', name: 'Baidu Qianfan', category: 'asia', type: 'openai', baseUrl: 'https://qianfan.baidubce.com/v2', icon: 'qianfan', keyUrl: 'https://console.bce.baidu.com/qianfan', alias: 'claude-qianfan' },
  { id: 'ark', name: 'Volcengine Doubao', category: 'asia', type: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', icon: 'doubao', keyUrl: 'https://console.volcengine.com/ark', alias: 'claude-doubao' },

  // Endpoints que falam o protocolo Anthropic: sem tradução, o Claude Code conversa direto.
  { id: 'deepseek-anthropic', name: 'DeepSeek (Anthropic)', ...anth, baseUrl: 'https://api.deepseek.com/anthropic', icon: 'deepseek', keyUrl: 'https://platform.deepseek.com/api_keys', alias: 'claude-deepseek-a' },
  { id: 'moonshot-anthropic', name: 'Kimi (Anthropic)', ...anth, baseUrl: 'https://api.moonshot.ai/anthropic', icon: 'kimi', keyUrl: 'https://platform.moonshot.ai/console/api-keys', alias: 'claude-kimi-a' },
  { id: 'zai-anthropic', name: 'Z.ai GLM (Anthropic)', ...anth, baseUrl: 'https://api.z.ai/api/anthropic', icon: 'zai', keyUrl: 'https://z.ai/manage-apikey/apikey-list', alias: 'claude-glm-a' },
  { id: 'minimax-anthropic', name: 'MiniMax (Anthropic)', ...anth, baseUrl: 'https://api.minimax.io/anthropic', icon: 'minimax', keyUrl: 'https://www.minimax.io/platform', alias: 'claude-minimax-a' },

  // Na sua máquina
  { id: 'ollama', name: 'Ollama', ...local, type: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', icon: 'ollama', alias: 'claude-ollama' },
  { id: 'lmstudio', name: 'LM Studio', ...local, type: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', icon: 'lmstudio', alias: 'claude-lmstudio' },
  { id: 'vllm', name: 'vLLM', ...local, type: 'openai', baseUrl: 'http://127.0.0.1:8000/v1', icon: 'vllm', alias: 'claude-vllm' },
  { id: 'llamacpp', name: 'llama.cpp', ...local, type: 'openai', baseUrl: 'http://127.0.0.1:8080/v1', alias: 'claude-llamacpp' },
  { id: 'jan', name: 'Jan', ...local, type: 'openai', baseUrl: 'http://127.0.0.1:1337/v1', alias: 'claude-jan' },
  { id: 'litellm', name: 'LiteLLM Proxy', ...local, type: 'openai', authScheme: 'bearer', baseUrl: 'http://127.0.0.1:4000/v1', alias: 'claude-litellm' },

  // Personalizado
  { id: 'custom', name: K('Compatível com OpenAI'), category: 'custom', type: 'openai', baseUrl: '', alias: 'claude-custom' },
  { id: 'custom-anthropic', name: K('Compatível com Anthropic'), category: 'custom', type: 'anthropic', authScheme: 'x-api-key', baseUrl: '', alias: 'claude-custom-a' },
];
