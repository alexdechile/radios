/* ===========================================
   RADIOS APP — Sketch Player
   Radio Browser API + Plyr + Playlist
   =========================================== */

const API_SERVERS = ['de1', 'de2', 'nl1', 'at1'];
const UA = 'RadiosSketchApp/1.0';
const STORE_KEY = 'radios_playlist';
const HISTORY_KEY = 'radios_search_history';
const APP_VERSION = '1.3.1';

// Resolve API path relative to base path (handles /radios subpath on production)
function getApiUrl(path) {
  const prefix = window.location.pathname.startsWith('/radios') ? '/radios' : '';
  const cleanPath = path.startsWith('/') ? path : '/' + path;
  return prefix + cleanPath;
}

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
let nowPlayingInterval = null;
let audioCtx = null;
let analyser = null;
let eqFilters = [];   // 5 BiquadFilter nodes
let eqActive = false; // panel open state

// Audio Effects state
let effectsActive = false; // panel open state
let stereoWidthNode = null;  // { splitter, gains, merger }
let surroundNode = null;     // { splitter, delay, merger }
let bassBoostFilter = null;  // BiquadFilterNode
let effectsInjected = false; // whether effects are in the chain

// Station Presets state
const SP_KEY = 'radios_station_presets';
let stationPresets = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(SP_KEY) || 'null');
    if (Array.isArray(raw) && raw.length === 6) return raw;
  } catch(e) {}
  return Array(6).fill(null);
})();
let currentPlayingPreset = -1; // index of preset currently playing (-1 = none)
let currentPlayingStation = null; // { url, name, uuid }

// EQ band config: [frequency Hz, type]
const EQ_BANDS = [
  { freq: 60,    type: 'lowshelf'  },
  { freq: 250,   type: 'peaking'   },
  { freq: 1000,  type: 'peaking'   },
  { freq: 4000,  type: 'peaking'   },
  { freq: 16000, type: 'highshelf' },
];

// Presets [60Hz, 250Hz, 1kHz, 4kHz, 16kHz]
const EQ_PRESETS = {
  flat:   [0,   0,   0,   0,   0 ],
  bass:   [8,   4,   0,  -2,  -2 ],
  vocal:  [-2,  0,   5,   4,   0 ],
  treble: [-2, -2,   0,   4,   8 ],
};

// Timer & Alarm state
let sleepTimeTarget = null; // timestamp when sleep timer triggers
let alarmTime = localStorage.getItem('radios_alarm_time') || '';
let alarmEnabled = localStorage.getItem('radios_alarm_enabled') === 'true';
let alarmStation = localStorage.getItem('radios_alarm_station') || 'current';
let lastAlarmTriggeredDate = '';
let alarmCheckerInterval = null;

// Playlist navigation state
let plFilterText = '';
let plCurrentIndex = -1;
let plShuffled = false;
let plShuffleOrder = [];
let plDragSrcIndex = -1;

// Auto-skip state
let autoSkipCount = 0;
let autoSkipTimer = null;

/* ── Init ── */
async function init() {
  await checkUpdate();

  // Service Worker for PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  playlist = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
  searchHistory = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');

  // Sync curated radios from server SQLite
  syncCuratedFromServer();

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
  const searchClear = document.getElementById('searchClear');
  let debounce;

  function updateSearchClear() {
    if (searchClear) {
      searchClear.classList.toggle('visible', input.value.length > 0);
    }
  }

  if (searchClear) {
    searchClear.addEventListener('click', () => {
      input.value = '';
      input.focus();
      searchClear.classList.remove('visible');
      document.getElementById('results').innerHTML = '';
      if (historyDropdown) historyDropdown.classList.add('hidden');
    });
  }

  if (input) {
    input.addEventListener('input', () => {
      updateSearchClear();
      clearTimeout(debounce);
      const q = input.value.trim();
      renderHistory(q);
      if (q.length < 2) {
        document.getElementById('results').innerHTML = '';
        return;
      }
      debounce = setTimeout(() => {
        search(q);
        saveToHistory(q);
      }, 400);
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
    initCarousel();
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
    if (nowPlayingInterval) { clearInterval(nowPlayingInterval); nowPlayingInterval = null; }
    const trackEl = document.getElementById('nowPlayingTrack');
    if (trackEl) trackEl.classList.add('hidden');
  });
  document.getElementById('btnPrev')?.addEventListener('click', playPrev);
  document.getElementById('btnNext')?.addEventListener('click', playNext);

  // Auto-advance on stream end
  player.on('ended', playNext);

  // Event delegation
  document.getElementById('results').addEventListener('click', onResultsClick);
  document.getElementById('playlist').addEventListener('click', onPlaylistClick);
  document.getElementById('btnExportM3U')?.addEventListener('click', (e) => onToolbarClick(e));
  document.getElementById('btnExportJSON')?.addEventListener('click', (e) => onToolbarClick(e));
  document.getElementById('btnImportJSON')?.addEventListener('click', (e) => onToolbarClick(e));
  document.getElementById('btnImportM3U')?.addEventListener('click', (e) => onToolbarClick(e));
  document.getElementById('btnCopyPlaylist')?.addEventListener('click', copyPlaylistToClipboard);
  document.getElementById('btnHardRefresh')?.addEventListener('click', hardRefresh);
  document.getElementById('btnMobileVersion')?.addEventListener('click', () => {
    localStorage.removeItem('force_classic_version');
    window.location.href = 'mini.html';
  });

  // Playlist toolbar
  document.getElementById('plSearch')?.addEventListener('input', onPlSearch);
  document.getElementById('btnPlayAll')?.addEventListener('click', playlistPlayAll);
  document.getElementById('btnShuffle')?.addEventListener('click', playlistShuffle);

  // Drag events bound per-item in renderPlaylist()

  // Deep Linking (Play from URL)
  const params = new URLSearchParams(window.location.search);
  const playUrl = params.get('play');
  const playName = params.get('name');
  if (playUrl && playName) {
    setTimeout(() => play(playUrl, playName), 1000);
  }

  // Init Timer & Alarm
  initTimerAndAlarm();

  // Init EQ Panel UI
  initEqPanel();

  // Init Effects Panel UI
  initEffectsPanel();

  // Init Station Presets
  initStationPresets();
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

/* ── Station Presets ── */
function initStationPresets() {
  renderStationPresets();

  const grid = document.querySelector('.sp-grid');
  if (!grid) return;

  // Long-press state per button
  const timers = {};

  grid.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.sp-btn');
    if (!btn) return;
    const idx = parseInt(btn.dataset.idx, 10);

    timers[idx] = setTimeout(() => {
      // Long press → save current station
      if (!currentPlayingStation) {
        showSpHint('▶ Primero reproduce una radio');
        return;
      }
      stationPresets[idx] = { ...currentPlayingStation };
      localStorage.setItem(SP_KEY, JSON.stringify(stationPresets));
      renderStationPresets();
      syncPresetActiveState(currentPlayingStation.url);
      showSpHint(`✔ Guardado en ${idx + 1}`);
    }, 500);
  });

  const cancelTimer = (e) => {
    const btn = e.target.closest('.sp-btn');
    if (!btn) return;
    const idx = parseInt(btn.dataset.idx, 10);
    clearTimeout(timers[idx]);
  };

  grid.addEventListener('pointerup', cancelTimer);
  grid.addEventListener('pointerleave', cancelTimer);

  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('.sp-btn');
    if (!btn) return;
    const idx = parseInt(btn.dataset.idx, 10);
    const preset = stationPresets[idx];

    if (preset) {
      // Play this preset
      currentPlayingPreset = idx;
      play(preset.url, preset.name, preset.uuid);
    } else {
      // Empty → save current if playing
      if (!currentPlayingStation) {
        showSpHint('▶ Primero reproduce una radio');
        return;
      }
      stationPresets[idx] = { ...currentPlayingStation };
      localStorage.setItem(SP_KEY, JSON.stringify(stationPresets));
      renderStationPresets();
      syncPresetActiveState(currentPlayingStation.url);
      showSpHint(`✔ Guardado en ${idx + 1}`);
    }
  });

  // Context menu (right-click / long-tap) to clear a preset
  grid.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const btn = e.target.closest('.sp-btn');
    if (!btn) return;
    const idx = parseInt(btn.dataset.idx, 10);
    if (stationPresets[idx]) {
      stationPresets[idx] = null;
      if (currentPlayingPreset === idx) currentPlayingPreset = -1;
      localStorage.setItem(SP_KEY, JSON.stringify(stationPresets));
      renderStationPresets();
      showSpHint(`Preset ${idx + 1} borrado`);
    }
  });
}

