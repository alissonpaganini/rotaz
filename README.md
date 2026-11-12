# Rotaz

*Qualquer modelo no seu Claude Code.* Pronuncia-se "RRÔ-taz".

Gateway local que permite usar APIs de terceiros no Claude Code, com painel web para gerenciar provedores, chaves e modelos. Um único processo Node, sem dependências externas.

## Como funciona

O Claude Code só fala o protocolo **Anthropic Messages**, e a maioria dos provedores fala **OpenAI Chat Completions**. Por isso o gateway traduz nos dois sentidos:

| Cliente | Provedor | O que acontece |
| --- | --- | --- |
| Anthropic (`/v1/messages`, Claude Code) | OpenAI | Tradução completa |
| OpenAI (`/v1/chat/completions`) | Anthropic | Tradução completa |
| Anthropic | Anthropic | Repasse com troca do modelo e filtro de campos |
| OpenAI | OpenAI | Repasse com troca do modelo |

Cada alias público (`claude-*`) aponta para provedor, modelo real, URL base e credencial. O provedor sempre recebe o identificador real do modelo.

## Duas formas de usar

| Para quem | Como |
| --- | --- |
| Qualquer pessoa | **App instalável:** `Rotaz-<versão>-Windows-x64-Setup.exe` (Windows) ou `Rotaz-<versão>-macOS-universal.dmg` (macOS). O nome de cada arquivo diz o sistema. Abre o painel numa janela própria e fica na bandeja do sistema. |
| Quem usa terminal | **Código-fonte:** `npm start`, com Node 20.11 ou superior e nenhuma dependência para instalar. |

Os dois rodam exatamente o mesmo gateway e o mesmo painel.

### App instalável

- **Instalação:** dê dois cliques no instalador. Não precisa de administrador; no Windows, ele instala na sua conta e cria atalhos no menu Iniciar e na área de trabalho.
- **Primeiro acesso:** o app já abre na tela de criar a senha.
- **Ao fechar a janela:** por padrão o app e o gateway continuam na bandeja (use **Sair do Rotaz** no menu da bandeja para encerrar). Em Configurações → Sistema e segurança, ou no menu da bandeja, dá para trocar para **Encerrar o app**.
- **Iniciar com o sistema:** em Configurações ou no menu da bandeja; o app abre minimizado.
- **Dados:** ficam em `%APPDATA%\Rotaz\data` (Windows) ou `~/Library/Application Support/Rotaz/data` (macOS).
- **Chave mestra:** protegida pelo DPAPI no Windows e pelo Keychain no macOS.
- **Convivência com o terminal:** se uma versão de terminal já estiver rodando na mesma porta, o app abre esse painel em vez de iniciar um segundo gateway.
- **Atualizações:** no Windows, o app baixa a versão nova das Releases do GitHub em segundo plano e instala ao reiniciar (pelo aviso, pelo menu da logo, pela bandeja ou ao fechar o app). No macOS e no terminal, o painel só avisa e mostra o link. Desligue em Configurações → Sistema e segurança → **Atualizações**; desligado, o Rotaz não consulta o GitHub. A consulta envia só o IP e a versão instalada.

### Gerar os instaladores

```bash
cd desktop
npm install
npm run dist:win
```

O `.exe` sai em `desktop/dist/`. O `.dmg` precisa ser gerado num Mac (`npm run dist:mac`) ou pelo GitHub Actions: o workflow `.github/workflows/installers.yml` gera os dois a cada tag `v*` ou manualmente, pela aba Actions.

### Assinatura

Sem certificado de código, os sistemas desconfiam do instalador:

- **Windows:** o SmartScreen mostra "O Windows protegeu o computador". Clique em **Mais informações → Executar assim mesmo**.
- **macOS:** clique com o botão direito no app → **Abrir**, ou permita em **Ajustes do Sistema → Privacidade e Segurança**.

Para distribuir sem esses avisos, você precisa de:

