import { productIcon } from '../foods.js';
import { icon } from '../icons.js';
import { NUTRIENTS, checkProduct, nutrOf, scale } from '../nutrition.js';
import * as store from '../store.js';
import {
  busy, confirmDialog, foodHero, nutriTable, openSheet, toast, toastError,
} from '../ui.js';
import { $, $$, esc, fmt, parseNum, toInput } from '../util.js';
import { openQuantitySheet } from './picker.js';
import { openScanner } from '../scanner.js';
import { describeRead, openLabelReader } from '../label-reader.js';

const sourceLabel = (p) => (p.source === 'casa' ? 'Catálogo da Nutri' : 'Meu produto');

// ---------- detalhes ----------

export function openProduct(product, { day } = {}) {
  const sheet = openSheet({ className: 'product-sheet' });

  function render() {
    const p = store.findProduct(product.id) || product;
    const { warnings } = checkProduct(p);
    const pending = store.pendingSuggestionFor(p);
    const fav = store.isFavorite(p.id);
    const admin = store.isAdmin();
    const n = nutrOf(p);

    sheet.setTitle(p.nome, `${sourceLabel(p)} · valores por 100 ${p.unidade}`);
    sheet.setBody(`
      ${foodHero(productIcon(p), n, `em 100 ${p.unidade}`)}
      ${p.porcao_g ? `<p class="portion-line">${icon('info')}1 ${esc(p.porcao_nome || 'porção')} = ${fmt(p.porcao_g)} ${p.unidade} · ${fmt(scale(n, p.porcao_g).kcal, 0)} kcal</p>` : ''}
      ${p.archived ? `<div class="notice warn" style="margin-top:12px">${icon('trash')}<div>Na lixeira: não aparece na despensa. O administrador pode restaurar ou excluir de vez na Curadoria.</div></div>` : ''}
      ${warnings.length ? `
        <div class="notice warn" style="margin-top:12px">${icon('alert')}
          <div><b>Confira estes valores</b><br>${warnings.map((w) => esc(w.msg)).join('<br>')}</div>
        </div>` : ''}
      ${pending ? `
        <div class="notice ok" style="margin-top:12px">${icon('send')}
          <div>Você já enviou uma sugestão${p.source === 'casa' ? ' de correção' : ''} para este produto. Ela está aguardando o administrador.</div>
        </div>` : ''}
      ${nutriTable(n, { title: '100 ' + p.unidade, flags: warnings.map((w) => w.field) })}
      ${p.barcode ? `<p class="faint" style="font-size:12.5px;margin:12px 0 0">${icon('barcode', 'inline')} Código de barras <span class="num">${esc(p.barcode)}</span></p>` : ''}
      <div class="btn-row" style="margin-top:18px">
        ${p.source === 'meu' ? `
          <button class="btn soft sm" data-act="edit">${icon('edit')}Editar</button>
          ${admin
            ? `<button class="btn soft sm" data-act="publish">${icon('send')}Publicar no catálogo</button>`
            : `<button class="btn soft sm" data-act="suggest-new" ${pending ? 'disabled' : ''}>${icon('send')}Sugerir para o catálogo</button>`}
          <button class="btn danger sm" data-act="delete">${icon('trash')}Excluir</button>` : ''}
        ${p.source === 'casa' && !admin ? `
          <button class="btn soft sm" data-act="suggest-fix" ${pending ? 'disabled' : ''}>${icon('edit')}Sugerir correção</button>` : ''}
        ${p.source === 'casa' && admin ? `
          <button class="btn soft sm" data-act="admin-edit">${icon('edit')}Editar no catálogo</button>
          ${p.archived
            ? `<button class="btn soft sm" data-act="archive">${icon('undo')}Restaurar</button>`
            : `<button class="btn danger sm" data-act="archive">${icon('trash')}Excluir do catálogo</button>`}` : ''}
      </div>`);
    sheet.setFooter(`
      <button class="btn soft" data-act="fav" aria-pressed="${fav}" style="flex:0 0 auto">
        ${icon(fav ? 'starFill' : 'star')}${fav ? 'Favorito' : 'Favoritar'}</button>
      ${p.archived ? '' : `<button class="btn primary" data-act="add">${icon('plus')}Adicionar ao diário</button>`}`);
  }

  async function onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const p = store.findProduct(product.id) || product;
    try {
      switch (btn.dataset.act) {
        case 'add':
          sheet.close();
          openQuantitySheet(p, { day });
          break;
        case 'fav':
          await store.toggleFavorite(p.id);
          break;
        case 'edit':
          openProductForm({ mode: 'edit-mine', product: p, onSaved: render });
          break;
        case 'admin-edit':
          openProductForm({ mode: 'edit-catalog', product: p, onSaved: render });
          break;
        case 'suggest-fix':
          openProductForm({ mode: 'suggest-fix', product: p, onSaved: render });
          break;
        case 'suggest-new':
          await sendNewSuggestion(p, btn);
          break;
        case 'publish':
          if (await confirmDialog({
            title: 'Publicar no catálogo da Nutri?',
            message: `"${esc(p.nome)}" passa a aparecer para todo mundo. O seu produto pessoal continua existindo.`,
            confirm: 'Publicar',
          })) {
            await busy(btn, () => store.saveCatalogProduct(p));
            toast('Publicado no catálogo da Nutri.');
          }
          break;
        case 'archive': {
          const archive = !p.archived;
          if (archive && !await confirmDialog({
            title: 'Excluir do catálogo?',
            message: `"${esc(p.nome)}" some da despensa de todos e vai para a lixeira da Curadoria, onde dá para restaurar ou excluir de vez. Diários e receitas de quem já usou continuam com os valores.`,
            confirm: 'Excluir',
            danger: true,
          })) return;
          await busy(btn, () => store.setArchived(p.id, archive));
          toast(archive ? 'Produto movido para a lixeira.' : 'Produto restaurado.', archive ? {
            action: { label: 'Desfazer', run: () => store.setArchived(p.id, false).catch(toastError) },
          } : {});
          if (archive) sheet.close();
          break;
        }
        case 'delete':
          if (await confirmDialog({
            title: 'Excluir produto?',
            message: `"${esc(p.nome)}" sai da sua despensa. O que já está no diário e nas receitas não muda.`,
            confirm: 'Excluir',
            danger: true,
          })) {
            await store.deleteMyProduct(p.id);
            toast('Produto excluído.');
            sheet.close();
          }
          break;
        default:
      }
    } catch (err) {
      toastError(err);
    }
  }

  sheet.el.addEventListener('click', onClick);
  const unsub = store.subscribe(() => !sheet.closed && render());
  const origRemove = sheet._remove;
  sheet._remove = () => {
    unsub();
    origRemove();
  };
  render();
  return sheet;
}

