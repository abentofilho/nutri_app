// Estado do app + todas as conversas com o backend.
// As telas leem `state` e chamam as ações daqui; depois de cada mudança,
// `changed()` avisa quem está inscrito para redesenhar.

import { api, getToken, setToken } from './api.js';
import { DEFAULT_GOALS, NUTRIENT_KEYS, nutrOf, sumItems } from './nutrition.js';
import { appUrl, normalize, storage } from './util.js';

const CACHE_KEY = 'nutri_cache_v2';
const LEGACY_KEY = 'nutri_user_id';          // id anônimo que a v1 guardava no navegador

const EMPTY = () => ({
  user: null,
  catalog: [],        // catálogo da Nutri, inclusive arquivados (receitas antigas apontam para eles)
  myProducts: [],
  houseRecipes: [],
  myRecipes: [],
  diary: [],
  suggestions: [],
  water: {},          // { 'AAAA-MM-DD': ml }
  loaded: false,      // true depois da primeira resposta do servidor nesta sessão
});

export const state = {
  ...EMPTY(),
  config: { google_client_id: null, history_days: 30 },
};

// ---------- inscrição / cache ----------

const subscribers = new Set();
let queued = false;

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function changed() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    saveCache();
    subscribers.forEach((fn) => fn());
  });
}

const CACHED = ['user', 'catalog', 'myProducts', 'houseRecipes', 'myRecipes', 'diary', 'suggestions', 'water', 'config'];

function saveCache() {
  if (!state.user) return;
  storage(CACHE_KEY, Object.fromEntries(CACHED.map((k) => [k, state[k]])));
}

/** Abre o app na hora com o que ficou salvo da última visita. */
export function restoreCache() {
  const cached = storage(CACHE_KEY);
  if (!getToken() || !cached?.user) return false;
  for (const k of CACHED) if (cached[k] !== undefined) state[k] = cached[k];
  return true;
}

export function clearSession() {
  setToken(null);
  storage(CACHE_KEY, null);
  Object.assign(state, EMPTY());
  changed();
}

// ---------- carregamento ----------

export async function loadConfig() {
  try {
    state.config = await api('/config');
  } catch {
    /* sem config, o app funciona sem o botão do Google */
  }
}

export async function refreshAll() {
  const [user, catalog, myProducts, houseRecipes, myRecipes, diary, suggestions, water] = await Promise.all([
    api('/me'),
    api('/products?archived=true'),
    api('/my/products'),
    api('/recipes/house'),
    api('/meals'),
    api('/diary'),
    api('/suggestions'),
    api('/water'),
  ]);
  Object.assign(state, { user, catalog, myProducts, houseRecipes, myRecipes, diary, suggestions, water, loaded: true });
  changed();
}

// ---------- conta ----------

async function authenticate(path, body) {
  const legacy = localStorage.getItem(LEGACY_KEY);
  const res = await api(path, { method: 'POST', body: { ...body, legacy_id: legacy || undefined } });
  if (res.pending) return res;      // login por código do GitHub: a pessoa ainda não confirmou
  setToken(res.token);
  state.user = res.user;
  state.loaded = false;
  await refreshAll();
  if (legacy) {
    // Guarda uma cópia por segurança, mas não manda de novo em outro login.
    localStorage.setItem(LEGACY_KEY + '_v1', legacy);
    localStorage.removeItem(LEGACY_KEY);
  }
  return { claimed: legacy ? state.myRecipes.filter((r) => !r.items[0]?.nutr).length : 0 };
}

export const login = (email, senha) => authenticate('/auth/login', { email, senha });
export const register = (nome, email, senha) => authenticate('/auth/register', { nome, email, senha, app_url: appUrl() });
export const enterAsGuest = (nome) => authenticate('/auth/guest', { nome });
export const loginWithGoogle = (credential) => authenticate('/auth/google', { credential });
// Com sessão aberta, o backend vincula o GitHub à conta atual em vez de trocar de conta.
export const loginWithGitHub = (code, redirectUri) => authenticate('/auth/github', { code, redirect_uri: redirectUri });
export const startGitHubDevice = () => api('/auth/github/device', { method: 'POST' });
export const pollGitHubDevice = (deviceCode) => authenticate('/auth/github/device/poll', { device_code: deviceCode });
export const redeemTransfer = (code) => authenticate('/auth/transfer', { code });

export async function logout() {
  try {
    await api('/auth/logout', { method: 'POST' });
  } catch {
    /* mesmo offline, a sessão local é encerrada */
  }
  clearSession();
}

