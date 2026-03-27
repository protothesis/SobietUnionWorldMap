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
const DEFAULT_COLOR = '#f03939';

const SCALE_COLORS = ['#e53935', '#0f55c7', '#43a047', '#8e24aa', '#fdd835'];

const FRAME_PIN_STYLE = { icon: '🟢', color: '#4caf50', label: 'Item Frame' };

const EXPLORER_PIN_STYLES = {
  mansion:         { icon: '🏰', color: '#7c4dff', label: 'Woodland Mansion' },
  monument:        { icon: '🏛️', color: '#1e88e5', label: 'Ocean Monument'   },
  treasure:        { icon: '❌', color: '#f57f17', label: 'Buried Treasure'  },
  jungle_pyramid:  { icon: '🌿', color: '#2e7d32', label: 'Jungle Pyramid'   },
  swamp_hut:       { icon: '🏚️', color: '#558b2f', label: 'Swamp Hut'        },
  trial_chambers:  { icon: '⚗️', color: '#00bcd4', label: 'Trial Chambers'   },
  green_triangle:  { icon: '🏯', color: '#4caf50', label: 'Structure'         },
  village_plains:  { icon: '🏘️', color: '#ef6c00', label: 'Plains Village'   },
  village_desert:  { icon: '🏘️', color: '#f9a825', label: 'Desert Village'   },
  village_savanna: { icon: '🏘️', color: '#ff7043', label: 'Savanna Village'  },
  village_snowy:   { icon: '🏘️', color: '#4fc3f7', label: 'Snowy Village'    },
  village_taiga:   { icon: '🏘️', color: '#795548', label: 'Taiga Village'    },
};

// ── State ──────────────────────────────────────────────────────────────────

let mapInstance   = null;
let allMaps       = [];
let allMarkers    = [];        // raw data from API (user pins + derived-pin annotations)
let derivedPins   = [];        // pins derived from map decoration data (ephemeral)

let markerLayer       = null;  // L.MarkerClusterGroup — user pins
let framePinsLayer    = null;  // L.MarkerClusterGroup — frame decoration pins
let explorerPinsLayer = null;  // L.MarkerClusterGroup — explorer structure pins
let dimensionLayers   = {};    // { overworld, nether, end } → L.LayerGroup of map tiles
let explorerMapsLayer = null;  // L.LayerGroup — explorer map tile highlight overlay

let leafletMarkers        = {};  // markerId → L.Marker (user pins)
let leafletDerivedMarkers = {};  // derivedKey → L.Marker (derived pins)

let activeMarkerId   = null;
let activeDimension  = 'overworld';
let layerVis = {
  explorerMaps: false,
  framePins:    true,
  explorerPins: true,
  userPins:     true,
};