async function sendNewSuggestion(p, btn) {
  const note = await askNote('Sugerir para o catálogo da Nutri',
    `"${p.nome}" vai para a revisão do administrador. Se aprovado, passa a aparecer para todos os usuários.`);
  if (note === null) return;
  await busy(btn, () => store.suggest({ kind: 'novo', product: p, note }));
  toast('Sugestão enviada. Obrigado!');
}

function askNote(title, message) {
  return new Promise((resolve) => {
    let value = null;
    const sheet = openSheet({
      title,
      className: 'dialog',
      body: `<p class="muted" style="margin:0 0 12px">${esc(message)}</p>
        <label class="field"><span class="field-label">recado para o administrador (opcional)</span>
        <textarea class="textarea" maxlength="500" placeholder="ex: comprei no mercado do bairro, foto do rótulo confere"></textarea></label>`,
      footer: '<button class="btn soft" data-close>Cancelar</button><button class="btn primary" data-ok>Enviar sugestão</button>',
      onClose: () => resolve(value),
    });
    $('[data-ok]', sheet.foot).addEventListener('click', () => {
      value = $('textarea', sheet.body).value.trim();
      sheet.close();
    });
  });
}

// ---------- formulário ----------

// Porções caseiras mais comuns nos rótulos brasileiros.
const PORTION_NAMES = ['unidade', 'fatia', 'copo', 'xícara', 'colher de sopa', 'colher de chá', 'porção', 'pote', 'pacote', 'lata', 'pedaço', 'concha'];

const MODES = {
  'new-mine': { title: 'Novo produto', save: 'Salvar produto' },
  'edit-mine': { title: 'Editar produto', save: 'Salvar alterações' },
  'new-catalog': { title: 'Novo produto da Nutri', save: 'Adicionar ao catálogo' },
  'edit-catalog': { title: 'Editar produto da Nutri', save: 'Salvar no catálogo' },
  'suggest-fix': { title: 'Sugerir correção', save: 'Enviar sugestão' },
  approve: { title: 'Revisar e aprovar', save: 'Aprovar com estes valores' },
};

/**
 * mode: veja MODES. `prefill` vem do leitor de código de barras.
 * onSaved recebe o produto salvo (ou a sugestão enviada).
 */
