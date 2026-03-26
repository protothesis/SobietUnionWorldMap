/* ============================================================
   Minecraft Atlas — app.js
   Leaflet-based interactive map viewer with marker management.
   ============================================================ */

'use strict';

// ── Constants ──────────────────────────────────────────────────────────────

const API_BASE = '/api';

const ICONS = [
  '📍','🏠','⚔️','🏰','🌲','⛏️','💎','🔥','🌊','🏔️',
  '🐉','🧱','⚙️','🗺️','🏺','🔮','🌿','🎯','⚠️','🏕️',
  '🛖','🐑','🐄','🐺','🌾','🪨','🌋','❄️','🕳️','🗿',
];

const DEFAULT_ICON  = '📍';
const DEFAULT_COLOR = '#e8c97a';

// ── State ──────────────────────────────────────────────────────────────────

let mapInstance   = null;
let allMaps       = [];
let allMarkers    = [];   // raw data from API
let markerLayer   = null; // L.MarkerClusterGroup
let leafletMarkers = {};  // id → L.Marker
let activeMarkerId = null;
let addMode       = false;
let ghostMarker   = null;
let activeTags    = new Set();
let pendingNewCoords = null;   // {x, z} waiting for modal submit

// ── Leaflet init ───────────────────────────────────────────────────────────

function initMap() {
  mapInstance = L.map('map', {
    crs: L.CRS.Simple,
    minZoom: -6,
    maxZoom: 3,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    attributionControl: false,
    zoomControl: true,
  });

  // Move zoom control away from default position
  mapInstance.zoomControl.setPosition('bottomright');

  markerLayer = L.markerClusterGroup({
    maxClusterRadius: 60,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    zoomToBoundsOnClick: true,
    disableClusteringAtZoom: 2,
  });
  mapInstance.addLayer(markerLayer);

  // Coord display on mouse move
  mapInstance.on('mousemove', (e) => {
    const x = Math.round(e.latlng.lng);
    const z = Math.round(-e.latlng.lat);  // negate: Leaflet lat = -Z
    document.getElementById('coord-display').innerHTML =
      `x: <strong>${x}</strong> &nbsp; z: <strong>${z}</strong>`;

    if (addMode && ghostMarker) {
      ghostMarker.setLatLng(e.latlng);
    }
  });

  // Right-click = place marker
  mapInstance.on('contextmenu', (e) => {
    e.originalEvent.preventDefault();
    openNewMarkerModal(e.latlng);
  });

  // Left-click in add mode = place marker
  mapInstance.on('click', (e) => {
    if (addMode) {
      openNewMarkerModal(e.latlng);
    }
  });

  mapInstance.on('zoom', updateScaleLegend);
}

// ── Map tile loading ───────────────────────────────────────────────────────

async function loadMapTiles() {
  try {
    const res = await fetch('data/maps.json');
    const data = await res.json();
    allMaps = Array.isArray(data) ? data : (data.maps || []);
  } catch (err) {
    console.warn('Could not load maps.json, continuing without tiles.', err);
    allMaps = [];
  }

  if (!allMaps.length) {
    showEmptyState();
    return;
  }

  // Place image overlays, largest scale first (so detail maps render on top)
  const boundsAll = [];
  allMaps.forEach((m) => {
    const b = m.bounds;
    // Leaflet uses [lat, lng] → [-z, x]
    // Z is negated because Minecraft Z increases southward (down) but Leaflet lat
    // increases upward, so we flip to get north at the top.
    const sw = [-b.zMax, b.xMin];
    const ne = [-b.zMin, b.xMax];
    const leafletBounds = L.latLngBounds(sw, ne);

    L.imageOverlay('data/' + m.file, leafletBounds, {
      opacity:     1,
      interactive: false,
      className:   'map-tile',
    }).addTo(mapInstance);

    boundsAll.push(leafletBounds);
  });

  // Fit view to all maps combined.
  // Use a fresh LatLngBounds as the initial accumulator so that extend() never
  // mutates a tile's own bounds object (which imageOverlay holds by reference).
  const combinedBounds = boundsAll.reduce((acc, b) => acc.extend(b), L.latLngBounds());
  mapInstance.fitBounds(combinedBounds, { padding: [40, 40] });

  updateScaleLegend();
}