function renderStationPresets() {
  for (let i = 0; i < 6; i++) {
    const btn  = document.getElementById(`sp${i}`);
    if (!btn) continue;
    const p    = stationPresets[i];
    const nameEl = btn.querySelector('.sp-name');
    btn.classList.toggle('sp-filled', !!p);
    btn.classList.toggle('sp-active', i === currentPlayingPreset);
    if (nameEl) nameEl.textContent = p ? shortName(p.name) : '—';
    btn.title = p ? `${p.name}\nClick: reproducir\nDer. click: borrar` : 'Click o mant. puls. para guardar radio actual';
  }
}

function syncPresetActiveState(url) {
  currentPlayingPreset = -1;
  for (let i = 0; i < 6; i++) {
    if (stationPresets[i] && stationPresets[i].url === url) {
      currentPlayingPreset = i;
      break;
    }
  }
  renderStationPresets();
}

function shortName(name) {
  // Abbreviate to fit the tiny button
  return name.length > 7 ? name.slice(0, 6) + '…' : name;
}

let spHintTimer = null;
function showSpHint(msg) {
  const el = document.getElementById('spHint');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('visible');
  clearTimeout(spHintTimer);
  spHintTimer = setTimeout(() => {
    el.classList.remove('visible');
  }, 2000);
}

