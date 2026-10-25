/* =====================================================================
   RailInsight – preprocessing.js
   One schema (OPS) describes every operation; a single generic renderer
   builds the form, validates it, calls the API and shows before/after.

   POST /api/preprocessing/run   { category, operation, params }
   POST /api/preprocessing/integrate/analyze   (multipart: file)
   GET  /api/preprocessing/compare             POST /api/preprocessing/reset
   ===================================================================== */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  const TABS = [
    { id: 'cleaning', label: 'Data Cleaning', icon: 'fa-broom' },
    { id: 'integration', label: 'Data Integration', icon: 'fa-code-merge' },
    { id: 'transformation', label: 'Data Transformation', icon: 'fa-wand-magic-sparkles' },
    { id: 'reduction', label: 'Data Reduction', icon: 'fa-compress' },
    { id: 'discretization', label: 'Discretization', icon: 'fa-bars-staggered' },
  ];

  /* field types: column | columns | select | number | text | checkbox | checks */
  const OPS = {
    cleaning: [
      { id: 'detect_missing', label: 'Detect missing values', desc: 'Counts missing cells per column (nothing is changed).', fields: [] },
      { id: 'impute', label: 'Impute missing values', desc: 'Mean/median work on numerical columns; mode works on any column.',
        fields: [{ name: 'columns', type: 'columns', kind: 'any', label: 'Columns', required: true },
                 { name: 'method', type: 'select', label: 'Method', options: ['mean', 'median', 'mode'], default: 'median' }] },
      { id: 'remove_duplicates', label: 'Remove duplicate rows', desc: 'Leave the subset empty to compare entire rows.',
        fields: [{ name: 'subset', type: 'columns', kind: 'any', label: 'Compare only these columns (optional)' },
                 { name: 'keep', type: 'select', label: 'Keep', options: ['first', 'last'], default: 'first' }] },
      { id: 'fix_dtypes', label: 'Correct data type', desc: 'Convert a column to a proper numeric, datetime, category or string type.',
        fields: [{ name: 'column', type: 'column', kind: 'any', label: 'Column', required: true },
                 { name: 'target_type', type: 'select', label: 'Convert to', options: ['numeric', 'datetime', 'category', 'string'], default: 'numeric' },
                 { name: 'date_format', type: 'text', label: 'Date format (optional)', placeholder: '%m/%d/%Y' }] },
      { id: 'standardize_values', label: 'Standardize inconsistent values', desc: 'Trim spaces and unify letter case so “cst ” and “CST” become one value.',
        fields: [{ name: 'columns', type: 'columns', kind: 'categorical', label: 'Text columns', required: true },
                 { name: 'case', type: 'select', label: 'Letter case', options: ['none', 'lower', 'upper', 'title'], default: 'title' },
                 { name: 'trim', type: 'checkbox', label: 'Trim & collapse spaces', default: true }] },
      { id: 'invalid_dates', label: 'Detect invalid dates', desc: 'Finds values that cannot be parsed as dates, or lie outside a sensible range.',
        fields: [{ name: 'column', type: 'column', kind: 'date', label: 'Date column', required: true },
                 { name: 'date_format', type: 'text', label: 'Date format (optional)', placeholder: '%m/%d/%Y' },
                 { name: 'action', type: 'select', label: 'Action', options: ['flag', 'drop'], default: 'flag' }] },
      { id: 'outliers', label: 'Detect / treat outliers', desc: 'IQR rule (threshold = multiplier, usually 1.5) or Z-score rule (threshold = cut-off, usually 3).',
        fields: [{ name: 'column', type: 'column', kind: 'numerical', label: 'Numerical column', required: true },
                 { name: 'method', type: 'select', label: 'Method', options: ['iqr', 'zscore'], default: 'iqr' },
                 { name: 'threshold', type: 'number', label: 'Threshold', default: 1.5, step: 0.1, min: 0.1 },
                 { name: 'action', type: 'select', label: 'Action', options: ['flag', 'remove', 'cap'], default: 'flag' }] },
    ],
    transformation: [
      { id: 'minmax', label: 'Min-Max normalization', desc: 'Rescales values into a fixed range: (x − min) / (max − min).',
        fields: [{ name: 'columns', type: 'columns', kind: 'numerical', label: 'Numerical columns', required: true },
                 { name: 'new_min', type: 'number', label: 'New minimum', default: 0 }, { name: 'new_max', type: 'number', label: 'New maximum', default: 1 }] },
      { id: 'zscore', label: 'Z-score standardization', desc: 'Centres at mean 0 with standard deviation 1: (x − mean) / std.',
        fields: [{ name: 'columns', type: 'columns', kind: 'numerical', label: 'Numerical columns', required: true }] },
      { id: 'robust_scale', label: 'Robust scaling', desc: 'Uses median and IQR, so outliers have little influence.',
        fields: [{ name: 'columns', type: 'columns', kind: 'numerical', label: 'Numerical columns', required: true }] },
      { id: 'label_encode', label: 'Label encoding', desc: 'Replaces each category with an integer code.',
        fields: [{ name: 'columns', type: 'columns', kind: 'categorical', label: 'Categorical columns', required: true }] },
      { id: 'one_hot', label: 'One-hot encoding', desc: 'Creates one 0/1 column per category.',
        fields: [{ name: 'columns', type: 'columns', kind: 'categorical', label: 'Categorical columns', required: true },
                 { name: 'drop_first', type: 'checkbox', label: 'Drop first category (avoid redundancy)', default: false },
                 { name: 'max_categories', type: 'number', label: 'Skip columns with more categories than', default: 30, min: 2 }] },
      { id: 'date_features', label: 'Date feature extraction', desc: 'Derives year, month, quarter, weekday … from a date column.',
        fields: [{ name: 'column', type: 'column', kind: 'date', label: 'Date column', required: true },
                 { name: 'features', type: 'checks', label: 'Features', options: ['year', 'month', 'quarter', 'day', 'weekday', 'week_of_year', 'is_weekend'], default: ['year', 'month', 'quarter', 'weekday'] }] },
      { id: 'aggregate', label: 'Categorical aggregation', desc: 'Groups rows by categories and aggregates a numerical column.',
        fields: [{ name: 'group_by', type: 'columns', kind: 'categorical', label: 'Group by', required: true },
                 { name: 'value', type: 'column', kind: 'numerical', label: 'Value column', required: true },
                 { name: 'func', type: 'select', label: 'Function', options: ['sum', 'mean', 'count', 'min', 'max', 'median'], default: 'sum' }] },
    ],
    reduction: [
      { id: 'feature_selection', label: 'Feature selection', desc: 'Ranks features by variance, correlation with a target, or mutual information.',
        fields: [{ name: 'method', type: 'select', label: 'Method', options: ['variance', 'correlation', 'mutual_info'], default: 'variance' },
                 { name: 'target', type: 'column', kind: 'any', label: 'Target column (needed for correlation / mutual info)', optional: true },
                 { name: 'k', type: 'number', label: 'Features to keep', default: 5, min: 1 }] },
      { id: 'sampling', label: 'Sampling', desc: 'Reduces the number of rows while keeping the data representative.',
        fields: [{ name: 'method', type: 'select', label: 'Method', options: ['random', 'stratified', 'systematic'], default: 'random' },
                 { name: 'fraction', type: 'number', label: 'Fraction of rows', default: 0.1, min: 0.001, max: 1, step: 0.01 },
                 { name: 'stratify_by', type: 'column', kind: 'categorical', label: 'Stratify by (stratified only)', optional: true },
                 { name: 'seed', type: 'number', label: 'Random seed', default: 42 }] },
      { id: 'pca', label: 'Principal Component Analysis (PCA)', desc: 'Projects numerical columns onto fewer uncorrelated components.',
        fields: [{ name: 'columns', type: 'columns', kind: 'numerical', label: 'Numerical columns', required: true },
                 { name: 'n_components', type: 'number', label: 'Components', default: 2, min: 1 },
                 { name: 'standardize', type: 'checkbox', label: 'Standardize first (recommended)', default: true }] },
    ],
    discretization: [
      { id: 'equal_width', label: 'Equal-width binning', desc: 'Splits the value range into bins of identical width.',
        fields: [{ name: 'column', type: 'column', kind: 'numerical', label: 'Numerical column', required: true },
                 { name: 'bins', type: 'number', label: 'Number of bins', default: 5, min: 2 }] },
      { id: 'equal_frequency', label: 'Equal-frequency binning', desc: 'Each bin holds (roughly) the same number of rows (quantile bins).',
        fields: [{ name: 'column', type: 'column', kind: 'numerical', label: 'Numerical column', required: true },
                 { name: 'bins', type: 'number', label: 'Number of bins', default: 5, min: 2 }] },
      { id: 'custom_bins', label: 'Custom bins', desc: 'You choose the bin edges, e.g. 0,15,30,60,120.',
        fields: [{ name: 'column', type: 'column', kind: 'numerical', label: 'Numerical column', required: true },
                 { name: 'edges', type: 'text', label: 'Bin edges (comma separated)', placeholder: '0,15,30,60,120', required: true },
                 { name: 'labels', type: 'text', label: 'Bin labels (optional, comma separated)' }] },
    ],
  };

  const selectedOp = {};
  let integration = null;           // result of /integrate/analyze

  /* ------------------------------ skeleton ---------------------------- */
  function init() {
    $('pp-root').innerHTML = `
      <div class="card">
        <div class="card-header p-0 border-0"><ul class="nav nav-tabs card-tabs">
          ${TABS.map((t, i) => `<li class="nav-item"><button class="nav-link${i ? '' : ' active'}" data-bs-toggle="tab" data-bs-target="#pp-pane-${t.id}">
            <i class="fa-solid ${t.icon} me-1"></i>${t.label}</button></li>`).join('')}
        </ul></div>
        <div class="card-body tab-content">
          ${TABS.map((t, i) => `<div class="tab-pane fade${i ? '' : ' show active'}" id="pp-pane-${t.id}">
            <div class="row g-3">
              <div class="col-xl-4"><div class="pp-controls" id="pp-ctl-${t.id}"></div></div>
              <div class="col-xl-8"><div id="pp-out-${t.id}"><div class="state-box"><i class="fa-solid fa-flask big"></i>
                <h6>No operation run yet</h6><div class="small">Choose an operation, set its options and press Run.</div></div></div></div>
            </div></div>`).join('')}
        </div>
      </div>`;

    $('pp-download').addEventListener('click', () => { location.href = Api.url('/api/dataset/download', { stage: 'processed' }); });
    $('pp-reset').addEventListener('click', resetAll);
    $('pp-root').addEventListener('change', (e) => {
      const sel = e.target.closest('.pp-op');
      if (sel) { selectedOp[sel.dataset.cat] = sel.value; renderControls(sel.dataset.cat); }
    });
    $('pp-root').addEventListener('click', (e) => {
      const run = e.target.closest('.pp-run');
      if (run) runOperation(run.dataset.cat);
    });
  }

  /* ------------------------------ controls ---------------------------- */
  function fieldHTML(f) {
    const cols = f.kind ? App.columnsOfKind(f.kind) : [];
    let inner = '';
    switch (f.type) {
      case 'column':
        inner = UI.select(f.name, (f.required ? [] : [{ value: '', label: '— none —' }]).concat(cols)); break;
      case 'columns': inner = UI.checks(f.name, cols); break;
      case 'select': inner = UI.select(f.name, f.options, f.default); break;
      case 'number':
        inner = `<input type="number" class="form-control form-control-sm" name="${f.name}" value="${f.default ?? ''}"
          ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''} step="${f.step || 'any'}">`; break;
      case 'text':
        inner = `<input type="text" class="form-control form-control-sm" name="${f.name}" placeholder="${UI.esc(f.placeholder || '')}">`; break;
      case 'checkbox':
        return `<div class="form-check mb-3"><input class="form-check-input" type="checkbox" name="${f.name}" id="pp-${f.name}-${++UI._uid}"${f.default ? ' checked' : ''}>
          <label class="form-check-label small" for="pp-${f.name}-${UI._uid}">${UI.esc(f.label)}</label></div>`;
      case 'checks': inner = UI.checks(f.name, f.options, f.default || [], { toggle: false }); break;
      default: inner = '';
    }
    return UI.field(UI.esc(f.label) + (f.required ? ' <span class="text-danger">*</span>' : ''), inner);
  }

  function renderControls(cat) {
    const box = $('pp-ctl-' + cat);
    if (cat === 'integration') { renderIntegrationControls(box); return; }
    const ops = OPS[cat];
    const cur = ops.find((o) => o.id === selectedOp[cat]) || ops[0];
    selectedOp[cat] = cur.id;
    box.innerHTML = `<div class="card"><div class="card-body">
      <label class="form-label small fw-semibold">Operation</label>
      <select class="form-select form-select-sm pp-op mb-2" data-cat="${cat}">
        ${ops.map((o) => `<option value="${o.id}"${o.id === cur.id ? ' selected' : ''}>${UI.esc(o.label)}</option>`).join('')}</select>
      <p class="small text-muted">${UI.esc(cur.desc)}</p>
      <form class="pp-form" data-cat="${cat}" onsubmit="return false">${cur.fields.map(fieldHTML).join('')}</form>
      <button class="btn btn-primary w-100 pp-run" data-cat="${cat}"><i class="fa-solid fa-play me-2"></i>Run</button>
    </div></div>`;
  }

  function collect(form, fields) {
    const p = {};
    for (const f of fields) {
      const q = (sel) => form.querySelector(sel);
      if (f.type === 'columns' || f.type === 'checks') {
        p[f.name] = [...form.querySelectorAll(`input[name="${f.name}"]:checked`)].map((i) => i.value);
        if (f.required && !p[f.name].length) throw new Error(`Select at least one option for “${f.label}”.`);
      } else if (f.type === 'checkbox') {
        p[f.name] = q(`[name="${f.name}"]`).checked;
      } else {
        const v = q(`[name="${f.name}"]`).value.trim();
        if (f.required && v === '') throw new Error(`“${f.label}” is required.`);
        p[f.name] = v === '' ? null : (f.type === 'number' ? Number(v) : v);
      }
    }
    return p;
  }

  /* ------------------------------- run -------------------------------- */
  async function runOperation(cat, direct) {
    const out = $('pp-out-' + cat);
    let operation, params;
    if (direct) { ({ operation, params } = direct); }
    else {
      const op = OPS[cat].find((o) => o.id === selectedOp[cat]);
      try { params = collect(document.querySelector(`#pp-ctl-${cat} .pp-form`), op.fields); }
      catch (e) { UI.toast(e.message, 'warning'); return; }
      operation = op.id;
    }
    UI.loading(out, 'Running on the full dataset… this can take a few seconds for large files.');
    try {
      const res = await Api.post('/api/preprocessing/run', { category: cat, operation, params });
      renderResult(out, cat, res);
      if (res.changed !== false && operation !== 'detect_missing') {   // dataset changed → refresh dependants
        if (cat === 'integration') integration = null;
        App.bump();
        await App.refreshSummary();
        App.markLoaded('preprocessing');
        TABS.forEach((t) => { if (t.id !== 'integration') renderControls(t.id); });
        loadCompare();
      }
    } catch (e) { UI.error(out, e); }
  }

  function renderResult(out, cat, res) {
    const id = 'pp-r-' + cat;
    out.innerHTML = `
      ${res.message ? UI.alert('success', UI.esc(res.message)) : ''}
      ${UI.alerts(res.warnings)}
      ${res.stats ? `<div class="stat-pills">${Object.entries(res.stats).map(([k, v]) =>
        `<span class="stat-pill"><b>${UI.esc(k)}</b>${UI.esc(UI.fmt(v))}</span>`).join('')}</div>` : ''}
      <div class="row g-3">
        ${res.before ? `<div class="col-12 col-xxl-6"><div id="${id}-b"></div></div>` : ''}
        ${res.after ? `<div class="col-12 col-xxl-${res.before ? 6 : 12}"><div id="${id}-a"></div></div>` : ''}
      </div>
      <div class="row g-3 mt-1" id="${id}-c"></div>`;
    if (res.before) UI.table(`${id}-b`, { columns: res.before.columns, rows: res.before.rows, title: res.before.title || 'Before', pageSize: 8, searchable: false, exportName: `${cat}_before` });
    if (res.after) UI.table(`${id}-a`, { columns: res.after.columns, rows: res.after.rows, title: res.after.title || 'After', pageSize: 8, searchable: false, exportName: `${cat}_after` });
    if (res.charts && res.charts.length) Charts.renderGrid(`${id}-c`, res.charts);
  }

  /* ---------------------------- integration --------------------------- */
  function renderIntegrationControls(box) {
    if (!integration) {
      box.innerHTML = `<div class="card"><div class="card-body">
        <p class="small text-muted">Combine another compatible CSV with the current dataset. Column names that differ can be matched in the next step.</p>
        ${UI.field('Second CSV file', '<input type="file" accept=".csv" class="form-control form-control-sm" id="pp-int-file">')}
        <button class="btn btn-primary w-100" id="pp-int-analyze"><i class="fa-solid fa-magnifying-glass-chart me-2"></i>Analyse file</button>
      </div></div>`;
      $('pp-int-analyze').addEventListener('click', analyzeIntegration);
      return;
    }
    const rows = Object.keys(integration.suggested_mapping).map((inc) => {
      const cur = integration.suggested_mapping[inc];
      const opts = [{ value: '__new__', label: '(keep as new column)' }, { value: '__ignore__', label: '(ignore)' }]
        .concat(integration.existing_columns.map((c) => ({ value: c, label: '→ ' + c })));
      return `<tr><td class="small">${UI.esc(inc)}</td><td>${UI.select('map', opts, cur || '__new__', `data-incoming="${UI.esc(inc)}"`)}</td></tr>`;
    }).join('');
    box.innerHTML = `<div class="card"><div class="card-body">
      <div class="small mb-2"><b>${UI.esc(integration.filename)}</b> · ${UI.nf.format(integration.rows)} rows · ${integration.columns.length} columns</div>
      <div class="table-responsive" style="max-height:260px"><table class="table table-sm"><thead><tr><th>Incoming column</th><th>Match to</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="form-check my-3"><input class="form-check-input" type="checkbox" id="pp-int-dedupe" checked>
        <label class="form-check-label small" for="pp-int-dedupe">Remove duplicate records across both files</label></div>
      <button class="btn btn-primary w-100 mb-2" id="pp-int-run"><i class="fa-solid fa-code-merge me-2"></i>Integrate datasets</button>
      <button class="btn btn-sm btn-outline-secondary w-100" id="pp-int-cancel">Choose another file</button>
    </div></div>`;
    $('pp-int-cancel').addEventListener('click', () => { integration = null; renderIntegrationControls(box); });
    $('pp-int-run').addEventListener('click', () => {
      const mapping = {};
      box.querySelectorAll('select[data-incoming]').forEach((s) => { mapping[s.dataset.incoming] = s.value; });
      runOperation('integration', { operation: 'combine', params: { mapping, drop_duplicates: $('pp-int-dedupe').checked } });
    });
  }

  async function analyzeIntegration() {
    const f = $('pp-int-file').files[0];
    if (!f) { UI.toast('Choose a CSV file first.', 'warning'); return; }
    if (!/\.csv$/i.test(f.name)) { UI.toast('Only .csv files are accepted.', 'danger'); return; }
    const fd = new FormData(); fd.append('file', f);
    const btn = $('pp-int-analyze'); btn.disabled = true;
    try {
      integration = await Api.upload('/api/preprocessing/integrate/analyze', fd);
      renderIntegrationControls($('pp-ctl-integration'));
    } catch (e) { UI.toast(e.message, 'danger'); btn.disabled = false; }
  }

  /* ------------------------- compare / reset / history ---------------- */
  async function loadCompare() {
    const box = $('pp-compare');
    UI.loading(box);
    try {
      const c = await Api.get('/api/preprocessing/compare');
      const row = (k, a, b) => `<tr><td>${k}</td><td>${UI.esc(UI.fmt(a))}</td><td>${UI.esc(UI.fmt(b))}</td></tr>`;
      box.innerHTML = `<div class="row g-3"><div class="col-lg-6">
        <table class="table table-sm table-bordered"><thead class="table-light"><tr><th></th><th>Raw</th><th>Processed</th></tr></thead><tbody>
          ${row('Rows', c.raw.rows, c.processed.rows)}${row('Columns', c.raw.columns, c.processed.columns)}
          ${row('Missing cells', c.raw.missing_cells, c.processed.missing_cells)}${row('Duplicate rows', c.raw.duplicates, c.processed.duplicates)}
        </tbody></table>
        ${(c.columns_added || []).length ? `<div class="small"><b>Columns added:</b> ${UI.esc(c.columns_added.join(', '))}</div>` : ''}
        ${(c.columns_removed || []).length ? `<div class="small"><b>Columns removed:</b> ${UI.esc(c.columns_removed.join(', '))}</div>` : ''}</div>
        <div class="col-lg-6"><h6 class="mb-2">Operations applied</h6>
        ${(c.history || []).length ? `<ol class="small mb-0">${c.history.map((h) => `<li>${UI.esc(h)}</li>`).join('')}</ol>` : '<div class="text-muted small">No operations applied – processed data equals raw data.</div>'}</div></div>`;
    } catch (e) { UI.error(box, e, { showDatasetLink: false }); }
  }

  async function resetAll() {
    if (!confirm('Discard all preprocessing steps and go back to the original uploaded data?')) return;
    try {
      await Api.post('/api/preprocessing/reset', {});
      UI.toast('Dataset reset to the original upload.', 'success');
      App.bump(); await App.refreshSummary(); App.markLoaded('preprocessing');
      TABS.forEach((t) => renderControls(t.id));
      loadCompare();
    } catch (e) { UI.toast(e.message, 'danger'); }
  }

  /* ------------------------------- page ------------------------------- */
  async function show() {
    if (!App.stale('preprocessing') && App.state.summary) return;
    const st = $('pp-state');
    if (!App.state.summary) await App.refreshSummary();
    if (!App.state.summary) {
      UI.error(st, App.state.summaryError || new ApiError('No dataset loaded.', { status: 409 }));
      $('pp-root').hidden = true; return;
    }
    st.innerHTML = ''; $('pp-root').hidden = false;
    TABS.forEach((t) => renderControls(t.id));
    loadCompare();
    App.markLoaded('preprocessing');
  }

  App.register('preprocessing', { init, show });
})();
