/**
 * FHIP UKFE Modelling - Standalone Web Application
 * Pure Client-Side JavaScript (Zero Server / Zero R Dependencies)
 */

(function () {
  'use strict';

  // Global App State
  let appData = null;
  let stationsMap = {};
  let flowsByStation = {};
  let zdistsByStation = {};
  let poolingByStation = {};

  let currentStationId = '59001';
  let currentRegion = 'All UK';
  let currentPlotMode = 'Q';     // 'Q' or 'GF'
  let currentPlotScale = 'log';   // 'log' or 'linear'

  let leafletMap = null;
  let markersLayer = null;
  let activeMarker = null;
  let tomSelectInstance = null;

  let flowsDataTable = null;
  let poolingDataTable = null;
  let summaryDataTable = null;

  // ---------------------------------------------------------------------------
  // 1. App Initialization
  // ---------------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', async function () {
    try {
      await loadData();
      indexData();
      initUI();
      initMap();
      initSummaryTable();
      
      // Select initial default station
      const defaultId = stationsMap['59001'] ? '59001' : (appData.stations[0]?.station_id || '54014');
      selectStation(defaultId, false);
    } catch (err) {
      console.error('Initialization error:', err);
      alert('Error initializing dashboard data: ' + err.message);
    }
  });

  // ---------------------------------------------------------------------------
  // 2. Data Ingestion (Embedded JS or Fallback to JSON)
  // ---------------------------------------------------------------------------
  async function loadData() {
    if (window.FHIP_DATA) {
      appData = window.FHIP_DATA;
      return;
    }

    // Fallback: fetch JSON from server
    const resp = await fetch('data/stations_data.json');
    if (!resp.ok) throw new Error(`HTTP error! status: ${resp.status}`);
    appData = await resp.json();
  }

  function indexData() {
    // 1. Stations catalogue indexed by ID
    appData.stations.forEach(s => {
      s.station_id = String(s.station_id);
      stationsMap[s.station_id] = s;
    });

    // 2. Design flows grouped by station_id
    appData.design_flows.forEach(f => {
      const id = String(f.station_id);
      if (!flowsByStation[id]) flowsByStation[id] = [];
      flowsByStation[id].push(f);
    });

    // 3. Zdists indexed by station_id
    if (appData.zdists) {
      appData.zdists.forEach(z => {
        const id = String(z.station_id);
        zdistsByStation[id] = z;
      });
    }

    // 4. Pooling groups grouped by subject_station_id
    if (appData.pooling_groups) {
      appData.pooling_groups.forEach(p => {
        const id = String(p.subject_station_id);
        if (!poolingByStation[id]) poolingByStation[id] = [];
        poolingByStation[id].push(p);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 3. UI Controls & Event Listeners
  // ---------------------------------------------------------------------------
  function initUI() {
    // Tom Select for Station Search & Dropdown
    const selectEl = document.getElementById('stationSelect');
    tomSelectInstance = new TomSelect(selectEl, {
      valueField: 'id',
      labelField: 'label',
      searchField: ['label', 'id', 'name', 'river'],
      maxItems: 1,
      maxOptions: 600,
      create: false,
      onChange: function (value) {
        if (value && value !== currentStationId) {
          selectStation(value);
        }
      }
    });

    // Region Filter Change
    const regionEl = document.getElementById('regionFilter');
    regionEl.addEventListener('change', function () {
      currentRegion = this.value;
      updateStationDropdownChoices();
      updateMapMarkers();
    });

    updateStationDropdownChoices();

    // Plot View Mode Radio (Q vs GF)
    document.querySelectorAll('input[name="plotMode"]').forEach(radio => {
      radio.addEventListener('change', function () {
        currentPlotMode = this.value;
        renderFloodFrequencyPlot();
      });
    });

    // Plot Scale Mode Radio (Log-Log vs Semi-Log)
    document.querySelectorAll('input[name="plotScale"]').forEach(radio => {
      radio.addEventListener('change', function () {
        currentPlotScale = this.value;
        renderFloodFrequencyPlot();
      });
    });

    // Download Buttons
    document.getElementById('btnDlFlows').addEventListener('click', downloadCurrentFlowsCsv);
    document.getElementById('btnDlPooling').addEventListener('click', downloadCurrentPoolingCsv);
    document.getElementById('btnDlAllZip').addEventListener('click', downloadAllDataZip);
    document.getElementById('btnDlSummaryCsv').addEventListener('click', downloadSummaryTableCsv);

    // Bootstrap Tab switch resize trigger (ensures Plotly, Leaflet, and DataTables adjust smoothly)
    document.querySelectorAll('button[data-bs-toggle="tab"], button[data-bs-toggle="pill"]').forEach(tab => {
      tab.addEventListener('shown.bs.tab', function () {
        if (leafletMap) leafletMap.invalidateSize();
        Plotly.Plots.resize(document.getElementById('freqPlot'));
        Plotly.Plots.resize(document.getElementById('zdistsPlot'));

        // Re-align and adjust table column widths whenever a tab becomes visible
        setTimeout(function () {
          $.fn.dataTable.tables({ visible: true, api: true }).columns.adjust();
        }, 50);
      });
    });

    window.addEventListener('resize', function () {
      $.fn.dataTable.tables({ visible: true, api: true }).columns.adjust();
    });
  }

  function getFilteredStations() {
    if (!currentRegion || currentRegion === 'All UK') {
      return appData.stations;
    }
    return appData.stations.filter(s => s.region_group === currentRegion);
  }

  function updateStationDropdownChoices() {
    const filtered = getFilteredStations();
    tomSelectInstance.clearOptions();
    
    const options = filtered.map(s => ({
      id: s.station_id,
      label: `${s.station_id} - ${s.station_name} (${s.river})`,
      name: s.station_name,
      river: s.river
    }));
    
    tomSelectInstance.addOptions(options);

    // If current station is not in filtered list, select the first available
    const exists = filtered.some(s => s.station_id === currentStationId);
    if (!exists && filtered.length > 0) {
      selectStation(filtered[0].station_id, false);
    } else if (exists) {
      tomSelectInstance.setValue(currentStationId, true);
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Station Selection & Reactive Updates
  // ---------------------------------------------------------------------------
  function selectStation(stationId, panMap = true) {
    stationId = String(stationId);
    if (!stationsMap[stationId]) return;

    currentStationId = stationId;
    tomSelectInstance.setValue(stationId, true);

    const stn = stationsMap[stationId];
    renderStationQuickInfo(stn);
    renderDesignFlowsTable(stationId);
    renderFloodFrequencyPlot();
    renderZdistsPlot(stn);
    renderPoolingGroupTable(stationId);

    // Update map marker active state & pan if requested
    if (leafletMap && stn.latitude && stn.longitude) {
      updateActiveMarker(stn);
      if (panMap) {
        if (leafletMap.getZoom() < 8) {
          leafletMap.setView([stn.latitude, stn.longitude], 8);
        } else {
          leafletMap.panTo([stn.latitude, stn.longitude]);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Sidebar: Station Quick Info Card
  // ---------------------------------------------------------------------------
  function renderStationQuickInfo(stn) {
    const infoContainer = document.getElementById('stationQuickInfo');
    const nrfaUrl = `https://nrfa.ceh.ac.uk/data/station/info/${stn.station_id}`;

    infoContainer.innerHTML = `
      <div class="d-flex justify-content-between align-items-center mb-1">
        <strong class="text-primary">Station ${stn.station_id}</strong>
        <a href="${nrfaUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-outline-primary btn-sm py-0 px-2" style="font-size: 0.78rem; text-decoration: none;">
          <i class="fas fa-arrow-up-right-from-square"></i> NRFA Page
        </a>
      </div>
      <div>
        <div><b>Name:</b> ${stn.station_name || 'N/A'}</div>
        <div><b>River:</b> ${stn.river || 'N/A'}</div>
        <div><b>Area:</b> ${stn.catchment_area ? (parseFloat(stn.catchment_area).toFixed(1) + ' km²') : 'N/A'}</div>
        <div><b>Authority:</b> ${stn.measuring_authority_id || 'N/A'}</div>
        <div><b>Coordinates:</b> ${parseFloat(stn.latitude).toFixed(4)}°N, ${parseFloat(stn.longitude).toFixed(4)}°E</div>
      </div>
    `;
  }

  // ---------------------------------------------------------------------------
  // 6. Interactive Leaflet Map
  // ---------------------------------------------------------------------------
  function initMap() {
    // Initial center on whole UK at zoom 6
    leafletMap = L.map('map', {
      center: [54.5, -3.8],
      zoom: 6,
      zoomControl: true
    });

    const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    });

    const esriLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Tiles &copy; Esri'
    });

    osmLayer.addTo(leafletMap);

    L.control.layers({
      "OpenStreetMap": osmLayer,
      "Esri Topo": esriLayer
    }).addTo(leafletMap);

    markersLayer = L.layerGroup().addTo(leafletMap);
    updateMapMarkers();
  }

  function updateMapMarkers() {
    if (!markersLayer) return;
    markersLayer.clearLayers();

    const stations = getFilteredStations();
    const latLngs = [];

    stations.forEach(s => {
      if (!s.latitude || !s.longitude) return;
      const lat = parseFloat(s.latitude);
      const lng = parseFloat(s.longitude);
      latLngs.push([lat, lng]);

      const marker = L.circleMarker([lat, lng], {
        radius: 6,
        color: '#004b57',
        weight: 1.2,
        fillColor: '#0092a6',
        fillOpacity: 0.8
      });

      marker.bindTooltip(`<b>${s.station_id}</b>: ${s.station_name}<br>River: ${s.river}`);
      marker.on('click', () => selectStation(s.station_id, true));

      markersLayer.addLayer(marker);
    });

    if (latLngs.length > 0) {
      if (currentRegion === 'All UK') {
        leafletMap.setView([54.5, -3.8], 6);
      } else {
        leafletMap.fitBounds(latLngs, { padding: [30, 30], maxZoom: 9 });
      }
    }

    const currentStn = stationsMap[currentStationId];
    if (currentStn) updateActiveMarker(currentStn);
  }

  function updateActiveMarker(stn) {
    if (!leafletMap || !stn.latitude || !stn.longitude) return;

    if (activeMarker) {
      leafletMap.removeLayer(activeMarker);
    }

    activeMarker = L.circleMarker([stn.latitude, stn.longitude], {
      radius: 10,
      color: '#e63946',
      weight: 3,
      fillColor: '#ffbe0b',
      fillOpacity: 0.95
    }).addTo(leafletMap);

    activeMarker.bindTooltip(`<b>Active: ${stn.station_name}</b> (${stn.station_id})`);
  }

  // ---------------------------------------------------------------------------
  // 7. Design Flows Data Table
  // ---------------------------------------------------------------------------
  function renderDesignFlowsTable(stationId) {
    const flows = flowsByStation[stationId] || [];
    
    // Sort ascending by Return Period
    const sortedFlows = [...flows].sort((a, b) => parseFloat(a.RP) - parseFloat(b.RP));

    if ($.fn.DataTable.isDataTable('#flowsTable')) {
      flowsDataTable.clear().destroy();
    }

    const tableBody = document.querySelector('#flowsTable tbody');
    tableBody.innerHTML = '';

    sortedFlows.forEach(f => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><b>${f.RP}</b></td>
        <td>${parseFloat(f.Q).toFixed(1)}</td>
        <td>${parseFloat(f.GF).toFixed(3)}</td>
        <td>${parseFloat(f.FSE).toFixed(3)}</td>
        <td>${parseFloat(f.Lower95).toFixed(1)}</td>
        <td>${parseFloat(f.Upper95).toFixed(1)}</td>
      `;
      tableBody.appendChild(tr);
    });

    flowsDataTable = $('#flowsTable').DataTable({
      dom: 't',
      paging: false,
      searching: false,
      ordering: false,
      info: false
    });
  }

  // ---------------------------------------------------------------------------
  // 8. Flood Frequency & Growth Curve Plot (Plotly)
  // ---------------------------------------------------------------------------
  function renderFloodFrequencyPlot() {
    const plotDiv = document.getElementById('freqPlot');
    const flows = flowsByStation[currentStationId] || [];
    if (flows.length === 0) {
      Plotly.purge(plotDiv);
      return;
    }

    const stn = stationsMap[currentStationId] || {};
    const stnName = stn.station_name || currentStationId;
    const distName = stn.chosen_distribution || 'Pooled';
    const isLogY = (currentPlotScale === 'log');

    // Sort flows by return period
    const sortedFlows = [...flows].sort((a, b) => parseFloat(a.RP) - parseFloat(b.RP));
    const rps = sortedFlows.map(f => parseFloat(f.RP));

    let traces = [];
    let layout = {
      template: 'plotly_white',
      margin: { l: 80, r: 30, t: 65, b: 60 },
      hovermode: 'x unified',
      xaxis: {
        title: 'Return Period (years, log scale)',
        type: 'log',
        tickvals: [2, 5, 10, 20, 30, 50, 75, 100, 200, 500, 1000],
        gridcolor: '#f0f2f5'
      }
    };

    if (currentPlotMode === 'GF') {
      const gfs = sortedFlows.map(f => parseFloat(f.GF));

      traces = [
        {
          x: rps,
          y: gfs,
          type: 'scatter',
          mode: 'lines',
          name: 'Growth Factor (GF)',
          line: { color: '#0092a6', width: 3 },
          hovertemplate: 'Growth Factor: %{y:.2f}<extra></extra>'
        },
        {
          x: rps,
          y: gfs,
          type: 'scatter',
          mode: 'markers',
          name: 'GF Points',
          marker: { color: '#004b57', size: 8 },
          hovertemplate: 'Return Period: %{x} yrs<br>Growth Factor: %{y:.2f}<extra></extra>'
        }
      ];

      layout.title = {
        text: `Pooled Growth Curve: ${stnName} (${currentStationId})`,
        font: { size: 15, color: '#004b57' }
      };
      layout.yaxis = {
        title: isLogY ? 'Growth Factor (x QMED, log scale)' : 'Growth Factor (x QMED)',
        type: isLogY ? 'log' : 'linear',
        gridcolor: '#f0f2f5'
      };
      layout.showlegend = false;

    } else {
      // Design Flow (Q) with 95% Confidence Interval Ribbon
      const qs = sortedFlows.map(f => parseFloat(f.Q));
      const lowers = sortedFlows.map(f => parseFloat(f.Lower95));
      const uppers = sortedFlows.map(f => parseFloat(f.Upper95));
      const ciLabels = sortedFlows.map(f => `[${parseFloat(f.Lower95).toFixed(1)}, ${parseFloat(f.Upper95).toFixed(1)}] m³/s`);

      // Ribbon: trace for lower bound, then trace for upper bound filling to lower
      const lowerTrace = {
        x: rps,
        y: lowers,
        type: 'scatter',
        mode: 'lines',
        line: { color: 'rgba(0, 146, 166, 0.3)', width: 1, dash: 'dot' },
        showlegend: false,
        hoverinfo: 'none'
      };

      const upperTrace = {
        x: rps,
        y: uppers,
        type: 'scatter',
        mode: 'lines',
        fill: 'tonexty',
        fillcolor: 'rgba(0, 146, 166, 0.2)',
        line: { color: 'rgba(0, 146, 166, 0.3)', width: 1, dash: 'dot' },
        name: '95% Confidence Interval',
        hoverinfo: 'none'
      };

      const qLineTrace = {
        x: rps,
        y: qs,
        type: 'scatter',
        mode: 'lines',
        name: `Design Flow (${distName})`,
        line: { color: '#0092a6', width: 3 },
        customdata: ciLabels,
        hovertemplate: 'Design Flow: %{y:.1f} m³/s<br>95% CI: %{customdata}<extra></extra>'
      };

      const qMarkerTrace = {
        x: rps,
        y: qs,
        type: 'scatter',
        mode: 'markers',
        name: 'Design Flows',
        marker: { color: '#004b57', size: 8 },
        customdata: ciLabels,
        hovertemplate: 'Return Period: %{x} yrs<br>Design Flow: %{y:.1f} m³/s<br>95% CI: %{customdata}<extra></extra>'
      };

      traces = [lowerTrace, upperTrace, qLineTrace, qMarkerTrace];

      layout.title = {
        text: `Flood Frequency Curve: ${stnName} (${currentStationId})`,
        font: { size: 15, color: '#004b57' }
      };
      layout.yaxis = {
        title: isLogY ? 'Design Flow Q (m³/s, log scale)' : 'Design Flow Q (m³/s)',
        type: isLogY ? 'log' : 'linear',
        gridcolor: '#f0f2f5'
      };
      layout.legend = { orientation: 'h', x: 0.5, xanchor: 'center', y: 1.08 };
      layout.showlegend = true;
    }

    Plotly.react(plotDiv, traces, layout, { responsive: true, displaylogo: false });
  }

  // ---------------------------------------------------------------------------
  // 9. Goodness-of-Fit Zdists Plot (Plotly)
  // ---------------------------------------------------------------------------
  function renderZdistsPlot(stn) {
    const plotDiv = document.getElementById('zdistsPlot');
    const zd = zdistsByStation[stn.station_id];

    if (!zd) {
      plotDiv.innerHTML = `<p class="text-muted p-3">Z-distance diagnostics details are not available for this station. Chosen distribution: <b>${stn.chosen_distribution}</b></p>`;
      return;
    }

    const dists = ['GEV', 'GenLog', 'Gumbel', 'Kappa3'];
    const zdData = dists.map(d => {
      const val = zd[d] !== undefined ? parseFloat(zd[d]) : NaN;
      return {
        dist: d,
        z: val,
        absZ: Math.abs(val),
        isChosen: (d === stn.chosen_distribution)
      };
    }).filter(d => !isNaN(d.z));

    // Sort by absolute Z ascending
    zdData.sort((a, b) => a.absZ - b.absZ);

    const minAbs = zdData.length > 0 ? zdData[0].absZ : 0;
    document.getElementById('zdistsBannerText').innerHTML = `
      Best-fit model selected by minimum absolute Z-score: <b>${stn.chosen_distribution}</b> (|Z| = ${minAbs.toFixed(3)}).
      Values below the 1.645 threshold line represent acceptable statistical fits.
    `;

    const maxAbsVal = Math.max(2.5, ...zdData.map(d => d.absZ + 0.5));

    const barTrace = {
      x: zdData.map(d => d.dist),
      y: zdData.map(d => d.absZ),
      type: 'bar',
      name: '|Z| Score',
      marker: {
        color: zdData.map(d => d.isChosen ? '#0092a6' : '#b0c4de')
      },
      hovertemplate: 'Distribution: %{x}<br>|Z|: %{y:.3f}<extra></extra>'
    };

    const layout = {
      title: {
        text: 'Candidate Distribution Z-Distances (|Z|)',
        font: { size: 14, color: '#004b57' }
      },
      xaxis: { title: 'Candidate Distribution' },
      yaxis: {
        title: 'Absolute Z-Score |Z|',
        range: [0, maxAbsVal]
      },
      template: 'plotly_white',
      margin: { l: 60, r: 30, t: 45, b: 45 },
      shapes: [
        {
          type: 'line',
          x0: 0,
          x1: 1,
          xref: 'paper',
          y0: 1.645,
          y1: 1.645,
          yref: 'y',
          line: { color: '#e63946', dash: 'dash', width: 2 }
        }
      ],
      annotations: [
        {
          x: 1,
          y: 1.645,
          xref: 'paper',
          yref: 'y',
          text: 'Acceptable Threshold (|Z| = 1.645)',
          showarrow: false,
          xanchor: 'right',
          yanchor: 'bottom',
          font: { color: '#e63946', size: 11 }
        }
      ],
      showlegend: false
    };

    Plotly.react(plotDiv, [barTrace], layout, { responsive: true, displaylogo: false });
  }

  // ---------------------------------------------------------------------------
  // 10. Pooling Group Stations Table
  // ---------------------------------------------------------------------------
  function renderPoolingGroupTable(stationId) {
    const donors = poolingByStation[stationId] || [];

    // Summary numbers
    const donorCount = donors.length;
    let totalYears = 0;
    donors.forEach(d => {
      const n = parseFloat(d.N);
      if (!isNaN(n)) totalYears += n;
    });

    document.getElementById('statDonorCount').textContent = donorCount;
    document.getElementById('statDonorYears').textContent = `${Math.round(totalYears)} years`;

    if ($.fn.DataTable.isDataTable('#poolingTable')) {
      poolingDataTable.clear().destroy();
    }

    const tableBody = document.querySelector('#poolingTable tbody');
    tableBody.innerHTML = '';

    donors.forEach(d => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><b>${d.donor_station_id}</b></td>
        <td>${parseFloat(d.SDM || 0).toFixed(3)}</td>
        <td>${parseFloat(d.AREA || 0).toFixed(1)}</td>
        <td>${parseFloat(d.SAAR9120 || 0).toFixed(1)}</td>
        <td>${parseFloat(d.FARL2015 || 0).toFixed(3)}</td>
        <td>${parseFloat(d.URBEXT2015 || 0).toFixed(4)}</td>
        <td>${parseFloat(d.Lcv || 0).toFixed(3)}</td>
        <td>${parseFloat(d.LSkew || 0).toFixed(3)}</td>
        <td>${parseFloat(d.QMED || 0).toFixed(1)}</td>
        <td>${parseFloat(d.N || 0).toFixed(0)}</td>
        <td>${parseFloat(d.Discordancy || 0).toFixed(3)}</td>
        <td>${parseFloat(d.PercentNonFlood || 0).toFixed(1)}%</td>
      `;
      tableBody.appendChild(tr);
    });

    poolingDataTable = $('#poolingTable').DataTable({
      pageLength: 8,
      lengthChange: false,
      scrollX: true,
      autoWidth: false,
      order: [[1, 'asc']]
    });

    setTimeout(function () {
      if (poolingDataTable) poolingDataTable.columns.adjust();
    }, 50);
  }

  // ---------------------------------------------------------------------------
  // 11. National Summary Table (Catalogue)
  // ---------------------------------------------------------------------------
  function initSummaryTable() {
    if ($.fn.DataTable.isDataTable('#summaryTable')) return;

    const tableBody = document.querySelector('#summaryTable tbody');
    tableBody.innerHTML = '';

    appData.stations.forEach(s => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><b>${s.station_id}</b></td>
        <td>${s.station_name || ''}</td>
        <td>${s.river || ''}</td>
        <td>${parseFloat(s.catchment_area || 0).toFixed(1)}</td>
        <td><span class="badge bg-light text-dark border">${s.measuring_authority_id || ''}</span></td>
        <td>${parseFloat(s.QMED_observed || 0).toFixed(1)}</td>
        <td>${parseFloat(s.UAF || 1).toFixed(3)}</td>
        <td><span class="badge bg-primary">${s.chosen_distribution || 'N/A'}</span></td>
        <td>${s.Q_2 ? parseFloat(s.Q_2).toFixed(1) : '-'}</td>
        <td>${s.Q_10 ? parseFloat(s.Q_10).toFixed(1) : '-'}</td>
        <td>${s.Q_50 ? parseFloat(s.Q_50).toFixed(1) : '-'}</td>
        <td>${s.Q_100 ? parseFloat(s.Q_100).toFixed(1) : '-'}</td>
        <td>${s.Q_1000 ? parseFloat(s.Q_1000).toFixed(1) : '-'}</td>
      `;
      tableBody.appendChild(tr);
    });

    summaryDataTable = $('#summaryTable').DataTable({
      pageLength: 15,
      scrollX: true,
      autoWidth: false,
      order: [[0, 'asc']]
    });

    setTimeout(function () {
      if (summaryDataTable) summaryDataTable.columns.adjust();
    }, 50);
  }

  // ---------------------------------------------------------------------------
  // 12. Client-Side CSV & ZIP Downloads
  // ---------------------------------------------------------------------------
  function downloadCsv(content, filename) {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    saveAs(blob, filename);
  }

  function downloadCurrentFlowsCsv() {
    const flows = flowsByStation[currentStationId] || [];
    if (flows.length === 0) return;

    const headers = ['Return Period (yrs)', 'Design Flow (m3/s)', 'Growth Factor', 'FSE', 'Lower 95% CI', 'Upper 95% CI'];
    const rows = flows.map(f => [f.RP, f.Q, f.GF, f.FSE, f.Lower95, f.Upper95].join(','));
    const csv = [headers.join(','), ...rows].join('\n');

    downloadCsv(csv, `${currentStationId}_design_flows_and_CIs.csv`);
  }

  function downloadCurrentPoolingCsv() {
    const donors = poolingByStation[currentStationId] || [];
    if (donors.length === 0) return;

    const keys = Object.keys(donors[0]);
    const rows = donors.map(d => keys.map(k => `"${d[k] || ''}"`).join(','));
    const csv = [keys.join(','), ...rows].join('\n');

    downloadCsv(csv, `${currentStationId}_pooling_group.csv`);
  }

  function downloadSummaryTableCsv() {
    const stns = appData.stations;
    if (!stns || stns.length === 0) return;

    const keys = Object.keys(stns[0]);
    const rows = stns.map(s => keys.map(k => `"${s[k] || ''}"`).join(','));
    const csv = [keys.join(','), ...rows].join('\n');

    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    downloadCsv(csv, `FHIP_UKFE_Stations_Summary_${dateStr}.csv`);
  }

  async function downloadAllDataZip() {
    const zip = new JSZip();

    // Fetch raw CSVs or generate them from in-memory objects
    try {
      const summaryResp = await fetch('data/csv/all_stations_summary.csv');
      const flowsResp = await fetch('data/csv/all_design_flows.csv');
      const pgsResp = await fetch('data/csv/all_pooling_groups.csv');
      const zdResp = await fetch('data/csv/all_zdists.csv');

      if (summaryResp.ok) zip.file('all_stations_summary.csv', await summaryResp.text());
      if (flowsResp.ok) zip.file('all_design_flows.csv', await flowsResp.text());
      if (pgsResp.ok) zip.file('all_pooling_groups.csv', await pgsResp.text());
      if (zdResp.ok) zip.file('all_zdists.csv', await zdResp.text());
    } catch (e) {
      // Fallback: generate CSV from appData
      zip.file('all_stations_summary.csv', jsonToCsv(appData.stations));
      zip.file('all_design_flows.csv', jsonToCsv(appData.design_flows));
      zip.file('all_pooling_groups.csv', jsonToCsv(appData.pooling_groups));
      zip.file('all_zdists.csv', jsonToCsv(appData.zdists));
    }

    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const blob = await zip.generateAsync({ type: 'blob' });
    saveAs(blob, `FHIP_UKFE_All_Study_Results_${dateStr}.zip`);
  }

  function jsonToCsv(arr) {
    if (!arr || arr.length === 0) return '';
    const keys = Object.keys(arr[0]);
    const rows = arr.map(obj => keys.map(k => `"${obj[k] || ''}"`).join(','));
    return [keys.join(','), ...rows].join('\n');
  }

})();
