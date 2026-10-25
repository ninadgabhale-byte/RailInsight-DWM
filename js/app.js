/* =====================================================================
   RailInsight – app.js
   Core: configuration, API client, UI helpers, page router.
   Every other file (dashboard.js, etl.js, olap.js …) builds on this one.
   ===================================================================== */
'use strict';

/* ------------------------------ config ------------------------------ */
const CONFIG = {
  // Flask backend address. Override before loading app.js with:
  //   <script>window.RAILINSIGHT_API_BASE = 'http://127.0.0.1:5001'</script>
  API_BASE: (window.RAILINSIGHT_API_BASE || 'http://127.0.0.1:5000').replace(/\/$/, ''),
  HEALTH_INTERVAL_MS: 15000,
  MAX_UPLOAD_MB: 200,
};

const OFFLINE_MSG =
  'Cannot reach the RailInsight backend at ' + CONFIG.API_BASE +
  '. Start it from the project folder with:  python backend/app.py';

/* ---------------------------- API client ---------------------------- */
class ApiError extends Error {
  constructor(message, { status = 0, offline = false, data = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.offline = offline;
    this.data = data;
  }
}

const Api = {
  url(path, params) {
    let url = CONFIG.API_BASE + path;
    if (params) {
      const qs = new URLSearchParams();
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') qs.append(k, v);
      });
      const s = qs.toString();
      if (s) url += (url.includes('?') ? '&' : '?') + s;
    }
    return url;
  },

  async request(method, path, { params, body } = {}) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(this.url(path, params), opts);
    } catch (e) {
      throw new ApiError(OFFLINE_MSG, { offline: true });
    }
    let data = null;
    if ((res.headers.get('content-type') || '').includes('application/json')) {
      data = await res.json().catch(() => null);
    }
    if (!res.ok) {
      throw new ApiError((data && (data.error || data.message)) || `Request failed (${res.status})`,
        { status: res.status, data });
    }
    return data;
  },

  get(path, params) { return this.request('GET', path, { params }); },
  post(path, body) { return this.request('POST', path, { body: body === undefined ? {} : body }); },

  /** multipart upload with progress callback (fraction 0..1) */
  upload(path, formData, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', this.url(path));
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch (_) { /* not json */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new ApiError((data && (data.error || data.message)) || `Upload failed (${xhr.status})`, { status: xhr.status, data }));
      };
      xhr.onerror = () => reject(new ApiError(OFFLINE_MSG, { offline: true }));
      xhr.send(formData);
    });
  },
};

