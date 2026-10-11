// Login com GitHub, de dois jeitos (o servidor diz qual em /api/config):
//
//  - por código: o app mostra um código, a pessoa digita em
//    github.com/login/device e o app entra sozinho. Não precisa de segredo no
//    servidor.
//  - por redirecionamento (quando o servidor tem GITHUB_CLIENT_SECRET): o app
//    manda a pessoa para o github.com, que volta para a mesma página com
//    ?code=...&state=... na URL. O state confere que a volta é deste navegador.

import { icon } from './icons.js';
import * as store from './store.js';
import { afterSheetBack, openSheet, toast } from './ui.js';
import { appUrl, esc } from './util.js';

const STATE_KEY = 'nutri_github_state';

/** Entra pelo GitHub ou, com sessão aberta, vincula o GitHub à conta atual. */
export function signInWithGitHub(onDone) {
  const { github_client_id: clientId, github_device_flow: byCode } = store.state.config;
  if (byCode) openCodeLogin(onDone);
  else startGitHubLogin(clientId);
}

function startGitHubLogin(clientId) {
  const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  sessionStorage.setItem(STATE_KEY, state);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: appUrl(),
    scope: 'read:user user:email',
    state,
  });
  location.assign(`https://github.com/login/oauth/authorize?${params}`);
}

/** Lê (e limpa da URL) a volta do GitHub. null quando não é uma volta. */
export function takeGitHubCallback() {
  const query = new URLSearchParams(location.search);
  const code = query.get('code');
  const error = query.get('error');
  if (!code && !error) return null;
  const expected = sessionStorage.getItem(STATE_KEY);
  sessionStorage.removeItem(STATE_KEY);
  history.replaceState(null, '', location.pathname + (location.hash || '#/hoje'));
  if (error) return { error: 'Login com GitHub cancelado.' };
  if (!expected || query.get('state') !== expected) return { error: 'Não foi possível confirmar o login com GitHub. Tente de novo.' };
  return { code };
}

function openCodeLogin(onDone) {
  let device = null;
  let waitMs = 5000;
  let timer = 0;
  let lastPoll = 0;
  let polling = false;
  let closed = false;

  const sheet = openSheet({
    title: 'Entrar com GitHub',
    onClose: () => {
      closed = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    },
  });
  const step = (n, html) => `<li class="guide-step"><span class="guide-n">${n}</span><div>${html}</div></li>`;

  function fail(message) {
    clearTimeout(timer);
    device = null;
    sheet.setBody(`<div class="notice warn">${icon('info')}<div>${esc(message)}</div></div>`);
    sheet.setFooter('<button class="btn soft" data-close>Fechar</button><button class="btn primary" data-act="retry">Gerar outro código</button>');
  }

  async function begin() {
    sheet.setBody('<p class="muted device-wait">Gerando o código…</p>');
    sheet.setFooter('');
    try {
      device = await store.startGitHubDevice();
    } catch (err) {
      fail(err.message);
      return;
    }
    if (closed) return;
    waitMs = device.interval * 1000;
    sheet.setBody(`
      <div class="transfer-code" aria-label="Código para digitar no GitHub">${esc(device.user_code)}</div>
      <ol class="guide" style="margin-top:18px">
        ${step(1, 'Toque no botão abaixo. Ele copia o código e abre o GitHub.')}
        ${step(2, 'No GitHub, cole o código e toque em <b>Authorize</b>.')}
        ${step(3, 'Volte para esta tela. O app entra sozinho.')}
      </ol>
      <p class="faint device-wait" role="status">Aguardando a confirmação no GitHub…</p>`);
    sheet.setFooter(`<a class="btn primary" data-act="open" href="${esc(device.verification_uri)}" target="_blank" rel="noopener">${icon('copy')}Copiar código e abrir o GitHub</a>`);
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(poll, waitMs + 1000);
  }

  async function poll() {
    if (closed || polling || !device) return;
    polling = true;
    lastPoll = Date.now();
    try {
      const result = await store.pollGitHubDevice(device.device_code);
      if (result.pending) {
        if (result.interval) waitMs = result.interval * 1000;
        schedule();
        return;
      }
      sheet.close();
      afterSheetBack(() => {
        onDone?.(result);
        if (store.state.user.is_admin) setTimeout(() => toast('Você entrou como administrador do catálogo.'), 1200);
      });
    } catch (err) {
      // Queda de internet ou servidor acordando: continua tentando.
      if (!err.status || err.status >= 500) schedule();
      else if (!closed) fail(err.message);
    } finally {
      polling = false;
    }
  }

  // O navegador pausa os temporizadores enquanto a pessoa está na aba do
  // GitHub; ao voltar, confere na hora (respeitando o intervalo do GitHub).
  function onVisible() {
    if (document.visibilityState !== 'visible' || !device) return;
    clearTimeout(timer);
    timer = setTimeout(poll, Math.max(0, lastPoll + waitMs + 1000 - Date.now()));
  }
  document.addEventListener('visibilitychange', onVisible);

  sheet.el.addEventListener('click', (e) => {
    if (e.target.closest('[data-act=retry]')) begin();
    // Sem preventDefault: o link segue para o GitHub em outra aba.
    if (e.target.closest('[data-act=open]')) navigator.clipboard?.writeText(device.user_code).catch(() => {});
  });

  begin();
}