let addMode          = false;
let ghostMarker      = null;
let activeTags       = new Set();
let pendingNewCoords = null;
let coverageLayer    = null;
let coverageVisible  = false;
let layersDropdownOpen = false;

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

  mapInstance.zoomControl.setPosition('bottomright');

  markerLayer = L.markerClusterGroup({
    maxClusterRadius: 60,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    zoomToBoundsOnClick: true,
    disableClusteringAtZoom: 2,
  });
  mapInstance.addLayer(markerLayer);

  framePinsLayer = L.markerClusterGroup({
    maxClusterRadius: 60,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    zoomToBoundsOnClick: true,
    disableClusteringAtZoom: 2,
  });
  mapInstance.addLayer(framePinsLayer);

  explorerPinsLayer = L.markerClusterGroup({
    maxClusterRadius: 80,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    zoomToBoundsOnClick: true,
    disableClusteringAtZoom: 2,
  });
  mapInstance.addLayer(explorerPinsLayer);

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
    const res  = await fetch('data/maps.json');
    const data = await res.json();
    allMaps    = Array.isArray(data) ? data : (data.maps || []);
    const worldName = Array.isArray(data) ? '' : (data.world_name || '');
    document.getElementById('world-name').textContent = worldName;
  } catch (err) {
    console.warn('Could not load maps.json, continuing without tiles.', err);
    allMaps = [];
  }

  if (!allMaps.length) {
    showEmptyState();
    return;
  }

  // Create per-dimension layer groups + explorer highlight layer
  dimensionLayers = {
    overworld: L.layerGroup(),
    nether:    L.layerGroup(),
    end:       L.layerGroup(),
  };
  explorerMapsLayer = L.layerGroup();

  const boundsAll = [];

  // Sort largest scale first so detail maps render on top
  allMaps.forEach((m) => {
    const b   = m.bounds;
    const sw  = [-b.zMax, b.xMin];
    const ne  = [-b.zMin, b.xMax];
    const lb  = L.latLngBounds(sw, ne);
    const dim = m.dimensionName || 'overworld';

    const isExplorer = m.inferredType && m.inferredType !== 'standard';

    if (isExplorer) {
      // Explorer maps are hidden by default — only shown via the overlay toggle
      L.imageOverlay('data/' + m.file, lb, {
        opacity:     1,
        interactive: false,
        className:   'map-tile explorer-map-tile',
      }).addTo(explorerMapsLayer);
    } else {
      L.imageOverlay('data/' + m.file, lb, {
        opacity:     1,
        interactive: false,
        className:   'map-tile',
      }).addTo(dimensionLayers[dim] ?? dimensionLayers.overworld);
    }

    // All maps contribute to the initial viewport bounds regardless of visibility
    if (dim === activeDimension) boundsAll.push(lb);
  });

  // Only the active dimension is visible initially
  dimensionLayers[activeDimension].addTo(mapInstance);

  if (boundsAll.length) {
    const combined = boundsAll.reduce((acc, b) => acc.extend(b), L.latLngBounds());
    mapInstance.fitBounds(combined, { padding: [40, 40] });
  }

  buildCoverageLayer();
  buildDerivedPins();
  updateScaleLegend();
  syncLayersUI();
}

function setDimension(dim) {
  if (dim === activeDimension || !dimensionLayers[dim]) return;

  mapInstance.removeLayer(dimensionLayers[activeDimension]);
  activeDimension = dim;
  dimensionLayers[dim].addTo(mapInstance);

  document.querySelectorAll('.dim-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.dim === dim)
  );

  const dimMaps = allMaps.filter(m => (m.dimensionName || 'overworld') === dim);
  if (dimMaps.length) {
    const bounds = dimMaps
      .map(m => L.latLngBounds([-m.bounds.zMax, m.bounds.xMin], [-m.bounds.zMin, m.bounds.xMax]))
      .reduce((acc, b) => acc.extend(b), L.latLngBounds());
    mapInstance.fitBounds(bounds, { padding: [40, 40] });
  }
}

function buildCoverageLayer() {
  coverageLayer = L.layerGroup();
  allMaps.forEach((m) => {
    const b     = m.bounds;
    const sw    = [-b.zMax, b.xMin];
    const ne    = [-b.zMin, b.xMax];
    const color = SCALE_COLORS[m.scale] ?? '#ffffff';
    L.rectangle([sw, ne], {
      color, weight: 2, fillColor: color, fillOpacity: 0.20, interactive: false,
    }).addTo(coverageLayer);
  });
}

