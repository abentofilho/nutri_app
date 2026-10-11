// Leitura da tabela nutricional pela câmera.
// O reconhecimento de texto (Tesseract, em português) roda no próprio
// aparelho: a foto não é enviada a nenhum servidor. O leitor (~5 MB) é
// baixado na primeira vez e fica guardado pelo navegador.

import { icon } from './icons.js';
import { NUTRIENT_MAX } from './nutrition.js';
import { openSheet, toastError } from './ui.js';
import { $, esc, loadScript, normalize } from './util.js';

const TESS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const TESS_SRI = 'sha384-GJqSu7vueQ9qN0E9yLPb3Wtpd7OrgK8KmYzC8T1IysG1bcvxvIO4qtYR/D3A991F';
const PATHS = {
  workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
  corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1',
  langPath: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/por@1.0.0/4.0.0_best_int',
};

// ---------- interpretação do texto ----------

// Ordem importa: "açúcares adicionados" antes de "açúcares", "saturadas" antes de "gorduras".
const ROWS = [
  ['acucad', /acucares?\s+adicionad/],
  ['acuc', /acucares?(\s+totais)?/],
  ['carb', /carboidrat/],
  ['prot', /prote[il]na/],
  ['gordsat', /saturad/],
  ['gordtrans', /\btrans\b/],
  ['gord', /gorduras?(\s+totais)?|gordura total|lipideos/],
  ['fibra', /fibras?/],
  ['sodio', /sodio/],
  ['calcio', /calcio/],
];

const NUMBER = /(\d+(?:[.,]\d+)?)/g;
const num = (s) => Number(s.replace(',', '.'));

// Trocas típicas do OCR perto das unidades: "TO mg" é 70 mg, "Og" é 0 g.
const LOOKALIKE = { o: '0', t: '7', l: '1', i: '1', s: '5', b: '8' };

/** Limpa uma linha já normalizada (minúscula, sem acento) antes de ler os números. */
function cleanLine(line, perPortion) {
  let l = line
    // unidades entre parênteses: "(g)" costuma sair "(9)", que viraria número
    .replace(/\(\s*(?:k?cal|kj|g|9|mg|m9|ml)\s*\)/g, ' ')
    // letra lida no lugar de número, logo antes da unidade
    .replace(/\b([0-9otlisb]{1,4})\s*(mg|g|kcal|ml)\b/g, (m, n, unit) => (
      /[a-z]/.test(n) ? `${n.replace(/[otlisb]/g, (c) => LOOKALIKE[c])} ${unit}` : m));
  // modelo antigo, com unidade colada ao número: "6,3g" sai "6,39"
  if (perPortion) l = l.replace(/(\d+[.,]\d)9(?=\s|$)/g, '$1 g');
  return l;
}

function numbersAfter(line, re) {
  const m = re.exec(line);
  const rest = m ? line.slice(m.index + m[0].length) : line;
  return (rest.match(NUMBER) || []).map(num);
}

function singular(nome) {
  return nome.trim()
    .replace(/^colheres/, 'colher').replace(/^fatias/, 'fatia').replace(/^unidades/, 'unidade')
    .replace(/^xicaras/, 'xícara').replace(/^copos/, 'copo').replace(/^biscoitos/, 'biscoito')
    .replace(/^potes/, 'pote').replace(/^pedacos/, 'pedaço').replace(/^xicara/, 'xícara')
    .replace(/s$/, '');
}

/**
 * O 100 g lido confere com a coluna da porção? Se o OCR perdeu a vírgula
 * ("11" no lugar de "1,1"), a coluna da porção mostra qual é o valor certo.
 */
function crossCheck(v, portionValue, portionGrams) {
  if (v == null || portionValue == null || !portionGrams) return v;
  // Do mais provável para o menos: as duas colunas certas; vírgula perdida no
  // 100 g; vírgula perdida na porção. Fica a primeira combinação que fecha.
  const tries = [[v, portionValue], [v / 10, portionValue], [v, portionValue / 10], [v / 100, portionValue]];
  for (const [a, b] of tries) {
    const expected = (b * 100) / portionGrams;
    if (Math.abs(a - expected) <= Math.max(0.6, expected * 0.3)) return Math.round(a * 10) / 10;
  }
  return v;   // sem acordo entre as colunas, fica o valor de 100 g como foi lido
}

