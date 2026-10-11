// Instalação do app na tela inicial (PWA).
// Android/Chrome: o navegador dispara "beforeinstallprompt" e o botão Instalar
// abre a janela nativa. iPhone/Safari: não existe esse evento; mostramos o
// passo a passo do menu Compartilhar.

import { icon } from './icons.js';
import { openSheet } from './ui.js';
import { storage } from './util.js';

const DISMISS_KEY = 'nutri_install_dismissed';
let deferredPrompt = null;
const listeners = new Set();

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  listeners.forEach((fn) => fn());
});
window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  storage(DISMISS_KEY, true);
  listeners.forEach((fn) => fn());
});

export const onInstallChange = (fn) => listeners.add(fn);

export const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

// iPadOS se apresenta como Mac; o toque denuncia.
export const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const isMobile = () => isIOS() || /android/i.test(navigator.userAgent);

/** Dá para oferecer a instalação agora? */
export function canInstall() {
  if (isStandalone()) return false;
  return !!deferredPrompt || isIOS();
}

/** O convite na tela Hoje: só no celular, e some depois de fechado. */
export const shouldInvite = () => canInstall() && isMobile() && !storage(DISMISS_KEY);
export const dismissInvite = () => storage(DISMISS_KEY, true);

export async function install() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    listeners.forEach((fn) => fn());
    return;
  }
  openIOSGuide();
}

function openIOSGuide() {
  const step = (n, html) => `<li class="guide-step"><span class="guide-n">${n}</span><div>${html}</div></li>`;
  openSheet({
    title: 'Instalar no iPhone',
    subtitle: 'Leva 10 segundos',
    body: `
      <ol class="guide">
        ${step(1, `Toque em <b>Compartilhar</b> <span class="guide-ic">${icon('share')}</span> na barra do Safari.`)}
        ${step(2, `Role a lista e escolha <b>Adicionar à Tela de Início</b> <span class="guide-ic">${icon('plus')}</span>.`)}
        ${step(3, 'Toque em <b>Adicionar</b>. O ícone aparece junto dos seus apps.')}
      </ol>
      <div class="notice" style="margin-top:16px">${icon('info')}
        <div>No iPhone, o app instalado guarda os dados separado do Safari. Ao abrir pela primeira vez,
        entre com a sua conta ou use <b>Perfil › Usar em outro aparelho</b>.</div>
      </div>`,
    footer: '<button class="btn primary" data-close>Entendi</button>',
  });
}
