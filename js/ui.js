import { foodImg } from './foods.js';
import { icon } from './icons.js';
import { MACROS, NUTRIENTS, VD, macroSplit } from './nutrition.js';
import { $, esc, fmt } from './util.js';

// ---------- sheets ----------
// Janelas que sobem de baixo no celular (e viram modal no desktop).
// Cada sheet aberta empilha um estado no histórico: o "voltar" do Android
// fecha a sheet em vez de sair do app.
//
// Fechar pelo app (botão, Esc) tira a sheet da tela na hora e desfaz a entrada
// do histórico com history.back(), que é assíncrono. Se outra sheet abrir logo
// em seguida (ex.: scanner -> cadastro), a entrada dela espera esse "voltar"
// terminar; sem isso, o popstate atrasado fecharia a sheet nova.

const stack = [];
let expectedPops = 0;
let afterPops = [];

window.addEventListener('popstate', () => {
  if (expectedPops > 0) {
    expectedPops -= 1;
    if (!expectedPops) {
      const pending = afterPops;
      afterPops = [];
      pending.forEach((fn) => fn());
    }
    return;
  }
  stack[stack.length - 1]?._remove();     // "voltar" do usuário
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && stack.length) stack[stack.length - 1].close();
});

// O estado do histórico sobrevive a um recarregamento da página; um id único
// evita confundir uma sheet nova com a entrada antiga de antes do reload.
const sessionTag = Date.now().toString(36);
let sheetSeq = 0;
if (history.state?.sheet) history.replaceState({ ...history.state, sheet: null }, '');

/** Roda `fn` depois que o "voltar" de uma sheet fechada terminar (ou já). */
export function afterSheetBack(fn) {
  if (expectedPops > 0) afterPops.push(fn);
  else fn();
}

export const sheetBackPending = () => expectedPops > 0;

function pushEntry(sheet) {
  const push = () => {
    if (!sheet.closed) history.pushState({ ...(history.state || {}), sheet: sheet.id }, '');
  };
  if (expectedPops > 0) afterPops.push(push);
  else push();
}

export function openSheet({ title = '', subtitle = '', body = '', footer = '', className = '', onClose } = {}) {
  const id = `${sessionTag}-${++sheetSeq}`;
  const layer = document.createElement('div');
  layer.className = 'sheet-layer';
  layer.innerHTML = `
    <div class="sheet-backdrop" data-close></div>
    <section class="sheet ${className}" role="dialog" aria-modal="true" aria-labelledby="sheet-title-${id}">
      <header class="sheet-head">
        <div class="titles">
          <h2 id="sheet-title-${id}"></h2>
          <p class="sheet-subtitle" hidden></p>
        </div>
        <button class="icon-btn" data-close aria-label="Fechar">${icon('x')}</button>
      </header>
      <div class="sheet-body"></div>
      <footer class="sheet-foot"></footer>
    </section>`;
  const lastFocus = document.activeElement;

  const sheet = {
    id,
    el: $('.sheet', layer),
    body: $('.sheet-body', layer),
    foot: $('.sheet-foot', layer),
    setTitle(t, sub = '') {
      $('h2', layer).textContent = t;
      const p = $('.sheet-subtitle', layer);
      p.textContent = sub;
      p.hidden = !sub;
    },
    setBody(html) {
      sheet.body.innerHTML = html;
      sheet.body.scrollTop = 0;
    },
    setFooter(html) {
      sheet.foot.innerHTML = html;
    },
    close() {
      if (sheet.closed) return;
      const ownsEntry = history.state?.sheet === id;
      sheet._remove();
      if (ownsEntry) {
        expectedPops += 1;
        history.back();
      }
    },
    _remove() {
      if (sheet.closed) return;
      sheet.closed = true;
      stack.splice(stack.indexOf(sheet), 1);
      layer.classList.remove('open');
      setTimeout(() => layer.remove(), 280);
      if (!stack.length) document.body.classList.remove('sheet-open');
      onClose?.();
      lastFocus?.focus?.({ preventScroll: true });
    },
  };

  sheet.setTitle(title, subtitle);
  sheet.body.innerHTML = body;
  sheet.foot.innerHTML = footer;
  layer.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) sheet.close();
  });

  document.body.appendChild(layer);
  document.body.classList.add('sheet-open');
  stack.push(sheet);
  pushEntry(sheet);
  requestAnimationFrame(() => layer.classList.add('open'));
  return sheet;
}

export function closeAllSheets() {
  [...stack].reverse().forEach((s) => s._remove());
}

/** Pergunta com Sim/Não. Resolve true/false. */
export function confirmDialog({ title, message = '', confirm = 'Confirmar', danger = false }) {
  return new Promise((resolve) => {
    let answer = false;
    const sheet = openSheet({
      title,
      className: 'dialog',
      body: message ? `<p class="muted" style="margin:0">${message}</p>` : '',
      footer: `<button class="btn soft" data-close>Cancelar</button>
               <button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(confirm)}</button>`,
      onClose: () => resolve(answer),
    });
    sheet.foot.querySelector('[data-ok]').addEventListener('click', () => {
      answer = true;
      sheet.close();
    });
  });
}

