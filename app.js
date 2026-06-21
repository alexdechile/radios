/* ===========================================
   RADIOS APP — Sketch Player
   Radio Browser API + Plyr + Playlist
   =========================================== */

const API_SERVERS = ['de1', 'de2', 'nl1', 'at1'];
const UA = 'RadiosSketchApp/1.0';
const STORE_KEY = 'radios_playlist';
const HISTORY_KEY = 'radios_search_history';
const APP_VERSION = '1.1.3';

// Radios patrocinadas que SIEMPRE aparecen al iniciar
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

let player = null;
let playlist = [];
let searchHistory = [];
let deepDb = [];
let cachedServer = null;
let metadataInterval = null;
let audioCtx = null;
let analyser = null;

/* ── Init ── */
async function init() {
  await checkUpdate();

  // Service Worker for PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  playlist = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
  searchHistory = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');

  // Inyectar patrocinadas (asegurando que no se repitan)
  SPONSORED_STATIONS.forEach(sponsored => {
    if (!playlist.some(p => p.uuid === sponsored.uuid)) {
      playlist.unshift(sponsored); // Al principio de la lista
    }
  });

  // Load Deep Search Database
  try {
    const res = await fetch('radios_db.json');
    if (res.ok) deepDb = await res.json();
  } catch (e) {
    console.warn('Deep Search database not found or invalid.');
  }

  player = new Plyr('#audioPlayer', {
    controls: ['play-large', 'play', 'progress', 'current-time', 'mute', 'volume'],
    displayDuration: false,
    clickToPlay: true,
    resetOnEnd: false,
  });

  player.on('timeupdate', () => {
    const displayTime = document.getElementById('radioDisplayTime');
    if (displayTime) {
      const mins = Math.floor(player.currentTime / 60).toString().padStart(2, '0');
      const secs = Math.floor(player.currentTime % 60).toString().padStart(2, '0');
      displayTime.textContent = `${mins}:${secs}`;
    }
  });

  renderPlaylist();

  const input = document.getElementById('searchInput');
  const historyDropdown = document.getElementById('searchHistory');
  let debounce;

  if (input) {
    input.addEventListener('input', () => {
      clearTimeout(debounce);
      const q = input.value.trim();
      renderHistory(q);
      if (q.length < 2) {
        document.getElementById('results').innerHTML = '';
        return;
      }
      debounce = setTimeout(() => search(q), 400);
    });

    input.addEventListener('focus', () => {
      renderHistory(input.value.trim());
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(debounce);
        const q = input.value.trim();
        if (q.length >= 2) {
          search(q);
          saveToHistory(q);
          if (historyDropdown) historyDropdown.classList.add('hidden');
        }
      }
    });
  }

  // Hide history when clicking outside
  document.addEventListener('click', (e) => {
    if (historyDropdown && !e.target.closest('.search-wrapper')) {
      historyDropdown.classList.add('hidden');
    }
  });

  if (historyDropdown) {
    historyDropdown.addEventListener('click', (e) => {
      const item = e.target.closest('.history-item');
      const btnRemove = e.target.closest('.btn-remove-history');

      if (btnRemove) {
        e.stopPropagation();
        const qToRemove = btnRemove.dataset.q;
        removeFromHistory(qToRemove);
        renderHistory(input ? input.value.trim() : '');
        return;
      }

      if (item && input) {
        const q = item.dataset.q;
        input.value = q;
        search(q);
        saveToHistory(q); // Move to top
        historyDropdown.classList.add('hidden');
      }
    });
  }

  // Filters trigger re-search
  document.getElementById('filterBitrate')?.addEventListener('change', triggerSearch);
  document.getElementById('filterCodec')?.addEventListener('change', triggerSearch);

  // Deep Search Button
  document.getElementById('btnDeepSearch').addEventListener('click', deepSearch);

  // Tab Switching Logic
  const tabResults = document.getElementById('tabResults');
  const tabPlaylist = document.getElementById('tabPlaylist');
  const sectionResults = document.getElementById('resultsSection');
  const sectionPlaylist = document.getElementById('playlistSection');

  tabResults.addEventListener('click', () => {
    tabResults.classList.add('active');
    tabPlaylist.classList.remove('active');
    sectionResults.classList.remove('hidden');
    sectionPlaylist.classList.add('hidden');
  });

  tabPlaylist.addEventListener('click', () => {
    tabPlaylist.classList.add('active');
    tabResults.classList.remove('active');
    sectionPlaylist.classList.remove('hidden');
    sectionResults.classList.add('hidden');
  });

  // Winamp Controls
  document.getElementById('btnPlayWinamp')?.addEventListener('click', () => player.play());
  document.getElementById('btnPause')?.addEventListener('click', () => player.pause());
  document.getElementById('btnStop')?.addEventListener('click', () => {
    player.stop();
    const marquee = document.getElementById('radioDisplay');
    if (marquee) marquee.textContent = 'Parado';
  });

  // Event delegation
  document.getElementById('results').addEventListener('click', onResultsClick);
  document.getElementById('playlist').addEventListener('click', onPlaylistClick);
  document.getElementById('btnExportJSON')?.addEventListener('click', (e) => onToolbarClick(e));
  document.getElementById('btnImportJSON')?.addEventListener('click', (e) => onToolbarClick(e));
  document.getElementById('btnCopyPlaylist')?.addEventListener('click', copyPlaylistToClipboard);
  document.getElementById('btnHardRefresh')?.addEventListener('click', hardRefresh);

  // Deep Linking (Play from URL)
  const params = new URLSearchParams(window.location.search);
  const playUrl = params.get('play');
  const playName = params.get('name');
  if (playUrl && playName) {
    setTimeout(() => play(playUrl, playName), 1000);
  }
}

