/* ============================================================
   Minecraft Atlas — app.js
   Leaflet-based interactive map viewer with marker management.
   ============================================================ */

'use strict';

// ── Constants ──────────────────────────────────────────────────────────────

const API_BASE = '/api';

// Set to true to re-enable Leaflet.markercluster grouping behaviour.
// When true, showCoverageOnHover draws a bounding polygon on hover so you
// can still see where the individual pins live before clicking to zoom in.
const CLUSTER_MARKERS = false;

const ICONS = [
  '📍','🏠','⚔️','🏰','🌲','⛏️','💎','🔥','🌊','🏔️',
  '🐉','🧱','⚙️','🗺️','🏺','🔮','🌿','🎯','⚠️','🏕️',
  '🛖','🐑','🐄','🐺','🌾','🪨','🌋','❄️','🕳️','🗿',
];

const DEFAULT_ICON  = '🔴';
const DEFAULT_COLOR = '#f03939';

const SCALE_COLORS = ['#e53935', '#0f55c7', '#43a047', '#8e24aa', '#fdd835'];

const FRAME_PIN_STYLE = { icon: '🟢', color: '#4caf50', label: 'Item Frame Pin' };

const EXPLORER_PIN_STYLES = {
  mansion:         { icon: '🏰', color: '#7c4dff', label: 'Woodland Mansion' },
  monument:        { icon: '🏛️', color: '#1e88e5', label: 'Ocean Monument'   },
  red_x:           { icon: '❌', color: '#0200006b', label: 'Buried Treasure'  },
  jungle_pyramid:  { icon: '🌿', color: '#2e7d32', label: 'Jungle Pyramid'   },
  swamp_hut:       { icon: '🏚️', color: '#467916', label: 'Swamp Hut'        },
  trial_chambers:  { icon: '⚗️', color: '#00bfd4', label: 'Trial Chambers'   },
  green_triangle:  { icon: '🏯', color: '#4caf50', label: 'Structure'         },
  village_plains:  { icon: '🏘️', color: '#ef6c00', label: 'Plains Village'   },
  village_desert:  { icon: '🏘️', color: '#f9a825', label: 'Desert Village'   },
  village_savanna: { icon: '🏘️', color: '#ff7043', label: 'Savanna Village'  },
  village_snowy:   { icon: '🏘️', color: '#4fc3f7', label: 'Snowy Village'    },
  village_taiga:   { icon: '🏘️', color: '#795548', label: 'Taiga Village'    },
};

const USER_PIN_TYPES = [
  { id: 'default',  label: 'Default',  icon: '🔴', color: '#ed2d2d' },
  { id: 'shelter',  label: 'Shelter',  icon: '🛏️', color: '#ece2df' },
  { id: 'village',  label: 'Village',  icon: '🏘️', color: '#ad7b55' },
  { id: 'portal',   label: 'Portal',   icon: '🌀', color: '#983dee' },
  { id: 'landmark', label: 'Landmark', icon: '⛰️', color: '#749274' },
  { id: 'spawner',  label: 'Spawner',  icon: '💀', color: '#2b2a27' },
  { id: 'poi',      label: 'POI',      icon: '🔷', color: '#8bd3f5' },
];

// ── State ──────────────────────────────────────────────────────────────────

let mapInstance   = null;
let allMaps       = [];
let allMarkers    = [];        // raw data from API (user pins + derived-pin annotations)
let derivedPins   = [];        // pins derived from map decoration data (ephemeral)

let markerLayer       = null;  // L.LayerGroup (or MarkerClusterGroup when CLUSTER_MARKERS) — user pins
let framePinsLayer    = null;  // L.LayerGroup (or MarkerClusterGroup when CLUSTER_MARKERS) — frame decoration pins
let explorerPinsLayer = null;  // L.LayerGroup (or MarkerClusterGroup when CLUSTER_MARKERS) — explorer structure pins
let dimensionScaleLayers = {};  // { dim: { scale: L.LayerGroup } } — per-dimension per-scale tile groups
let explorerMapsLayer    = null;  // L.LayerGroup — explorer map tile highlight overlay
let autoScaleThresholds  = [0.5, 1, 2, 4, 9999];  // max blocks/px to show scale[i]; overridden by atlas_config.json

