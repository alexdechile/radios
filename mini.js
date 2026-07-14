/* ===========================================
   RADIOS MINI — Lightweight Mobile Client
   Optimized for iPhone 6 & Small Screens
   =========================================== */

const API_SERVERS = ['de1', 'de2', 'nl1', 'at1'];
const UA = 'RadiosMiniApp/1.0';
const STORE_KEY = 'radios_playlist';

// Resolve API path relative to base path (handles /radios subpath on production)
function getApiUrl(path) {
  const prefix = window.location.pathname.startsWith('/radios') ? '/radios' : '';
  const cleanPath = path.startsWith('/') ? path : '/' + path;
  return prefix + cleanPath;
}
const SPONSORED_STATIONS = [
  {
    uuid: 'sponsored-1',
    name: 'Radio Forever',
    url: 'https://streaming.radioforever.com/radio/8000/radio.mp3',
    tags: 'pop, rock, hits',
    country: 'Sponsored',
    bitrate: '128',
    is_sponsored: true
  },
  {
    uuid: 'sponsored-2',
    name: 'Positively 80s',
    url: 'http://149.56.147.197:8121/stream',
    tags: '80s, retro, pop',
    country: 'Sponsored',
    bitrate: '128',
    is_sponsored: true
  }
];

// App State
let audio = null;
let playlist = [];
let deepDb = [];
let searchResults = [];
let cachedServer = null;
let currentStation = null;
let activeQueue = []; // currently active queue for Prev/Next (either playlist or searchResults)
let activeTab = 'results'; // 'results' or 'playlist'

// Auto-skip state
let miniAutoSkipCount = 0;
let miniAutoSkipTimer = null;

// Health check state
const MINI_HEALTH_CHECK_TIMEOUT = 6000;
const MINI_HEALTH_CONCURRENCY = 3;
let miniStationHealth = new Map();
let miniHasAutoPlayed = false;
let miniAutoPlayScanning = false;
let miniHideOffline = false;
let miniHealthCheckAborted = false;

// Now-playing poll interval
let miniNowPlayingInterval = null;

// Audio Effects state
let miniAudioCtx = null;
let miniEffectsActive = false;
let miniEffectsInjected = false;
let miniStereoWidthNode = null;
let miniSurroundNode = null;
let miniBassBoostFilter = null;

// Timer & Alarm state
let miniSleepTimeTarget = null;
let miniAlarmTime = localStorage.getItem('mini_alarm_time') || '';
let miniAlarmEnabled = localStorage.getItem('mini_alarm_enabled') === 'true';
let miniAlarmStation = localStorage.getItem('mini_alarm_station') || 'current';
let miniLastAlarmTriggeredDate = '';
let miniAlarmCheckerInterval = null;

// Initializer
document.addEventListener('DOMContentLoaded', async () => {
  audio = document.getElementById('audioElement');
  
  // Load Favorites from LocalStorage
  try {
    playlist = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
  } catch (e) {
    playlist = [];
  }

  // Sync curated radios from server SQLite
  syncCuratedFromServer();

  // Inject sponsored stations if not already present
  SPONSORED_STATIONS.forEach(s => {
    if (!playlist.some(p => p.uuid === s.uuid)) {
      playlist.unshift(s);
    }
  });
  savePlaylist();

  // Load Deep Search database
  try {
    const res = await fetch('radios_db.json');
    if (res.ok) {
      deepDb = await res.json();
    }
  } catch (e) {
    console.warn('Deep Search database not loaded in mini.', e);
  }

  setupEventListeners();
  updateFavBadge();
  renderPlaylist();

  // Load last sintonized station if saved in localStorage (optional)
  const lastSaved = localStorage.getItem('mini_last_station');
  if (lastSaved) {
    try {
      currentStation = JSON.parse(lastSaved);
      updatePlayerInfo(currentStation);
    } catch(e) {}
  }

  // Initialize Timer, Alarm and Equalizer Panel
  initMiniTimerAndAlarm();
  initMiniEqPanel();

  // Deep Linking (Play from URL)
  const params = new URLSearchParams(window.location.search);
  const playUrl = params.get('play');
  const playName = params.get('name');
  if (playUrl && playName) {
    setTimeout(() => {
      const station = {
        uuid: params.get('uuid') || Math.random().toString(36).substring(2, 11),
        name: playName,
        url: playUrl
      };
      playStation(station);
    }, 1000);
  }
});

