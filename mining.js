/* =====================================================================
   RailInsight – mining.js  (Data Mining)
   GET  /api/mining/options
   POST /api/mining/classification | clustering | association | anomaly
   GET  /api/mining/patterns
   All results are computed by scikit-learn / mlxtend in the backend.
   The backend tells us which targets/features are valid (e.g. it removes
   leakage columns), so this file never assumes dataset columns.
   ===================================================================== */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  let opts = null;
  const ran = { asc: false };

  const val = (root, name) => { const e = root.querySelector(`[name="${name}"]`); return e ? e.value : ''; };
  const checked = (root, name) => [...root.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);
  const num = (root, name) => Number(val(root, name));
  const warn = (list) => UI.alerts(list, 'warning');

  async function runPost(path, body, out, render) {
    UI.loading(out, 'Training / running on the dataset… large data can take up to a minute.');
    try { render(out, await Api.post(path, body)); }
    catch (e) { UI.error(out, e); }
  }

  /* =============================== CLASSIFICATION =============================== */
  const ALGOS = [
    ['decision_tree', 'Decision Tree'], ['random_forest', 'Random Forest'], ['logistic_regression', 'Logistic Regression'],
    ['knn', 'K-Nearest Neighbors'], ['naive_bayes', 'Naive Bayes'],
  ];

  function clsForm() {
    const c = opts.classification, f = $('mn-cls-form');
    if (!c.targets.length) { UI.empty(f, 'fa-ban', 'No valid target column', (c.note || 'The dataset has no column that can be used as a classification target.')); return; }
    f.innerHTML = `<form onsubmit="return false">
      ${UI.field('Target column', UI.select('target', c.targets.map((t) => ({ value: t.column, label: t.label || t.column }))))}
      <div id="cls-note" class="small mb-3"></div>
      ${UI.field('Features', '<div id="cls-features"></div>')}
      ${UI.field('Algorithms', UI.checks('algorithms', ALGOS.map(([v, l]) => ({ value: v, label: l })), ALGOS.map((a) => a[0]), { toggle: false }))}
      ${UI.field('Test size', UI.range('test_size', 0.1, 0.5, 0.05, 0.2))}
      ${UI.field('Rows to use (sample)', '<input class="form-control form-control-sm" type="number" name="sample_size" value="100000" min="1000" step="1000">', 'Sampling keeps training fast on large data; the split is done AFTER sampling.')}
      ${UI.field('Random seed', '<input class="form-control form-control-sm" type="number" name="random_state" value="42">')}
      <button class="btn btn-primary w-100" id="cls-run"><i class="fa-solid fa-play me-2"></i>Train &amp; evaluate</button></form>`;
    const sync = () => {
      const t = c.targets.find((x) => x.column === val(f, 'target'));
      const excl = new Set(t.excluded_features || []);
      $('cls-features').innerHTML = UI.checks('features', c.features.filter((x) => !excl.has(x.column) && x.column !== t.column).map((x) => x.column), c.features.filter((x) => !excl.has(x.column) && x.column !== t.column).map((x) => x.column));
      $('cls-note').innerHTML = t.note ? UI.alert('info', UI.esc(t.note)) : '';
    };
    f.querySelector('[name=target]').addEventListener('change', sync); sync();
    $('cls-run').addEventListener('click', () => {
      const algorithms = checked(f, 'algorithms'), features = checked(f, 'features');
      if (!algorithms.length || !features.length) { UI.toast('Select at least one algorithm and one feature.', 'warning'); return; }
      runPost('/api/mining/classification', { target: val(f, 'target'), features, algorithms, test_size: num(f, 'test_size'), sample_size: num(f, 'sample_size'), random_state: num(f, 'random_state') }, $('mn-cls-out'), renderCls);
    });
  }

  function renderCls(out, r) {
    const b = r.baseline || {};
    out.innerHTML = `${warn(r.warnings)}
      <div class="row g-3 mb-3">
        ${UI.kpiCard({ label: 'Training rows', value: r.split.train, format: 'int' }, 'fa-dumbbell')}
        ${UI.kpiCard({ label: 'Test rows', value: r.split.test, format: 'int' }, 'fa-vial')}
        ${UI.kpiCard({ label: 'Classes', value: (r.classes || []).length, format: 'int', hint: (r.classes || []).slice(0, 4).join(', ') }, 'fa-tags')}
        ${UI.kpiCard({ label: 'Majority-class baseline', value: b.majority_accuracy * 100, format: 'percent', hint: 'accuracy of always guessing the most common class' }, 'fa-scale-balanced')}
      </div>
      <div class="viva-note mb-3">A model is only useful if it clearly beats the <b>baseline</b>. If accuracy ≈ baseline, the chosen features carry little information about the target.</div>
      <div class="card mb-3"><div class="card-header">Model comparison (weighted averages on the test set)</div><div class="card-body">
        <div id="cls-table"></div><div class="chart-box mt-3"><canvas id="cls-chart"></canvas></div></div></div>
      <div class="accordion" id="cls-acc"></div>`;
    UI.table('cls-table', { columns: ['Algorithm', 'Accuracy', 'Precision', 'Recall', 'F1-score', 'Train time (s)'], searchable: false, pageSize: 10, exportName: 'classification_results',
      rows: r.results.map((m) => [m.algorithm, m.accuracy, m.precision, m.recall, m.f1, m.train_seconds]) });
    Charts.fromSpec('cls-chart', { type: 'bar', labels: r.results.map((m) => m.algorithm),
      datasets: [['Accuracy', 'accuracy'], ['Precision', 'precision'], ['Recall', 'recall'], ['F1-score', 'f1']].map(([l, k]) => ({ label: l, data: r.results.map((m) => m[k]) })), y_label: 'Score (0–1)' });
    $('cls-acc').innerHTML = r.results.map((m, i) => `<div class="accordion-item"><h2 class="accordion-header"><button class="accordion-button collapsed" data-bs-toggle="collapse" data-bs-target="#cls-d${i}">
      ${UI.esc(m.algorithm)} – confusion matrix &amp; classification report</button></h2>
      <div id="cls-d${i}" class="accordion-collapse collapse" data-bs-parent="#cls-acc"><div class="accordion-body"><div class="row g-3">
        <div class="col-lg-6"><h6>Confusion matrix</h6><div id="cls-cm${i}"></div></div>
        <div class="col-lg-6"><div id="cls-rep${i}"></div></div>
        ${m.feature_importance ? `<div class="col-12"><div class="chart-box"><canvas id="cls-fi${i}"></canvas></div></div>` : ''}
      </div></div></div></div>`).join('');
    r.results.forEach((m, i) => {
      Charts.heatmap(`cls-cm${i}`, { corner: 'Actual ↓ / Predicted →', row_labels: m.confusion.labels, col_labels: m.confusion.labels, matrix: m.confusion.matrix });
      UI.table(`cls-rep${i}`, { columns: ['Class', 'Precision', 'Recall', 'F1', 'Support'], rows: m.report.map((x) => [x.label, x.precision, x.recall, x.f1, x.support]), searchable: false, pageSize: 12, title: 'Classification report' });
      if (m.feature_importance) Charts.fromSpec(`cls-fi${i}`, { type: 'hbar', labels: m.feature_importance.map((x) => x.feature), values: m.feature_importance.map((x) => x.importance), label: 'Importance' });
    });
  }

  /* ================================ CLUSTERING ================================== */
  function cluForm() {
    const c = opts.clustering, f = $('mn-clu-form');
    const ents = c.entities.filter((e) => e.supported);
    if (!ents.length) { UI.empty(f, 'fa-ban', 'Clustering unavailable', 'The mapped columns do not provide a unit to cluster.'); return; }
    f.innerHTML = `<form onsubmit="return false">
      ${UI.field('What to cluster', UI.select('entity', ents.map((e) => ({ value: e.key, label: e.label }))), '<span id="clu-desc"></span>')}
      ${UI.field('Algorithm', UI.select('algorithm', [{ value: 'kmeans', label: 'K-Means' }, { value: 'hierarchical', label: 'Hierarchical (agglomerative)' }, { value: 'dbscan', label: 'DBSCAN' }]))}
      <div data-for="kmeans hierarchical">${UI.field('Number of clusters (k)', '<input class="form-control form-control-sm" type="number" name="k" value="3" min="2" max="12">')}</div>
      <div data-for="kmeans">${UI.field('Elbow / silhouette range', '<div class="d-flex gap-2"><input class="form-control form-control-sm" type="number" name="k_min" value="2" min="2"><input class="form-control form-control-sm" type="number" name="k_max" value="8" min="3" max="15"></div>')}</div>
      <div data-for="hierarchical">${UI.field('Linkage', UI.select('linkage', ['ward', 'average', 'complete', 'single']))}</div>
      <div data-for="dbscan">${UI.field('eps (neighbourhood radius)', '<input class="form-control form-control-sm" type="number" step="0.05" name="eps" value="0.5" min="0.01">')}
        ${UI.field('min_samples', '<input class="form-control form-control-sm" type="number" name="min_samples" value="5" min="2">')}</div>
      ${UI.field('Max rows used', '<input class="form-control form-control-sm" type="number" name="sample_size" value="5000" min="200" step="500">', 'Hierarchical clustering is O(n²) – keep this small.')}
      <button class="btn btn-primary w-100" id="clu-run"><i class="fa-solid fa-play me-2"></i>Run clustering</button></form>`;
    const sync = () => {
      const a = val(f, 'algorithm');
      f.querySelectorAll('[data-for]').forEach((d) => { d.hidden = !d.dataset.for.split(' ').includes(a); });
      const e = ents.find((x) => x.key === val(f, 'entity'));
      $('clu-desc').textContent = e ? e.description || '' : '';
    };
    f.querySelector('[name=algorithm]').addEventListener('change', sync); f.querySelector('[name=entity]').addEventListener('change', sync); sync();
    $('clu-run').addEventListener('click', () => runPost('/api/mining/clustering', {
      entity: val(f, 'entity'), algorithm: val(f, 'algorithm'), k: num(f, 'k'), k_min: num(f, 'k_min'), k_max: num(f, 'k_max'),
      linkage: val(f, 'linkage'), eps: num(f, 'eps'), min_samples: num(f, 'min_samples'), sample_size: num(f, 'sample_size') }, $('mn-clu-out'), renderClu));
  }

  function renderClu(out, r) {
    out.innerHTML = `${warn(r.warnings)}
      <div class="row g-3 mb-3">
        ${UI.kpiCard({ label: 'Clusters found', value: r.n_clusters, format: 'int' }, 'fa-circle-nodes')}
        ${UI.kpiCard({ label: 'Silhouette score', value: r.silhouette, format: 'decimal', hint: '−1 … 1, higher is better' }, 'fa-bullseye')}
        ${UI.kpiCard({ label: 'Items clustered', value: r.n_items, format: 'int' }, 'fa-database')}
        ${r.noise !== undefined ? UI.kpiCard({ label: 'Noise points', value: r.noise, format: 'int' }, 'fa-ghost') : ''}
      </div>
      <div class="row g-3 mb-3">
        ${r.elbow ? '<div class="col-12 col-xl-6"><div class="card"><div class="card-header">Elbow method &amp; silhouette</div><div class="card-body"><div class="chart-box"><canvas id="clu-elbow"></canvas></div></div></div></div>' : ''}
        <div class="col-12 ${r.elbow ? 'col-xl-6' : ''}"><div class="card"><div class="card-header">Cluster plot (${UI.esc((r.scatter.axes || []).join(' vs '))})</div><div class="card-body"><div class="chart-box"><canvas id="clu-scatter"></canvas></div></div></div></div>
      </div>
      ${(r.interpretation || []).length ? `<div class="card mb-3"><div class="card-header">Cluster interpretation</div><div class="card-body"><ul class="mb-0">${r.interpretation.map((t) => `<li>${UI.esc(t)}</li>`).join('')}</ul></div></div>` : ''}
      <div class="card mb-3"><div class="card-body"><div id="clu-summary"></div></div></div>
      <div class="card"><div class="card-body"><div id="clu-assign"></div></div></div>`;
    if (r.elbow) Charts.fromSpec('clu-elbow', { type: 'line', labels: r.elbow.k.map(String), x_label: 'k',
      datasets: [{ label: 'Inertia (WCSS)', data: r.elbow.inertia, yAxisID: 'y' }, { label: 'Silhouette', data: r.elbow.silhouette, yAxisID: 'y1', borderColor: '#f5a524' }] });
    if (r.elbow) { const ch = Charts.registry['clu-elbow']; ch.options.scales.y1 = { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'Silhouette' } }; ch.update(); }
    Charts.fromSpec('clu-scatter', { type: 'scatter', datasets: r.scatter.groups.map((g) => ({ label: g.label, data: g.points })), x_label: (r.scatter.axes || [])[0], y_label: (r.scatter.axes || [])[1] });
    UI.table('clu-summary', { columns: r.summary.columns, rows: r.summary.rows, title: 'Cluster profiles (average of each feature)', searchable: false, pageSize: 12, exportName: 'cluster_profiles' });
    UI.table('clu-assign', { columns: r.assignments.columns, rows: r.assignments.rows, title: 'Cluster assignments', exportName: 'cluster_assignments', pageSize: 10 });
  }

  /* ============================ ASSOCIATION RULES ============================== */
  function ascForm() {
    const a = opts.association, f = $('mn-asc-form');
    if (!a.transaction_columns.length) { UI.empty(f, 'fa-ban', 'Association rules unavailable', 'No categorical columns are available to build itemsets.'); return; }
    f.innerHTML = `<form onsubmit="return false">
      <div class="alert alert-info py-2 small mb-3">${UI.esc(a.note || 'Each record becomes one itemset made of the chosen attributes (e.g. ticket=Single, payment=UPI).')}</div>
      ${UI.field('Algorithm', UI.select('algorithm', [{ value: 'fpgrowth', label: 'FP-Growth' }, { value: 'apriori', label: 'Apriori' }, { value: 'both', label: 'Both (compare runtime)' }]))}
      ${UI.field('Attributes in each itemset', UI.checks('columns', a.transaction_columns, a.transaction_columns.slice(0, 5)))}
      ${UI.field('Minimum support', UI.range('min_support', 0.001, 0.5, 0.001, 0.05))}
      ${UI.field('Minimum confidence', UI.range('min_confidence', 0.05, 1, 0.01, 0.5))}
      ${UI.field('Minimum lift', '<input class="form-control form-control-sm" type="number" step="0.05" name="min_lift" value="1.0" min="0">')}
      ${UI.field('Max itemset length', UI.select('max_len', [2, 3, 4], 3))}
      <button class="btn btn-primary w-100" id="asc-run"><i class="fa-solid fa-play me-2"></i>Mine rules</button></form>`;
    const go = () => {
      const cols = checked(f, 'columns');
      if (cols.length < 2) { UI.toast('Select at least two attributes.', 'warning'); return; }
      ran.asc = true;
      runPost('/api/mining/association', { algorithm: val(f, 'algorithm'), columns: cols, min_support: num(f, 'min_support'), min_confidence: num(f, 'min_confidence'), min_lift: num(f, 'min_lift'), max_len: num(f, 'max_len') }, $('mn-asc-out'), renderAsc);
    };
    $('asc-run').addEventListener('click', go);
    // sliders re-run automatically once a first result exists
    f.querySelectorAll('input[type=range]').forEach((s) => s.addEventListener('change', () => { if (ran.asc) go(); }));
  }

  function renderAsc(out, r) {
    const rt = r.runtimes || {};
    out.innerHTML = `${warn(r.warnings)}
      <div class="row g-3 mb-3">
        ${UI.kpiCard({ label: 'Transactions (itemsets)', value: r.transactions, format: 'int' }, 'fa-basket-shopping')}
        ${UI.kpiCard({ label: 'Frequent itemsets', value: r.itemsets.rows.length, format: 'int' }, 'fa-layer-group')}
        ${UI.kpiCard({ label: 'Rules', value: r.rules.rows.length, format: 'int' }, 'fa-link')}
        ${UI.kpiCard({ label: 'Runtime', value: Object.entries(rt).map(([k, v]) => `${k} ${v}s`).join(' · '), hint: 'seconds' }, 'fa-stopwatch')}
      </div>
      <div class="viva-note mb-3"><b>Support</b> = how often the itemset occurs · <b>Confidence</b> = P(consequent | antecedent) · <b>Lift</b> &gt; 1 means the items occur together more than by chance; lift ≈ 1 means no real association.</div>
      <div class="card mb-3"><div class="card-header">Support vs confidence (each dot = one rule)</div><div class="card-body"><div class="chart-box"><canvas id="asc-scatter"></canvas></div></div></div>
      <div class="card mb-3"><div class="card-body"><div id="asc-rules"></div></div></div>
      <div class="card"><div class="card-body"><div id="asc-items"></div></div></div>`;
    UI.table('asc-rules', { columns: r.rules.columns, rows: r.rules.rows, title: 'Association rules', exportName: 'association_rules', pageSize: 10 });
    UI.table('asc-items', { columns: r.itemsets.columns, rows: r.itemsets.rows, title: 'Frequent itemsets', exportName: 'frequent_itemsets', pageSize: 10 });
    const si = r.rules.columns.indexOf('support'), ci = r.rules.columns.indexOf('confidence');
    if (si >= 0 && ci >= 0 && r.rules.rows.length) {
      Charts.fromSpec('asc-scatter', { type: 'scatter', x_label: 'Support', y_label: 'Confidence', datasets: [{ label: 'Rules', data: r.rules.rows.map((x) => ({ x: x[si], y: x[ci] })) }] });
    } else Charts.destroy('asc-scatter');
  }

  /* ============================ ANOMALY DETECTION ============================== */
  function anoForm() {
    const a = opts.anomaly, f = $('mn-ano-form');
    const units = a.units.filter((u) => u.supported);
    if (!units.length) { UI.empty(f, 'fa-ban', 'Anomaly detection unavailable', (a.units[0] && a.units[0].reason) || 'No suitable numerical columns.'); return; }
    f.innerHTML = `<form onsubmit="return false">
      ${UI.field('What to inspect', UI.select('unit', units.map((u) => ({ value: u.key, label: u.label }))))}
      <div id="ano-unit-note" class="small mb-3 text-muted"></div>
      ${UI.field('Method', UI.select('method', [{ value: 'both', label: 'Isolation Forest + IQR' }, { value: 'isolation_forest', label: 'Isolation Forest' }, { value: 'iqr', label: 'IQR rule' }]))}
      ${UI.field('Expected contamination (Isolation Forest)', UI.range('contamination', 0.001, 0.1, 0.001, 0.01))}
      ${UI.field('IQR multiplier', '<input class="form-control form-control-sm" type="number" step="0.1" name="iqr_k" value="1.5" min="0.5">')}
      <button class="btn btn-primary w-100" id="ano-run"><i class="fa-solid fa-play me-2"></i>Detect anomalies</button></form>`;
    const sync = () => { const u = units.find((x) => x.key === val(f, 'unit')); $('ano-unit-note').textContent = u.description || ''; };
    f.querySelector('[name=unit]').addEventListener('change', sync); sync();
    $('ano-run').addEventListener('click', () => runPost('/api/mining/anomaly', { unit: val(f, 'unit'), method: val(f, 'method'), contamination: num(f, 'contamination'), iqr_k: num(f, 'iqr_k') }, $('mn-ano-out'), renderAno));
  }

  function renderAno(out, r) {
    out.innerHTML = `${warn(r.warnings)}
      <div class="row g-3 mb-3">
        ${UI.kpiCard({ label: 'Items inspected', value: r.summary.total, format: 'int' }, 'fa-magnifying-glass')}
        ${UI.kpiCard({ label: 'Anomalies flagged', value: r.summary.flagged, format: 'int' }, 'fa-triangle-exclamation')}
        ${UI.kpiCard({ label: 'Share flagged', value: r.summary.total ? (r.summary.flagged / r.summary.total) * 100 : 0, format: 'percent' }, 'fa-percent')}
      </div>
      <div class="row g-3 mb-3">
        ${r.chart ? '<div class="col-12 col-xl-6"><div class="card"><div class="card-header">Series with anomalies highlighted</div><div class="card-body"><div class="chart-box"><canvas id="ano-chart"></canvas></div></div></div></div>' : ''}
        ${r.boxplot && r.boxplot.length ? '<div class="col-12 col-xl-6"><div class="card"><div class="card-header">Box plot</div><div class="card-body"><div class="chart-box"><canvas id="ano-box"></canvas></div></div></div></div>' : ''}
      </div>
      <div class="card"><div class="card-body"><div id="ano-table"></div></div></div>`;
    if (r.chart) Charts.fromSpec('ano-chart', r.chart);
    if (r.boxplot && r.boxplot.length) Charts.boxplot('ano-box', r.boxplot);
    UI.table('ano-table', { columns: r.anomalies.columns, rows: r.anomalies.rows, title: 'Anomalous records', exportName: 'anomalies', pageSize: 10 });
  }

  /* =============================== PATTERNS ==================================== */
  async function loadPatterns() {
    const out = $('mn-pat-out');
    UI.loading(out, 'Discovering patterns from the data…');
    try {
      const r = await Api.get('/api/mining/patterns');
      out.innerHTML = `<div class="row g-3 mb-3">${(r.patterns || []).map((p) => `<div class="col-md-6 col-xl-4"><div class="card h-100 hoverable"><div class="card-body">
          <span class="badge text-bg-primary mb-2">${UI.esc(p.category)}</span><h6>${UI.esc(p.title)}</h6><p class="small mb-0">${UI.esc(p.finding)}</p></div></div></div>`).join('')}</div>
        ${UI.alerts(r.warnings)}<div class="row g-3" id="pat-grid"></div>`;
      Charts.renderGrid('pat-grid', r.charts || []);
    } catch (e) { UI.error(out, e); }
  }

  /* ================================= PAGE ====================================== */
  async function load() {
    const st = $('mn-state');
    UI.loading(st, 'Preparing mining options…');
    try {
      opts = await Api.get('/api/mining/options');
      st.innerHTML = (opts.notes || []).map((n) => UI.alert('info', UI.esc(n))).join('');
      clsForm(); cluForm(); ascForm(); anoForm();
      ['cls', 'clu', 'asc', 'ano'].forEach((k) => { $(`mn-${k}-out`).innerHTML = '<div class="state-box"><i class="fa-solid fa-brain big"></i><h6>Configure and run</h6><div class="small">Results appear here.</div></div>'; });
      App.markLoaded('mining');
    } catch (e) { UI.error(st, e); }
  }

  function init() {
    document.querySelector('[data-bs-target="#mn-pat"]').addEventListener('shown.bs.tab', () => { if (!$('mn-pat-out').children.length) loadPatterns(); });
  }

  App.register('mining', { init, show() { if (App.stale('mining')) { $('mn-pat-out').innerHTML = ''; load(); } } });
})();
