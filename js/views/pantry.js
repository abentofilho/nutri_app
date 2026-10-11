import { foodImg, productIcon } from '../foods.js';
import { icon } from '../icons.js';
import { checkProduct } from '../nutrition.js';
import * as store from '../store.js';
import { openScanner } from '../scanner.js';
import { openProduct, openProductForm } from '../sheets/product.js';
import { emptyState, stackBar } from '../ui.js';
import { $, debounce, esc, fmt } from '../util.js';

export const title = 'Despensa';

const FILTERS = [
  { key: 'todos', label: 'Tudo' },
  { key: 'casa', label: 'Da Nutri' },
  { key: 'meu', label: 'Meus' },
  { key: 'fav', label: 'Favoritos' },
];

let filter = 'todos';
let query = '';

export function render() {
  return `
    <div class="page-head">
      <h1 class="page-title">Despensa</h1>
      ${store.isAdmin() ? `<button class="btn ghost sm" data-act="new-catalog">${icon('shield')}Produto da Nutri</button>` : ''}
    </div>
    <div class="toolbar">
      <div class="toolbar-row">
        <label class="search">${icon('search')}
          <span class="sr-only">Buscar na despensa</span>
          <input class="input" type="search" placeholder="Buscar produto" value="${esc(query)}" autocomplete="off" enterkeyhint="search">
        </label>
        <button class="icon-btn boxed" data-act="scan" aria-label="Ler código de barras">${icon('barcode')}</button>
        <button class="icon-btn boxed primary" data-act="new" aria-label="Cadastrar produto">${icon('plus')}</button>
      </div>
      <div class="seg" role="group" aria-label="Filtrar">${FILTERS.map((f) =>
        `<button class="chip" data-filter="${f.key}" aria-pressed="${f.key === filter}">${f.label}<span class="count"></span></button>`).join('')}</div>
    </div>
    <div class="product-list" aria-live="polite"></div>`;
}

function row(p) {
  const warn = checkProduct(p).warnings.length > 0;
  const tags = [
    p.source === 'meu' ? '<span class="tag meu">meu</span>' : '',
    store.isFavorite(p.id) ? `<span class="tag fav">${icon('starFill')}</span>` : '',
    warn ? `<span class="tag warn" title="Valores para conferir">${icon('alert')}</span>` : '',
    store.pendingSuggestionFor(p) ? '<span class="tag ok">sugerido</span>' : '',
  ].join('');
  return `
    <button class="product-row" data-product="${esc(p.id)}">
      ${foodImg(productIcon(p), 44)}
      <span class="pr-main">
        <span class="pr-name">${esc(p.nome)}</span>
        <span class="pr-meta">${stackBar(p)}${tags}</span>
      </span>
      <span class="pr-kcal"><b>${fmt(p.kcal, 0)}</b><small>kcal/100${p.unidade}</small></span>
    </button>`;
}

function filtered() {
  let list = store.productList();
  if (filter === 'casa' || filter === 'meu') list = list.filter((p) => p.source === filter);
  if (filter === 'fav') list = list.filter((p) => store.isFavorite(p.id));
  return store.searchProducts(query, list);
}

export function update(el) {
  const all = store.productList();
  const counts = {
    todos: all.length,
    casa: all.filter((p) => p.source === 'casa').length,
    meu: all.filter((p) => p.source === 'meu').length,
    fav: all.filter((p) => store.isFavorite(p.id)).length,
  };
  for (const f of FILTERS) {
    const chip = $(`[data-filter="${f.key}"]`, el);
    chip.setAttribute('aria-pressed', f.key === filter);
    $('.count', chip).textContent = counts[f.key] || '';
  }
  const list = filtered();
  const box = $('.product-list', el);
  if (list.length) {
    box.innerHTML = `<div class="card list-card">${list.map(row).join('')}</div>`;
  } else if (query) {
    box.innerHTML = emptyState('search', `Nada encontrado para "${esc(query)}".`,
      `<button class="btn soft sm" data-act="new">${icon('plus')}Cadastrar "${esc(query)}"</button>`);
  } else if (filter === 'meu') {
    box.innerHTML = emptyState('pantry', 'Os produtos que você cadastrar ficam só para você.',
      `<button class="btn soft sm" data-act="scan">${icon('barcode')}Escanear um rótulo</button>`);
  } else if (filter === 'fav') {
    box.innerHTML = emptyState('star', 'Marque a estrela de um produto para ele aparecer aqui e no topo das buscas.');
  } else {
    box.innerHTML = emptyState('pantry', 'Nenhum produto ainda.');
  }
}

export function mount(el) {
  const input = $('input[type=search]', el);
  input.addEventListener('input', debounce(() => {
    query = input.value;
    update(el);
  }, 80));

  el.addEventListener('click', (e) => {
    const f = e.target.closest('[data-filter]');
    if (f) {
      filter = f.dataset.filter;
      update(el);
      return;
    }
    const p = e.target.closest('[data-product]');
    if (p) {
      const product = store.findProduct(p.dataset.product);
      if (product) openProduct(product);
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'scan') openScanner({ onProduct: (product) => openProduct(product) });
    if (act === 'new') openProductForm({ mode: 'new-mine', prefill: query ? { nome: query } : null, onSaved: openProduct });
    if (act === 'new-catalog') openProductForm({ mode: 'new-catalog', onSaved: openProduct });
  });
  update(el);
}