// Setup DOM Listeners
function setupEventListeners() {
  // Classic Mode redirect button
  document.getElementById('btnClassicMode').addEventListener('click', () => {
    localStorage.setItem('force_classic_version', 'true');
    window.location.href = 'index.html';
  });

  // Export/Import JSON
  document.getElementById('btnMiniExportJSON')?.addEventListener('click', () => exportMiniPlaylist());
  document.getElementById('btnMiniImportJSON')?.addEventListener('click', () => importMiniPlaylist());

  // Effects Toggle
  document.getElementById('btnMiniEffectsToggle')?.addEventListener('click', () => {
    toggleMiniEffects();
  });

  // Stereo Width slider
  document.getElementById('miniStereoWidthSlider')?.addEventListener('input', () => {
    const slider = document.getElementById('miniStereoWidthSlider');
    const valEl = document.getElementById('miniStereoWidthVal');
    const val = parseInt(slider.value);
    if (valEl) valEl.textContent = val + '%';
    updateMiniStereoWidth(val);
  });

  // Surround toggle
  document.getElementById('miniSurroundToggle')?.addEventListener('change', () => {
    const toggle = document.getElementById('miniSurroundToggle');
    const status = document.getElementById('miniSurroundStatus');
    const on = toggle.checked;
    if (status) status.textContent = on ? 'ON' : 'OFF';
    updateMiniSurround(on);
  });

  // Bass Boost toggle
  document.getElementById('miniBassBoostToggle')?.addEventListener('change', () => {
    const toggle = document.getElementById('miniBassBoostToggle');
    const status = document.getElementById('miniBassBoostStatus');
    const on = toggle.checked;
    if (status) status.textContent = on ? 'ON' : 'OFF';
    updateMiniBassBoost(on);
  });

  // Reset all effects to Normal
  document.getElementById('btnMiniEffectsReset')?.addEventListener('click', () => {
    const swSlider = document.getElementById('miniStereoWidthSlider');
    const swVal = document.getElementById('miniStereoWidthVal');
    if (swSlider) swSlider.value = '100';
    if (swVal) swVal.textContent = '100%';
    updateMiniStereoWidth(100);

    const surrToggle = document.getElementById('miniSurroundToggle');
    const surrStatus = document.getElementById('miniSurroundStatus');
    if (surrToggle) surrToggle.checked = false;
    if (surrStatus) surrStatus.textContent = 'OFF';
    updateMiniSurround(false);

    const bassToggle = document.getElementById('miniBassBoostToggle');
    const bassStatus = document.getElementById('miniBassBoostStatus');
    if (bassToggle) bassToggle.checked = false;
    if (bassStatus) bassStatus.textContent = 'OFF';
    updateMiniBassBoost(false);

    // Reset EQ to FLAT
    document.querySelectorAll('.btn-mini-eq-preset').forEach(b => b.classList.remove('active'));
    document.querySelector('.btn-mini-eq-preset[data-preset="flat"]')?.classList.add('active');
    for (let i = 0; i < 5; i++) {
      const slider = document.getElementById(`miniEqBand${i}`);
      const valEl = document.getElementById(`miniEqVal${i}`);
      if (slider) {
        slider.value = '0';
        if (valEl) valEl.textContent = '0dB';
      }
      if (miniEqFilters[i]) {
        miniEqFilters[i].gain.value = 0;
      }
      localStorage.setItem(`mini_eq_band_${i}`, '0');
    }
  });

  // Tab switching
  const tabs = document.querySelectorAll('.mini-tabs .tab-btn');
  tabs.forEach(tab => {
    tab.addEventListener('click', (e) => {
      tabs.forEach(t => t.classList.remove('active'));
      const targetTab = e.currentTarget.getAttribute('data-tab');
      e.currentTarget.classList.add('active');
      
      activeTab = targetTab;
      if (targetTab === 'results') {
        document.getElementById('sectionResults').classList.remove('hidden');
        document.getElementById('sectionPlaylist').classList.add('hidden');
        activeQueue = searchResults;
      } else {
        document.getElementById('sectionResults').classList.add('hidden');
        document.getElementById('sectionPlaylist').classList.remove('hidden');
        activeQueue = playlist;
        renderPlaylist();
      }
    });
  });

  // Search Clear Button
  const miniSearchInput = document.getElementById('miniSearchInput');
  const miniSearchClear = document.getElementById('miniSearchClear');

  function updateMiniSearchClear() {
    if (miniSearchClear) {
      miniSearchClear.classList.toggle('visible', miniSearchInput.value.length > 0);
    }
  }

  if (miniSearchClear) {
    miniSearchClear.addEventListener('click', () => {
      miniSearchInput.value = '';
      miniSearchInput.focus();
      miniSearchClear.classList.remove('visible');
      document.getElementById('resultsList').innerHTML = `
        <div class="list-placeholder">
          <i class="fas fa-search"></i>
          <p>Busca emisoras por nombre, género o país.</p>
        </div>`;
    });
  }

  if (miniSearchInput) {
    miniSearchInput.addEventListener('input', updateMiniSearchClear);
  }

  // Search Action
  document.getElementById('btnMiniSearch').addEventListener('click', () => {
    performSearch(false);
  });

  document.getElementById('miniSearchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      performSearch(false);
      e.target.blur(); // hide keyboard on mobile
    }
  });

  // Deep Search Action
  document.getElementById('btnMiniDeepSearch').addEventListener('click', () => {
    performSearch(true);
  });

  // Player Actions
  const btnPlay = document.getElementById('btnMiniPlay');
  btnPlay.addEventListener('click', () => {
    if (!currentStation) return;
    if (audio.paused) {
      playStation(currentStation);
    } else {
      audio.pause();
    }
  });

  document.getElementById('btnMiniPrev').addEventListener('click', () => {
    miniAutoSkipCount = 0;
    if (miniAutoSkipTimer) { clearTimeout(miniAutoSkipTimer); miniAutoSkipTimer = null; }
    playNeighbor(-1);
  });

  document.getElementById('btnMiniNext').addEventListener('click', () => {
    miniAutoSkipCount = 0;
    if (miniAutoSkipTimer) { clearTimeout(miniAutoSkipTimer); miniAutoSkipTimer = null; }
    playNeighbor(1);
  });

  document.getElementById('btnMiniFav').addEventListener('click', () => {
    if (!currentStation) return;
    toggleFavorite(currentStation);
    updateMiniFavButton();
  });

  const btnMute = document.getElementById('btnMiniMute');
  btnMute.addEventListener('click', () => {
    audio.muted = !audio.muted;
    if (audio.muted) {
      btnMute.innerHTML = '<i class="fas fa-volume-xmark"></i>';
    } else {
      btnMute.innerHTML = '<i class="fas fa-volume-high"></i>';
    }
  });

  // Audio HTML5 Events
  audio.addEventListener('loadstart', () => {
    setPlayerStatus('CARGANDO...', 'loading');
  });

  audio.addEventListener('waiting', () => {
    setPlayerStatus('BUFFEREANDO...', 'loading');
  });

  audio.addEventListener('playing', () => {
    setPlayerStatus('REPRODUCIENDO', 'playing');
    btnPlay.innerHTML = '<i class="fas fa-pause"></i>';
    btnPlay.classList.add('playing');
  });

  audio.addEventListener('pause', () => {
    setPlayerStatus('PAUSADO', '');
    btnPlay.innerHTML = '<i class="fas fa-play"></i>';
    btnPlay.classList.remove('playing');
  });

  audio.addEventListener('error', (e) => {
    console.error('Audio playback error', e);
    setPlayerStatus('ERROR STREAM', 'error');
    btnPlay.innerHTML = '<i class="fas fa-play"></i>';
    btnPlay.classList.remove('playing');
    handleMiniPlaybackError();
  });

  // Simple progress animation for visual feedback (since stream is infinite, we simulate dynamic bar)
  let progressVal = 0;
  setInterval(() => {
    if (!audio.paused && !audio.muted) {
      progressVal = (progressVal + 2) % 100;
      document.getElementById('playerProgressFill').style.width = `${progressVal}%`;
    } else if (audio.paused) {
      document.getElementById('playerProgressFill').style.width = `0%`;
    }
  }, 300);
}

// Update Player Status Text & Colors
function setPlayerStatus(text, className) {
  const badge = document.getElementById('playerStatusText');
  badge.textContent = text;
  badge.className = 'player-status-badge';
  if (className) {
    badge.classList.add(className);
  }
}

// Get API Server
async function pickServer() {
  if (cachedServer) {
    try {
      const res = await fetch(`https://${cachedServer}.api.radio-browser.info/json/stations/search?name=test&limit=1&hidebroken=true`, {
        headers: { 'User-Agent': UA }
      });
      if (res.ok) return cachedServer;
    } catch {}
    cachedServer = null;
  }

  // Resolve active servers dynamically from all.api.radio-browser.info
  let activeServers = ['de1.api.radio-browser.info', 'de2.api.radio-browser.info'];
  try {
    const res = await fetch('https://all.api.radio-browser.info/json/servers', {
      headers: { 'User-Agent': UA }
    });
    if (res.ok) {
      const list = await res.json();
      if (Array.isArray(list) && list.length > 0) {
        activeServers = [...new Set(list.map(s => s.name))];
      }
    }
  } catch (e) {
    console.warn('Failed to fetch active servers list, using fallback:', e);
  }

  const shuffled = activeServers.sort(() => Math.random() - 0.5);
  for (const s of shuffled) {
    const hostname = s.includes('.api.radio-browser.info') ? s : `${s}.api.radio-browser.info`;
    try {
      const res = await fetch(`https://${hostname}/json/stations/search?name=test&limit=1&hidebroken=true`, {
        headers: { 'User-Agent': UA }
      });
      if (res.ok) {
        const prefix = hostname.split('.')[0];
        cachedServer = prefix;
        return prefix;
      }
    } catch {}
  }
  return 'de1';
}