function initEqualizer() {
  const audio = document.getElementById('audioPlayer');
  if (audioCtx) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioCtx.createAnalyser();

  // Build EQ filter chain
  eqFilters = EQ_BANDS.map((band, i) => {
    const filter = audioCtx.createBiquadFilter();
    filter.type = band.type;
    filter.frequency.value = band.freq;
    filter.Q.value = 1.4;
    // Restore saved gain
    const saved = parseFloat(localStorage.getItem(`eq_band_${i}`) || '0');
    filter.gain.value = saved;
    return filter;
  });

  // Chain: source → filter[0] → filter[1] → ... → effects → analyser → destination
  try {
    const source = audioCtx.createMediaElementSource(audio);
    let node = source;
    for (const filter of eqFilters) {
      node.connect(filter);
      node = filter;
    }
    // Inject effects nodes between EQ and analyser
    node = createEffectsChain(node);
    node.connect(analyser);
    analyser.connect(audioCtx.destination);
  } catch (e) {
    audioCtx = null;
    eqFilters = [];
    effectsInjected = false;
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

  // Sync slider UI to restored values
  EQ_BANDS.forEach((_, i) => {
    const slider = document.getElementById(`eqBand${i}`);
    const valEl  = document.getElementById(`eqVal${i}`);
    if (!slider || !eqFilters[i]) return;
    const saved = parseFloat(localStorage.getItem(`eq_band_${i}`) || '0');
    slider.value = saved;
    valEl.textContent = saved > 0 ? `+${saved}` : `${saved}`;
  });
}

/* ── EQ Panel UI ── */
function initEqPanel() {
  const btnToggle = document.getElementById('btnEqToggle');
  const panel     = document.getElementById('eqPanel');
  if (!btnToggle || !panel) return;

  // Toggle panel open/close
  btnToggle.addEventListener('click', () => {
    eqActive = !eqActive;
    panel.classList.toggle('hidden', !eqActive);
    btnToggle.classList.toggle('eq-active', eqActive);
  });

  // Slider → BiquadFilter gain
  EQ_BANDS.forEach((_, i) => {
    const slider = document.getElementById(`eqBand${i}`);
    const valEl  = document.getElementById(`eqVal${i}`);
    if (!slider) return;

    slider.addEventListener('input', () => {
      const val = parseFloat(slider.value);
      valEl.textContent = val > 0 ? `+${val}` : `${val}`;
      localStorage.setItem(`eq_band_${i}`, val);
      if (eqFilters[i]) eqFilters[i].gain.value = val;
      // Clear active preset highlight
      document.querySelectorAll('.btn-eq-preset').forEach(b => b.classList.remove('active'));
    });
  });

  // Preset buttons
  document.querySelectorAll('.btn-eq-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = EQ_PRESETS[btn.dataset.preset];
      if (!preset) return;

      preset.forEach((gain, i) => {
        const slider = document.getElementById(`eqBand${i}`);
        const valEl  = document.getElementById(`eqVal${i}`);
        if (!slider) return;
        slider.value = gain;
        valEl.textContent = gain > 0 ? `+${gain}` : `${gain}`;
        localStorage.setItem(`eq_band_${i}`, gain);
        if (eqFilters[i]) eqFilters[i].gain.value = gain;
      });

      document.querySelectorAll('.btn-eq-preset').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
}

/* ── Audio Effects Chain ── */
function createEffectsChain(inputNode) {
  if (!audioCtx) return inputNode;

  // Stereo Width: Mid/Side processing
  const swSplitter = audioCtx.createChannelSplitter(2);
  const swGainL = audioCtx.createGain();
  const swGainR = audioCtx.createGain();
  const swGainCrossL = audioCtx.createGain();
  const swGainCrossR = audioCtx.createGain();
  const swMerger = audioCtx.createChannelMerger(2);

  const savedWidth = parseFloat(localStorage.getItem('fx_stereo_width') || '100');
  const widthNorm = savedWidth / 100;
  const alpha = (1 + widthNorm) / 2;
  const beta  = (1 - widthNorm) / 2;
  swGainL.gain.value = alpha;
  swGainR.gain.value = alpha;
  swGainCrossL.gain.value = beta;
  swGainCrossR.gain.value = beta;

  // L' = L*alpha + R*beta
  swSplitter.connect(swGainL, 0, 0);
  swSplitter.connect(swGainCrossR, 1, 0);
  swGainL.connect(swMerger, 0, 0);
  swGainCrossR.connect(swMerger, 0, 0);
  // R' = L*beta + R*alpha
  swSplitter.connect(swGainCrossL, 0, 0);
  swSplitter.connect(swGainR, 1, 0);
  swGainCrossL.connect(swMerger, 0, 1);
  swGainR.connect(swMerger, 0, 1);

  stereoWidthNode = { splitter: swSplitter, gains: [swGainL, swGainR, swGainCrossL, swGainCrossR], merger: swMerger };

  // Surround: Haas effect (delay on left channel)
  const surrSplitter = audioCtx.createChannelSplitter(2);
  const surrDelay = audioCtx.createDelay(0.1);
  surrDelay.delayTime.value = 0.001; // min delay when off
  const surrMerger = audioCtx.createChannelMerger(2);

  surrSplitter.connect(surrDelay, 0, 0);
  surrDelay.connect(surrMerger, 0, 0);
  surrSplitter.connect(surrMerger, 1, 1);

  surroundNode = { splitter: surrSplitter, delay: surrDelay, merger: surrMerger };

  // Bass Boost
  bassBoostFilter = audioCtx.createBiquadFilter();
  bassBoostFilter.type = 'lowshelf';
  bassBoostFilter.frequency.value = 80;
  bassBoostFilter.Q.value = 0.8;
  const savedBass = localStorage.getItem('fx_bass_boost') === 'true';
  bassBoostFilter.gain.value = savedBass ? 6 : 0;

  // Connect chain: input → swSplitter → swMerger → surrSplitter → surrMerger → bassBoost → output
  inputNode.connect(swSplitter);
  swMerger.connect(surrSplitter);
  surrMerger.connect(bassBoostFilter);

  effectsInjected = true;

  // Restore surround state
  const savedSurround = localStorage.getItem('fx_surround') === 'true';
  surrDelay.delayTime.value = savedSurround ? 0.025 : 0.001;

  return bassBoostFilter;
}

function updateStereoWidth(percent) {
  if (!stereoWidthNode) return;
  const widthNorm = percent / 100;
  const alpha = (1 + widthNorm) / 2;
  const beta  = (1 - widthNorm) / 2;
  stereoWidthNode.gains[0].gain.value = alpha; // L_self
  stereoWidthNode.gains[1].gain.value = alpha; // R_self
  stereoWidthNode.gains[2].gain.value = beta;  // L_cross
  stereoWidthNode.gains[3].gain.value = beta;  // R_cross
  localStorage.setItem('fx_stereo_width', percent);
}

function updateSurround(enabled) {
  if (!surroundNode) return;
  surroundNode.delay.delayTime.value = enabled ? 0.025 : 0.001;
  localStorage.setItem('fx_surround', enabled);
}

function updateBassBoost(enabled) {
  if (!bassBoostFilter) return;
  bassBoostFilter.gain.value = enabled ? 6 : 0;
  localStorage.setItem('fx_bass_boost', enabled);
}

/* ── Effects Panel UI ── */
function initEffectsPanel() {
  const btnToggle = document.getElementById('btnEffectsToggle');
  const panel     = document.getElementById('effectsPanel');
  if (!btnToggle || !panel) return;

  btnToggle.addEventListener('click', () => {
    effectsActive = !effectsActive;
    panel.classList.toggle('hidden', !effectsActive);
    btnToggle.classList.toggle('effects-active', effectsActive);
    // Close EQ panel if open
    if (effectsActive && eqActive) {
      document.getElementById('btnEqToggle').click();
    }
  });

  // Stereo Width slider
  const swSlider = document.getElementById('stereoWidthSlider');
  const swVal    = document.getElementById('stereoWidthVal');
  if (swSlider) {
    swSlider.addEventListener('input', () => {
      const val = parseInt(swSlider.value);
      swVal.textContent = val + '%';
      updateStereoWidth(val);
    });
  }

  // Surround toggle
  const surrToggle = document.getElementById('surroundToggle');
  const surrStatus = document.getElementById('surroundStatus');
  if (surrToggle) {
    surrToggle.addEventListener('change', () => {
      const on = surrToggle.checked;
      surrStatus.textContent = on ? 'ON' : 'OFF';
      updateSurround(on);
    });
  }

  // Bass Boost toggle
  const bassToggle = document.getElementById('bassBoostToggle');
  const bassStatus = document.getElementById('bassBoostStatus');
  if (bassToggle) {
    bassToggle.addEventListener('change', () => {
      const on = bassToggle.checked;
      bassStatus.textContent = on ? 'ON' : 'OFF';
      updateBassBoost(on);
    });
  }

  // Reset all effects to Normal
  document.getElementById('btnEffectsReset')?.addEventListener('click', () => {
    // Reset Stereo Width to 100%
    const swSlider = document.getElementById('stereoWidthSlider');
    const swVal = document.getElementById('stereoWidthVal');
    if (swSlider) { swSlider.value = '100'; }
    if (swVal) { swVal.textContent = '100%'; }
    updateStereoWidth(100);

    // Reset Surround to off
    const surrToggle = document.getElementById('surroundToggle');
    const surrStatus = document.getElementById('surroundStatus');
    if (surrToggle) { surrToggle.checked = false; }
    if (surrStatus) { surrStatus.textContent = 'OFF'; }
    updateSurround(false);

    // Reset Bass Boost to off
    const bassToggle = document.getElementById('bassBoostToggle');
    const bassStatus = document.getElementById('bassBoostStatus');
    if (bassToggle) { bassToggle.checked = false; }
    if (bassStatus) { bassStatus.textContent = 'OFF'; }
    updateBassBoost(false);
  });
}

function initCarousel() {
  const container = document.getElementById('resultsSection');
  const cards = document.querySelectorAll('.station-card');

  document.getElementById('carouselPrev').onclick = () => {
    container.scrollBy({ left: -296, behavior: 'smooth' });
  };
  document.getElementById('carouselNext').onclick = () => {
    container.scrollBy({ left: 296, behavior: 'smooth' });
  };

  const arrows = document.querySelectorAll('.carousel-arrow');
  arrows.forEach(a => a.style.display = cards.length > 2 ? '' : 'none');
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
      // Fallback: use only local database if API is unavailable
      const qLow = query.toLowerCase();
      const fallbackResults = deepDb.filter(s => {
        return (s.name || '').toLowerCase().includes(qLow) || (s.tags || '').toLowerCase().includes(qLow);
      });
      if (fallbackResults.length) {
        renderResults(fallbackResults);
        setTimeout(initCarousel, 50);
        container.innerHTML += '<div class="status-msg hint">Solo resultados locales (sin conexión a API)</div>';
      } else {
        container.innerHTML = '<div class="status-msg error">No hay conexión con los servidores de radios y no hay resultados locales.</div>';
      }
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
    // Also search each word separately in tags for partial matches
    const words = query.split(/\s+/);
    if (words.length > 1) {
      words.forEach(word => {
        if (word.length >= 3) {
          searches.push({ tag: word });
        }
      });
    }

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
    let merged = [];
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

    // Additional filter: include stations where tags contain query (even if not exact tag match)
    // This captures partial matches like "smooth jazz" when searching just "jazz"
    const qLow = q.toLowerCase();
    merged = merged.filter(s => {
      const tags = (s.tags || '').toLowerCase();
      const name = (s.name || '').toLowerCase();
      // Include if name matches, or tags match exactly, or tags contain the query as partial match
      return name.includes(qLow) || tags.includes(qLow) || tags.split(',').map(t => t.trim()).some(t => t === qLow);
    });

    // RELEVANCE LOGIC: Prioritize by tags first, then name, then others
    const tagMatches = merged.filter(s => (s.tags || '').toLowerCase().includes(qLow));
    const nameMatches = merged.filter(s => (s.name || '').toLowerCase().includes(qLow) && !tagMatches.some(t => t.stationuuid === s.stationuuid));
    const otherMatches = merged.filter(s => !(s.tags || '').toLowerCase().includes(qLow) && !(s.name || '').toLowerCase().includes(qLow));

    // Prioritize HTTPS over HTTP to avoid proxy (better performance, less load)
    const sortByHttps = (a, b) => {
      const aHttps = (a.url || '').startsWith('https://') ? 0 : 1;
      const bHttps = (b.url || '').startsWith('https://') ? 0 : 1;
      return aHttps - bHttps;
    };

    const finalMerged = [...tagMatches.sort(sortByHttps), ...nameMatches.sort(sortByHttps), ...otherMatches.sort(sortByHttps)];

    // DISCOVERY LOGIC: Move items already in playlist to the bottom
    const inPlaylistUuids = new Set(playlist.map(p => p.uuid));
    const discoveryResults = finalMerged.filter(s => !inPlaylistUuids.has(s.stationuuid || s.uuid));
    const alreadyFavorited = finalMerged.filter(s => inPlaylistUuids.has(s.stationuuid || s.uuid));

    renderResults([...discoveryResults, ...alreadyFavorited].slice(0, 150));
    setTimeout(initCarousel, 50);
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
    const res = await fetch(getApiUrl(`api/websearch?q=${encodeURIComponent(query)}`));
    if (!res.ok) throw new Error();
    const data = await res.json();

    if (!data || data.length === 0) {
      container.innerHTML = '<div class="status-msg">No se encontraron flujos de audio directos en la web para esta búsqueda.</div>' + originalResults;
    } else {
      // Mark as deep
      data.forEach(s => s.is_web = true);
      renderResults(data, true); // true means append/prepend
      setTimeout(initCarousel, 50);
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
    const codec = s.codec || '';
    const inPl = playlist.some((p) => p.uuid === uuid);

    const tagList = tags ? tags.split(',').map(t => t.trim()).filter(Boolean).slice(0, 3) : [];
    const badgeHtml = [
      bitrate ? `<span class="badge badge-bitrate">${bitrate}k</span>` : '',
      codec ? `<span class="badge badge-codec">${codec}</span>` : '',
      country ? `<span class="badge badge-country">${country}</span>` : '',
    ].filter(Boolean).join('');

    return `
      <div class="station-card ${s.is_web ? 'web-result' : ''}" 
        data-url="${escAttr(url)}" 
        data-uuid="${escAttr(uuid)}" 
        data-name="${escAttr(name)}"
        data-tags="${escAttr(tags)}"
        data-favicon="${escAttr(favicon)}"
        data-country="${escAttr(country)}"
        data-bitrate="${escAttr(bitrate)}"
        data-codec="${escAttr(codec)}"
      >
        <div class="station-card-art">
          ${favicon
            ? `<img src="${escAttr(favicon)}" alt="" loading="lazy" onerror="">`
            : `<div class="placeholder-icon">${s.is_web ? '<i class="fas fa-globe"></i>' : '<i class="fas fa-radio"></i>'}</div>`
          }
        </div>
        <div class="station-card-body">
          <div class="station-name">${name}</div>
          ${tagList.length ? `<div class="station-tags">${tagList.join(', ')}</div>` : ''}
          <div class="station-card-badges">${badgeHtml}</div>
        </div>
        <div class="station-card-footer">
          <button class="btn-play-card" title="Reproducir"><i class="fas fa-play"></i></button>
          ${inPl
            ? `<button class="btn-add-card is-fav" title="Quitar de playlist"><i class="fas fa-heart"></i></button>`
            : `<button class="btn-add-card" title="Agregar a playlist"><i class="fas fa-plus"></i></button>`
          }
          <button class="btn-dismiss-card" title="Descartar"><i class="fas fa-eye-slash"></i></button>
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = html;
}

/* ── Play Radio ── */
function play(url, name, uuid) {
  const audio = document.getElementById('audioPlayer');
  console.log('[PLAY] name=%s uuid=%s url=%s', name, uuid, url);

  // Reset auto-skip on manual play
  autoSkipCount = 0;
  if (autoSkipTimer) { clearTimeout(autoSkipTimer); autoSkipTimer = null; }

  // Track currently playing station for preset assignment
  currentPlayingStation = { url, name, uuid };
  // Sync preset active state
  syncPresetActiveState(url);

  // Clear previous metadata interval
  if (metadataInterval) clearInterval(metadataInterval);

  // Remove playing state from all, then highlight matching card
  document.querySelectorAll('.station-card.playing, .pl-item.playing')
    .forEach((el) => el.classList.remove('playing'));
  document.querySelectorAll(`.station-card[data-url="${escAttr(url)}"], .pl-item[data-url="${escAttr(url)}"]`)
    .forEach((el) => el.classList.add('playing'));

  // Update Display immediately for feedback
  const display = document.getElementById('radioDisplay');
  if (display) {
    display.textContent = `*** ${name || 'Sintonizando...'} ***`;
  }
  
  const displayTime = document.getElementById('radioDisplayTime');
  if (displayTime) displayTime.textContent = '00:00';

  // Only proxy HTTP streams (mixed content blocked by browser).
  // HTTPS streams play directly; crossOrigin omitted to avoid CORS issues.
  const isHttp = url.startsWith('http://');
  const finalUrl = isHttp ? `proxy?url=${encodeURIComponent(url)}` : url;
  console.log('[PLAY] finalUrl=%s proxied=%s', finalUrl, isHttp ? 'yes' : 'no');

  audio.crossOrigin = isHttp ? 'anonymous' : '';
  audio.src = finalUrl;
  audio.load();

  audio.addEventListener('error', function onPlayError() {
    console.error('[PLAY] audio error code=%d message=%s', this.error ? this.error.code : '?', this.error ? this.error.message : 'unknown');
    audio.removeEventListener('error', onPlayError);
    handlePlaybackError();
  }, { once: true });

  audio.addEventListener('canplay', () => {
    console.log('[PLAY] canplay event fired for %s', name);
  }, { once: true });

  // Initialize/Resume Equalizer safely
  try {
    initEqualizer();
  } catch (e) {
    console.error('Equalizer error:', e);
  }

  // Play
  player.play().then(() => {
    console.log('[PLAY] playback started for %s', name);
  }).catch((err) => {
    console.error('[PLAY] playback error:', err);
    display.textContent = '⚠️ Error de conexión';
    handlePlaybackError();
  });

  // Start metadata tracking if we have a valid UUID
  if (uuid && uuid !== 'undefined' && !uuid.startsWith('deep-')) {
    startMetadataTracker(uuid, url);
  }
}

async function startMetadataTracker(uuid, stationUrl) {
  const display = document.getElementById('radioDisplay');
  const kbpsDisplay = document.getElementById('plCount');
  const trackEl = document.getElementById('nowPlayingTrack');
  const trackText = document.getElementById('nowPlayingTrackText');
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
          if (kbpsDisplay && s.bitrate) {
            kbpsDisplay.textContent = `${s.bitrate} kbps`;
          }
          
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
          }, 8000);
        }
      }
    } catch {}
  };

  // Fetch now-playing track info from our server endpoint
  const fetchNowPlaying = async () => {
    if (!stationUrl) return;
    try {
      const res = await fetch(getApiUrl(`/api/nowplaying?url=${encodeURIComponent(stationUrl)}`));
      if (res.ok) {
        const data = await res.json();
        if (data && data.title && trackEl && trackText) {
          trackText.textContent = data.title;
          trackEl.classList.remove('hidden');
        } else if (trackEl) {
          trackEl.classList.add('hidden');
        }
      }
    } catch {}
  };

  fetchMeta();
  fetchNowPlaying();

  // Poll now-playing (clear previous first)
  if (nowPlayingInterval) clearInterval(nowPlayingInterval);
  nowPlayingInterval = setInterval(fetchNowPlaying, 15000);
}

/* ── Click on Results ── */
function onResultsClick(e) {
  const card = e.target.closest('[data-url]');
  if (!card) return;

  const btn = e.target.closest('button');
  const url = card.dataset.url;
  const name = card.dataset.name;
  const uuid = card.dataset.uuid;

  if (btn) {
    if (btn.classList.contains('btn-add-card') && !btn.classList.contains('is-fav')) {
      addToPlaylist({
        uuid: card.dataset.uuid,
        name: card.dataset.name,
        url: card.dataset.url,
        favicon: card.dataset.favicon || '',
        tags: card.dataset.tags || '',
        country: card.dataset.country || '',
        bitrate: card.dataset.bitrate || '',
        codec: card.dataset.codec || '',
      });
      return;
    }
    if (btn.classList.contains('btn-add-card') && btn.classList.contains('is-fav')) {
      removeFromPlaylist(card.dataset.uuid);
      return;
    }
    if (btn.classList.contains('btn-dismiss-card')) {
      card.remove();
      return;
    }
  }

  document.querySelectorAll('.station-card.playing').forEach(el => el.classList.remove('playing'));
  card.classList.add('playing');
  play(url, name, uuid);
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
  if (!station.is_sponsored) syncCuratedToServer(station);
}

function removeFromPlaylist(uuid) {
  const removed = playlist.find((s) => s.uuid === uuid);
  playlist = playlist.filter((s) => s.uuid !== uuid);
  persistPlaylist();
  renderPlaylist();
  updateResultAddButton(uuid, false);
  if (removed && !removed.is_sponsored) removeCuratedFromServer(uuid);
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
          persistPlaylist();
          renderPlaylist();
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

function persistPlaylist() {
  // Guardar solo las que no son patrocinadas para que el "patrocinio" sea fresco cada vez
  const toSave = playlist.filter(s => !s.is_sponsored);
  localStorage.setItem(STORE_KEY, JSON.stringify(toSave));
}

function updateResultAddButton(uuid, added) {
  document.querySelectorAll('.station-card').forEach((card) => {
    if (card.dataset.uuid === uuid) {
      const footer = card.querySelector('.station-card-footer');
      if (footer) {
        const old = footer.querySelector('.btn-add-card');
        if (old) {
          old.outerHTML = added
            ? '<button class="btn-add-card is-fav" title="Quitar de playlist"><i class="fas fa-heart"></i></button>'
            : '<button class="btn-add-card" title="Agregar a playlist"><i class="fas fa-plus"></i></button>';
        }
      }
    }
  });
}

function getFilteredPlaylist() {
  if (!plFilterText) return playlist;
  const q = plFilterText.toLowerCase();
  return playlist.filter(s =>
    (s.name || '').toLowerCase().includes(q) ||
    (s.tags || '').toLowerCase().includes(q) ||
    (s.country || '').toLowerCase().includes(q)
  );
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

  const filtered = getFilteredPlaylist();

  // Group by first tag
  const groups = {};
  filtered.forEach(s => {
    const genre = (s.tags || '').split(',')[0].trim() || 'Sin género';
    if (!groups[genre]) groups[genre] = [];
    groups[genre].push(s);
  });

  let html = '';

  // PlSearch input
  html += `<div class="pl-search-wrap">
    <input type="text" id="plSearch" class="pl-search" placeholder="Filtrar en playlist..." value="${escAttr(plFilterText)}" autocomplete="off">
  </div>`;

  const sortedGenres = Object.keys(groups).sort();
  sortedGenres.forEach(genre => {
    const items = groups[genre];
    html += `<div class="pl-group">
      <div class="pl-group-header">
        <span class="pl-group-name">${escHtml(genre)}</span>
        <span class="pl-group-count">${items.length}</span>
      </div>`;

    items.forEach(s => {
      const uuid = s.uuid || s.stationuuid || '';
      const isPlaying = uuid === document.querySelector('.pl-item.playing')?.dataset.uuid;
      html += `
      <div class="pl-item ${isPlaying ? 'playing' : ''}" draggable="true"
        data-url="${escAttr(s.url)}" 
        data-uuid="${escAttr(uuid)}" 
        data-name="${escAttr(s.name)}"
        data-pl-idx="${playlist.indexOf(s)}">
        <div class="pl-drag-handle"><i class="fas fa-grip-lines"></i></div>
        ${s.favicon
          ? `<img src="${escAttr(s.favicon)}" class="pl-favicon" alt="" loading="lazy" onerror="this.style.display='none'">`
          : `<div class="pl-favicon-placeholder"><i class="fas fa-radio"></i></div>`
        }
        <div class="pl-info">
          <span class="pl-name">${escHtml(s.name || 'Sin nombre')}</span>
          <div class="pl-meta">
            ${s.bitrate ? `<span class="badge badge-bitrate">${s.bitrate}k</span>` : ''}
            ${s.codec ? `<span class="badge badge-codec">${s.codec}</span>` : ''}
            ${s.country ? `<span class="badge badge-country">${escHtml(s.country)}</span>` : ''}
            ${s.language ? `<span class="badge badge-lang">${escHtml(s.language)}</span>` : ''}
          </div>
        </div>
        <div class="pl-actions">
          <button class="btn btn-play-small" title="Reproducir"><i class="fas fa-play"></i></button>
          <button class="btn btn-remove" title="Eliminar"><i class="fas fa-times"></i></button>
        </div>
      </div>`;
    });

    html += `</div>`;
  });

  container.innerHTML = html;

  // Re-bind search input event
  document.getElementById('plSearch')?.addEventListener('input', onPlSearch);

  // Re-bind drag events on new items
  container.querySelectorAll('.pl-item[draggable]').forEach(el => {
    el.addEventListener('dragstart', onPlDragStart);
    el.addEventListener('dragover', onPlDragOver);
    el.addEventListener('drop', onPlDrop);
    el.addEventListener('dragend', onPlDragEnd);
  });
}

/* ── Playlist Search ── */
function onPlSearch(e) {
  plFilterText = e.target.value;
  renderPlaylist();
}

/* ── Playlist Play All / Shuffle ── */
function playlistPlayAll() {
  const filtered = getFilteredPlaylist();
  if (!filtered.length) return;
  plShuffled = false;
  plCurrentIndex = 0;
  playPlItem(plCurrentIndex);
}

function playlistShuffle() {
  const filtered = getFilteredPlaylist();
  if (!filtered.length) return;
  plShuffled = true;
  const indices = filtered.map((_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  plShuffleOrder = indices;
  plCurrentIndex = 0;
  playPlItem(plShuffleOrder[0]);
}

function playPlItem(filteredIdx) {
  const filtered = getFilteredPlaylist();
  if (filteredIdx < 0 || filteredIdx >= filtered.length) return;
  const s = filtered[filteredIdx];
  if (!s || !s.url) return;
  play(s.url, s.name, s.uuid);
}

function playNext() {
  const filtered = getFilteredPlaylist();
  if (!filtered.length) return;
  if (plCurrentIndex < 0) { playlistPlayAll(); return; }
  plCurrentIndex++;
  if (plCurrentIndex >= filtered.length) plCurrentIndex = 0;
  const idx = plShuffled ? plShuffleOrder[plCurrentIndex] : plCurrentIndex;
  playPlItem(idx);
}

function playPrev() {
  const filtered = getFilteredPlaylist();
  if (!filtered.length) return;
  if (plCurrentIndex < 0) { playlistPlayAll(); return; }
  plCurrentIndex--;
  if (plCurrentIndex < 0) plCurrentIndex = filtered.length - 1;
  const idx = plShuffled ? plShuffleOrder[plCurrentIndex] : plCurrentIndex;
  playPlItem(idx);
}

function handlePlaybackError() {
  if (autoSkipTimer) return;
  const filtered = getFilteredPlaylist();
  if (plCurrentIndex >= 0 && filtered.length > 0) {
    if (autoSkipCount >= filtered.length) {
      console.warn('[AUTO-SKIP] All stations in playlist failed, stopping.');
      const display = document.getElementById('radioDisplay');
      if (display) display.textContent = '❌ Todas las radios fallaron';
      return;
    }
    autoSkipCount++;
    const display = document.getElementById('radioDisplay');
    if (display) display.textContent = `⚠️ Error - Saltando a la siguiente... (${autoSkipCount}/${filtered.length})`;
    autoSkipTimer = setTimeout(() => {
      autoSkipTimer = null;
      playNext();
    }, 1500);
  }
}

/* ── Drag & Drop ── */
function onPlDragStart(e) {
  const item = e.target.closest('.pl-item');
  if (!item) return;
  plDragSrcIndex = parseInt(item.dataset.plIdx);
  item.classList.add('pl-dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', plDragSrcIndex);
}

function onPlDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const item = e.target.closest('.pl-item');
  if (!item) return;
  document.querySelectorAll('.pl-item').forEach(el => el.classList.remove('pl-drag-over'));
  item.classList.add('pl-drag-over');
}

function onPlDrop(e) {
  e.preventDefault();
  const target = e.target.closest('.pl-item');
  if (!target) return;
  const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
  const toIdx = parseInt(target.dataset.plIdx);
  if (isNaN(fromIdx) || isNaN(toIdx) || fromIdx === toIdx) return;

  const item = playlist.splice(fromIdx, 1)[0];
  const adjustedTo = fromIdx < toIdx ? toIdx - 1 : toIdx;
  playlist.splice(adjustedTo, 0, item);
  persistPlaylist();
  renderPlaylist();
}

function onPlDragEnd(e) {
  document.querySelectorAll('.pl-item').forEach(el => {
    el.classList.remove('pl-dragging', 'pl-drag-over');
  });
}

/* ── Playlist Toolbar ── */
function onToolbarClick(e) {
  const btn = e.target.closest('button');
  if (!btn) return;

  if (btn) {
    if (btn.id === 'btnExportM3U') exportM3U();
    if (btn.id === 'btnExportJSON') exportJSON();
    if (btn.id === 'btnImportJSON') importJSON();
    if (btn.id === 'btnImportM3U') importM3U();
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
    const attrs = [
      `tvg-id="${s.uuid || ''}"`,
      `tvg-logo="${s.favicon || ''}"`,
      `tvg-name="${s.name || ''}"`,
      `group-title="${s.tags || ''}"`,
      `tvg-country="${s.country || ''}"`,
      `tvg-language="${s.language || ''}"`,
      `tvg-bitrate="${s.bitrate || ''}"`,
      `tvg-codec="${s.codec || ''}"`,
    ].join(' ');
    lines.push(`#EXTINF:-1 ${attrs},${s.name}`);
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
            codec: s.codec || '',
            homepage: s.homepage || '',
            language: s.language || '',
            state: s.state || '',
            clickcount: s.clickcount || '',
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

function importM3U() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.m3u,.m3u8';
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
      const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#EXTM3U'));

      const existing = new Set(playlist.map(s => s.uuid));
      let added = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('#EXTINF:')) {
          const urlLine = lines[i + 1];
          if (!urlLine || urlLine.startsWith('#')) continue;

          const attrMatch = line.match(/tvg-id="([^"]*)"/);
          const nameMatch = line.match(/,([^,]+)$/);
          const logoMatch = line.match(/tvg-logo="([^"]*)"/);
          const groupMatch = line.match(/group-title="([^"]*)"/);
          const countryMatch = line.match(/tvg-country="([^"]*)"/);
          const langMatch = line.match(/tvg-language="([^"]*)"/);
          const bitrateMatch = line.match(/tvg-bitrate="([^"]*)"/);
          const codecMatch = line.match(/tvg-codec="([^"]*)"/);

          const uuid = attrMatch ? attrMatch[1] : `m3u-${i}`;
          const name = nameMatch ? nameMatch[1] : 'Sin nombre';

          if (!existing.has(uuid)) {
            playlist.push({
              uuid,
              name,
              url: urlLine,
              favicon: logoMatch ? logoMatch[1] : '',
              tags: groupMatch ? groupMatch[1] : '',
              country: countryMatch ? countryMatch[1] : '',
              bitrate: bitrateMatch ? bitrateMatch[1] : '',
              codec: codecMatch ? codecMatch[1] : '',
              language: langMatch ? langMatch[1] : '',
            });
            existing.add(uuid);
            added++;
          }
          i++;
        }
      }

      if (added > 0) {
        persistPlaylist();
        renderPlaylist();
      }
    } catch {
      alert('El archivo M3U no es válido');
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

/* ── Timer and Alarm Logic ── */
function initTimerAndAlarm() {
  const btnToggle = document.getElementById('btnTimerToggle');
  const modal = document.getElementById('timerModal');
  const btnClose = document.getElementById('btnCloseTimerModal');
  
  if (!btnToggle || !modal || !btnClose) return;

  // Toggle Modal open/close
  btnToggle.addEventListener('click', () => {
    modal.classList.add('show');
    populateAlarmStations();
    updateTimerModalUI();
  });

  btnClose.addEventListener('click', () => {
    modal.classList.remove('show');
  });

  // Close modal when clicking outside content
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.remove('show');
    }
  });

  // Open modal if badge is clicked
  document.getElementById('timerIndicator')?.addEventListener('click', () => btnToggle.click());
  document.getElementById('alarmIndicator')?.addEventListener('click', () => btnToggle.click());

  // --- Sleep Timer Setup ---
  const presets = document.querySelectorAll('.sleep-presets .btn-preset[data-minutes]');
  presets.forEach(btn => {
    btn.addEventListener('click', () => {
      presets.forEach(p => p.classList.remove('active'));
      document.getElementById('customSleepInputWrap').classList.add('hidden');
      
      const mins = parseInt(btn.dataset.minutes);
      setSleepTimer(mins);
      btn.classList.add('active');
    });
  });

  const btnCustom = document.getElementById('btnCustomSleep');
  const customWrap = document.getElementById('customSleepInputWrap');
  if (btnCustom && customWrap) {
    btnCustom.addEventListener('click', () => {
      presets.forEach(p => p.classList.remove('active'));
      btnCustom.classList.add('active');
      customWrap.classList.remove('hidden');
      document.getElementById('inputCustomSleep').focus();
    });
  }

  document.getElementById('btnApplyCustomSleep')?.addEventListener('click', () => {
    const input = document.getElementById('inputCustomSleep');
    const mins = parseInt(input.value);
    if (isNaN(mins) || mins <= 0) {
      alert('Ingresa un número válido de minutos');
      return;
    }
    setSleepTimer(mins);
  });

  // --- Alarm Clock Setup ---
  const inputAlarmTime = document.getElementById('inputAlarmTime');
  const btnToggleAlarm = document.getElementById('btnToggleAlarm');
  const selectAlarmStation = document.getElementById('selectAlarmStation');

  if (inputAlarmTime) inputAlarmTime.value = alarmTime;
  if (selectAlarmStation) {
    selectAlarmStation.value = alarmStation;
    selectAlarmStation.addEventListener('change', () => {
      alarmStation = selectAlarmStation.value;
      localStorage.setItem('radios_alarm_station', alarmStation);
      updateTimerModalUI();
      updateBadges();
    });
  }

  if (btnToggleAlarm) {
    btnToggleAlarm.addEventListener('click', () => {
      if (alarmEnabled) {
        // Disable alarm
        alarmEnabled = false;
        localStorage.setItem('radios_alarm_enabled', 'false');
      } else {
        // Enable alarm
        const val = inputAlarmTime.value;
        if (!val) {
          alert('Por favor selecciona una hora para la alarma.');
          return;
        }
        alarmTime = val;
        alarmEnabled = true;
        localStorage.setItem('radios_alarm_time', alarmTime);
        localStorage.setItem('radios_alarm_enabled', 'true');
      }
      updateTimerModalUI();
      updateBadges();
    });
  }

  if (inputAlarmTime) {
    inputAlarmTime.addEventListener('change', () => {
      alarmTime = inputAlarmTime.value;
      localStorage.setItem('radios_alarm_time', alarmTime);
      if (alarmEnabled) {
        updateTimerModalUI();
        updateBadges();
      }
    });
  }

  // Start checking loop for alarm and updating timer countdown
  if (alarmCheckerInterval) clearInterval(alarmCheckerInterval);
  alarmCheckerInterval = setInterval(() => {
    checkAlarm();
    updateSleepCountdown();
  }, 1000);

  // Update initial UI state
  updateTimerModalUI();
  updateBadges();
}

