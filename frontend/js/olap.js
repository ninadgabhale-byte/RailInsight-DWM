/* =====================================================================
   RailInsight – olap.js  (OLAP Analysis)
   GET  /api/olap/metadata -> { dimensions:[{key,label,values?}], time_levels:[{key,label}],
                                measures:[{key,label}], aggregations:['SUM',...] }
   POST /api/olap/query    -> { sql, params, columns, rows, chart, level, next_level, row_count }

   The browser only sends dimension/measure KEYS. The backend maps them to a
   whitelist of real columns, so users can never inject arbitrary SQL.
   ===================================================================== */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  const EXPLAIN = {
    rollup: { title: 'Roll-up (viva note)', text: 'Roll-up moves UP a concept hierarchy – for time: Day → Month → Quarter → Year. Detail is summarised, so there are fewer rows and a bigger picture. In SQL it is a GROUP BY on a coarser level.' },
    drilldown: { title: 'Drill-down (viva note)', text: 'Drill-down is the opposite of roll-up: start from a summary (Year) and click a value to see the next level of detail (Quarter → Month → Day). In SQL it adds one more GROUP BY level and a WHERE on the values you clicked.' },
    slice: { title: 'Slice (viva note)', text: 'Slice fixes ONE dimension to a single value (e.g. ticket type = Single) and looks at the remaining data – like cutting one slice of a cube. In SQL it is a single WHERE condition.' },
    dice: { title: 'Dice (viva note)', text: 'Dice selects a sub-cube by filtering SEVERAL dimensions at once (e.g. line IN (Western, Central) AND payment IN (UPI, Cash)). In SQL it is a WHERE with multiple conditions.' },
    pivot: { title: 'Pivot (viva note)', text: 'Pivot (rotate) turns one dimension into columns so two dimensions can be compared in a cross-table, e.g. routes down the side and months across the top, with a measure in each cell.' },
  };

  const state = { meta: null, op: 'rollup', path: [], measure: null, agg: null, last: null, diceRows: 1 };

  function init() {
    $('olap-ops').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-op]'); if (!b) return;
      state.op = b.dataset.op; state.path = [];
      document.querySelectorAll('#olap-ops button').forEach((x) => x.classList.toggle('active', x === b));
      renderForm();
    });
    $('olap-run').addEventListener('click', run);
    const form = $('olap-form');
    form.addEventListener('change', (e) => {
      if (e.target.name === 'measure') state.measure = e.target.value;
      if (e.target.name === 'agg') state.agg = e.target.value;
      if (e.target.name === 'slice_dim') fillSliceValues();
      if (e.target.dataset.role === 'dim') fillDiceValues(e.target.closest('.dice-row'));
    });
    form.addEventListener('click', (e) => {
      if (e.target.closest('#olap-add-dice')) { addDiceRow(); }
      const rm = e.target.closest('.dice-remove'); if (rm) rm.closest('.dice-row').remove();
      if (e.target.closest('#olap-restart')) { state.path = []; run(); }
    });
  }

  /* ------------------------------ forms -------------------------------- */
  const dimOptions = (timeOnly) => state.meta.dimensions.filter((d) => !timeOnly || d.time).map((d) => ({ value: d.key, label: d.label }));
  const measureAgg = () =>
    UI.field('Measure', UI.select('measure', state.meta.measures.map((m) => ({ value: m.key, label: m.label })), state.measure)) +
    UI.field('Aggregation', UI.select('agg', state.meta.aggregations, state.agg));

  function renderForm() {
    const m = state.meta, f = $('olap-form');
    const levels = m.time_levels.map((l) => ({ value: l.key, label: l.label }));
    const optional = [{ value: '', label: '— none —' }].concat(dimOptions(false));
    let html = '';
    switch (state.op) {
      case 'rollup':
        html = UI.field('Roll up to level', UI.select('level', levels, levels[levels.length - 1].value), 'Day → Month → Quarter → Year')
          + UI.field('Also group by (optional)', UI.select('group_by', optional, ''));
        break;
      case 'drilldown':
        html = `<p class="small text-muted">Start at the top level, then <b>click a bar or a table row</b> to drill into the next level.</p>
          <button type="button" class="btn btn-sm btn-outline-secondary mb-3" id="olap-restart"><i class="fa-solid fa-rotate-left me-1"></i>Restart from top</button>`;
        break;
      case 'slice':
        html = UI.field('Dimension to slice', UI.select('slice_dim', dimOptions(false)))
          + `<div id="olap-slice-val"></div>` + UI.field('Show results grouped by', UI.select('group_by', dimOptions(false), (dimOptions(false)[1] || {}).value));
        break;
      case 'dice':
        html = `<div id="olap-dice-rows"></div><button type="button" class="btn btn-sm btn-outline-primary mb-3" id="olap-add-dice"><i class="fa-solid fa-plus me-1"></i>Add condition</button>`
          + UI.field('Show results grouped by', UI.select('group_by', dimOptions(false), (dimOptions(false)[1] || {}).value));
        break;
      case 'pivot': {
        const d = dimOptions(false);
        html = UI.field('Rows', UI.select('pivot_rows', d, d[0] && d[0].value)) + UI.field('Columns', UI.select('pivot_cols', d, d[1] ? d[1].value : (d[0] && d[0].value)));
        break;
      }
      default: break;
    }
    f.innerHTML = html + measureAgg();
    if (state.op === 'slice') fillSliceValues();
    if (state.op === 'dice') { state.diceRows = 0; addDiceRow(); }
  }

  function valueControl(dim, name) {
    const d = state.meta.dimensions.find((x) => x.key === dim);
    if (d && d.values && d.values.length) {
      return { html: `<select class="form-select form-select-sm" name="${name}" ${name === 'dice_vals' ? 'multiple size="4"' : ''}>${d.values.map((v) => `<option value="${UI.esc(v)}">${UI.esc(v)}</option>`).join('')}</select>`, multi: true };
    }
    return { html: `<input class="form-control form-control-sm" name="${name}" placeholder="${name === 'dice_vals' ? 'value1, value2' : 'value'}">`, multi: false };
  }

  function fillSliceValues() {
    const dim = $('olap-form').querySelector('[name=slice_dim]').value;
    $('olap-slice-val').innerHTML = UI.field('Value', valueControl(dim, 'slice_val').html);
  }

  function addDiceRow() {
    const host = $('olap-dice-rows');
    const row = document.createElement('div');
    row.className = 'dice-row border rounded p-2 mb-2';
    row.innerHTML = `<div class="d-flex gap-2 mb-1">${UI.select('dice_dim', dimOptions(false), '', 'data-role="dim"')}
      <button type="button" class="btn btn-sm btn-outline-danger dice-remove" title="Remove"><i class="fa-solid fa-xmark"></i></button></div><div class="dice-vals"></div>
      <div class="form-text">Hold Ctrl to pick several values.</div>`;
    host.appendChild(row);
    fillDiceValues(row);
  }
  function fillDiceValues(row) {
    const dim = row.querySelector('[data-role=dim]').value;
    row.querySelector('.dice-vals').innerHTML = valueControl(dim, 'dice_vals').html;
  }

  /* ------------------------------ request ------------------------------ */
  function buildRequest() {
    const f = $('olap-form');
    const val = (n) => { const el = f.querySelector(`[name="${n}"]`); return el ? el.value : ''; };
    const req = { operation: state.op, measure: val('measure'), agg: val('agg'), limit: 500 };
    switch (state.op) {
      case 'rollup': req.level = val('level'); if (val('group_by')) req.group_by = val('group_by'); break;
      case 'drilldown': req.path = state.path; break;
      case 'slice': {
        const v = val('slice_val').trim();
        if (!v) throw new Error('Enter or choose a value to slice on.');
        req.slice = { dimension: val('slice_dim'), value: v }; req.group_by = val('group_by');
        if (req.group_by === req.slice.dimension) throw new Error('Group by a different dimension than the one you sliced on.');
        break;
      }
      case 'dice': {
        req.dice = [];
        f.querySelectorAll('.dice-row').forEach((r) => {
          const dim = r.querySelector('[data-role=dim]').value;
          const sel = r.querySelector('select[name=dice_vals]');
          const values = sel ? [...sel.selectedOptions].map((o) => o.value)
            : r.querySelector('input[name=dice_vals]').value.split(',').map((s) => s.trim()).filter(Boolean);
          if (values.length) req.dice.push({ dimension: dim, values });
        });
        if (!req.dice.length) throw new Error('Add at least one condition with a selected value.');
        const dims = req.dice.map((d) => d.dimension);
        if (new Set(dims).size !== dims.length) throw new Error('Use each dimension only once in a dice.');
        req.group_by = val('group_by');
        break;
      }
      case 'pivot':
        req.pivot = { rows: val('pivot_rows'), columns: val('pivot_cols') };
        if (req.pivot.rows === req.pivot.columns) throw new Error('Rows and columns must be different dimensions.');
        break;
      default: break;
    }
    return req;
  }

  async function run() {
    let req;
    try { req = buildRequest(); } catch (e) { UI.toast(e.message, 'warning'); return; }
    const out = $('olap-out');
    UI.loading(out, 'Querying the warehouse…');
    try {
      const res = await Api.post('/api/olap/query', req);
      state.last = res;
      render(res, req);
    } catch (e) { UI.error(out, e); }
  }

  /* ----------------------------- rendering ----------------------------- */
  function breadcrumb(res) {
    const lvl = (k) => { const l = state.meta.time_levels.find((x) => x.key === k); return l ? l.label : k; };
    const items = [`<button class="crumb-item" data-crumb="0">All ${UI.esc(lvl(state.meta.time_levels[0].key))}s</button>`]
      .concat(state.path.map((p, i) => `<button class="crumb-item" data-crumb="${i + 1}">${UI.esc(lvl(p.level))}: ${UI.esc(p.value)}</button>`));
    return `<div class="breadcrumb-trail">${items.join('<i class="fa-solid fa-chevron-right small text-muted"></i>')}
      <span class="ms-2 text-muted">showing by <b>${UI.esc(lvl(res.level))}</b>${res.next_level ? '' : ' (lowest level)'}</span></div>`;
  }

  function drill(value) {
    const res = state.last;
    if (state.op !== 'drilldown' || !res || !res.next_level) { UI.toast('Already at the lowest level.', 'info'); return; }
    state.path.push({ level: res.level, value: String(value) });
    run();
  }

  function render(res, req) {
    const out = $('olap-out');
    const exp = EXPLAIN[req.operation];
    const isPivot = req.operation === 'pivot';
    out.innerHTML = `
      <div class="card mb-3"><div class="card-header d-flex justify-content-between align-items-center"><span><i class="fa-solid fa-code me-2"></i>Generated SQL</span>
        <button class="btn btn-sm btn-outline-secondary" id="olap-copy"><i class="fa-regular fa-copy me-1"></i>Copy</button></div>
        <pre class="code-block" style="border-radius:0"><code>${UI.esc(res.sql)}</code></pre>
        ${res.params && Object.keys(res.params).length ? `<div class="small text-muted px-3 py-2">Bound parameters: <code>${UI.esc(JSON.stringify(res.params))}</code></div>` : ''}</div>
      <div class="card mb-3"><div class="card-body">
        ${req.operation === 'drilldown' ? breadcrumb(res) : ''}
        ${res.truncated ? UI.alert('warning', `Showing the first ${UI.nf.format(res.rows.length)} of ${UI.nf.format(res.row_count)} result rows.`) : ''}
        ${isPivot ? '<div id="olap-heat"></div><div class="mt-2"><button class="btn btn-sm btn-outline-secondary" id="olap-pivot-csv"><i class="fa-solid fa-file-csv me-1"></i>Export pivot CSV</button></div>'
          : '<div class="chart-box tall"><canvas id="olap-chart"></canvas></div><div class="text-end mt-2"><button class="btn btn-sm btn-outline-secondary" data-export-chart="olap-chart" data-name="olap_result"><i class="fa-solid fa-image me-1"></i>PNG</button></div>'}
      </div></div>
      ${isPivot ? '' : '<div class="card mb-3"><div class="card-body"><div id="olap-table"></div></div></div>'}
      <div class="viva-note"><b>${exp.title}:</b> ${exp.text}</div>`;

    $('olap-copy').addEventListener('click', () => UI.copy(res.sql));

    if (isPivot) {
      Charts.heatmap('olap-heat', { corner: `${req.pivot.rows} ↓ / ${req.pivot.columns} →`, row_labels: res.rows.map((r) => r[0]), col_labels: res.columns.slice(1), matrix: res.rows.map((r) => r.slice(1)) });
      $('olap-pivot-csv').addEventListener('click', () => UI.downloadCSV('olap_pivot', res.columns, res.rows));
    } else {
      const spec = Object.assign({}, res.chart);
      if (req.operation === 'drilldown' && res.next_level) spec.onClick = (label) => drill(label);
      Charts.fromSpec('olap-chart', spec);
      UI.table('olap-table', {
        columns: res.columns, rows: res.rows, pageSize: 10, exportName: 'olap_result',
        onRowClick: req.operation === 'drilldown' && res.next_level ? (row) => drill(row[0]) : null,
      });
    }
    if (req.operation === 'drilldown') {
      out.querySelectorAll('[data-crumb]').forEach((b) => b.addEventListener('click', () => { state.path = state.path.slice(0, +b.dataset.crumb); run(); }));
    }
  }

  /* ------------------------------- page -------------------------------- */
  async function load() {
    const st = $('olap-state');
    UI.loading(st, 'Loading OLAP metadata…');
    $('olap-body').hidden = true;
    try {
      state.meta = await Api.get('/api/olap/metadata');
      st.innerHTML = '';
      $('olap-body').hidden = false;
      state.measure = state.meta.measures[0].key; state.agg = state.meta.aggregations[0];
      state.path = [];
      renderForm();
      $('olap-out').innerHTML = '<div class="state-box"><i class="fa-solid fa-cube big"></i><h6>Pick an operation and press Run</h6><div class="small">The generated SQL, chart and table will appear here.</div></div>';
      App.markLoaded('olap');
    } catch (e) {
      UI.error(st, e);
      if (e.status === 409) st.insertAdjacentHTML('beforeend', '<div class="text-center small text-muted">Run the ETL pipeline first so the warehouse has data.</div>');
    }
  }

  App.register('olap', { init, show() { if (App.stale('olap')) load(); } });
})();