// Perform Search (Fully aligned with app.js)
async function performSearch(isDeep) {
  // Cancel any ongoing health check
  miniHealthCheckAborted = true;

  const query = document.getElementById('miniSearchInput').value.trim();
  const codecFilter = document.getElementById('miniFilterCodec').value;
  const bitrateFilter = parseInt(document.getElementById('miniFilterBitrate').value || '0');
  const listContainer = document.getElementById('resultsList');

  if (!query) {
    listContainer.innerHTML = `
      <div class="list-placeholder">
        <i class="fas fa-circle-info"></i>
        <p>Escribe algo en el cuadro de búsqueda para empezar.</p>
      </div>`;
    return;
  }

  listContainer.innerHTML = '<div class="status-msg"><i class="fas fa-spinner fa-spin"></i> Buscando...</div>';
  
  // Make sure Results Tab is visually active
  document.getElementById('tabResults').click();

  try {
    const server = await pickServer();
    if (!server) {
      listContainer.innerHTML = '<div class="status-msg error">No hay conexión con los servidores de radios.</div>';
      return;
    }
    const base = `https://${server}.api.radio-browser.info/json/stations/search`;

    const q = query.toLowerCase();
    const COUNTRIES = {
      chile: 'CL', chilena: 'CL', chileno: 'CL',
      argentina: 'AR', argentino: 'AR',
      mexico: 'MX', mexicana: 'MX', mejico: 'MX',
      colombia: 'CO', colombiana: 'CO',
      peru: 'PE', peruana: 'PE',
      brasil: 'BR', brazil: 'BR', brasileña: 'BR',
      venezuela: 'VE', venezolana: 'VE',
      ecuador: 'EC',
      uruguay: 'UY',
      paraguay: 'PY',
      bolivia: 'BO',
      cuba: 'CU', cubana: 'CU',
      'república dominicana': 'DO', dominicana: 'DO',
      guatemala: 'GT',
      'costa rica': 'CR',
      panama: 'PA',
      'puerto rico': 'PR', boricua: 'PR',
      españa: 'ES', española: 'ES', spain: 'ES',
      usa: 'US', eeuu: 'US', 'estados unidos': 'US',
      italia: 'IT', italiana: 'IT', italiano: 'IT',
      france: 'FR', francia: 'FR', francesa: 'FR',
      alemania: 'DE', alemana: 'DE', germany: 'DE',
      uk: 'GB', 'reino unido': 'GB', inglaterra: 'GB',
      japan: 'JP', japon: 'JP',
    };

    const REGION_HINTS = {
      latina: { language: 'spanish', tag: 'latin' },
      latino: { language: 'spanish', tag: 'latin' },
      latin: { language: 'spanish', tag: 'latin' },
      latinoamerica: { language: 'spanish', tag: 'latin' },
      caribe: { language: 'spanish', tag: 'caribbean' },
      caribeña: { language: 'spanish', tag: 'caribbean' },
      caribbean: { language: 'spanish', tag: 'caribbean' },
      tropical: { tag: 'tropical' },
      sudamerica: { language: 'spanish', tag: 'south america' },
    };

    const LANGUAGE_HINTS = {
      ingles: 'english', english: 'english',
      frances: 'french', french: 'french',
      portugues: 'portuguese', portuguese: 'portuguese',
      aleman: 'german', german: 'german',
      italiano: 'italian', italian: 'italian',
      japones: 'japanese', japanese: 'japanese',
    };

    const searches = [];
    searches.push({ tag: query });
    searches.push({ name: query });

    let detectedCountry = false;
    for (const [name, code] of Object.entries(COUNTRIES)) {
      if (q.includes(name)) {
        detectedCountry = true;
        searches.push({ countrycode: code });
        if (['CL','AR','MX','CO','PE','VE','EC','UY','PY','BO','CU','DO','GT','CR','PA','PR','ES'].includes(code)) {
          searches.push({ language: 'spanish' });
        }
        if (code === 'BR') searches.push({ language: 'portuguese' });
        break;
      }
    }

    for (const [hint, params] of Object.entries(REGION_HINTS)) {
      if (q.includes(hint)) { searches.push(params); break; }
    }
    for (const [hint, lang] of Object.entries(LANGUAGE_HINTS)) {
      if (q.includes(hint)) { searches.push({ language: lang }); break; }
    }

    // Local results (Deep Search local DB)
    const localResults = deepDb.filter(s => {
      const qLow = q.toLowerCase();
      return (s.name || '').toLowerCase().includes(qLow) || (s.tags || '').toLowerCase().includes(qLow);
    });

    // Build active filters
    const filters = {};
    if (bitrateFilter > 0) filters.bitrateMin = bitrateFilter;
    if (codecFilter) filters.codec = codecFilter;

    const seenKeys = new Set();
    const unique = searches.filter(s => {
      const key = JSON.stringify(s);
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });

    const orderings = ['clicktrend', 'random', 'votes', 'clickcount'];
    const urls = [];
    unique.forEach(params => {
      const allParams = { ...params, ...filters };
      const qs = Object.entries(allParams).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
      orderings.forEach(order => {
        const reverse = (order !== 'random');
        const seed = Math.random().toString(36).substring(7);
        urls.push(`${base}?${qs}&hidebroken=true&limit=60&order=${order}${reverse ? '&reverse=true' : ''}&seed=${seed}`);
      });
    });

    // Fetch and Shuffle groups
    const apiResults = await Promise.allSettled(
      urls.map(url => fetch(url, { headers: { 'User-Agent': UA } }).then(r => r.ok ? r.json() : []))
    );

    const seen = new Set();
    const merged = [];
    const groups = [];

    if (localResults.length) groups.push(localResults.map(s => ({ ...s, stationuuid: s.uuid })));

    apiResults.forEach(r => {
      if (r.status === 'fulfilled' && Array.isArray(r.value) && r.value.length) {
        groups.push(r.value);
      }
    });

    groups.sort(() => Math.random() - 0.5);

    // Interleave: round-robin between groups
    const maxLen = groups.reduce((max, g) => Math.max(max, g.length), 0);
    for (let i = 0; i < maxLen; i++) {
      for (const group of groups) {
        if (i < group.length) {
          const s = group[i];
          const uid = s.stationuuid || s.uuid;
          if (uid && !seen.has(uid)) {
            seen.add(uid);
            merged.push(s);
          }
        }
      }
    }

    // Relevance logic: prioritize exact title matches
    const exactMatches = merged.filter(s => (s.name || '').toLowerCase().includes(q.toLowerCase()));
    const relatedMatches = merged.filter(s => !(s.name || '').toLowerCase().includes(q.toLowerCase()));

    // Prioritize HTTPS
    const sortByHttps = (a, b) => {
      const aHttps = (a.url_resolved || a.url || '').startsWith('https://') ? 0 : 1;
      const bHttps = (b.url_resolved || b.url || '').startsWith('https://') ? 0 : 1;
      return aHttps - bHttps;
    };

    const finalMerged = [...exactMatches.sort(sortByHttps), ...relatedMatches.sort(sortByHttps)];

    // Discovery Logic (favorites to bottom)
    const inPlaylistUuids = new Set(playlist.map(p => p.uuid));
    const discoveryResults = finalMerged.filter(s => !inPlaylistUuids.has(s.stationuuid || s.uuid));
    const alreadyFavorited = finalMerged.filter(s => inPlaylistUuids.has(s.stationuuid || s.uuid));

    const finalResults = [...discoveryResults, ...alreadyFavorited].slice(0, 150);

    // Map to clean format
    searchResults = finalResults.map(station => {
      const cleanUrl = (station.url_resolved || station.url || '').trim();
      return {
        uuid: station.stationuuid || station.uuid || Math.random().toString(36).substring(2, 11),
        name: station.name || 'Sin Nombre',
        url: cleanUrl,
        tags: station.tags || '',
        country: station.country || 'Desconocido',
        bitrate: station.bitrate || '0',
        codec: station.codec || 'MP3',
        is_sponsored: station.is_sponsored || false
      };
    });

    activeQueue = searchResults;
    renderResults();
    // Start health check in background (with error isolation)
    miniHasAutoPlayed = false;
    miniAutoPlayScanning = true;
    miniPrefilterResults().then(() => { miniAutoPlayScanning = false; }).catch(err => {
      miniAutoPlayScanning = false;
      console.error('[HEALTHCHECK] prefilter error:', err);
    });

  } catch (err) {
    console.error('Radio Search error:', err);
    listContainer.innerHTML = '<div class="status-msg error">Hubo un error al realizar la búsqueda.</div>';
  }
}