function toggleCoverageLayer() {
  coverageVisible = !coverageVisible;
  if (coverageVisible) {
    coverageLayer.addTo(mapInstance);
  } else {
    mapInstance.removeLayer(coverageLayer);
  }
  document.getElementById('btn-coverage-layer').classList.toggle('active', coverageVisible);
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

// ── Derived pins ───────────────────────────────────────────────────────────

function buildDerivedPins() {
  const frameSeen    = new Map();  // 'blockX:blockZ' → pin
  const explorerSeen = new Map();  // 'typeName:blockX:blockZ' → pin

  allMaps.forEach((map) => {
    (map.decorations || []).forEach((dec) => {
      const bx = dec.blockX;
      const bz = dec.blockZ;

      if (dec.typeName === 'frame') {
        const key = `${bx}:${bz}`;
        if (!frameSeen.has(key)) {
          frameSeen.set(key, {
            id:          `frame:${bx}:${bz}`,
            derivedKey:  `frame:${bx}:${bz}`,
            source:      'frame',
            type:        'frame',
            x:           bx,
            z:           bz,
            title:       FRAME_PIN_STYLE.label,
            icon:        FRAME_PIN_STYLE.icon,
            color:       FRAME_PIN_STYLE.color,
            body:        '',
            tags:        [],
            locked:      true,
            annotationId: null,
          });
        }
      } else {
        const style = EXPLORER_PIN_STYLES[dec.typeName];
        if (style) {
          const key = `${dec.typeName}:${bx}:${bz}`;
          if (!explorerSeen.has(key)) {
            explorerSeen.set(key, {
              id:          `explorer:${dec.typeName}:${bx}:${bz}`,
              derivedKey:  `explorer:${dec.typeName}:${bx}:${bz}`,
              source:      'explorer',
              type:        dec.typeName,
              x:           bx,
              z:           bz,
              title:       style.label,
              icon:        style.icon,
              color:       style.color,
              body:        '',
              tags:        [],
              locked:      true,
              annotationId: null,
            });
          }
        }
      }
    });
  });

  derivedPins = [...frameSeen.values(), ...explorerSeen.values()];
}

function mergeDerivedAnnotations() {
  // Reset all derived pins first (handles re-merges cleanly)
  derivedPins.forEach((pin) => {
    const style = pin.source === 'frame' ? FRAME_PIN_STYLE : EXPLORER_PIN_STYLES[pin.type];
    pin.annotationId = null;
    pin.title = style?.label || 'Pin';
    pin.icon  = style?.icon  || DEFAULT_ICON;
    pin.color = style?.color || DEFAULT_COLOR;
    pin.body  = '';
    pin.tags  = [];
  });

  allMarkers.forEach((m) => {
    if (!m.derivedFrom) return;
    const pin = derivedPins.find(p => p.derivedKey === m.derivedFrom);
    if (!pin) return;
    pin.annotationId = m.id;
    pin.title = m.title;
    pin.icon  = m.icon;
    pin.color = m.color;
    pin.body  = m.body;
    pin.tags  = m.tags;
  });
}

function renderFramePins() {
  framePinsLayer.clearLayers();
  // Remove frame entries from derived marker map
  Object.keys(leafletDerivedMarkers).forEach(k => {
    if (k.startsWith('frame:')) delete leafletDerivedMarkers[k];
  });

  if (!layerVis.framePins) return;

  derivedPins.filter(p => p.source === 'frame').forEach((pin) => {
    const lm = L.marker([-pin.z, pin.x], {
      icon: makeLeafletIcon(pin.icon, pin.color),
      title: pin.title,
      riseOnHover: true,
    });
    lm.on('click', () => openPanel(pin.id));
    leafletDerivedMarkers[pin.derivedKey] = lm;
    framePinsLayer.addLayer(lm);
  });
}

function renderExplorerPins() {
  explorerPinsLayer.clearLayers();
  // Remove explorer entries from derived marker map
  Object.keys(leafletDerivedMarkers).forEach(k => {
    if (k.startsWith('explorer:')) delete leafletDerivedMarkers[k];
  });

  if (!layerVis.explorerPins) return;

  derivedPins.filter(p => p.source === 'explorer').forEach((pin) => {
    const lm = L.marker([-pin.z, pin.x], {
      icon: makeLeafletIcon(pin.icon, pin.color),
      title: pin.title,
      riseOnHover: true,
    });
    lm.on('click', () => openPanel(pin.id));
    leafletDerivedMarkers[pin.derivedKey] = lm;
    explorerPinsLayer.addLayer(lm);
  });
}

function getDerivedPin(id) {
  return derivedPins.find(p => p.id === id) || null;
}

function updateDerivedMarkerIcon(pin) {
  const lm = leafletDerivedMarkers[pin.derivedKey];
  if (lm) lm.setIcon(makeLeafletIcon(pin.icon, pin.color));
}

// ── Markers ────────────────────────────────────────────────────────────────

async function loadMarkers() {
  try {
    const res = await fetch('data/markers.json');
    allMarkers = await res.json();
  } catch {
    allMarkers = [];
  }
  mergeDerivedAnnotations();
  renderAllMarkers();
  renderFramePins();
  renderExplorerPins();
  buildTagBar();
}

function makeLeafletIcon(icon, color) {
  return L.divIcon({
    html: `<div class="atlas-marker" style="background:${color}"><span class="atlas-marker-inner">${icon}</span></div>`,
    className: '',
    iconSize:   [32, 32],
    iconAnchor: [16, 32],
    popupAnchor:[0, -34],
  });
}

function renderAllMarkers() {
  markerLayer.clearLayers();
  leafletMarkers = {};

  if (!layerVis.userPins) return;

  // Only user-created markers — exclude derived-pin annotation records
  const userMarkers = allMarkers.filter(m => !m.source || m.source === 'user');

  const filtered = activeTags.size
    ? userMarkers.filter(m => m.tags && m.tags.some(t => activeTags.has(t)))
    : userMarkers;

  filtered.forEach((m) => {
    const lm = L.marker([-m.z, m.x], {
      icon:        makeLeafletIcon(m.icon || DEFAULT_ICON, m.color || DEFAULT_COLOR),
      title:       m.title,
      riseOnHover: true,
    });
    lm.on('click', () => openPanel(m.id));
    leafletMarkers[m.id] = lm;
    markerLayer.addLayer(lm);
  });
}

function getPinById(id) {
  return allMarkers.find(m => m.id === id) || getDerivedPin(id) || null;
}

// ── Panel ──────────────────────────────────────────────────────────────────

function highlightPin(id) {
  Object.values(leafletMarkers).forEach(lm =>
    lm.getElement()?.querySelector('.atlas-marker')?.classList.remove('selected')
  );
  Object.values(leafletDerivedMarkers).forEach(lm =>
    lm.getElement()?.querySelector('.atlas-marker')?.classList.remove('selected')
  );

  const pin = getPinById(id);
  if (!pin) return;
  const lm = pin.locked ? leafletDerivedMarkers[pin.derivedKey] : leafletMarkers[id];
  lm?.getElement()?.querySelector('.atlas-marker')?.classList.add('selected');
}

function openPanel(id) {
  const pin = getPinById(id);
  if (!pin) return;

  activeMarkerId = id;
  highlightPin(id);

  // Source badge
  const badge = document.getElementById('panel-source-badge');
  if (pin.locked) {
    const label = pin.source === 'frame'
      ? `${FRAME_PIN_STYLE.icon} Frame Pin`
      : `${pin.icon} ${EXPLORER_PIN_STYLES[pin.type]?.label || 'Explorer Pin'}`;
    badge.textContent = label;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  // Delete button: hide for unmodified derived pins (nothing to delete yet)
  const canDelete = !pin.locked || !!pin.annotationId;
  document.getElementById('btn-delete-marker').style.visibility = canDelete ? 'visible' : 'hidden';

  // Populate view
  document.getElementById('panel-icon-display').textContent = pin.icon || DEFAULT_ICON;
  document.getElementById('panel-title').textContent        = pin.title || 'Untitled';
  document.getElementById('panel-coords').textContent       = `x: ${pin.x}  z: ${pin.z}`;

  const tagsEl = document.getElementById('panel-tags');
  tagsEl.innerHTML = '';
  (pin.tags || []).forEach(t => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.textContent = t;
    chip.onclick = () => toggleTagFilter(t);
    tagsEl.appendChild(chip);
  });

  const bodyEl = document.getElementById('panel-body-view');
  if (pin.body && pin.body.trim()) {
    bodyEl.innerHTML = marked.parse(pin.body);
    bodyEl.querySelectorAll('a').forEach(a => a.setAttribute('target', '_blank'));
  } else {
    bodyEl.innerHTML = `<p class="empty-body">${pin.locked ? 'Click ✏ to add a label or notes.' : 'No notes yet. Click ✏ to add some.'}</p>`;
  }

  showPanelView();
  document.getElementById('info-panel').classList.add('panel-open');
  document.getElementById('map').classList.add('panel-open');
  mapInstance.panTo([-pin.z, pin.x], { animate: true, duration: 0.4 });
}

function closePanel() {
  activeMarkerId = null;
  document.getElementById('info-panel').classList.remove('panel-open');
  document.getElementById('map').classList.remove('panel-open');
  // Restore delete button visibility
  document.getElementById('btn-delete-marker').style.visibility = 'visible';
  Object.values(leafletMarkers).forEach(lm =>
    lm.getElement()?.querySelector('.atlas-marker')?.classList.remove('selected')
  );
  Object.values(leafletDerivedMarkers).forEach(lm =>
    lm.getElement()?.querySelector('.atlas-marker')?.classList.remove('selected')
  );
}

function showPanelView() {
  document.getElementById('panel-body-view').classList.remove('hidden');
  document.getElementById('panel-edit-form').classList.add('hidden');
}

function showPanelEdit() {
  const pin = getPinById(activeMarkerId);
  if (!pin) return;

  document.getElementById('edit-title').value = pin.title || '';
  document.getElementById('edit-color').value = pin.color || DEFAULT_COLOR;
  document.getElementById('edit-tags').value  = (pin.tags || []).join(', ');
  document.getElementById('edit-body').value  = pin.body || '';
  document.getElementById('edit-preview').classList.add('hidden');
  document.getElementById('edit-body').classList.remove('hidden');

  initIconPicker('icon-picker', pin.icon || DEFAULT_ICON);

  document.querySelectorAll('#editor-tabs .editor-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === 'write');
  });

  document.getElementById('panel-body-view').classList.add('hidden');
  document.getElementById('panel-edit-form').classList.remove('hidden');
}

