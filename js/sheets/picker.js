import { foodImg, productIcon, recipeIcon } from '../foods.js';
import { icon } from '../icons.js';
import { SLOTS, nutrOf, scale, slotForNow, slotLabel, slotTo, sumItems } from '../nutrition.js';
import * as store from '../store.js';
import { busy, macroLegend, openSheet, stackBar, toast, toastError } from '../ui.js';
import { $, $$, addDays, debounce, esc, fmt, isoDay, portionLabel, relativeDay } from '../util.js';
import { mountQtyField } from './qty.js';
import { openProductForm } from './product.js';
import { openScanner } from '../scanner.js';

const PORTIONS = [0.5, 1, 1.5, 2];

function productRow(p, extra = '') {
  return `
    <button class="pick-item" data-product="${esc(p.id)}">
      ${foodImg(productIcon(p), 36)}
      <span class="pi-main">
        <span class="pi-name">${esc(p.nome)}</span>
        <span class="pi-meta">${extra || `${fmt(p.kcal, 0)} kcal em 100 ${p.unidade}`}</span>
      </span>
    </button>`;
}

function recipeRow(r, house) {
  const t = store.recipeTotals(r);
  return `
    <button class="pick-item" data-recipe="${esc(r.id)}" data-house="${house ? 1 : ''}">
      ${foodImg(recipeIcon({ ...r, items: store.recipeItems(r) }), 36)}
      <span class="pi-main">
        <span class="pi-name">${esc(r.nome)}</span>
        <span class="pi-meta">${house ? 'Receita da Nutri' : 'Minha receita'} · ${fmt(t.kcal, 0)} kcal</span>
      </span>
    </button>`;
}

/**
 * Seletor de alimentos.
 *   mode 'diary'   -> adiciona ao diário em `day`/`slot`
 *   mode 'builder' -> devolve o item escolhido em onPick (montar receita)
 */
