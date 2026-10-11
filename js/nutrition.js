// Nutrientes do rótulo brasileiro: a mesma lista da v1 e do backend.
export const NUTRIENTS = [
  { key: 'kcal', label: 'Valor energético', unit: 'kcal' },
  { key: 'carb', label: 'Carboidratos', unit: 'g' },
  { key: 'acuc', label: 'Açúcares totais', unit: 'g', sub: true },
  { key: 'acucad', label: 'Açúcares adicionados', unit: 'g', sub: true },
  { key: 'prot', label: 'Proteínas', unit: 'g' },
  { key: 'gord', label: 'Gorduras totais', unit: 'g' },
  { key: 'gordsat', label: 'Gorduras saturadas', unit: 'g', sub: true },
  { key: 'gordtrans', label: 'Gorduras trans', unit: 'g', sub: true },
  { key: 'fibra', label: 'Fibras alimentares', unit: 'g' },
  { key: 'sodio', label: 'Sódio', unit: 'mg' },
  { key: 'calcio', label: 'Cálcio', unit: 'mg' },
];
export const NUTRIENT_KEYS = NUTRIENTS.map((n) => n.key);
export const nutrientLabel = (key) => NUTRIENTS.find((n) => n.key === key)?.label || key;

// Valores diários de referência da ANVISA (IN 75/2020), base do %VD dos rótulos.
export const VD = {
  kcal: 2000, carb: 300, acucad: 50, prot: 50, gord: 65, gordsat: 20, fibra: 25, sodio: 2000, calcio: 1000,
};

// Mesmos limites do backend (por 100 g/ml).
export const NUTRIENT_MAX = {
  kcal: 950, carb: 100, acuc: 100, acucad: 100, prot: 100, gord: 100, gordsat: 100, gordtrans: 100,
  fibra: 100, sodio: 40000, calcio: 5000,
};

export const MACROS = [
  { key: 'carb', label: 'Carboidratos', short: 'Carb', hex: '#e2a23a', kcalPerG: 4 },
  { key: 'prot', label: 'Proteínas', short: 'Prot', hex: '#d0603f', kcalPerG: 4 },
  { key: 'gord', label: 'Gorduras', short: 'Gord', hex: '#3f8a8c', kcalPerG: 9 },
];

export const DEFAULT_GOALS = { kcal: 2000, carb: 250, prot: 100, gord: 65, agua: 2000 };

export const SLOTS = [
  { key: 'cafe', label: 'Café da manhã', short: 'Café', to: 'ao café da manhã' },
  { key: 'almoco', label: 'Almoço', short: 'Almoço', to: 'ao almoço' },
  { key: 'lanche', label: 'Lanches', short: 'Lanches', to: 'aos lanches' },
  { key: 'jantar', label: 'Jantar', short: 'Jantar', to: 'ao jantar' },
];
export const slotLabel = (key) => SLOTS.find((s) => s.key === key)?.label || key;
/** "ao almoço", "aos lanches"… */
export const slotTo = (key) => SLOTS.find((s) => s.key === key)?.to || key;

/** Refeição mais provável pelo horário de agora. */
export function slotForNow(date = new Date()) {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h >= 4.5 && h < 10.5) return 'cafe';
  if (h >= 10.5 && h < 15) return 'almoco';
  if (h >= 18 && h < 23) return 'jantar';
  return 'lanche';
}

export function emptyTotals() {
  return Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, 0]));
}

/** Os 11 valores por 100 g/ml de um produto. */
export function nutrOf(product) {
  return Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, Number(product?.[k]) || 0]));
}

/** Soma itens no formato { qty, nutr } (receitas e diário). */
export function sumItems(items) {
  const t = emptyTotals();
  for (const it of items) {
    if (!it.nutr) continue;
    const f = (Number(it.qty) || 0) / 100;
    for (const k of NUTRIENT_KEYS) t[k] += (it.nutr[k] || 0) * f;
  }
  return t;
}

export function scale(nutr, qty) {
  return sumItems([{ qty, nutr }]);
}

/** Energia esperada pelos macros (fatores de Atwater). */
export function kcalFromMacros(p) {
  return 4 * (p.carb || 0) + 4 * (p.prot || 0) + 9 * (p.gord || 0);
}

/** % das calorias vindas de cada macro (para as barrinhas coloridas). */
export function macroSplit(t) {
  const parts = MACROS.map((m) => (t[m.key] || 0) * m.kcalPerG);
  const total = parts.reduce((a, b) => a + b, 0);
  return MACROS.map((m, i) => ({ ...m, pct: total ? (parts[i] / total) * 100 : 0 }));
}

/**
 * Confere um produto (valores por 100 g/ml).
 * errors impedem salvar (mesmas regras do servidor); warnings só avisam.
 */
export function checkProduct(p) {
  const errors = [];
  const warnings = [];
  for (const n of NUTRIENTS) {
    const v = p[n.key];
    if (v === null || v === undefined) continue;
    if (Number.isNaN(v)) errors.push({ field: n.key, msg: `${n.label}: número inválido.` });
    else if (v < 0) errors.push({ field: n.key, msg: `${n.label} não pode ser negativo.` });
    else if (v > NUTRIENT_MAX[n.key]) {
      errors.push({ field: n.key, msg: `${n.label}: ${v} ${n.unit} em 100 ${p.unidade || 'g'} não é possível (máx. ${NUTRIENT_MAX[n.key]}).` });
    }
  }
  if (errors.length) return { errors, warnings };

  const v = (k) => Number(p[k]) || 0;
  if (v('acuc') > v('carb') + 0.05) warnings.push({ field: 'acuc', msg: 'Açúcares totais maiores que os carboidratos.' });
  if (v('acucad') > v('acuc') + 0.05) warnings.push({ field: 'acucad', msg: 'Açúcares adicionados maiores que os açúcares totais.' });
  if (v('gordsat') + v('gordtrans') > v('gord') + 0.05) warnings.push({ field: 'gordsat', msg: 'Gorduras saturadas + trans maiores que as gorduras totais.' });
  if (v('carb') + v('prot') + v('gord') + v('fibra') > 105) warnings.push({ field: 'carb', msg: 'Carboidratos, proteínas, gorduras e fibras somam mais de 100 g.' });

  const expected = kcalFromMacros(p);
  const kcal = v('kcal');
  if (kcal || expected) {
    const diff = Math.abs(kcal - expected);
    if (diff > 40 && diff / Math.max(kcal, expected) > 0.25) {
      warnings.push({
        field: 'kcal',
        msg: `As calorias (${Math.round(kcal)} kcal) não batem com os macros (≈ ${Math.round(expected)} kcal). Confira o rótulo.`,
      });
    }
  }
  return { errors, warnings };
}
