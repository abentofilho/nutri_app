import { icon } from '../icons.js';
import { NUTRIENTS, checkProduct, nutrOf } from '../nutrition.js';
import * as store from '../store.js';
import { openProduct, openProductForm } from '../sheets/product.js';
import { foodImg, productIcon } from '../foods.js';
import { busy, confirmDialog, emptyState, nutriTable, promptDialog, toast, toastError } from '../ui.js';
import { esc, fmt, isoDay, normalize, shortDate } from '../util.js';

export const title = 'Curadoria';

let tab = 'pendentes';
let pending = null;      // null = carregando
let loadError = null;

export function render() {
  if (!store.isAdmin()) {
    return emptyState('shield', 'Esta área é só do administrador do catálogo.', '<a class="btn soft sm" href="#/perfil">Voltar ao perfil</a>');
  }
  return `
    <div class="page-head">
      <div>
        <a href="#/perfil" class="link-btn" style="font-size:13px">${icon('left')}Perfil</a>
        <h1 class="page-title" style="margin-top:6px">Curadoria</h1>
        <p class="page-sub">O que entra, muda ou sai do catálogo da Nutri passa por aqui.</p>
      </div>
    </div>
    <div class="seg" style="margin-bottom:14px">
      <button class="chip" data-tab="pendentes" aria-pressed="${tab === 'pendentes'}">${icon('send')}Sugestões<span class="count">${pending?.length || ''}</span></button>
      <button class="chip" data-tab="duplicados" aria-pressed="${tab === 'duplicados'}">${icon('copy')}Duplicados<span class="count">${store.duplicateGroups().length || ''}</span></button>
      <button class="chip" data-tab="lixeira" aria-pressed="${tab === 'lixeira'}">${icon('trash')}Lixeira<span class="count">${store.state.catalog.filter((p) => p.archived).length || ''}</span></button>
    </div>
    <div class="admin-body">${{ pendentes: renderPending, duplicados: renderDuplicates, lixeira: renderTrash }[tab]()}</div>`;
}

function diffRows(current, proposed) {
  const fields = [
    { key: 'nome', label: 'Nome', text: true },
    { key: 'unidade', label: 'Base', text: true },
    { key: 'barcode', label: 'Código de barras', text: true },
    ...NUTRIENTS.map((n) => ({ key: n.key, label: `${n.label} (${n.unit})` })),
  ];
  const show = (f, v) => (f.text ? esc(v || '—') : fmt(v || 0));
  const rows = fields
    .filter((f) => String(current[f.key] ?? '') !== String(proposed[f.key] ?? '') && !(f.key === 'barcode' && !proposed.barcode))
    .map((f) => `<tr class="changed"><td>${f.label}</td><td class="old">${show(f, current[f.key])}</td><td class="new">${show(f, proposed[f.key])}</td></tr>`);
  return rows.length
    ? `<table class="diff"><tbody>${rows.join('')}</tbody></table>`
    : '<p class="muted" style="margin:8px 0 0">Nenhuma diferença em relação ao catálogo atual.</p>';
}

function suggestionCard(s) {
  const current = s.kind === 'correcao' ? store.findProduct(s.product_id) : null;
  const { warnings } = checkProduct(s.product);
  const dup = s.kind === 'novo' && store.productList().some((p) => p.source === 'casa' && normalize(p.nome) === normalize(s.product.nome));
  return `
    <article class="card" data-suggestion="${esc(s.id)}">
      <div class="btn-row" style="justify-content:space-between;align-items:center">
        <span class="badge ${s.kind === 'novo' ? 'casa' : 'meu'}">${s.kind === 'novo' ? 'novo produto' : 'correção'}</span>
        <span class="faint" style="font-size:12.5px">${esc(s.author_nome)} · ${shortDate(isoDay(new Date(s.created_at)))}</span>
      </div>
      <h3 class="serif" style="margin:10px 0 2px;font-size:19px">${esc(s.product.nome)}</h3>
      <div class="faint num" style="font-size:12px">por 100 ${s.product.unidade}${s.product.barcode ? ` · ${esc(s.product.barcode)}` : ''}</div>
      ${s.note ? `<div class="notice" style="margin-top:10px">${icon('info')}<div>“${esc(s.note)}”</div></div>` : ''}
      ${dup ? `<div class="notice warn" style="margin-top:10px">${icon('alert')}<div>Já existe um produto no catálogo com este nome.</div></div>` : ''}
      ${warnings.length ? `<div class="notice warn" style="margin-top:10px">${icon('alert')}<div>${warnings.map((w) => esc(w.msg)).join('<br>')}</div></div>` : ''}
      ${current ? diffRows(current, s.product) : nutriTable(nutrOf(s.product), { title: '100 ' + s.product.unidade, vd: false })}
      <div class="btn-row" style="margin-top:14px">
        <button class="btn primary sm" data-act="approve">${icon('check')}Aprovar</button>
        <button class="btn soft sm" data-act="edit">${icon('edit')}Editar e aprovar</button>
        <button class="btn danger sm" data-act="reject">${icon('x')}Recusar</button>
      </div>
    </article>`;
}

function renderPending() {
  if (loadError) return emptyState('alert', esc(loadError), '<button class="btn soft sm" data-act="reload">Tentar de novo</button>');
  if (!pending) return '<div class="skeleton" style="height:180px"></div>';
  if (!pending.length) return emptyState('check', 'Nenhuma sugestão esperando revisão.');
  return pending.map(suggestionCard).join('');
}