function setSleepTimer(minutes) {
  sleepTimeTarget = Date.now() + minutes * 60 * 1000;
  
  updateTimerModalUI();
  updateBadges();
}

function cancelSleepTimer() {
  sleepTimeTarget = null;
  const presets = document.querySelectorAll('.sleep-presets .btn-preset');
  presets.forEach(p => p.classList.remove('active'));
  const customWrap = document.getElementById('customSleepInputWrap');
  if (customWrap) customWrap.classList.add('hidden');
  const customInput = document.getElementById('inputCustomSleep');
  if (customInput) customInput.value = '';
  
  updateTimerModalUI();
  updateBadges();
}

window.cancelSleepTimer = cancelSleepTimer;

function updateSleepCountdown() {
  if (!sleepTimeTarget) return;
  
  const diff = sleepTimeTarget - Date.now();
  if (diff <= 0) {
    sleepTimeTarget = null;
    triggerSleepStop();
  } else {
    updateBadges();
    // Update status string in modal if open
    const statusDiv = document.getElementById('sleepTimerStatus');
    if (statusDiv) {
      const remainingSecs = Math.floor(diff / 1000);
      const m = Math.floor(remainingSecs / 60).toString().padStart(2, '0');
      const s = (remainingSecs % 60).toString().padStart(2, '0');
      statusDiv.innerHTML = `
        <span>⏳ Quedan <strong>${m}:${s}</strong> min para apagar.</span>
        <button class="btn-cancel-timer" onclick="cancelSleepTimer()">Cancelar</button>
      `;
      statusDiv.classList.add('active');
    }
  }
}

