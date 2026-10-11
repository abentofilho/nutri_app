import { LOGO, icon } from '../icons.js';
import * as store from '../store.js';
import { busy, passwordField } from '../ui.js';
import { startGitHubLogin } from '../github.js';
import { openPrivacy } from '../privacy.js';
import { $, esc, loadScript } from '../util.js';

const GOOGLE_LIB = 'https://accounts.google.com/gsi/client';

const MODES = [
  { key: 'criar', label: 'Criar conta' },
  { key: 'entrar', label: 'Entrar' },
  { key: 'convidado', label: 'Sem conta' },
];
// Telas de uma tarefa só: sem as abas e sem o botão do Google.
const FOCUSED = ['codigo', 'esqueci', 'enviado', 'redefinir'];

/**
 * Tela de entrada. `onDone(result)` é chamado depois de entrar.
 *   code       código de transferência vindo do QR (já envia)
 *   resetToken link de "esqueci minha senha" aberto do e-mail
 *   onCancel   sair da tela de nova senha sem trocar
 */
export function showWelcome(root, { onDone, onCancel, code = '', resetToken = '' } = {}) {
  let mode = resetToken ? 'redefinir' : code ? 'codigo' : 'criar';
  let sentTo = '';
  const returning = !!localStorage.getItem('nutri_user_id');
  const { config } = store.state;

  root.innerHTML = `
    <div class="welcome">
      <div class="welcome-inner">
        <div class="welcome-brand">
          ${LOGO}
          <h1>Nutri<em>App</em></h1>
          <div class="welcome-sub">seu diário nutricional</div>
          <p>Registre o que comeu, acompanhe calorias e macros e compartilhe o seu dia.</p>
        </div>
        ${returning ? `<div class="notice ok" style="margin:18px 0 0">${icon('info')}<div>As refeições que você salvou na versão anterior vêm junto quando você entrar neste navegador.</div></div>` : ''}
        <div class="card">
          <div class="social">
            <div class="gsi-slot" hidden></div>
            <div class="divider gsi-divider" hidden>ou</div>
          </div>
          <div class="seg mode-seg" role="tablist" style="margin-bottom:14px;justify-content:center"></div>
          <div class="mode-body"></div>
          <p class="form-error" role="alert"></p>
        </div>
        <div class="welcome-links">
          <button class="link-btn code-link" data-mode="codigo">${icon('phone')}Tenho um código de outro aparelho</button>
          <button class="link-btn subtle" data-act="privacy">Privacidade</button>
          <button class="link-btn subtle" data-act="github" hidden>${icon('shield')}Administrador? Entrar com GitHub</button>
        </div>
      </div>
    </div>`;

  const body = $('.mode-body', root);
  const error = $('.form-error', root);

  function paint() {
    const focused = FOCUSED.includes(mode);
    error.textContent = '';
    $('.mode-seg', root).hidden = focused;
    $('.social', root).hidden = focused;
    $('.code-link', root).hidden = focused;
    $('.mode-seg', root).innerHTML = MODES.map((m) =>
      `<button class="chip" role="tab" data-mode="${m.key}" aria-selected="${m.key === mode}" aria-pressed="${m.key === mode}">${m.label}</button>`).join('');

    const forms = {
      entrar: `
        <form data-form="login">
          <label class="field"><span class="field-label">E-mail</span>
            <input class="input" type="email" name="email" autocomplete="email" required></label>
          ${passwordField('Senha', 'senha', 'current-password', { minlength: false })}
          <button class="btn primary block" style="margin-top:16px">Entrar</button>
          ${config.email_enabled ? '<p class="form-foot"><button type="button" class="link-btn" data-mode="esqueci">Esqueci minha senha</button></p>' : ''}
        </form>`,
      criar: `
        <form data-form="register">
          <label class="field"><span class="field-label">Seu nome</span>
            <input class="input" name="nome" autocomplete="given-name" maxlength="60" required></label>
          <label class="field"><span class="field-label">E-mail</span>
            <input class="input" type="email" name="email" autocomplete="email" required></label>
          ${passwordField('Senha (mínimo 8 caracteres)', 'senha', 'new-password')}
          <button class="btn primary block" style="margin-top:16px">Criar conta</button>
        </form>`,
      convidado: `
        <form data-form="guest">
          <label class="field"><span class="field-label">Como podemos te chamar?</span>
            <input class="input" name="nome" autocomplete="given-name" maxlength="60" placeholder="ex: Ana" required></label>
          <button class="btn primary block" style="margin-top:16px">Entrar sem conta</button>
          <p class="field-hint" style="text-align:center">Os dados ficam só neste aparelho. Dá para criar a conta depois, no Perfil, sem perder nada.</p>
        </form>`,
      codigo: `
        <form data-form="code">
          <label class="field"><span class="field-label">Código de transferência</span>
            <input class="input num" name="code" autocomplete="one-time-code" maxlength="9" placeholder="ABCD-2345"
                   style="text-transform:uppercase;letter-spacing:.1em;font-size:22px;text-align:center" value="${esc(code)}" required></label>
          <p class="field-hint">No aparelho onde você já usa o app: Perfil › Outro aparelho.</p>
          <button class="btn primary block" style="margin-top:12px">Entrar com o código</button>
          <button type="button" class="btn ghost block" data-mode="entrar" style="margin-top:6px">Voltar</button>
        </form>`,
      esqueci: `
        <form data-form="forgot">
          <h2 class="form-title">Esqueci minha senha</h2>
          <p class="muted" style="margin:0 0 14px">Informe o e-mail da conta. Enviamos um link para você criar uma senha nova.</p>
          <label class="field"><span class="field-label">E-mail</span>
            <input class="input" type="email" name="email" autocomplete="email" required></label>
          <button class="btn primary block" style="margin-top:16px">Enviar link</button>
          <button type="button" class="btn ghost block" data-mode="entrar" style="margin-top:6px">Voltar</button>
        </form>`,
      enviado: `
        <div class="sent">
          <span class="sent-ic">${icon('mail')}</span>
          <h2 class="form-title">Confira seu e-mail</h2>
          <p class="muted">Se existir uma conta com <b>${esc(sentTo)}</b>, o link chega em instantes. Ele vale por 30 minutos. Olhe também a caixa de spam.</p>
          <button type="button" class="btn soft block" data-mode="entrar">Voltar para entrar</button>
        </div>`,
      redefinir: `
        <form data-form="reset">
          <h2 class="form-title">Criar nova senha</h2>
          ${passwordField('Nova senha (mínimo 8 caracteres)', 'senha', 'new-password')}
          <button class="btn primary block" style="margin-top:16px">Salvar e entrar</button>
          <button type="button" class="btn ghost block" data-act="cancel-reset" style="margin-top:6px">Cancelar</button>
        </form>`,
    };
    body.innerHTML = forms[mode];
    const first = $('input', body);
    if (first && !first.value && window.matchMedia('(pointer: fine)').matches) first.focus();
  }

  root.onclick = (e) => {
    const m = e.target.closest('[data-mode]');
    if (m) {
      mode = m.dataset.mode;
      paint();
    }
    if (e.target.closest('[data-act=github]')) startGitHubLogin(config.github_client_id);
    if (e.target.closest('[data-act=privacy]')) openPrivacy();
    if (e.target.closest('[data-act=cancel-reset]')) {
      if (onCancel) onCancel();
      else {
        mode = 'entrar';
        paint();
      }
    }
  };

  async function run(btn, fn, then = onDone) {
    error.textContent = '';
    try {
      const result = await busy(btn, fn);
      then?.(result);
    } catch (err) {
      error.textContent = err.message;
    }
  }

  root.onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = $('button:not([type=button])', f);
    switch (f.dataset.form) {
      case 'login':
        run(btn, () => store.login(f.email.value, f.senha.value));
        break;
      case 'register':
        run(btn, () => store.register(f.nome.value, f.email.value, f.senha.value));
        break;
      case 'guest':
        run(btn, () => store.enterAsGuest(f.nome.value));
        break;
      case 'code':
        run(btn, () => store.redeemTransfer(f.code.value));
        break;
      case 'forgot':
        sentTo = f.email.value.trim();
        run(btn, () => store.forgotPassword(sentTo), () => {
          mode = 'enviado';
          paint();
        });
        break;
      case 'reset':
        run(btn, () => store.resetPassword(resetToken, f.senha.value));
        break;
      default:
    }
  };

  paint();
  setupGoogle(root, (credential) => run($('.gsi-slot', root), () => store.loginWithGoogle(credential)));
  $('[data-act=github]', root).hidden = !config.github_client_id;
  if (code) {
    const f = $('[data-form=code]', root);
    run($('button', f), () => store.redeemTransfer(f.code.value));
  }
}

async function setupGoogle(root, onCredential) {
  const clientId = store.state.config.google_client_id;
  if (!clientId) return;
  try {
    await loadScript(GOOGLE_LIB);
    const slot = $('.gsi-slot', root);
    if (!slot) return;
    slot.hidden = false;
    $('.gsi-divider', root).hidden = false;
    window.google.accounts.id.initialize({ client_id: clientId, callback: (r) => onCredential(r.credential) });
    window.google.accounts.id.renderButton(slot, {
      theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', locale: 'pt-BR',
      width: Math.min(360, slot.clientWidth || 320),
    });
  } catch {
    /* sem o Google, as outras formas de entrar continuam */
  }
}
