// Leitor de código de barras.
// 1) procura o código na despensa (catálogo + produtos pessoais);
// 2) se não achar, busca no Open Food Facts (base aberta e colaborativa,
//    com boa cobertura de produtos brasileiros) e abre o cadastro já preenchido.

import * as store from './store.js';
import { openSheet, toastError } from './ui.js';
import { $, esc, loadScript } from './util.js';
import { openProductForm } from './sheets/product.js';

const SCANNER_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js';
const SCANNER_SRI = 'sha384-c9d8RFSL+u3exBOJ4Yp3HUJXS4znl9f+z66d1y54ig+ea249SpqR+w1wyvXz/lk+';
const OFF_URL = 'https://world.openfoodfacts.org/api/v2/product/';

/**
 * onCode(code)   -> se devolver true, o scanner só entrega o número (formulário)
 * onProduct(p)   -> produto encontrado ou recém-cadastrado
 */
export function openScanner({ onCode, onProduct } = {}) {
  let reader = null;
  let done = false;

  const sheet = openSheet({
    title: 'Ler código de barras',
    subtitle: 'Aponte a câmera para o código do rótulo',
    className: 'scanner-sheet',
    onClose: stop,
  });
  sheet.setBody(`
    <div class="scanner-view">
      <div id="scanner-region"></div>
      <div class="scanner-frame"></div>
      <div class="scanner-status">Abrindo a câmera…</div>
    </div>
    <form class="toolbar-row" style="margin-top:14px" data-manual>
      <label class="field" style="flex:1">
        <span class="field-label">ou digite os números do código</span>
        <input class="input num" inputmode="numeric" maxlength="14" placeholder="7891234567890">
      </label>
      <button class="btn primary" style="align-self:flex-end">Buscar</button>
    </form>
    <p class="faint" style="font-size:12px;margin:12px 0 0">Produtos que não estão na despensa são buscados no
      <a href="https://br.openfoodfacts.org" target="_blank" rel="noopener">Open Food Facts</a>, uma base aberta de rótulos.</p>`);

  const status = (msg) => {
    const el = $('.scanner-status', sheet.body);
    if (el) el.textContent = msg;
  };

  $('[data-manual]', sheet.body).addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('[data-manual] input', sheet.body).value.replace(/\D/g, '');
    if (code.length >= 6) handle(code);
  });

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      status('Este navegador não dá acesso à câmera. Digite o código abaixo.');
      return;
    }
    try {
      await loadScript(SCANNER_LIB, SCANNER_SRI);
      if (sheet.closed) return;
      const { Html5Qrcode, Html5QrcodeSupportedFormats: F } = window;
      reader = new Html5Qrcode('scanner-region', {
        formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128],
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
        verbose: false,
      });
      await reader.start(
        { facingMode: 'environment' },
        { fps: 12, qrbox: (w, h) => ({ width: Math.floor(w * 0.76), height: Math.floor(h * 0.4) }), aspectRatio: 4 / 3 },
        (text) => handle(text.replace(/\D/g, '')),
        () => {},
      );
      if (sheet.closed) stop();
      else status('Procurando um código…');
    } catch (err) {
      const denied = /permission|notallowed/i.test(String(err?.name || err));
      status(denied
        ? 'Sem permissão para usar a câmera. Libere nas configurações do navegador ou digite o código.'
        : 'Não foi possível abrir a câmera. Digite o código abaixo.');
    }
  }

  function stop() {
    const r = reader;
    reader = null;
    if (r?.isScanning) r.stop().catch(() => {});
  }

  async function handle(code) {
    if (done || !code) return;
    done = true;
    navigator.vibrate?.(60);
    stop();
    if (onCode?.(code)) {
      sheet.close();
      return;
    }
    const local = store.findByBarcode(code);
    if (local) {
      sheet.close();
      onProduct?.(local);
      return;
    }
    status(`Código ${code}: buscando o produto…`);
    sheet.setTitle('Buscando produto…', `Código ${code}`);
    try {
      const found = await lookupOpenFoodFacts(code);
      sheet.close();
      openProductForm({
        mode: 'new-mine',
        prefill: found ? found.product : { barcode: code },
        source: found
          ? `Encontramos <b>${esc(found.product.nome)}</b> no Open Food Facts. Confira os valores com o rótulo antes de salvar.`
          : `O código <span class="num">${code}</span> não está em nenhuma base. Cadastre com os dados do rótulo.`,
        onSaved: onProduct,
      });
    } catch (err) {
      toastError(err);
      done = false;
    }
  }

  start();
  return sheet;
}

// ---------- Open Food Facts ----------

const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

/** Converte a resposta do Open Food Facts para os campos do app (por 100 g/ml). */
export function fromOpenFoodFacts(code, p) {
  const n = p.nutriments || {};
  const get = (key) => {
    const v = n[`${key}_100g`];
    return typeof v === 'number' && v >= 0 ? v : 0;
  };
  let kcal = get('energy-kcal');
  if (!kcal && get('energy')) kcal = get('energy') / 4.184;      // só veio em kJ
  const liquid = /\b(ml|l|litros?)\b/i.test(p.quantity || '') || /ml/i.test(p.serving_size || '');
  const nome = [p.product_name_pt || p.product_name, p.brands?.split(',')[0]]
    .filter(Boolean).map((s) => s.trim()).filter((s, i, a) => a.indexOf(s) === i).join(' ');
  return {
    nome: nome.slice(0, 120),
    unidade: liquid ? 'ml' : 'g',
    barcode: code,
    kcal: round(kcal, 0),
    carb: round(get('carbohydrates')),
    acuc: round(get('sugars')),
    acucad: round(get('added-sugars')),
    prot: round(get('proteins')),
    gord: round(get('fat')),
    gordsat: round(get('saturated-fat')),
    gordtrans: round(get('trans-fat')),
    fibra: round(get('fiber')),
    sodio: round(get('sodium') * 1000, 0),    // g -> mg
    calcio: round(get('calcium') * 1000, 0),  // g -> mg
  };
}

async function lookupOpenFoodFacts(code) {
  const fields = 'product_name,product_name_pt,brands,quantity,serving_size,nutriments';
  let res;
  try {
    res = await fetch(`${OFF_URL}${code}.json?fields=${fields}`);
  } catch {
    throw new Error('Sem conexão para buscar o código. Tente de novo ou cadastre manualmente.');
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('O Open Food Facts não respondeu agora. Tente de novo em instantes.');
  const data = await res.json();
  if (data.status === 0 || !data.product) return null;
  const product = fromOpenFoodFacts(code, data.product);
  if (!product.nome) product.nome = '';
  return { product };
}
