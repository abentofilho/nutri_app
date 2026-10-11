import { icon } from '../icons.js';
import { DEFAULT_GOALS, MACROS } from '../nutrition.js';
import * as store from '../store.js';
import { busy, confirmDialog, openSheet, passwordField, promptDialog, toast, toastError } from '../ui.js';
import { APP_NAME } from '../config.js';
import { signInWithGitHub } from '../github.js';
import { openPrivacy } from '../privacy.js';
import { canInstall, install } from '../pwa.js';
import { $, $$, esc, fmt, initials, isoDay, loadScript, parseNum, shortDate } from '../util.js';

export const title = 'Perfil';

const QR_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
const QR_SRI = 'sha384-3zSEDfvllQohrq0PHL1fOXJuC/jSOO34H46t6UQfobFOmxE5BpjjaIJY5F2/bMnU';
const STATUS = {
  pendente: ['', 'aguardando'],
  aprovada: ['ok', 'aprovada'],
  recusada: ['no', 'recusada'],
};

function accountLine(u) {
  if (u.is_guest) return 'Convidado neste aparelho';
  return esc(u.email || (u.github_login ? `@${u.github_login}` : 'Conta Google'));
}

export function render() {
  const u = store.state.user;
  const g = store.goals();
  const { config, suggestions } = store.state;
  const linkGitHub = config.github_client_id && !u.github_login;

  return `
    <div class="card profile-card">
      <div class="profile-head">
        <span class="avatar lg">${esc(initials(u.nome))}</span>
        <div class="ph-main">
          <h2>${esc(u.nome)}</h2>
          <p>${accountLine(u)}</p>
        </div>
        <button class="icon-btn" data-act="rename" aria-label="Mudar nome">${icon('edit')}</button>
      </div>
      ${u.is_admin || u.has_google || u.github_login ? `<div class="tag-row">
        ${u.is_admin ? '<span class="badge admin">administrador</span>' : ''}
        ${u.has_google ? '<span class="badge">Google</span>' : ''}
        ${u.github_login ? `<span class="badge">GitHub @${esc(u.github_login)}</span>` : ''}
      </div>` : ''}
      ${store.needsEmailCheck() ? `
        <div class="notice warn" style="margin-top:14px">${icon('mail')}
          <div><b>E-mail ainda não confirmado</b><br>Abra o link que enviamos para ${esc(u.email)}. Sem confirmar, não dá para recuperar a conta se esquecer a senha.
            <br><button class="link-btn" data-act="resend" style="margin-top:6px">Reenviar o link</button></div>
        </div>` : ''}
      ${u.is_guest ? `
        <form class="upgrade" data-form="upgrade">
          <p class="muted">Crie uma senha para entrar de qualquer aparelho. Nada do que você registrou se perde.</p>
          <label class="field"><span class="field-label">E-mail</span>
            <input class="input" type="email" name="email" autocomplete="email" required></label>
          ${passwordField('Senha (mínimo 8 caracteres)', 'senha', 'new-password')}
          <button class="btn primary block">Criar senha</button>
        </form>` : ''}
    </div>

    ${u.is_admin ? `
      <a class="card nav-card" href="#/curadoria">
        <span class="nc-icon dark">${icon('shield')}</span>
        <span class="nc-main"><b>Curadoria do catálogo</b><span>Sugestões, edição e produtos arquivados</span></span>
        ${icon('right')}
      </a>` : ''}

    <h2 class="section-title" id="metas">Metas diárias</h2>
    <form class="card" data-form="goals">
      <div class="goal-grid">
        <label class="field"><span class="field-label">energia (kcal)</span>
          <input class="input num" name="kcal" inputmode="numeric" value="${g.kcal}"></label>
        ${MACROS.map((m) => `<label class="field"><span class="field-label"><i class="dot" style="background:${m.hex}"></i>${m.label} (g)</span>
          <input class="input num" name="${m.key}" inputmode="numeric" value="${g[m.key]}"></label>`).join('')}
        <label class="field"><span class="field-label">Água (ml)</span>
          <input class="input num" name="agua" inputmode="numeric" value="${g.agua}"></label>
      </div>
      <p class="field-hint goal-check"></p>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn primary sm">Salvar</button>
        <button type="button" class="btn soft sm" data-act="calc">${icon('calc')}Calcular para mim</button>
        <button type="button" class="btn ghost sm" data-act="reset-goals">Padrão</button>
      </div>
    </form>

    <h2 class="section-title">Outro aparelho</h2>
    <div class="card">
      <p class="muted" style="margin:0 0 12px">Gere um código e digite no outro celular ou computador, ou aponte a câmera para o QR. Vale por 10 minutos, uma vez só.</p>
      <div class="transfer"></div>
      <button class="btn soft block" data-act="transfer">${icon('phone')}Gerar código</button>
    </div>

    ${suggestions.length ? `
      <h2 class="section-title">Minhas sugestões</h2>
      <div class="card">${suggestions.map((s) => `
        <div class="list-row">
          <div class="lr-main">
            <b>${esc(s.product.nome)}</b>
            <span>${s.kind === 'novo' ? 'Produto novo' : 'Correção'} · ${shortDate(isoDay(new Date(s.created_at)))}${s.review_note ? ` · “${esc(s.review_note)}”` : ''}</span>
          </div>
          <span class="badge ${STATUS[s.status]?.[0] || ''}">${STATUS[s.status]?.[1] || esc(s.status)}</span>
        </div>`).join('')}</div>` : ''}

    <h2 class="section-title">App</h2>
    <div class="card list-card">
      <button class="list-row" data-act="install" hidden>
        <span class="nc-icon">${icon('install')}</span>
        <span class="lr-main"><b>Instalar na tela inicial</b><span>Abre em tela cheia, como um app</span></span>
        ${icon('right')}
      </button>
      ${linkGitHub ? `
        <button class="list-row" data-act="link-github">
          <span class="nc-icon">${icon('shield')}</span>
          <span class="lr-main"><b>Vincular GitHub</b><span>Para o administrador entrar pelo GitHub</span></span>
          ${icon('right')}
        </button>` : ''}
      <a class="list-row" href="#/historico">
        <span class="nc-icon">${icon('download')}</span>
        <span class="lr-main"><b>Baixar meus dados</b><span>Planilha, PDF e imagens no Histórico</span></span>
        ${icon('right')}
      </a>
      ${u.email ? `
        <button class="list-row" data-act="password">
          <span class="nc-icon">${icon('key')}</span>
          <span class="lr-main"><b>${u.has_password ? 'Trocar senha' : 'Criar senha'}</b><span>${u.has_password ? 'Os outros aparelhos são desconectados' : 'Para entrar também com e-mail e senha'}</span></span>
          ${icon('right')}
        </button>` : ''}
      <button class="list-row" data-act="revoke">
        <span class="nc-icon">${icon('phone')}</span>
        <span class="lr-main"><b>Sair dos outros aparelhos</b><span>Mantém só este conectado</span></span>
      </button>
      <button class="list-row" data-act="logout">
        <span class="nc-icon">${icon('logout')}</span>
        <span class="lr-main"><b>Sair</b><span>${u.is_guest ? 'Sem senha, você não volta a esta conta' : 'Seus dados continuam salvos'}</span></span>
      </button>
      <button class="list-row danger-text" data-act="delete">
        <span class="nc-icon">${icon('trash')}</span>
        <span class="lr-main"><b>Excluir conta</b><span>Apaga diário, receitas e produtos pessoais</span></span>
      </button>
    </div>

    <div class="credits">
      <b>${APP_NAME}</b> · criado por Antônio Bento<br>
      <button class="link-btn subtle" data-act="privacy">Privacidade</button> · Ícones: Fluent Emoji (Microsoft)
    </div>`;
}