let leafletMarkers        = {};  // markerId → L.Marker (user pins)
let leafletDerivedMarkers = {};  // derivedKey → L.Marker (derived pins)

let activeMarkerId   = null;
let activeDimension  = 'overworld';
let layerVis = {
  explorerMaps: false,
  framePins:    true,
  explorerPins: false,
  userPins:     true,
  scales:       { 0: true, 1: true, 2: true, 3: true, 4: true },
  autoScale:    false,
};

let addMode          = false;
let ghostMarker      = null;
let activeTags       = new Set();
let pendingNewCoords = null;
let isDraggingMarker = false;
let dragGhost        = null;
let dragMarkerId     = null;
let framePinHighlightLayer = null;
let coverageLayer    = null;
let coverageVisible  = false;
let layersDropdownOpen = false;

let tileData        = [];  // { file, lb, dim, scale, isExplorer, overlay: L.ImageOverlay|null }
let tileLoadPending = 0;

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

  // Home button — resets view to x:0, z:0 at 1px=1block (zoom 0)
  const HomeControl = L.Control.extend({
    options: { position: 'bottomright' },
    onAdd() {
      const btn = L.DomUtil.create('a', 'leaflet-control-home leaflet-bar-part');
      btn.title = 'Reset view to origin (0, 0) at 1px=1block';
      btn.href = '#';
      btn.innerHTML = '⌂';
      L.DomEvent.on(btn, 'click', (e) => {
        L.DomEvent.stopPropagation(e);
        L.DomEvent.preventDefault(e);
        mapInstance.setView([0, 0], 0);
      });
      const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
      container.appendChild(btn);
      return container;
    },
  });
  new HomeControl().addTo(mapInstance);


  if (CLUSTER_MARKERS) {
    // Clustering on: pins collapse at low zoom. showCoverageOnHover draws a
    // bounding polygon on hover so you can see where members sit before clicking.
    markerLayer = L.markerClusterGroup({
      maxClusterRadius: 60,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: true,
      zoomToBoundsOnClick: true,
      disableClusteringAtZoom: 2,
    });
    framePinsLayer = L.markerClusterGroup({
      maxClusterRadius: 60,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: true,
      zoomToBoundsOnClick: true,
      disableClusteringAtZoom: 2,
    });
    explorerPinsLayer = L.markerClusterGroup({
      maxClusterRadius: 80,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: true,
      zoomToBoundsOnClick: true,
      disableClusteringAtZoom: 2,
    });
  } else {
    markerLayer       = L.layerGroup();
    framePinsLayer    = L.layerGroup();
    explorerPinsLayer = L.layerGroup();
  }
  mapInstance.addLayer(markerLayer);
  mapInstance.addLayer(framePinsLayer);
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

  // Left-click: place marker in add mode, or deselect/close panel on empty map
  mapInstance.on('click', (e) => {
    if (addMode) {
      openNewMarkerModal(e.latlng);
    } else if (activeMarkerId && !isDraggingMarker) {
      closePanel();
    }
  });

  mapInstance.on('zoomend', () => {
    updateScaleLegend();
    if (layerVis.autoScale) applyAutoScale();
    updateAllMarkerSizes();
    // moveend also fires on zoom, so refreshVisibleTiles is covered
  });

  mapInstance.on('moveend', refreshVisibleTiles);
}

// ── Tile viewport culling & loading indicator ──────────────────────────────

function updateLoadingIndicator() {
  const el = document.getElementById('tile-loading');
  if (!el) return;
  if (tileLoadPending > 0) {
    el.classList.remove('hidden', 'fading');
    document.getElementById('tile-loading-text').textContent =
      `loading ${tileLoadPending} tile${tileLoadPending === 1 ? '' : 's'}…`;
  } else {
    el.classList.add('fading');
    setTimeout(() => { el.classList.add('hidden'); el.classList.remove('fading'); }, 500);
  }
}

// Remove all tracked overlays from a layer group and clear their refs.
// Call before removing a layer group from the map so no stale overlays
// re-download when the group is later re-added.
function clearLayerGroupTiles(lg) {
  tileData.forEach(tile => {
    if (!tile.overlay) return;
    const tileLg = tile.isExplorer
      ? explorerMapsLayer
      : (dimensionScaleLayers[tile.dim] || {})[tile.scale];
    if (tileLg === lg) {
      lg.removeLayer(tile.overlay);
      tile.overlay = null;
    }
  });
}

