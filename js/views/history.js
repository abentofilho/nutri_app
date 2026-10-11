import { icon } from '../icons.js';
import { macroSplit, sumItems } from '../nutrition.js';
import * as store from '../store.js';
import { exportCsv, openStory, printReport } from '../share.js';
import { stackBar } from '../ui.js';
import { addDays, fmt, isoDay, relativeDay, shortDate } from '../util.js';

export const title = 'Histórico';

function chart(days, totals, goal) {
  // Desenha na largura real da tela para o texto não encolher no celular.
  const W = Math.round(Math.min(900, Math.max(300, Math.min(window.innerWidth, 1040) - 70)));
  const H = 200;
  const top = 18;
  const bottom = 26;
  const left = 4;
  const right = 4;
  const n = days.length;
  const slot = (W - left - right) / n;
  const bw = Math.max(4, slot * 0.66);
  const max = Math.max(goal * 1.2, ...totals.map((t) => t.kcal)) || 1;
  const y = (v) => top + (H - top - bottom) * (1 - v / max);
  const today = isoDay();

  const bars = days.map((d, i) => {
    const v = totals[i].kcal;
    const x = left + i * slot + (slot - bw) / 2;
    const h = v ? Math.max(3, y(0) - y(v)) : 3;
    const cls = !v ? 'empty' : d === today ? 'today' : v > goal * 1.02 ? 'over' : '';
    const label = i % 5 === (n - 1) % 5 || d === today
      ? `<text class="lbl" x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${d === today ? 'hoje' : shortDate(d).split(' ').slice(1).join(' ')}</text>` : '';
    return `<a href="#/hoje/${d}" aria-label="${relativeDay(d)}, ${fmt(v, 0)} kcal">
      <title>${shortDate(d)}: ${fmt(v, 0)} kcal</title>
      <rect x="${left + i * slot}" y="${top}" width="${slot}" height="${H - top - bottom}" fill="transparent"/>
      <rect class="b ${cls}" x="${x}" y="${y(0) - h}" width="${bw}" height="${h}" rx="${Math.min(4, bw / 2)}"/>
    </a>${label}`;
  }).join('');

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Calorias por dia nos últimos ${n} dias">
    <line class="grid" x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}"/>
    <line class="goal" x1="0" x2="${W}" y1="${y(goal)}" y2="${y(goal)}"/>
    <text class="goal-lbl" x="${W - 2}" y="${y(goal) - 5}" text-anchor="end">meta ${fmt(goal, 0)} kcal</text>
    ${bars}
  </svg>`;
}

function streak(byDay) {
  let day = isoDay();
  if (!byDay.has(day)) day = addDays(day, -1);
  let count = 0;
  while (byDay.has(day)) {
    count += 1;
    day = addDays(day, -1);
  }
  return count;
}

let period = 7;

function summaryTable(days, byDay) {
  const rows = days.slice().reverse().map((d) => {
    const t = sumItems(byDay.get(d) || []);
    const water = store.waterFor(d);
    const empty = !byDay.has(d) && !water;
    return `<tr class="${empty ? 'empty-day' : ''}" data-day="${d}">
      <td><b>${relativeDay(d)}</b><small>${shortDate(d).split(' ').slice(1).join(' ')}</small></td>
      <td>${empty ? '—' : fmt(t.kcal, 0)}</td>
      <td>${empty ? '' : fmt(t.carb, 0)}</td>
      <td>${empty ? '' : fmt(t.prot, 0)}</td>
      <td>${empty ? '' : fmt(t.gord, 0)}</td>
      <td>${water ? fmt(water / 1000, 1) : ''}</td>
    </tr>`;
  }).join('');
  return `
    <div class="card table-card">
      <table class="week-table">
        <thead><tr><th>Dia</th><th>kcal</th><th>Carb</th><th>Prot</th><th>Gord</th><th>Água</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="table-note">Carboidratos, proteínas e gorduras em gramas; água em litros. Toque num dia para abrir.</p>
    </div>`;
}

export function render() {
  const historyDays = store.state.config.history_days || 30;
  const span = Math.min(period, historyDays);
  const today = isoDay();
  const days = Array.from({ length: span }, (_, i) => addDays(today, i - span + 1));
  const byDay = store.diaryByDay();
  const totals = days.map((d) => sumItems(byDay.get(d) || []));
  const logged = days.filter((d) => byDay.has(d));
  const goal = store.goals().kcal;
  const loggedTotals = logged.map((d) => sumItems(byDay.get(d)));
  const avg = sumItems(loggedTotals.map((t) => ({ qty: 100 / (loggedTotals.length || 1), nutr: t })));
  const split = macroSplit(avg);

  const exportBtn = (act, ic, color, titleTxt, sub) => `
    <button class="export-btn" data-act="${act}">
      <span class="ei" style="background:${color}">${icon(ic)}</span>
      <span><b>${titleTxt}</b><span>${sub}</span></span>
    </button>`;

  return `
    <div class="page-head">
      <h1 class="page-title">Histórico</h1>
      <div class="seg" role="group" aria-label="Período">
        <button class="chip" data-period="7" aria-pressed="${span === 7}">7 dias</button>
        <button class="chip" data-period="${historyDays}" aria-pressed="${span === historyDays}">${historyDays} dias</button>
      </div>
    </div>

    <div class="stats-row">
      <div class="stat"><div class="k">Média diária</div><div class="v">${fmt(avg.kcal, 0)}</div><div class="u">kcal</div></div>
      <div class="stat"><div class="k">Registrados</div><div class="v">${logged.length}</div><div class="u">de ${span} dias</div></div>
      <div class="stat"><div class="k">Sequência</div><div class="v">${streak(byDay)}</div><div class="u">dias seguidos</div></div>
    </div>

    <article class="card" style="margin-top:12px">
      <div class="eyebrow" style="margin-bottom:8px">Calorias por dia</div>
      ${chart(days, totals, goal)}
      ${logged.length ? `
        <div style="margin-top:14px">
          <div class="eyebrow" style="margin-bottom:6px">De onde vêm as calorias</div>
          ${stackBar(avg)}
          <div class="macro-legend" style="margin-top:8px">${split.map((m) =>
            `<span><i style="background:${m.hex}"></i>${m.label} ${fmt(m.pct, 0)}% · ${fmt(avg[m.key], 0)} g</span>`).join('')}</div>
        </div>` : ''}
    </article>

    <h2 class="section-title">Totais por dia</h2>
    ${summaryTable(days, byDay)}

    <h2 class="section-title">Compartilhar e baixar</h2>
    <div class="export-grid">
      ${exportBtn('csv', 'table', 'var(--sage-t)', 'Planilha (CSV)', `Totais dos ${span} dias, abre no Excel`)}
      ${exportBtn('pdf', 'file', 'var(--prot-t)', 'Relatório em PDF', 'Para imprimir ou levar à nutricionista')}
      ${exportBtn('week-story', 'image', 'var(--carb-t)', 'Story da semana', 'Imagem dos últimos 7 dias')}
    </div>
    <p class="faint" style="font-size:13px;margin:10px 2px 0">
      <button class="link-btn" data-act="csv-full">Planilha com cada alimento separado</button></p>
    <p class="faint" style="font-size:12.5px;margin:14px 2px 0">O app guarda os últimos ${historyDays} dias; os mais antigos saem sozinhos. Baixe a planilha se quiser guardar.</p>`;
}

export function mount(el) {
  el.addEventListener('click', (e) => {
    const p = e.target.closest('[data-period]');
    if (p) {
      period = Number(p.dataset.period);
      el.innerHTML = render();
      return;
    }
    const row = e.target.closest('tr[data-day]');
    if (row) {
      location.hash = `#/hoje/${row.dataset.day}`;
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'week-story') openStory('week');
    if (act === 'csv') exportCsv('resumo', period);
    if (act === 'csv-full') exportCsv('detalhado', period);
    if (act === 'pdf') printReport(period);
  });
}