function triggerSleepStop() {
  console.log('[TIMER] Sleep timer triggered. Stopping playback.');
  if (player) {
    player.stop();
  }
  const marquee = document.getElementById('radioDisplay');
  if (marquee) marquee.textContent = 'Apagado automático por temporizador';
  
  updateTimerModalUI();
  updateBadges();
}

function populateAlarmStations() {
  const select = document.getElementById('selectAlarmStation');
  if (!select) return;
  
  const currentVal = select.value || alarmStation;
  select.innerHTML = '<option value="current">Radio actual / sintonizada</option>';
  
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

function updateTimerModalUI() {
  // Sleep UI
  const statusDiv = document.getElementById('sleepTimerStatus');
  if (statusDiv) {
    if (sleepTimeTarget) {
      const remaining = Math.max(0, Math.floor((sleepTimeTarget - Date.now()) / 1000));
      const m = Math.floor(remaining / 60).toString().padStart(2, '0');
      const s = (remaining % 60).toString().padStart(2, '0');
      statusDiv.innerHTML = `
        <span>⏳ Quedan <strong>${m}:${s}</strong> min para apagar.</span>
        <button class="btn-cancel-timer" onclick="cancelSleepTimer()">Cancelar</button>
      `;
      statusDiv.classList.add('active');
    } else {
      statusDiv.innerHTML = '<span>Apagado automático desactivado.</span>';
      statusDiv.classList.remove('active');
    }
  }

  // Alarm UI
  const btnToggleAlarm = document.getElementById('btnToggleAlarm');
  const alarmStatusDiv = document.getElementById('alarmStatus');
  
  if (btnToggleAlarm) {
    if (alarmEnabled) {
      btnToggleAlarm.textContent = 'Desactivar';
      btnToggleAlarm.classList.add('active');
    } else {
      btnToggleAlarm.textContent = 'Activar';
      btnToggleAlarm.classList.remove('active');
    }
  }

  if (alarmStatusDiv) {
    if (alarmEnabled && alarmTime) {
      let stationName = 'Radio actual';
      if (alarmStation !== 'current') {
        const station = playlist.find(s => (s.uuid || s.stationuuid) === alarmStation);
        if (station) stationName = station.name;
      }
      alarmStatusDiv.innerHTML = `
        <span>🔔 Activa a las <strong>${alarmTime}</strong> sintonizando <em>"${stationName}"</em>.</span>
      `;
      alarmStatusDiv.classList.add('active');
    } else {
      alarmStatusDiv.innerHTML = '<span>Alarma desactivada.</span>';
      alarmStatusDiv.classList.remove('active');
    }
  }
}

function updateBadges() {
  const btnToggle = document.getElementById('btnTimerToggle');
  const alarmBadge = document.getElementById('alarmIndicator');
  const sleepBadge = document.getElementById('timerIndicator');

  let anyActive = false;

  // Alarm Badge
  if (alarmBadge) {
    if (alarmEnabled && alarmTime) {
      alarmBadge.textContent = `⏰ ${alarmTime}`;
      alarmBadge.classList.remove('hidden');
      anyActive = true;
    } else {
      alarmBadge.classList.add('hidden');
    }
  }

  // Sleep Badge
  if (sleepBadge) {
    if (sleepTimeTarget) {
      const remaining = Math.max(0, Math.floor((sleepTimeTarget - Date.now()) / 1000));
      const m = Math.floor(remaining / 60);
      const s = remaining % 60;
      sleepBadge.textContent = `⏳ ${m}:${s.toString().padStart(2, '0')}`;
      sleepBadge.classList.remove('hidden');
      anyActive = true;
    } else {
      sleepBadge.classList.add('hidden');
    }
  }

  // Main Toggle Button
  if (btnToggle) {
    if (anyActive) {
      btnToggle.classList.add('active');
    } else {
      btnToggle.classList.remove('active');
    }
  }
}

function checkAlarm() {
  if (!alarmEnabled || !alarmTime) return;

  const now = new Date();
  const hrs = now.getHours().toString().padStart(2, '0');
  const mins = now.getMinutes().toString().padStart(2, '0');
  const currentTimeString = `${hrs}:${mins}`;

  if (currentTimeString === alarmTime) {
    const todayStr = now.toDateString() + ' ' + currentTimeString;
    if (lastAlarmTriggeredDate !== todayStr) {
      lastAlarmTriggeredDate = todayStr;
      triggerAlarm();
    }
  }
}

function triggerAlarm() {
  console.log('[ALARM] Alarm clock triggered at %s!', alarmTime);
  
  let targetStation = null;
  if (alarmStation !== 'current') {
    targetStation = playlist.find(s => (s.uuid || s.stationuuid) === alarmStation);
  }

  const marquee = document.getElementById('radioDisplay');
  
  if (targetStation) {
    if (marquee) marquee.textContent = `⏰ ¡ALARMA! Sintonizando ${targetStation.name}...`;
    play(targetStation.url, targetStation.name, targetStation.uuid);
  } else {
    // Play current or first playlist item
    const currentPlayingCard = document.querySelector('.station-card.playing, .pl-item.playing');
    if (currentPlayingCard) {
      const name = currentPlayingCard.dataset.name;
      const url = currentPlayingCard.dataset.url;
      const uuid = currentPlayingCard.dataset.uuid;
      if (marquee) marquee.textContent = `⏰ ¡ALARMA! Sintonizando ${name}...`;
      play(url, name, uuid);
    } else if (playlist.length > 0) {
      const first = playlist[0];
      if (marquee) marquee.textContent = `⏰ ¡ALARMA! Sintonizando ${first.name}...`;
      play(first.url, first.name, first.uuid);
    } else {
      if (marquee) marquee.textContent = '⏰ ¡ALARMA! (No hay radios guardadas en tu playlist)';
      // Play sponsored 1 as fallback
      const fallback = SPONSORED_STATIONS[0];
      play(fallback.url, fallback.name, fallback.uuid);
    }
  }
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