function refreshVisibleTiles() {
  if (!mapInstance || !tileData.length) return;
  const vp = mapInstance.getBounds().pad(0.5);

  tileData.forEach(tile => {
    const lg = tile.isExplorer
      ? explorerMapsLayer
      : (dimensionScaleLayers[tile.dim] || {})[tile.scale];
    if (!lg) return;

    const layerOnMap = mapInstance.hasLayer(lg);
    const inView     = layerOnMap && vp.intersects(tile.lb);

    if (inView && !tile.overlay) {
      // Create overlay lazily — only when in viewport
      const ov = L.imageOverlay('data/' + tile.file, tile.lb, {
        opacity: 1, interactive: false,
        className: 'map-tile' + (tile.isExplorer ? ' explorer-map-tile' : ''),
      });
      tile.overlay = ov;
      tileLoadPending++;
      updateLoadingIndicator();
      ov.on('load', () => {
        tileLoadPending = Math.max(0, tileLoadPending - 1);
        updateLoadingIndicator();
      });
      lg.addLayer(ov);
    } else if (layerOnMap && !inView && tile.overlay) {
      // Cull — remove from DOM, free memory
      lg.removeLayer(tile.overlay);
      tile.overlay = null;
    }
  });
}

// ── Map tile loading ───────────────────────────────────────────────────────

async function loadAtlasConfig() {
  try {
    const res = await fetch('/atlas_config.json');
    if (res.ok) {
      const cfg = await res.json();
      if (cfg.autoScaleMaxBpp) {
        autoScaleThresholds = [0, 1, 2, 3, 4].map(
          s => cfg.autoScaleMaxBpp[s] ?? autoScaleThresholds[s]
        );
      }
    }
  } catch { /* use defaults */ }
}

async function loadMapTiles() {
  await loadAtlasConfig();

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

  // Build tile metadata — overlays are created lazily by refreshVisibleTiles
  dimensionScaleLayers = { overworld: {}, nether: {}, end: {} };
  explorerMapsLayer = L.layerGroup();
  tileData = [];

  // Sort descending so coarser (higher scale) tiles are iterated first,
  // ensuring detail tiles (scale 0) end up on top within each layer group.
  const sortedMaps = [...allMaps].sort((a, b) => (b.scale ?? 0) - (a.scale ?? 0));

  sortedMaps.forEach((m) => {
    const b          = m.bounds;
    const lb         = L.latLngBounds([-b.zMax, b.xMin], [-b.zMin, b.xMax]);
    const dim        = m.dimensionName || 'overworld';
    const scale      = m.scale ?? 0;
    const isExplorer = m.inferredType && m.inferredType !== 'standard';

    tileData.push({ file: m.file, lb, dim, scale, isExplorer, overlay: null });

    if (!isExplorer) {
      if (!dimensionScaleLayers[dim]) dimensionScaleLayers[dim] = {};
      if (!dimensionScaleLayers[dim][scale]) dimensionScaleLayers[dim][scale] = L.layerGroup();
    }
  });

  // Add empty layer groups to the map — overlays will be populated by refreshVisibleTiles
  Object.entries(dimensionScaleLayers[activeDimension] || {})
    .sort(([a], [b]) => +b - +a)
    .forEach(([scale, lg]) => {
      if (layerVis.scales[+scale] !== false) lg.addTo(mapInstance);
    });

  mapInstance.setView([0, 0], 0);
  refreshVisibleTiles();

  buildScaleToggles();
  buildCoverageLayer();
  buildDerivedPins();
  updateScaleLegend();
  syncLayersUI();
}