// Render Results List
function renderResults() {
  const listContainer = document.getElementById('resultsList');
  if (searchResults.length === 0) {
    listContainer.innerHTML = `
      <div class="list-placeholder">
        <i class="fas fa-face-frown"></i>
        <p>No se encontraron resultados para tu búsqueda.</p>
      </div>`;
    return;
  }

  listContainer.innerHTML = '';
  searchResults.forEach((station, idx) => {
    const item = createRadioItem(station, idx);
    listContainer.appendChild(item);
  });
}

// Render Playlist Favorites
function renderPlaylist() {
  const listContainer = document.getElementById('playlistList');
  if (playlist.length === 0) {
    listContainer.innerHTML = `
      <div class="list-placeholder">
        <i class="far fa-heart"></i>
        <p>Tu playlist está vacía. ¡Busca y agrega radios!</p>
      </div>`;
    return;
  }

  listContainer.innerHTML = '';
  playlist.forEach((station, idx) => {
    const item = createRadioItem(station, idx);
    listContainer.appendChild(item);
  });
}

// Create Card Radio Element — Diet Classic
function createRadioItem(station, index) {
  const isCurrent = currentStation && currentStation.url === station.url;
  const isFav = playlist.some(p => p.url === station.url);
  const favicon = station.favicon || '';
  const tags = station.tags || '';
  const tagList = tags.split(',').map(t => t.trim()).filter(Boolean).slice(0, 2);
  const metaParts = [];
  if (station.country) metaParts.push(`<span>${station.country}</span>`);
  if (station.bitrate && station.bitrate !== '0') metaParts.push(`<span>${station.bitrate}k</span>`);
  if (station.codec) metaParts.push(`<span>${station.codec}</span>`);

  const div = document.createElement('div');
  div.className = `radio-item ${isCurrent ? 'active' : ''}`;
  div.dataset.uuid = station.uuid;
  div.dataset.url = station.url;
  div.dataset.name = station.name;

  div.innerHTML = `
    <div class="radio-card-art">
      ${favicon
        ? `<img src="${escAttr(favicon)}" alt="" loading="lazy" onerror="this.style.display='none'">`
        : `<div class="placeholder-icon"><i class="fas fa-radio"></i></div>`
      }
    </div>
    <div class="radio-card-body">
      <div class="radio-item-name">
        ${escHtml(station.name)}
        <span class="mini-health-badge checking"><i class="fas fa-spinner fa-spin"></i></span>
      </div>
      ${tagList.length ? `<div class="radio-item-meta">${tagList.join(', ')}</div>` : ''}
    </div>
    <div class="radio-card-footer">
      <button class="btn-card-play">${(isCurrent && !audio.paused) ? '<i class="fas fa-pause"></i>' : '<i class="fas fa-play"></i>'}</button>
      <button class="btn-card-fav ${isFav ? 'is-fav' : ''}">${isFav ? '<i class="fas fa-heart"></i>' : '<i class="far fa-heart"></i>'}</button>
    </div>
  `;

  const userPlay = () => {
    miniAutoSkipCount = 0;
    if (miniAutoSkipTimer) { clearTimeout(miniAutoSkipTimer); miniAutoSkipTimer = null; }
    playStation(station);
  };

  div.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) {
      if (btn.classList.contains('btn-card-fav')) {
        e.stopPropagation();
        toggleFavorite(station);
        return;
      }
      if (btn.classList.contains('btn-card-play')) {
        e.stopPropagation();
        if (isCurrent && !audio.paused) {
          audio.pause();
        } else {
          userPlay();
        }
        return;
      }
    }
    userPlay();
  });

  return div;
}

