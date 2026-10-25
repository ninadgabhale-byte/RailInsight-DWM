/* =====================================================================
   RailInsight – etl.js  (ETL Pipeline)
   POST /api/etl/run     -> 202 {state:'running'}  (job runs in background)
   GET  /api/etl/status  -> {state, stages[], metrics{}, logs[], rejected{columns,rows}}
   GET  /api/etl/tables  -> {tables:[...]}          (MySQL source dropdown)
   POST /api/etl/upload-extra (multipart)           (additional CSV source)
   GET  /api/etl/rejected                           (download rejected CSV)
   ===================================================================== */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);

  // CSV Dataset → Extraction → Validation → Cleaning → Transformation → MySQL Data Warehouse
  const NODES = [
    { key: 'source', label: 'CSV Dataset', icon: 'fa-file-csv' },
    { key: 'extract', label: 'Extraction', icon: 'fa-file-arrow-down' },
    { key: 'validate', label: 'Validation', icon: 'fa-clipboard-check' },
    { key: 'clean', label: 'Cleaning', icon: 'fa-broom' },
    { key: 'transform', label: 'Transformation', icon: 'fa-gears' },
    { key: 'load', label: 'MySQL Data Warehouse', icon: 'fa-database' },
  ];
  const METRICS = [
    { key: 'extracted', label: 'Extracted rows', icon: 'fa-file-arrow-down' },
    { key: 'valid', label: 'Valid records', icon: 'fa-circle-check' },
    { key: 'rejected', label: 'Rejected records', icon: 'fa-ban' },
    { key: 'transformed', label: 'Transformed records', icon: 'fa-gears' },
    { key: 'loaded', label: 'Loaded records', icon: 'fa-database' },
    { key: 'skipped_existing', label: 'Skipped (already loaded)', icon: 'fa-forward' },
    { key: 'duration_sec', label: 'Duration (s)', icon: 'fa-stopwatch', format: 'decimal' },
    { key: 'state_label', label: 'Pipeline status', icon: 'fa-signal' },
  ];

  let timer = null;
  let extraUploaded = false;

  function init() {
    drawPipeline(null);
    drawMetrics(null);
    document.querySelectorAll('input[name="etl-source"]').forEach((r) => r.addEventListener('change', onSourceChange));
    $('etl-run').addEventListener('click', run);
    $('etl-extra-file').addEventListener('change', uploadExtra);
  }

  async function onSourceChange() {
    const v = document.querySelector('input[name="etl-source"]:checked').value;
    $('etl-mysql-table').disabled = v !== 'mysql';
    $('etl-extra-file').disabled = v !== 'extra';
    if (v === 'mysql' && $('etl-mysql-table').options.length <= 1) {
      try {
        const t = await Api.get('/api/etl/tables');
        (t.tables || []).forEach((n) => { const o = document.createElement('option'); o.value = n; o.textContent = n; $('etl-mysql-table').appendChild(o); });
        if (!(t.tables || []).length) UI.toast('No tables found in the MySQL database.', 'warning');
      } catch (e) { UI.toast(e.message, 'danger'); }
    }
  }

  async function uploadExtra() {
    const f = $('etl-extra-file').files[0]; if (!f) return;
    if (!/\.csv$/i.test(f.name)) { UI.toast('Only .csv files are accepted.', 'danger'); return; }
    const fd = new FormData(); fd.append('file', f);
    try {
      const r = await Api.upload('/api/etl/upload-extra', fd);
      extraUploaded = true;
      UI.toast(`Additional CSV ready: ${UI.nf.format(r.rows)} rows`, 'success');
    } catch (e) { extraUploaded = false; UI.toast(e.message, 'danger'); }
  }

  /* ------------------------------ drawing ----------------------------- */
  function statusOf(key, st) {
    if (!st) return { status: 'pending', msg: '' };
    const stages = st.stages || [];
    const find = (k) => stages.find((s) => s.key === k);
    if (key === 'source') { const e = find('extract'); return { status: e && e.status !== 'pending' ? 'success' : 'pending', msg: '' }; }
    const s = find(key);
    if (!s) return { status: 'pending', msg: '' };
    const dur = s.duration_ms ? ` · ${(s.duration_ms / 1000).toFixed(1)}s` : '';
    return { status: s.status, msg: (s.message || '') + dur };
  }

  function drawPipeline(st) {
    const icons = { running: 'fa-spinner fa-spin', success: 'fa-check', failed: 'fa-xmark' };
    $('etl-pipeline').innerHTML = NODES.map((n, i) => {
      const { status, msg } = statusOf(n.key, st);
      return `${i ? '<div class="pl-arrow"><i class="fa-solid fa-arrow-right"></i></div>' : ''}
        <div class="pl-node ${status}"><div class="ic"><i class="fa-solid ${icons[status] || n.icon}"></i></div>
        <div class="nm">${n.label}</div><div class="ms">${UI.esc(msg)}</div></div>`;
    }).join('');
  }

  function drawMetrics(st) {
    const m = (st && st.metrics) || {};
    const label = st ? ({ idle: 'Idle', running: 'Running…', success: 'Success', failed: 'Failed' }[st.state] || st.state) : 'Not run yet';
    $('etl-metrics').innerHTML = METRICS.map((k) => {
      const value = k.key === 'state_label' ? label : (st && m[k.key] !== undefined ? m[k.key] : null);
      return UI.kpiCard({ label: k.label, value, format: k.format || 'int' }, k.icon).replace('col-6 col-lg-4 col-xxl-3', 'col-6 col-md-3');
    }).join('');
  }

  function drawLogs(st) {
    const logs = (st && st.logs) || [];
    const box = $('etl-logs');
    if (!logs.length) { box.innerHTML = '<div class="text-muted small p-3">No ETL run yet.</div>'; return; }
    box.innerHTML = logs.map((l) => `<div class="${UI.esc(l.level)}">[${UI.esc(l.ts)}] ${UI.esc(l.level)} – ${UI.esc(l.message)}</div>`).join('');
    box.scrollTop = box.scrollHeight;
  }

  function drawRejected(st) {
    const r = st && st.rejected;
    const dl = $('etl-rejected-dl');
    if (!r || !r.rows || !r.rows.length) {
      $('etl-rejected').innerHTML = '<div class="text-muted small">No records were rejected.</div>'; dl.hidden = true; return;
    }
    dl.hidden = false; dl.href = Api.url('/api/etl/rejected');
    UI.table('etl-rejected', { columns: r.columns, rows: r.rows, pageSize: 6, searchable: false });
  }

  function render(st) {
    drawPipeline(st); drawMetrics(st); drawLogs(st); drawRejected(st);
  }

  /* ------------------------------- run -------------------------------- */
  async function run() {
    const source = document.querySelector('input[name="etl-source"]:checked').value;
    const mode = document.querySelector('input[name="etl-mode"]:checked').value;
    const body = { source, mode };
    if (source === 'mysql') {
      body.table = $('etl-mysql-table').value;
      if (!body.table) { UI.toast('Choose a MySQL table to extract from.', 'warning'); return; }
    }
    if (source === 'extra' && !extraUploaded) { UI.toast('Upload the additional CSV first.', 'warning'); return; }
    if (mode === 'full' && !confirm('Full reload will delete all rows in the warehouse tables before loading. Continue?')) return;

    const btn = $('etl-run');
    btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Running…';
    try {
      await Api.post('/api/etl/run', body);
      poll();
    } catch (e) {
      UI.toast(e.message, 'danger');
      resetButton();
    }
  }

  function resetButton() {
    const btn = $('etl-run');
    btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-play me-2"></i>Run ETL Pipeline';
  }

  function poll() {
    clearInterval(timer);
    const tick = async () => {
      try {
        const st = await Api.get('/api/etl/status');
        render(st);
        if (st.state !== 'running') {
          clearInterval(timer); resetButton();
          if (st.state === 'success') {
            UI.toast(`ETL finished: ${UI.nf.format((st.metrics || {}).loaded || 0)} rows loaded`, 'success');
            App.bump();                       // warehouse changed → OLAP / dashboards must refresh
            App.markLoaded('etl');
          } else if (st.state === 'failed') UI.toast('ETL failed – see the execution log.', 'danger');
        }
      } catch (e) { clearInterval(timer); resetButton(); UI.toast(e.message, 'danger'); }
    };
    tick();
    timer = setInterval(tick, 1000);
  }

  async function show() {
    try {
      const st = await Api.get('/api/etl/status');
      render(st);
      if (st.state === 'running') {
        const btn = $('etl-run'); btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Running…';
        poll();
      }
    } catch (e) { if (e.offline) UI.toast(e.message, 'danger'); }
  }

  App.register('etl', { init, show });
})();