function setDimension(dim) {
  if (dim === activeDimension || !dimensionScaleLayers[dim]) return;

  // Remove all scale layers for the old dimension, clearing lazy overlays first
  Object.values(dimensionScaleLayers[activeDimension] || {}).forEach(lg => {
    clearLayerGroupTiles(lg);
    mapInstance.removeLayer(lg);
  });

  activeDimension = dim;

  // Add visible scale layers for the new dimension — descending order so scale 0 ends up on top
  Object.entries(dimensionScaleLayers[dim] || {})
    .sort(([a], [b]) => +b - +a)
    .forEach(([scale, lg]) => {
      if (layerVis.scales[+scale] !== false) lg.addTo(mapInstance);
    });

  if (layerVis.autoScale) applyAutoScale();

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

function buildScaleToggles() {
  const container = document.getElementById('scale-toggles');
  if (!container) return;
  container.innerHTML = '';

  // Collect all scales present across all dimensions
  const allScales = new Set();
  Object.values(dimensionScaleLayers).forEach(dimLayers =>
    Object.keys(dimLayers).forEach(s => allScales.add(+s))
  );

  [...allScales].sort((a, b) => a - b).forEach((scale) => {
    const color = SCALE_COLORS[scale] ?? '#ffffff';
    const label = document.createElement('label');
    label.className = 'layer-toggle';
    label.id = `scale-toggle-label-${scale}`;
    label.innerHTML =
      `<input type="checkbox" id="toggle-scale-${scale}" checked />` +
      `<span class="scale-dot" style="background:${color}"></span>` +
      `<span>Scale ${scale}</span>`;
    container.appendChild(label);

    label.querySelector('input').addEventListener('change', (e) => {
      if (!layerVis.autoScale) setScaleVis(scale, e.target.checked);
    });
  });

  // Initialize layerVis.scales for only the scales that exist
  [...allScales].forEach(s => { layerVis.scales[s] = true; });
}

function setScaleVis(scale, visible) {
  layerVis.scales[scale] = visible;
  const lg = (dimensionScaleLayers[activeDimension] || {})[scale];
  if (lg) {
    if (visible) {
      lg.addTo(mapInstance);
      refreshVisibleTiles();
    } else {
      clearLayerGroupTiles(lg);
      mapInstance.removeLayer(lg);
    }
  }
  updateScaleLegend();
}

function applyAutoScale() {
  if (!mapInstance) return;
  const bpp = Math.pow(2, -mapInstance.getZoom());
  const groups = dimensionScaleLayers[activeDimension] || {};

  // Compute new visibility, clear lazy overlays, then remove all layer groups
  Object.entries(groups).forEach(([scale, lg]) => {
    layerVis.scales[+scale] = bpp <= (autoScaleThresholds[+scale] ?? 9999);
    clearLayerGroupTiles(lg);
    mapInstance.removeLayer(lg);
  });

  // Re-add visible layer groups in descending order so scale 0 (detail) stays on top
  Object.entries(groups)
    .sort(([a], [b]) => +b - +a)
    .forEach(([scale, lg]) => {
      if (layerVis.scales[+scale]) lg.addTo(mapInstance);
    });

  refreshVisibleTiles();
  syncScaleTogglesUI();
  updateScaleLegend();
}

function syncScaleTogglesUI() {
  const auto = layerVis.autoScale;
  Object.keys(layerVis.scales).forEach((scale) => {
    const cb = document.getElementById(`toggle-scale-${scale}`);
    if (!cb) return;
    cb.checked = !!layerVis.scales[+scale];
    cb.disabled = auto;
    const label = document.getElementById(`scale-toggle-label-${scale}`);
    if (label) label.classList.toggle('layer-toggle-disabled', auto);
  });
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

function showFramePinCoverage(sourceMaps, pinColor) {
  framePinHighlightLayer = L.layerGroup();
  sourceMaps.forEach(({ bounds: b }) => {
    const sw = [-b.zMax, b.xMin];
    const ne = [-b.zMin, b.xMax];
    L.rectangle([sw, ne], {
      color:       pinColor,
      weight:      2,
      fillColor:   pinColor,
      fillOpacity: 0.18,
      interactive: false,
    }).addTo(framePinHighlightLayer);
  });
  framePinHighlightLayer.addTo(mapInstance);
}

function clearFramePinHighlight() {
  if (framePinHighlightLayer) {
    mapInstance.removeLayer(framePinHighlightLayer);
    framePinHighlightLayer = null;
  }
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
            sourceMaps:  [],
          });
        }
        frameSeen.get(key).sourceMaps.push({ id: map.id, scale: map.scale ?? 0, bounds: map.bounds });
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
    lm._atlasIcon  = pin.icon;
    lm._atlasColor = pin.color;
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
    lm._atlasIcon  = pin.icon;
    lm._atlasColor = pin.color;
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
  if (lm) {
    lm._atlasIcon  = pin.icon;
    lm._atlasColor = pin.color;
    lm.setIcon(makeLeafletIcon(pin.icon, pin.color));
  }
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

