/* =====================================================================
   RailInsight – dataset.js  (Dataset Management)
   POST /api/upload                GET /api/dataset/summary
   GET  /api/dataset/preview       GET/POST /api/dataset/mapping
   POST /api/dataset/validate      GET /api/dataset/download?stage=raw|processed
   ===================================================================== */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const KIND_COLOR = { numerical: 'primary', categorical: 'info', date: 'warning', time: 'warning' };
  let previewN = 15;

  function init() {
    const dz = $('dropzone'), inp = $('file-input');
    dz.addEventListener('click', () => inp.click());
    dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inp.click(); } });
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); }));
    dz.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });
    inp.addEventListener('change', () => { if (inp.files[0]) handleFile(inp.files[0]); inp.value = ''; });

    $('preview-rows').addEventListener('change', (e) => { previewN = +e.target.value; loadPreview(); });
    $('btn-download-raw').addEventListener('click', () => { location.href = Api.url('/api/dataset/download', { stage: 'raw' }); });
    $('btn-download-processed').addEventListener('click', () => { location.href = Api.url('/api/dataset/download', { stage: 'processed' }); });
    $('btn-save-mapping').addEventListener('click', saveMapping);
    $('btn-validate').addEventListener('click', validate);
  }

  /* ------------------------------ upload ------------------------------ */
  async function handleFile(file) {
    if (!/\.csv$/i.test(file.name)) { UI.toast('Only .csv files are accepted.', 'danger'); return; }
    if (file.size > CONFIG.MAX_UPLOAD_MB * 1024 * 1024) { UI.toast(`File is larger than ${CONFIG.MAX_UPLOAD_MB} MB.`, 'danger'); return; }
    if (file.size === 0) { UI.toast('The selected file is empty.', 'danger'); return; }

    const box = $('upload-progress'), bar = $('upload-bar');
    box.hidden = false; bar.style.width = '0%'; bar.classList.add('progress-bar-striped', 'progress-bar-animated');
    $('upload-label').textContent = `Uploading ${file.name} (${(file.size / 1048576).toFixed(1)} MB)…`;
    $('upload-pct').textContent = '0%';

    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await Api.upload('/api/upload', fd, (f) => {
        const p = Math.round(f * 100);
        bar.style.width = p + '%'; $('upload-pct').textContent = p + '%';
        if (p >= 100) $('upload-label').textContent = 'Upload complete – analysing dataset…';
      });
      UI.toast(`Loaded ${res.filename || file.name}: ${UI.nf.format(res.rows)} rows × ${res.columns} columns`, 'success');
      App.bump();
      await load(true);
    } catch (e) {
      UI.toast(e.message, 'danger');
    } finally {
      bar.classList.remove('progress-bar-striped', 'progress-bar-animated');
      setTimeout(() => { box.hidden = true; }, 1500);
    }
  }

  /* ------------------------------ render ------------------------------ */
  async function load(force) {
    if (!force && !App.stale('dataset')) return;
    const state = $('ds-state');
    UI.loading(state, 'Reading dataset summary…');
    const s = await App.refreshSummary();
    if (!s) {
      $('ds-cards').innerHTML = ''; $('ds-tabs-card').hidden = true;
      const err = App.state.summaryError;
      if (err && !err.offline && (err.status === 409 || err.status === 404)) {
        UI.empty(state, 'fa-file-circle-plus', 'No dataset loaded yet', 'Upload your railway CSV above to begin.');
      } else UI.error(state, err || new ApiError('Unknown error'), { showDatasetLink: false });
      return;
    }
    state.innerHTML = '';
    $('ds-tabs-card').hidden = false;
    renderCards(s); renderColumns(s); renderStats(s); renderMissing(s);
    loadPreview(); loadMapping();
    App.markLoaded('dataset');
  }

  function renderCards(s) {
    const count = (k) => (s.columns_info || []).filter((c) => c.kind === k).length;
    const items = [
      { label: 'Rows', value: s.rows, format: 'int', icon: 'fa-table-list' },
      { label: 'Columns', value: s.columns, format: 'int', icon: 'fa-table-columns' },
      { label: 'Duplicate rows', value: s.duplicates, format: 'int', icon: 'fa-clone', hint: s.rows ? ((s.duplicates / s.rows) * 100).toFixed(3) + '% of rows' : '' },
      { label: 'Missing cells', value: s.missing_cells, format: 'int', icon: 'fa-circle-question' },
      { label: 'Numerical / Categorical', value: `${count('numerical')} / ${count('categorical')}`, icon: 'fa-shapes' },
      { label: 'Date / Time columns', value: `${count('date')} / ${count('time')}`, icon: 'fa-calendar' },
      { label: 'Memory', value: s.memory_mb !== undefined ? s.memory_mb.toFixed(1) + ' MB' : '—', icon: 'fa-memory' },
      { label: 'File', value: s.file_name || '—', icon: 'fa-file-csv' },
    ];
    $('ds-cards').innerHTML = items.map((k) => UI.kpiCard(k, k.icon)).join('');
  }

  function renderColumns(s) {
    UI.table('ds-columns-table', {
      columns: ['Column', 'Data type', 'Detected kind', 'Missing', 'Missing %', 'Unique values', 'Suggested railway role'],
      rows: (s.columns_info || []).map((c) => [c.column, c.dtype, c.kind, c.missing, c.missing_pct, c.unique, c.suggested_role || '—']),
      exportName: 'column_info', pageSize: 25,
    });
  }

  function renderStats(s) {
    if (!s.describe) { UI.empty('ds-stats-table', 'fa-calculator', 'No statistics', 'The backend did not return descriptive statistics.'); return; }
    UI.table('ds-stats-table', { columns: s.describe.columns, rows: s.describe.rows, exportName: 'descriptive_statistics', pageSize: 25, title: 'Descriptive statistics (numerical columns)' });
  }

  function renderMissing(s) {
    const ci = (s.columns_info || []);
    Charts.fromSpec('ds-missing-chart', {
      type: 'bar', labels: ci.map((c) => c.column), label: 'Missing values', values: ci.map((c) => c.missing),
      x_label: 'Column', y_label: 'Missing cells',
    });
    const pct = s.rows ? (s.duplicates / s.rows) * 100 : 0;
    $('ds-dup-info').innerHTML = `
      <div class="card"><div class="card-body">
        <h6>Duplicate-record detection</h6>
        <p class="mb-1"><b>${UI.nf.format(s.duplicates)}</b> exact duplicate rows (${pct.toFixed(3)}%).</p>
        ${(s.notes || []).map((n) => UI.alert('warning', UI.esc(n))).join('')}
        <p class="small text-muted mb-0">Use <b>Data Preprocessing → Cleaning</b> to remove duplicates or impute missing values.</p>
      </div></div>`;
  }

  async function loadPreview() {
    const box = $('ds-preview-table');
    UI.loading(box);
    try {
      const p = await Api.get('/api/dataset/preview', { n: previewN });
      UI.table(box, { columns: p.columns, rows: p.rows, searchable: true, pageSize: previewN, exportName: 'dataset_preview' });
    } catch (e) { UI.error(box, e, { showDatasetLink: false }); }
  }

  /* ---------------------------- column mapping ------------------------ */
  async function loadMapping() {
    const grid = $('ds-mapping-grid');
    UI.loading(grid);
    try {
      const m = await Api.get('/api/dataset/mapping');
      grid.innerHTML = m.roles.map((r) => {
        const opts = ['<option value="">— not mapped —</option>'].concat(m.columns.map((c) =>
          `<option value="${UI.esc(c)}"${r.mapped === c ? ' selected' : ''}>${UI.esc(c)}</option>`)).join('');
        return `<div class="col-md-6 col-xl-4"><label class="form-label small fw-semibold mb-1">${UI.esc(r.label)}
          ${r.required ? '<span class="badge text-bg-danger ms-1">required</span>' : '<span class="badge text-bg-light text-muted ms-1">optional</span>'}</label>
          <select class="form-select form-select-sm" data-role="${UI.esc(r.key)}">${opts}</select>
          ${r.description ? `<div class="form-text">${UI.esc(r.description)}</div>` : ''}</div>`;
      }).join('');
    } catch (e) { UI.error(grid, e, { showDatasetLink: false }); }
  }

  async function saveMapping() {
    const mapping = {};
    document.querySelectorAll('#ds-mapping-grid select[data-role]').forEach((s) => { if (s.value) mapping[s.dataset.role] = s.value; });
    const used = Object.values(mapping);
    const dup = used.find((c, i) => used.indexOf(c) !== i);
    if (dup) { UI.toast(`Column "${dup}" is mapped to more than one role.`, 'warning'); return; }
    try {
      await Api.post('/api/dataset/mapping', { mapping });
      UI.toast('Column mapping saved', 'success');
      App.bump();
    } catch (e) { UI.toast(e.message, 'danger'); }
  }

  /* ----------------------------- validation --------------------------- */
  async function validate() {
    const out = $('ds-validation-out');
    UI.loading(out, 'Validating dataset…');
    try {
      const v = await Api.post('/api/dataset/validate', {});
      const icon = { pass: ['fa-circle-check', 'success'], warn: ['fa-triangle-exclamation', 'warning'], fail: ['fa-circle-xmark', 'danger'] };
      const checks = (v.checks || []).map((c) => {
        const [ic, col] = icon[c.status] || icon.warn;
        return `<li class="list-group-item d-flex gap-2"><i class="fa-solid ${ic} text-${col} mt-1"></i>
          <div><b>${UI.esc(c.name)}</b><div class="small text-muted">${UI.esc(c.message)}</div></div></li>`;
      }).join('');
      out.innerHTML = `${UI.alert(v.valid ? 'success' : 'danger', v.valid ? 'Dataset passed validation and is ready for processing.' : 'Dataset has blocking problems – fix them before running ETL.')}
        <ul class="list-group mb-3">${checks}</ul>
        <h6>Which features can this dataset support?</h6><div id="ds-features"></div>`;
      UI.table('ds-features', {
        columns: ['Feature', 'Status', 'Needs these railway fields'],
        rows: (v.available_features || []).map((f) => [f.feature, f.available ? 'Available' : 'Unavailable', (f.requires || []).join(', ') || '—']),
        searchable: false, pageSize: 20, exportName: 'feature_availability',
      });
    } catch (e) { UI.error(out, e, { showDatasetLink: false }); }
  }

  App.register('dataset', { init, show() { load(false); } });
})();