function showEmptyState() {
  const el = document.createElement('div');
  el.style.cssText = `
    position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
    color: var(--text-muted); font-family: var(--font-display);
    font-size:14px; letter-spacing:0.15em; text-align:center;
    pointer-events:none; z-index:500;
  `;
  el.innerHTML = `
    <div style="font-size:48px;margin-bottom:16px;opacity:0.3">🗺️</div>
    NO MAP DATA FOUND<br>
    <span style="font-family:var(--font-body);font-size:13px;letter-spacing:0;opacity:0.6">
      Run the parser to generate tiles, then refresh.
    </span>
  `;
  document.body.appendChild(el);
}

// ── Markers ────────────────────────────────────────────────────────────────

async function loadMarkers() {
  try {
    const res = await fetch('data/markers.json');
    allMarkers = await res.json();
  } catch {
    allMarkers = [];
  }
  renderAllMarkers();
  buildTagBar();
}

function makeLeafletIcon(icon, color) {
  const svg = `
    <div class="atlas-marker" style="background:${color}">
      <span class="atlas-marker-inner">${icon}</span>
    </div>`;
  return L.divIcon({
    html: svg,
    className: '',
    iconSize:   [32, 32],
    iconAnchor: [16, 32],
    popupAnchor:[0, -34],
  });
}

function renderAllMarkers() {
  markerLayer.clearLayers();
  leafletMarkers = {};

  const filtered = activeTags.size
    ? allMarkers.filter(m => m.tags && m.tags.some(t => activeTags.has(t)))
    : allMarkers;

  filtered.forEach((m) => {
    const lm = L.marker([-m.z, m.x], {  // negate Z: Leaflet lat = -Z
      icon:      makeLeafletIcon(m.icon || DEFAULT_ICON, m.color || DEFAULT_COLOR),
      title:     m.title,
      riseOnHover: true,
    });

    lm.on('click', () => openPanel(m.id));
    leafletMarkers[m.id] = lm;
    markerLayer.addLayer(lm);
  });
}

function getMarkerById(id) {
  return allMarkers.find(m => m.id === id);
}

// ── Panel ──────────────────────────────────────────────────────────────────

function openPanel(markerId) {
  const marker = getMarkerById(markerId);
  if (!marker) return;

  activeMarkerId = markerId;

  // Highlight selected marker
  Object.entries(leafletMarkers).forEach(([id, lm]) => {
    const el = lm.getElement();
    if (el) el.querySelector('.atlas-marker')?.classList.toggle('selected', id === markerId);
  });

  // Populate view
  document.getElementById('panel-icon-display').textContent = marker.icon || DEFAULT_ICON;
  document.getElementById('panel-title').textContent        = marker.title || 'Untitled';
  document.getElementById('panel-coords').textContent       = `x: ${marker.x}  z: ${marker.z}`;

  const tagsEl = document.getElementById('panel-tags');
  tagsEl.innerHTML = '';
  (marker.tags || []).forEach(t => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.textContent = t;
    chip.onclick = () => toggleTagFilter(t);
    tagsEl.appendChild(chip);
  });

  const bodyEl = document.getElementById('panel-body-view');
  if (marker.body && marker.body.trim()) {
    bodyEl.innerHTML = marked.parse(marker.body);
    bodyEl.querySelectorAll('a').forEach(a => a.setAttribute('target', '_blank'));
  } else {
    bodyEl.innerHTML = '<p class="empty-body">No notes yet. Click ✏ to add some.</p>';
  }

  // Ensure view mode
  showPanelView();

  // Open panel
  document.getElementById('info-panel').classList.add('panel-open');
  document.getElementById('map').classList.add('panel-open');

  // Pan map to marker
  mapInstance.panTo([-marker.z, marker.x], { animate: true, duration: 0.4 });  // negate Z: Leaflet lat = -Z
}