/* ── History Logic ── */
function saveToHistory(query) {
  if (!query) return;
  // Remove if already exists to move to top
  searchHistory = searchHistory.filter(q => q.toLowerCase() !== query.toLowerCase());
  searchHistory.unshift(query);
  searchHistory = searchHistory.slice(0, 10); // Limit to 10
  localStorage.setItem(HISTORY_KEY, JSON.stringify(searchHistory));
}

function removeFromHistory(query) {
  searchHistory = searchHistory.filter(q => q !== query);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(searchHistory));
}

function renderHistory(filter = '') {
  const dropdown = document.getElementById('searchHistory');
  const filtered = filter 
    ? searchHistory.filter(q => q.toLowerCase().includes(filter.toLowerCase()))
    : searchHistory;

  if (filtered.length === 0) {
    dropdown.classList.add('hidden');
    return;
  }

  dropdown.innerHTML = filtered.map(q => `
    <div class="history-item" data-q="${escAttr(q)}">
      <span><i class="fas fa-history mr-2 opacity-50"></i> ${escHtml(q)}</span>
      <button class="btn-remove-history" data-q="${escAttr(q)}" title="Quitar">
        <i class="fas fa-times"></i>
      </button>
    </div>
  `).join('');
  
  dropdown.classList.remove('hidden');
}

function initEqualizer() {
  const audio = document.getElementById('audioPlayer');
  if (audio.crossOrigin !== 'anonymous' && !audio.src.startsWith(location.origin)) {
    return; // CORS no permitido, ecualizador no disponible
  }
  if (audioCtx) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return;
  }
  
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioCtx.createAnalyser();
  try {
    const source = audioCtx.createMediaElementSource(audio);
    source.connect(analyser);
    analyser.connect(audioCtx.destination);
  } catch (e) {
    audioCtx = null;
    return;
  }
  analyser.fftSize = 64;

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  const canvas = document.getElementById('equalizer');
  const ctx = canvas.getContext('2d');

  function draw() {
    requestAnimationFrame(draw);
    analyser.getByteFrequencyData(dataArray);

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const barWidth = (canvas.width / bufferLength) * 2.5;
    let barHeight;
    let x = 0;

    ctx.strokeStyle = '#C9B6D9'; // lavender
    ctx.lineWidth = 2;
    ctx.beginPath();

    for(let i = 0; i < bufferLength; i++) {
      barHeight = dataArray[i] / 2;
      // Sketch style bars: slightly irregular
      const jitter = Math.random() * 2;
      ctx.moveTo(x, canvas.height);
      ctx.lineTo(x + jitter, canvas.height - barHeight);
      x += barWidth + 2;
    }
    ctx.stroke();
  }
  
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
  draw();
}

