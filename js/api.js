import { API_BASE } from './config.js';
import { nutrientLabel } from './nutrition.js';
import { storage } from './util.js';

const TOKEN_KEY = 'nutri_token';
let token = storage(TOKEN_KEY);

export const getToken = () => token;
export function setToken(t) {
  token = t || null;
  storage(TOKEN_KEY, token);
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// O servidor gratuito do Render "dorme" depois de um tempo parado e leva até
// um minuto para acordar. Quando uma requisição demora, a tela avisa.
let slowCount = 0;
let onSlow = () => {};
export function onSlowChange(fn) {
  onSlow = fn;
}

const FIELD_ERRORS = {
  less_than_equal: (e) => `valor acima do possível (máx. ${e.ctx?.le})`,
  greater_than_equal: () => 'não pode ser negativo',
  greater_than: () => 'precisa ser maior que zero',
  string_too_short: (e) => (e.ctx?.min_length > 1 ? `mínimo de ${e.ctx.min_length} caracteres` : 'obrigatório'),
  string_too_long: () => 'texto longo demais',
  string_pattern_mismatch: () => 'formato inválido',
  missing: () => 'obrigatório',
};
const FIELD_NAMES = { senha: 'Senha', nova: 'Nova senha', atual: 'Senha atual', nome: 'Nome', email: 'E-mail', qty: 'Quantidade', barcode: 'Código de barras', unidade: 'Unidade' };

/** Transforma o erro 422 do FastAPI em uma frase legível. */
function describeValidation(detail) {
  const e = detail[0] || {};
  const field = [...(e.loc || [])].reverse().find((p) => typeof p === 'string' && p !== 'body') || '';
  const name = FIELD_NAMES[field] || nutrientLabel(field);
  const text = FIELD_ERRORS[e.type]?.(e) || e.msg?.replace(/^Value error, /, '') || 'valor inválido';
  return name ? `${name}: ${text}.` : text;
}

export async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;

  let slow = false;
  const timer = setTimeout(() => {
    slow = true;
    if (++slowCount === 1) onSlow(true);
  }, 2500);

  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Sem conexão com o servidor. Verifique sua internet e tente de novo.', 0);
  } finally {
    clearTimeout(timer);
    if (slow && --slowCount === 0) onSlow(false);
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    let msg = data?.detail;
    if (Array.isArray(msg)) msg = describeValidation(msg);
    throw new ApiError(msg || `Erro ${res.status} no servidor.`, res.status);
  }
  return data;
}
