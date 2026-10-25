/* =====================================================================
   RailInsight – dashboard.js  (Overview Dashboard)
   GET /api/analytics/dashboard?from=&to=&station=
   The backend decides which KPIs/charts the dataset supports; this file
   simply renders whatever comes back (no hard-coded numbers).
   ===================================================================== */
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const KPI_ICONS = {
    total_records: 'fa-database', total_bookings: 'fa-ticket', total_revenue: 'fa-indian-rupee-sign',
    avg_fare: 'fa-tags', total_passengers: 'fa-users', cancellation_pct: 'fa-ban',
    top_route: 'fa-route', top_station: 'fa-location-dot', avg_passengers: 'fa-user-group',
    busiest_day: 'fa-calendar-day', peak_hour: 'fa-clock',
  };
  let filtersReady = false;

  function init() {
    $('ov-apply').addEventListener('click', () => load());
    $('ov-reset').addEventListener('click', () => {
      $('ov-from').value = ''; $('ov-to').value = ''; $('ov-station').value = '';
      load();
    });
  }

  function currentParams() {
    return { from: $('ov-from').value, to: $('ov-to').value, station: $('ov-station').value };
  }

  function fillFilters(f) {
    if (!f || filtersReady) return;
    if (f.date_range) {
      ['ov-from', 'ov-to'].forEach((id) => {
        $(id).min = f.date_range.min; $(id).max = f.date_range.max;
      });
    } else {
      ['ov-from', 'ov-to'].forEach((id) => { $(id).disabled = true; $(id).title = 'Needs a mapped date column'; });
    }
    const sel = $('ov-station');
    if (f.stations && f.stations.length) {
      f.stations.forEach((s) => { const o = document.createElement('option'); o.value = s; o.textContent = s; sel.appendChild(o); });
    } else {
      sel.disabled = true; sel.title = 'Needs mapped source/destination station columns';
    }
    filtersReady = true;
  }

  async function load() {
    const state = $('ov-state');
    UI.loading(state, 'Calculating dashboard from the dataset…');
    $('ov-kpis').innerHTML = ''; $('ov-notices').innerHTML = '';
    Charts.destroyIn($('ov-charts')); $('ov-charts').innerHTML = '';
    try {
      const res = await Api.get('/api/analytics/dashboard', currentParams());
      state.innerHTML = '';
      fillFilters(res.filters);

      $('ov-kpis').innerHTML = (res.kpis || []).map((k) => UI.kpiCard(k, KPI_ICONS[k.key] || 'fa-chart-simple')).join('');
      $('ov-notices').innerHTML = (res.unavailable || []).map((u) =>
        UI.alert('info', `<b>${UI.esc(u.feature)}</b> is unavailable – requires: ${UI.esc((u.requires || []).join(', '))}.`)).join('');
      Charts.renderGrid('ov-charts', res.charts || []);
      App.markLoaded('overview');
    } catch (e) {
      UI.error(state, e);
    }
  }

  // dataset changed (upload / preprocessing / ETL) → rebuild filter options too
  function resetFilters() {
    filtersReady = false;
    ['ov-from', 'ov-to'].forEach((id) => { $(id).value = ''; $(id).disabled = false; $(id).removeAttribute('min'); $(id).removeAttribute('max'); });
    const sel = $('ov-station');
    sel.disabled = false; sel.innerHTML = '<option value="">All stations</option>';
  }

  App.register('overview', {
    init,
    show() { if (App.stale('overview')) { resetFilters(); load(); } },
  });
})();