export function openProductForm({ mode = 'new-mine', product = null, prefill = null, source = '', suggestionId = null, onSaved } = {}) {
  const cfg = MODES[mode];
  const base = { nome: '', unidade: 'g', barcode: '', ...(product || {}), ...(prefill || {}) };
  const sheet = openSheet({
    title: cfg.title,
    subtitle: 'Valores por 100 g ou 100 ml, como no rótulo',
    className: 'form-sheet',
  });

  const portionNames = PORTION_NAMES.includes(base.porcao_nome) || !base.porcao_nome
    ? PORTION_NAMES : [base.porcao_nome, ...PORTION_NAMES];

  const numField = (n) => `
    <label class="field ${n.sub ? 'sub' : ''}">
      <span class="field-label">${n.label.toLowerCase()} (${n.unit})</span>
      <input class="input num" name="${n.key}" inputmode="decimal" autocomplete="off" value="${toInput(base[n.key])}" placeholder="0">
    </label>`;

  sheet.setBody(`
    ${source ? `<div class="notice ok" style="margin-bottom:14px">${icon('info')}<div>${source}</div></div>` : ''}
    ${mode === 'suggest-fix' ? `<div class="notice" style="margin-bottom:14px">${icon('info')}<div>Corrija o que estiver diferente do rótulo. O administrador revisa antes de mudar para todo mundo.</div></div>` : ''}
    <button type="button" class="ocr-btn" data-act="ocr">
      <span class="nc-icon">${icon('camera')}</span>
      <span class="lr-main"><b>Ler a tabela com a câmera</b><span>Preenche os valores a partir de uma foto do rótulo</span></span>
      ${icon('right')}
    </button>
    <div class="read-note" hidden></div>
    <form class="form-grid" novalidate>
      <label class="field full">
        <span class="field-label">nome do produto</span>
        <input class="input" name="nome" maxlength="120" required value="${esc(base.nome)}" placeholder="ex: Queijo mussarela Tirolez">
      </label>
      <div class="field">
        <span class="field-label">base</span>
        <div class="unit-toggle" role="radiogroup">
          <button type="button" class="chip" data-unit="g" aria-pressed="${base.unidade !== 'ml'}">100 g</button>
          <button type="button" class="chip" data-unit="ml" aria-pressed="${base.unidade === 'ml'}">100 ml</button>
        </div>
      </div>
      <div class="field">
        <label class="field-label" for="pf-barcode-${sheet.id}">código de barras</label>
        <div class="toolbar-row">
          <input class="input num" id="pf-barcode-${sheet.id}" name="barcode" inputmode="numeric" maxlength="14" value="${esc(base.barcode || '')}" placeholder="opcional">
          <button type="button" class="icon-btn" data-act="scan" aria-label="Ler código com a câmera">${icon('barcode')}</button>
        </div>
      </div>
      <div class="field full">
        <span class="field-label">Porção caseira (opcional)</span>
        <div class="portion-row">
          <span>1</span>
          <select class="select" name="porcao_nome" aria-label="Tipo de porção">
            ${portionNames.map((nm) => `<option ${nm === (base.porcao_nome || 'unidade') ? 'selected' : ''}>${esc(nm)}</option>`).join('')}
          </select>
          <span>=</span>
          <input class="input num" name="porcao_g" inputmode="decimal" aria-label="Peso da porção" value="${toInput(base.porcao_g)}" placeholder="46">
          <span class="portion-unit">${base.unidade === 'ml' ? 'ml' : 'g'}</span>
        </div>
        <p class="field-hint">Ex.: 1 unidade = 46 g. Assim dá para registrar "2 ovos" sem pesar.</p>
      </div>
      ${NUTRIENTS.map(numField).join('')}
      ${mode === 'suggest-fix' ? `
        <label class="field full"><span class="field-label">o que estava errado? (opcional)</span>
          <textarea class="textarea" name="note" maxlength="500" placeholder="ex: proteína estava 1515 g, no rótulo é 15 g"></textarea></label>` : ''}
      ${mode === 'new-mine' && !store.isAdmin() ? `
        <label class="full check-row">
          <input type="checkbox" name="share">
          <span>Sugerir também para o <b>catálogo da Nutri</b>, para outras pessoas usarem</span>
        </label>` : ''}
      <div class="full checks" aria-live="polite"></div>
    </form>`);
  sheet.setFooter(`<button class="btn soft" data-close>Cancelar</button>
    <button class="btn primary" data-act="save">${cfg.save}</button>`);

  const form = $('form', sheet.body);
  let unidade = base.unidade === 'ml' ? 'ml' : 'g';

  function read() {
    const data = { nome: form.nome.value.trim(), unidade, barcode: form.barcode.value.replace(/\D/g, '') || null };
    for (const n of NUTRIENTS) data[n.key] = parseNum(form[n.key].value) ?? 0;
    const porcao = parseNum(form.porcao_g.value);
    data.porcao_g = porcao || null;
    data.porcao_nome = porcao ? form.porcao_nome.value : null;
    return data;
  }

  function validate(show = false) {
    const data = read();
    const { errors, warnings } = checkProduct(data);
    if (!data.nome || data.nome.length < 2) errors.unshift({ field: 'nome', msg: 'Informe o nome do produto.' });
    if (data.barcode && !/^\d{6,14}$/.test(data.barcode)) errors.push({ field: 'barcode', msg: 'O código de barras tem de 8 a 14 números.' });
    if (Number.isNaN(data.porcao_g) || data.porcao_g < 0 || data.porcao_g > 2000) {
      errors.push({ field: 'porcao_g', msg: 'A porção precisa ter entre 1 e 2.000 g/ml.' });
    }
    $$('.input', form).forEach((i) => i.classList.toggle('invalid', show && errors.some((e) => e.field === i.name)));
    const box = $('.checks', form);
    box.innerHTML = [
      ...(show ? errors : errors.filter((e) => e.field !== 'nome')).map((e) => `<div class="notice warn">${icon('alert')}<div>${esc(e.msg)}</div></div>`),
      ...warnings.map((w) => `<div class="notice">${icon('info')}<div>${esc(w.msg)}</div></div>`),
    ].join('');
    return { data, errors };
  }

  form.addEventListener('input', () => validate(false));
  form.addEventListener('submit', (e) => e.preventDefault());
  sheet.el.addEventListener('click', async (e) => {
    const unitBtn = e.target.closest('[data-unit]');
    if (unitBtn) {
      unidade = unitBtn.dataset.unit;
      $$('[data-unit]', form).forEach((b) => b.setAttribute('aria-pressed', b === unitBtn));
      $('.portion-unit', form).textContent = unidade;
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'ocr') openLabelReader({ onResult: fillFromLabel });
    if (act === 'scan') {
      openScanner({
        onCode: (code) => {
          form.barcode.value = code;
          return true;
        },
      });
    }
    if (act === 'save') save(e.target.closest('button'));
  });

  /** Preenche com o que a câmera leu e destaca os campos para conferir. */
  function fillFromLabel(parsed) {
    $$('.input.filled', form).forEach((i) => i.classList.remove('filled'));
    for (const [k, v] of Object.entries(parsed.values)) {
      form[k].value = toInput(v);
      form[k].classList.add('filled');
    }
    if (parsed.unidade !== unidade) $(`[data-unit=${parsed.unidade}]`, form).click();
    if (parsed.porcao_g) {
      form.porcao_g.value = toInput(parsed.porcao_g);
      const nome = parsed.porcao_nome || 'porção';
      if (![...form.porcao_nome.options].some((o) => o.value === nome)) form.porcao_nome.add(new Option(nome, nome), 0);
      form.porcao_nome.value = nome;
      form.porcao_g.classList.add('filled');
    }
    const note = $('.read-note', sheet.body);
    note.hidden = false;
    note.innerHTML = `<div class="notice ok">${icon('check')}<div>${describeRead(parsed)}${parsed.warnings.map((w) => `<br>${esc(w)}`).join('')}</div></div>`;
    validate(false);
    if (!form.nome.value) form.nome.focus();
  }

  async function save(btn) {
    const { data, errors } = validate(true);
    if (errors.length) {
      $('.input.invalid', form)?.focus();
      return;
    }
    try {
      await busy(btn, async () => {
        let saved;
        if (mode === 'new-mine' || mode === 'edit-mine') {
          saved = await store.saveMyProduct(data, mode === 'edit-mine' ? product.id : undefined);
          if (form.share?.checked) await store.suggest({ kind: 'novo', product: saved });
          toast(form.share?.checked ? 'Produto salvo e sugerido para o catálogo.' : 'Produto salvo na sua despensa.');
        } else if (mode === 'new-catalog' || mode === 'edit-catalog') {
          saved = await store.saveCatalogProduct(data, mode === 'edit-catalog' ? product.id : undefined);
          toast('Catálogo da Nutri atualizado.');
        } else if (mode === 'approve') {
          saved = (await store.approveSuggestion(suggestionId, { product: data })).product;
          toast('Sugestão aprovada e catálogo atualizado.');
        } else {
          saved = await store.suggest({ kind: 'correcao', product: data, productId: product.id, note: form.note.value.trim() });
          toast('Sugestão enviada. Obrigado!');
        }
        sheet.close();
        onSaved?.(saved);
      });
    } catch (err) {
      toastError(err);
    }
  }

  validate(false);
  if (!base.nome) setTimeout(() => form.nome.focus(), 300);
  return sheet;
}
