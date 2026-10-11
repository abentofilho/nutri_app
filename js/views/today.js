import { SLOT_ICONS, foodImg, productIcon } from '../foods.js';
import { icon } from '../icons.js';
import { MACROS, SLOTS, scale, slotLabel, sumItems } from '../nutrition.js';
import * as store from '../store.js';
import { dismissInvite, install, shouldInvite } from '../pwa.js';
import { openStory } from '../share.js';
import { openPicker } from '../sheets/picker.js';
import { openProduct } from '../sheets/product.js';
import { busy, nutriTable, openSheet, ring, toast, toastError } from '../ui.js';
import { $, $$, addDays, esc, fmt, isoDay, longDate, portionLabel, relativeDay } from '../util.js';
import { mountQtyField } from '../sheets/qty.js';

export const title = 'Hoje';

const historyStart = () => addDays(isoDay(), -(store.state.config.history_days || 30) + 1);

/** Dia vindo da URL (#/hoje/2026-10-07), limitado à janela do histórico. */
function resolveDay(params) {
  const today = isoDay();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(params[0] || '') ? params[0] : today;
  if (day > today) return today;
  return day < historyStart() ? historyStart() : day;
}

function macroColumns(totals, goals) {
  return `<div class="macro-cols">${MACROS.map((m) => {
    const v = totals[m.key] || 0;
    const pct = goals[m.key] ? Math.min((v / goals[m.key]) * 100, 100) : 0;
    return `<div class="mc">
      <div class="mc-label"><i style="background:${m.hex}"></i>${m.label}</div>
      <div class="mc-value">${fmt(v, 0)}<small> g</small></div>
      <div class="bar"><span style="width:${pct}%;background:${m.hex}"></span></div>
      <div class="mc-goal">de ${fmt(goals[m.key], 0)} g</div>
    </div>`;
  }).join('')}</div>`;
}

function amountLabel(e) {
  return e.porcoes ? `${portionLabel(e.porcoes, e.porcao_nome)} · ${fmt(e.qty)} ${e.unidade}` : `${fmt(e.qty)} ${e.unidade}`;
}

const GLASS = 250;

function waterCard(day) {
  const ml = store.waterFor(day);
  const goal = store.goals().agua || 2000;
  const glasses = Math.max(8, Math.ceil(goal / GLASS));
  const filled = Math.round(ml / GLASS);
  return `
    <section class="card water" aria-label="Água">
      ${foodImg('water', 40)}
      <div class="water-main">
        <div class="water-top"><h3>Água</h3><span><b>${fmt(ml / 1000, 2)} L</b> de ${fmt(goal / 1000, 1)} L</span></div>
        <div class="glasses" aria-hidden="true">${Array.from({ length: glasses }, (_, i) => `<i class="${i < filled ? 'on' : ''}"></i>`).join('')}</div>
      </div>
      <div class="water-btns">
        <button class="icon-btn boxed" data-water="-1" aria-label="Tirar um copo" ${ml ? '' : 'disabled'}>${icon('minus')}</button>
        <button class="icon-btn boxed primary" data-water="1" aria-label="Mais um copo de 250 ml">${icon('plus')}</button>
      </div>
    </section>`;
}

function slotCard(s, items) {
  const t = sumItems(items);
  return `
    <section class="card slot" aria-label="${s.label}">
      <header class="slot-head">
        ${foodImg(SLOT_ICONS[s.key], 40, 'slot-food')}
        <div class="slot-title">
          <h3>${s.label}</h3>
          <div class="slot-sub">${items.length ? `${fmt(t.kcal, 0)} kcal` : 'Nada registrado'}</div>
        </div>
        <button class="add-btn" data-add="${s.key}" aria-label="Adicionar ${s.to}">${icon('plus')}</button>
      </header>
      ${items.map((e) => `
        <button class="entry" data-entry="${e.id}">
          ${foodImg(productIcon(e), 32)}
          <span class="entry-main">
            <span class="entry-name">${esc(e.nome)}</span>
            <span class="entry-meta">${esc(amountLabel(e))}</span>
          </span>
          <span class="entry-kcal">${fmt(scale(e.nutr, e.qty).kcal, 0)}<small> kcal</small></span>
        </button>`).join('')}
    </section>`;
}

