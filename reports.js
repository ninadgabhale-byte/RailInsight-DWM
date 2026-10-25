/* =====================================================================
   RailInsight – reports.js  (Reports & Export)
   GET /api/reports/list    -> { reports:[{key,title,description,available,reason}] }
   GET /api/reports/preview?type=<key>
        -> { title, sections:[{heading, text?, bullets?[], table?{columns,rows}}] }
   GET /api/reports/export?type=<key>&format=csv|excel|pdf   (file download)
   Reports are built by the backend from results that were really computed;
   if a module has not been run yet the backend answers 409 with a message.
   ===================================================================== */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const ICONS = { dataset: 'fa-database', preprocessing: 'fa-broom', etl: 'fa-arrows-spin', warehouse: 'fa-warehouse', olap: 'fa-cube',
    classification: 'fa-sitemap', clustering: 'fa-circle-nodes', association: 'fa-link', analytics: 'fa-chart-line', forecasting: 'fa-chart-area' };

  function init() {
    $('rp-grid').addEventListener('click', async (e) => {
      const p = e.target.closest('[data-preview]');
      if (p) { preview(p.dataset.preview, p.dataset.title); return; }
      const d = e.target.closest('[data-export]');
      if (d) download(d.dataset.export, d.dataset.fmt);
    });
  }

  /** Fetch as a blob so a "run this module first" error shows as a toast, not a broken page. */
  async function download(type, fmt) {
    try {
      const res = await fetch(Api.url('/api/reports/export', { type, format: fmt }));
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        UI.toast(j.error || `Export failed (${res.status})`, 'warning'); return;
      }
      const m = /filename="?([^";]+)"?/.exec(res.headers.get('Content-Disposition') || '');
      const name = m ? m[1] : `${type}_report.${fmt === 'excel' ? 'xlsx' : fmt}`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await res.blob()); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) { UI.toast(OFFLINE_MSG, 'danger'); }
  }

  async function preview(type, title) {
    const modalEl = $('reportModal'), body = $('reportModalBody');
    $('reportModalTitle').textContent = title;
    UI.loading(body, 'Building report from computed results…');
    bootstrap.Modal.getOrCreateInstance(modalEl).show();
    try {
      const r = await Api.get('/api/reports/preview', { type });
      body.innerHTML = r.sections.map((s, i) => `<h5 class="mt-${i ? 4 : 0}">${UI.esc(s.heading)}</h5>
        ${s.text ? `<p>${UI.esc(s.text)}</p>` : ''}
        ${s.bullets ? `<ul>${s.bullets.map((b) => `<li>${UI.esc(b)}</li>`).join('')}</ul>` : ''}
        ${s.table ? `<div id="rp-t-${i}"></div>` : ''}`).join('');
      r.sections.forEach((s, i) => { if (s.table) UI.table(`rp-t-${i}`, { columns: s.table.columns, rows: s.table.rows, pageSize: 8, searchable: false, exportName: `${type}_${i}` }); });
    } catch (e) { UI.error(body, e, { showDatasetLink: false }); }
  }

  async function load() {
    const st = $('rp-state'), grid = $('rp-grid');
    UI.loading(st, 'Loading available reports…'); grid.innerHTML = '';
    try {
      const r = await Api.get('/api/reports/list');
      st.innerHTML = '';
      grid.innerHTML = r.reports.map((x) => `<div class="col-md-6 col-xl-4"><div class="card h-100 hoverable"><div class="card-body d-flex flex-column">
        <div class="d-flex align-items-center gap-2 mb-2"><span class="kpi-icon" style="width:38px;height:38px;font-size:1rem"><i class="fa-solid ${ICONS[x.key] || 'fa-file-lines'}"></i></span><h6 class="mb-0">${UI.esc(x.title)}</h6></div>
        <p class="small text-muted flex-fill">${UI.esc(x.description || '')}</p>
        ${x.available ? `<div class="d-flex flex-wrap gap-1">
          <button class="btn btn-sm btn-outline-primary" data-preview="${UI.esc(x.key)}" data-title="${UI.esc(x.title)}"><i class="fa-solid fa-eye me-1"></i>Preview</button>
          <button class="btn btn-sm btn-outline-secondary" data-export="${UI.esc(x.key)}" data-fmt="csv">CSV</button>
          <button class="btn btn-sm btn-outline-secondary" data-export="${UI.esc(x.key)}" data-fmt="excel">Excel</button>
          <button class="btn btn-sm btn-outline-secondary" data-export="${UI.esc(x.key)}" data-fmt="pdf">PDF</button></div>`
          : `<div class="small text-warning"><i class="fa-solid fa-circle-info me-1"></i>${UI.esc(x.reason || 'Not available yet.')}</div>`}
      </div></div></div>`).join('');
      App.markLoaded('reports');
    } catch (e) { UI.error(st, e); }
  }

  App.register('reports', { init, show() { load(); } });
})();
