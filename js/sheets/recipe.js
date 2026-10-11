import { foodImg, productIcon, recipeIcon } from '../foods.js';
import { icon } from '../icons.js';
import { scale, slotForNow, sumItems } from '../nutrition.js';
import * as store from '../store.js';
import {
  busy, confirmDialog, foodHero, nutriTable, openSheet, toast, toastError,
} from '../ui.js';
import { $, esc, fmt, isoDay, longDate, parseNum, portionLabel, toInput } from '../util.js';
import { openPicker } from './picker.js';

// ---------- detalhes ----------

export function openRecipe(recipe, { house = false } = {}) {
  const sheet = openSheet({ className: 'recipe-sheet' });
  const admin = store.isAdmin();

  function current() {
    const list = house ? store.state.houseRecipes : store.state.myRecipes;
    return list.find((r) => r.id === recipe.id) || recipe;
  }

  function render() {
    const r = current();
    const items = store.recipeItems(r);
    const totals = store.recipeTotals(r);
    const legacy = items.some((it) => !it.nutr);
    sheet.setTitle(r.nome, house ? 'Receita da Nutri' : `Minha receita · salva em ${longDate(isoDay(new Date(r.saved_at)))}`);
    sheet.setBody(`
      ${r.descricao ? `<p class="muted" style="margin:0 0 14px">${esc(r.descricao)}</p>` : ''}
      ${foodHero(recipeIcon({ ...r, items }), totals, `${items.length} ${items.length === 1 ? 'ingrediente' : 'ingredientes'}`)}
      <div>${items.map((it) => `
        <div class="builder-item">
          ${foodImg(productIcon(it), 32)}
          <span class="bi-name">${esc(it.nome)}
            <small>${it.porcoes ? `${esc(portionLabel(it.porcoes, it.porcao_nome))} · ` : ''}${fmt(it.qty)} ${it.unidade}${it.nutr ? ` · ${fmt(scale(it.nutr, it.qty).kcal, 0)} kcal` : ' · não está mais no catálogo'}</small></span>
        </div>`).join('')}</div>
      <h3 class="section-title">Tabela nutricional</h3>
      ${nutriTable(totals, { title: 'Receita' })}
      ${legacy ? `<p class="table-note">Receita da versão anterior: valores calculados com o catálogo atual.</p>` : ''}
      <div class="btn-row" style="margin-top:18px">
        ${house ? `<button class="btn soft sm" data-act="copy">${icon('copy')}Salvar uma cópia minha</button>` : ''}
        ${!house && admin ? `<button class="btn soft sm" data-act="promote">${icon('chef')}Levar para Receitas da Nutri</button>` : ''}
        ${!house || admin ? `<button class="btn danger sm" data-act="delete">${icon('trash')}Excluir</button>` : ''}
      </div>`);
    sheet.setFooter(`
      ${!house || admin ? `<button class="btn soft" data-act="edit" style="flex:0 0 auto">${icon('edit')}Editar</button>` : ''}
      <button class="btn primary" data-act="add">${icon('plus')}Adicionar ao diário</button>`);
  }

  sheet.el.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const r = current();
    try {
      switch (btn.dataset.act) {
        case 'add':
          sheet.close();
          openPicker({ slot: slotForNow(), startRecipe: { recipe: r, house } });
          break;
        case 'edit':
          openRecipeBuilder({ recipe: r, house });
          break;
        case 'copy':
          await busy(btn, () => store.saveRecipe({ nome: r.nome, descricao: r.descricao, items: store.recipeItems(r).filter((it) => it.nutr) }));
          toast('Cópia salva em Minhas receitas.');
          break;
        case 'promote':
          if (await confirmDialog({
            title: 'Levar para as Receitas da Nutri?',
            message: `"${esc(r.nome)}" passa a aparecer para todos, com a sua foto de criador.`,
            confirm: 'Publicar',
          })) {
            await busy(btn, () => store.saveRecipe({ nome: r.nome, descricao: r.descricao, items: store.recipeItems(r).filter((it) => it.nutr) }, { house: true }));
            toast('Agora faz parte das Receitas da Nutri.');
          }
          break;
        case 'delete':
          if (await confirmDialog({
            title: 'Excluir receita?',
            message: `"${esc(r.nome)}" será apagada${house ? ' para todos os usuários' : ''}. O que já foi registrado no diário não muda.`,
            confirm: 'Excluir',
            danger: true,
          })) {
            await store.deleteRecipe(r.id, { house });
            sheet.close();
            toast('Receita excluída.');
          }
          break;
        default:
      }
    } catch (err) {
      toastError(err);
    }
  });

  const unsub = store.subscribe(() => !sheet.closed && render());
  const remove = sheet._remove;
  sheet._remove = () => {
    unsub();
    remove();
  };
  render();
  return sheet;
}

