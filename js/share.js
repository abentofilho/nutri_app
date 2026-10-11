// Compartilhar e exportar: imagem no formato de story (1080x1920),
// planilha CSV e relatório para imprimir/salvar em PDF.

import { APP_NAME, APP_URL } from './config.js';
import { SLOT_ICONS, foodSrc } from './foods.js';
import { isIOS } from './pwa.js';
import { icon, LOGO } from './icons.js';
import { MACROS, NUTRIENTS, SLOTS, sumItems } from './nutrition.js';
import * as store from './store.js';
import { openSheet, toast, toastError } from './ui.js';
import { $, addDays, esc, fmt, isoDay, longDate, relativeDay, shortDate } from './util.js';

const W = 1080;
const H = 1920;
const C = {
  bg: '#f3ece0', paper: '#fffbf4', ink: '#2b241c', ink2: '#5e5446', ink3: '#8e8373',
  line: '#e6dac6', track: '#eae0cf', sage: '#3f7552', prot: '#d0603f', caramel: '#b8733a',
};

// ---------- canvas helpers ----------

async function ensureFonts() {
  await Promise.all([
    document.fonts.load('700 80px Fraunces'),
    document.fonts.load('600 40px Fraunces'),
    document.fonts.load('600 36px Inter'),
    document.fonts.load('400 30px Inter'),
    document.fonts.load('500 28px "IBM Plex Mono"'),
  ]).catch(() => {});
}

function loadLogo() {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(LOGO.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '));
  });
}

function roundRect(ctx, x, y, w, h, radius) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function card(ctx, x, y, w, h) {
  ctx.save();
  ctx.shadowColor = 'rgba(70, 48, 18, 0.16)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 14;
  ctx.fillStyle = C.paper;
  roundRect(ctx, x, y, w, h, 48);
  ctx.fill();
  ctx.restore();
}

function text(ctx, str, x, y, { font, color = C.ink, align = 'left', maxWidth } = {}) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  let s = String(str);
  if (maxWidth) {
    while (s.length > 1 && ctx.measureText(s).width > maxWidth) s = s.slice(0, -2) + '…';
    if (s !== String(str) && !s.endsWith('…')) s += '…';
  }
  ctx.fillText(s, x, y);
}

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function blob(ctx, x, y, r, color) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, 'rgba(243,236,224,0)');
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

async function baseCanvas() {
  await ensureFonts();
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  blob(ctx, 980, 140, 520, 'rgba(226,162,58,0.30)');
  blob(ctx, 60, 760, 480, 'rgba(63,117,82,0.16)');
  blob(ctx, 960, 1780, 520, 'rgba(208,96,63,0.16)');

  const logo = await loadLogo();
  if (logo) ctx.drawImage(logo, 90, 104, 92, 92);
  ctx.font = '700 52px Fraunces';
  const nutriW = ctx.measureText('Nutri').width;
  text(ctx, 'Nutri', 204, 168, { font: '700 52px Fraunces' });
  text(ctx, 'App', 204 + nutriW, 168, { font: '700 52px Fraunces', color: C.caramel });

  text(ctx, APP_URL, W / 2, H - 92, {
    font: '500 24px "IBM Plex Mono"', color: C.ink3, align: 'center',
  });
  return { canvas, ctx };
}

function macroColumns(ctx, totals, goals, y) {
  const colW = (W - 180 - 60 - 60) / 3;   // 3 colunas dentro do cartão, com respiro nas bordas
  MACROS.forEach((m, i) => {
    const x = 90 + 30 + i * (colW + 30);
    ctx.fillStyle = m.hex;
    ctx.beginPath();
    ctx.arc(x + 12, y - 12, 12, 0, Math.PI * 2);
    ctx.fill();
    text(ctx, m.label, x + 34, y, { font: '600 28px Inter', color: C.ink2 });
    text(ctx, `${fmt(totals[m.key] || 0, 0)} g`, x, y + 74, { font: '700 60px Fraunces' });
    const g = goals[m.key] || 1;
    ctx.fillStyle = C.track;
    roundRect(ctx, x, y + 104, colW - 20, 16, 8);
    ctx.fill();
    ctx.fillStyle = m.hex;
    roundRect(ctx, x, y + 104, Math.max(16, (colW - 20) * Math.min((totals[m.key] || 0) / g, 1)), 16, 8);
    ctx.fill();
    text(ctx, `meta ${fmt(g, 0)} g`, x, y + 160, { font: '500 24px "IBM Plex Mono"', color: C.ink3 });
  });
}