/**
 * Lê o texto de uma tabela nutricional brasileira e devolve os valores por
 * 100 g/ml. Funciona com o modelo novo (colunas 100 g | porção | %VD) e com o
 * antigo (só a porção), convertendo pela porção quando preciso.
 */
export function parseLabel(raw) {
  const lines = raw.split(/\n+/).map((l) => normalize(l).replace(/\s+/g, ' ').trim()).filter(Boolean);
  const text = lines.join('\n');
  const values = {};
  const result = { values, unidade: /100\s*ml/.test(text) ? 'ml' : 'g', warnings: [] };
  const header = text.split(/valor energetico|energia/)[0] || '';
  const has100 = /100\s*(g|ml)/.test(header);

  // porção: "Porção: 30 g (2 fatias)" ou "Porção de 200 ml (1 copo)"
  const portion = text.match(/porc[ao]o?e?s?\s*(?:de|:)?\s*(\d+(?:[.,]\d+)?)\s*(g|ml)\b\s*(?:\(([^)]*)\))?/);
  let portionGrams = null;
  if (portion) {
    portionGrams = num(portion[1]);
    const desc = (portion[3] || '').match(/(\d+(?:[.,]\d+)?|meia|meio)\s+([a-z ]+)/);
    const count = desc ? (/mei[ao]/.test(desc[1]) ? 0.5 : num(desc[1])) : 0;
    if (count > 0) {
      result.porcao_g = Math.round((portionGrams / count) * 10) / 10;
      result.porcao_nome = singular(desc[2]).slice(0, 30);
    } else {
      result.porcao_g = portionGrams;
      result.porcao_nome = 'porção';
    }
  }

  for (const raw0 of lines) {
    const line = cleanLine(raw0, !has100);
    if (/valor energetico|energia/.test(line)) {
      const kcal = line.match(/(\d+(?:[.,]\d+)?)\s*k?cal/);
      const kj = line.match(/(\d+(?:[.,]\d+)?)\s*kj/);
      let v;
      if (kcal) v = num(kcal[1]);
      else if (kj) v = Math.round(num(kj[1]) / 4.184);
      else {
        const nums = numbersAfter(line, /valor energetico|energia/);
        v = has100 ? crossCheck(nums[0], nums[1], portionGrams) : nums[0];
      }
      if (v != null && values.kcal === undefined) values.kcal = v;
      continue;
    }
    for (const [key, re] of ROWS) {
      if (re.test(line)) {
        if (values[key] === undefined) {
          const nums = numbersAfter(line, re);
          if (nums.length) values[key] = has100 ? crossCheck(nums[0], nums[1], portionGrams) : nums[0];
        }
        break;
      }
    }
  }

  // Modelo antigo: só a coluna da porção. Converte para 100 g/ml.
  if (!has100) {
    if (portionGrams) {
      const f = 100 / portionGrams;
      for (const k of Object.keys(values)) values[k] = Math.round(values[k] * f * 10) / 10;
      result.warnings.push(`A tabela mostra só a porção de ${portionGrams} ${result.unidade}; os valores foram convertidos para 100 ${result.unidade}.`);
    } else {
      result.warnings.push('Não encontrei a coluna de 100 g nem a porção. Confira se os valores são por 100 g.');
    }
  }

  // Descarta leituras impossíveis (ex.: "%VD" lido como valor).
  for (const [k, v] of Object.entries(values)) {
    if (!(v >= 0 && v <= NUTRIENT_MAX[k])) delete values[k];
  }
  result.found = Object.keys(values).length;
  return result;
}

// ---------- imagem ----------

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => reject(new Error('Não foi possível abrir a foto.'));
    img.src = url;
  });
}