export const isAdmin = () => !!state.user?.is_admin;

export async function updateProfile(patch) {
  state.user = await api('/me', { method: 'PATCH', body: patch });
  changed();
}

export async function setCredentials(email, senha) {
  state.user = await api('/me/credentials', { method: 'POST', body: { email, senha, app_url: appUrl() } });
  changed();
}

// ---------- e-mail e senha ----------

export const forgotPassword = (email) => api('/auth/forgot', { method: 'POST', body: { email, app_url: appUrl() } });
export const resetPassword = (token, senha) => authenticate('/auth/reset', { token, senha });
export const resendVerification = () => api('/me/verify-email', { method: 'POST', body: { app_url: appUrl() } });

export async function verifyEmail(token) {
  const res = await api('/auth/verify-email', { method: 'POST', body: { token } });
  if (state.user) {
    state.user = await api('/me');
    changed();
  }
  return res;
}

export async function changePassword(atual, nova) {
  await api('/me/password', { method: 'POST', body: { atual: atual || null, nova } });
  state.user = { ...state.user, has_password: true };
  changed();
}

export const revokeOtherSessions = () => api('/me/sessions/revoke-others', { method: 'POST' });

/** Falta confirmar o e-mail (e o servidor consegue mandar o link)? */
export const needsEmailCheck = () => !!(state.config.email_enabled && state.user?.email && !state.user.email_verified);

export const createTransferCode = () => api('/me/transfer-code', { method: 'POST' });

export async function deleteAccount() {
  await api('/me', { method: 'DELETE' });
  clearSession();
}

// ---------- preferências (metas, favoritos) ----------

export const prefs = () => state.user?.prefs || {};
export const goals = () => ({ ...DEFAULT_GOALS, ...(prefs().goals || {}) });

let prefsSeq = 0;
export async function savePrefs(patch) {
  const next = { ...prefs(), ...patch };
  state.user = { ...state.user, prefs: next };
  changed();
  const seq = ++prefsSeq;
  const user = await api('/me', { method: 'PATCH', body: { prefs: next } });
  if (seq === prefsSeq) {
    state.user = user;
    changed();
  }
}

export const isFavorite = (id) => (prefs().favorites || []).includes(id);

export function toggleFavorite(id) {
  const favs = new Set(prefs().favorites || []);
  if (favs.has(id)) favs.delete(id);
  else favs.add(id);
  return savePrefs({ favorites: [...favs] });
}

// ---------- produtos ----------

const byName = (a, b) => a.nome.localeCompare(b.nome, 'pt-BR');

function upsert(list, item) {
  const rest = list.filter((x) => x.id !== item.id);
  return [...rest, item].sort(byName);
}

/** Catálogo da Nutri (ativos) + produtos pessoais, cada um com sua origem. */
export function productList() {
  return [
    ...state.catalog.filter((p) => !p.archived).map((p) => ({ ...p, source: 'casa' })),
    ...state.myProducts.map((p) => ({ ...p, source: 'meu' })),
  ].sort(byName);
}

export function findProduct(id) {
  const casa = state.catalog.find((p) => p.id === id);
  if (casa) return { ...casa, source: 'casa' };
  const meu = state.myProducts.find((p) => p.id === id);
  return meu ? { ...meu, source: 'meu' } : null;
}

export function findByBarcode(code) {
  return productList().find((p) => p.barcode === code) || null;
}