// ---------- story do dia ----------

export async function renderDayStory(day) {
  const { canvas, ctx } = await baseCanvas();
  const entries = store.entriesFor(day);
  const totals = sumItems(entries);
  const goals = store.goals();
  const nome = store.state.user?.nome?.split(' ')[0] || '';

  text(ctx, relativeDay(day) === 'Hoje' || relativeDay(day) === 'Ontem'
    ? `${relativeDay(day)}, ${longDate(day)}` : longDate(day), 90, 330, { font: '600 36px Inter', color: C.ink2 });
  text(ctx, nome ? `O dia de ${nome}` : 'Meu dia', 90, 420, { font: '700 84px Fraunces', maxWidth: W - 180 });

  // anel de calorias
  card(ctx, 90, 490, W - 180, 800);
  const cx = W / 2;
  const cy = 760;
  const r = 200;
  ctx.lineCap = 'round';
  ctx.lineWidth = 46;
  ctx.strokeStyle = C.track;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  const pct = Math.min(totals.kcal / (goals.kcal || 1), 1);
  ctx.strokeStyle = totals.kcal > goals.kcal * 1.02 ? C.prot : C.sage;
  if (pct > 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pct);
    ctx.stroke();
  }
  text(ctx, fmt(totals.kcal, 0), cx, cy + 30, { font: '700 112px Fraunces', align: 'center' });
  text(ctx, `de ${fmt(goals.kcal, 0)} kcal`, cx, cy + 86, { font: '400 32px Inter', color: C.ink2, align: 'center' });
  macroColumns(ctx, totals, goals, 1070);

  // refeições
  const slots = SLOTS.map((s) => ({ ...s, items: entries.filter((e) => e.slot === s.key) })).filter((s) => s.items.length);
  const icons = await Promise.all(slots.map((s) => loadImage(foodSrc(SLOT_ICONS[s.key]))));
  const rowH = 112;
  const listTop = 1340;
  const listH = Math.max(1, slots.length) * rowH + 60;
  card(ctx, 90, listTop, W - 180, listH);
  if (!slots.length) {
    text(ctx, 'Nenhuma refeição registrada.', cx, listTop + 100, { font: '400 32px Inter', color: C.ink3, align: 'center' });
  }
  slots.forEach((s, i) => {
    const y = listTop + 30 + i * rowH;
    const t = sumItems(s.items);
    if (icons[i]) ctx.drawImage(icons[i], 132, y + 20, 68, 68);
    text(ctx, s.label, 222, y + 52, { font: '600 36px Fraunces' });
    text(ctx, s.items.map((e) => e.nome).join(', '), 222, y + 92, { font: '400 26px Inter', color: C.ink3, maxWidth: W - 222 - 300 });
    text(ctx, `${fmt(t.kcal, 0)} kcal`, W - 140, y + 70, { font: '500 32px "IBM Plex Mono"', align: 'right' });
    if (i < slots.length - 1) {
      ctx.fillStyle = C.line;
      ctx.fillRect(140, y + rowH, W - 280, 2);
    }
  });
  return canvas;
}

// ---------- story da semana ----------

