import { foodImg, recipeIcon } from '../foods.js';
import { icon } from '../icons.js';
import * as store from '../store.js';
import { openRecipe, openRecipeBuilder } from '../sheets/recipe.js';
import { emptyState } from '../ui.js';
import { esc, fmt } from '../util.js';

export const title = 'Receitas';

function recipeCard(r, house) {
  const t = store.recipeTotals(r);
  const items = store.recipeItems(r);
  return `
    <button class="recipe-card" data-recipe="${esc(r.id)}" data-house="${house ? 1 : ''}">
      ${foodImg(recipeIcon({ ...r, items }), 52)}
      <span class="rc-main">
        <span class="rc-name">${esc(r.nome)}</span>
        <span class="rc-meta">${items.length} ${items.length === 1 ? 'ingrediente' : 'ingredientes'}</span>
      </span>
      <span class="rc-kcal"><b>${fmt(t.kcal, 0)}</b><small>kcal</small></span>
    </button>`;
}

export function render() {
  const { houseRecipes, myRecipes } = store.state;
  const admin = store.isAdmin();
  return `
    <div class="page-head">
      <h1 class="page-title">Receitas</h1>
      <button class="btn primary sm" data-act="new">${icon('plus')}Nova receita</button>
    </div>

    <section class="house-hero">
      <span class="hero-foods" aria-hidden="true">${foodImg('salad', 46)}${foodImg('poultry', 40)}${foodImg('bread', 38)}</span>
      <div>
        <h2>Receitas da Nutri</h2>
        <p>Combinações prontas, com os valores calculados pelos rótulos.</p>
      </div>
      ${admin ? `<button class="icon-btn" data-act="new-house" aria-label="Nova Receita da Nutri">${icon('plus')}</button>` : ''}
    </section>
    <div class="recipe-grid">
      ${houseRecipes.length ? houseRecipes.map((r) => recipeCard(r, true)).join('') : emptyState('chef', 'As Receitas da Nutri aparecem aqui.')}
    </div>

    <h2 class="section-title">Minhas receitas</h2>
    <div class="recipe-grid">
      ${myRecipes.length ? myRecipes.map((r) => recipeCard(r, false)).join('')
        : emptyState('recipes', 'Monte uma vez as refeições de sempre e registre depois com um toque.')}
    </div>`;
}

export function mount(el) {
  el.addEventListener('click', (e) => {
    const card = e.target.closest('[data-recipe]');
    if (card) {
      const house = !!card.dataset.house;
      const r = (house ? store.state.houseRecipes : store.state.myRecipes).find((x) => x.id === card.dataset.recipe);
      if (r) openRecipe(r, { house });
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'new') openRecipeBuilder();
    if (act === 'new-house') openRecipeBuilder({ house: true });
  });
}