/** Tons de cinza, contraste esticado e tamanho bom para o OCR. */
function prepare(img) {
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  const scale = Math.min(3, 2600 / longest);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = data.data;
  let min = 255;
  let max = 0;
  for (let i = 0; i < px.length; i += 4) {
    const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    px[i] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }
  const range = Math.max(1, max - min);
  for (let i = 0; i < px.length; i += 4) {
    const v = ((px[i] - min) / range) * 255;
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  ctx.putImageData(data, 0, 0);
  return canvas;
}

/** Texto reconhecido de uma imagem já carregada (exportado para testes). */
export function recognizeImage(img, onProgress = () => {}) {
  return recognize(prepare(img), onProgress);
}

async function recognize(canvas, onProgress) {
  await loadScript(TESS, TESS_SRI);
  const worker = await window.Tesseract.createWorker('por', 1, {
    ...PATHS,
    logger: (m) => onProgress(m),
  });
  try {
    // PSM 6 lê linha a linha: mantém cada nutriente junto do seu valor.
    await worker.setParameters({ preserve_interword_spaces: '1', tessedit_pageseg_mode: '6' });
    const { data } = await worker.recognize(canvas);
    return data.text;
  } finally {
    worker.terminate();
  }
}

// ---------- tela ----------

/** Abre a câmera/galeria, lê a tabela e devolve o resultado em onResult. */
export function openLabelReader({ onResult }) {
  const sheet = openSheet({
    title: 'Ler tabela nutricional',
    subtitle: 'A leitura acontece no seu aparelho',
    className: 'label-sheet',
  });

  function start() {
    sheet.setBody(`
      <ul class="tips">
        <li>${icon('camera')}<span>Fotografe só a <b>tabela</b>, de frente e com o texto reto.</span></li>
        <li>${icon('sun')}<span>Boa luz e sem reflexo do plástico.</span></li>
        <li>${icon('check')}<span>Depois é só conferir os valores antes de salvar.</span></li>
      </ul>
      <input type="file" accept="image/*" capture="environment" data-file="camera" hidden>
      <input type="file" accept="image/*" data-file="gallery" hidden>`);
    sheet.setFooter(`
      <button class="btn soft" data-pick="gallery">${icon('image')}Galeria</button>
      <button class="btn primary" data-pick="camera">${icon('camera')}Tirar foto</button>`);
  }

  async function read(file) {
    let url;
    try {
      const loaded = await loadImage(file);
      url = loaded.url;
      sheet.setFooter('');
      sheet.setBody(`
        <img class="label-preview" src="${url}" alt="Foto da tabela">
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100"><span></span></div>
        <p class="progress-text muted">Preparando a foto…</p>`);
      const bar = $('.progress span', sheet.body);
      const status = $('.progress-text', sheet.body);
      const text = await recognizeImage(loaded.img, (m) => {
        if (sheet.closed) return;
        if (m.status === 'recognizing text') {
          status.textContent = `Lendo a tabela… ${Math.round(m.progress * 100)}%`;
          bar.style.width = `${30 + m.progress * 70}%`;
        } else if (/load|initializ/.test(m.status)) {
          status.textContent = 'Preparando o leitor (na primeira vez demora um pouco mais)…';
          bar.style.width = `${Math.round((m.progress || 0) * 30)}%`;
        }
      });
      if (sheet.closed) return;
      const parsed = parseLabel(text);
      if (parsed.found < 3) {
        sheet.setBody(`
          <img class="label-preview" src="${url}" alt="Foto da tabela">
          <div class="notice warn">${icon('alert')}<div><b>Não deu para ler a tabela.</b><br>
            Tente de novo mais perto, com a tabela reta e bem iluminada.</div></div>`);
        sheet.setFooter(`<button class="btn soft" data-close>Digitar à mão</button>
          <button class="btn primary" data-retry>${icon('camera')}Tentar de novo</button>`);
        return;
      }
      sheet.close();
      onResult(parsed);
    } catch (err) {
      toastError(err);
      start();
    } finally {
      if (url) setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  }

  sheet.el.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-pick]');
    if (pick) $(`[data-file=${pick.dataset.pick}]`, sheet.body).click();
    if (e.target.closest('[data-retry]')) start();
  });
  sheet.el.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) read(file);
  });
  start();
  return sheet;
}

export const describeRead = (parsed) =>
  `Lemos ${parsed.found} valores da foto${parsed.porcao_g ? ` e a porção (${esc(String(parsed.porcao_g))} ${parsed.unidade})` : ''}. Confira com o rótulo antes de salvar.`;
