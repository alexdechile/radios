/* ===========================================
   RADIOS MINI — Lightweight Mobile Client
   Optimized for iPhone 6 & Small Screens
   =========================================== */

const API_SERVERS = ['de1', 'de2', 'nl1', 'at1'];
const UA = 'RadiosMiniApp/1.0';
const STORE_KEY = 'radios_playlist';
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
    playNeighbor(-1);
  });

  document.getElementById('btnMiniNext').addEventListener('click', () => {
    playNeighbor(1);
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

  const shuffled = [...API_SERVERS].sort(() => Math.random() - 0.5);
  for (const s of shuffled) {
    try {
      const res = await fetch(`https://${s}.api.radio-browser.info/json/stations/search?name=test&limit=1&hidebroken=true`, {
        headers: { 'User-Agent': UA }
      });
      if (res.ok) {
        cachedServer = s;
        return s;
      }
    } catch {}
  }
  return null;
}

// Perform Search (Fully aligned with app.js)
async function performSearch(isDeep) {
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
      <div class="radio-item-name">${escHtml(station.name)}</div>
      ${tagList.length ? `<div class="radio-item-meta">${tagList.join(', ')}</div>` : ''}
    </div>
    <div class="radio-card-footer">
      <button class="btn-card-play">${(isCurrent && !audio.paused) ? '<i class="fas fa-pause"></i>' : '<i class="fas fa-play"></i>'}</button>
      <button class="btn-card-fav ${isFav ? 'is-fav' : ''}">${isFav ? '<i class="fas fa-heart"></i>' : '<i class="far fa-heart"></i>'}</button>
    </div>
  `;

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
          playStation(station);
        }
        return;
      }
    }
    playStation(station);
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

// Sintonize & Play Station
function playStation(station) {
  if (!station || !station.url) return;

  currentStation = station;
  localStorage.setItem('mini_last_station', JSON.stringify(station));
  
  updatePlayerInfo(station);

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
    });
  }
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

// Save Playlist
function savePlaylist() {
  localStorage.setItem(STORE_KEY, JSON.stringify(playlist));
}

/* ── SQLite Curated Radios Sync ── */
async function syncCuratedFromServer() {
  try {
    const res = await fetch('/api/curated');
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
    await fetch('/api/curated', {
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
    await fetch(`/api/curated?uuid=${encodeURIComponent(uuid)}`, { method: 'DELETE' });
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