- **Windows:** um certificado de assinatura de código, configurado pelos segredos `CSC_LINK` e `CSC_KEY_PASSWORD`.
- **macOS:** uma conta Apple Developer (US$ 99 por ano), com os segredos `CSC_LINK` e `CSC_KEY_PASSWORD` e mais `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` e `APPLE_TEAM_ID` para a notarização.

Cadastre esses segredos no repositório do GitHub; o workflow já os usa.

### Publicar uma versão

A atualização automática lê a Release mais recente do repositório. Para lançar uma versão:

1. Suba `version` em `desktop/package.json` (e em `package.json` da raiz, para a versão de terminal).
2. Crie e envie a tag: `git tag v1.1.0 && git push origin v1.1.0`.
3. O workflow gera os instaladores e publica a Release com `latest.yml` e os `.blockmap`. Sem esses arquivos, o app instalado não enxerga a versão nova.

A Release precisa estar publicada (não rascunho nem pré-lançamento).

## Início rápido (terminal)

Requer Node 20.11 ou superior.

```bash
npm start
```

No Windows, um duplo clique em `Iniciar.cmd` faz o mesmo. O painel abre em <http://127.0.0.1:8787/>.

1. **Primeiro acesso:** crie a senha do painel. O código de configuração vem na URL aberta automaticamente, no console e em `data/setup-token.txt`.
2. **Provedores → Adicionar provedor:** abre o catálogo com 49 provedores, em grade (padrão) ou lista. Os provedores estão em sete grupos: principais, inferência e nuvem, agregadores, China e Ásia, compatíveis com Anthropic, na sua máquina e personalizado. Escolha um, cole a chave e o gateway oferece importar os modelos em seguida. Endpoints conferidos em 07/11/2026.
3. **Importar do provedor:** lista os modelos do provedor (em cache por 1 h; "Atualizar lista" busca de novo). Filtre, marque vários, ajuste os aliases sugeridos e adicione todos de uma vez. Para um modelo só, use "Adicionar modelo".
4. **Testar:** faz requisições reais ao provedor. Na tabela de modelos, marque vários para testar, ativar, desativar, editar ou remover em massa. "Testar todos" faz o teste rápido de todos os modelos ativos.
   - **Teste rápido:** uma chamada de texto por modelo, bom para listas grandes.
   - **Teste completo:** texto e, em seguida, streaming e ferramentas ao mesmo tempo (três chamadas por modelo).
   - Cada teste tem prazo total, então um provedor mudo vira falha em vez de travar a lista. **Interromper** cancela também o que já está em andamento.
   - O último resultado fica na coluna "Último teste" até o servidor reiniciar.
5. **Roteamento:** escolha o modelo padrão, as famílias e o fallback.

Mudanças de provedor e modelo valem na requisição seguinte, sem reiniciar nada.

## Configurar o Claude Code

A aba **Claude Code** do painel mostra a URL e o token prontos para copiar. O token do gateway é diferente das chaves dos provedores e só dá acesso ao gateway.

### Claude Desktop (modo desenvolvedor)

Os nomes abaixo são os do Claude Desktop em português; em inglês, entre parênteses. O painel mostra o passo a passo no idioma escolhido.

1. Menu **Ajuda → Solução de problemas → Ativar modo de desenvolvedor** (Help → Troubleshooting → Enable Developer Mode).
2. Menu **Desenvolvedor → Configurar inferência de terceiros** (Developer → Configure Third-Party Inference).
3. Em **Conexão** (Connection), escolha **Gateway**.
4. **Tipo de credencial** (Credential type): Chave de API estática.
5. **URL base do gateway** (Gateway base URL): `http://127.0.0.1:8787`. **Chave de API do gateway** (Gateway API key): o token do painel.
6. **Esquema de autenticação do gateway** (Gateway auth scheme): bearer.
7. Deixe ligada a **Descoberta de modelos** (Model discovery), clique em **Aplicar alterações** e reinicie o app.

### Claude Code no terminal

