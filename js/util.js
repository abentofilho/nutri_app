// ---------- DOM ----------

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[m]));
}

// ---------- números (sempre no formato brasileiro: 12,5) ----------

const nf = [0, 1, 2].map((d) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: d }));

export function fmt(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(n)) return '0';
  return nf[digits].format(n);
}

/** Aceita "12,5", "12.5" e " 12 ". Vazio vira null, lixo vira NaN. */
export function parseNum(value) {
  if (typeof value === 'number') return value;
  const s = String(value ?? '').trim().replace(/\s/g, '').replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/** Formato para preencher um input: 12.5 -> "12,5", 0 -> "". */
export function toInput(n) {
  return n ? String(Math.round(n * 100) / 100).replace('.', ',') : '';
}

// ---------- texto ----------

export function normalize(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

export function plural(n, one, many) {
  return `${fmt(n, 0)} ${n === 1 ? one : many}`;
}

export function initials(nome) {
  return (String(nome || '?').trim()[0] || '?').toUpperCase();
}

// ---------- datas (sempre no fuso de quem está usando) ----------

export function isoDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function parseDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(day, n) {
  const d = parseDay(day);
  d.setDate(d.getDate() + n);
  return isoDay(d);
}

const weekdayFmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'long' });
const shortFmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: 'numeric', month: 'short' });
const longFmt = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long' });

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const clean = (s) => s.replace(/\./g, '').replace(/,/g, '');

export function relativeDay(day) {
  const today = isoDay();
  if (day === today) return 'Hoje';
  if (day === addDays(today, -1)) return 'Ontem';
  return cap(weekdayFmt.format(parseDay(day)));
}

/** "8 de outubro" */
export function longDate(day) {
  return longFmt.format(parseDay(day));
}

/** "qua 8 out" */
export function shortDate(day) {
  return clean(shortFmt.format(parseDay(day))).replace(' de ', ' ');
}

/** Endereço desta página sem ?query nem #rota (para links de e-mail e login externo). */
export const appUrl = () => location.origin + location.pathname;

// ---------- outros ----------

export function debounce(fn, ms = 150) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function storage(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(key));
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    return null;
  }
  return value;
}

const scripts = {};
/**
 * Carrega um script externo uma única vez (scanner, QR code, Google).
 * Com `integrity`, o navegador recusa o arquivo se ele tiver sido alterado.
 */
export function loadScript(src, integrity) {
  scripts[src] ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    if (integrity) {
      s.integrity = integrity;
      s.crossOrigin = 'anonymous';
    }
    s.onload = resolve;
    s.onerror = () => {
      delete scripts[src];
      reject(new Error('Não foi possível carregar ' + src));
    };
    document.head.appendChild(s);
  });
  return scripts[src];
}

// ---------- porções ----------

const IRREGULAR = { 'colher de sopa': 'colheres de sopa', 'colher de chá': 'colheres de chá', 'pão': 'pães' };

function pluralWord(word) {
  if (IRREGULAR[word]) return IRREGULAR[word];
  if (word.endsWith('ão')) return word.slice(0, -2) + 'ões';
  if (/[rsz]$/.test(word)) return word + 'es';
  if (word.endsWith('l')) return word.slice(0, -1) + 'is';
  return word + 's';
}

/** "1 fatia", "2 fatias", "1,5 colher de sopa", "3 colheres de sopa". */
export function portionLabel(n, nome = 'porção') {
  const base = nome || 'porção';
  const plural = n > 1 && Number.isInteger(n) ? (IRREGULAR[base] || base.replace(/^(\S+)/, (w) => pluralWord(w))) : base;
  return `${fmt(n, 2)} ${plural}`;
}
