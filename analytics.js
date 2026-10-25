/* =====================================================================
   RailInsight – analytics.js  (Railway Analytics)
   GET /api/analytics/<category>   category = booking|revenue|route|station|time|ticket
   -> { charts:[...], unavailable:[{feature, requires:[]}] }
   Each tab loads the first time it is opened (and again if the data changed).
   ===================================================================== */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const loadedVersion = {};

  async function loadCategory(cat) {
    const pane = $('an-' + cat);
    if (loadedVersion[cat] === App.state.version) return;
    const grid = pane.querySelector('.an-grid'), notes = pane.querySelector('.an-notices');
    Charts.destroyIn(grid);
    notes.innerHTML = ''; grid.innerHTML = '';
    UI.loading(notes, 'Calculating ' + cat + ' analytics…');
    try {
      const res = await Api.get('/api/analytics/' + cat);
      notes.innerHTML = (res.unavailable || []).map((u) =>
        UI.alert('info', `<b>${UI.esc(u.feature)}</b> is unavailable – requires: ${UI.esc((u.requires || []).join(', '))}.`)).join('');
      Charts.renderGrid(grid, res.charts || []);
      loadedVersion[cat] = App.state.version;
    } catch (e) { UI.error(notes, e); }
  }

  const activeCat = () => document.querySelector('#an-tabs .nav-link.active').dataset.cat;

  function init() {
    document.querySelectorAll('#an-tabs [data-cat]').forEach((b) =>
      b.addEventListener('shown.bs.tab', () => loadCategory(b.dataset.cat)));
  }

  App.register('analytics', {
    init,
    show() {
      if (!App.state.summary && App.state.summaryError && !App.state.summaryError.offline) {
        UI.error('an-state', App.state.summaryError);
      } else $('an-state').innerHTML = '';
      loadCategory(activeCat());
    },
  });
})();
