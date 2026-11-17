// Página de retorno do login OAuth (callback do Google). O painel acompanha o login perguntando ao servidor,
// então aqui só falta fechar o popup. Sem opener (navegação na própria aba), a página fica com a mensagem e o link.
(() => {
  if (!document.getElementById('oauth-result')?.textContent) return;
  if (window.opener && !window.opener.closed) setTimeout(() => window.close(), 300);
})();