export function openPicker({ mode = 'diary', day = isoDay(), slot = slotForNow(), onPick, startRecipe } = {}) {
  const diary = mode === 'diary';
  const sheet = openSheet({ className: 'picker-sheet' });
  let query = '';

  const setTitle = () => sheet.setTitle(
    diary ? `Adicionar ${slotTo(slot)}` : 'Adicionar ingrediente',
    diary ? relativeDay(day) : 'Escolha um produto da despensa',
  );

  // ---------- passo 1: lista ----------

  function showList() {
    setTitle();
    sheet.setFooter('');
    sheet.setBody(`
      <div class="toolbar-row" style="position:sticky;top:-8px;z-index:2;background:var(--paper);padding:6px 0 10px">
        <label class="search" style="flex:1">${icon('search')}
          <span class="sr-only">Buscar alimento</span>
          <input class="input" type="search" placeholder="Buscar alimento ou receita" value="${esc(query)}" autocomplete="off" enterkeyhint="search">
        </label>
        <button class="icon-btn" data-act="scan" aria-label="Ler código de barras" style="background:var(--paper-2);border:1px solid var(--line)">${icon('barcode')}</button>
      </div>
      <div class="results"></div>`);
    const input = $('input', sheet.body);
    input.addEventListener('input', debounce(() => {
      query = input.value;
      renderResults();
    }, 80));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('.results .pick-item', sheet.body)?.click();
    });
    renderResults();
    if (window.matchMedia('(pointer: fine)').matches) setTimeout(() => input.focus(), 250);
  }

  function renderResults() {
    const box = $('.results', sheet.body);
    const parts = [];
    if (query.trim()) {
      const products = store.searchProducts(query);
      const recipes = diary ? searchRecipes(query) : [];
      if (!products.length && !recipes.length) {
        parts.push(`<div class="empty" style="margin-top:8px">${icon('search')}
          <p>Nada encontrado para "${esc(query)}".</p>
          <button class="btn soft sm" data-act="new">${icon('plus')}Cadastrar "${esc(query)}"</button></div>`);
      }
      if (recipes.length) parts.push('<div class="pick-group">Receitas</div>', ...recipes.map(([r, h]) => recipeRow(r, h)));
      if (products.length) parts.push('<div class="pick-group">Produtos</div>', ...products.map((p) => productRow(p)));
    } else {
      const shortcuts = [];
      if (diary) {
        const yesterday = addDays(day, -1);
        const prev = store.entriesFor(yesterday).filter((e) => e.slot === slot);
        if (prev.length) {
          shortcuts.push(`<button class="chip" data-act="copy-yesterday">${icon('repeat')}Repetir ${slotTo(slot).replace(/^a/, '')} de ontem · ${fmt(sumItems(prev).kcal, 0)} kcal</button>`);
        }
      }
      shortcuts.push(`<button class="chip" data-act="new">${icon('plus')}Novo produto</button>`);
      parts.push(`<div class="seg" style="flex-wrap:wrap">${shortcuts.join('')}</div>`);

      const recents = store.recentProducts(6);
      if (recents.length) parts.push('<div class="pick-group">Recentes</div>', ...recents.map((p) => productRow(p, lastQtyLabel(p))));
      const favs = store.productList().filter((p) => store.isFavorite(p.id));
      if (favs.length) parts.push('<div class="pick-group">Favoritos</div>', ...favs.map((p) => productRow(p)));
      if (diary) {
        const recipes = [...store.state.myRecipes.map((r) => [r, false]), ...store.state.houseRecipes.map((r) => [r, true])];
        if (recipes.length) parts.push('<div class="pick-group">Receitas</div>', ...recipes.slice(0, 8).map(([r, h]) => recipeRow(r, h)));
      }
      parts.push('<div class="pick-group">Todos os produtos</div>', ...store.productList().map((p) => productRow(p)));
    }
    box.innerHTML = parts.join('');
  }

  function lastQtyLabel(p) {
    const e = store.lastEntry(p.id);
    if (!e) return '';
    return `Última vez: ${e.porcoes ? portionLabel(e.porcoes, e.porcao_nome) : `${fmt(e.qty)} ${p.unidade}`}`;
  }

  // ---------- passo 2: quantidade ----------

  function showQuantity(product) {
    renderQuantityStep(sheet, product, {
      diary,
      slot,
      backLabel: 'Voltar',
      onBack: showList,
      onSlot: (s) => {
        slot = s;
      },
      onConfirm: async (qty, chosenSlot, porcoes) => {
        const item = store.itemFrom(product, qty, porcoes);
        if (!diary) {
          onPick?.(item);
          sheet.close();
          return;
        }
        await addAndClose([item], chosenSlot, product.nome);
      },
    });
  }

  // ---------- receita -> porção ----------

  function showRecipe(recipe, house) {
    let portion = 1;
    const items = store.recipeItems(recipe);
    const missing = items.filter((it) => !it.nutr);
    sheet.setTitle(recipe.nome, `${house ? 'Receita da Nutri' : 'Minha receita'} · escolha a porção`);

    function paint() {
      const scaled = items.filter((it) => it.nutr).map((it) => ({ ...it, qty: it.qty * portion, porcoes: it.porcoes ? it.porcoes * portion : null }));
      const t = sumItems(scaled);
      sheet.setBody(`
        <div class="field-label">Porção</div>
        <div class="qty-chips" style="margin-bottom:14px">${PORTIONS.map((p) =>
          `<button class="chip" data-portion="${p}" aria-pressed="${p === portion}">${p === 0.5 ? '½' : p === 1.5 ? '1½' : p}×</button>`).join('')}</div>
        ${slotPicker(slot)}
        <div class="preview-card">
          <div class="preview-kcal"><span class="muted">Total</span><b>${fmt(t.kcal, 0)} <span class="num faint" style="font-size:13px">kcal</span></b></div>
          ${stackBar(t)}<div style="margin-top:8px">${macroLegend(t)}</div>
        </div>
        <div style="margin-top:12px">${scaled.map((it) => `
          <div class="builder-item">${foodImg(productIcon(it), 32)}<span class="bi-name">${esc(it.nome)}
          <small>${it.porcoes ? `${esc(portionLabel(it.porcoes, it.porcao_nome))} · ` : ''}${fmt(it.qty)} ${it.unidade}</small></span></div>`).join('')}</div>
        ${missing.length ? `<div class="notice warn" style="margin-top:12px">${icon('alert')}<div>${missing.length} item(ns) desta receita não existem mais no catálogo e ficaram de fora.</div></div>` : ''}`);
      sheet.setFooter(`<button class="btn soft" data-act="back">Voltar</button>
        <button class="btn primary" data-act="add-recipe">${icon('plus')}Adicionar ${slotTo(slot)}</button>`);
    }
    sheet.onRecipeClick = async (e) => {
      const p = e.target.closest('[data-portion]');
      if (p) {
        portion = Number(p.dataset.portion);
        paint();
        return true;
      }
      const s = e.target.closest('[data-slot]');
      if (s) {
        slot = s.dataset.slot;
        paint();
        return true;
      }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'back') {
        sheet.onRecipeClick = null;
        showList();
        return true;
      }
      if (act === 'add-recipe') {
        const scaled = items.filter((it) => it.nutr).map((it) => ({ ...it, qty: it.qty * portion, porcoes: it.porcoes ? it.porcoes * portion : null }));
        await busy(e.target.closest('button'), () => addAndClose(scaled, slot, recipe.nome));
        return true;
      }
      return false;
    };
    paint();
  }

  async function addAndClose(items, chosenSlot, name) {
    try {
      const created = await store.addToDiary(day, chosenSlot, items);
      sheet.close();
      toast(`${name} → ${slotLabel(chosenSlot)}`, {
        action: {
          label: 'Desfazer',
          run: () => Promise.all(created.map((c) => store.deleteEntry(c.id))).catch(toastError),
        },
      });
    } catch (err) {
      toastError(err);
    }
  }

  // ---------- eventos ----------

  sheet.el.addEventListener('click', async (e) => {
    if (sheet.onRecipeClick && await sheet.onRecipeClick(e)) return;
    const prod = e.target.closest('[data-product]');
    if (prod) {
      const p = store.findProduct(prod.dataset.product);
      if (p) showQuantity(p);
      return;
    }
    const rec = e.target.closest('[data-recipe]');
    if (rec) {
      const house = !!rec.dataset.house;
      const list = house ? store.state.houseRecipes : store.state.myRecipes;
      const r = list.find((x) => x.id === rec.dataset.recipe);
      if (r) showRecipe(r, house);
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'scan') {
      openScanner({
        onProduct: (p) => showQuantity(p),
      });
    } else if (act === 'new') {
      openProductForm({
        mode: 'new-mine',
        prefill: query.trim() ? { nome: query.trim() } : null,
        onSaved: (p) => showQuantity(p),
      });
    } else if (act === 'copy-yesterday') {
      const btn = e.target.closest('button');
      await busy(btn, async () => {
        try {
          const n = await store.copyDay(addDays(day, -1), day, slot);
          sheet.close();
          toast(`${n} ${n === 1 ? 'item copiado' : 'itens copiados'} de ontem.`);
        } catch (err) {
          toastError(err);
        }
      });
    }
  });

  if (startRecipe) showRecipe(startRecipe.recipe, startRecipe.house);
  else showList();
  return sheet;
}