Mescle em `~/.claude/settings.json`, depois de fazer uma cópia do arquivo:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "<token do gateway>",
    "ANTHROPIC_MODEL": "claude-seu-alias",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"
  }
}
```

### Por que o prefixo `claude-` existe, e onde ele não basta

Medido nos binários instalados (Claude Code 2.1.317 e Claude Desktop 4.16336):

- O Claude Code consulta `GET /v1/models?limit=1000` e mantém apenas ids que casam com `/(claude|anthropic)/i`. O prefixo `claude-` resolve isso.
- **O seletor do Claude Desktop aplica um filtro adicional:** descarta ids que citam outros fornecedores (`gpt`, `gemini`, `deepseek`, `grok`, `qwen`, `llama`, `mistral` e outros), mesmo com o prefixo. Assim, `claude-gpt` funciona no terminal, mas não aparece nesse seletor.

O painel diz onde cada alias aparece ("CLI e Desktop" ou "Só CLI") enquanto você digita, e sugere nomes parecidos que servem para os dois: uma letra a mais ou um hífen entre as sílabas (`claude-gpt-4o` → `claude-gept-4o`, `claude-deepseek-chat` → `claude-deeepseek-chat` ou `claude-deep-seek-chat`). Ao importar, os nomes já saem assim (dá para escolher "Iguais ao provedor"). Na tabela, "Renomear para o Desktop" e "Ajustar para o Desktop" (em massa) trocam os nomes, e o roteamento acompanha. A regra fica em `public/alias.js`, a mesma no painel e no servidor. Um alias oculto no seletor continua funcionando como modelo padrão, porque o gateway decide o destino: o Claude Code pode pedir qualquer nome e receber o modelo configurado em **Roteamento**.

O gateway não falsifica metadados para contornar esse filtro. Ele publica os aliases como você os cadastrou.

## Idiomas

O painel, a abertura, a bandeja e as mensagens de erro estão em português (Brasil), inglês, espanhol, chinês simplificado, japonês, coreano, alemão e francês. O Rotaz segue a língua do sistema e usa inglês quando ela não está na lista. Troque em **Configurações → Aparência → Idioma** ou no seletor da abertura. `ROTAZ_LANG=<código>` substitui o idioma do sistema no modo automático.

Para acrescentar um texto, escreva-o em português dentro de `L('...')` (painel) ou `K('...')` / `LocalError('...')` (servidor) e adicione a tradução em cada `public/i18n/<código>.json`.

## Gasto e orçamento

Cadastre o preço de cada modelo (em dólar por 1 milhão de tokens, como na página de preços do provedor) e o Rotaz mostra quanto você gasta: o mês, o dia, os últimos 30 dias e os provedores que mais gastaram, no quadro **Gasto** da visão geral. Ao importar modelos do OpenRouter, os preços vêm preenchidos. Modelos locais custam 0; modelo sem preço não entra na conta, e o painel avisa quantos pedidos ficaram de fora.

Em **Configurações → Gastos e orçamento**:

- **Moeda:** dólar, real ou euro, com a cotação que você informar.
- **Limites por dia e por mês**, com aviso ao chegar a uma porcentagem (80% por padrão). No app, o aviso também sai como notificação.
- **Ao atingir o limite:** só avisar, trocar todos os pedidos para um modelo de reserva (barato ou local) ou bloquear os pedidos até o fim do período (o Claude Code recebe o erro 402).

O gasto é uma estimativa feita pelos tokens que o provedor informa; a cobrança de verdade é a do provedor.

## Backup do perfil

Clique na logo do Rotaz (na barra de título do app, ou no topo da barra lateral no navegador) para abrir o menu: **Exportar perfil**, **Importar perfil**, **Documentação**, **Reportar um problema** e **Sobre o Rotaz**.

- **Exportar:** salva provedores, modelos (com preços), rotas, orçamento, aparência e limites num arquivo `.json`. As chaves de API só entram se você escolher uma senha: elas vão cifradas com ela (AES-256-GCM, chave derivada por scrypt), porque a chave mestra de um computador não vale em outro. A senha do painel, o token do gateway, métricas e registros nunca entram.
- **Importar:** mostra o que vem no arquivo antes de aplicar. **Substituir tudo** troca a configuração atual pela do arquivo; **Acrescentar provedores** só soma os provedores e mantém o resto. Sem a senha, os provedores entram sem as chaves. Tudo é aplicado de uma vez: se algo no arquivo for inválido, nada muda.

## Roteamento

Ordem de resolução do nome pedido:

1. Alias exato, ignorando sufixos como `[1m]`.
2. `auto` ou nome vazio vão para o modelo padrão.
3. Com "Aceitar nomes desconhecidos" ligado: nomes com `opus`, `sonnet` ou `haiku` usam o mapa de famílias, e os demais usam o padrão. Isso é necessário porque o Claude Code pede modelos como `claude-haiku-*` em tarefas de fundo.

**Rodízio de chaves** (sempre ativo): em 401, 402, 403 e 429 o gateway tenta a próxima chave do mesmo provedor e do mesmo modelo. Chaves que falham ficam em quarentena por 30 s a 5 min.

**Fallback**, apenas antes de qualquer byte chegar ao cliente:
- **Ligado:** mesmo alias nos demais provedores, por prioridade (menor número primeiro), e depois o modelo padrão. O gateway nunca troca para um modelo arbitrário; respostas por fallback aparecem marcadas no painel e no header `x-gateway-route: fallback`.
- **Desligado:** só o provedor de maior prioridade responde.
- **Desativados:** modelos, provedores e chaves desativados nunca são usados, nem por fallback. O pedido recebe erro 503.

Erros 400 não acionam fallback, porque outro provedor recusaria o mesmo pedido.

## Teste de provedor

O botão **Testar** usa o modelo configurado e passa pelo mesmo pipeline do tráfego real. São três chamadas reais: texto, streaming e ferramenta. Elas consomem poucos tokens.

Resultados: Funcional, Falha de autenticação, Endpoint inválido, Modelo inexistente, Timeout, Erro de protocolo, Falha de conexão, Limite ou saldo do provedor, Erro do provedor.

## Limitações da tradução

Diferenças sem equivalência direta entre as APIs, e o que o gateway faz em cada uma.

**Anthropic → OpenAI**

| Recurso | Comportamento |
| --- | --- |
| `top_k` | Descartado |
| `cache_control` | Descartado. O cache depende do provedor; tokens em cache são informados quando ele os reporta |
| `thinking`, `output_config.effort` | Não mapeados. Configure "Esforço de raciocínio" por modelo |
| Raciocínio do provedor | Vira bloco `thinking` quando o cliente pediu, com assinatura própria do gateway, e volta ao provedor como `reasoning_content` |
| Ferramentas de servidor (`web_search_*` etc.) | Removidas. Ferramentas comuns funcionam |
| PDF | Substituído por um aviso em texto. Documentos de texto são incluídos |
| Imagem em `tool_result` | Vai em uma mensagem de usuário logo após o resultado |
| `role: system` dentro de `messages` | Sobe para a mensagem de sistema inicial |
| Bloco `x-anthropic-billing-header` | Removido, não sai da máquina |
| `metadata.user_id` | Enviado como hash de 32 caracteres, pois contém identificadores do dispositivo |
| `stop_sequence` na resposta | OpenAI não informa qual sequência parou; volta como `end_turn` |
| Nomes de ferramenta acima de 64 caracteres | Encurtados com hash e restaurados na resposta |
| Pares `tool_use`/`tool_result` órfãos | Reparados com um resultado vazio ou convertidos em texto |
| `count_tokens` | Estimativa local, exceto com provedor Anthropic |
| `context_management` | Descartado |

**OpenAI → Anthropic**

| Recurso | Comportamento |
| --- | --- |
| `n > 1` | Erro 400 |
| `response_format` | Vira instrução de sistema, sem garantia estrutural |
| `temperature` acima de 1 | Limitada a 1 |
| `seed`, `logit_bias`, `logprobs`, penalidades | Descartados |
| `max_tokens` ausente | Usa o limite do modelo ou 4096 |
| `reasoning_effort` | Descartado |

**Geral**

- Parâmetros recusados pelo provedor com erro 400 são ajustados automaticamente e reenviados, até 3 vezes (`max_tokens`, `max_completion_tokens`, `temperature`, `stream_options` e similares).
- Depois que o streaming começa não há fallback. Se o provedor cortar a conexão, o cliente recebe um evento de erro, nunca um fim normal.
- 401 e 403 do provedor chegam ao cliente como 502 com `x-should-retry: false`. Sem isso o Claude Code pediria `/login` de uma conta que não tem relação com o erro.
- A qualidade do uso de ferramentas depende do modelo. Um modelo pode ser "Funcional" e ainda assim sair-se mal em tarefas longas do Claude Code.

## Segurança

| Tema | Implementação |
| --- | --- |
| Chaves em repouso | AES-256-GCM, com AAD por campo (segredo copiado para outro campo não decifra) |
| Chave mestra | DPAPI do Windows, vinculada à sua conta; ou `GATEWAY_MASTER_KEY` (mínimo de 32 caracteres); em outros sistemas, arquivo com permissão 0600 |
| Frontend | Chaves nunca voltam ao navegador: apenas os 4 caracteres finais e um rótulo |
| Logs | Redação de segredos em toda linha; corpos de mensagem nunca são registrados |
| Painel | Senha com scrypt, cookie HttpOnly e SameSite=Strict, bloqueio progressivo de login |
| Acesso | Painel só responde a loopback, mesmo escutando em `0.0.0.0`; padrão `127.0.0.1` |
| CSRF e DNS rebinding | Validação de Host, Origin e Sec-Fetch-Site, e header próprio obrigatório |
| SSRF | IP validado no momento da conexão; metadados de nuvem e link-local sempre bloqueados; rede privada só com opção explícita por provedor; redirects não são seguidos |
| Gateway | Token obrigatório, rate limit, limite de concorrência, de payload e timeouts |
| Isolamento | O corpo da requisição não escolhe URL, chave ou headers; o repasse Anthropic usa lista de campos permitidos |
| Página | CSP estrita, sem scripts inline nem recursos externos |

**Se você perder a chave mestra** (formatar o Windows ou trocar de conta, por exemplo), `data/config.json` não pode ser decifrado. O gateway recusa iniciar e não altera nada. Cadastre as chaves novamente em uma pasta `data` nova.

## Linha de comando

```bash
node src/index.js --open --port 8787 --host 127.0.0.1 --data ./data
```

Para encerrar, use Ctrl+C no console ou finalize o processo `node`. Para iniciar com o Windows, use **Configurações → Iniciar com o Windows**.

## Estrutura

```
src/index.js              processo, servidor HTTP
src/gateway.js            endpoints /v1, fallback, relay de streaming
src/pipeline.js           montagem da chamada e conversão da resposta
src/translate/            tradução entre protocolos e parser SSE
src/routing.js            alias para alvos, rodízio de chaves
src/upstream.js           cliente HTTP com keep-alive e SSRF por conexão
src/tester.js             teste real de provedor
src/admin.js              API do painel, sessão, CSRF
src/store.js              persistência e validação
src/crypto.js             cifragem, chave mestra, senhas
src/security.js           SSRF, redação, rate limit, compatibilidade de aliases
public/                   painel (JS puro, sem build)
public/vendor/            Motion 14.6.0, Floating UI 1.8.0 e sprite Phosphor 2.1.1 (todos MIT, licenças junto)
public/fonts/             Hanken Grotesk e Geist Mono (SIL OFL, licenças junto)
public/icons/             logos dos provedores (@lobehub/icons-static-svg 1.98.0, MIT; veja LICENSE.txt)
desktop/                  app instalável (Electron 45 + electron-builder 26, MIT): main.js, ícones
.github/workflows/        geração dos instaladores .exe e .dmg
data/                     criado na execução; não versionar
```
