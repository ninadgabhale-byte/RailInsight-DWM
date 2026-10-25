/* =====================================================================
   RailInsight – forecast.js  (Prediction & Forecasting)
   GET  /api/forecast/options -> { targets:[{key,label,available,reason}], granularities:[], models:[{key,label}], max_horizon }
   POST /api/forecast  { target, granularity, model, horizon, test_fraction }
     -> { available, reason?, history:{labels,values}, test:{labels,predicted},
          forecast:{labels,values,lower?,upper?}, metrics:{MAE,RMSE,R2,baseline_MAE}, split, warnings }
   Training/testing is chronological (no shuffling). If the data is not
   sufficient the backend answers available:false and we show WHY instead
   of drawing an invented forecast.
   ===================================================================== */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  let opts = null;

  function renderForm() {
    const f = $('fc-form');
    f.innerHTML = `<form onsubmit="return false">
      ${UI.field('What to forecast', UI.select('target', opts.targets.filter((t) => t.available).map((t) => ({ value: t.key, label: t.label }))))}
      ${UI.field('Granularity', UI.select('granularity', opts.granularities))}
      ${UI.field('Model', UI.select('model', opts.models.map((m) => ({ value: m.key, label: m.label }))))}
      ${UI.field('Forecast horizon (periods)', `<input class="form-control form-control-sm" type="number" name="horizon" value="14" min="1" max="${opts.max_horizon || 90}">`)}
      ${UI.field('Test fraction (last part of the timeline)', UI.range('test_fraction', 0.1, 0.4, 0.05, 0.2))}
      <button class="btn btn-primary w-100" id="fc-run"><i class="fa-solid fa-play me-2"></i>Train &amp; forecast</button>
      ${opts.targets.filter((t) => !t.available).map((t) => `<div class="small text-muted mt-3"><i class="fa-solid fa-ban me-1"></i><b>${UI.esc(t.label)}</b> unavailable: ${UI.esc(t.reason || '')}</div>`).join('')}
    </form>`;
    $('fc-run').addEventListener('click', run);
  }

  async function run() {
    const f = $('fc-form'), out = $('fc-out');
    const v = (n) => f.querySelector(`[name="${n}"]`).value;
    UI.loading(out, 'Training model on the chronological split…');
    try {
      const r = await Api.post('/api/forecast', { target: v('target'), granularity: v('granularity'), model: v('model'), horizon: +v('horizon'), test_fraction: +v('test_fraction') });
      render(out, r);
    } catch (e) { UI.error(out, e); }
  }

  function render(out, r) {
    if (!r.available) {
      out.innerHTML = UI.alert('warning', `<b>Reliable forecasting is not available.</b><br>${UI.esc(r.reason || 'The dataset does not contain enough history.')}`)
        + UI.alerts(r.warnings);
      return;
    }
    const m = r.metrics || {};
    out.innerHTML = `${UI.alerts(r.warnings)}
      <div class="row g-3 mb-3">
        ${UI.kpiCard({ label: 'MAE', value: m.MAE, format: 'decimal', hint: 'mean absolute error' }, 'fa-ruler')}
        ${UI.kpiCard({ label: 'RMSE', value: m.RMSE, format: 'decimal', hint: 'penalises big misses' }, 'fa-square-root-variable')}
        ${UI.kpiCard({ label: 'R² score', value: m.R2, format: 'decimal', hint: '≤ 0 means no better than the average' }, 'fa-bullseye')}
        ${m.baseline_MAE !== undefined ? UI.kpiCard({ label: 'Naive baseline MAE', value: m.baseline_MAE, format: 'decimal', hint: 'predict “same as last period”' }, 'fa-scale-balanced') : ''}
      </div>
      <div class="card mb-3"><div class="card-header d-flex justify-content-between"><span>Actual, test predictions and forecast</span>
        <button class="btn btn-sm btn-outline-secondary" data-export-chart="fc-chart" data-name="forecast"><i class="fa-solid fa-image"></i></button></div>
        <div class="card-body"><div class="chart-box tall"><canvas id="fc-chart"></canvas></div>
        <div class="chart-note">Training period ends ${UI.esc((r.split || {}).train_end || '')}; the model is evaluated only on the later test period (no shuffling).</div></div></div>
      ${r.forecast_table ? '<div class="card"><div class="card-body"><div id="fc-table"></div></div></div>' : ''}`;

    // build aligned series on one label axis
    const labels = r.history.labels.concat(r.forecast.labels);
    const nH = r.history.labels.length;
    const pad = (n) => new Array(n).fill(null);
    const actual = r.history.values.concat(pad(r.forecast.labels.length));
    const testPred = labels.map((l) => { const i = r.test.labels.indexOf(l); return i >= 0 ? r.test.predicted[i] : null; });
    const fc = pad(nH - 1).concat([r.history.values[nH - 1]], r.forecast.values);   // start at last actual → connected line
    const ds = [
      { label: 'Actual', data: actual, borderColor: '#16345f' },
      { label: 'Model on test period', data: testPred, borderColor: '#00b8a9', borderDash: [5, 4] },
      { label: 'Forecast', data: fc, borderColor: '#f5a524', borderDash: [6, 4] },
    ];
    if (r.forecast.lower && r.forecast.upper) {
      ds.push({ label: 'Lower bound', data: pad(nH).concat(r.forecast.lower), borderColor: 'rgba(245,165,36,.4)', borderWidth: 1, pointRadius: 0 });
      ds.push({ label: 'Upper bound', data: pad(nH).concat(r.forecast.upper), borderColor: 'rgba(245,165,36,.4)', borderWidth: 1, pointRadius: 0 });
    }
    Charts.fromSpec('fc-chart', { type: 'line', labels, datasets: ds, y_label: r.unit || '' });
    if (r.forecast_table) UI.table('fc-table', { columns: r.forecast_table.columns, rows: r.forecast_table.rows, title: 'Forecast values', exportName: 'forecast', pageSize: 10 });
  }

  async function load() {
    const st = $('fc-state');
    UI.loading(st, 'Checking what can be forecast from this dataset…');
    $('fc-body').hidden = true;
    try {
      opts = await Api.get('/api/forecast/options');
      st.innerHTML = '';
      if (!opts.targets.some((t) => t.available)) {
        UI.error(st, new ApiError(opts.targets.map((t) => `${t.label}: ${t.reason}`).join(' | ') || 'No forecastable measure found.', { status: 0 }));
        return;
      }
      $('fc-body').hidden = false;
      renderForm();
      $('fc-out').innerHTML = '<div class="state-box"><i class="fa-solid fa-chart-area big"></i><h6>Choose a target and run</h6><div class="small">Forecast chart and error metrics appear here.</div></div>';
      App.markLoaded('forecast');
    } catch (e) { UI.error(st, e); }
  }

  App.register('forecast', { show() { if (App.stale('forecast')) load(); } });
})();
