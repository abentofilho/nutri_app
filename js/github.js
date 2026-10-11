// Login com GitHub (OAuth). O app manda a pessoa para o github.com, que volta
// para a mesma página com ?code=...&state=... na URL. O backend troca o code
// pelos dados da conta; o state confere que a volta é deste navegador.

import { appUrl } from './util.js';

const STATE_KEY = 'nutri_github_state';

export function startGitHubLogin(clientId) {
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