function closePanel() {
  activeMarkerId = null;
  document.getElementById('info-panel').classList.remove('panel-open');
  document.getElementById('map').classList.remove('panel-open');
  // Deselect all
  Object.values(leafletMarkers).forEach(lm => {
    lm.getElement()?.querySelector('.atlas-marker')?.classList.remove('selected');
  });
}

function showPanelView() {
  document.getElementById('panel-body-view').classList.remove('hidden');
  document.getElementById('panel-edit-form').classList.add('hidden');
}

function showPanelEdit() {
  const marker = getMarkerById(activeMarkerId);
  if (!marker) return;

  document.getElementById('edit-title').value = marker.title || '';
  document.getElementById('edit-color').value = marker.color || DEFAULT_COLOR;
  document.getElementById('edit-tags').value  = (marker.tags || []).join(', ');
  document.getElementById('edit-body').value  = marker.body || '';
  document.getElementById('edit-preview').classList.add('hidden');
  document.getElementById('edit-body').classList.remove('hidden');

  initIconPicker('icon-picker', marker.icon || DEFAULT_ICON);

  // Reset tab
  document.querySelectorAll('#editor-tabs .editor-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === 'write');
  });

  document.getElementById('panel-body-view').classList.add('hidden');
  document.getElementById('panel-edit-form').classList.remove('hidden');
}

// ── Marker CRUD ────────────────────────────────────────────────────────────