/** Não redesenha a tela enquanto a pessoa digita ou tem um código na tela. */
export function keepOnUpdate(el) {
  const typing = el.contains(document.activeElement) && document.activeElement.matches('input, select, textarea');
  return typing || !!$('.transfer', el)?.childElementCount;
}

function goalCheck(form) {
  const v = (k) => parseNum(form[k].value) || 0;
  const fromMacros = 4 * v('carb') + 4 * v('prot') + 9 * v('gord');
  const kcal = v('kcal');
  const hint = $('.goal-check', form);
  if (!kcal) {
    hint.textContent = '';
    return;
  }
  const pct = (k, f) => Math.round(((v(k) * f) / kcal) * 100);
  hint.textContent = `Os macros somam ${fmt(fromMacros, 0)} kcal (${pct('carb', 4)}% carb · ${pct('prot', 4)}% prot · ${pct('gord', 9)}% gord).`
    + (Math.abs(fromMacros - kcal) > kcal * 0.1 ? ' Não fecha com a meta de energia.' : '');
}

function openPasswordSheet() {
  const u = store.state.user;
  const sheet = openSheet({
    title: u.has_password ? 'Trocar senha' : 'Criar senha',
    subtitle: u.email,
    className: 'dialog',
    body: `<form>
      ${u.has_password ? passwordField('Senha atual', 'atual', 'current-password', { minlength: false }) : ''}
      ${passwordField('Nova senha (mínimo 8 caracteres)', 'nova', 'new-password')}
      <p class="form-error" role="alert"></p>
    </form>`,
    footer: '<button class="btn soft" data-close>Cancelar</button><button class="btn primary" data-ok>Salvar</button>',
  });
  const form = $('form', sheet.body);
  const submit = async () => {
    const error = $('.form-error', form);
    error.textContent = '';
    if (!form.reportValidity()) return;
    try {
      await busy($('[data-ok]', sheet.foot), () => store.changePassword(form.atual?.value, form.nova.value));
      sheet.close();
      toast(u.has_password ? 'Senha trocada. Os outros aparelhos foram desconectados.' : 'Senha criada.');
    } catch (err) {
      error.textContent = err.message;
    }
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  $('[data-ok]', sheet.foot).addEventListener('click', submit);
}

function openCalculator(onUse) {
  const body = store.prefs().body || {};
  let sexo = body.sexo || 'f';
  let objetivo = body.objetivo || 'manter';
  const sheet = openSheet({
    title: 'Calcular minhas metas',
    subtitle: 'Estimativa pela equação de Mifflin-St Jeor',
  });
  const chip = (group, value, label, current) =>
    `<button type="button" class="chip" data-${group}="${value}" aria-pressed="${value === current}">${label}</button>`;
  sheet.setBody(`
    <div class="field"><span class="field-label">sexo</span>
      <div class="unit-toggle">${chip('sexo', 'f', 'Feminino', sexo)}${chip('sexo', 'm', 'Masculino', sexo)}</div></div>
    <div class="goal-grid" style="margin-top:12px">
      <label class="field"><span class="field-label">idade</span><input class="input num" name="idade" inputmode="numeric" value="${body.idade || ''}"></label>
      <label class="field"><span class="field-label">peso (kg)</span><input class="input num" name="peso" inputmode="decimal" value="${body.peso || ''}"></label>
      <label class="field"><span class="field-label">altura (cm)</span><input class="input num" name="altura" inputmode="numeric" value="${body.altura || ''}"></label>
      <label class="field"><span class="field-label">atividade</span>
        <select class="select" name="atividade">
          ${[['1.2', 'Sedentário'], ['1.375', 'Leve (1–3x/sem)'], ['1.55', 'Moderado (3–5x/sem)'], ['1.725', 'Intenso (6–7x/sem)']]
            .map(([v, l]) => `<option value="${v}" ${String(body.atividade || '1.375') === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></label>
    </div>
    <div class="field" style="margin-top:12px"><span class="field-label">objetivo</span>
      <div class="slot-pick" style="grid-template-columns:repeat(3,1fr)">${chip('obj', 'perder', 'Perder peso', objetivo)}${chip('obj', 'manter', 'Manter', objetivo)}${chip('obj', 'ganhar', 'Ganhar massa', objetivo)}</div></div>
    <div class="preview-card result"></div>
    <p class="faint" style="font-size:12px;margin:10px 0 0">É uma estimativa para começar. Para um plano sob medida, procure um(a) nutricionista.</p>`);
  sheet.setFooter('<button class="btn soft" data-close>Cancelar</button><button class="btn primary" data-act="use" disabled>Usar estas metas</button>');

  let result = null;
  const calc = () => {
    const n = (name) => parseNum($(`[name=${name}]`, sheet.body).value);
    const idade = n('idade');
    const peso = n('peso');
    const altura = n('altura');
    const atividade = Number($('[name=atividade]', sheet.body).value);
    const box = $('.result', sheet.body);
    if (!(idade > 10 && idade < 110 && peso > 25 && peso < 350 && altura > 100 && altura < 250)) {
      box.innerHTML = '<span class="muted">Preencha idade, peso e altura.</span>';
      $('[data-act=use]', sheet.foot).disabled = true;
      return;
    }
    const tmb = 10 * peso + 6.25 * altura - 5 * idade + (sexo === 'm' ? 5 : -161);
    const factor = { perder: 0.85, manter: 1, ganhar: 1.1 }[objetivo];
    const kcal = Math.round((tmb * atividade * factor) / 10) * 10;
    const prot = Math.round(Math.min(peso * (objetivo === 'manter' ? 1.4 : 1.8), (kcal * 0.35) / 4));
    const gord = Math.round((kcal * 0.28) / 9);
    const carb = Math.max(0, Math.round((kcal - prot * 4 - gord * 9) / 4));
    const agua = Math.round((peso * 35) / 250) * 250;   // 35 ml por kg, arredondado em copos
    result = { goals: { kcal, carb, prot, gord, agua }, body: { sexo, idade, peso, altura, atividade, objetivo } };
    box.innerHTML = `<div class="preview-kcal"><span class="muted">Meta diária</span><b>${fmt(kcal, 0)} <span class="num faint" style="font-size:13px">kcal</span></b></div>
      <div class="macro-legend">${MACROS.map((m) => `<span><i style="background:${m.hex}"></i>${m.label} ${result.goals[m.key]} g</span>`).join('')}<span>Água ${fmt(agua / 1000, 2)} L</span></div>
      <p class="faint" style="font-size:12px;margin:8px 0 0">Gasto em repouso ≈ ${fmt(tmb, 0)} kcal · com atividade ≈ ${fmt(tmb * atividade, 0)} kcal</p>`;
    $('[data-act=use]', sheet.foot).disabled = false;
  };
  sheet.body.addEventListener('input', calc);
  sheet.el.addEventListener('click', async (e) => {
    const s = e.target.closest('[data-sexo]');
    const o = e.target.closest('[data-obj]');
    if (s || o) {
      if (s) sexo = s.dataset.sexo;
      if (o) objetivo = o.dataset.obj;
      $$('[data-sexo]', sheet.body).forEach((b) => b.setAttribute('aria-pressed', b.dataset.sexo === sexo));
      $$('[data-obj]', sheet.body).forEach((b) => b.setAttribute('aria-pressed', b.dataset.obj === objetivo));
      calc();
      return;
    }
    if (e.target.closest('[data-act=use]') && result) {
      try {
        await busy(e.target.closest('button'), () => store.savePrefs(result));
        sheet.close();
        onUse();
        toast('Metas atualizadas.');
      } catch (err) {
        toastError(err);
      }
    }
  });
  calc();
}

async function showTransferCode(box, btn) {
  const { code, expires_at: expiresAt } = await store.createTransferCode();
  const link = `${location.origin}${location.pathname}#/codigo/${code.replace('-', '')}`;
  box.innerHTML = `
    <div class="transfer-code" aria-label="Código de transferência">${code}</div>
    <div class="qr-box"></div>
    <p class="faint" style="text-align:center;font-size:12.5px;margin:0 0 12px">Expira em <span class="countdown num">10:00</span></p>`;
  btn.hidden = true;
  try {
    await loadScript(QR_LIB, QR_SRI);
    new window.QRCode($('.qr-box', box), {
      text: link, width: 368, height: 368, colorDark: '#2b241c', colorLight: '#ffffff', correctLevel: window.QRCode.CorrectLevel.M,
    });
  } catch {
    $('.qr-box', box).remove();
  }
  const tick = setInterval(() => {
    const left = Math.max(0, expiresAt - Date.now());
    const el = $('.countdown', box);
    if (!el || !left) {
      clearInterval(tick);
      if (el) {
        box.innerHTML = '';
        btn.hidden = false;
      }
      return;
    }
    el.textContent = `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
  }, 1000);
}

function paintInstall(el) {
  const btn = $('[data-act=install]', el);
  if (btn) btn.hidden = !canInstall();
}

export function mount(el, params) {
  const goalsForm = $('[data-form=goals]', el);
  goalCheck(goalsForm);
  paintInstall(el);
  if (params[0] === 'metas') {
    setTimeout(() => {
      $('#metas', el)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      goalsForm.kcal.focus({ preventScroll: true });
    }, 50);
  }

  el.addEventListener('input', (e) => {
    if (e.target.form === goalsForm) goalCheck(goalsForm);
  });

  el.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const btn = $('button:not([type=button])', form);
    try {
      if (form.dataset.form === 'goals') {
        const goals = {};
        for (const k of ['kcal', 'carb', 'prot', 'gord', 'agua']) {
          const v = parseNum(form[k].value);
          if (!(v > 0 && v < 10000)) {
            form[k].focus();
            toast('Confira os valores das metas.', { error: true });
            return;
          }
          goals[k] = Math.round(v);
        }
        await busy(btn, () => store.savePrefs({ goals }));
        toast('Metas salvas.');
      }
      if (form.dataset.form === 'upgrade') {
        await busy(btn, () => store.setCredentials(form.email.value, form.senha.value));
        toast('Conta criada! Agora você entra de qualquer aparelho.');
      }
    } catch (err) {
      toastError(err);
    }
  });

  el.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    try {
      switch (btn.dataset.act) {
        case 'calc':
          openCalculator(() => {});
          break;
        case 'reset-goals':
          await store.savePrefs({ goals: DEFAULT_GOALS });
          toast('Metas padrão: 2.000 kcal.');
          break;
        case 'transfer':
          await busy(btn, () => showTransferCode($('.transfer', el), btn));
          break;
        case 'rename': {
          const nome = await promptDialog({ title: 'Como você quer ser chamado?', label: 'nome', value: store.state.user.nome, maxLength: 60 });
          if (nome) await store.updateProfile({ nome });
          break;
        }
        case 'install':
          await install();
          paintInstall(el);
          break;
        case 'resend':
          await busy(btn, () => store.resendVerification());
          toast('Link enviado. Confira seu e-mail.');
          break;
        case 'password':
          openPasswordSheet();
          break;
        case 'revoke': {
          const { revoked } = await busy(btn, () => store.revokeOtherSessions());
          toast(revoked ? `${revoked} ${revoked === 1 ? 'aparelho desconectado' : 'aparelhos desconectados'}.` : 'Só este aparelho está conectado.');
          break;
        }
        case 'privacy':
          openPrivacy();
          break;
        case 'link-github':
          signInWithGitHub(() => toast('Conta do GitHub vinculada.'));
          break;
        case 'logout':
          if (await confirmDialog({
            title: 'Sair da conta?',
            message: store.state.user.is_guest
              ? 'Você está como convidado. Sem senha ou código de transferência, não dá para voltar a esta conta.'
              : 'Você pode entrar de novo quando quiser.',
            confirm: 'Sair',
            danger: store.state.user.is_guest,
          })) {
            await store.logout();
            location.hash = '#/';
          }
          break;
        case 'delete':
          if (await confirmDialog({
            title: 'Excluir sua conta?',
            message: 'Diário, receitas e produtos pessoais serão apagados para sempre. Sugestões já aprovadas continuam no catálogo.',
            confirm: 'Excluir tudo',
            danger: true,
          })) {
            await store.deleteAccount();
            location.hash = '#/';
          }
          break;
        default:
      }
    } catch (err) {
      toastError(err);
    }
  });
}

