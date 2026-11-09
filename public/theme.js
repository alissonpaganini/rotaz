// Aplica tema e paleta antes da primeira pintura, para não piscar o tema errado.
(function () {
  try {
    var ui = JSON.parse(localStorage.getItem('rotaz.ui') || '{}');
    if (ui.theme === 'light' || ui.theme === 'dark') document.documentElement.dataset.theme = ui.theme;
    if (ui.palette) document.documentElement.dataset.palette = ui.palette;
  } catch (e) { /* sem armazenamento: segue o sistema */ }
})();