async function saveMarkerEdits() {
  const marker = getMarkerById(activeMarkerId);
  if (!marker) return;

  const payload = {
    title: document.getElementById('edit-title').value.trim() || 'Untitled',
    icon:  getSelectedIcon('icon-picker'),
    color: document.getElementById('edit-color').value,
    body:  document.getElementById('edit-body').value,
    tags:  document.getElementById('edit-tags').value
      .split(',').map(t => t.trim()).filter(Boolean),
  };

  try {
    const res = await fetch(`${API_BASE}/markers/${activeMarkerId}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const updated = await res.json();

    // Update local state
    const idx = allMarkers.findIndex(m => m.id === activeMarkerId);
    if (idx !== -1) allMarkers[idx] = updated;

    // Re-render marker icon
    const lm = leafletMarkers[activeMarkerId];
    if (lm) lm.setIcon(makeLeafletIcon(updated.icon || DEFAULT_ICON, updated.color || DEFAULT_COLOR));

    buildTagBar();
    openPanel(activeMarkerId);  // refresh view
  } catch (err) {
    console.error('Save failed:', err);
    alert('Failed to save. Is the server running?');
  }
}

async function deleteMarker(id) {
  if (!confirm('Delete this marker?')) return;
  try {
    await fetch(`${API_BASE}/markers/${id}`, { method: 'DELETE' });
    allMarkers = allMarkers.filter(m => m.id !== id);
    const lm = leafletMarkers[id];
    if (lm) markerLayer.removeLayer(lm);
    delete leafletMarkers[id];
    buildTagBar();
    closePanel();
  } catch (err) {
    console.error('Delete failed:', err);
  }
}

async function createMarker(x, z) {
  const payload = {
    x,
    z,
    title: document.getElementById('new-title').value.trim() || 'Untitled',
    icon:  getSelectedIcon('modal-icon-picker'),
    color: document.getElementById('new-color').value,
    tags:  document.getElementById('new-tags').value
      .split(',').map(t => t.trim()).filter(Boolean),
    body: '',
  };

  try {
    const res = await fetch(`${API_BASE}/markers`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const newMarker = await res.json();
    allMarkers.push(newMarker);

    const lm = L.marker([-newMarker.z, newMarker.x], {  // negate Z: Leaflet lat = -Z
      icon:        makeLeafletIcon(newMarker.icon || DEFAULT_ICON, newMarker.color || DEFAULT_COLOR),
      title:       newMarker.title,
      riseOnHover: true,
    });
    lm.on('click', () => openPanel(newMarker.id));
    leafletMarkers[newMarker.id] = lm;
    markerLayer.addLayer(lm);

    buildTagBar();
    closeModal();
    disableAddMode();
    openPanel(newMarker.id);
  } catch (err) {
    console.error('Create failed:', err);
    alert('Failed to create marker. Is the server running?');
  }
}

// ── New marker modal ───────────────────────────────────────────────────────

function openNewMarkerModal(latlng) {
  pendingNewCoords = { x: Math.round(latlng.lng), z: Math.round(-latlng.lat) };  // negate: Leaflet lat = -Z

  document.getElementById('modal-coords').textContent =
    `x: ${pendingNewCoords.x}  z: ${pendingNewCoords.z}`;
  document.getElementById('new-title').value = '';
  document.getElementById('new-tags').value  = '';
  document.getElementById('new-color').value = DEFAULT_COLOR;

  initIconPicker('modal-icon-picker', DEFAULT_ICON);

  document.getElementById('modal-overlay').classList.remove('hidden');
  setTimeout(() => document.getElementById('new-title').focus(), 50);
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  pendingNewCoords = null;
}

// ── Add mode ───────────────────────────────────────────────────────────────

function toggleAddMode() {
  addMode ? disableAddMode() : enableAddMode();
}

function enableAddMode() {
  addMode = true;
  document.getElementById('btn-add-mode').classList.add('active');
  document.getElementById('map').classList.add('add-mode');

  // Create ghost marker that follows cursor
  ghostMarker = L.marker([0, 0], {
    icon: makeLeafletIcon(DEFAULT_ICON, DEFAULT_COLOR + '88'),
    interactive: false,
    zIndexOffset: 1000,
  });
  ghostMarker.getElement && ghostMarker.addTo(mapInstance);
  ghostMarker.addTo(mapInstance);
  ghostMarker.getElement()?.classList.add('ghost-marker');
}

function disableAddMode() {
  addMode = false;
  document.getElementById('btn-add-mode').classList.remove('active');
  document.getElementById('map').classList.remove('add-mode');
  if (ghostMarker) {
    mapInstance.removeLayer(ghostMarker);
    ghostMarker = null;
  }
}

// ── Icon picker ────────────────────────────────────────────────────────────

function initIconPicker(containerId, selectedIcon) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'icon-picker-grid';

  ICONS.forEach(icon => {
    const btn = document.createElement('div');
    btn.className = 'icon-option' + (icon === selectedIcon ? ' selected' : '');
    btn.textContent = icon;
    btn.title = icon;
    btn.onclick = () => {
      grid.querySelectorAll('.icon-option').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    };
    grid.appendChild(btn);
  });

  container.appendChild(grid);
}

function getSelectedIcon(containerId) {
  const selected = document.getElementById(containerId)
    .querySelector('.icon-option.selected');
  return selected ? selected.textContent : DEFAULT_ICON;
}

// ── Tag filter bar ─────────────────────────────────────────────────────────

function buildTagBar() {
  const allTags = new Set();
  allMarkers.forEach(m => (m.tags || []).forEach(t => allTags.add(t)));

  const bar = document.getElementById('tag-bar');
  bar.innerHTML = '';

  if (!allTags.size) return;

  allTags.forEach(tag => {
    const btn = document.createElement('button');
    btn.className = 'tag-filter-btn' + (activeTags.has(tag) ? ' active' : '');
    btn.textContent = `# ${tag}`;
    btn.onclick = () => toggleTagFilter(tag);
    bar.appendChild(btn);
  });
}

function toggleTagFilter(tag) {
  activeTags.has(tag) ? activeTags.delete(tag) : activeTags.add(tag);
  renderAllMarkers();
  buildTagBar();
}

// ── Search ─────────────────────────────────────────────────────────────────

function initSearch() {
  const input   = document.getElementById('search-input');
  const results = document.getElementById('search-results');

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { results.classList.remove('open'); return; }

    const hits = allMarkers.filter(m =>
      m.title.toLowerCase().includes(q) ||
      (m.tags || []).some(t => t.toLowerCase().includes(q)) ||
      (m.body || '').toLowerCase().includes(q)
    ).slice(0, 8);

    results.innerHTML = '';
    if (!hits.length) { results.classList.remove('open'); return; }

    hits.forEach(m => {
      const item = document.createElement('div');
      item.className = 'search-result-item';
      item.innerHTML = `
        <span class="result-icon">${m.icon || DEFAULT_ICON}</span>
        <div>
          <div class="result-title">${escHtml(m.title)}</div>
          <div class="result-coords">x: ${m.x}  z: ${m.z}</div>
        </div>`;
      item.onclick = () => {
        results.classList.remove('open');
        input.value = '';
        openPanel(m.id);
      };
      results.appendChild(item);
    });
    results.classList.add('open');
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#search-wrap')) {
      results.classList.remove('open');
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { results.classList.remove('open'); input.value = ''; }
  });
}