/** Um lembrete por vez: primeiro salvar a conta (convidado), depois as metas. */
function setupCard() {
  const u = store.state.user;
  const dismissed = store.prefs().dismissed || {};
  if (u.is_guest && !dismissed.guest) {
    return `
      <div class="card invite tip">
        <span class="tip-ic">${icon('key')}</span>
        <div><b>Seus dados estão só neste aparelho</b><span>Crie uma senha para ver o diário no celular e no computador.</span></div>
        <a class="btn primary sm" href="#/perfil">Criar senha</a>
        <button class="icon-btn" data-dismiss="guest" aria-label="Agora não">${icon('x')}</button>
      </div>`;
  }
  if (store.needsEmailCheck() && !dismissed.verify) {
    return `
      <div class="card invite tip">
        <span class="tip-ic">${icon('mail')}</span>
        <div><b>Confirme seu e-mail</b><span>Abra o link que enviamos. Ele garante a recuperação da conta.</span></div>
        <button class="btn primary sm" data-act="resend">Reenviar</button>
        <button class="icon-btn" data-dismiss="verify" aria-label="Agora não">${icon('x')}</button>
      </div>`;
  }
  if (!store.prefs().goals && !dismissed.goals) {
    return `
      <div class="card invite tip">
        <span class="tip-ic">${icon('calc')}</span>
        <div><b>Personalize suas metas</b><span>A meta padrão é 2.000 kcal. Calcule a sua em 1 minuto.</span></div>
        <a class="btn primary sm" href="#/perfil/metas">Calcular</a>
        <button class="icon-btn" data-dismiss="goals" aria-label="Agora não">${icon('x')}</button>
      </div>`;
  }
  return '';
}

export function render(params) {
  const today = isoDay();
  const day = resolveDay(params);
  const entries = store.entriesFor(day);
  const totals = sumItems(entries);
  const goals = store.goals();
  const left = goals.kcal - totals.kcal;
  const yesterday = store.entriesFor(addDays(day, -1));
  const tip = setupCard();     // um lembrete por vez, para não poluir a tela

  return `
    <div class="day-switch">
      <a class="icon-btn" href="#/hoje/${addDays(day, -1)}" aria-label="Dia anterior" ${day <= historyStart() ? 'hidden' : ''}>${icon('left')}</a>
      <div class="day-label">
        <strong>${relativeDay(day)}</strong>
        <span>${longDate(day)}</span>
      </div>
      ${day < today
        ? `<a class="icon-btn" href="#/hoje/${addDays(day, 1)}" aria-label="Próximo dia">${icon('right')}</a>`
        : '<span class="icon-btn placeholder" aria-hidden="true"></span>'}
    </div>

    ${tip}
    ${!tip && shouldInvite() ? `
      <div class="card invite">
        <img src="assets/icons/icon-192.png" alt="" width="44" height="44">
        <div><b>Use como app</b><span>Ícone na tela inicial, em tela cheia.</span></div>
        <button class="btn primary sm" data-act="install">Instalar</button>
        <button class="icon-btn" data-act="dismiss-install" aria-label="Agora não">${icon('x')}</button>
      </div>` : ''}

    <div class="today-grid">
      <article class="card summary">
        <button class="icon-btn summary-share" data-act="share" aria-label="Compartilhar o dia" ${entries.length ? '' : 'hidden'}>${icon('share')}</button>
        <div class="summary-top">
          ${ring(totals.kcal, goals.kcal, { size: 136 })}
          <div class="summary-side">
            <div class="left-label">${left >= 0 ? 'Restam' : 'Acima da meta'}</div>
            <div class="left-value ${left < 0 ? 'over' : ''}">${fmt(Math.abs(left), 0)} <small>kcal</small></div>
            <a class="goal-link" href="#/perfil/metas">Meta de ${fmt(goals.kcal, 0)} kcal</a>
          </div>
        </div>
        ${macroColumns(totals, goals)}
        <button class="more-row" data-act="details">
          <span>Fibras <b>${fmt(totals.fibra)} g</b></span>
          <span>Sódio <b>${fmt(totals.sodio, 0)} mg</b></span>
          <span class="more-link">Tabela ${icon('right')}</span>
        </button>
      </article>

      <div class="slots">
        ${!entries.length && yesterday.length ? `
          <div class="card repeat-banner">
            ${icon('repeat')}
            <div><b>Comeu parecido com ontem?</b><span>Copie os ${yesterday.length} itens e ajuste o que mudou.</span></div>
            <button class="btn soft sm" data-act="copy-yesterday">Copiar</button>
          </div>` : ''}
        ${SLOTS.map((s) => slotCard(s, entries.filter((e) => e.slot === s.key))).join('')}
        ${waterCard(day)}
      </div>
    </div>`;
}

