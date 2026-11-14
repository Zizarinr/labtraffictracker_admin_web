'use strict';

(() => {
  const state = {
    authenticated: false,
    user: null,
    csrfToken: '',
    system: {},
    currentView: 'dashboard',
    labs: [],
    visitsPage: 1,
    visitsTotalPages: 1,
    invPage: 1,
    invTotalPages: 1,
    currentImportJob: null,
  };

  const VIEW_META = {
    dashboard: {
      title: 'Ringkasan Operasional & Status Lab',
      subtitle: 'Pemantauan penerimaan log multi-laboratorium, antrean lokal kiosk, dan aset',
    },
    visits: {
      title: 'Data Kunjungan Mahasiswa (Lab Scan KTM)',
      subtitle: 'Penelusuran, pemfilteran, inspeksi detail scan, dan ekspor log kunjungan',
    },
    labs: {
      title: 'Manajemen Laboratorium & Token Integrasi',
      subtitle: 'Pendaftaran identitas lab_id, rotasi Bearer token, dan konfigurasi PC Kiosk',
    },
    inventory: {
      title: 'Inventaris Peralatan Laboratorium',
      subtitle: 'Pengelolaan data barang, kondisi fisik, dan penempatan per laboratorium',
    },
    'import-audit': {
      title: 'Impor Massal Excel & Audit Operasional',
      subtitle: 'Validasi pratinjau impor inventaris 2-tahap, riwayat batch kiosk, dan log keamanan',
    },
  };

  /* ---------------- UTILITAS ---------------- */
  function $(id) {
    return document.getElementById(id);
  }

  function esc(val) {
    if (val === null || val === undefined) return '';
    return String(val)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtDateTime(iso) {
    if (!iso) return '-';
    const s = String(iso);
    if (s.length >= 19) {
      return `${s.slice(0, 10)} ${s.slice(11, 19)}`;
    }
    return s;
  }

  function showToast(message, type = 'info') {
    const container = $('toast-container');
    if (!container) return;
    const el = document.createElement('div');
    el.className = `toast-item ${type === 'error' ? 'toast-error' : type === 'success' ? 'toast-success' : ''}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, 4200);
  }

  async function apiFetch(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && typeof options.body === 'object' && !(options.body instanceof ArrayBuffer)) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    if (state.csrfToken && ['POST', 'PUT', 'PATCH', 'DELETE'].includes((options.method || 'GET').toUpperCase())) {
      headers['X-CSRF-Token'] = state.csrfToken;
    }

    const res = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers,
    });

    let data = null;
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      try {
        data = await res.json();
      } catch {
        data = null;
      }
    }

    if (res.status === 401 && url !== '/api/auth/login' && url !== '/api/auth/me') {
      showLoginScreen();
      throw new Error('Sesi berakhir, silakan masuk kembali.');
    }

    if (!res.ok) {
      const errMsg = (data && data.message) || `Permintaan gagal (HTTP ${res.status})`;
      const err = new Error(errMsg);
      err.status = res.status;
      err.data = data;
      throw err;
    }

    return data;
  }

  /* ---------------- RENDER BADGES ---------------- */
  function renderScanStatusBadge(status) {
    if (status === 'ok') {
      return '<span class="badge badge-success">Terdaftar (OK)</span>';
    }
    return '<span class="badge badge-danger">Tidak Dikenal</span>';
  }

  function renderLabHealthBadge(lab) {
    if (!lab.active || lab.health_state === 'inactive') {
      return '<span class="badge badge-neutral"><span class="status-dot status-dot-muted"></span>Nonaktif</span>';
    }
    if (lab.health_state === 'online') {
      return '<span class="badge badge-success"><span class="status-dot status-dot-online"></span>Online</span>';
    }
    if (lab.health_state === 'silent') {
      return `<span class="badge badge-warning"><span class="status-dot status-dot-warning"></span>Silent (${lab.minutes_since_seen}m)</span>`;
    }
    return '<span class="badge badge-neutral"><span class="status-dot status-dot-muted"></span>Belum Kirim Data</span>';
  }

  function renderConditionBadge(condition) {
    if (condition === 'Baik') return '<span class="badge badge-success">Baik</span>';
    if (condition === 'Rusak Ringan' || condition === 'Dalam Perbaikan') {
      return `<span class="badge badge-warning">${esc(condition)}</span>`;
    }
    return `<span class="badge badge-danger">${esc(condition)}</span>`;
  }

  function renderInvStatusBadge(status) {
    if (status === 'Aktif') return '<span class="badge badge-success">Aktif</span>';
    if (status === 'Tidak Aktif') return '<span class="badge badge-warning">Tidak Aktif</span>';
    return '<span class="badge badge-neutral">Arsip</span>';
  }

  /* ---------------- AUTH & NAVIGATION ---------------- */
  function showLoginScreen() {
    state.authenticated = false;
    $('app-shell').classList.add('hidden');
    $('login-screen').classList.remove('hidden');
  }

  function showAppShell() {
    $('login-screen').classList.add('hidden');
    $('app-shell').classList.remove('hidden');
    if (state.user) {
      $('current-user-name').textContent = state.user.name || 'Administrator';
      $('current-user-email').textContent = state.user.email || '';
    }
    if (state.system && state.system.ingest_url) {
      $('sidebar-ingest-url').textContent = state.system.ingest_url;
    }
  }

  async function checkSession() {
    try {
      const me = await apiFetch('/api/auth/me');
      if (me && me.authenticated) {
        state.authenticated = true;
        state.user = me.user;
        state.csrfToken = me.csrf_token || '';
        state.system = me.system || {};
        showAppShell();
        await loadLabsOptions();
        await switchView(state.currentView);
      } else {
        showLoginScreen();
      }
    } catch {
      showLoginScreen();
    }
  }

  async function loadLabsOptions() {
    try {
      const data = await apiFetch('/api/laboratories');
      state.labs = data.items || [];
      populateLabSelects();
    } catch {
      /* ignore */
    }
  }

  function populateLabSelects() {
    const selects = [
      { el: $('dash-lab-filter'), emptyLabel: 'Semua Laboratorium' },
      { el: $('visits-lab'), emptyLabel: 'Semua Lab' },
      { el: $('inv-lab'), emptyLabel: 'Semua Lab' },
      { el: $('inv-input-lab'), emptyLabel: null },
    ];

    for (const { el, emptyLabel } of selects) {
      if (!el) continue;
      const currentVal = el.value;
      const optionsHtml = [];
      if (emptyLabel !== null) {
        optionsHtml.push(`<option value="">${esc(emptyLabel)}</option>`);
      }
      for (const lab of state.labs) {
        optionsHtml.push(
          `<option value="${esc(lab.id)}">${esc(lab.name)} (${esc(lab.id)})</option>`
        );
      }
      el.innerHTML = optionsHtml.join('');
      if (currentVal) el.value = currentVal;
    }
  }

  async function switchView(viewName) {
    if (!VIEW_META[viewName]) viewName = 'dashboard';
    state.currentView = viewName;

    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    });

    document.querySelectorAll('.view-section').forEach((sec) => {
      sec.classList.toggle('hidden', sec.id !== `view-${viewName}`);
    });

    $('topbar-title').textContent = VIEW_META[viewName].title;
    $('topbar-subtitle').textContent = VIEW_META[viewName].subtitle;

    if (viewName === 'dashboard') {
      await loadDashboard();
    } else if (viewName === 'visits') {
      await loadVisits(state.visitsPage);
    } else if (viewName === 'labs') {
      await loadLaboratoriesView();
    } else if (viewName === 'inventory') {
      await loadInventory(state.invPage);
    } else if (viewName === 'import-audit') {
      await loadAuditView();
    }
  }

  /* ---------------- VIEW 1: DASHBOARD ---------------- */
  function renderBarChart(containerId, items, labelKey) {
    const container = $(containerId);
    if (!container) return;
    if (!items || items.length === 0) {
      container.innerHTML = '<div class="empty-cell">Belum ada data grafik</div>';
      return;
    }

    const maxVal = Math.max(1, ...items.map((i) => i.total || 0));
    const colsHtml = items
      .map((item) => {
        const total = item.total || 0;
        const ok = item.ok || 0;
        const nf = Math.max(0, total - ok);
        const totalHeightPct = Math.round((total / maxVal) * 100);
        const okPct = total > 0 ? Math.round((ok / total) * 100) : 0;
        const nfPct = 100 - okPct;
        const rawLabel = String(item[labelKey] || '');
        const shortLabel = labelKey === 'date' ? rawLabel.slice(5) : rawLabel.slice(0, 2);

        return `
          <div class="bar-col" title="${esc(rawLabel)} — Total: ${total} (OK: ${ok}, Tidak Dikenal: ${nf})">
            <div class="bar-val">${total > 0 ? total : ''}</div>
            <div class="bar-stack" style="height: ${Math.max(4, totalHeightPct)}%;">
              ${nf > 0 ? `<div class="bar-seg-nf" style="height: ${nfPct}%;"></div>` : ''}
              ${ok > 0 ? `<div class="bar-seg-ok" style="height: ${okPct}%;"></div>` : ''}
            </div>
            <div class="bar-label">${esc(shortLabel)}</div>
          </div>
        `;
      })
      .join('');

    container.innerHTML = `<div class="bar-chart-rows">${colsHtml}</div>`;
  }

  async function loadDashboard() {
    try {
      const labId = $('dash-lab-filter').value;
      const from = $('dash-from-date').value;
      const to = $('dash-to-date').value;

      const qs = new URLSearchParams();
      if (labId) qs.set('lab_id', labId);
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);

      const data = await apiFetch(`/api/dashboard/summary?${qs.toString()}`);

      if (data.server_time) {
        $('server-clock-text').textContent = `${fmtDateTime(data.server_time)} WIB`;
      }

      if (!$('dash-from-date').value && data.range_stats?.from) {
        $('dash-from-date').value = data.range_stats.from;
      }
      if (!$('dash-to-date').value && data.range_stats?.to) {
        $('dash-to-date').value = data.range_stats.to;
      }

      // KPI Cards
      $('kpi-today-date').textContent = data.today_stats.date;
      $('kpi-today-total').textContent = data.today_stats.total_scans;
      $('kpi-today-ok').textContent = data.today_stats.ok_scans;
      $('kpi-today-notfound').textContent = data.today_stats.not_found_scans;
      $('kpi-today-unique').textContent = data.today_stats.unique_students;

      $('kpi-range-total').textContent = data.range_stats.total_scans;
      $('kpi-range-unique').textContent = data.range_stats.unique_students;

      $('kpi-labs-online').textContent = data.labs_summary.online_labs;
      $('kpi-labs-active').textContent = data.labs_summary.active_labs;
      $('kpi-labs-silent').textContent = data.labs_summary.silent_labs;

      $('kpi-inv-items').textContent = data.inventory_summary.total_items;
      $('kpi-inv-units').textContent = data.inventory_summary.total_units;
      $('kpi-inv-good').textContent = data.inventory_summary.baik_count;
      const issueCount =
        (data.inventory_summary.rusak_ringan_count || 0) +
        (data.inventory_summary.rusak_berat_count || 0) +
        (data.inventory_summary.perbaikan_count || 0);
      $('kpi-inv-issue').textContent = issueCount;

      // Alerts
      const alertsBox = $('dash-alerts-container');
      if (data.alerts && data.alerts.length > 0) {
        alertsBox.classList.remove('hidden');
        alertsBox.innerHTML = data.alerts
          .map(
            (a) => `
            <div class="alert-banner ${a.severity === 'danger' ? 'alert-danger' : 'alert-warning'}">
              <div>
                <strong>[${esc(a.type.toUpperCase())}]</strong> ${esc(a.message)}
              </div>
              <span class="mono">${esc(fmtDateTime(a.at))}</span>
            </div>
          `
          )
          .join('');
      } else {
        alertsBox.classList.add('hidden');
        alertsBox.innerHTML = '';
      }

      // Tabel Kesehatan Lab
      const labsTbody = $('dash-labs-tbody');
      if (!data.labs_health || data.labs_health.length === 0) {
        labsTbody.innerHTML =
          '<tr><td colspan="9" class="empty-cell">Belum ada laboratorium terdaftar. Tambahkan laboratorium di menu Laboratorium & Token.</td></tr>';
      } else {
        labsTbody.innerHTML = data.labs_health
          .map((l) => {
            const skewAbs = Math.abs(l.last_clock_skew_sec || 0);
            const skewClass = l.clock_skew_alert ? 'text-danger' : '';
            const pendingClass = l.backlog_alert ? 'text-warning' : '';
            return `
              <tr>
                <td class="mono"><strong>${esc(l.id)}</strong></td>
                <td>
                  <div><strong>${esc(l.name)}</strong></div>
                  <div class="text-muted" style="font-size:11.5px;">${esc(l.location || '-')}</div>
                </td>
                <td>${renderLabHealthBadge(l)}</td>
                <td class="num">${l.today_scans}</td>
                <td class="num">${l.total_scans}</td>
                <td class="num ${pendingClass}">${l.last_pending_count}</td>
                <td class="num ${skewClass}">${l.last_seen_at ? `${skewAbs}s` : '-'}</td>
                <td class="mono">${esc(fmtDateTime(l.last_seen_at))}</td>
                <td class="actions-col">
                  <button type="button" class="btn btn-secondary btn-sm" data-filter-lab-visits="${esc(l.id)}">
                    Lihat Log
                  </button>
                </td>
              </tr>
            `;
          })
          .join('');
      }

      // Charts
      renderBarChart('chart-daily-trend', data.daily_trend, 'date');
      renderBarChart('chart-hourly-trend', data.hourly_trend, 'hour');

      // Live feed
      const feedTbody = $('dash-livefeed-tbody');
      if (!data.live_feed || data.live_feed.length === 0) {
        feedTbody.innerHTML = '<tr><td colspan="7" class="empty-cell">Belum ada data kunjungan masuk.</td></tr>';
      } else {
        feedTbody.innerHTML = data.live_feed
          .map(
            (r) => `
            <tr data-visit-lab="${esc(r.lab_id)}" data-visit-id="${esc(r.id)}">
              <td class="mono">${esc(fmtDateTime(r.scanned_at))}</td>
              <td>
                <div><strong>${esc(r.lab_name || r.lab_id)}</strong></div>
                <div class="mono text-muted" style="font-size:11px;">${esc(r.lab_id)}</div>
              </td>
              <td class="mono"><strong>${esc(r.nim)}</strong></td>
              <td>${r.nama ? esc(r.nama) : '<span class="text-muted">Tidak terdaftar di kiosk</span>'}</td>
              <td class="mono">${esc(r.kelas || '-')} / ${esc(r.semester ?? '-')}</td>
              <td>${renderScanStatusBadge(r.status)}</td>
              <td class="mono text-muted">${esc(fmtDateTime(r.received_at))}</td>
            </tr>
          `
          )
          .join('');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  /* ---------------- VIEW 2: VISIT LOGS ---------------- */
  function getVisitFilterParams(page = 1) {
    const qs = new URLSearchParams();
    qs.set('page', String(page));
    qs.set('limit', '25');
    const q = $('visits-q').value.trim();
    const lab = $('visits-lab').value;
    const status = $('visits-status').value;
    const from = $('visits-from').value;
    const to = $('visits-to').value;
    const kelas = $('visits-kelas').value.trim();
    const semester = $('visits-semester').value.trim();

    if (q) qs.set('q', q);
    if (lab) qs.set('lab_id', lab);
    if (status) qs.set('status', status);
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    if (kelas) qs.set('kelas', kelas);
    if (semester) qs.set('semester', semester);
    return qs;
  }

  async function loadVisits(page = 1) {
    try {
      state.visitsPage = page;
      const qs = getVisitFilterParams(page);
      const data = await apiFetch(`/api/visit-logs?${qs.toString()}`);

      const items = data.items || [];
      const pag = data.pagination || { page: 1, total_pages: 1, total: 0 };
      state.visitsTotalPages = pag.total_pages;

      $('visits-summary-text').textContent = `Total ditemukan: ${pag.total} catatan kunjungan`;
      $('visits-page-info').textContent = `Halaman ${pag.page} dari ${pag.total_pages} (Total ${pag.total} baris)`;
      $('visits-prev-page').disabled = pag.page <= 1;
      $('visits-next-page').disabled = pag.page >= pag.total_pages;

      const tbody = $('visits-tbody');
      if (items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="empty-cell">Tidak ada catatan kunjungan yang sesuai filter.</td></tr>';
      } else {
        tbody.innerHTML = items
          .map(
            (r) => `
            <tr data-visit-lab="${esc(r.lab_id)}" data-visit-id="${esc(r.id)}">
              <td class="mono">${esc(fmtDateTime(r.scanned_at))}</td>
              <td class="mono"><strong>${esc(r.nim)}</strong></td>
              <td>${r.nama ? esc(r.nama) : '<span class="text-muted">-</span>'}</td>
              <td class="mono">${esc(r.kelas || '-')} / ${esc(r.semester ?? '-')}</td>
              <td>
                <div><strong>${esc(r.lab_name || r.lab_id)}</strong></div>
                <div class="mono text-muted" style="font-size:11px;">${esc(r.lab_id)}</div>
              </td>
              <td>${renderScanStatusBadge(r.status)}</td>
              <td class="mono text-muted">${esc(fmtDateTime(r.received_at))}</td>
              <td class="actions-col">
                <button type="button" class="btn btn-secondary btn-sm" data-visit-lab="${esc(r.lab_id)}" data-visit-id="${esc(r.id)}">
                  Detail
                </button>
              </td>
            </tr>
          `
          )
          .join('');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function openVisitDrawer(labId, id) {
    try {
      const [detailData, studentHistory] = await Promise.all([
        apiFetch(`/api/visit-logs/${encodeURIComponent(labId)}/${encodeURIComponent(id)}`),
        null,
      ]);

      const v = detailData.visit;
      let studentData = null;
      if (v && v.nim) {
        studentData = await apiFetch(`/api/students/${encodeURIComponent(v.nim)}/visits`);
      }

      $('drawer-title').textContent = `${v.nim} — ${v.nama || 'NIM Tidak Terdaftar'}`;

      const labsBreakdownHtml =
        studentData && studentData.labs_breakdown && studentData.labs_breakdown.length > 0
          ? studentData.labs_breakdown
              .map(
                (b) =>
                  `<span class="badge badge-neutral">${esc(b.lab_name || b.lab_id)}: <strong class="mono">${b.visit_count}x</strong></span>`
              )
              .join(' ')
          : '-';

      const historyRowsHtml =
        studentData && studentData.visits && studentData.visits.length > 0
          ? studentData.visits
              .slice(0, 20)
              .map(
                (h) => `
                <tr>
                  <td class="mono">${esc(fmtDateTime(h.scanned_at))}</td>
                  <td>${esc(h.lab_name || h.lab_id)}</td>
                  <td>${renderScanStatusBadge(h.status)}</td>
                </tr>
              `
              )
              .join('')
          : '<tr><td colspan="3" class="empty-cell">Tidak ada riwayat lain</td></tr>';

      $('drawer-body').innerHTML = `
        <div>
          <h3 style="margin:0 0 8px; font-size:13px;">Metadata Catatan Kunjungan</h3>
          <div class="kv-grid">
            <div class="kv-label">ID Record Sumber</div>
            <div class="kv-val mono">${esc(v.id)}</div>
            <div class="kv-label">Laboratorium</div>
            <div class="kv-val"><strong>${esc(v.lab_name || v.lab_id)}</strong> (<code class="mono">${esc(v.lab_id)}</code>)</div>
            <div class="kv-label">NIM Mahasiswa</div>
            <div class="kv-val mono"><strong>${esc(v.nim)}</strong></div>
            <div class="kv-label">Nama Mahasiswa</div>
            <div class="kv-val">${esc(v.nama || '-')}</div>
            <div class="kv-label">Kelas / Semester</div>
            <div class="kv-val mono">${esc(v.kelas || '-')} / ${esc(v.semester ?? '-')}</div>
            <div class="kv-label">Status Hasil Scan</div>
            <div class="kv-val">${renderScanStatusBadge(v.status)}</div>
            <div class="kv-label">Waktu Scan (Kiosk)</div>
            <div class="kv-val mono">${esc(v.scanned_at)}</div>
            <div class="kv-label">Waktu Diterima Pusat</div>
            <div class="kv-val mono">${esc(v.received_at)}</div>
            <div class="kv-label">ID Batch Ingest</div>
            <div class="kv-val mono">${esc(v.batch_id || '-')}</div>
            <div class="kv-label">IP Kiosk Pengirim</div>
            <div class="kv-val mono">${esc(v.batch_source_ip || '-')}</div>
            <div class="kv-label">Selisih Jam (Skew)</div>
            <div class="kv-val mono">${v.batch_clock_skew_sec !== null && v.batch_clock_skew_sec !== undefined ? `${v.batch_clock_skew_sec} detik` : '-'}</div>
          </div>
        </div>

        <div>
          <h3 style="margin:0 0 6px; font-size:13px;">Riwayat Kunjungan Mahasiswa Lintas Lab (${studentData ? studentData.total_visits : 1} Kunjungan)</h3>
          <div style="margin-bottom:10px; display:flex; gap:6px; flex-wrap:wrap;">
            ${labsBreakdownHtml}
          </div>
          <div class="panel">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Waktu Scan</th>
                  <th>Laboratorium</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>${historyRowsHtml}</tbody>
            </table>
          </div>
        </div>
      `;

      $('visit-drawer-backdrop').classList.remove('hidden');
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  /* ---------------- VIEW 3: LABORATORIES & TOKEN ---------------- */
  function showTokenReveal({ title, token, envSnippet }) {
    $('token-reveal-title').textContent = title;
    $('token-reveal-value').textContent = token;
    $('token-reveal-env').textContent = envSnippet;
    $('token-reveal-panel').classList.remove('hidden');
    $('token-reveal-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function loadLaboratoriesView() {
    try {
      const data = await apiFetch('/api/laboratories');
      state.labs = data.items || [];
      populateLabSelects();

      const tbody = $('labs-tbody');
      if (state.labs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" class="empty-cell">Belum ada laboratorium yang didaftarkan.</td></tr>';
        return;
      }

      tbody.innerHTML = state.labs
        .map(
          (l) => `
          <tr>
            <td class="mono"><strong>${esc(l.id)}</strong></td>
            <td><strong>${esc(l.name)}</strong></td>
            <td>
              <div>${esc(l.location || '-')}</div>
              <div class="text-muted" style="font-size:11.5px;">${esc(l.description || '')}</div>
            </td>
            <td>
              ${l.active ? '<span class="badge badge-success">Aktif</span>' : '<span class="badge badge-neutral">Nonaktif</span>'}
            </td>
            <td>${renderLabHealthBadge(l)}</td>
            <td class="mono">${esc(l.token_hint || 'lab_***')}</td>
            <td class="num">${l.total_scans || 0} <span class="text-muted">(hari ini: ${l.today_scans || 0})</span></td>
            <td class="num">${l.inventory_count || 0}</td>
            <td class="mono">${esc(fmtDateTime(l.last_seen_at))}</td>
            <td class="actions-col">
              <button type="button" class="btn btn-secondary btn-sm" data-edit-lab="${esc(l.id)}">Ubah</button>
              <button type="button" class="btn btn-secondary btn-sm" data-rotate-token="${esc(l.id)}">Rotasi Token</button>
            </td>
          </tr>
        `
        )
        .join('');
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function openLabModal(lab = null) {
    if (lab) {
      $('modal-lab-title').textContent = `Ubah Laboratorium (${lab.id})`;
      $('lab-form-mode').value = 'edit';
      $('lab-input-id').value = lab.id;
      $('lab-input-id').disabled = true;
      $('lab-input-name').value = lab.name || '';
      $('lab-input-location').value = lab.location || '';
      $('lab-input-desc').value = lab.description || '';
      $('lab-input-active').checked = Boolean(lab.active);
      $('lab-active-group').classList.remove('hidden');
    } else {
      $('modal-lab-title').textContent = 'Tambah Laboratorium Baru';
      $('lab-form-mode').value = 'create';
      $('lab-input-id').value = '';
      $('lab-input-id').disabled = false;
      $('lab-input-name').value = '';
      $('lab-input-location').value = '';
      $('lab-input-desc').value = '';
      $('lab-input-active').checked = true;
      $('lab-active-group').classList.add('hidden');
    }
    $('modal-lab').classList.remove('hidden');
  }

  /* ---------------- VIEW 4: INVENTORY ---------------- */
  function getInventoryFilterParams(page = 1) {
    const qs = new URLSearchParams();
    qs.set('page', String(page));
    qs.set('limit', '25');
    const q = $('inv-q').value.trim();
    const lab = $('inv-lab').value;
    const category = $('inv-category').value;
    const condition = $('inv-condition').value;
    const status = $('inv-status').value;

    if (q) qs.set('q', q);
    if (lab) qs.set('lab_id', lab);
    if (category) qs.set('category', category);
    if (condition) qs.set('condition', condition);
    if (status) {
      qs.set('status', status);
      if (status === 'Arsip') qs.set('include_archived', 'true');
    }
    return qs;
  }

  async function loadInventory(page = 1) {
    try {
      state.invPage = page;
      const qs = getInventoryFilterParams(page);
      const [invData, dashData] = await Promise.all([
        apiFetch(`/api/inventory?${qs.toString()}`),
        apiFetch('/api/dashboard/summary'),
      ]);

      if (dashData && dashData.inventory_summary) {
        const s = dashData.inventory_summary;
        $('inv-stat-total').textContent = `${s.total_items} item (${s.total_units} unit)`;
        $('inv-stat-baik').textContent = s.baik_count;
        $('inv-stat-ringan').textContent = (s.rusak_ringan_count || 0) + (s.perbaikan_count || 0);
        $('inv-stat-berat').textContent = s.rusak_berat_count || 0;
      }

      // Update category select
      const catSelect = $('inv-category');
      const currentCat = catSelect.value;
      catSelect.innerHTML = [
        '<option value="">Semua Kategori</option>',
        ...(invData.categories || []).map((c) => `<option value="${esc(c)}">${esc(c)}</option>`),
      ].join('');
      if (currentCat) catSelect.value = currentCat;

      const items = invData.items || [];
      const pag = invData.pagination || { page: 1, total_pages: 1, total: 0 };
      state.invTotalPages = pag.total_pages;

      $('inv-summary-text').textContent = `Menampilkan ${items.length} dari total ${pag.total} item inventaris`;
      $('inv-page-info').textContent = `Halaman ${pag.page} dari ${pag.total_pages} (Total ${pag.total} item)`;
      $('inv-prev-page').disabled = pag.page <= 1;
      $('inv-next-page').disabled = pag.page >= pag.total_pages;

      const tbody = $('inv-tbody');
      if (items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="11" class="empty-cell">Tidak ada data inventaris yang sesuai filter.</td></tr>';
      } else {
        tbody.innerHTML = items
          .map(
            (item) => `
            <tr>
              <td class="mono"><strong>${esc(item.inventory_code)}</strong></td>
              <td><strong>${esc(item.name)}</strong></td>
              <td>${esc(item.category)}</td>
              <td>
                <div>${esc(item.lab_name || item.lab_id)}</div>
                <div class="mono text-muted" style="font-size:11px;">${esc(item.lab_id)}</div>
              </td>
              <td class="num"><strong>${item.quantity}</strong></td>
              <td>${esc(item.unit)}</td>
              <td>${renderConditionBadge(item.condition)}</td>
              <td>${renderInvStatusBadge(item.status)}</td>
              <td class="text-muted">${esc(item.notes || '-')}</td>
              <td class="mono text-muted">${esc(fmtDateTime(item.updated_at))}</td>
              <td class="actions-col">
                <button type="button" class="btn btn-secondary btn-sm" data-edit-inv="${esc(item.id)}">Ubah</button>
                ${
                  item.status !== 'Arsip'
                    ? `<button type="button" class="btn btn-danger btn-sm" data-archive-inv="${esc(item.id)}" data-archive-code="${esc(item.inventory_code)}">Arsip</button>`
                    : ''
                }
              </td>
            </tr>
          `
          )
          .join('');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function openInvModal(item = null) {
    populateLabSelects();
    if (item) {
      $('modal-inv-title').textContent = `Ubah Item Inventaris (${item.inventory_code})`;
      $('inv-form-id').value = item.id;
      $('inv-input-code').value = item.inventory_code;
      $('inv-input-lab').value = item.lab_id;
      $('inv-input-name').value = item.name;
      $('inv-input-category').value = item.category;
      $('inv-input-qty').value = item.quantity;
      $('inv-input-unit').value = item.unit;
      $('inv-input-condition').value = item.condition;
      $('inv-input-status').value = item.status;
      $('inv-input-notes').value = item.notes || '';
    } else {
      $('modal-inv-title').textContent = 'Tambah Item Inventaris Baru';
      $('inv-form-id').value = '';
      $('inv-input-code').value = '';
      if (state.labs.length > 0) $('inv-input-lab').value = state.labs[0].id;
      $('inv-input-name').value = '';
      $('inv-input-category').value = '';
      $('inv-input-qty').value = '1';
      $('inv-input-unit').value = 'unit';
      $('inv-input-condition').value = 'Baik';
      $('inv-input-status').value = 'Aktif';
      $('inv-input-notes').value = '';
    }
    $('modal-inv').classList.remove('hidden');
  }

  /* ---------------- VIEW 5: EXCEL IMPORT & AUDIT ---------------- */
  function renderImportPreview(preview) {
    state.currentImportJob = preview;
    $('prev-file-name').textContent = preview.file_name;
    $('prev-total-rows').textContent = preview.total_rows;
    $('prev-new-rows').textContent = preview.new_valid_rows;
    $('prev-conflict-rows').textContent = preview.conflict_rows;
    $('prev-failed-rows').textContent = preview.failed_rows;

    const canConfirm = preview.valid_rows > 0;
    $('import-confirm-card').classList.toggle('import-step-disabled', !canConfirm);
    $('btn-confirm-import').disabled = !canConfirm;
    $('btn-cancel-preview').disabled = false;

    const tbody = $('import-preview-tbody');
    tbody.innerHTML = (preview.rows || [])
      .map((r) => {
        let stateBadge = '<span class="badge badge-success">Valid (Baru)</span>';
        let noteHtml = '<span class="text-success">Siap ditambahkan</span>';

        if (r.state === 'conflict') {
          stateBadge = '<span class="badge badge-warning">Konflik Kode</span>';
          noteHtml = `<span class="text-warning">Kode sudah ada di DB (${esc(r.existing.name)}, jml: ${r.existing.quantity}). Akan mengikuti kebijakan konflik.</span>`;
        } else if (r.state === 'invalid') {
          stateBadge = '<span class="badge badge-danger">Gagal Validasi</span>';
          noteHtml = `<span class="text-danger">${esc((r.errors || []).join('; '))}</span>`;
        }

        const d = r.data || {};
        return `
          <tr>
            <td class="num">${r.row_number}</td>
            <td>${stateBadge}</td>
            <td class="mono"><strong>${esc(d.inventory_code || '-')}</strong></td>
            <td>${esc(d.name || '-')}</td>
            <td>${esc(d.category || '-')}</td>
            <td class="mono">${esc(d.lab_id || '-')}</td>
            <td class="num">${esc(d.quantity)} ${esc(d.unit || '')}</td>
            <td>${esc(d.condition || '-')} / ${esc(d.status || '-')}</td>
            <td>${noteHtml}</td>
          </tr>
        `;
      })
      .join('');

    $('import-preview-results').classList.remove('hidden');
  }

  function resetImportPreview() {
    state.currentImportJob = null;
    $('import-preview-results').classList.add('hidden');
    $('import-confirm-card').classList.add('import-step-disabled');
    $('btn-confirm-import').disabled = true;
    $('btn-cancel-preview').disabled = true;
    $('excel-file-input').value = '';
  }

  async function loadAuditView() {
    try {
      const data = await apiFetch('/api/audit-logs?limit=50');

      const batchesTbody = $('audit-batches-tbody');
      const batches = data.ingest_batches || [];
      if (batches.length === 0) {
        batchesTbody.innerHTML = '<tr><td colspan="7" class="empty-cell">Belum ada riwayat batch sinkronisasi.</td></tr>';
      } else {
        batchesTbody.innerHTML = batches
          .map(
            (b) => `
            <tr>
              <td class="mono">${esc(fmtDateTime(b.received_at))}</td>
              <td class="mono"><strong>${esc(b.lab_id)}</strong></td>
              <td class="num">${b.record_count}</td>
              <td class="num text-success">${b.accepted_count}</td>
              <td class="num ${b.duplicate_count > 0 ? 'text-warning' : ''}">${b.duplicate_count}</td>
              <td class="num">${b.pending_count ?? 0}</td>
              <td class="num">${b.clock_skew_sec ?? 0}s</td>
            </tr>
          `
          )
          .join('');
      }

      const logsTbody = $('audit-logs-tbody');
      const logs = data.audit_logs || [];
      if (logs.length === 0) {
        logsTbody.innerHTML = '<tr><td colspan="5" class="empty-cell">Belum ada catatan audit.</td></tr>';
      } else {
        logsTbody.innerHTML = logs
          .map(
            (l) => `
            <tr>
              <td class="mono">${esc(fmtDateTime(l.created_at))}</td>
              <td class="mono">${esc(l.user_email || l.ip_address || 'system')}</td>
              <td><span class="badge badge-neutral mono">${esc(l.action)}</span></td>
              <td class="mono">${esc(l.target || '-')}</td>
              <td class="mono text-muted" style="font-size:11.5px;">${l.detail ? esc(JSON.stringify(l.detail)) : '-'}</td>
            </tr>
          `
          )
          .join('');
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  /* ---------------- EVENT LISTENERS ---------------- */
  function bindEvents() {
    // Login form
    $('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errBox = $('login-error');
      errBox.classList.add('hidden');
      const btn = $('login-submit');
      btn.disabled = true;

      try {
        const email = $('login-email').value.trim();
        const password = $('login-password').value;
        await apiFetch('/api/auth/login', {
          method: 'POST',
          body: { email, password },
        });
        $('login-password').value = '';
        await checkSession();
        showToast('Berhasil masuk ke konsol pusat.', 'success');
      } catch (err) {
        errBox.textContent = err.message;
        errBox.classList.remove('hidden');
      } finally {
        btn.disabled = false;
      }
    });

    // Logout
    $('logout-btn').addEventListener('click', async () => {
      try {
        await apiFetch('/api/auth/logout', { method: 'POST' });
      } catch {
        /* ignore */
      }
      showLoginScreen();
    });

    // Sidebar navigation
    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        switchView(btn.dataset.view);
      });
    });

    // Quick view jump buttons
    document.querySelectorAll('[data-goto-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        switchView(btn.dataset.gotoView);
      });
    });

    // Refresh current view
    $('refresh-current-view').addEventListener('click', () => {
      switchView(state.currentView);
    });

    // Dashboard filter
    $('dash-apply-filter').addEventListener('click', () => {
      loadDashboard();
    });

    // Delegated clicks on tables
    document.body.addEventListener('click', async (e) => {
      // Close modal buttons
      const closeModalBtn = e.target.closest('[data-close-modal]');
      if (closeModalBtn) {
        $(closeModalBtn.dataset.closeModal).classList.add('hidden');
        return;
      }

      // Filter visits by lab from Dashboard
      const filterLabBtn = e.target.closest('[data-filter-lab-visits]');
      if (filterLabBtn) {
        $('visits-lab').value = filterLabBtn.dataset.filterLabVisits;
        await switchView('visits');
        return;
      }

      // Open visit detail drawer
      const visitRowOrBtn = e.target.closest('[data-visit-lab][data-visit-id]');
      if (visitRowOrBtn) {
        await openVisitDrawer(visitRowOrBtn.dataset.visitLab, visitRowOrBtn.dataset.visitId);
        return;
      }

      // Edit lab
      const editLabBtn = e.target.closest('[data-edit-lab]');
      if (editLabBtn) {
        const lab = state.labs.find((l) => l.id === editLabBtn.dataset.editLab);
        if (lab) openLabModal(lab);
        return;
      }

      // Rotate token
      const rotateBtn = e.target.closest('[data-rotate-token]');
      if (rotateBtn) {
        const labId = rotateBtn.dataset.rotateToken;
        if (!window.confirm(`Rotasi token untuk laboratorium '${labId}'? Token lama akan langsung tidak berlaku.`)) {
          return;
        }
        try {
          const res = await apiFetch(`/api/laboratories/${encodeURIComponent(labId)}/rotate-token`, {
            method: 'POST',
          });
          showTokenReveal({
            title: `Token Baru Laboratorium: ${res.lab_name} (${res.lab_id})`,
            token: res.token_once,
            envSnippet: res.kiosk_env_snippet,
          });
          await loadLaboratoriesView();
          showToast(`Token laboratorium ${labId} berhasil dirotasi.`, 'success');
        } catch (err) {
          showToast(err.message, 'error');
        }
        return;
      }

      // Edit inventory
      const editInvBtn = e.target.closest('[data-edit-inv]');
      if (editInvBtn) {
        try {
          const res = await apiFetch(`/api/inventory/${encodeURIComponent(editInvBtn.dataset.editInv)}`);
          if (res.item) openInvModal(res.item);
        } catch (err) {
          showToast(err.message, 'error');
        }
        return;
      }

      // Archive inventory
      const archInvBtn = e.target.closest('[data-archive-inv]');
      if (archInvBtn) {
        const id = archInvBtn.dataset.archiveInv;
        const code = archInvBtn.dataset.archiveCode;
        if (!window.confirm(`Arsipkan item inventaris '${code}'?`)) return;
        try {
          await apiFetch(`/api/inventory/${encodeURIComponent(id)}`, { method: 'DELETE' });
          showToast(`Inventaris ${code} diarsipkan.`, 'success');
          await loadInventory(state.invPage);
        } catch (err) {
          showToast(err.message, 'error');
        }
      }
    });

    // Close drawer
    $('btn-close-drawer').addEventListener('click', () => {
      $('visit-drawer-backdrop').classList.add('hidden');
    });
    $('visit-drawer-backdrop').addEventListener('click', (e) => {
      if (e.target === $('visit-drawer-backdrop')) {
        $('visit-drawer-backdrop').classList.add('hidden');
      }
    });

    // Visit logs filter & pagination
    $('visits-filter-form').addEventListener('submit', (e) => {
      e.preventDefault();
      loadVisits(1);
    });
    $('visits-reset-btn').addEventListener('click', () => {
      $('visits-filter-form').reset();
      loadVisits(1);
    });
    $('visits-prev-page').addEventListener('click', () => {
      if (state.visitsPage > 1) loadVisits(state.visitsPage - 1);
    });
    $('visits-next-page').addEventListener('click', () => {
      if (state.visitsPage < state.visitsTotalPages) loadVisits(state.visitsPage + 1);
    });
    $('visits-export-xlsx').addEventListener('click', () => {
      const qs = getVisitFilterParams(1);
      qs.set('format', 'xlsx');
      window.location.href = `/api/visit-logs/export?${qs.toString()}`;
    });
    $('visits-export-csv').addEventListener('click', () => {
      const qs = getVisitFilterParams(1);
      qs.set('format', 'csv');
      window.location.href = `/api/visit-logs/export?${qs.toString()}`;
    });

    // Laboratories modal & token copy
    $('btn-open-new-lab').addEventListener('click', () => openLabModal(null));
    $('btn-close-token-reveal').addEventListener('click', () => {
      $('token-reveal-panel').classList.add('hidden');
    });
    $('btn-copy-token').addEventListener('click', async () => {
      await navigator.clipboard.writeText($('token-reveal-value').textContent);
      showToast('Bearer token berhasil disalin ke clipboard.', 'success');
    });
    $('btn-copy-env').addEventListener('click', async () => {
      await navigator.clipboard.writeText($('token-reveal-env').textContent);
      showToast('Konfigurasi .env kiosk berhasil disalin ke clipboard.', 'success');
    });

    $('form-lab').addEventListener('submit', async (e) => {
      e.preventDefault();
      const mode = $('lab-form-mode').value;
      const id = $('lab-input-id').value.trim().toLowerCase();
      const name = $('lab-input-name').value.trim();
      const location = $('lab-input-location').value.trim();
      const description = $('lab-input-desc').value.trim();
      const active = $('lab-input-active').checked;

      try {
        if (mode === 'create') {
          const res = await apiFetch('/api/laboratories', {
            method: 'POST',
            body: { id, name, location, description },
          });
          $('modal-lab').classList.add('hidden');
          showTokenReveal({
            title: `Laboratorium Baru Terdaftar: ${res.laboratory.name} (${res.laboratory.id})`,
            token: res.token_once,
            envSnippet: res.kiosk_env_snippet,
          });
          showToast(`Laboratorium ${id} berhasil dibuat.`, 'success');
        } else {
          await apiFetch(`/api/laboratories/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: { name, location, description, active },
          });
          $('modal-lab').classList.add('hidden');
          showToast(`Data laboratorium ${id} berhasil diperbarui.`, 'success');
        }
        await loadLaboratoriesView();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    // Inventory filter, pagination, modal
    $('inv-filter-form').addEventListener('submit', (e) => {
      e.preventDefault();
      loadInventory(1);
    });
    $('inv-reset-btn').addEventListener('click', () => {
      $('inv-filter-form').reset();
      loadInventory(1);
    });
    $('inv-prev-page').addEventListener('click', () => {
      if (state.invPage > 1) loadInventory(state.invPage - 1);
    });
    $('inv-next-page').addEventListener('click', () => {
      if (state.invPage < state.invTotalPages) loadInventory(state.invPage + 1);
    });
    $('inv-export-xlsx').addEventListener('click', () => {
      const qs = getInventoryFilterParams(1);
      qs.set('format', 'xlsx');
      window.location.href = `/api/inventory/export?${qs.toString()}`;
    });
    $('btn-open-new-inv').addEventListener('click', () => {
      if (state.labs.length === 0) {
        showToast('Tambahkan minimal satu laboratorium terlebih dahulu sebelum mengisi inventaris.', 'error');
        switchView('labs');
        return;
      }
      openInvModal(null);
    });

    $('form-inv').addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = $('inv-form-id').value;
      const payload = {
        inventory_code: $('inv-input-code').value.trim(),
        lab_id: $('inv-input-lab').value,
        name: $('inv-input-name').value.trim(),
        category: $('inv-input-category').value.trim(),
        quantity: Number.parseInt($('inv-input-qty').value, 10),
        unit: $('inv-input-unit').value.trim(),
        condition: $('inv-input-condition').value,
        status: $('inv-input-status').value,
        notes: $('inv-input-notes').value.trim(),
      };

      try {
        if (!id) {
          await apiFetch('/api/inventory', { method: 'POST', body: payload });
          showToast(`Item inventaris ${payload.inventory_code} berhasil ditambahkan.`, 'success');
        } else {
          await apiFetch(`/api/inventory/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload });
          showToast(`Item inventaris ${payload.inventory_code} berhasil diperbarui.`, 'success');
        }
        $('modal-inv').classList.add('hidden');
        await loadInventory(state.invPage);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    // Excel Import 2-Step
    $('excel-preview-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fileInput = $('excel-file-input');
      const file = fileInput.files && fileInput.files[0];
      if (!file) {
        showToast('Pilih file Excel terlebih dahulu.', 'error');
        return;
      }

      const btn = $('btn-run-preview');
      btn.disabled = true;
      try {
        const arrayBuf = await file.arrayBuffer();
        const bytes = new Uint8Array(arrayBuf);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i += 1) {
          binary += String.fromCharCode(bytes[i]);
        }
        const fileBase64 = btoa(binary);

        const preview = await apiFetch('/api/inventory/import/preview', {
          method: 'POST',
          body: {
            file_name: file.name,
            file_base64: fileBase64,
          },
        });

        renderImportPreview(preview);
        showToast(
          `Pratinjau selesai: ${preview.valid_rows} baris valid, ${preview.failed_rows} baris gagal.`,
          preview.failed_rows > 0 ? 'info' : 'success'
        );
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        btn.disabled = false;
      }
    });

    $('btn-confirm-import').addEventListener('click', async () => {
      if (!state.currentImportJob) return;
      const conflictMode = $('import-conflict-mode').value;
      const btn = $('btn-confirm-import');
      btn.disabled = true;

      try {
        const res = await apiFetch('/api/inventory/import/confirm', {
          method: 'POST',
          body: {
            job_id: state.currentImportJob.job_id,
            conflict_mode: conflictMode,
          },
        });
        showToast(
          `Impor berhasil disimpan! Ditambahkan: ${res.inserted_rows}, Diperbarui: ${res.updated_rows}, Dilewati: ${res.skipped_rows}.`,
          'success'
        );
        resetImportPreview();
        await loadAuditView();
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false;
      }
    });

    $('btn-cancel-preview').addEventListener('click', () => {
      resetImportPreview();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    checkSession();
  });
})();