// Returns a pin size in px appropriate for the current zoom level.
// Pins shrink when zoomed out so they don't swamp the map.
function getMarkerSize() {
  const zoom = mapInstance ? mapInstance.getZoom() : 0;
  // zoom range is roughly -6 … 3; original values clamp to [10, 28] * 2.5
  // base size at zoom0 + zoom * zoom factor (sizechange (lower = subtler))
  return Math.round(Math.max(10, Math.min(36, 28 + zoom * 4)));
}

function makeLeafletIcon(icon, color, size) {
  const s = size ?? getMarkerSize();
  return L.divIcon({
    html: `<div class="atlas-marker" style="background:${color};width:${s}px;height:${s}px"><span class="atlas-marker-inner">${icon}</span></div>`,
    className: '',
    iconSize:   [s, s],
    iconAnchor: [s / 2, s],
    popupAnchor:[0, -(s + 2)],
  });
}

// Refresh icon sizes for every visible marker after a zoom change.
function updateAllMarkerSizes() {
  const size = getMarkerSize();
  Object.values(leafletMarkers).forEach(lm => {
    if (lm._atlasIcon !== undefined) {
      lm.setIcon(makeLeafletIcon(lm._atlasIcon, lm._atlasColor, size));
    }
  });
  Object.values(leafletDerivedMarkers).forEach(lm => {
    if (lm._atlasIcon !== undefined) {
      lm.setIcon(makeLeafletIcon(lm._atlasIcon, lm._atlasColor, size));
    }
  });
}

// Resolve a user marker's display icon/color from the live USER_PIN_TYPES table
// (falls back to stored values for legacy markers without a pinType).
function resolveUserPinStyle(m) {
  const type = USER_PIN_TYPES.find(t => t.id === m.pinType);
  return {
    icon:  type ? type.icon  : (m.icon  || DEFAULT_ICON),
    color: type ? type.color : (m.color || DEFAULT_COLOR),
  };
}