export async function renderWeekStory(endDay = isoDay()) {
  const { canvas, ctx } = await baseCanvas();
  const days = Array.from({ length: 7 }, (_, i) => addDays(endDay, i - 6));
  const byDay = store.diaryByDay();
  const totals = days.map((d) => sumItems(byDay.get(d) || []));
  const logged = totals.filter((t) => t.kcal > 0);
  const avg = sumItems(logged.map((t) => ({ qty: 100 / logged.length, nutr: t })));
  const goals = store.goals();
  const nome = store.state.user?.nome?.split(' ')[0] || '';

  const sameMonth = days[0].slice(0, 7) === days[6].slice(0, 7);
  const range = sameMonth ? `${Number(days[0].slice(8))} a ${longDate(days[6])}` : `${longDate(days[0])} a ${longDate(days[6])}`;
  text(ctx, range, 90, 330, { font: '600 36px Inter', color: C.ink2 });
  text(ctx, nome ? `A semana de ${nome}` : 'Minha semana', 90, 420, { font: '700 84px Fraunces', maxWidth: W - 180 });

  card(ctx, 90, 490, W - 180, 760);
  text(ctx, 'média por dia', 140, 580, { font: '600 30px Inter', color: C.ink2 });
  text(ctx, `${fmt(avg.kcal || 0, 0)} kcal`, 140, 680, { font: '700 96px Fraunces' });
  text(ctx, `${logged.length} de 7 dias registrados`, W - 140, 580, { font: '500 26px "IBM Plex Mono"', color: C.ink3, align: 'right' });

  const chartTop = 760;
  const chartH = 380;
  const max = Math.max(goals.kcal * 1.15, ...totals.map((t) => t.kcal));
  const bw = 84;
  const gap = (W - 280 - bw * 7) / 6;
  const goalY = chartTop + chartH - (goals.kcal / max) * chartH;
  ctx.setLineDash([14, 12]);
  ctx.strokeStyle = C.caramel;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(140, goalY);
  ctx.lineTo(W - 140, goalY);
  ctx.stroke();
  ctx.setLineDash([]);
  text(ctx, `meta ${fmt(goals.kcal, 0)}`, W - 140, goalY - 14, { font: '500 24px "IBM Plex Mono"', color: C.caramel, align: 'right' });
  days.forEach((d, i) => {
    const x = 140 + i * (bw + gap);
    const h = Math.max(10, (totals[i].kcal / max) * chartH);
    ctx.fillStyle = !totals[i].kcal ? C.track : totals[i].kcal > goals.kcal * 1.02 ? C.prot : C.sage;
    roundRect(ctx, x, chartTop + chartH - h, bw, h, 18);
    ctx.fill();
    text(ctx, shortDate(d).split(' ')[0], x + bw / 2, chartTop + chartH + 50, { font: '600 26px Inter', color: C.ink2, align: 'center' });
  });

  card(ctx, 90, 1300, W - 180, 330);
  macroColumns(ctx, avg, goals, 1390);
  text(ctx, 'média diária de macronutrientes', W / 2, 1600, { font: '500 24px "IBM Plex Mono"', color: C.ink3, align: 'center' });
  return canvas;
}

// ---------- prévia + compartilhar ----------

function toBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * No iPhone, baixar um arquivo do app instalado nem sempre funciona; o menu
 * de compartilhar oferece "Salvar em Arquivos" e funciona sempre.
 */
async function saveFile(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (isIOS() && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (err) {
      if (err?.name !== 'AbortError') download(blob, filename);
    }
    return;
  }
  download(blob, filename);
}

export async function openStory(kind, day = isoDay()) {
  const sheet = openSheet({
    title: kind === 'week' ? 'Compartilhar a semana' : 'Compartilhar o dia',
    subtitle: 'Imagem no tamanho certo para o status do WhatsApp e stories',
    className: 'story-sheet',
  });
  sheet.setBody('<div class="skeleton" style="aspect-ratio:9/16;max-height:60vh;margin:0 auto"></div>');
  let blob;
  let url;
  try {
    const canvas = kind === 'week' ? await renderWeekStory(day) : await renderDayStory(day);
    blob = await toBlob(canvas);
    url = URL.createObjectURL(blob);
  } catch (err) {
    sheet.close();
    toastError(err);
    return;
  }
  const filename = `despensa-${kind === 'week' ? 'semana' : 'dia'}-${day}.png`;
  const file = new File([blob], filename, { type: 'image/png' });
  const canShare = !!navigator.canShare?.({ files: [file] });

  sheet.setBody(`<img src="${url}" alt="Prévia da imagem" style="max-height:58vh;width:auto;margin:0 auto;border-radius:16px;box-shadow:var(--shadow)">
    ${canShare ? '' : '<p class="faint" style="font-size:12.5px;text-align:center;margin:12px 0 0">Neste aparelho, baixe a imagem e poste pelo app do WhatsApp ou Instagram.</p>'}`);
  sheet.setFooter(`
    <button class="btn soft" data-act="download">${icon('download')}Baixar</button>
    ${canShare ? `<button class="btn primary" data-act="share">${icon('share')}Compartilhar</button>` : ''}`);
  sheet.foot.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'download') download(blob, filename);
    if (act === 'share') {
      try {
        await navigator.share({ files: [file], title: APP_NAME });
      } catch (err) {
        if (err?.name !== 'AbortError') toastError(err);
      }
    }
  });
  const remove = sheet._remove;
  sheet._remove = () => {
    remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
}

// ---------- planilha (CSV para Excel/Google Planilhas em português) ----------

const csvNum = (n, d = 1) => (Math.round((n || 0) * 10 ** d) / 10 ** d).toString().replace('.', ',');
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const NUTRIENT_HEADERS = NUTRIENTS.map((n) => `${n.label} (${n.unit})`);