const productLine = (p) => `
  <div class="list-row">
    ${foodImg(productIcon(p), 36)}
    <div class="lr-main"><b>${esc(p.nome)}</b><span>${fmt(p.kcal, 0)} kcal · ${fmt(p.carb)} C · ${fmt(p.prot)} P · ${fmt(p.gord)} G${p.barcode ? ` · ${esc(p.barcode)}` : ''}</span></div>
    <button class="icon-btn" data-view="${esc(p.id)}" aria-label="Ver ${esc(p.nome)}">${icon('info')}</button>`;

function renderDuplicates() {
  const groups = store.duplicateGroups();
  if (!groups.length) return emptyState('check', 'Nenhum produto repetido no catálogo.');
  return `<p class="muted" style="margin:0 0 4px">Mesmo nome ou mesmo código de barras. Mantenha o cadastro certo e mande os outros para a lixeira.</p>
    ${groups.map((g) => `<div class="card list-card">${g.map((p) => `${productLine(p)}
      <button class="btn danger sm" data-trash="${esc(p.id)}">${icon('trash')}Excluir</button>
    </div>`).join('')}</div>`).join('')}`;
}

function renderTrash() {
  const trashed = store.state.catalog.filter((p) => p.archived);
  if (!trashed.length) return emptyState('trash', 'A lixeira está vazia.');
  return `<p class="muted" style="margin:0 0 4px">Produtos na lixeira não aparecem para ninguém. Excluir de vez não afeta diários e receitas, que guardam uma cópia dos valores.</p>
    <div class="card list-card">${trashed.map((p) => `${productLine(p)}
      <button class="icon-btn" data-restore="${esc(p.id)}" aria-label="Restaurar ${esc(p.nome)}">${icon('undo')}</button>
      <button class="icon-btn danger-text" data-purge="${esc(p.id)}" aria-label="Excluir ${esc(p.nome)} de vez">${icon('trash')}</button>
    </div>`).join('')}</div>`;
}

async function load(el) {
  loadError = null;
  try {
    pending = await store.loadPending();
  } catch (err) {
    loadError = err.message;
  }
  if (el.isConnected) el.innerHTML = render();
}

export function mount(el) {
  pending = null;
  if (store.isAdmin()) load(el);

  el.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) {
      tab = t.dataset.tab;
      el.innerHTML = render();
      return;
    }
    const trash = e.target.closest('[data-trash]');
    if (trash) {
      try {
        await busy(trash, () => store.setArchived(trash.dataset.trash, true));
        el.innerHTML = render();
        toast('Produto movido para a lixeira.', {
          action: { label: 'Desfazer', run: () => store.setArchived(trash.dataset.trash, false).then(() => { el.innerHTML = render(); }, toastError) },
        });
      } catch (err) {
        toastError(err);
      }
      return;
    }
    const purge = e.target.closest('[data-purge]');
    if (purge) {
      const p = store.findProduct(purge.dataset.purge);
      if (await confirmDialog({
        title: 'Excluir de vez?',
        message: `"${esc(p?.nome || '')}" sai do banco de dados e não dá para desfazer.`,
        confirm: 'Excluir de vez',
        danger: true,
      })) {
        try {
          await store.deleteCatalogProduct(purge.dataset.purge);
          el.innerHTML = render();
          toast('Produto excluído.');
        } catch (err) {
          toastError(err);
        }
      }
      return;
    }
    const restore = e.target.closest('[data-restore]');
    if (restore) {
      try {
        await busy(restore, () => store.setArchived(restore.dataset.restore, false));
        el.innerHTML = render();
        toast('Produto de volta à despensa.');
      } catch (err) {
        toastError(err);
      }
      return;
    }
    const view = e.target.closest('[data-view]');
    if (view) {
      openProduct(store.findProduct(view.dataset.view));
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'reload') {
      load(el);
      return;
    }
    const cardEl = btn.closest('[data-suggestion]');
    const s = pending?.find((x) => x.id === cardEl?.dataset.suggestion);
    if (!s) return;
    const done = () => {
      pending = pending.filter((x) => x.id !== s.id);
      el.innerHTML = render();
    };
    try {
      if (btn.dataset.act === 'approve') {
        await busy(btn, () => store.approveSuggestion(s.id));
        toast(s.kind === 'novo' ? `"${s.product.nome}" entrou no catálogo da Nutri.` : 'Correção aplicada ao catálogo.');
        done();
      } else if (btn.dataset.act === 'edit') {
        openProductForm({
          mode: 'approve',
          suggestionId: s.id,
          product: s.kind === 'correcao' ? { ...store.findProduct(s.product_id), ...s.product } : s.product,
          onSaved: done,
        });
      } else if (btn.dataset.act === 'reject') {
        const note = await promptDialog({
          title: 'Recusar sugestão',
          label: 'motivo (opcional, quem sugeriu vai ver)',
          confirm: 'Recusar',
          required: false,
          maxLength: 500,
        });
        if (note === null) return;
        await busy(btn, () => store.rejectSuggestion(s.id, note));
        toast('Sugestão recusada.');
        done();
      }
    } catch (err) {
      toastError(err);
    }
  });
}

// O catálogo pode mudar enquanto a tela está aberta (aprovar, excluir).
export function update(el) {
  if (tab !== 'pendentes' && el.isConnected) el.innerHTML = render();
}