export function mount(el, params) {
  const day = () => resolveDay(params);

  el.addEventListener('click', async (e) => {
    const add = e.target.closest('[data-add]');
    if (add) {
      openPicker({ day: day(), slot: add.dataset.add });
      return;
    }
    const entry = e.target.closest('[data-entry]');
    if (entry) {
      openEntry(entry.dataset.entry);
      return;
    }
    const water = e.target.closest('[data-water]');
    if (water) {
      const step = Number(water.dataset.water) * GLASS;
      store.setWater(day(), store.waterFor(day()) + step).catch(toastError);
      return;
    }
    const dismiss = e.target.closest('[data-dismiss]');
    if (dismiss) {
      store.savePrefs({ dismissed: { ...(store.prefs().dismissed || {}), [dismiss.dataset.dismiss]: true } }).catch(toastError);
      return;
    }
    const btn = e.target.closest('[data-act]');
    switch (btn?.dataset.act) {
      case 'share':
        openStory('day', day());
        break;
      case 'details': {
        const totals = sumItems(store.entriesFor(day()));
        openSheet({ title: 'Tabela do dia', subtitle: `${relativeDay(day())}, ${longDate(day())}`, body: nutriTable(totals) });
        break;
      }
      case 'install':
        install();
        break;
      case 'resend':
        await busy(btn, () => store.resendVerification().then(() => toast('Link enviado. Confira seu e-mail.'), toastError));
        break;
      case 'dismiss-install':
        dismissInvite();
        btn.closest('.invite').remove();
        break;
      case 'copy-yesterday':
        await busy(btn, async () => {
          try {
            const n = await store.copyDay(addDays(day(), -1), day());
            toast(`${n} ${n === 1 ? 'item copiado' : 'itens copiados'} de ontem.`);
          } catch (err) {
            toastError(err);
          }
        });
        break;
      default:
    }
  });
}

// ---------- editar um registro ----------

function openEntry(id) {
  const entry = store.state.diary.find((e) => e.id === id);
  if (!entry) return;
  let slot = entry.slot;
  let current = { qty: entry.qty, porcoes: entry.porcoes };
  const product = store.findProduct(entry.product_id);
  const porcaoG = entry.porcoes ? entry.qty / entry.porcoes : product?.porcao_g;
  const porcaoNome = entry.porcao_nome || product?.porcao_nome;
  const sheet = openSheet({ title: entry.nome, subtitle: `${relativeDay(entry.day)} · ${slotLabel(entry.slot)}` });
  sheet.setBody(`
    <div class="field-label">Quantidade</div>
    <div class="qty-field"></div>
    <div class="field-label" style="margin-top:14px">Refeição</div>
    <div class="slot-pick">${SLOTS.map((s) => `<button class="chip" data-slot="${s.key}" aria-pressed="${s.key === slot}">${s.short}</button>`).join('')}</div>
    <div class="preview-card"></div>
    <div class="btn-row" style="margin-top:16px">
      ${product ? `<button class="btn ghost sm" data-act="product">${icon('info')}Ver produto</button>` : ''}
      <button class="btn ghost sm danger-text" data-act="delete">${icon('trash')}Remover</button>
    </div>`);
  sheet.setFooter('<button class="btn soft" data-close>Cancelar</button><button class="btn primary" data-act="save">Salvar</button>');
  const saveBtn = $('[data-act=save]', sheet.foot);

  const paint = () => {
    const t = scale(entry.nutr, current.qty || 0);
    $('.preview-card', sheet.body).innerHTML = `<div class="preview-kcal"><span class="muted">${esc(amountLabel({ ...entry, ...current }))}</span>
      <b>${fmt(t.kcal, 0)} <small>kcal</small></b></div>
      <div class="macro-legend">${MACROS.map((m) => `<span><i style="background:${m.hex}"></i>${m.short} ${fmt(t[m.key])} g</span>`).join('')}</div>`;
  };
  mountQtyField($('.qty-field', sheet.body), {
    unidade: entry.unidade,
    porcaoG,
    porcaoNome,
    qty: entry.qty,
    porcoes: entry.porcoes,
    onChange: (v) => {
      current = v;
      paint();
    },
    onSubmit: () => saveBtn.click(),
  });

  sheet.el.addEventListener('click', async (e) => {
    const s = e.target.closest('[data-slot]');
    if (s) {
      slot = s.dataset.slot;
      $$('[data-slot]', sheet.body).forEach((b) => b.setAttribute('aria-pressed', b === s));
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    try {
      if (act === 'save') {
        if (!(current.qty > 0 && current.qty <= 5000)) {
          toast('Informe uma quantidade válida.', { error: true });
          return;
        }
        await busy(saveBtn, () => store.updateEntry(id, { qty: current.qty, slot, porcoes: current.porcoes || 0 }));
        sheet.close();
      } else if (act === 'delete') {
        sheet.close();
        const removed = await store.deleteEntry(id);
        toast(`${removed.nome} removido.`, {
          action: {
            label: 'Desfazer',
            run: () => store.addToDiary(removed.day, removed.slot, [{ ...removed, productId: removed.product_id }]).catch(toastError),
          },
        });
      } else if (act === 'product') {
        sheet.close();
        openProduct(product);
      }
    } catch (err) {
      toastError(err);
    }
  });
}