/* ---------------------------- UI helpers ---------------------------- */
const UI = {
  _uid: 0,
  nf: new Intl.NumberFormat('en-IN'),
  nf2: new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }),

  el(x) { return typeof x === 'string' ? document.getElementById(x) : x; },

  esc(v) {
    return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  /** KPI / card number formatting. format: int | currency | percent | decimal | text */
  fmt(value, format) {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value !== 'number') return String(value);
    switch (format) {
      case 'int': return this.nf.format(Math.round(value));
      case 'currency': return '₹' + this.nf2.format(value);
      case 'percent': return value.toFixed(2) + '%';
      case 'decimal': return value.toFixed(3);
      default: return Number.isInteger(value) ? this.nf.format(value) : this.nf2.format(value);
    }
  },

  /** table-cell formatting: keeps IDs un-grouped, rounds floats */
  cell(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number' && !Number.isInteger(v)) return Math.round(v * 10000) / 10000;
    if (typeof v === 'object') return JSON.stringify(v);
    return v;
  },

  toast(message, type = 'info') {
    const host = document.getElementById('toasts');
    const color = { info: 'primary', success: 'success', danger: 'danger', warning: 'warning' }[type] || 'primary';
    const div = document.createElement('div');
    div.className = `toast align-items-center text-bg-${color} border-0`;
    div.setAttribute('role', 'alert');
    div.innerHTML = `<div class="d-flex"><div class="toast-body">${this.esc(message)}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button></div>`;
    host.appendChild(div);
    const t = new bootstrap.Toast(div, { delay: type === 'danger' ? 7000 : 3500 });
    div.addEventListener('hidden.bs.toast', () => div.remove());
    t.show();
  },

  empty(target, icon, title, message, actionHtml = '') {
    const el = this.el(target); if (!el) return;
    el.innerHTML = `<div class="state-box"><i class="fa-solid ${icon} big"></i><h6>${this.esc(title)}</h6>
      <div class="small">${this.esc(message)}</div>${actionHtml}</div>`;
  },

  loading(target, message = 'Loading…') {
    const el = this.el(target); if (!el) return;
    el.innerHTML = `<div class="spinner-wrap"><div class="spinner-border spinner-border-sm text-primary"></div><span>${this.esc(message)}</span></div>`;
  },

  /** Friendly error panel. 409/404 → usually "no dataset yet". */
  error(target, err, { showDatasetLink = true } = {}) {
    const el = this.el(target); if (!el) return;
    let icon = 'fa-triangle-exclamation', title = 'Something went wrong', action = '';
    if (err.offline) { icon = 'fa-plug-circle-xmark'; title = 'Backend not connected'; }
    else if (err.status === 409 || err.status === 404) {
      icon = 'fa-database'; title = 'Action required';
      if (showDatasetLink) action = '<div class="mt-3"><button class="btn btn-primary btn-sm" data-goto="dataset"><i class="fa-solid fa-upload me-1"></i>Go to Dataset Management</button></div>';
    }
    this.empty(el, icon, title, err.message || String(err), action);
  },

  alert(type, html, icon) {
    const ic = icon || { success: 'fa-circle-check', warning: 'fa-triangle-exclamation', danger: 'fa-circle-xmark', info: 'fa-circle-info', primary: 'fa-circle-info' }[type] || 'fa-circle-info';
    return `<div class="alert alert-${type} d-flex gap-2 py-2"><i class="fa-solid ${ic} mt-1"></i><div>${html}</div></div>`;
  },

  alerts(list, type = 'warning') {
    return (list || []).map((m) => this.alert(type, this.esc(m))).join('');
  },

  kpiCard(k, icon) {
    return `<div class="col-6 col-lg-4 col-xxl-3"><div class="card hoverable h-100"><div class="kpi">
      <div class="kpi-icon"><i class="fa-solid ${icon}"></i></div>
      <div><div class="kpi-label">${this.esc(k.label)}</div>
      <div class="kpi-value">${this.esc(this.fmt(k.value, k.format))}</div>
      ${k.hint ? `<div class="kpi-hint">${this.esc(k.hint)}</div>` : ''}</div></div></div></div>`;
  },

  badge(text, color = 'secondary') { return `<span class="badge text-bg-${color} badge-kind">${this.esc(text)}</span>`; },

  /* ---- form builders ---- */
  field(label, inner, help = '') {
    return `<div class="mb-3"><label class="form-label small fw-semibold mb-1">${label}</label>${inner}
      ${help ? `<div class="form-text">${help}</div>` : ''}</div>`;
  },

  select(name, options, selected, attrs = '') {
    const opts = options.map((o) => {
      const v = typeof o === 'object' ? o.value : o;
      const l = typeof o === 'object' ? (o.label !== undefined ? o.label : o.value) : o;
      return `<option value="${this.esc(v)}"${String(v) === String(selected) ? ' selected' : ''}>${this.esc(l)}</option>`;
    }).join('');
    return `<select class="form-select form-select-sm" name="${name}" ${attrs}>${opts}</select>`;
  },

  checks(name, options, checked = [], { toggle = true } = {}) {
    const set = new Set(checked.map(String));
    const items = options.map((o) => {
      const v = typeof o === 'object' ? o.value : o;
      const l = typeof o === 'object' ? (o.label !== undefined ? o.label : o.value) : o;
      const id = `ck${++this._uid}`;
      return `<div class="form-check"><input class="form-check-input" type="checkbox" name="${name}" value="${this.esc(v)}" id="${id}"${set.has(String(v)) ? ' checked' : ''}>
        <label class="form-check-label" for="${id}">${this.esc(l)}</label></div>`;
    }).join('') || '<div class="text-muted small">No columns available</div>';
    return `${toggle ? '<div class="small mb-1"><a href="#" data-checks-toggle="all">select all</a> · <a href="#" data-checks-toggle="none">none</a></div>' : ''}
      <div class="check-list">${items}</div>`;
  },

  range(name, min, max, step, value, formatFn) {
    const id = `rg${++this._uid}`;
    return `<div class="d-flex align-items-center gap-2"><input type="range" class="form-range flex-fill" name="${name}" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}" data-range-out="${id}-o">
      <span class="range-out" id="${id}-o">${formatFn ? formatFn(value) : value}</span></div>`;
  },

  /* ---- CSV / clipboard ---- */
  downloadCSV(filename, columns, rows) {
    const q = (v) => {
      if (v === null || v === undefined) return '';
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [columns.map(q).join(',')].concat(rows.map((r) => r.map(q).join(','))).join('\r\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename.endsWith('.csv') ? filename : filename + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },

  downloadText(filename, text, mime = 'text/plain') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: mime }));
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  },

  async copy(text) {
    try { await navigator.clipboard.writeText(text); this.toast('Copied to clipboard', 'success'); }
    catch (_) { this.toast('Copy failed – select the text manually', 'warning'); }
  },

  /**
   * Searchable, sortable, paginated table with CSV export.
   * opt: { columns:[], rows:[[]], title, pageSize, searchable, exportName, maxHeight, onRowClick(row, index) }
   */
  table(target, opt) {
    const el = this.el(target); if (!el) return;
    const o = Object.assign({ columns: [], rows: [], pageSize: 15, searchable: true, sortable: true }, opt);
    const { columns, rows } = o;
    if (!columns.length) { this.empty(el, 'fa-table', 'No data', 'There is nothing to display yet.'); return; }

    el.innerHTML = `${o.title ? `<div class="rt-title">${this.esc(o.title)}</div>` : ''}
      <div class="rt-bar">
        ${o.searchable ? `<div class="input-group input-group-sm rt-search"><span class="input-group-text"><i class="fa-solid fa-magnifying-glass"></i></span>
          <input type="search" class="form-control rt-q" placeholder="Search rows…"></div>` : '<span></span>'}
        <div class="rt-actions"><span class="rt-count small text-muted"></span>
          ${o.exportName ? '<button class="btn btn-sm btn-outline-secondary rt-export"><i class="fa-solid fa-file-csv me-1"></i>CSV</button>' : ''}</div>
      </div>
      <div class="rt-scroll" style="${o.maxHeight ? `max-height:${o.maxHeight}px;` : ''}">
        <table class="table table-sm table-hover align-middle rt-table"><thead></thead><tbody></tbody></table></div>
      <div class="rt-pager"></div>`;

    const thead = el.querySelector('thead'), tbody = el.querySelector('tbody');
    const pager = el.querySelector('.rt-pager'), count = el.querySelector('.rt-count');
    let sortCol = -1, sortDir = 1, page = 0, q = '';

    const compute = () => {
      let list = rows.map((r, i) => ({ r, i }));
      if (q) {
        const s = q.toLowerCase();
        list = list.filter((x) => x.r.some((v) => v !== null && v !== undefined && String(v).toLowerCase().includes(s)));
      }
      if (sortCol >= 0) {
        list.sort((a, b) => {
          const x = a.r[sortCol], y = b.r[sortCol];
          if (x === null || x === undefined) return 1;
          if (y === null || y === undefined) return -1;
          if (typeof x === 'number' && typeof y === 'number') return (x - y) * sortDir;
          return String(x).localeCompare(String(y), undefined, { numeric: true }) * sortDir;
        });
      }
      return list;
    };

    const draw = () => {
      const list = compute();
      const pages = Math.max(1, Math.ceil(list.length / o.pageSize));
      if (page >= pages) page = pages - 1;
      const slice = list.slice(page * o.pageSize, (page + 1) * o.pageSize);
      thead.innerHTML = '<tr>' + columns.map((c, i) =>
        `<th data-c="${i}">${this.esc(c)}${o.sortable ? `<span class="sort">${sortCol === i ? (sortDir > 0 ? '▲' : '▼') : '↕'}</span>` : ''}</th>`).join('') + '</tr>';
      tbody.innerHTML = slice.length ? slice.map((x) =>
        `<tr data-i="${x.i}"${o.onRowClick ? ' class="clickable"' : ''}>` + x.r.map((v) => {
          const c = this.cell(v);
          return c === null ? '<td class="null">null</td>' : `<td>${this.esc(c)}</td>`;
        }).join('') + '</tr>').join('')
        : `<tr><td colspan="${columns.length}" class="text-center text-muted py-4">No matching rows</td></tr>`;
      count.textContent = `${this.nf.format(list.length)} row${list.length === 1 ? '' : 's'}`;
      pager.innerHTML = pages > 1
        ? `<button class="btn btn-sm btn-outline-secondary" data-p="-1" ${page === 0 ? 'disabled' : ''}>‹ Prev</button>
           <span>Page ${page + 1} / ${pages}</span>
           <button class="btn btn-sm btn-outline-secondary" data-p="1" ${page >= pages - 1 ? 'disabled' : ''}>Next ›</button>` : '';
    };

    thead.addEventListener('click', (e) => {
      const th = e.target.closest('th'); if (!th || !o.sortable) return;
      const c = +th.dataset.c;
      if (sortCol === c) sortDir = -sortDir; else { sortCol = c; sortDir = 1; }
      draw();
    });
    pager.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-p]'); if (!b) return;
      page += +b.dataset.p; draw();
    });
    if (o.onRowClick) {
      tbody.addEventListener('click', (e) => {
        const tr = e.target.closest('tr[data-i]'); if (!tr) return;
        const i = +tr.dataset.i; o.onRowClick(rows[i], i);
      });
    }
    const qi = el.querySelector('.rt-q');
    if (qi) qi.addEventListener('input', () => { q = qi.value.trim(); page = 0; draw(); });
    const ex = el.querySelector('.rt-export');
    if (ex) ex.addEventListener('click', () => this.downloadCSV(o.exportName, columns, compute().map((x) => x.r)));
    draw();
  },
};