/** Pede um texto curto. Resolve com o texto (sem espaços nas pontas) ou null. */
export function promptDialog({ title, label = '', value = '', confirm = 'Salvar', maxLength = 120, required = true }) {
  return new Promise((resolve) => {
    let answer = null;
    const sheet = openSheet({
      title,
      className: 'dialog',
      body: `<form><label class="field"><span class="field-label">${esc(label)}</span>
        <input class="input" maxlength="${maxLength}" value="${esc(value)}"></label></form>`,
      footer: `<button class="btn soft" data-close>Cancelar</button><button class="btn primary" data-ok>${esc(confirm)}</button>`,
      onClose: () => resolve(answer),
    });
    const input = $('input', sheet.body);
    const submit = () => {
      if (required && !input.value.trim()) return input.focus();
      answer = input.value.trim();
      return sheet.close();
    };
    $('form', sheet.body).addEventListener('submit', (e) => {
      e.preventDefault();
      submit();
    });
    sheet.foot.querySelector('[data-ok]').addEventListener('click', submit);
    setTimeout(() => input.select(), 250);
  });
}

/** Campo de senha com o botão de mostrar/ocultar. */
export function passwordField(label, name, autocomplete, { minlength = true } = {}) {
  return `
    <label class="field"><span class="field-label">${esc(label)}</span>
      <span class="pass-wrap">
        <input class="input" type="password" name="${name}" autocomplete="${autocomplete}" ${minlength ? 'minlength="8"' : ''} required>
        <button type="button" class="icon-btn" data-toggle-pass aria-label="Mostrar senha">${icon('eye')}</button>
      </span>
    </label>`;
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-toggle-pass]');
  if (!btn) return;
  e.preventDefault();
  const input = btn.parentElement.querySelector('input');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.innerHTML = icon(show ? 'eyeOff' : 'eye');
  btn.setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha');
});

// ---------- toast ----------

let toastHost;

export function toast(message, { action, error = false, duration = 3800 } = {}) {
  toastHost ||= Object.assign(document.body.appendChild(document.createElement('div')), {
    className: 'toasts',
  });
  toastHost.setAttribute('role', 'status');
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' err' : '');
  el.innerHTML = `<span>${esc(message)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}`;
  const remove = () => el.remove();
  if (action) {
    el.querySelector('button').addEventListener('click', () => {
      remove();
      action.run();
    });
  }
  toastHost.appendChild(el);
  setTimeout(remove, action ? duration + 2500 : duration);
}

export const toastError = (err) => toast(err?.message || 'Algo deu errado. Tente de novo.', { error: true });

/** Roda uma ação assíncrona mostrando "carregando" no botão. */
export async function busy(button, fn) {
  if (!button || button.classList.contains('busy')) return undefined;
  button.classList.add('busy');
  button.disabled = true;
  try {
    return await fn();
  } finally {
    button.classList.remove('busy');
    button.disabled = false;
  }
}

// ---------- peças visuais ----------

export function ring(value, goal, { size = 168, stroke = 14, label = 'kcal' } = {}) {
  const r = (100 - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = goal ? Math.min(value / goal, 1) : 0;
  const over = goal && value > goal * 1.02;
  return `
    <div class="ring ${over ? 'over' : ''}" style="--ring:${size}px;width:${size}px;height:${size}px"
         role="img" aria-label="${fmt(value, 0)} de ${fmt(goal, 0)} ${label}">
      <svg viewBox="0 0 100 100">
        <circle class="track" cx="50" cy="50" r="${r}" fill="none" stroke-width="${stroke}"/>
        <circle class="value" cx="50" cy="50" r="${r}" fill="none" stroke-width="${stroke}"
                stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct)}"/>
      </svg>
      <div class="ring-center">
        <div class="big">${fmt(value, 0)}</div>
        <div class="small">de ${fmt(goal, 0)} ${label}</div>
      </div>
    </div>`;
}

/** Barrinha empilhada: quanto das calorias vem de cada macro. */
export function stackBar(totals) {
  const parts = macroSplit(totals);
  return `<div class="stackbar" aria-hidden="true">${parts
    .map((p) => `<span class="c-${p.key}" style="width:${p.pct}%"></span>`).join('')}</div>`;
}

export function macroLegend(totals) {
  return `<div class="macro-legend">${MACROS.map((m) =>
    `<span><i style="background:${m.hex}"></i>${m.short} ${fmt(totals[m.key] || 0)} g</span>`).join('')}</div>`;
}

/**
 * A tabela nutricional da v1, agora com a coluna de %VD.
 * `flags` marca os campos que a validação achou estranhos.
 */
export function nutriTable(totals, { title = 'Total', vd = true, flags = [] } = {}) {
  const rows = NUTRIENTS.map((n) => {
    const v = totals[n.key] || 0;
    const vdCell = vd ? `<td class="vd">${VD[n.key] ? fmt((v / VD[n.key]) * 100, 0) + '%' : '—'}</td>` : '';
    return `<tr class="${n.sub ? 'sub' : ''}">
      <td>${n.label} (${n.unit})</td>
      <td class="${flags.includes(n.key) ? 'flag' : ''}">${fmt(v)}</td>${vdCell}
    </tr>`;
  }).join('');
  return `
    <table class="nutri-table">
      <thead><tr><th>Nutriente</th><th>${esc(title)}</th>${vd ? '<th>%VD*</th>' : ''}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${vd ? '<p class="table-note">* % dos valores diários de referência (dieta de 2.000 kcal), como nos rótulos.</p>' : ''}`;
}

/** Cabeçalho das janelas de produto e receita: ícone, calorias e macros. */
export function foodHero(iconName, totals, caption) {
  return `
    <div class="food-hero">
      ${foodImg(iconName, 72)}
      <div class="fh-main">
        <div class="fh-kcal"><b>${fmt(totals.kcal, 0)}</b> kcal <span>${caption}</span></div>
        ${stackBar(totals)}
        ${macroLegend(totals)}
      </div>
    </div>`;
}

export function emptyState(iconName, text, actionHtml = '') {
  return `<div class="empty">${icon(iconName)}<p>${text}</p>${actionHtml}</div>`;
}