// ── Marker CRUD ────────────────────────────────────────────────────────────

async function saveMarkerEdits() {
  const pin = getPinById(activeMarkerId);
  if (!pin) return;

  const payload = {
    title: document.getElementById('edit-title').value.trim() || 'Untitled',
    icon:  getSelectedIcon('icon-picker'),
    color: document.getElementById('edit-color').value,
    body:  document.getElementById('edit-body').value,
    tags:  document.getElementById('edit-tags').value
      .split(',').map(t => t.trim()).filter(Boolean),
  };

  try {
    if (pin.locked) {
      if (pin.annotationId) {
        // Update existing annotation
        const res = await fetch(`${API_BASE}/markers/${pin.annotationId}`, {
          method:  'PUT',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(payload),
        });
        const updated = await res.json();
        const idx = allMarkers.findIndex(m => m.id === pin.annotationId);
        if (idx !== -1) allMarkers[idx] = updated;
      } else {
        // Create new annotation for this derived pin
        const res = await fetch(`${API_BASE}/markers`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            x: pin.x, z: pin.z,
            source: pin.source,
            locked: true,
            derivedFrom: pin.derivedKey,
            ...payload,
          }),
        });
        const newAnnotation = await res.json();
        pin.annotationId = newAnnotation.id;
        allMarkers.push(newAnnotation);
      }
      Object.assign(pin, payload);
      updateDerivedMarkerIcon(pin);
      buildTagBar();
      openPanel(activeMarkerId);
    } else {
      // User marker — standard update
      const res = await fetch(`${API_BASE}/markers/${activeMarkerId}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      });
      const updated = await res.json();
      const idx = allMarkers.findIndex(m => m.id === activeMarkerId);
      if (idx !== -1) allMarkers[idx] = updated;
      const lm = leafletMarkers[activeMarkerId];
      if (lm) lm.setIcon(makeLeafletIcon(updated.icon || DEFAULT_ICON, updated.color || DEFAULT_COLOR));
      buildTagBar();
      openPanel(activeMarkerId);
    }
  } catch (err) {
    console.error('Save failed:', err);
    alert('Failed to save. Is the server running?');
  }
}

async function deleteMarker(id) {
  const pin = getPinById(id);
  if (!pin) return;

  if (pin.locked) {
    if (!pin.annotationId) return;
    if (!confirm('Remove custom label from this pin? The pin itself will remain.')) return;
    try {
      await fetch(`${API_BASE}/markers/${pin.annotationId}`, { method: 'DELETE' });
      allMarkers = allMarkers.filter(m => m.id !== pin.annotationId);
      // Reset to defaults
      const style = pin.source === 'frame' ? FRAME_PIN_STYLE : EXPLORER_PIN_STYLES[pin.type];
      pin.annotationId = null;
      pin.title = style?.label || 'Pin';
      pin.icon  = style?.icon  || DEFAULT_ICON;
      pin.color = style?.color || DEFAULT_COLOR;
      pin.body  = '';
      pin.tags  = [];
      updateDerivedMarkerIcon(pin);
      buildTagBar();
      closePanel();
    } catch (err) {
      console.error('Delete failed:', err);
    }
  } else {
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
}

async function createMarker(x, z) {
  const payload = {
    x,
    z,
    title:  document.getElementById('new-title').value.trim() || 'Untitled',
    icon:   getSelectedIcon('modal-icon-picker'),
    color:  document.getElementById('new-color').value,
    tags:   document.getElementById('new-tags').value
      .split(',').map(t => t.trim()).filter(Boolean),
    body:   '',
    source: 'user',
  };

  try {
    const res = await fetch(`${API_BASE}/markers`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const newMarker = await res.json();
    allMarkers.push(newMarker);

    if (layerVis.userPins) {
      const lm = L.marker([-newMarker.z, newMarker.x], {
        icon:        makeLeafletIcon(newMarker.icon || DEFAULT_ICON, newMarker.color || DEFAULT_COLOR),
        title:       newMarker.title,
        riseOnHover: true,
      });
      lm.on('click', () => openPanel(newMarker.id));
      leafletMarkers[newMarker.id] = lm;
      markerLayer.addLayer(lm);
    }

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
  pendingNewCoords = { x: Math.round(latlng.lng), z: Math.round(-latlng.lat) };

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

  ghostMarker = L.marker([0, 0], {
    icon: makeLeafletIcon(DEFAULT_ICON, DEFAULT_COLOR + '88'),
    interactive: false,
    zIndexOffset: 1000,
  });
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

// ── Layers dropdown ────────────────────────────────────────────────────────

function initLayersDropdown() {
  document.getElementById('dimension-controls').addEventListener('click', (e) => {
    const btn = e.target.closest('.dim-btn');
    if (btn) setDimension(btn.dataset.dim);
  });

  document.getElementById('toggle-explorer-maps').addEventListener('change', (e) => {
    setLayerVis('explorerMaps', e.target.checked);
  });
  document.getElementById('toggle-frame-pins').addEventListener('change', (e) => {
    setLayerVis('framePins', e.target.checked);
  });
  document.getElementById('toggle-explorer-pins').addEventListener('change', (e) => {
    setLayerVis('explorerPins', e.target.checked);
  });
  document.getElementById('toggle-user-pins').addEventListener('change', (e) => {
    setLayerVis('userPins', e.target.checked);
  });

  // Close panel on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#layers-dropdown-wrap')) {
      closeLayersDropdown();
    }
  });
}

function toggleLayersDropdown() {
  layersDropdownOpen = !layersDropdownOpen;
  document.getElementById('layers-panel').classList.toggle('hidden', !layersDropdownOpen);
  document.getElementById('btn-layers').classList.toggle('active', layersDropdownOpen);
}

function closeLayersDropdown() {
  if (!layersDropdownOpen) return;
  layersDropdownOpen = false;
  document.getElementById('layers-panel').classList.add('hidden');
  document.getElementById('btn-layers').classList.remove('active');
}

function setLayerVis(layerName, visible) {
  layerVis[layerName] = visible;
  switch (layerName) {
    case 'explorerMaps':
      if (visible) explorerMapsLayer?.addTo(mapInstance);
      else if (explorerMapsLayer) mapInstance.removeLayer(explorerMapsLayer);
      break;
    case 'framePins':
      renderFramePins();
      break;
    case 'explorerPins':
      renderExplorerPins();
      break;
    case 'userPins':
      renderAllMarkers();
      break;
  }
}

function syncLayersUI() {
  const map = {
    'toggle-explorer-maps':  layerVis.explorerMaps,
    'toggle-frame-pins':     layerVis.framePins,
    'toggle-explorer-pins':  layerVis.explorerPins,
    'toggle-user-pins':      layerVis.userPins,
  };
  Object.entries(map).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.checked = val;
  });
  document.querySelectorAll('.dim-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.dim === activeDimension)
  );
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
  // Only user-created markers drive the tag bar
  allMarkers
    .filter(m => !m.source || m.source === 'user')
    .forEach(m => (m.tags || []).forEach(t => allTags.add(t)));

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

    // Search user markers
    const userHits = allMarkers
      .filter(m => !m.source || m.source === 'user')
      .filter(m =>
        m.title.toLowerCase().includes(q) ||
        (m.tags || []).some(t => t.toLowerCase().includes(q)) ||
        (m.body || '').toLowerCase().includes(q)
      );

    // Search derived pins (by title and type)
    const derivedHits = derivedPins.filter(p =>
      p.title.toLowerCase().includes(q) ||
      p.type.toLowerCase().includes(q) ||
      (p.body || '').toLowerCase().includes(q)
    );

    const hits = [...userHits, ...derivedHits].slice(0, 8);

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
        else if (layersDropdownOpen) closeLayersDropdown();
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
  document.getElementById('btn-add-mode').onclick       = toggleAddMode;
  document.getElementById('btn-coverage-layer').onclick = toggleCoverageLayer;
  document.getElementById('btn-layers').onclick         = toggleLayersDropdown;
  document.getElementById('btn-close-panel').onclick    = closePanel;

  document.getElementById('btn-edit-marker').onclick = () => {
    if (activeMarkerId) showPanelEdit();
  };
  document.getElementById('btn-delete-marker').onclick = () => {
    if (activeMarkerId) deleteMarker(activeMarkerId);
  };
  document.getElementById('btn-save-marker').onclick  = saveMarkerEdits;
  document.getElementById('btn-cancel-edit').onclick  = showPanelView;

  document.getElementById('btn-create-marker').onclick = () => {
    if (pendingNewCoords) {
      createMarker(pendingNewCoords.x, pendingNewCoords.z);
    }
  };
  document.getElementById('btn-cancel-modal').onclick = () => {
    closeModal();
    disableAddMode();
  };

  document.getElementById('modal-overlay').onclick = (e) => {
    if (e.target === document.getElementById('modal-overlay')) {
      closeModal();
      disableAddMode();
    }
  };

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
  initLayersDropdown();

  await loadMapTiles();
  await loadMarkers();

  const frameCount    = derivedPins.filter(p => p.source === 'frame').length;
  const explorerCount = derivedPins.filter(p => p.source === 'explorer').length;
  console.log(
    `%cMinecraft Atlas loaded — ${allMaps.length} map tiles, ${allMarkers.length} markers, ` +
    `${frameCount} frame pins, ${explorerCount} explorer pins`,
    'color:#e8c97a;font-family:monospace'
  );
  console.log('Shortcuts: [N] add marker  [E] edit  [F] search  [Esc] close');
}

document.addEventListener('DOMContentLoaded', init);