function triggerSearch() {
  const q = document.getElementById('searchInput').value.trim();
  if (q.length >= 2) search(q);
}

/* ── Pick a working API server ── */
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

/* ── Search (multi-strategy) ── */
async function search(query) {
  // Switch to results tab automatically
  document.getElementById('tabResults').click();

  const container = document.getElementById('results');
  container.innerHTML = '<div class="status-msg">🔎 Buscando...</div>';
  
  // Reset deep search button state
  const btn = document.getElementById('btnDeepSearch');
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-globe"></i>';
  }

  try {
    const server = await pickServer();
    if (!server) {
      container.innerHTML = '<div class="status-msg error">No hay conexión con los servidores de radios. Verifica tu internet o abre con un servidor local (http://).</div>';
      return;
    }
    const base = `https://${server}.api.radio-browser.info/json/stations/search`;

    // Country / region detection
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

    // Build parallel queries for maximum coverage
    const searches = [];

    // 1. Core query
    searches.push({ tag: query });
    searches.push({ name: query });

    // 2. Country detection
    let detectedCountry = false;
    for (const [name, code] of Object.entries(COUNTRIES)) {
      if (q.includes(name)) {
        detectedCountry = true;
        searches.push({ countrycode: code });
        // Add specific language/tag for country
        if (['CL','AR','MX','CO','PE','VE','EC','UY','PY','BO','CU','DO','GT','CR','PA','PR','ES'].includes(code)) {
          searches.push({ language: 'spanish' });
        }
        if (code === 'BR') searches.push({ language: 'portuguese' });
        break;
      }
    }

    // 3. Region/Language hints
    for (const [hint, params] of Object.entries(REGION_HINTS)) {
      if (q.includes(hint)) { searches.push(params); break; }
    }
    for (const [hint, lang] of Object.entries(LANGUAGE_HINTS)) {
      if (q.includes(hint)) { searches.push({ language: lang }); break; }
    }

    // --- Deep Search (Local DB) ---
    const localResults = deepDb.filter(s => {
      const qLow = q.toLowerCase();
      return (s.name || '').toLowerCase().includes(qLow) || (s.tags || '').toLowerCase().includes(qLow);
    });

    // Apply filters and deduplicate
    const filters = getActiveFilters();
    const seenKeys = new Set();
    const unique = searches.filter(s => {
      const key = JSON.stringify(s);
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });

    // Strategy: Fewer base queries, more orderings to get depth
    const orderings = ['clicktrend', 'random', 'votes', 'clickcount'];
    const urls = [];
    unique.forEach(params => {
      const allParams = { ...params, ...filters };
      const qs = Object.entries(allParams).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
      orderings.forEach(order => {
        const reverse = (order !== 'random');
        // Add random seed to prevent caching of identical results
        const seed = Math.random().toString(36).substring(7);
        urls.push(`${base}?${qs}&hidebroken=true&limit=60&order=${order}${reverse ? '&reverse=true' : ''}&seed=${seed}`);
      });
    });

    // Fetch and Shuffle groups for variety
    const apiResults = await Promise.allSettled(
      urls.map(url => fetch(url, { headers: { 'User-Agent': UA } }).then(r => r.json()))
    );

    const seen = new Set();
    const merged = [];
    const groups = [];
    
    // Mix local results in randomly
    if (localResults.length) groups.push(localResults.map(s => ({ ...s, stationuuid: s.uuid })));

    apiResults.forEach(r => {
      if (r.status === 'fulfilled' && Array.isArray(r.value) && r.value.length) {
        groups.push(r.value);
      }
    });

    // SHUFFLE groups so the interleaving starting point is always different
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

    // RELEVANCE LOGIC: Prioritize stations that actually have the query in their name
    const exactMatches = merged.filter(s => (s.name || '').toLowerCase().includes(q.toLowerCase()));
    const relatedMatches = merged.filter(s => !(s.name || '').toLowerCase().includes(q.toLowerCase()));

    const finalMerged = [...exactMatches, ...relatedMatches];

    // DISCOVERY LOGIC: Move items already in playlist to the bottom
    const inPlaylistUuids = new Set(playlist.map(p => p.uuid));
    const discoveryResults = finalMerged.filter(s => !inPlaylistUuids.has(s.stationuuid || s.uuid));
    const alreadyFavorited = finalMerged.filter(s => inPlaylistUuids.has(s.stationuuid || s.uuid));

    renderResults([...discoveryResults, ...alreadyFavorited].slice(0, 150));
  } catch {
    container.innerHTML = '<div class="status-msg error">Error al buscar. Intenta de nuevo.</div>'
      + '<div class="status-msg hint">💡 Tip: prueba "80s", "jazz", "rock", "disco", "electro"</div>';
  }
}