// ── Scale legend ───────────────────────────────────────────────────────────

function updateScaleLegend() {
  if (!mapInstance) return;
  const zoom = mapInstance.getZoom();
  // At zoom 0, 1 Leaflet px = 1 block.
  // At zoom -1, 1 px = 2 blocks, etc.
  const blocksPerPixel = Math.pow(2, -zoom);
  const el = document.getElementById('scale-text');
  if (blocksPerPixel < 1) {
    el.textContent = `zoom: ${zoom.toFixed(2)}`;
  } else {
    el.textContent = `1px = ${Math.round(blocksPerPixel)} block${blocksPerPixel > 1 ? 's' : ''}`;
  }
}

// ── Editor tab switching ───────────────────────────────────────────────────

function initEditorTabs() {
  document.getElementById('editor-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.editor-tab');
    if (!tab) return;

    document.querySelectorAll('#editor-tabs .editor-tab').forEach(b =>
      b.classList.toggle('active', b === tab)
    );

    const isPreview = tab.dataset.tab === 'preview';
    document.getElementById('edit-body').classList.toggle('hidden', isPreview);
    const preview = document.getElementById('edit-preview');
    preview.classList.toggle('hidden', !isPreview);
    if (isPreview) {
      preview.innerHTML = marked.parse(document.getElementById('edit-body').value || '');
    }
  });
}

// ── Keyboard shortcuts ─────────────────────────────────────────────────────

function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    switch (e.key) {
      case 'Escape':
        if (addMode) disableAddMode();
        else if (activeMarkerId) closePanel();
        break;
      case 'n': case 'N':
        toggleAddMode();
        break;
      case 'e': case 'E':
        if (activeMarkerId) showPanelEdit();
        break;
      case 'f': case 'F':
        document.getElementById('search-input').focus();
        break;
    }
  });
}

// ── Utility ────────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Event wiring ───────────────────────────────────────────────────────────

function wireEvents() {
  document.getElementById('btn-add-mode').onclick    = toggleAddMode;
  document.getElementById('btn-close-panel').onclick = closePanel;

  document.getElementById('btn-edit-marker').onclick = () => {
    if (activeMarkerId) showPanelEdit();
  };
  document.getElementById('btn-delete-marker').onclick = () => {
    if (activeMarkerId) deleteMarker(activeMarkerId);
  };
  document.getElementById('btn-save-marker').onclick   = saveMarkerEdits;
  document.getElementById('btn-cancel-edit').onclick   = showPanelView;

  document.getElementById('btn-create-marker').onclick = () => {
    if (pendingNewCoords) {
      createMarker(pendingNewCoords.x, pendingNewCoords.z);
    }
  };
  document.getElementById('btn-cancel-modal').onclick  = () => {
    closeModal();
    disableAddMode();
  };

  // Close modal on overlay click
  document.getElementById('modal-overlay').onclick = (e) => {
    if (e.target === document.getElementById('modal-overlay')) {
      closeModal();
      disableAddMode();
    }
  };

  // Enter key in modal title → create
  document.getElementById('new-title').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-create-marker').click();
  });
}

// ── Bootstrap ──────────────────────────────────────────────────────────────

async function init() {
  initMap();
  wireEvents();
  initSearch();
  initEditorTabs();
  initKeyboard();

  await loadMapTiles();
  await loadMarkers();

  console.log(`%cMinecraft Atlas loaded — ${allMaps.length} map tiles, ${allMarkers.length} markers`,
    'color:#e8c97a;font-family:monospace');
  console.log('Shortcuts: [N] add marker  [E] edit  [F] search  [Esc] close');
}

document.addEventListener('DOMContentLoaded', init);
