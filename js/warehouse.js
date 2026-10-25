/* =====================================================================
   RailInsight – warehouse.js  (Data Warehouse)
   GET  /api/warehouse/schema
        -> { grain, tables:[{name, kind:'fact'|'dimension', rows, columns:[{name,type,key,references}]}],
             ddl, indexes:[{table,columns,reason,ddl}], sample_queries:[{id,title,sql,explanation}] }
   POST /api/warehouse/sample/run  { id }  -> { columns, rows }
   The star diagram is DRAWN FROM THE SCHEMA THE BACKEND RETURNS, so it
   always matches the real MySQL tables (only applicable dimensions appear).
   ===================================================================== */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  let schema = null;

  function init() {
    $('wh-ddl-copy').addEventListener('click', () => schema && UI.copy(schema.ddl));
    $('wh-ddl-dl').addEventListener('click', () => schema && UI.downloadText('schema.sql', schema.ddl, 'text/sql'));
    $('wh-svg-dl').addEventListener('click', () => {
      const svg = $('wh-diagram').querySelector('svg');
      if (svg) UI.downloadText('star_schema.svg', new XMLSerializer().serializeToString(svg), 'image/svg+xml');
    });
    $('wh-queries-out').addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-run]'); if (!b) return;
      const out = $('wh-q-out-' + b.dataset.run);
      UI.loading(out, 'Running query…');
      try {
        const r = await Api.post('/api/warehouse/sample/run', { id: b.dataset.run });
        UI.table(out, { columns: r.columns, rows: r.rows, pageSize: 8, searchable: false, exportName: 'query_' + b.dataset.run });
      } catch (err) { UI.error(out, err, { showDatasetLink: false }); }
    });
  }

  /* --------------------------- star diagram --------------------------- */
  function buildStarSVG(sc) {
    const fact = sc.tables.find((t) => t.kind === 'fact');
    const dims = sc.tables.filter((t) => t !== fact);
    if (!fact) return '<div class="state-box">No fact table found in schema.</div>';

    const BW = 236, HH = 30, RH = 19;
    const height = (t) => HH + RH * t.columns.length + 10;
    const maxH = Math.max(...sc.tables.map(height));
    const W = 1260, ry = Math.max(300, maxH / 2 + 190), rx = 480;
    const H = Math.round(2 * ry + maxH + 60), cx = W / 2, cy = H / 2;

    const pos = {};
    pos[fact.name] = { x: cx, y: cy, w: BW + 20, h: height(fact), t: fact };
    dims.forEach((d, i) => {
      const a = (-90 + (360 * i) / dims.length) * Math.PI / 180;
      pos[d.name] = { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a), w: BW, h: height(d), t: d };
    });

    // connectors: one line per foreign key (role-playing FKs get parallel lines)
    const perDim = {};
    let lines = '', labels = '';
    fact.columns.forEach((c) => {
      if (!c.references) return;
      const target = c.references.split('.')[0];
      if (!pos[target]) return;
      const n = (perDim[target] = (perDim[target] || 0) + 1) - 1;
      const a = pos[fact.name], b = pos[target];
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      const off = (n - 0.5 * ((fact.columns.filter((x) => x.references && x.references.startsWith(target + '.')).length) - 1)) * 18;
      const ox = (-dy / len) * off, oy = (dx / len) * off;
      lines += `<line x1="${a.x + ox}" y1="${a.y + oy}" x2="${b.x + ox}" y2="${b.y + oy}" stroke="#7b93b8" stroke-width="1.6"/>`;
      const mx = a.x + dx * 0.62 + ox, my = a.y + dy * 0.62 + oy;
      labels += `<g><rect x="${mx - 4 - c.name.length * 3.3}" y="${my - 9}" width="${c.name.length * 6.6 + 8}" height="16" rx="4" fill="#fff" stroke="#c9d6ea"/>
        <text x="${mx}" y="${my + 3}" font-size="10" text-anchor="middle" fill="#46618c">${UI.esc(c.name)}</text></g>`;
    });

    const keyColor = { PK: '#d97706', FK: '#2f7df6' };
    const box = (p) => {
      const t = p.t, isFact = t.kind === 'fact';
      const x = p.x - p.w / 2, y = p.y - p.h / 2;
      let s = `<g><rect x="${x}" y="${y}" width="${p.w}" height="${p.h}" rx="10" fill="#fff" stroke="${isFact ? '#2f7df6' : '#16345f'}" stroke-width="2"/>
        <path d="M${x} ${y + 10} a10 10 0 0 1 10 -10 h${p.w - 20} a10 10 0 0 1 10 10 v${HH - 10} h-${p.w} z" fill="${isFact ? '#2f7df6' : '#16345f'}"/>
        <text x="${p.x}" y="${y + 20}" font-size="13" font-weight="700" fill="#fff" text-anchor="middle">${UI.esc(t.name)}</text>`;
      t.columns.forEach((c, i) => {
        const ry2 = y + HH + 4 + i * RH + 13;
        const nm = c.name.length > 24 ? c.name.slice(0, 23) + '…' : c.name;
        s += `<text x="${x + 10}" y="${ry2}" font-size="11" font-weight="700" fill="${keyColor[c.key] || 'transparent'}">${c.key || ''}</text>
          <text x="${x + 36}" y="${ry2}" font-size="11.5" fill="#1e293b">${UI.esc(nm)}</text>
          <text x="${x + p.w - 10}" y="${ry2}" font-size="10" fill="#94a3b8" text-anchor="end">${UI.esc((c.type || '').toLowerCase())}</text>`;
      });
      return s + '</g>';
    };

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Star schema diagram">
      <rect width="${W}" height="${H}" fill="#fbfdff"/>${lines}${labels}${Object.values(pos).map(box).join('')}</svg>`;
  }

  /* ------------------------------ tabs -------------------------------- */
  function renderTables(sc) {
    UI.table('wh-tables-out', {
      columns: ['Table', 'Kind', 'Rows in MySQL', 'Columns', 'Primary key', 'Foreign keys'],
      rows: sc.tables.map((t) => [
        t.name, t.kind, t.rows === null || t.rows === undefined ? 'not created yet' : t.rows, t.columns.length,
        t.columns.filter((c) => c.key === 'PK').map((c) => c.name).join(', ') || '—',
        t.columns.filter((c) => c.key === 'FK').map((c) => c.name).join(', ') || '—']),
      searchable: false, pageSize: 20, exportName: 'warehouse_tables',
    });
  }

  function renderQueries(sc) {
    const host = $('wh-queries-out');
    if (!(sc.sample_queries || []).length) { host.innerHTML = '<div class="text-muted">No sample queries provided.</div>'; return; }
    host.innerHTML = sc.sample_queries.map((q, i) => `
      <div class="accordion-item"><h2 class="accordion-header"><button class="accordion-button${i ? ' collapsed' : ''}" type="button" data-bs-toggle="collapse" data-bs-target="#wh-q-${i}">
        ${UI.esc(q.title)}</button></h2>
        <div id="wh-q-${i}" class="accordion-collapse collapse${i ? '' : ' show'}" data-bs-parent="#wh-queries-out"><div class="accordion-body">
          <pre class="code-block mb-2"><code>${UI.esc(q.sql)}</code></pre>
          <div class="viva-note mb-2">${UI.esc(q.explanation || '')}</div>
          <button class="btn btn-sm btn-primary mb-2" data-run="${UI.esc(q.id)}"><i class="fa-solid fa-play me-1"></i>Run on warehouse</button>
          <div id="wh-q-out-${UI.esc(q.id)}"></div>
        </div></div></div>`).join('');
  }

  function renderIndexes(sc) {
    if (!(sc.indexes || []).length) { $('wh-index-out').innerHTML = '<div class="text-muted">No indexing recommendations provided.</div>'; return; }
    UI.table('wh-index-out', {
      columns: ['Table', 'Indexed column(s)', 'Why', 'SQL'],
      rows: sc.indexes.map((x) => [x.table, x.columns, x.reason, x.ddl]),
      searchable: false, pageSize: 20, exportName: 'index_recommendations',
    });
  }

  async function load() {
    const st = $('wh-state');
    UI.loading(st, 'Reading warehouse schema…');
    $('wh-body').hidden = true;
    try {
      schema = await Api.get('/api/warehouse/schema');
      st.innerHTML = '';
      $('wh-body').hidden = false;
      $('wh-grain').innerHTML = `<b>Fact-table grain:</b> ${UI.esc(schema.grain || 'not defined')}`;
      $('wh-diagram').innerHTML = buildStarSVG(schema);
      $('wh-ddl-code').textContent = schema.ddl || '-- DDL not provided by backend';
      renderTables(schema); renderQueries(schema); renderIndexes(schema);
      App.markLoaded('warehouse');
    } catch (e) { UI.error(st, e); }
  }

  App.register('warehouse', { init, show() { if (App.stale('warehouse')) load(); } });
})();
