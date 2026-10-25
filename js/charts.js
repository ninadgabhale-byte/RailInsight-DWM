/* =====================================================================
   RailInsight – charts.js
   One place for chart styling so every chart in the app looks the same.

   Chart "spec" format (what the backend returns, what Charts.fromSpec renders):
     { type: 'bar'|'hbar'|'line'|'pie'|'doughnut'|'scatter'|'histogram',
       title, labels:[...], values:[...]  OR  datasets:[{label, data:[...]}],
       x_label, y_label, options:{ stacked, area, horizontal } }
   Other grid items:  { type:'table', columns, rows }
                      { type:'heatmap', row_labels, col_labels, matrix }
                      { type:'boxplot', stats:[{label,min,q1,median,q3,max}] }
   ===================================================================== */
'use strict';

const Charts = {
  PALETTE: ['#2f7df6', '#00b8a9', '#f5a524', '#e5484d', '#8b5cf6', '#14b8a6', '#f97316', '#64748b', '#22c55e', '#ec4899'],
  registry: {},
  _uid: 0,

  uid(prefix = 'chart') { this._uid += 1; return `${prefix}-${this._uid}`; },

  init() {
    if (!window.Chart) { console.error('Chart.js failed to load (check your internet connection).'); return; }
    Chart.defaults.font.family = "'Segoe UI', system-ui, sans-serif";
    Chart.defaults.font.size = 12;
    Chart.defaults.color = '#475569';
    Chart.defaults.borderColor = 'rgba(100,116,139,.18)';
    Chart.defaults.maintainAspectRatio = false;
    Chart.defaults.plugins.legend.position = 'bottom';
    Chart.defaults.plugins.legend.labels.usePointStyle = true;
    Chart.defaults.plugins.tooltip.backgroundColor = '#0f2747';
    Chart.defaults.plugins.tooltip.padding = 10;
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-export-chart]');
      if (b) Charts.exportPNG(b.dataset.exportChart, b.dataset.name);
    });
  },

  color(i, alpha = 1) {
    const hex = this.PALETTE[i % this.PALETTE.length];
    if (alpha >= 1) return hex;
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  },

  destroy(id) { if (this.registry[id]) { this.registry[id].destroy(); delete this.registry[id]; } },

  destroyIn(el) {
    if (el && el._charts) el._charts.forEach((id) => this.destroy(id));
    if (el) el._charts = [];
  },

  make(id, config) {
    const canvas = document.getElementById(id);
    if (!canvas || !window.Chart) return null;
    this.destroy(id);
    this.registry[id] = new Chart(canvas.getContext('2d'), config);
    return this.registry[id];
  },

  /** Render a chart spec into an existing <canvas id=…> */
  fromSpec(id, spec) {
    const t = spec.type || 'bar';
    const labels = spec.labels || [];
    const pie = t === 'pie' || t === 'doughnut';
    const horizontal = t === 'hbar' || !!(spec.options && spec.options.horizontal);
    const cfgType = (t === 'hbar' || t === 'histogram') ? 'bar' : t;
    const opts = spec.options || {};

    let datasets = spec.datasets || (spec.values ? [{ label: spec.label || spec.title || 'Value', data: spec.values }] : []);
    datasets = datasets.map((d, i) => {
      const b = Object.assign({}, d);
      if (pie) {
        b.backgroundColor = labels.map((_, j) => this.color(j));
        b.borderColor = '#fff'; b.borderWidth = 2;
      } else if (cfgType === 'line') {
        b.borderColor = b.borderColor || this.color(i);
        b.backgroundColor = this.color(i, 0.15);
        b.tension = 0.3; b.fill = !!opts.area; b.borderWidth = 2;
        b.pointRadius = (d.data || []).length > 60 ? 0 : 3;
      } else if (cfgType === 'scatter') {
        b.backgroundColor = this.color(i, 0.6); b.borderColor = this.color(i); b.pointRadius = 4;
      } else {
        b.backgroundColor = spec.multicolor && datasets.length === 1 ? labels.map((_, j) => this.color(j)) : this.color(i, 0.88);
        b.borderRadius = 4;
        if (t === 'histogram') { b.categoryPercentage = 1; b.barPercentage = 0.98; }
      }
      return b;
    });

    const nf = (v) => (typeof v === 'number' ? UI.nf2.format(v) : v);
    const options = {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: pie || datasets.length > 1 },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              if (cfgType === 'scatter') return `${ctx.dataset.label || ''} (${nf(ctx.parsed.x)}, ${nf(ctx.parsed.y)})`;
              const v = pie ? ctx.parsed : (horizontal ? ctx.parsed.x : ctx.parsed.y);
              return `${ctx.dataset.label ? ctx.dataset.label + ': ' : ''}${nf(v)}`;
            },
          },
        },
      },
    };
    if (!pie) {
      options.scales = {
        x: { stacked: !!opts.stacked, grid: { display: cfgType !== 'bar' }, title: { display: !!spec.x_label, text: spec.x_label } },
        y: { stacked: !!opts.stacked, beginAtZero: cfgType !== 'scatter', title: { display: !!spec.y_label, text: spec.y_label } },
      };
      if (cfgType === 'scatter') { options.scales.x.type = 'linear'; options.scales.x.grid = { display: true }; }
      if (horizontal) options.indexAxis = 'y';
    }
    if (t === 'doughnut') options.cutout = '60%';
    if (spec.onClick) {
      options.onClick = (evt, els, chart) => { if (els.length) spec.onClick(chart.data.labels[els[0].index], els[0].index); };
      options.onHover = (evt, els) => { evt.native.target.style.cursor = els.length ? 'pointer' : 'default'; };
    }
    return this.make(id, { type: cfgType, data: { labels, datasets }, options });
  },

  /** Box plot drawn with Chart.js floating bars (whisker bar + box bar + median marker). */
  boxplot(id, stats, { horizontal = false, yLabel = '' } = {}) {
    const labels = stats.map((s) => s.label);
    const cfg = {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Min – Max', data: stats.map((s) => [s.min, s.max]), backgroundColor: 'rgba(47,125,246,.25)', borderColor: '#2f7df6', borderWidth: 1, barPercentage: 0.16, grouped: false, order: 3 },
          { label: 'Q1 – Q3', data: stats.map((s) => [s.q1, s.q3]), backgroundColor: 'rgba(47,125,246,.75)', borderRadius: 3, barPercentage: 0.55, grouped: false, order: 2 },
          { type: 'line', label: 'Median', data: stats.map((s) => s.median), showLine: false, pointStyle: 'rectRot', pointRadius: 6, pointBackgroundColor: '#f5a524', pointBorderColor: '#fff', order: 1 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        indexAxis: horizontal ? 'y' : 'x',
        scales: { y: { title: { display: !!yLabel, text: yLabel } } },
        plugins: {
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const s = stats[ctx.dataIndex];
                return ctx.dataset.label === 'Median' ? `Median: ${UI.nf2.format(s.median)}`
                  : `${ctx.dataset.label}: ${UI.nf2.format(ctx.dataset.label === 'Q1 – Q3' ? s.q1 : s.min)} → ${UI.nf2.format(ctx.dataset.label === 'Q1 – Q3' ? s.q3 : s.max)}`;
              },
            },
          },
        },
      },
    };
    return this.make(id, cfg);
  },

  /** HTML heat-map table (also used for pivot tables, confusion matrices, correlation matrices) */
  heatmap(target, h) {
    const el = UI.el(target); if (!el) return;
    const rl = h.row_labels || [], cl = h.col_labels || [], m = h.matrix || [];
    let min = Infinity, max = -Infinity;
    m.forEach((r) => r.forEach((v) => { if (typeof v === 'number') { if (v < min) min = v; if (v > max) max = v; } }));
    const span = (max - min) || 1;
    const fmt = (v) => (v === null || v === undefined ? '' : (typeof v === 'number' ? (Number.isInteger(v) ? UI.nf.format(v) : UI.nf2.format(v)) : UI.esc(v)));
    let html = `<div class="heat-wrap"><table class="heat"><thead><tr><th>${UI.esc(h.corner || '')}</th>${cl.map((c) => `<th>${UI.esc(c)}</th>`).join('')}</tr></thead><tbody>`;
    rl.forEach((r, i) => {
      html += `<tr><th>${UI.esc(r)}</th>`;
      (m[i] || []).forEach((v) => {
        if (typeof v !== 'number') { html += '<td></td>'; return; }
        const a = 0.07 + 0.85 * ((v - min) / span);
        html += `<td style="background:rgba(47,125,246,${a.toFixed(2)});color:${a > 0.5 ? '#fff' : '#0f2747'}">${fmt(v)}</td>`;
      });
      html += '</tr>';
    });
    el.innerHTML = html + '</tbody></table></div>';
  },

  /** Download a chart as a white-background PNG */
  exportPNG(id, name) {
    const chart = this.registry[id]; if (!chart) return;
    const src = chart.canvas;
    const tmp = document.createElement('canvas');
    tmp.width = src.width; tmp.height = src.height;
    const ctx = tmp.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, tmp.width, tmp.height);
    ctx.drawImage(src, 0, 0);
    const a = document.createElement('a');
    a.href = tmp.toDataURL('image/png');
    a.download = (name || id).replace(/[^\w\-]+/g, '_') + '.png';
    document.body.appendChild(a); a.click(); a.remove();
  },

  /** Card wrapper for a chart canvas */
  cardHTML(id, title, { note = '', tall = false } = {}) {
    return `<div class="card chart-card h-100"><div class="card-header"><span>${UI.esc(title || '')}</span>
      <button class="btn btn-sm btn-outline-secondary" data-export-chart="${id}" data-name="${UI.esc(title || id)}" title="Download PNG"><i class="fa-solid fa-image"></i></button></div>
      <div class="card-body"><div class="chart-box${tall ? ' tall' : ''}"><canvas id="${id}"></canvas></div>
      ${note ? `<div class="chart-note">${UI.esc(note)}</div>` : ''}</div></div>`;
  },

  /**
   * Render a list of backend items (charts / tables / heatmaps / boxplots) into a .row container.
   */
  renderGrid(target, items) {
    const el = UI.el(target); if (!el) return;
    this.destroyIn(el);
    if (!items || !items.length) {
      el.innerHTML = '<div class="col-12"></div>';
      UI.empty(el.firstChild, 'fa-chart-simple', 'Nothing to display', 'No charts are available for the current dataset and mapping.');
      return;
    }
    el.innerHTML = '';
    const after = [];
    items.forEach((item) => {
      const col = document.createElement('div');
      col.className = item.width === 'full' || item.type === 'table' || item.type === 'heatmap' ? 'col-12' : 'col-12 col-xl-6';
      const id = this.uid('c');
      if (item.type === 'table') {
        col.innerHTML = `<div class="card h-100"><div class="card-body"><div id="${id}"></div></div></div>`;
        after.push(() => UI.table(id, { columns: item.columns, rows: item.rows, title: item.title, exportName: item.export_name || item.title || 'table', pageSize: item.page_size || 10 }));
      } else if (item.type === 'heatmap') {
        col.innerHTML = `<div class="card h-100"><div class="card-header">${UI.esc(item.title || '')}</div><div class="card-body"><div id="${id}"></div></div></div>`;
        after.push(() => this.heatmap(id, item));
      } else {
        col.innerHTML = this.cardHTML(id, item.title, { note: item.note });
        el._charts.push(id);
        after.push(() => (item.type === 'boxplot' ? this.boxplot(id, item.stats, { yLabel: item.y_label }) : this.fromSpec(id, item)));
      }
      el.appendChild(col);
    });
    after.forEach((fn) => fn());
  },
};