function searchRecipes(query) {
  const words = store.searchProducts(query, [
    ...store.state.myRecipes.map((r) => ({ ...r, house: false })),
    ...store.state.houseRecipes.map((r) => ({ ...r, house: true })),
  ]);
  return words.map((r) => [r, r.house]);
}

function slotPicker(current) {
  return `<div class="field-label">Refeição</div>
    <div class="slot-pick">${SLOTS.map((s) =>
      `<button class="chip" data-slot="${s.key}" aria-pressed="${s.key === current}">${s.short}</button>`).join('')}</div>`;
}

/**
 * Passo de quantidade, usado dentro do picker e sozinho
 * (ex.: "Adicionar ao diário" a partir da despensa).
 */
function renderQuantityStep(sheet, product, { diary, slot, onBack, backLabel, onSlot, onConfirm }) {
  const unit = product.unidade;
  const lastEntry = store.lastEntry(product.id);
  let chosenSlot = slot;
  let current = { qty: 0, porcoes: null };
  const n = nutrOf(product);

  sheet.setTitle(product.nome, `${product.source === 'meu' ? 'Meu produto' : 'Da Nutri'} · ${fmt(n.kcal, 0)} kcal em 100 ${unit}`);
  sheet.setBody(`
    <div class="field-label">Quantidade</div>
    <div class="qty-field"></div>
    ${diary ? `<div style="margin-top:16px">${slotPicker(chosenSlot)}</div>` : ''}
    <div class="preview-card" aria-live="polite"></div>`);
  sheet.setFooter(`
    ${onBack ? `<button class="btn soft" data-q="back">${backLabel}</button>` : ''}
    <button class="btn primary" data-q="ok">${icon('plus')}<span></span></button>`);
  const okBtn = $('[data-q="ok"]', sheet.foot);

  function paint() {
    const { qty, porcoes } = current;
    const t = scale(n, qty || 0);
    const amount = porcoes ? `${portionLabel(porcoes, product.porcao_nome)} · ${fmt(qty)} ${unit}` : `${fmt(qty || 0)} ${unit}`;
    $('.preview-card', sheet.body).innerHTML = `
      <div class="preview-kcal"><span class="muted">${esc(amount)}</span>
        <b>${fmt(t.kcal, 0)} <small>kcal</small></b></div>
      ${stackBar(t)}<div style="margin-top:8px">${macroLegend(t)}</div>`;
    $('span', okBtn).textContent = diary ? `Adicionar ${slotTo(chosenSlot)}` : 'Adicionar à receita';
    okBtn.disabled = !(qty > 0 && qty <= 5000);
  }

  mountQtyField($('.qty-field', sheet.body), {
    unidade: unit,
    porcaoG: product.porcao_g,
    porcaoNome: product.porcao_nome,
    qty: lastEntry?.qty,
    porcoes: lastEntry?.porcoes,
    last: lastEntry && !lastEntry.porcoes ? lastEntry.qty : null,
    onChange: (v) => {
      current = v;
      paint();
    },
    onSubmit: () => okBtn.click(),
  });

  let handler = null;
  const cleanup = () => sheet.el.removeEventListener('click', handler);
  handler = async (e) => {
    const s = e.target.closest('[data-slot]');
    if (s) {
      chosenSlot = s.dataset.slot;
      onSlot?.(chosenSlot);
      $$('[data-slot]', sheet.body).forEach((b) => b.setAttribute('aria-pressed', b === s));
      paint();
      return;
    }
    const q = e.target.closest('[data-q]')?.dataset.q;
    if (q === 'back') {
      cleanup();
      onBack();
    } else if (q === 'ok' && current.qty > 0) {
      await busy(okBtn, () => onConfirm(current.qty, chosenSlot, current.porcoes));
    }
  };
  sheet.el.addEventListener('click', handler);
  const originalSetBody = sheet.setBody;
  sheet.setBody = (html) => {
    cleanup();
    sheet.setBody = originalSetBody;
    originalSetBody(html);
  };
  paint();
}

/** Atalho: já abre direto na quantidade (vindo da despensa ou do scanner). */
export function openQuantitySheet(product, { day = isoDay(), slot = slotForNow() } = {}) {
  const sheet = openSheet({ className: 'picker-sheet' });
  renderQuantityStep(sheet, product, {
    diary: true,
    slot,
    onConfirm: async (qty, chosenSlot, porcoes) => {
      try {
        const created = await store.addToDiary(day, chosenSlot, [store.itemFrom(product, qty, porcoes)]);
        sheet.close();
        toast(`${product.nome} → ${slotLabel(chosenSlot)}`, {
          action: { label: 'Desfazer', run: () => Promise.all(created.map((c) => store.deleteEntry(c.id))).catch(toastError) },
        });
      } catch (err) {
        toastError(err);
      }
    },
  });
  return sheet;
}
