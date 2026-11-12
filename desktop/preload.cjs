// Ponte mínima entre o painel e a janela. Expõe só os controles da janela, a preferência de fechar e a abertura:
// nada de Node, arquivos ou rede.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rotazDesktop', {
  platform: process.platform,
  minimize: () => ipcRenderer.send('rotaz:window', 'minimize'),
  toggleMaximize: () => ipcRenderer.send('rotaz:window', 'toggle-maximize'),
  close: () => ipcRenderer.send('rotaz:window', 'close'),
  isMaximized: () => ipcRenderer.invoke('rotaz:is-maximized'),
  onMaximized: (cb) => ipcRenderer.on('rotaz:maximized', (_e, value) => cb(!!value)),
  // O que acontece ao fechar a janela: 'tray' ou 'quit'. É do app, vale para qualquer gateway que ele abrir.
  getCloseAction: () => ipcRenderer.invoke('rotaz:close-action'),
  setCloseAction: (value) => ipcRenderer.invoke('rotaz:close-action', value),
  // Abertura animada: mostra só na primeira vez que o app abre.
  shouldShowSplash: () => ipcRenderer.invoke('rotaz:splash'),
  markSplashSeen: () => ipcRenderer.invoke('rotaz:splash', true),
  // Atualização automática (Windows): estado, verificar agora e reiniciar para instalar.
  updateState: () => ipcRenderer.invoke('rotaz:update'),
  updateAction: (action) => ipcRenderer.invoke('rotaz:update', action),
  onUpdate: (cb) => ipcRenderer.on('rotaz:update', (_e, state) => cb(state)),
});