async function deepSearch() {
  // Switch to results tab automatically
  document.getElementById('tabResults').click();

  const input = document.getElementById('searchInput');
  const query = input.value.trim();
  if (query.length < 2) {
    alert('Ingresa al menos 2 caracteres para la búsqueda profunda');
    return;
  }

  const container = document.getElementById('results');
  const btn = document.getElementById('btnDeepSearch');
  
  const originalResults = container.innerHTML;
  container.innerHTML = '<div class="status-msg"><i class="fas fa-spinner fa-spin"></i> Explorando la web profunda...<br><small>Esto puede tardar 10-15 segundos</small></div>';
  
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

  try {
    const res = await fetch(`api/websearch?q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error();
    const data = await res.json();

    if (!data || data.length === 0) {
      container.innerHTML = '<div class="status-msg">No se encontraron flujos de audio directos en la web para esta búsqueda.</div>' + originalResults;
    } else {
      // Mark as deep
      data.forEach(s => s.is_web = true);
      renderResults(data, true); // true means append/prepend
      if (originalResults.includes('station-card')) {
        container.innerHTML += '<hr class="search-divider"><div class="status-msg">Resultados anteriores:</div>' + originalResults;
      }
    }
  } catch (e) {
    container.innerHTML = '<div class="status-msg error">Error en la búsqueda web. Revisa si el servidor soporta Deep Search.</div>' + originalResults;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-globe"></i>';
  }
}

/* ── Render Results ── */
function renderResults(stations, isAppend = false) {
  const container = document.getElementById('results');

  if (!stations || !stations.length) {
    if (!isAppend) container.innerHTML = '<div class="status-msg">Sin resultados. Prueba otro término.</div>';
    return;
  }

  const html = stations.map((s) => {
    const url = s.url_resolved || s.url || '';
    const name = s.name || 'Sin nombre';
    const tags = s.tags || '';
    const favicon = s.favicon || '';
    const uuid = s.stationuuid || s.uuid || '';
    const country = s.country || '';
    const bitrate = s.bitrate || '';
    const inPl = playlist.some((p) => p.uuid === uuid);

    return `
      <div class="station-card ${s.is_web ? 'web-result' : ''}" 
        data-url="${escAttr(url)}" 
        data-uuid="${escAttr(uuid)}" 
        data-name="${escAttr(name)}"
        data-tags="${escAttr(tags)}"
        data-favicon="${escAttr(favicon)}"
        data-country="${escAttr(country)}"
        data-bitrate="${escAttr(bitrate)}"
      >
        <div class="station-info">
          ${favicon
            ? `<img src="${escAttr(favicon)}" class="station-icon" alt="" loading="lazy" onerror="this.style.display='none'">`
            : `<div class="station-icon-placeholder">${s.is_web ? '<i class="fas fa-globe"></i>' : '<i class="fas fa-radio"></i>'}</div>`
          }
          <div>
            <div class="station-name">
              ${s.is_deep ? '<i class="fas fa-anchor text-azul mr-1" title="Deep Search"></i>' : ''}
              ${s.is_web ? '<i class="fas fa-globe text-azul mr-1" title="Web Search"></i>' : ''}
              ${name}
            </div>
            <div class="station-meta">
              ${s.is_web ? '<span class="badge badge-web">Web Result</span>' : ''}
              ${s.is_deep ? '<span class="badge badge-deep">Deep Search</span>' : ''}
              ${tags ? `<span class="tag">${tags.split(',').slice(0, 3).join(', ')}</span>` : ''}
              ${s.bitrate ? `<span class="badge badge-bitrate">${s.bitrate}k</span>` : ''}
              ${s.codec ? `<span class="badge badge-codec">${s.codec}</span>` : ''}
              ${s.country ? `<span class="badge badge-country">${s.country}</span>` : ''}
            </div>
          </div>
        </div>
        <div class="station-actions">
          <button class="btn btn-play" title="Reproducir"><i class="fas fa-play"></i></button>
          ${inPl
            ? '<button class="btn btn-remove" title="Quitar de playlist"><i class="fas fa-heart-crack"></i></button>'
            : '<button class="btn btn-add" title="Agregar a playlist"><i class="fas fa-plus"></i></button>'
          }
          <button class="btn btn-dismiss" title="Descartar de esta búsqueda"><i class="fas fa-eye-slash"></i></button>
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = html;
}

/* ── Play Radio ── */
function play(url, name, uuid) {
  const audio = document.getElementById('audioPlayer');

  // Clear previous metadata interval
  if (metadataInterval) clearInterval(metadataInterval);

  // Remove playing state from all
  document.querySelectorAll('.station-card.playing, .pl-item.playing')
    .forEach((el) => el.classList.remove('playing'));

  // Update Display immediately for feedback
  const display = document.getElementById('radioDisplay');
  if (display) {
    display.textContent = `*** ${name || 'Sintonizando...'} ***`;
  }
  
  const displayTime = document.getElementById('radioDisplayTime');
  if (displayTime) displayTime.textContent = '00:00';

  // Change Source
  audio.crossOrigin = 'anonymous'; // Enable visualizer for CORS-enabled streams
  audio.src = url;
  audio.load();

  // Initialize/Resume Equalizer safely
  try {
    initEqualizer();
  } catch (e) {
    console.error('Equalizer error:', e);
  }

  // Play
  player.play().catch((err) => {
    console.error('Playback error:', err);
    brand.textContent = '⚠️ Error de conexión';
  });

  // Start metadata tracking if we have a valid UUID
  if (uuid && uuid !== 'undefined' && !uuid.startsWith('deep-')) {
    startMetadataTracker(uuid);
  }
}

async function startMetadataTracker(uuid) {
  const display = document.getElementById('radioDisplay');
  const kbpsDisplay = document.getElementById('plCount');
  const server = await pickServer();
  if (!server) return;

  const fetchMeta = async () => {
    if (!uuid || uuid === 'undefined') return;
    try {
      const res = await fetch(`https://${server}.api.radio-browser.info/json/stations/byuuid/${uuid}`, {
        headers: { 'User-Agent': UA }
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data[0]) {
          const s = data[0];
          // Update Winamp KBPS info
          if (kbpsDisplay && s.bitrate) {
            kbpsDisplay.textContent = `${s.bitrate} kbps`;
          }
          
          // Cycle info in marquee
          const infoParts = [
            `*** REPRODUCIENDO: ${s.name} ***`,
            `GÉNERO: ${s.tags || 'Varios'}`,
            `PAÍS: ${s.country || 'Desconocido'}`,
            `CODEC: ${s.codec || 'MP3'} @ ${s.bitrate || '128'}kbps`
          ];
          
          let partIdx = 0;
          if (metadataInterval) clearInterval(metadataInterval);
          
          metadataInterval = setInterval(() => {
            if (display) {
              display.textContent = infoParts[partIdx];
              partIdx = (partIdx + 1) % infoParts.length;
            }
          }, 8000); // Change info every 8 seconds
        }
      }
    } catch {}
  };

  fetchMeta();
}

/* ── Click on Results ── */
function onResultsClick(e) {
  const btn = e.target.closest('button');
  if (!btn) return;

  const card = btn.closest('[data-url]');
  if (!card) return;

  const url = card.dataset.url;
  const name = card.dataset.name;
  const uuid = card.dataset.uuid;

  if (btn.classList.contains('btn-play')) {
    card.classList.add('playing');
    play(url, name, uuid);
  }

  if (btn.classList.contains('btn-add')) {
    const found = playlist.find((p) => p.uuid === card.dataset.uuid);
    if (!found) addToPlaylist({
      uuid: card.dataset.uuid,
      name: card.dataset.name,
      url: card.dataset.url,
      favicon: card.dataset.favicon || '',
      tags: card.dataset.tags || '',
      country: card.dataset.country || '',
      bitrate: card.dataset.bitrate || '',
    });
  }

  if (btn.classList.contains('btn-remove')) {
    removeFromPlaylist(card.dataset.uuid);
  }

  if (btn.classList.contains('btn-dismiss')) {
    card.remove();
  }
}

/* ── Click on Playlist ── */
function onPlaylistClick(e) {
  const btn = e.target.closest('button');
  if (!btn) return;

  const item = btn.closest('[data-url]');
  if (!item) return;

  const url = item.dataset.url;
  const name = item.dataset.name;
  const uuid = item.dataset.uuid;

  if (btn.classList.contains('btn-play-small')) {
    document.querySelectorAll('.pl-item').forEach((el) => el.classList.remove('playing'));
    item.classList.add('playing');
    play(url, name, uuid);
  }

  if (btn.classList.contains('btn-remove')) {
    removeFromPlaylist(item.dataset.uuid);
  }
}

/* ── Playlist CRUD ── */
function addToPlaylist(station) {
  if (!station || !station.uuid) return;
  if (playlist.some((s) => s.uuid === station.uuid)) return;

  playlist.push(station);
  persistPlaylist();
  renderPlaylist();
  updateResultAddButton(station.uuid, true);
}

function removeFromPlaylist(uuid) {
  playlist = playlist.filter((s) => s.uuid !== uuid);
  persistPlaylist();
  renderPlaylist();
  updateResultAddButton(uuid, false);
}

function persistPlaylist() {
  // Guardar solo las que no son patrocinadas para que el "patrocinio" sea fresco cada vez
  const toSave = playlist.filter(s => !s.is_sponsored);
  localStorage.setItem(STORE_KEY, JSON.stringify(toSave));
}

function updateResultAddButton(uuid, added) {
  document.querySelectorAll('.station-card').forEach((card) => {
    if (card.dataset.uuid === uuid) {
      const actions = card.querySelector('.station-actions');
      const old = actions.querySelector('.btn-add, .btn-remove, .added-check');
      if (old) {
        old.outerHTML = added
          ? '<button class="btn btn-remove" title="Quitar de playlist"><i class="fas fa-heart-crack"></i></button>'
          : '<button class="btn btn-add" title="Agregar a playlist"><i class="fas fa-plus"></i></button>';
      }
    }
  });
}

function renderPlaylist() {
  const container = document.getElementById('playlist');
  const count = document.getElementById('plCount');
  if (count) count.textContent = `${playlist.length} radios`;

  if (!playlist.length) {
    container.innerHTML = '<div class="empty-playlist">'
      + '<i class="fas fa-list"></i>'
      + 'Tu playlist está vacía.<br>Busca y agrega radios.'
      + '</div>';
    return;
  }

  container.innerHTML = playlist.map((s) => {
    const uuid = s.uuid || s.stationuuid || '';
    return `
      <div class="pl-item" data-url="${escAttr(s.url)}" data-uuid="${escAttr(uuid)}" data-name="${escAttr(s.name)}">
        <div class="pl-info">
          <span class="pl-name">${escHtml(s.name || 'Sin nombre')}</span>
          ${s.bitrate ? `<span class="badge badge-bitrate">${s.bitrate}k</span>` : ''}
        </div>
        <div class="pl-actions">
          <button class="btn btn-play-small" title="Reproducir"><i class="fas fa-play"></i></button>
          <button class="btn btn-remove" title="Eliminar"><i class="fas fa-times"></i></button>
        </div>
      </div>
    `;
  }).join('');
}

/* ── Playlist Toolbar ── */
function onToolbarClick(e) {
  const btn = e.target.closest('button');
  if (!btn) return;

  if (btn) {
    if (btn.id === 'btnExportM3U') exportM3U();
    if (btn.id === 'btnExportJSON') exportJSON();
    if (btn.id === 'btnImportJSON') importJSON();
    if (btn.id === 'btnHardRefresh') hardRefresh();
  }
}

async function checkUpdate() {
  try {
    const res = await fetch(`version_check.json?t=${Date.now()}`);
    if (res.ok) {
      const data = await res.json();
      if (data.version && data.version !== APP_VERSION) {
        console.log(`New version available: ${data.version}`);
        const reload = confirm(`Nueva versión disponible (${data.version}). ¿Deseas actualizar ahora para ver los cambios?`);
        if (reload) {
          hardRefresh();
        }
      }
    }
  } catch (e) {
    console.warn('Update check failed');
  }
}

async function hardRefresh() {
  const btn = document.getElementById('btnHardRefresh');
  const icon = btn.querySelector('i');
  
  icon.classList.add('fa-spin-fast');
  btn.disabled = true;

  try {
    // 1. Unregister Service Workers
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (let registration of registrations) {
        await registration.unregister();
      }
    }

    // 2. Clear Cache API
    if ('caches' in window) {
      const keys = await caches.keys();
      for (let key of keys) {
        await caches.delete(key);
      }
    }

    // 3. Reload Page (Hard)
    window.location.reload(true);
  } catch (e) {
    console.error('Refresh error:', e);
    window.location.reload();
  }
}

function exportM3U() {
  if (!playlist.length) return;
  const lines = ['#EXTM3U'];
  playlist.forEach(s => {
    lines.push(`#EXTINF:-1,${s.name}`);
    lines.push(s.url);
  });
  download(lines.join('\n'), 'radios.m3u', 'audio/x-mpegurl');
}

function exportJSON() {
  if (!playlist.length) return;
  download(JSON.stringify(playlist, null, 2), 'radios.json', 'application/json');
}

function copyPlaylistToClipboard() {
  if (!playlist.length) {
    const btn = document.getElementById('btnCopyPlaylist');
    btn.innerHTML = '<i class="fas fa-clipboard"></i>';
    return;
  }

  const lines = playlist.map((s, i) => `${i + 1}. ${s.name}${s.bitrate ? ` (${s.bitrate}k)` : ''}\n   ${s.url}`);
  const text = `🎵 Mi Playlist de Radios (${playlist.length} emisoras)\n\n${lines.join('\n')}`;

  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('btnCopyPlaylist');
    const orig = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-check" style="color: var(--sage)"></i>';
    setTimeout(() => btn.innerHTML = orig, 2000);
  }).catch(() => {
    const btn = document.getElementById('btnCopyPlaylist');
    const orig = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-times" style="color: #E07070"></i>';
    setTimeout(() => btn.innerHTML = orig, 2000);
  });
}

