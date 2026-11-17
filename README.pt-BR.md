# Rotaz

**Qualquer modelo no seu Claude Code.** · [Read in English](README.md)

O Rotaz é um gateway local que faz o Claude Code e o Claude Desktop usarem modelos de outros provedores: OpenAI, Gemini, DeepSeek, OpenRouter, modelos locais e dezenas de outros. Ele traduz entre as APIs da Anthropic e da OpenAI na sua máquina e vem com um painel web para gerenciar provedores, chaves e modelos.

Criado por **Alisson Paganini**.

## Baixar

Pegue o arquivo do seu sistema na [Release mais recente](https://github.com/alissonpaganini/rotaz/releases/latest):

| Sistema | Arquivo |
| --- | --- |
| Windows 10/11 | `Rotaz-<versão>-Windows-x64-Setup.exe` |
| macOS (Apple Silicon e Intel) | `Rotaz-<versão>-macOS-universal.dmg` |
| Ubuntu / Debian | `Rotaz-<versão>-Linux-amd64.deb` |
| Outros Linux (x64) | `Rotaz-<versão>-Linux-x86_64.AppImage` |

Os instaladores ainda não têm assinatura digital, então o sistema pede confirmação na primeira vez:

- **Windows:** o SmartScreen mostra "O Windows protegeu o computador". Clique em **Mais informações → Executar assim mesmo**.
- **macOS:** clique com o botão direito no app → **Abrir**, ou permita em **Ajustes do Sistema → Privacidade e Segurança**.
- **Linux:** instale o `.deb` com `sudo apt install ./Rotaz-*.deb`. Para o AppImage, rode `chmod +x Rotaz-*.AppImage` (no Ubuntu 22.04 ou mais novo pode faltar o FUSE 2: `libfuse2t64`).

No Windows, o app se atualiza sozinho. No macOS e no Linux, ele mostra o link para baixar.

## Começo rápido

1. Abra o Rotaz e crie a senha do painel.
2. **Adicione um provedor:** entre com uma conta (GitHub Copilot, ChatGPT, Kimi, Google Antigravity e outros) ou cole uma chave de API. Importe os modelos e teste todos de uma vez.
3. **Conecte o Claude:** o painel configura o Claude Desktop com um clique. Para o Claude Code no terminal, a aba **Claude Code** mostra o endereço e o token para copiar:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_AUTH_TOKEN": "<token do gateway>",
    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY": "1"
  }
}
```

Junte isso ao `~/.claude/settings.json` (faça uma cópia do arquivo antes).

### Rodar pelo código-fonte

Requer Node 20.11 ou superior. Nenhuma dependência para instalar.

```bash
npm start
```

O painel abre em <http://127.0.0.1:8787/>. No Windows, dê dois cliques em `Iniciar.cmd`.

## Recursos

- **Tradução nos dois sentidos.** O Claude Code fala Anthropic Messages; a maioria dos provedores fala OpenAI Chat Completions. O Rotaz também fala Gemini (Google Antigravity) e a API Responses da OpenAI.
- **Roteamento.** Cada alias público (`claude-*`) aponta para um provedor e um modelo real. As chaves revezam sozinhas, e o fallback opcional tenta o próximo provedor antes de qualquer byte chegar ao cliente.
- **Entrar com a conta.** Provedores que funcionam por assinatura conectam pelo login da conta, sem copiar chave de API.
- **Testes.** Chamadas reais pelo mesmo caminho do tráfego: texto, streaming e ferramentas.
- **Gasto e orçamento.** Custo do dia e do mês por provedor, com limites que avisam, bloqueiam ou trocam para um modelo mais barato.
- **Backup do perfil.** Exporte provedores, modelos e rotas num arquivo cifrado com senha e importe em outro computador.
- **Oito idiomas:** português (Brasil), inglês, espanhol, chinês simplificado, japonês, coreano, alemão e francês.

### Nomes dos modelos no Claude Desktop

O Claude Code só lista modelos com `claude` no nome, por isso os aliases começam com `claude-`. O seletor de modelos do Claude Desktop também esconde nomes que citam outros fornecedores (`gpt`, `gemini`, `deepseek` e outros). O painel diz onde cada alias aparece e sugere nomes que servem para os dois, como `claude-gpt-4o` → `claude-gept-4o`.

## Privacidade e segurança

- Tudo roda na sua máquina. As chaves ficam cifradas (AES-256-GCM) e nunca voltam ao navegador.
- A chave mestra é protegida pelo DPAPI do Windows, pelo Keychain do macOS ou pelo Secret Service do Linux.
- O painel só responde nesta máquina, com CSP estrita e proteção contra CSRF e DNS rebinding. As chamadas de saída são conferidas contra SSRF.
- Os seus dados ficam em `%APPDATA%\Rotaz\data` (Windows), `~/Library/Application Support/Rotaz/data` (macOS) ou `~/.config/Rotaz/data` (Linux). Atualizar ou desinstalar não mexe neles.
- A consulta de atualização envia só o seu IP e a versão instalada, e pode ser desligada em **Configurações → Sistema e segurança**.

## Gerar e publicar

```bash
cd desktop
npm install
npm run dist:win     # dist:mac num Mac, dist:linux no Linux
```

Para publicar uma versão, suba o `version` em `package.json` e `desktop/package.json`, escreva a versão no [CHANGELOG.md](CHANGELOG.md) e envie a tag (`git tag v1.2.0 && git push origin v1.2.0`). O GitHub Actions gera todos os instaladores e publica a Release, com as notas tiradas do changelog.

## Créditos

O Rotaz foi criado por **Alisson Paganini**. Se você usar, fizer um fork ou redistribuir, mantenha este crédito e o aviso de copyright da [licença](LICENSE).

Bibliotecas e recursos incluídos, todos MIT ou SIL OFL, com as licenças junto: Motion, Floating UI, Phosphor Icons, Hanken Grotesk, Geist Mono e logos de provedores do `@lobehub/icons`.

## Licença

[MIT](LICENSE) © 2026 Alisson Paganini
