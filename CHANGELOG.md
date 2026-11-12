# Novidades

O que mudou em cada versão do Rotaz. Os instaladores ficam nas [Releases](https://github.com/alissonpaganini/rotaz/releases).

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