// Build a Leaflet marker for a user pin with all event handlers attached.
function makeUserMarker(m) {
  const { icon, color } = resolveUserPinStyle(m);
  const lm = L.marker([-m.z, m.x], {
    icon:        makeLeafletIcon(icon, color),
    title:       m.title,
    riseOnHover: true,
  });
  lm._atlasIcon  = icon;
  lm._atlasColor = color;
  lm.on('mousedown', (e) => {
    if (e.originalEvent.button !== 0) return;
    if (activeMarkerId !== m.id) return;
    e.originalEvent.preventDefault();
    startMarkerDrag(m.id, e.latlng);
  });
  lm.on('click', () => {
    if (isDraggingMarker) return;
    openPanel(m.id);
  });
  return lm;
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
    const lm = makeUserMarker(m);
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

  // Frame pin — show source map info and highlight coverage
  const mapInfoEl = document.getElementById('panel-map-info');
  clearFramePinHighlight();
  if (pin.source === 'frame' && pin.sourceMaps?.length) {
    const color = pin.color || FRAME_PIN_STYLE.color;
    mapInfoEl.innerHTML = pin.sourceMaps.map(sm =>
      `<span class="map-info-chip">
        <span class="map-info-dot" style="background:${SCALE_COLORS[sm.scale] ?? '#fff'}"></span>
        map_${sm.id} &nbsp;·&nbsp; scale ${sm.scale}
       </span>`
    ).join('');
    mapInfoEl.classList.remove('hidden');
    showFramePinCoverage(pin.sourceMaps, color);
  } else {
    mapInfoEl.classList.add('hidden');
  }

  const tagsEl = document.getElementById('panel-tags');
  tagsEl.innerHTML = '';
  (pin.tags || []).forEach(t => {
    const isTypeTag = !pin.locked && pin.pinType && t === pin.pinType;
    const chip = document.createElement('span');
    chip.className = 'tag-chip' + (isTypeTag ? ' tag-chip-type' : '');
    chip.textContent = t;
    if (!isTypeTag) chip.onclick = () => toggleTagFilter(t);
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
  clearFramePinHighlight();
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

  const isUserPin = !pin.locked;

  document.getElementById('edit-title').value = pin.title || '';
  document.getElementById('edit-body').value  = pin.body  || '';
  document.getElementById('edit-preview').classList.add('hidden');
  document.getElementById('edit-body').classList.remove('hidden');

  if (isUserPin) {
    const currentType = USER_PIN_TYPES.find(t => t.id === pin.pinType) || USER_PIN_TYPES[0];
    // Strip the locked type tag so it doesn't show in the editable tags field
    const userTags = (pin.tags || []).filter(t => t !== currentType.id);
    document.getElementById('edit-tags').value = userTags.join(', ');
    initTypePicker('edit-type-picker', currentType.id);
    document.getElementById('edit-type-row').classList.remove('hidden');
    document.getElementById('edit-icon-row').classList.add('hidden');
  } else {
    document.getElementById('edit-tags').value  = (pin.tags || []).join(', ');
    document.getElementById('edit-color').value = pin.color || DEFAULT_COLOR;
    initIconPicker('icon-picker', pin.icon || DEFAULT_ICON);
    document.getElementById('edit-icon-row').classList.remove('hidden');
    document.getElementById('edit-type-row').classList.add('hidden');
  }

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

  const isUserPin = !pin.locked;
  let payload;
  if (isUserPin) {
    const type     = getSelectedPinType('edit-type-picker') || USER_PIN_TYPES[0];
    const extraTags = document.getElementById('edit-tags').value
      .split(',').map(t => t.trim()).filter(t => t && t !== type.id);
    payload = {
      title:   document.getElementById('edit-title').value.trim() || type.label,
      icon:    type.icon,
      color:   type.color,
      pinType: type.id,
      body:    document.getElementById('edit-body').value,
      tags:    [type.id, ...extraTags],
    };
  } else {
    payload = {
      title: document.getElementById('edit-title').value.trim() || 'Untitled',
      icon:  getSelectedIcon('icon-picker'),
      color: document.getElementById('edit-color').value,
      body:  document.getElementById('edit-body').value,
      tags:  document.getElementById('edit-tags').value
        .split(',').map(t => t.trim()).filter(Boolean),
    };
  }

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
      if (lm) {
        const { icon, color } = resolveUserPinStyle(updated);
        lm.setIcon(makeLeafletIcon(icon, color));
        lm._atlasIcon  = icon;
        lm._atlasColor = color;
      }
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
  const type      = getSelectedPinType('modal-type-picker') || USER_PIN_TYPES[0];
  const extraTags = document.getElementById('new-tags').value
    .split(',').map(t => t.trim()).filter(t => t && t !== type.id);
  const payload = {
    x,
    z,
    title:   document.getElementById('new-title').value.trim() || type.label,
    icon:    type.icon,
    color:   type.color,
    pinType: type.id,
    tags:    [type.id, ...extraTags],
    body:    '',
    source:  'user',
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
      const lm = makeUserMarker(newMarker);
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

  initTypePicker('modal-type-picker', 'default');

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

// ── Marker drag-to-move ─────────────────────────────────────────────────────

function startMarkerDrag(markerId, latlng) {
  const pin = getPinById(markerId);
  if (!pin || pin.locked) return;

  isDraggingMarker = true;
  dragMarkerId = markerId;
  mapInstance.dragging.disable();
  document.getElementById('map').classList.add('dragging-marker');

  const icon  = pin.icon  || DEFAULT_ICON;
  const color = pin.color || DEFAULT_COLOR;
  dragGhost = L.marker(latlng, {
    icon: makeLeafletIcon(icon, color + '88'),
    interactive: false,
    zIndexOffset: 1000,
  });
  dragGhost.addTo(mapInstance);
  dragGhost.getElement()?.classList.add('ghost-marker');

  // Hide real marker while dragging
  leafletMarkers[markerId]?.getElement()?.classList.add('drag-hidden');

  mapInstance.on('mousemove', _onMarkerDragMove);
  document.addEventListener('mouseup', _endMarkerDrag, { once: true });
}

function _onMarkerDragMove(e) {
  if (dragGhost) dragGhost.setLatLng(e.latlng);
}

async function _endMarkerDrag() {
  mapInstance.off('mousemove', _onMarkerDragMove);
  mapInstance.dragging.enable();
  document.getElementById('map').classList.remove('dragging-marker');

  leafletMarkers[dragMarkerId]?.getElement()?.classList.remove('drag-hidden');

  if (dragGhost) {
    const newLatLng = dragGhost.getLatLng();
    mapInstance.removeLayer(dragGhost);
    dragGhost = null;

    const newX = Math.round(newLatLng.lng);
    const newZ = Math.round(-newLatLng.lat);
    await _saveMarkerPosition(dragMarkerId, newX, newZ);
  }

  dragMarkerId = null;
  // Brief delay so the suppressed click event fires before we clear the flag
  setTimeout(() => { isDraggingMarker = false; }, 50);
}

async function _saveMarkerPosition(markerId, x, z) {
  try {
    const res = await fetch(`${API_BASE}/markers/${markerId}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ x, z }),
    });
    const updated = await res.json();
    const idx = allMarkers.findIndex(m => m.id === markerId);
    if (idx !== -1) allMarkers[idx] = updated;

    // Move the Leaflet marker to new position
    const lm = leafletMarkers[markerId];
    if (lm) lm.setLatLng([-z, x]);

    // Refresh panel coords if this marker is still open
    if (activeMarkerId === markerId) {
      document.getElementById('panel-coords').textContent = `x: ${updated.x}  z: ${updated.z}`;
    }
  } catch (err) {
    console.error('Failed to move marker:', err);
    renderAllMarkers();
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
  document.getElementById('toggle-auto-scale').addEventListener('change', (e) => {
    setLayerVis('autoScale', e.target.checked);
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
      if (visible) {
        explorerMapsLayer?.addTo(mapInstance);
        refreshVisibleTiles();
      } else if (explorerMapsLayer) {
        clearLayerGroupTiles(explorerMapsLayer);
        mapInstance.removeLayer(explorerMapsLayer);
      }
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
    case 'autoScale':
      layerVis.autoScale = visible;
      if (visible) {
        applyAutoScale();
      } else {
        Object.entries(dimensionScaleLayers[activeDimension] || {}).forEach(([scale, lg]) => {
          if (layerVis.scales[+scale]) {
            lg.addTo(mapInstance);
          } else {
            clearLayerGroupTiles(lg);
            mapInstance.removeLayer(lg);
          }
        });
        refreshVisibleTiles();
        syncScaleTogglesUI();
        updateScaleLegend();
      }
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
  const autoEl = document.getElementById('toggle-auto-scale');
  if (autoEl) autoEl.checked = layerVis.autoScale;
  syncScaleTogglesUI();
}

// ── Type picker ─────────────────────────────────────────────────────────────

function initTypePicker(containerId, selectedTypeId) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'type-picker-grid';

  USER_PIN_TYPES.forEach(type => {
    const btn = document.createElement('button');
    btn.className = 'type-option' + (type.id === selectedTypeId ? ' selected' : '');
    btn.dataset.typeId = type.id;
    btn.title = type.label;
    btn.innerHTML =
      `<span class="type-option-dot" style="background:${type.color}"></span>` +
      `<span class="type-option-icon">${type.icon}</span>` +
      `<span class="type-option-label">${type.label}</span>`;
    btn.onclick = (e) => {
      e.preventDefault();
      grid.querySelectorAll('.type-option').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    };
    grid.appendChild(btn);
  });

  container.appendChild(grid);
}

function getSelectedPinType(containerId) {
  const btn = document.getElementById(containerId)?.querySelector('.type-option.selected');
  if (!btn) return USER_PIN_TYPES[0];
  return USER_PIN_TYPES.find(t => t.id === btn.dataset.typeId) || USER_PIN_TYPES[0];
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

  let text;
  if (blocksPerPixel < 1) {
    text = `zoom: ${zoom.toFixed(2)}`;
  } else {
    text = `1px = ${Math.round(blocksPerPixel)} block${blocksPerPixel > 1 ? 's' : ''}`;
  }

  if (layerVis.autoScale) {
    const groups = dimensionScaleLayers[activeDimension] || {};
    const visScales = Object.keys(groups)
      .filter(s => layerVis.scales[+s])
      .sort((a, b) => +a - +b);
    if (visScales.length) {
      const dots = visScales
        .map(s => `<span class="scale-dot-sm" style="background:${SCALE_COLORS[+s] ?? '#fff'}"></span>`)
        .join('');
      el.innerHTML = `${escHtml(text)}&nbsp;&nbsp;${dots}`;
      return;
    }
  }

  el.textContent = text;
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