/** Dias do diário dentro dos últimos `period` dias. */
function daysIn(byDay, period) {
  const start = addDays(isoDay(), -(period - 1));
  return [...byDay.keys()].filter((d) => d >= start).sort();
}

export function exportCsv(kind, period = 30) {
  const byDay = store.diaryByDay();
  const days = daysIn(byDay, period);
  if (!days.length) {
    toast('Ainda não há nada no diário para exportar.');
    return;
  }
  const rows = [];
  if (kind === 'detalhado') {
    rows.push(['Data', 'Refeição', 'Alimento', 'Quantidade', 'Unidade', ...NUTRIENT_HEADERS]);
    for (const d of days) {
      for (const s of SLOTS) {
        for (const e of byDay.get(d).filter((x) => x.slot === s.key)) {
          const t = sumItems([e]);
          rows.push([d.split('-').reverse().join('/'), s.label, e.nome, csvNum(e.qty), e.unidade, ...NUTRIENTS.map((n) => csvNum(t[n.key]))]);
        }
      }
    }
  } else {
    rows.push(['Data', 'Itens registrados', ...NUTRIENT_HEADERS, 'Água (ml)']);
    for (const d of days) {
      const t = sumItems(byDay.get(d));
      rows.push([d.split('-').reverse().join('/'), byDay.get(d).length, ...NUTRIENTS.map((n) => csvNum(t[n.key])), store.waterFor(d)]);
    }
  }
  const csv = '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n');
  saveFile(new Blob([csv], { type: 'text/csv' }), `despensa-${kind}-${isoDay()}.csv`);
}

// ---------- relatório para imprimir / salvar como PDF ----------

export function printReport(period = 30) {
  const byDay = store.diaryByDay();
  const days = daysIn(byDay, period);
  if (!days.length) {
    toast('Ainda não há nada no diário para o relatório.');
    return;
  }
  const cols = ['kcal', 'carb', 'prot', 'gord', 'fibra', 'sodio'];
  const head = `<tr><th>Data</th>${cols.map((k) => {
    const n = NUTRIENTS.find((x) => x.key === k);
    return `<th>${esc(n.label)} (${n.unit})</th>`;
  }).join('')}</tr>`;
  const dayTotals = days.map((d) => [d, sumItems(byDay.get(d))]);
  const avg = Object.fromEntries(cols.map((k) => [k, dayTotals.reduce((a, [, t]) => a + t[k], 0) / dayTotals.length]));
  const user = store.state.user;

  let el = $('.print-report');
  if (!el) {
    el = document.createElement('div');
    el.className = 'print-report';
    document.body.appendChild(el);
  }
  el.innerHTML = `
    <h1>Relatório nutricional</h1>
    <div class="sub">${esc(user?.nome || '')} · ${longDate(days[0])} a ${longDate(days[days.length - 1])} · ${days.length} dias registrados · meta ${fmt(store.goals().kcal, 0)} kcal/dia</div>
    <h2>Resumo por dia</h2>
    <table><thead>${head}</thead><tbody>
      ${dayTotals.map(([d, t]) => `<tr><td>${shortDate(d)}</td>${cols.map((k) => `<td>${fmt(t[k], k === 'kcal' || k === 'sodio' ? 0 : 1)}</td>`).join('')}</tr>`).join('')}
      <tr class="avg"><td>Média</td>${cols.map((k) => `<td>${fmt(avg[k], k === 'kcal' || k === 'sodio' ? 0 : 1)}</td>`).join('')}</tr>
    </tbody></table>
    ${days.slice().reverse().map((d) => `
      <h2>${relativeDay(d)}, ${longDate(d)}</h2>
      <table><thead><tr><th>Alimento</th><th>Refeição</th><th>Quantidade</th><th>kcal</th><th>Carb (g)</th><th>Prot (g)</th><th>Gord (g)</th></tr></thead><tbody>
      ${SLOTS.flatMap((s) => byDay.get(d).filter((e) => e.slot === s.key).map((e) => {
        const t = sumItems([e]);
        return `<tr><td>${esc(e.nome)}</td><td>${s.label}</td><td>${fmt(e.qty)} ${e.unidade}</td><td>${fmt(t.kcal, 0)}</td><td>${fmt(t.carb)}</td><td>${fmt(t.prot)}</td><td>${fmt(t.gord)}</td></tr>`;
      })).join('')}
      </tbody></table>`).join('')}
    <div class="foot">Gerado em ${new Date().toLocaleString('pt-BR')} por ${esc(APP_NAME)} · ${APP_URL}</div>`;
  window.print();
}