// ---------- montar / editar ----------
// É o "Nova refeição" da v1: escolher produto, informar a quantidade,
// ver a tabela somando e guardar com um nome.

export function openRecipeBuilder({ recipe = null, house = false } = {}) {
  let items = recipe ? store.recipeItems(recipe).filter((it) => it.nutr).map((it) => ({ ...it })) : [];
  const sheet = openSheet({
    title: recipe ? 'Editar receita' : house ? 'Nova Receita da Nutri' : 'Nova receita',
    subtitle: 'Escolha os produtos e as quantidades',
    className: 'builder-sheet',
  });

  sheet.setBody(`
    <label class="field">
      <span class="field-label">nome da receita</span>
      <input class="input" name="nome" maxlength="120" placeholder="ex: Café da manhã de domingo" value="${esc(recipe?.nome || '')}">
    </label>
    <label class="field">
      <span class="field-label">descrição (opcional)</span>
      <input class="input" name="descricao" maxlength="400" placeholder="ex: rende 1 porção" value="${esc(recipe?.descricao || '')}">
    </label>
    <h3 class="section-title">Ingredientes</h3>
    <div class="items"></div>
    <button class="btn soft block" data-act="add-item" style="margin-top:12px">${icon('plus')}Adicionar ingrediente</button>
    <div class="totals"></div>`);
  sheet.setFooter(`<button class="btn soft" data-close>Cancelar</button>
    <button class="btn primary" data-act="save">${recipe ? 'Salvar alterações' : 'Guardar receita'}</button>`);

  function paintItems() {
    $('.items', sheet.body).innerHTML = items.length
      ? items.map((it, i) => `
        <div class="builder-item">
          ${foodImg(productIcon(it), 32)}
          <span class="bi-name">${esc(it.nome)}<small>${fmt(scale(it.nutr, it.qty).kcal, 0)} kcal</small></span>
          <input class="input num" data-qty="${i}" inputmode="decimal" aria-label="Quantidade de ${esc(it.nome)}" value="${toInput(it.qty)}">
          <span class="unit">${it.unidade}</span>
          <button class="icon-btn" data-remove="${i}" aria-label="Remover ${esc(it.nome)}">${icon('x')}</button>
        </div>`).join('')
      : '<div class="empty" style="padding:16px">Nenhum ingrediente ainda.</div>';
    paintTotals();
  }

  function paintTotals() {
    const valid = items.filter((it) => it.qty > 0);
    $('.totals', sheet.body).innerHTML = valid.length
      ? `<h3 class="section-title">Totais da receita</h3>${nutriTable(sumItems(valid), { title: 'Total' })}`
      : '';
  }

  sheet.body.addEventListener('input', (e) => {
    const i = e.target.dataset.qty;
    if (i === undefined) return;
    const v = parseNum(e.target.value);
    items[i].qty = Number.isFinite(v) ? v : 0;
    items[i].porcoes = null;   // digitou em g/ml: a contagem de porções deixa de valer
    e.target.classList.toggle('invalid', !(items[i].qty > 0));
    e.target.closest('.builder-item').querySelector('small').textContent = `${fmt(scale(items[i].nutr, items[i].qty).kcal, 0)} kcal`;
    paintTotals();
  });

  sheet.el.addEventListener('click', async (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      items.splice(Number(rm.dataset.remove), 1);
      paintItems();
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'add-item') {
      openPicker({
        mode: 'builder',
        onPick: (item) => {
          items.push(item);
          paintItems();
        },
      });
    } else if (act === 'save') {
      const nome = $('[name=nome]', sheet.body).value.trim();
      const descricao = $('[name=descricao]', sheet.body).value.trim();
      if (!items.length) return toast('Adicione ao menos um ingrediente.', { error: true });
      if (items.some((it) => !(it.qty > 0 && it.qty <= 5000))) return toast('Confira as quantidades.', { error: true });
      if (!nome) {
        $('[name=nome]', sheet.body).focus();
        return toast('Dê um nome para a receita.', { error: true });
      }
      try {
        await busy(e.target.closest('button'), () => store.saveRecipe({ nome, descricao, items }, { id: recipe?.id, house }));
        sheet.close();
        toast(recipe ? 'Receita atualizada.' : `"${nome}" guardada em ${house ? 'Receitas da Nutri' : 'Minhas receitas'}.`);
      } catch (err) {
        toastError(err);
      }
    }
  });

  paintItems();
  return sheet;
}