function escAttr(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Toggle Favorite Station
function toggleFavorite(station) {
  const index = playlist.findIndex(p => p.url === station.url);
  if (index > -1) {
    // Check if it's sponsored. Don't remove sponsored, just alert
    if (station.is_sponsored) {
      alert("Esta radio es patrocinada del Homelab y no puede removerse de favoritos.");
      return;
    }
    const removed = playlist.splice(index, 1)[0];
    if (removed && !removed.is_sponsored) removeCuratedFromServer(removed.uuid);
  } else {
    playlist.push(station);
    if (!station.is_sponsored) syncCuratedToServer(station);
  }

  savePlaylist();
  updateFavBadge();
  updateMiniFavButton();

  // Redraw lists
  if (activeTab === 'playlist') {
    renderPlaylist();
  } else {
    renderResults();
  }

  // Refresh currently active card icons if they were affected
  updateRadioCardsActiveState();
}

// Update Favorite Badge Count
function updateFavBadge() {
  document.getElementById('favCount').textContent = playlist.length;
}

// Update Player Heart Button State
function updateMiniFavButton() {
  const btn = document.getElementById('btnMiniFav');
  if (!btn) return;
  if (!currentStation) {
    btn.classList.remove('is-fav');
    btn.title = 'Favoritos';
    btn.innerHTML = '<i class="far fa-heart"></i>';
    return;
  }
  const inPl = playlist.some(p => p.url === currentStation.url);
  if (inPl) {
    btn.classList.add('is-fav');
    btn.title = 'Quitar de favoritos';
    btn.innerHTML = '<i class="fas fa-heart"></i>';
  } else {
    btn.classList.remove('is-fav');
    btn.title = 'Agregar a favoritos';
    btn.innerHTML = '<i class="far fa-heart"></i>';
  }
}

/* ── Health Check ── */
async function miniCheckStationHealth(url) {
  try {
    const ep = getApiUrl(`api/healthcheck?url=${encodeURIComponent(url)}&timeout=${MINI_HEALTH_CHECK_TIMEOUT}`);
    const res = await fetch(ep);
    if (!res.ok) return { healthy: false, timeMs: 0, status: res.status };
    return await res.json();
  } catch {
    return { healthy: false, timeMs: 0, status: 0 };
  }
}

function miniUpdateHealthBadge(el, result) {
  const badge = el.querySelector('.mini-health-badge');
  if (!badge) return;
  const healthy = result && result.healthy === true;
  badge.className = `mini-health-badge ${healthy ? 'healthy' : 'unhealthy'}`;
  badge.innerHTML = healthy
    ? `<span>✓</span>`
    : `<span>✗</span>`;
  if (!healthy) {
    badge.style.cursor = 'pointer';
    badge.title = 'Toca para re-verificar';
    badge.onclick = (e) => {
      e.stopPropagation();
      miniRecheckStation(el);
    };
  } else {
    badge.onclick = null;
    badge.style.cursor = 'default';
    badge.title = 'Disponible';
  }
  const url = el.dataset.url;
  if (url) miniStationHealth.set(url, healthy);
}

function miniRecheckStation(el) {
  const url = el.dataset.url;
  if (!url) return;
  const badge = el.querySelector('.mini-health-badge');
  if (!badge) return;
  badge.className = 'mini-health-badge checking';
  badge.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  miniCheckStationHealth(url).then(result => {
    miniUpdateHealthBadge(el, result);
  });
}

async function miniPrefilterResults() {
  miniHealthCheckAborted = false;
  const items = [...document.querySelectorAll('#resultsList .radio-item')];
  let firstHealthyFound = false;

  for (let i = 0; i < items.length; i += MINI_HEALTH_CONCURRENCY) {
    if (miniHealthCheckAborted) break;
    const batch = items.slice(i, i + MINI_HEALTH_CONCURRENCY);
    const checks = batch.map(async (el) => {
      if (miniHealthCheckAborted) return;
      const url = el.dataset.url;
      if (!url) return;
      const badge = el.querySelector('.mini-health-badge');
      if (badge) badge.className = 'mini-health-badge checking';
      const result = await miniCheckStationHealth(url);
      if (miniHealthCheckAborted) return;
      miniUpdateHealthBadge(el, result);
      const healthy = result && result.healthy === true;
      if (healthy && !firstHealthyFound && !miniHasAutoPlayed && !miniHealthCheckAborted) {
        firstHealthyFound = true;
        miniHasAutoPlayed = true;
        const station = searchResults.find(s => s.url === url) || playlist.find(s => s.url === url);
        if (station) {
          el.classList.add('active');
          setPlayerStatus('Conectando...', 'loading');
          playStation(station);
        }
      }
    });
    await Promise.allSettled(checks);
  }

  if (!firstHealthyFound && !miniHasAutoPlayed && items.length > 0 && !miniHealthCheckAborted) {
    setPlayerStatus('Toca una radio', '');
  }
  miniHealthCheckAborted = false;
}

function miniSilentSkip() {
  if (activeQueue.length === 0) {
    activeQueue = activeTab === 'results' ? searchResults : playlist;
  }
  if (activeQueue.length === 0) return;
  let idx = -1;
  if (currentStation) {
    idx = activeQueue.findIndex(s => s.url === currentStation.url);
  }
  let next = idx + 1;
  if (next < 0) next = 0;
  if (next >= activeQueue.length) {
    setPlayerStatus('Sin conexión', '');
    return;
  }
  playStation(activeQueue[next]);
}

// Sintonize & Play Station
function playStation(station) {
  if (!station || !station.url) return;

  // Stop auto-play scanning
  miniAutoPlayScanning = false;
  miniHasAutoPlayed = true;
  miniHealthCheckAborted = true;

  currentStation = station;
  localStorage.setItem('mini_last_station', JSON.stringify(station));
  
  updatePlayerInfo(station);
  updateMiniFavButton();

  // Set visual active element in lists
  updateRadioCardsActiveState();

  // Load URL in native Audio Element
  setPlayerStatus('CARGANDO...', 'loading');
  audio.src = station.url;
  
  // En iPhone 6 / iOS, play() requiere interacción explícita del usuario
  const playPromise = audio.play();
  if (playPromise !== undefined) {
    playPromise.catch(error => {
      console.warn("Playback prevented or error:", error);
      setPlayerStatus('PAUSADO', '');
      const btnPlay = document.getElementById('btnMiniPlay');
      btnPlay.innerHTML = '<i class="fas fa-play"></i>';
      btnPlay.classList.remove('playing');
      handleMiniPlaybackError();
    });
  }

  // Start now-playing polling
  fetchMiniNowPlaying(station.url);
}

/* ── Mini Now Playing ── */
function fetchMiniNowPlaying(stationUrl) {
  if (miniNowPlayingInterval) {
    clearInterval(miniNowPlayingInterval);
    miniNowPlayingInterval = null;
  }

  const doFetch = async () => {
    if (!stationUrl) return;
    const trackEl = document.getElementById('miniNowPlayingTrack');
    const trackText = document.getElementById('miniNowPlayingText');
    if (!trackEl || !trackText) return;
    try {
      const res = await fetch(getApiUrl(`/api/nowplaying?url=${encodeURIComponent(stationUrl)}`));
      if (res.ok) {
        const data = await res.json();
        if (data && data.title) {
          trackText.textContent = data.title;
          trackEl.classList.remove('hidden');
        } else {
          trackEl.classList.add('hidden');
        }
      }
    } catch {}
  };

  doFetch();
  miniNowPlayingInterval = setInterval(doFetch, 15000);
}

// Update visual play/pause/active states in cards
function updateRadioCardsActiveState() {
  const items = document.querySelectorAll('.radio-item');
  items.forEach(item => {
    const isThisCurrent = currentStation && item.getAttribute('data-uuid') === currentStation.uuid;
    const playBtn = item.querySelector('.btn-card-play');
    const favBtn = item.querySelector('.btn-card-fav');
    
    if (isThisCurrent) {
      item.classList.add('active');
      if (playBtn) playBtn.innerHTML = audio.paused ? '<i class="fas fa-play"></i>' : '<i class="fas fa-pause"></i>';
    } else {
      item.classList.remove('active');
      if (playBtn) playBtn.innerHTML = '<i class="fas fa-play"></i>';
    }

    if (!favBtn) return;
    const isFav = playlist.some(p => p.uuid === item.getAttribute('data-uuid') || p.url === item.dataset.url);
    if (isFav) {
      favBtn.className = 'btn-card-fav is-fav';
      favBtn.innerHTML = '<i class="fas fa-heart"></i>';
    } else {
      favBtn.className = 'btn-card-fav';
      favBtn.innerHTML = '<i class="far fa-heart"></i>';
    }
  });
}

// Play neighboring station (Prev/Next)
function playNeighbor(direction) {
  if (activeQueue.length === 0) {
    activeQueue = activeTab === 'results' ? searchResults : playlist;
  }
  if (activeQueue.length === 0) return;

  let index = -1;
  if (currentStation) {
    index = activeQueue.findIndex(s => s.url === currentStation.url);
  }

  let nextIdx = index + direction;
  if (nextIdx < 0) nextIdx = activeQueue.length - 1;
  if (nextIdx >= activeQueue.length) nextIdx = 0;

  const nextStation = activeQueue[nextIdx];
  if (nextStation) {
    playStation(nextStation);
  }
}

function handleMiniPlaybackError() {
  if (miniAutoSkipTimer) return;
  if (activeQueue.length === 0) {
    activeQueue = activeTab === 'results' ? searchResults : playlist;
  }
  if (activeQueue.length > 0) {
    if (miniAutoSkipCount >= activeQueue.length) {
      console.warn('[AUTO-SKIP] All stations failed, stopping.');
      setPlayerStatus('TODO FALLARON', 'error');
      return;
    }
    miniAutoSkipCount++;
    if (miniAutoPlayScanning) {
      // Silent skip during health check auto-play
      setPlayerStatus('Buscando...', 'loading');
      miniAutoSkipTimer = setTimeout(() => {
        miniAutoSkipTimer = null;
        miniSilentSkip();
      }, 800);
    } else {
      setPlayerStatus('SIGUIENTE...', 'loading');
      miniAutoSkipTimer = setTimeout(() => {
        miniAutoSkipTimer = null;
        playNeighbor(1);
      }, 2000);
    }
  }
}

/* ── Mini Audio Effects ── */
const MINI_EQ_BANDS = [
  { freq: 60,    type: 'lowshelf'  },
  { freq: 250,   type: 'peaking'   },
  { freq: 1000,  type: 'peaking'   },
  { freq: 4000,  type: 'peaking'   },
  { freq: 16000, type: 'highshelf' },
];
let miniEqFilters = []; // 5 BiquadFilter nodes

function initMiniEffectsChain() {
  if (miniAudioCtx && miniEffectsInjected) return;
  if (!audio) return;

  try {
    miniAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = miniAudioCtx.createMediaElementSource(audio);

    // Build EQ filter chain
    miniEqFilters = MINI_EQ_BANDS.map((band, i) => {
      const filter = miniAudioCtx.createBiquadFilter();
      filter.type = band.type;
      filter.frequency.value = band.freq;
      filter.Q.value = 1.4;
      const saved = parseFloat(localStorage.getItem(`mini_eq_band_${i}`) || '0');
      filter.gain.value = saved;
      return filter;
    });

    // Stereo Width
    const swSplitter = miniAudioCtx.createChannelSplitter(2);
    const swGL = miniAudioCtx.createGain();
    const swGR = miniAudioCtx.createGain();
    const swGXL = miniAudioCtx.createGain();
    const swGXR = miniAudioCtx.createGain();
    const swMerger = miniAudioCtx.createChannelMerger(2);
    const savedW = parseFloat(localStorage.getItem('mini_fx_stereo_width') || '100');
    const wN = savedW / 100;
    swGL.gain.value = (1 + wN) / 2;
    swGR.gain.value = (1 + wN) / 2;
    swGXL.gain.value = (1 - wN) / 2;
    swGXR.gain.value = (1 - wN) / 2;
    swSplitter.connect(swGL, 0, 0);
    swSplitter.connect(swGXR, 1, 0);
    swGL.connect(swMerger, 0, 0);
    swGXR.connect(swMerger, 0, 0);
    swSplitter.connect(swGXL, 0, 0);
    swSplitter.connect(swGR, 1, 0);
    swGXL.connect(swMerger, 0, 1);
    swGR.connect(swMerger, 0, 1);
    miniStereoWidthNode = { gains: [swGL, swGR, swGXL, swGXR], merger: swMerger };

    // Surround
    const srSplitter = miniAudioCtx.createChannelSplitter(2);
    const srDelay = miniAudioCtx.createDelay(0.1);
    srDelay.delayTime.value = localStorage.getItem('mini_fx_surround') === 'true' ? 0.025 : 0.001;
    const srMerger = miniAudioCtx.createChannelMerger(2);
    srSplitter.connect(srDelay, 0, 0);
    srDelay.connect(srMerger, 0, 0);
    srSplitter.connect(srMerger, 1, 1);
    miniSurroundNode = { splitter: srSplitter, delay: srDelay, merger: srMerger };

    // Bass Boost
    miniBassBoostFilter = miniAudioCtx.createBiquadFilter();
    miniBassBoostFilter.type = 'lowshelf';
    miniBassBoostFilter.frequency.value = 80;
    miniBassBoostFilter.Q.value = 0.8;
    miniBassBoostFilter.gain.value = localStorage.getItem('mini_fx_bass_boost') === 'true' ? 6 : 0;

    // Connect chain
    let node = source;
    for (const filter of miniEqFilters) {
      node.connect(filter);
      node = filter;
    }
    node.connect(swSplitter);
    swMerger.connect(srSplitter);
    srMerger.connect(miniBassBoostFilter);
    miniBassBoostFilter.connect(miniAudioCtx.destination);

    miniEffectsInjected = true;
  } catch (e) {
    console.warn('Mini effects chain init failed:', e);
    miniAudioCtx = null;
    miniEffectsInjected = false;
  }
}

function updateMiniStereoWidth(percent) {
  if (!miniStereoWidthNode) return;
  const wN = percent / 100;
  miniStereoWidthNode.gains[0].gain.value = (1 + wN) / 2;
  miniStereoWidthNode.gains[1].gain.value = (1 + wN) / 2;
  miniStereoWidthNode.gains[2].gain.value = (1 - wN) / 2;
  miniStereoWidthNode.gains[3].gain.value = (1 - wN) / 2;
  localStorage.setItem('mini_fx_stereo_width', percent);
}

function updateMiniSurround(enabled) {
  if (!miniSurroundNode) return;
  miniSurroundNode.delay.delayTime.value = enabled ? 0.025 : 0.001;
  localStorage.setItem('mini_fx_surround', enabled);
}

function updateMiniBassBoost(enabled) {
  if (!miniBassBoostFilter) return;
  miniBassBoostFilter.gain.value = enabled ? 6 : 0;
  localStorage.setItem('mini_fx_bass_boost', enabled);
}

function toggleMiniEffects() {
  const panel = document.getElementById('miniEffectsPanel');
  const btn = document.getElementById('btnMiniEffectsToggle');
  miniEffectsActive = !miniEffectsActive;
  panel.classList.toggle('hidden', !miniEffectsActive);
  btn.classList.toggle('active', miniEffectsActive);

  if (miniEffectsActive) {
    initMiniEffectsChain();
  }
}

// Save Playlist
function savePlaylist() {
  localStorage.setItem(STORE_KEY, JSON.stringify(playlist));
}

/* ── SQLite Curated Radios Sync ── */
async function syncCuratedFromServer() {
  try {
    const res = await fetch(getApiUrl('/api/curated'));
    if (res.ok) {
      const serverList = await res.json();
      if (Array.isArray(serverList) && serverList.length > 0) {
        const localUuids = new Set(playlist.map(s => s.uuid));
        let added = 0;
        serverList.forEach(s => {
          if (s.uuid && !localUuids.has(s.uuid) && !s.is_sponsored) {
            playlist.push(s);
            localUuids.add(s.uuid);
            added++;
          }
        });
        if (added > 0) {
          savePlaylist();
          renderPlaylist();
          updateFavBadge();
        }
      }
    }
  } catch (e) {
    console.warn('SQLite sync from server failed, using localStorage:', e);
  }
}

async function syncCuratedToServer(station) {
  try {
    await fetch(getApiUrl('/api/curated'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(station),
    });
  } catch (e) {
    console.warn('SQLite sync to server failed:', e);
  }
}

async function removeCuratedFromServer(uuid) {
  try {
    await fetch(getApiUrl(`/api/curated?uuid=${encodeURIComponent(uuid)}`), { method: 'DELETE' });
  } catch (e) {
    console.warn('SQLite remove from server failed:', e);
  }
}

// Update Player Panel Info
function updatePlayerInfo(station) {
  document.getElementById('nowPlayingTitle').textContent = station.name;
  
  let subtitle = '';
  if (station.country) subtitle += `${station.country} `;
  if (station.codec) subtitle += `• ${station.codec} `;
  if (station.bitrate && station.bitrate !== '0') subtitle += `• ${station.bitrate}kbps `;
  if (station.tags) subtitle += `• ${station.tags.split(',').slice(0, 2).join(', ')}`;
  
  document.getElementById('nowPlayingSub').textContent = subtitle;
}

// Export playlist as JSON
function exportMiniPlaylist() {
  const dataStr = JSON.stringify(playlist, null, 2);
  const blob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `radios-playlist-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// Import playlist from JSON
function importMiniPlaylist() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (Array.isArray(data)) {
          playlist = data;
          savePlaylist();
          renderPlaylist();
          updateFavBadge();
          updateRadioCardsActiveState();
        }
      } catch (err) {
        alert('Error al cargar el archivo JSON');
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

/* ── Sleep Timer & Alarm Clock Logic (Mini) ── */
function initMiniTimerAndAlarm() {
  const btnToggle = document.getElementById('btnMiniTimerToggle');
  const modal = document.getElementById('miniTimerModal');
  const btnClose = document.getElementById('btnCloseMiniTimerModal');
  
  if (!btnToggle || !modal || !btnClose) return;

  btnToggle.addEventListener('click', () => {
    modal.classList.add('show');
    populateMiniAlarmStations();
    updateMiniTimerModalUI();
  });

  btnClose.addEventListener('click', () => {
    modal.classList.remove('show');
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.remove('show');
    }
  });

  document.getElementById('miniTimerIndicator')?.addEventListener('click', () => btnToggle.click());
  document.getElementById('miniAlarmIndicator')?.addEventListener('click', () => btnToggle.click());

  // Sleep Presets
  const presets = document.querySelectorAll('.mini-sleep-presets .btn-mini-preset[data-minutes]');
  presets.forEach(btn => {
    btn.addEventListener('click', () => {
      presets.forEach(p => p.classList.remove('active'));
      document.getElementById('miniCustomSleepInputWrap').classList.add('hidden');
      
      const mins = parseInt(btn.dataset.minutes);
      miniSleepTimeTarget = Date.now() + mins * 60 * 1000;
      updateMiniTimerModalUI();
      updateMiniBadges();
      btn.classList.add('active');
    });
  });

  const btnCustom = document.getElementById('btnMiniCustomSleep');
  const customWrap = document.getElementById('miniCustomSleepInputWrap');
  if (btnCustom && customWrap) {
    btnCustom.addEventListener('click', () => {
      presets.forEach(p => p.classList.remove('active'));
      btnCustom.classList.add('active');
      customWrap.classList.remove('hidden');
      document.getElementById('inputMiniCustomSleep').focus();
    });
  }

  document.getElementById('btnMiniApplyCustomSleep')?.addEventListener('click', () => {
    const input = document.getElementById('inputMiniCustomSleep');
    const mins = parseInt(input.value);
    if (isNaN(mins) || mins <= 0) {
      alert('Ingresa un número válido de minutos');
      return;
    }
    miniSleepTimeTarget = Date.now() + mins * 60 * 1000;
    updateMiniTimerModalUI();
    updateMiniBadges();
  });

  // Alarm Clock Setup
  const inputAlarmTime = document.getElementById('inputMiniAlarmTime');
  const btnToggleAlarm = document.getElementById('btnMiniToggleAlarm');
  const selectAlarmStation = document.getElementById('selectMiniAlarmStation');

  if (inputAlarmTime) inputAlarmTime.value = miniAlarmTime;
  if (selectAlarmStation) {
    selectAlarmStation.value = miniAlarmStation;
    selectAlarmStation.addEventListener('change', () => {
      miniAlarmStation = selectAlarmStation.value;
      localStorage.setItem('mini_alarm_station', miniAlarmStation);
      updateMiniTimerModalUI();
      updateMiniBadges();
    });
  }

  if (btnToggleAlarm) {
    btnToggleAlarm.addEventListener('click', () => {
      if (miniAlarmEnabled) {
        miniAlarmEnabled = false;
        localStorage.setItem('mini_alarm_enabled', 'false');
      } else {
        const val = inputAlarmTime.value;
        if (!val) {
          alert('Por favor selecciona una hora para la alarma.');
          return;
        }
        miniAlarmTime = val;
        miniAlarmEnabled = true;
        localStorage.setItem('mini_alarm_time', miniAlarmTime);
        localStorage.setItem('mini_alarm_enabled', 'true');
      }
      updateMiniTimerModalUI();
      updateMiniBadges();
    });
  }

  if (inputAlarmTime) {
    inputAlarmTime.addEventListener('change', () => {
      miniAlarmTime = inputAlarmTime.value;
      localStorage.setItem('mini_alarm_time', miniAlarmTime);
      if (miniAlarmEnabled) {
        updateMiniTimerModalUI();
        updateMiniBadges();
      }
    });
  }

  if (miniAlarmCheckerInterval) clearInterval(miniAlarmCheckerInterval);
  miniAlarmCheckerInterval = setInterval(() => {
    checkMiniAlarm();
    updateMiniSleepCountdown();
  }, 1000);

  updateMiniTimerModalUI();
  updateMiniBadges();
}

function checkMiniAlarm() {
  if (!miniAlarmEnabled || !miniAlarmTime) return;

  const now = new Date();
  const hrs = now.getHours().toString().padStart(2, '0');
  const mins = now.getMinutes().toString().padStart(2, '0');
  const currentTimeString = `${hrs}:${mins}`;

  if (currentTimeString === miniAlarmTime) {
    const todayStr = now.toDateString() + ' ' + currentTimeString;
    if (miniLastAlarmTriggeredDate !== todayStr) {
      miniLastAlarmTriggeredDate = todayStr;
      triggerMiniAlarm();
    }
  }
}

function triggerMiniAlarm() {
  console.log('[ALARM] Mini Alarm clock triggered at %s!', miniAlarmTime);
  let targetStation = null;
  if (miniAlarmStation !== 'current') {
    targetStation = playlist.find(s => (s.uuid || s.stationuuid) === miniAlarmStation);
  }
  const marquee = document.getElementById('nowPlayingTitle');
  if (targetStation) {
    if (marquee) marquee.textContent = `⏰ ¡ALARMA! Sintonizando ${targetStation.name}...`;
    playStation(targetStation);
  } else {
    if (currentStation) {
      if (marquee) marquee.textContent = `⏰ ¡ALARMA! Sintonizando ${currentStation.name}...`;
      playStation(currentStation);
    } else if (playlist.length > 0) {
      const first = playlist[0];
      if (marquee) marquee.textContent = `⏰ ¡ALARMA! Sintonizando ${first.name}...`;
      playStation(first);
    } else {
      if (marquee) marquee.textContent = '⏰ ¡ALARMA! (No hay favoritos)';
      const fallback = SPONSORED_STATIONS[0];
      playStation(fallback);
    }
  }
}

function updateMiniSleepCountdown() {
  if (!miniSleepTimeTarget) return;
  
  const diff = miniSleepTimeTarget - Date.now();
  if (diff <= 0) {
    miniSleepTimeTarget = null;
    triggerMiniSleepStop();
  } else {
    updateMiniBadges();
    const statusDiv = document.getElementById('miniSleepTimerStatus');
    if (statusDiv) {
      const remainingSecs = Math.floor(diff / 1000);
      const m = Math.floor(remainingSecs / 60).toString().padStart(2, '0');
      const s = (remainingSecs % 60).toString().padStart(2, '0');
      statusDiv.innerHTML = `
        <span>⏳ Quedan <strong>${m}:${s}</strong> min para apagar.</span>
        <button class="btn-cancel-timer" onclick="cancelMiniSleepTimer()">Cancelar</button>
      `;
      statusDiv.classList.add('active');
    }
  }
}

function triggerMiniSleepStop() {
  console.log('[TIMER] Mini Sleep timer triggered. Stopping playback.');
  if (audio) {
    audio.pause();
  }
  const marquee = document.getElementById('nowPlayingTitle');
  if (marquee) marquee.textContent = 'Apagado automático por temporizador';
  
  updateMiniTimerModalUI();
  updateMiniBadges();
}

function cancelMiniSleepTimer() {
  miniSleepTimeTarget = null;
  const presets = document.querySelectorAll('.mini-sleep-presets .btn-mini-preset');
  presets.forEach(p => p.classList.remove('active'));
  const customWrap = document.getElementById('miniCustomSleepInputWrap');
  if (customWrap) customWrap.classList.add('hidden');
  const customInput = document.getElementById('inputMiniCustomSleep');
  if (customInput) customInput.value = '';
  
  updateMiniTimerModalUI();
  updateMiniBadges();
}
window.cancelMiniSleepTimer = cancelMiniSleepTimer;

function updateMiniBadges() {
  const btnToggle = document.getElementById('btnMiniTimerToggle');
  const alarmBadge = document.getElementById('miniAlarmIndicator');
  const sleepBadge = document.getElementById('miniTimerIndicator');

  let anyActive = false;

  // Alarm Badge
  if (alarmBadge) {
    if (miniAlarmEnabled && miniAlarmTime) {
      alarmBadge.textContent = `⏰ ${miniAlarmTime}`;
      alarmBadge.classList.remove('hidden');
      anyActive = true;
    } else {
      alarmBadge.classList.add('hidden');
    }
  }

  // Sleep Badge
  if (sleepBadge) {
    if (miniSleepTimeTarget) {
      const remaining = Math.max(0, Math.floor((miniSleepTimeTarget - Date.now()) / 1000));
      const m = Math.floor(remaining / 60);
      const s = remaining % 60;
      sleepBadge.textContent = `⏳ ${m}:${s.toString().padStart(2, '0')}`;
      sleepBadge.classList.remove('hidden');
      anyActive = true;
    } else {
      sleepBadge.classList.add('hidden');
    }
  }

  // Main Toggle Button in Header
  if (btnToggle) {
    if (anyActive) {
      btnToggle.classList.add('active');
    } else {
      btnToggle.classList.remove('active');
    }
  }
}

function updateMiniTimerModalUI() {
  const statusDiv = document.getElementById('miniSleepTimerStatus');
  if (statusDiv) {
    if (miniSleepTimeTarget) {
      const remainingSecs = Math.max(0, Math.floor((miniSleepTimeTarget - Date.now()) / 1000));
      const m = Math.floor(remainingSecs / 60).toString().padStart(2, '0');
      const s = (remainingSecs % 60).toString().padStart(2, '0');
      statusDiv.innerHTML = `
        <span>⏳ Quedan <strong>${m}:${s}</strong> min para apagar.</span>
        <button class="btn-cancel-timer" onclick="cancelMiniSleepTimer()">Cancelar</button>
      `;
      statusDiv.classList.add('active');
    } else {
      statusDiv.innerHTML = '<span>Apagado automático desactivado.</span>';
      statusDiv.classList.remove('active');
    }
  }

  const btnToggleAlarm = document.getElementById('btnMiniToggleAlarm');
  const alarmStatusDiv = document.getElementById('miniAlarmStatus');
  const inputAlarmTime = document.getElementById('inputMiniAlarmTime');

  if (btnToggleAlarm) {
    if (miniAlarmEnabled) {
      btnToggleAlarm.textContent = 'Desactivar';
      btnToggleAlarm.classList.add('active');
    } else {
      btnToggleAlarm.textContent = 'Activar';
      btnToggleAlarm.classList.remove('active');
    }
  }

  if (alarmStatusDiv) {
    if (miniAlarmEnabled && miniAlarmTime) {
      let stationName = 'Radio actual';
      if (miniAlarmStation !== 'current') {
        const station = playlist.find(s => (s.uuid || s.stationuuid) === miniAlarmStation);
        if (station) stationName = station.name;
      }
      alarmStatusDiv.innerHTML = `
        <span>🔔 Activa a las <strong>${miniAlarmTime}</strong> sintonizando <em>"${stationName}"</em>.</span>
      `;
      alarmStatusDiv.classList.add('active');
    } else {
      alarmStatusDiv.innerHTML = '<span>Alarma desactivada.</span>';
      alarmStatusDiv.classList.remove('active');
    }
  }
}

function populateMiniAlarmStations() {
  const select = document.getElementById('selectMiniAlarmStation');
  if (!select) return;
  
  const currentVal = select.value || miniAlarmStation;
  select.innerHTML = '<option value="current">Radio sintonizada</option>';
  
  playlist.forEach(s => {
    const uuid = s.uuid || s.stationuuid || '';
    if (!uuid) return;
    const option = document.createElement('option');
    option.value = uuid;
    option.textContent = s.name;
    select.appendChild(option);
  });
  
  if (Array.from(select.options).some(opt => opt.value === currentVal)) {
    select.value = currentVal;
  } else {
    select.value = 'current';
  }
}

/* ── Equalizer Panel UI (Mini) ── */
function initMiniEqPanel() {
  // Restore sliders from localstorage
  for (let i = 0; i < 5; i++) {
    const slider = document.getElementById(`miniEqBand${i}`);
    const valEl = document.getElementById(`miniEqVal${i}`);
    if (slider) {
      const saved = localStorage.getItem(`mini_eq_band_${i}`) || '0';
      slider.value = saved;
      if (valEl) valEl.textContent = `${saved}dB`;

      slider.addEventListener('input', () => {
        const val = parseFloat(slider.value);
        if (valEl) valEl.textContent = `${val}dB`;
        if (miniEqFilters[i]) {
          miniEqFilters[i].gain.value = val;
        }
        localStorage.setItem(`mini_eq_band_${i}`, val);
        
        // Remove preset highlights
        document.querySelectorAll('.btn-mini-eq-preset').forEach(b => b.classList.remove('active'));
      });
    }
  }

  // Presets
  const EQ_PRESETS = {
    flat:   [0,   0,   0,   0,   0 ],
    bass:   [8,   4,   0,  -2,  -2 ],
    vocal:  [-2,  0,   5,   4,   0 ],
    treble: [-2, -2,   0,   4,   8 ],
  };

  document.querySelectorAll('.btn-mini-eq-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const presetName = btn.dataset.preset;
      const gains = EQ_PRESETS[presetName];
      if (!gains) return;

      document.querySelectorAll('.btn-mini-eq-preset').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      gains.forEach((gain, i) => {
        const slider = document.getElementById(`miniEqBand${i}`);
        const valEl = document.getElementById(`miniEqVal${i}`);
        if (slider) {
          slider.value = gain;
          if (valEl) valEl.textContent = `${gain}dB`;
        }
        if (miniEqFilters[i]) {
          miniEqFilters[i].gain.value = gain;
        }
        localStorage.setItem(`mini_eq_band_${i}`, gain);
      });
    });
  });

  // Restore preset active highlight if it matches
  const currentGains = [];
  for (let i = 0; i < 5; i++) {
    currentGains.push(parseFloat(localStorage.getItem(`mini_eq_band_${i}`) || '0'));
  }
  for (const [name, gains] of Object.entries(EQ_PRESETS)) {
    if (gains.every((g, idx) => g === currentGains[idx])) {
      document.querySelector(`.btn-mini-eq-preset[data-preset="${name}"]`)?.classList.add('active');
    }
  }
}

