// Ponto de entrada: monta a casca do app, cuida das rotas (#/hoje, #/despensa…)
// e decide entre a tela de entrada e o app.

import { getToken, onSlowChange } from './api.js';
import { APP_NAME } from './config.js';
import { takeGitHubCallback } from './github.js';
import { LOGO, icon } from './icons.js';
import { slotForNow } from './nutrition.js';
import * as store from './store.js';
import { openPicker } from './sheets/picker.js';
import { afterSheetBack, closeAllSheets, confirmDialog, sheetBackPending, toast } from './ui.js';
import { $, $$, appUrl, esc, initials, isoDay } from './util.js';
import * as admin from './views/admin.js';
import * as historyView from './views/history.js';
import * as pantry from './views/pantry.js';
import * as profile from './views/profile.js';
import * as recipes from './views/recipes.js';
import * as today from './views/today.js';
import { showWelcome } from './views/welcome.js';

const ROUTES = { hoje: today, despensa: pantry, receitas: recipes, historico: historyView, perfil: profile, curadoria: admin };

const NAV = [
  { key: 'hoje', label: 'Hoje', icon: 'today' },
  { key: 'despensa', label: 'Despensa', icon: 'pantry' },
  { key: 'add' },
  { key: 'receitas', label: 'Receitas', icon: 'recipes' },
  { key: 'historico', label: 'Histórico', icon: 'history' },
];

const root = document.getElementById('app');
let current = null;     // { name, params, view, el }
let started = false;

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] || 'hoje', params: parts.slice(1) };
}

// ---------- casca ----------

function renderShell() {
  root.innerHTML = `
    <div class="app">
      <header class="topbar">
        <a class="brand" href="#/hoje" aria-label="${APP_NAME}, início">
          ${LOGO}
          <span class="brand-name">Nutri<em>App</em></span>
        </a>
        <nav class="topbar-nav" aria-label="Seções">
          ${NAV.filter((n) => n.label).map((n) => `<a href="#/${n.key}" data-nav="${n.key}">${n.label}</a>`).join('')}
        </nav>
        <span class="topbar-spacer"></span>
        <button class="btn primary sm btn-add-desktop" data-act="quick-add">${icon('plus')}Registrar</button>
        <a class="avatar" href="#/perfil" data-nav="perfil" aria-label="Perfil"></a>
      </header>
      <div class="sync-note" hidden role="status">
        <span class="spinner"></span>
        <span>Conectando ao servidor. Depois de um tempo parado, ele pode levar até um minuto para responder.</span>
      </div>
      <main id="view" tabindex="-1"></main>
    </div>
    <nav class="tabbar" aria-label="Seções">
      ${NAV.map((n) => (n.key === 'add'
        ? `<button class="tab tab-add" data-act="quick-add" aria-label="Registrar alimento"><span class="fab">${icon('plus')}</span></button>`
        : `<a class="tab" href="#/${n.key}" data-nav="${n.key}">${icon(n.icon)}<span>${n.label}</span></a>`)).join('')}
    </nav>`;
}

function onQuickAdd(e) {
  if (!started || !e.target.closest('[data-act="quick-add"]')) return;
  const { name, params } = parseHash();
  const day = name === 'hoje' && /^\d{4}-\d{2}-\d{2}$/.test(params[0] || '') ? params[0] : isoDay();
  openPicker({ day, slot: slotForNow() });
}