function importJSON() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.style.display = 'none';
  document.body.appendChild(input);

  const cleanup = () => {
    if (input.parentNode) input.parentNode.removeChild(input);
  };

  input.addEventListener('cancel', cleanup);

  input.onchange = async () => {
    cleanup();
    const file = input.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data)) throw new Error();

      const existing = new Set(playlist.map(s => s.uuid));
      let added = 0;

      data.forEach(s => {
        if (s.uuid && !existing.has(s.uuid)) {
          playlist.push({
            uuid: s.uuid,
            name: s.name || 'Sin nombre',
            url: s.url || '',
            favicon: s.favicon || '',
            tags: s.tags || '',
            country: s.country || '',
            bitrate: s.bitrate || '',
          });
          existing.add(s.uuid);
          added++;
        }
      });

      if (added > 0) {
        persistPlaylist();
        renderPlaylist();
      }
    } catch {
      alert('El archivo no es válido');
    }
  };
  input.click();
}

function download(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ── Filters ── */
function getActiveFilters() {
  const filters = {};
  const elBitrate = document.getElementById('filterBitrate');
  const elCodec = document.getElementById('filterCodec');
  
  if (elBitrate) {
    const bitrate = parseInt(elBitrate.value);
    if (bitrate > 0) filters.bitrateMin = bitrate;
  }
  
  if (elCodec) {
    const codec = elCodec.value;
    if (codec) filters.codec = codec;
  }
  
  return filters;
}

/* ── Helpers ── */
function escAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ── Boot ── */
document.addEventListener('DOMContentLoaded', init);
