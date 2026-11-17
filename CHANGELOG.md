# Novidades

O que mudou em cada versão do Rotaz. Os instaladores ficam nas [Releases](https://github.com/alissonpaganini/rotaz/releases).

## 1.2.0 · 17 de novembro de 2026

### Novo

- **Entrar com a conta.** GitHub Copilot, ChatGPT, OpenAI Codex, Kimi Code, xAI (Grok), Cline, ClinePass, Kilo Code, DeepSeek Platform, Google Antigravity e outros conectam pelo login da própria conta, sem copiar chave de API. A lista de modelos da conta vem junto. Os que só funcionam com plano pago avisam antes de conectar.
- **Claude Desktop em um clique.** O Rotaz liga o modo de desenvolvedor, aponta o Claude Desktop para o gateway e confere cada ajuste ao vivo, com um guia visual por sistema para quem prefere fazer à mão. A visão geral mostra o passo a passo até tudo estar certo.
- **Adicionar provedor guiado.** Um assistente pergunta se você vai entrar com uma conta ou usar uma chave de API e leva até o primeiro modelo funcionando.
- **Importar modelos testando.** Traga a lista do provedor, teste todos de uma vez e adicione só os que respondem.
- **Atualização obrigatória.** No app instalado, uma versão nova trava o painel até atualizar. No Windows o app baixa sozinho e reinicia já na versão nova; no macOS e no Linux, o botão baixa o instalador. Provedores, modelos, chaves e configurações continuam como estão.
- **Novidades.** Depois de atualizar, o app mostra uma vez o que mudou, com animações de cada novidade.
- **Um Rotaz por vez.** Abrir um segundo Rotaz não briga mais pelo mesmo endereço e porta: ele avisa e traz a janela do que já está aberto.
- **Instaladores.** No Windows, o instalador tem etapas, com licença, escolha de quem usa e da pasta. No macOS, o DMG tem fundo com a marca e a licença. No Linux, além do AppImage, há o pacote `.deb`.

### Melhorias

- **Conta do Google travada.** Quando o Google pede para verificar uma conta do Antigravity, o painel e o Claude Code explicam como liberar. Modelo fora do plano da conta aparece como indisponível, não como endereço errado.
- **Botão Testar igual ao tráfego real.** O teste agora usa o mesmo caminho do gateway, inclusive o reenvio com menos imagens e o ajuste de parâmetros.
- **Ícone do app.** O Windows mostra o ícone do Rotaz na barra de tarefas, não o do Electron.

### Correções

- Chamadas de ferramenta do Gemini (Antigravity) em streaming perdiam a assinatura e falhavam no turno seguinte.
- Respostas em SSE que começavam com linha em branco não eram lidas.
- Pedido no formato OpenAI para um provedor que só fala Responses voltava como erro interno (500), e agora volta como erro do pedido (400). Conta sem token passa a vez para a próxima.
- Contas OAuth pausadas voltavam ativas ao importar um backup.
- A conta xAI sugeria o mesmo alias do provedor xAI por chave.

### Desempenho

- Cabeçalhos dos provedores e a lista de aliases deixaram de ser recalculados a cada pedido.
- O painel guarda seus arquivos em memória e a visão geral confere a configuração com menos pedidos.

## 1.1.0 · 12 de novembro de 2026

### Novo

- **Linux.** App em AppImage para x64, ao lado de Windows e macOS. Inicia com o sistema e guarda as chaves no cofre do sistema (Secret Service).
- **Custos e orçamento.** Gasto do dia e do mês por provedor, a partir do preço de cada modelo. Limites diário e mensal que avisam, recusam pedidos ou passam para um modelo de reserva.
- **Backup.** Exporte o perfil inteiro (provedores, chaves, modelos e rotas) num arquivo cifrado com senha e importe em outro computador.
- **Atualização automática.** No Windows, a versão nova é baixada em segundo plano e instalada quando o app reinicia. No macOS e no Linux, o app avisa e mostra o link.
- **Nomes para o CLI e o Desktop.** Enquanto você digita um alias, o painel diz se ele aparece só no Claude Code do terminal ou também no seletor do Claude Desktop, e sugere grafias que servem para os dois (`claude-gpt-4o` vira `claude-gept-4o`). Dá para ajustar vários de uma vez, e o roteamento acompanha.

### Melhorias

- **Testes de modelos.** Marque os modelos que quiser e teste. Os que você pede durante uma rodada entram na mesma fila, cada teste tem prazo total e **Interromper** para na hora, inclusive o que já estava no provedor.
- **Rota ativa.** Quando não há rota, o painel diz o motivo (provedor desligado, sem chave, modelo desativado) e mostra o botão que resolve, como ligar o provedor.
- **Claude Desktop.** O passo a passo usa os nomes dos menus do próprio Claude Desktop, no idioma do painel.
- **Instaladores.** O nome de cada arquivo diz o sistema: `Rotaz-1.1.0-Windows-x64-Setup.exe`, `Rotaz-1.1.0-macOS-universal.dmg` e `Rotaz-1.1.0-Linux-x86_64.AppImage`.

### Desempenho

- **Menos processador.** Com a Visão geral aberta, o app passou de cerca de 31% para 0,2% de um núcleo do processador.
- **Telas que se atualizam.** A Visão geral e os Registros param de atualizar com a janela escondida e só redesenham quando algo muda.

## 1.0.0 · 9 de novembro de 2026

Primeira versão.

- **Gateway local.** Traduz entre OpenAI e Anthropic para o Claude Code usar outros provedores, com fallback e revezamento de chaves.
- **Painel.** Visão geral, provedores, roteamento, configuração do Claude Code e registros, em oito idiomas.
- **Catálogo.** 49 provedores com endereço e protocolo prontos.
- **App.** Para Windows e macOS, com bandeja do sistema. Também roda pelo terminal com Node.js.