/* ------------------------- app / router state ----------------------- */
const App = {
  pages: {},
  current: null,
  state: { summary: null, summaryError: null, version: 0, loaded: {}, online: false, health: null },

  titles: {
    overview: 'Overview Dashboard', dataset: 'Dataset Management', preprocessing: 'Data Preprocessing',
    etl: 'ETL Pipeline', warehouse: 'Data Warehouse', olap: 'OLAP Analysis', mining: 'Data Mining',
    analytics: 'Railway Analytics', forecast: 'Prediction & Forecasting', reports: 'Reports & Export',
  },

  register(id, handlers) { this.pages[id] = handlers; },

  go(id, { push = true } = {}) {
    if (!this.pages[id]) id = 'overview';
    document.querySelectorAll('.page').forEach((s) => { s.hidden = s.id !== 'page-' + id; });
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === id));
    document.getElementById('crumb-title').textContent = this.titles[id] || id;
    this.current = id;
    if (push) history.replaceState(null, '', '#' + id);
    this.closeSidebar();
    window.scrollTo(0, 0);
    const h = this.pages[id];
    if (h) {
      if (!h._inited) { h._inited = true; if (h.init) h.init(); }
      if (h.show) h.show();
    }
  },

  /** pages reload their data only when the dataset/warehouse changed since last load */
  stale(key) { return this.state.loaded[key] !== this.state.version; },
  markLoaded(key) { this.state.loaded[key] = this.state.version; },
  bump() { this.state.version += 1; },

  async refreshSummary() {
    try {
      this.state.summary = await Api.get('/api/dataset/summary');
      this.state.summaryError = null;
    } catch (e) {
      this.state.summary = null;
      this.state.summaryError = e;
    }
    this.updateDatasetChip();
    return this.state.summary;
  },

  updateDatasetChip() {
    const chip = document.getElementById('dataset-chip');
    const s = this.state.summary;
    if (s) {
      chip.className = 'dataset-chip';
      chip.querySelector('span').textContent = `${s.file_name || 'dataset'} · ${UI.nf.format(s.rows)} rows`;
    } else {
      chip.className = 'dataset-chip none';
      chip.querySelector('span').textContent = 'No dataset';
    }
  },

  /** column names of a given kind: numerical | categorical | date | time | any */
  columnsOfKind(kind) {
    const s = this.state.summary;
    if (!s || !s.columns_info) return [];
    return s.columns_info.filter((c) => !kind || kind === 'any' || c.kind === kind).map((c) => c.column);
  },

  async checkHealth(first = false) {
    const badge = document.getElementById('backend-badge');
    const was = this.state.online;
    try {
      const h = await Api.get('/api/health');
      this.state.online = true; this.state.health = h;
      badge.className = 'status-badge online';
      badge.querySelector('span').textContent = 'API online · ' + (h.database_connected ? 'MySQL connected' : 'MySQL not connected');
    } catch (e) {
      this.state.online = false;
      badge.className = 'status-badge offline';
      badge.querySelector('span').textContent = 'Backend offline';
    }
    if (!was && this.state.online && !first) {           // backend just came back
      await this.refreshSummary();
      this.bump();
      const h = this.pages[this.current];
      if (h && h.show) h.show();
    }
  },

  openSidebar() { document.getElementById('sidebar').classList.add('open'); document.getElementById('sidebar-backdrop').classList.add('show'); },
  closeSidebar() { document.getElementById('sidebar').classList.remove('open'); document.getElementById('sidebar-backdrop').classList.remove('show'); },

  async boot() {
    Charts.init();

    // Dark / Light Theme Toggle
    const themeBtn = document.getElementById('theme-toggle');
    const applyTheme = (theme) => {
      document.documentElement.setAttribute('data-theme', theme);
      document.body.setAttribute('data-bs-theme', theme);
      if (themeBtn) {
        themeBtn.innerHTML = theme === 'dark' ? '<i class="fa-solid fa-sun text-warning"></i>' : '<i class="fa-solid fa-moon"></i>';
      }
      localStorage.setItem('railinsight-theme', theme);
    };
    const savedTheme = localStorage.getItem('railinsight-theme') || 'light';
    applyTheme(savedTheme);
    if (themeBtn) {
      themeBtn.addEventListener('click', () => {
        const cur = document.documentElement.getAttribute('data-theme') || 'light';
        applyTheme(cur === 'dark' ? 'light' : 'dark');
      });
    }

    document.getElementById('btn-menu').addEventListener('click', () => App.openSidebar());
    document.getElementById('sidebar-backdrop').addEventListener('click', () => App.closeSidebar());

    document.querySelectorAll('#nav a').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault(); App.go(a.dataset.page);
    }));

    // topbar module search: filters the sidebar, Enter jumps to first match
    const search = document.getElementById('module-search');
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('hidden-by-search', !!q && !a.textContent.toLowerCase().includes(q)));
    });
    search.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const first = [...document.querySelectorAll('#nav a')].find((a) => !a.classList.contains('hidden-by-search'));
      if (first) { App.go(first.dataset.page); search.value = ''; search.dispatchEvent(new Event('input')); }
    });

    // delegated helpers used by many pages
    document.addEventListener('click', (e) => {
      const g = e.target.closest('[data-goto]');
      if (g) { e.preventDefault(); App.go(g.dataset.goto); return; }
      const t = e.target.closest('[data-checks-toggle]');
      if (t) {
        e.preventDefault();
        const list = t.closest('div').nextElementSibling;
        if (list && list.classList.contains('check-list')) list.querySelectorAll('input[type=checkbox]').forEach((c) => { c.checked = t.dataset.checksToggle === 'all'; });
      }
    });
    document.addEventListener('input', (e) => {
      const r = e.target.closest('input[type=range][data-range-out]');
      if (r) { const out = document.getElementById(r.dataset.rangeOut); if (out) out.textContent = r.value; }
    });

    await this.checkHealth(true);
    if (this.state.online) await this.refreshSummary();
    setInterval(() => this.checkHealth(), CONFIG.HEALTH_INTERVAL_MS);

    const start = (location.hash || '#overview').slice(1);
    this.go(this.pages[start] ? start : 'overview', { push: false });
    window.addEventListener('hashchange', () => {
      const id = location.hash.slice(1);
      if (id && id !== App.current && App.pages[id]) App.go(id, { push: false });
    });
  },
};

document.addEventListener('DOMContentLoaded', () => App.boot());