function paintChrome(name) {
  $$('[data-nav]', root).forEach((a) => {
    if (a.dataset.nav === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const avatar = $('.avatar', root);
  if (avatar && store.state.user) avatar.textContent = initials(store.state.user.nome);
}

// ---------- rotas ----------

function navigate() {
  const { name, params } = parseHash();
  if (name === 'codigo') {
    handleTransferLink(params[0]);
    return;
  }
  if (name === 'confirmar') {
    handleVerifyLink(params[0]);
    return;
  }
  if (name === 'redefinir') {
    handleResetLink(params[0]);
    return;
  }
  if (!started) return;
  const view = ROUTES[name] || today;
  closeAllSheets();

  const el = document.createElement('div');
  el.className = 'view';
  el.innerHTML = view.render(params);
  $('#view', root).replaceChildren(el);
  view.mount?.(el, params);
  current = { name, params, view, el };
  paintChrome(ROUTES[name] ? name : 'hoje');
  document.title = `${view.title} · ${APP_NAME}`;
  window.scrollTo(0, 0);
}

function rerender() {
  if (!current) return;
  paintChrome(current.name);
  const { view, el, params } = current;
  if (view.update) view.update(el, params);
  else if (!view.keepOnUpdate?.(el)) el.innerHTML = view.render(params);
}

// ---------- entrar / sair ----------

function startApp() {
  started = true;
  renderShell();
  navigate();
}

function welcome({ code = '', resetToken = '' } = {}) {
  started = false;
  current = null;
  closeAllSheets();
  document.title = APP_NAME;
  showWelcome(root, {
    code,
    resetToken,
    onCancel: () => (store.state.user ? startApp() : welcome()),
    onDone: ({ claimed } = {}) => {
      history.replaceState(null, '', '#/hoje');
      startApp();
      toast(`Olá, ${store.state.user.nome.split(' ')[0]}!`);
      if (claimed) setTimeout(() => toast(`Trouxemos ${claimed} ${claimed === 1 ? 'refeição' : 'refeições'} da versão anterior para Minhas receitas.`), 1200);
    },
  });
}

/** Link "confirmar e-mail" aberto do e-mail. */
async function handleVerifyLink(token = '') {
  history.replaceState(null, '', '#/hoje');
  try {
    await store.verifyEmail(token);
    toast('E-mail confirmado.');
  } catch (err) {
    toast(err.message, { error: true });
  }
  if (store.state.user) navigate();
}

/** Link "criar nova senha" aberto do e-mail. */
function handleResetLink(token = '') {
  history.replaceState(null, '', '#/hoje');
  welcome({ resetToken: token });
}

async function handleTransferLink(code = '') {
  if (!store.state.user) {
    welcome({ code });
    return;
  }
  history.replaceState(null, '', '#/hoje');
  if (await confirmDialog({
    title: 'Entrar com outra conta?',
    message: `Você está conectado como <b>${esc(store.state.user.nome)}</b>. O código abre a conta de outro aparelho neste navegador.`,
    confirm: 'Trocar de conta',
  })) {
    store.clearSession();
    welcome({ code });
  } else {
    navigate();
  }
}

async function finishGitHub(result, configReady) {
  const wasLoggedIn = store.restoreCache();
  root.innerHTML = `<div class="boot">${LOGO}<span>Entrando com GitHub…</span></div>`;
  await configReady;
  if (result.error) {
    if (wasLoggedIn) startApp();
    else welcome();
    toast(result.error, { error: true });
    return;
  }
  try {
    await store.loginWithGitHub(result.code, appUrl());
    startApp();
    const u = store.state.user;
    toast(wasLoggedIn ? 'Conta do GitHub vinculada.' : `Olá, ${u.nome.split(' ')[0]}!`);
    if (u.is_admin) setTimeout(() => toast('Você entrou como administrador do catálogo.'), 1200);
  } catch (err) {
    if (wasLoggedIn) startApp();
    else welcome();
    toast(err.message, { error: true });
  }
}

function handleRefreshError(err) {
  if (err?.status === 401) {
    store.clearSession();
    toast('Sua sessão terminou. Entre de novo.', { error: true });
  } else if (!navigator.onLine || err?.status === 0) {
    toast('Sem conexão: mostrando os dados salvos neste aparelho.');
  } else {
    toast(err.message, { error: true });
  }
}

// ---------- início ----------

// Uma sheet que acabou de fechar ainda está desfazendo sua entrada no
// histórico (history.back é assíncrono, e lento no Safari). Um toque num link
// nesse meio tempo seria desfeito por esse "voltar"; então o link espera.
function onLinkWhileClosing(e) {
  const a = e.target.closest('a[href^="#/"]');
  if (!a || !sheetBackPending()) return;
  e.preventDefault();
  afterSheetBack(() => {
    location.hash = a.getAttribute('href');
  });
}

async function boot() {
  document.addEventListener('click', onLinkWhileClosing, true);
  root.addEventListener('click', onQuickAdd);
  onSlowChange((slow) => {
    const note = $('.sync-note', root);
    if (note) note.hidden = !slow;
  });

  store.subscribe(() => {
    if (!store.state.user) {
      if (started) welcome();
      return;
    }
    rerender();
  });

  window.addEventListener('hashchange', navigate);

  // Ao voltar para o app depois de um tempo, busca o que mudou (outro aparelho, virada do dia…).
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now();
    } else if (started && Date.now() - hiddenAt > 5 * 60_000) {
      store.refreshAll().catch(() => {});
      rerender();
    }
  });

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  const configReady = store.loadConfig();
  const github = takeGitHubCallback();
  const { name, params } = parseHash();

  if (github) {
    await finishGitHub(github, configReady);
    return;
  }

  if (store.restoreCache()) {
    // Abre na hora com o que está salvo e atualiza em segundo plano.
    startApp();
    configReady.then(rerender);
    store.refreshAll().catch(handleRefreshError);
    return;
  }

  root.innerHTML = `<div class="boot">${LOGO}<span>Carregando…</span></div>`;
  await configReady;
  if (name === 'redefinir') {
    handleResetLink(params[0]);
    return;
  }
  if (name === 'codigo' || !getToken()) {
    welcome({ code: name === 'codigo' ? params[0] || '' : '' });
    if (name === 'confirmar') handleVerifyLink(params[0]);
    return;
  }
  try {
    await store.refreshAll();
    startApp();
  } catch {
    store.clearSession();
    welcome();
  }
}

boot();