/** Busca sem acento, por palavras, em qualquer ordem ("frango peito" acha "Peito de frango"). */
export function searchProducts(query, list = productList()) {
  const q = normalize(query);
  if (!q) return list;
  if (/^\d{6,}$/.test(q)) return list.filter((p) => p.barcode?.includes(q));
  const words = q.split(/\s+/);
  return list
    .map((p) => {
      const name = normalize(p.nome);
      if (!words.every((w) => name.includes(w))) return null;
      let score = 0;
      if (name.startsWith(q)) score += 4;
      if (name.split(/\s+/).some((t) => t.startsWith(words[0]))) score += 2;
      if (isFavorite(p.id)) score += 1;
      return { p, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || byName(a.p, b.p))
    .map((x) => x.p);
}

export function productPayload(p) {
  return {
    nome: p.nome,
    unidade: p.unidade,
    barcode: p.barcode || null,
    porcao_g: p.porcao_g || null,
    porcao_nome: p.porcao_g ? p.porcao_nome || null : null,
    ...nutrOf(p),
  };
}

export async function saveMyProduct(data, id) {
  const body = productPayload(data);
  const saved = id
    ? await api(`/my/products/${id}`, { method: 'PUT', body })
    : await api('/my/products', { method: 'POST', body });
  state.myProducts = upsert(state.myProducts, saved);
  changed();
  return { ...saved, source: 'meu' };
}

export async function deleteMyProduct(id) {
  await api(`/my/products/${id}`, { method: 'DELETE' });
  state.myProducts = state.myProducts.filter((p) => p.id !== id);
  changed();
}

export async function saveCatalogProduct(data, id) {
  const body = productPayload(data);
  const saved = id
    ? await api(`/products/${id}`, { method: 'PUT', body })
    : await api('/products', { method: 'POST', body });
  state.catalog = upsert(state.catalog, saved);
  changed();
  return { ...saved, source: 'casa' };
}

export async function setArchived(id, archived) {
  await api(`/products/${id}/archive?archived=${archived}`, { method: 'POST' });
  state.catalog = state.catalog.map((p) => (p.id === id ? { ...p, archived: archived ? 1 : 0 } : p));
  changed();
}

/** Exclusão definitiva (só para produtos que já estão na lixeira). */
export async function deleteCatalogProduct(id) {
  await api(`/products/${id}`, { method: 'DELETE' });
  state.catalog = state.catalog.filter((p) => p.id !== id);
  changed();
}

/** Produtos do catálogo com o mesmo nome ou o mesmo código de barras. */
export function duplicateGroups() {
  const groups = new Map();
  for (const p of state.catalog.filter((x) => !x.archived)) {
    for (const key of [`n:${normalize(p.nome).replace(/[^a-z0-9]/g, '')}`, p.barcode ? `b:${p.barcode}` : null]) {
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
  }
  const seen = new Set();
  return [...groups.values()].filter((g) => {
    if (g.length < 2) return false;
    const id = g.map((p) => p.id).sort().join();
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// ---------- itens (receitas e diário guardam uma cópia dos valores) ----------

/** Item de receita/diário. `porcoes` quando a pessoa registrou em unidades. */
export function itemFrom(product, qty, porcoes = null) {
  return {
    productId: product.id,
    nome: product.nome,
    unidade: product.unidade,
    qty,
    nutr: nutrOf(product),
    porcoes: porcoes || null,
    porcao_nome: porcoes ? product.porcao_nome || 'porção' : null,
  };
}

function cleanItem(it) {
  return {
    productId: String(it.productId || it.product_id || 'avulso').slice(0, 64),
    nome: it.nome,
    unidade: it.unidade,
    qty: Math.round(Number(it.qty) * 10) / 10,
    nutr: Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, Number(it.nutr?.[k]) || 0])),
    porcoes: it.porcoes ? Math.round(it.porcoes * 100) / 100 : null,
    porcao_nome: it.porcoes ? it.porcao_nome || 'porção' : null,
  };
}

// ---------- água ----------

export const waterFor = (day) => state.water[day] || 0;

let waterTimer = null;
/** Atualiza na hora e manda ao servidor depois de uma pausa (vários toques seguidos = 1 requisição). */
export function setWater(day, ml) {
  state.water = { ...state.water, [day]: Math.max(0, Math.min(10000, Math.round(ml))) };
  changed();
  clearTimeout(waterTimer);
  return new Promise((resolve, reject) => {
    waterTimer = setTimeout(() => {
      api(`/water/${day}`, { method: 'PUT', body: { ml: state.water[day] } }).then(resolve, reject);
    }, 600);
  });
}

// ---------- diário ----------

export const entriesFor = (day) => state.diary.filter((e) => e.day === day);

export function diaryByDay() {
  const map = new Map();
  for (const e of state.diary) {
    if (!map.has(e.day)) map.set(e.day, []);
    map.get(e.day).push(e);
  }
  return map;
}

export async function addToDiary(day, slot, items) {
  const created = await api('/diary', { method: 'POST', body: { day, slot, items: items.map(cleanItem) } });
  state.diary = [...state.diary, ...created];
  changed();
  return created;
}

export async function updateEntry(id, patch) {
  const saved = await api(`/diary/${id}`, { method: 'PATCH', body: patch });
  state.diary = state.diary.map((e) => (e.id === id ? saved : e));
  changed();
  return saved;
}

export async function deleteEntry(id) {
  const entry = state.diary.find((e) => e.id === id);
  state.diary = state.diary.filter((e) => e.id !== id);
  changed();
  try {
    await api(`/diary/${id}`, { method: 'DELETE' });
  } catch (err) {
    state.diary = [...state.diary, entry];
    changed();
    throw err;
  }
  return entry;
}

/** Copia os registros de um dia (ou de uma refeição dele) para outro dia. */
export async function copyDay(fromDay, toDay, onlySlot) {
  const bySlot = {};
  for (const e of entriesFor(fromDay)) {
    if (onlySlot && e.slot !== onlySlot) continue;
    (bySlot[e.slot] ||= []).push(e);
  }
  for (const [slot, items] of Object.entries(bySlot)) await addToDiary(toDay, slot, items);
  return Object.values(bySlot).flat().length;
}

/** Produtos usados por último, sem repetir. */
export function recentProducts(limit = 8) {
  const seen = new Set();
  const out = [];
  for (const e of [...state.diary].sort((a, b) => b.created_at - a.created_at)) {
    if (seen.has(e.product_id)) continue;
    seen.add(e.product_id);
    const p = findProduct(e.product_id);
    if (p && !p.archived) out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

/** Último registro de um produto (para sugerir a mesma quantidade). */
export function lastEntry(productId) {
  let best = null;
  for (const e of state.diary) {
    if (e.product_id === productId && (!best || e.created_at > best.created_at)) best = e;
  }
  return best;
}

// ---------- receitas ----------

/**
 * Receitas salvas pela v1 não guardavam os valores dos produtos, só o id.
 * Aqui eles são buscados no catálogo para a receita poder ir para o diário.
 */
export function recipeItems(recipe) {
  return recipe.items.map((it) => {
    if (it.nutr) return it;
    const p = findProduct(it.productId);
    return p ? { ...it, nutr: nutrOf(p) } : { ...it, nutr: null };
  });
}

export function recipeTotals(recipe) {
  const items = recipeItems(recipe);
  return items.every((it) => it.nutr) ? sumItems(items) : recipe.totals;
}

export async function saveRecipe({ nome, descricao, items }, { id, house } = {}) {
  const base = house ? '/recipes/house' : '/meals';
  const body = { nome, descricao: descricao || null, items: items.map(cleanItem) };
  const saved = id
    ? await api(`${base}/${id}`, { method: 'PUT', body })
    : await api(base, { method: 'POST', body });
  const key = house ? 'houseRecipes' : 'myRecipes';
  state[key] = id ? state[key].map((r) => (r.id === id ? saved : r)) : [saved, ...state[key]];
  changed();
  return saved;
}

export async function deleteRecipe(id, { house } = {}) {
  await api(house ? `/recipes/house/${id}` : `/meals/${id}`, { method: 'DELETE' });
  const key = house ? 'houseRecipes' : 'myRecipes';
  state[key] = state[key].filter((r) => r.id !== id);
  changed();
}

// ---------- sugestões ----------

export async function suggest({ kind, product, productId, note }) {
  const s = await api('/suggestions', {
    method: 'POST',
    body: { kind, product_id: productId || null, product: productPayload(product), note: note || null },
  });
  state.suggestions = [s, ...state.suggestions];
  changed();
  return s;
}

/** Sugestão minha ainda pendente para um produto (do catálogo ou pessoal). */
export function pendingSuggestionFor(product) {
  return state.suggestions.find((s) => s.status === 'pendente' && (
    product.source === 'casa'
      ? s.kind === 'correcao' && s.product_id === product.id
      : s.kind === 'novo' && normalize(s.product.nome) === normalize(product.nome)
  ));
}

export const loadPending = () => api('/suggestions?scope=pending');

export async function approveSuggestion(id, { product, note } = {}) {
  const res = await api(`/suggestions/${id}/approve`, {
    method: 'POST', body: { product: product ? productPayload(product) : null, note: note || null },
  });
  state.catalog = upsert(state.catalog, res.product);
  markSuggestion(id, 'aprovada', note);
  return res;
}

export async function rejectSuggestion(id, note) {
  await api(`/suggestions/${id}/reject`, { method: 'POST', body: { note: note || null } });
  markSuggestion(id, 'recusada', note);
}

/** O administrador também pode ter sugerido: mantém a lista dele em dia. */
function markSuggestion(id, status, note) {
  state.suggestions = state.suggestions.map((s) => (s.id === id ? { ...s, status, review_note: note || null } : s));
  changed();
}
