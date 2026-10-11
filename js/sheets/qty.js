// Campo de quantidade usado ao registrar e ao editar um alimento.
// Se o produto tem porção cadastrada ("1 unidade = 46 g"), a pessoa pode
// informar em porções ("2 unidades") em vez de gramas. O diário guarda sempre
// o peso em g/ml e, junto, quantas porções foram informadas.

import { icon } from '../icons.js';
import { $, $$, esc, fmt, parseNum, portionLabel, toInput } from '../util.js';

const GRAM_CHIPS = { g: [30, 50, 100, 150, 200], ml: [100, 200, 250, 300, 500] };
const PORTION_CHIPS = [0.5, 1, 2, 3];

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * opts: { unidade, porcaoG, porcaoNome, qty, porcoes, last, onChange, onSubmit }
 * Devolve { value() } com { qty, porcoes } (porcoes = null quando em g/ml).
 */
export function mountQtyField(container, opts) {
  const { unidade, porcaoG, porcaoNome = 'porção', last, onChange, onSubmit } = opts;
  const hasPortion = porcaoG > 0;
  let mode = hasPortion && (opts.porcoes || !opts.qty) ? 'porcao' : 'g';
  let grams = opts.qty || (hasPortion ? porcaoG : unidade === 'ml' ? 200 : 100);
  let count = opts.porcoes || (hasPortion ? Math.max(0.5, Math.round((grams / porcaoG) * 2) / 2) : 1);

  container.innerHTML = `
    ${hasPortion ? `
      <div class="unit-toggle mode-toggle" role="group" aria-label="Informar em">
        <button type="button" class="chip" data-mode="porcao">${esc(capitalize(portionLabel(2, porcaoNome).replace(/^2 /, '')))}</button>
        <button type="button" class="chip" data-mode="g">${unidade === 'ml' ? 'Mililitros' : 'Gramas'}</button>
      </div>` : ''}
    <div class="qty-box">
      <button type="button" class="icon-btn" data-step="-1" aria-label="Diminuir">${icon('minus')}</button>
      <input class="input" inputmode="decimal" aria-label="Quantidade">
      <span class="unit"></span>
      <button type="button" class="icon-btn" data-step="1" aria-label="Aumentar">${icon('plus')}</button>
    </div>
    <p class="qty-hint"></p>
    <div class="qty-chips"></div>`;

  const input = $('input', container);

  const value = () => (mode === 'porcao'
    ? { qty: Math.round(count * porcaoG * 10) / 10, porcoes: count }
    : { qty: grams, porcoes: null });

  function paintMode() {
    $$('[data-mode]', container).forEach((b) => b.setAttribute('aria-pressed', b.dataset.mode === mode));
    input.value = toInput(mode === 'porcao' ? count : grams);
    $('.unit', container).textContent = mode === 'porcao' ? '×' : unidade;
    $('.qty-chips', container).innerHTML = mode === 'porcao'
      ? PORTION_CHIPS.map((n) => `<button type="button" class="chip" data-set="${n}">${esc(portionLabel(n, porcaoNome))}</button>`).join('')
      : [
        last ? `<button type="button" class="chip" data-set="${last}">${icon('clock')}${fmt(last)} ${unidade}</button>` : '',
        ...GRAM_CHIPS[unidade].filter((q) => q !== last).map((q) => `<button type="button" class="chip" data-set="${q}">${q} ${unidade}</button>`),
      ].join('');
    paintHint();
  }

  function paintHint() {
    const v = value();
    $('.qty-hint', container).textContent = mode === 'porcao'
      ? `${portionLabel(count || 0, porcaoNome)} = ${fmt(v.qty)} ${unidade}`
      : hasPortion ? `1 ${porcaoNome} = ${fmt(porcaoG)} ${unidade}` : '';
    onChange?.(v);
  }

  function set(n) {
    if (mode === 'porcao') count = n;
    else grams = n;
    input.value = toInput(n);
    paintHint();
  }

  input.addEventListener('input', () => {
    const v = parseNum(input.value);
    const n = Number.isFinite(v) ? v : 0;
    if (mode === 'porcao') count = n;
    else grams = n;
    paintHint();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onSubmit?.();
  });
  container.addEventListener('click', (e) => {
    const m = e.target.closest('[data-mode]');
    if (m && m.dataset.mode !== mode) {
      // troca mantendo o mesmo peso
      if (m.dataset.mode === 'g') grams = value().qty;
      else count = Math.max(0.5, Math.round((grams / porcaoG) * 2) / 2);
      mode = m.dataset.mode;
      paintMode();
      return;
    }
    const step = e.target.closest('[data-step]');
    if (step) {
      const dir = Number(step.dataset.step);
      if (mode === 'porcao') set(Math.max(0.5, (count || 0) + dir * (count < 1 || (count === 1 && dir < 0) ? 0.5 : 1)));
      else {
        const inc = unidade === 'ml' ? 50 : (grams >= 100 ? 25 : 10);
        set(Math.max(0, Math.round(((grams || 0) + dir * inc) / 5) * 5));
      }
      return;
    }
    const chip = e.target.closest('[data-set]');
    if (chip) set(Number(chip.dataset.set));
  });

  paintMode();
  if (window.matchMedia('(pointer: fine)').matches) setTimeout(() => input.select(), 250);
  return { value };
}
