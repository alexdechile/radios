/* ===========================================
   RADIOS APP — Sketch Player
   Radio Browser API + Plyr + Playlist
   =========================================== */

const API_SERVERS = ['de1', 'de2', 'nl1', 'at1'];
const UA = 'RadiosSketchApp/1.0';
const STORE_KEY = 'radios_playlist';
const APP_VERSION = '1.5.1';

// Resolve API path relative to base path (handles /radios subpath on production)
function getApiUrl(path) {
  const prefix = window.location.pathname.startsWith('/radios') ? '/radios' : '';
  const cleanPath = path.startsWith('/') ? path : '/' + path;
  return prefix + cleanPath;
}

const SPONSORED_STATIONS = [];

let player = null;
let playlist = [];
let deepDb = [];
let cachedServer = null;
let searchResults = [];
let activeQueue = 'playlist';
let metadataInterval = null;
let nowPlayingInterval = null;
let audioCtx = null;
let eqFilters = [];   // 5 BiquadFilter nodes
let eqActive = false; // panel open state

// Audio Effects state
let effectsActive = false; // panel open state
let stereoWidthNode = null;  // { splitter, gains, merger }
let surroundNode = null;     // { splitter, delay, merger }
let bassBoostFilter = null;  // BiquadFilterNode
let effectsInjected = false; // whether effects are in the chain

// Screen Wake Lock
let wakeLock = null;

async function requestWakeLock() {
  try {
    if (wakeLock) return;
    if (!('wakeLock' in navigator)) return;
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {}
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release();
    wakeLock = null;
  }
}

// Station Presets state

let currentPlayingStation = null; // { url, name, uuid }

// EQ band config: [frequency Hz, type]
const EQ_BANDS = [
  { freq: 60,    type: 'lowshelf'  },
  { freq: 250,   type: 'peaking'   },
  { freq: 1000,  type: 'peaking'   },
  { freq: 4000,  type: 'peaking'   },
  { freq: 16000, type: 'highshelf' },
];

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

// News-by-voice state
let newsEnabled = localStorage.getItem('radios_news_enabled') === 'true';
let lastNewsHour = -1;
let duckGain = null;
let newsPlaying = false;

// Playlist navigation state
let plFilterText = '';
let plCurrentIndex = -1;
let plShuffled = false;
let plShuffleOrder = [];
let plDragSrcIndex = -1;

// Health check state
const HEALTH_CHECK_TIMEOUT = 6000;
const HEALTH_CONCURRENCY = 3;
let stationHealth = new Map();
let hideOffline = false;
let healthCheckAborted = false;

// Song info popup state
let lastSongInfoTitle = null;
let songPopupTimer = null;
let songPopupDismissTimer = null;

/* ── Init ── */
async function init() {
  await checkUpdate();

  // Service Worker for PWA
  if ('serviceWorker' in navigator) {
    const hadSW = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.update();
    }).catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadSW) window.location.reload();
    });
  }

  playlist = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');

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

  player.on('play', () => {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    requestWakeLock();
  });
  player.on('pause', () => {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    releaseWakeLock();
  });

  // Re-acquire wake lock when returning to app
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && player?.playing) {
      requestWakeLock();
    }
  });

  renderPlaylist();

  // Deep Search Button
  document.getElementById('btnDeepSearch').addEventListener('click', deepSearch);

  // Tab Switching Logic
  const tabResults = document.getElementById('tabResults');
  const tabPlaylist = document.getElementById('tabPlaylist');
  const sectionResults = document.getElementById('resultsSection');
  const sectionPlaylist = document.getElementById('playlistSection');

  const btnPlToggle = document.getElementById('btnPlaylistToggle');

  tabResults.addEventListener('click', () => {
    activeQueue = 'results';
    sectionResults.classList.remove('hidden');
    sectionPlaylist.classList.add('hidden');
    if (btnPlToggle) btnPlToggle.classList.remove('active');
    initCarousel();
  });

  tabPlaylist.addEventListener('click', () => {
    activeQueue = 'playlist';
    sectionPlaylist.classList.remove('hidden');
    sectionResults.classList.add('hidden');
    if (btnPlToggle) btnPlToggle.classList.add('active');
  });

  if (btnPlToggle) {
    btnPlToggle.addEventListener('click', () => {
      if (sectionPlaylist && sectionPlaylist.classList.contains('hidden')) {
        tabPlaylist.click();
      } else {
        tabResults.click();
      }
    });
  }

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
    hideSongPopup();
    lastSongInfoTitle = null;
    if (typeof window.htmxNowPlayingIdle === 'function') {
      window.htmxNowPlayingIdle();
    }
  });
  document.getElementById('btnPrev')?.addEventListener('click', () => {
    playPrev();
  });
  document.getElementById('btnNext')?.addEventListener('click', () => {
    playNext();
  });

  // Favorite toggle from player
  document.getElementById('btnFavPlayer')?.addEventListener('click', () => {
    const cur = currentPlayingStation;
    if (!cur || (!cur.uuid && !cur.url)) return;

    // Match by uuid first, then by url as fallback
    const inPl = cur.uuid
      ? playlist.some(p => p.uuid === cur.uuid)
      : playlist.some(p => p.url === cur.url);

    if (inPl) {
      // Remove: find by uuid or url
      const toRemove = cur.uuid
        ? playlist.find(p => p.uuid === cur.uuid)
        : playlist.find(p => p.url === cur.url);
      if (toRemove) removeFromPlaylist(toRemove.uuid || toRemove.url);
    } else {
      // Add: use all available data from sData (search/playlist cache) or currentPlayingStation
      const sData = searchResults.find(s => s.url === cur.url) || playlist.find(s => s.url === cur.url);
      addToPlaylist({
        uuid: cur.uuid || ('local-' + btoa(cur.url).slice(0, 12)),
        name: cur.name,
        url: cur.url,
        favicon: cur.favicon || sData?.favicon || '',
        tags: sData?.tags || '',
        country: sData?.country || '',
        bitrate: sData?.bitrate || '',
        codec: sData?.codec || '',
      });
    }
    updatePlayerFavButton();
  });

  // Auto-advance on stream end
  player.on('ended', () => {
    playNext();
  });

  // Event delegation
  document.getElementById('results').addEventListener('click', onResultsClick);
  document.getElementById('playlist').addEventListener('click', onPlaylistClick);
  document.getElementById('btnExportM3U')?.addEventListener('click', (e) => onToolbarClick(e));
  document.getElementById('btnExportJSON')?.addEventListener('click', (e) => onToolbarClick(e));
  document.getElementById('btnImportJSON')?.addEventListener('click', (e) => onToolbarClick(e));
  document.getElementById('btnImportM3U')?.addEventListener('click', (e) => onToolbarClick(e));
  document.getElementById('btnCopyPlaylist')?.addEventListener('click', copyPlaylistToClipboard);
  document.getElementById('btnHardRefresh')?.addEventListener('click', hardRefresh);


  // Playlist toolbar
  document.getElementById('plSearch')?.addEventListener('input', onPlSearch);
  document.getElementById('btnPlayAll')?.addEventListener('click', () => {
    playlistPlayAll();
  });
  document.getElementById('btnShuffle')?.addEventListener('click', () => {
    playlistShuffle();
  });

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

  // Init News-by-Voice
  initNewsFeature();

  // Init EQ Panel UI
  initEqPanel();

  // Init Effects Panel UI
  initEffectsPanel();

  // Init Info Panel UI
  initInfoPanel();

  // Init Search Panel
  initSearchPanel();

  // Init horizontal drag-scroll for header buttons and carousel
  initHorizontalDrag(document.querySelector('.app-header-actions'));
  initHorizontalDrag(document.getElementById('resultsSection'));

  // Load favorites into carousel on startup
  if (playlist.length > 0) {
    document.getElementById('tabResults').click();
    renderResults(playlist);
    setTimeout(initCarousel, 50);
  }
}

function initEqualizer() {
  const audio = document.getElementById('audioPlayer');
  if (audioCtx) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return;
  }

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // Build EQ filter chain
  eqFilters = EQ_BANDS.map((band, i) => {
    const filter = audioCtx.createBiquadFilter();
    filter.type = band.type;
    filter.frequency.value = band.freq;
    filter.Q.value = 1.4;
    const saved = parseFloat(localStorage.getItem(`eq_band_${i}`) || '0');
    filter.gain.value = saved;
    return filter;
  });

  // Chain: source → filter[0] → filter[1] → effects → destination
  try {
    const source = audioCtx.createMediaElementSource(audio);
    let node = source;
    for (const filter of eqFilters) {
      node.connect(filter);
      node = filter;
    }
    node = createEffectsChain(node);
    // Duck node for news voice-over
    duckGain = audioCtx.createGain();
    duckGain.gain.value = 1.0;
    node.connect(duckGain);
    duckGain.connect(audioCtx.destination);
  } catch (e) {
    audioCtx = null;
    eqFilters = [];
    effectsInjected = false;
    return;
  }

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
  if (!panel) return;

  function toggleEq() {
    eqActive = !eqActive;
    panel.classList.toggle('hidden', !eqActive);
    if (btnToggle) btnToggle.classList.toggle('eq-active', eqActive);
    // Close info panel if open
    if (eqActive && infoActive) {
      infoActive = false;
      const infoPanel = document.getElementById('infoPanel');
      if (infoPanel) infoPanel.classList.add('hidden');
      const infoBtn = document.getElementById('btnInfoToggle');
      if (infoBtn) infoBtn.classList.remove('info-active');
    }
  }

  if (btnToggle) btnToggle.addEventListener('click', toggleEq);

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
  if (!panel) return;

  function toggleEffects() {
    effectsActive = !effectsActive;
    panel.classList.toggle('hidden', !effectsActive);
    if (btnToggle) btnToggle.classList.toggle('effects-active', effectsActive);
    // Close EQ panel if open
    if (effectsActive && eqActive) {
      eqActive = false;
      const eqPanel = document.getElementById('eqPanel');
      if (eqPanel) eqPanel.classList.add('hidden');
      const eqBtn = document.getElementById('btnEqToggle');
      if (eqBtn) eqBtn.classList.remove('eq-active');
    }
    if (effectsActive && infoActive) {
      infoActive = false;
      const infoPanel = document.getElementById('infoPanel');
      if (infoPanel) infoPanel.classList.add('hidden');
      const infoBtn = document.getElementById('btnInfoToggle');
      if (infoBtn) infoBtn.classList.remove('info-active');
    }
  }

  if (btnToggle) btnToggle.addEventListener('click', toggleEffects);

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

function initHorizontalDrag(container) {
  if (!container) return;
  let isDown = false;
  let startX;
  let scrollLeft;
  let moved = false;

  function onStart(clientX) {
    isDown = true;
    moved = false;
    startX = clientX - container.offsetLeft;
    scrollLeft = container.scrollLeft;
  }

  function onMove(clientX) {
    if (!isDown) return;
    const x = clientX - container.offsetLeft;
    const walk = (x - startX) * 1.5;
    if (Math.abs(walk) > 5) moved = true;
    if (moved) container.scrollLeft = scrollLeft - walk;
  }

  function onEnd() {
    isDown = false;
  }

  // Mouse drag-scroll events for desktop
  container.addEventListener('mousedown', (e) => { onStart(e.pageX); });
  container.addEventListener('mousemove', (e) => { onMove(e.pageX); });
  container.addEventListener('mouseup', onEnd);
  container.addEventListener('mouseleave', onEnd);

  // Prevent triggering click on children (buttons/cards) when dragging on desktop
  container.addEventListener('click', (e) => {
    if (moved) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true); // Capture phase to intercept before target elements receive click
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
  // Cancel any ongoing health check
  healthCheckAborted = true;

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
        searchResults = fallbackResults.map(s => ({
          uuid: s.stationuuid || s.uuid || '',
          name: s.name || 'Sin nombre',
          url: s.url_resolved || s.url || '',
          tags: s.tags || '',
          favicon: s.favicon || '',
          country: s.country || '',
          bitrate: s.bitrate || '',
          codec: s.codec || ''
        }));
        renderResults(fallbackResults);
        setTimeout(initCarousel, 50);
        container.innerHTML += '<div class="status-msg hint">Solo resultados locales (sin conexión a API)</div>';
        prefilterResults().catch(err => {
          console.error('[HEALTHCHECK] prefilter error:', err);
        });
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

    // Deduplicate
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
      const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
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

    const finalResults = [...discoveryResults, ...alreadyFavorited].slice(0, 150);
    searchResults = finalResults.map(s => ({
      uuid: s.stationuuid || s.uuid || '',
      name: s.name || 'Sin nombre',
      url: s.url_resolved || s.url || '',
      tags: s.tags || '',
      favicon: s.favicon || '',
      country: s.country || '',
      bitrate: s.bitrate || '',
      codec: s.codec || ''
    }));
    renderResults(finalResults);
    setTimeout(initCarousel, 50);
    // Start health check in background
    prefilterResults().catch(err => {
      console.error('[HEALTHCHECK] prefilter error:', err);
    });
  } catch {
    container.innerHTML = '<div class="status-msg error">Error al buscar. Intenta de nuevo.</div>'
      + '<div class="status-msg hint">💡 Tip: prueba "80s", "jazz", "rock", "disco", "electro"</div>';
  }
}

async function deepSearch() {
  // Switch to results tab automatically
  document.getElementById('tabResults').click();

  const input = document.getElementById('searchPanelInput');
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

/* ── Placeholder SVG (funny cartoon radio with glasses) ── */
const PLACEHOLDER_SVG = `<svg viewBox="0 0 140 100" xmlns="http://www.w3.org/2000/svg">
  <rect x="15" y="22" width="110" height="56" rx="14" fill="#F5EDE0" stroke="#D4C5A9" stroke-width="2"/>
  <rect x="25" y="30" width="90" height="16" rx="6" fill="#EDE5D5" stroke="#D4C5A9" stroke-width="1"/>
  <circle cx="48" cy="38" r="3.5" fill="#4A4A4A"/>
  <circle cx="78" cy="38" r="3.5" fill="#4A4A4A"/>
  <ellipse cx="48" cy="38" rx="8" ry="6" fill="none" stroke="#E8A87C" stroke-width="2"/>
  <ellipse cx="78" cy="38" rx="8" ry="6" fill="none" stroke="#E8A87C" stroke-width="2"/>
  <line x1="56" y1="38" x2="70" y2="38" stroke="#E8A87C" stroke-width="2"/>
  <path d="M50 46 Q63 54 76 46" fill="none" stroke="#4A4A4A" stroke-width="2" stroke-linecap="round"/>
  <circle cx="42" cy="66" r="5" fill="#D4C5A9" stroke="#C0B096" stroke-width="1.5"/>
  <circle cx="88" cy="66" r="5" fill="#D4C5A9" stroke="#C0B096" stroke-width="1.5"/>
  <line x1="70" y1="22" x2="70" y2="10" stroke="#D4C5A9" stroke-width="2.5" stroke-linecap="round"/>
  <circle cx="70" cy="8" r="4.5" fill="#F4A6A0" stroke="#E89090" stroke-width="1.5"/>
  <rect x="34" y="78" width="14" height="3" rx="1.5" fill="#D4C5A9"/>
  <rect x="82" y="78" width="14" height="3" rx="1.5" fill="#D4C5A9"/>
</svg>`;

function faviconError(imgEl) {
  const art = imgEl.parentNode;
  if (!art) return;
  art.innerHTML = PLACEHOLDER_SVG;
}

/* ── Render Results ── */
function renderResults(stations, isAppend = false) {
  const container = document.getElementById('results');

  if (stations && Array.isArray(stations)) {
    stations = stations.filter(s => {
      const name = (s.name || '').toLowerCase();
      const tags = (s.tags || '').toLowerCase();
      const country = (s.country || '').toLowerCase();
      const url = (s.url_resolved || s.url || '').toLowerCase();
      const uuid = (s.uuid || s.stationuuid || '').toLowerCase();
      return !name.includes('sponsored') &&
             !tags.includes('sponsored') &&
             !country.includes('sponsored') &&
             !url.includes('sponsored') &&
             !uuid.includes('sponsored') &&
             !s.is_sponsored;
    });
  }

  if (!stations || !stations.length) {
    if (!isAppend) container.innerHTML = '<div class="status-msg">Sin resultados. Prueba otro término.</div>';
    return;
  }

  const cardsHtml = stations.map((s) => {
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
            ? `<img src="${escAttr(favicon)}" alt="" loading="lazy" onerror="faviconError(this)">`
            : `<div class="placeholder-icon">${PLACEHOLDER_SVG}</div>`
          }
        </div>
        <div class="station-card-body">
          <div class="station-name-row">
            <button class="btn-play-card" title="Reproducir"><i class="fas fa-play"></i></button>
            <div class="station-name">
              ${name}
              <span class="health-badge checking" title="Verificando..."><i class="fas fa-spinner fa-spin"></i></span>
            </div>
          </div>
          ${tagList.length ? `<div class="station-tags">${tagList.join(', ')}</div>` : ''}
          <div class="station-card-badges">${badgeHtml}</div>
        </div>
        <div class="station-card-footer">
          ${inPl
            ? `<button class="btn-add-card is-fav" title="Quitar de playlist"><i class="fas fa-heart"></i></button>`
            : `<button class="btn-add-card" title="Agregar a playlist"><i class="fas fa-plus"></i></button>`
          }
          <button class="btn-dismiss-card" title="Descartar"><i class="fas fa-eye-slash"></i></button>
        </div>
      </div>
    `;
  }).join('');

  // Build health filter bar (only for initial render)
  const filterBar = !isAppend ? `
    <div class="health-filter-bar">
      <span>${stations.length} resultados</span>
      <button class="btn-toggle-offline${hideOffline ? ' active' : ''}" id="btnToggleOffline" data-hide="${hideOffline ? '1' : '0'}">
        <i class="fas fa-${hideOffline ? 'check-circle' : 'circle'}"></i> Solo verificadas
      </button>
    </div>` : '';

  container.innerHTML = filterBar + cardsHtml;
}

/* ── Health Check ── */
async function checkStationHealth(url) {
  try {
    const ep = getApiUrl(`api/healthcheck?url=${encodeURIComponent(url)}&timeout=${HEALTH_CHECK_TIMEOUT}`);
    const res = await fetch(ep);
    if (!res.ok) return { healthy: false, timeMs: 0, status: res.status };
    return await res.json();
  } catch {
    return { healthy: false, timeMs: 0, status: 0 };
  }
}

function updateHealthBadge(card, result) {
  const badge = card.querySelector('.health-badge');
  if (!badge) return;
  const healthy = result && result.healthy === true;
  badge.className = `health-badge ${healthy ? 'healthy' : 'unhealthy'}`;
  badge.innerHTML = healthy
    ? `<span>✓</span><small>${result.timeMs || 0}ms</small>`
    : `<span>✗</span><button class="btn-recheck" title="Re-verificar"><i class="fas fa-redo"></i></button>`;
  const url = card.dataset.url;
  if (url) stationHealth.set(url, healthy);
}

async function prefilterResults() {
  healthCheckAborted = false;
  const cards = [...document.querySelectorAll('#results .station-card')];
  let anyHealthy = false;

  for (let i = 0; i < cards.length; i += HEALTH_CONCURRENCY) {
    if (healthCheckAborted) break;
    const batch = cards.slice(i, i + HEALTH_CONCURRENCY);
    const checks = batch.map(async (card) => {
      if (healthCheckAborted) return;
      const url = card.dataset.url;
      if (!url) return;
      const badge = card.querySelector('.health-badge');
      if (badge) badge.className = 'health-badge checking';
      const result = await checkStationHealth(url);
      if (healthCheckAborted) return;
      updateHealthBadge(card, result);
      if (result && result.healthy === true) anyHealthy = true;
    });
    await Promise.allSettled(checks);
  }

  if (!anyHealthy && cards.length > 0 && !healthCheckAborted) {
    const display = document.getElementById('radioDisplay');
    if (display) display.textContent = '⚠️ Sin estaciones verificadas - toca una para reproducir';
  }
  healthCheckAborted = false;
}

/* ── Media Session (Lock Screen / Control Center) ── */
function updateMediaSession(station, trackTitle) {
  if (!('mediaSession' in navigator)) return;
  const title = trackTitle || station.name || 'Radios';
  const artwork = [];
  if (station.favicon) artwork.push({ src: station.favicon, sizes: '256x256', type: 'image/png' });
  artwork.push({ src: 'icon.svg', sizes: '256x256', type: 'image/svg+xml' });
  navigator.mediaSession.metadata = new MediaMetadata({
    title,
    artist: station.name || 'Radios',
    album: 'Radios App',
    artwork
  });
}

let mediaSessionActionsSetup = false;
function setupMediaSessionActions() {
  if (mediaSessionActionsSetup || !('mediaSession' in navigator)) return;
  mediaSessionActionsSetup = true;
  navigator.mediaSession.setActionHandler('play', () => player.play());
  navigator.mediaSession.setActionHandler('pause', () => player.pause());
  navigator.mediaSession.setActionHandler('previoustrack', () => document.getElementById('btnPrev')?.click());
  navigator.mediaSession.setActionHandler('nexttrack', () => document.getElementById('btnNext')?.click());
  navigator.mediaSession.setActionHandler('stop', () => player.pause());
}

/* ── Play Radio ── */
function play(url, name, uuid) {
  const audio = document.getElementById('audioPlayer');
  console.log('[PLAY] name=%s uuid=%s url=%s', name, uuid, url);

  // Set activeQueue automatically depending on where the station came from
  if (playlist.some(p => p.url === url)) {
    activeQueue = 'playlist';
  } else if (searchResults.some(s => s.url === url)) {
    activeQueue = 'results';
  }

  // Stop health checks
  healthCheckAborted = true;

  // Track currently playing station for preset assignment
  const sData = searchResults.find(s => s.url === url) || playlist.find(s => s.url === url);
  const favicon = sData ? sData.favicon || '' : '';
  currentPlayingStation = { url, name, uuid, favicon };
  updateMediaSession(currentPlayingStation);
  setupMediaSessionActions();
  // Update player fav button state
  updatePlayerFavButton();

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
  if (typeof window.htmxNowPlayingUpdate === 'function' && url) {
    const favicon = (currentPlayingStation && currentPlayingStation.favicon) || '';
    window.htmxNowPlayingUpdate(url, name, favicon);
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

  // Reset duck gain if it was left ducked by news
  if (duckGain) {
    duckGain.gain.cancelScheduledValues(audioCtx.currentTime);
    duckGain.gain.setValueAtTime(1.0, audioCtx.currentTime);
  }

  // Play
  player.play().then(() => {
    console.log('[PLAY] playback started for %s', name);
    if (url) {
      startMetadataTracker(uuid, url);
      // HTMX: notificar al panel "Ahora Suena" con la estación activa
      if (typeof window.htmxNowPlayingUpdate === 'function') {
        const favicon = (currentPlayingStation && currentPlayingStation.favicon) || '';
        window.htmxNowPlayingUpdate(url, name, favicon);
      }
    }
  }).catch((err) => {
    console.error('[PLAY] playback error:', err);
    if (err.name === 'NotAllowedError') {
      hideSongPopup();
      lastSongInfoTitle = null;
      const trackEl = document.getElementById('nowPlayingTrack');
      if (trackEl) trackEl.classList.add('hidden');
      display.textContent = '🎵 Pulsa Reproducir para iniciar';
      return;
    }
    display.textContent = '⚠️ Error de conexión';
  });

}

async function startMetadataTracker(uuid, stationUrl) {
  const display = document.getElementById('radioDisplay');
  const kbpsDisplay = document.getElementById('plCount');
  const trackEl = document.getElementById('nowPlayingTrack');
  const trackText = document.getElementById('nowPlayingTrackText');

  const fetchMeta = async () => {
    if (!uuid || uuid === 'undefined' || (typeof uuid === 'string' && uuid.startsWith('deep-'))) return;
    const server = await pickServer();
    if (!server) return;
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
          }, 30000);
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
          const previousTitle = trackText.textContent;
          trackText.textContent = data.title;
          trackEl.classList.remove('hidden');
          if (currentPlayingStation) {
            const station = { name: currentPlayingStation.name, favicon: currentPlayingStation.favicon || '' };
            updateMediaSession(station, data.title);
          }
          if (data.title !== previousTitle && data.title !== lastSongInfoTitle) {
            fetchSongInfo(data.title);
          }
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
  // Health filter toggle
  if (e.target.closest('#btnToggleOffline')) {
    hideOffline = !hideOffline;
    const btn = document.getElementById('btnToggleOffline');
    if (btn) {
      btn.dataset.hide = hideOffline ? '1' : '0';
      btn.className = `btn-toggle-offline${hideOffline ? ' active' : ''}`;
      btn.innerHTML = `<i class="fas fa-${hideOffline ? 'check-circle' : 'circle'}"></i> Solo verificadas`;
    }
    document.querySelectorAll('#results .station-card').forEach(card => {
      if (!hideOffline) { card.style.display = ''; return; }
      const badge = card.querySelector('.health-badge');
      const isHealthy = badge && badge.classList.contains('healthy');
      const isChecking = badge && badge.classList.contains('checking');
      card.style.display = isHealthy || isChecking ? '' : 'none';
    });
    return;
  }

  // Re-check individual station
  if (e.target.closest('.btn-recheck')) {
    const card = e.target.closest('[data-url]');
    if (!card) return;
    const url = card.dataset.url;
    if (!url) return;
    const badge = card.querySelector('.health-badge');
    if (!badge) return;
    badge.className = 'health-badge checking';
    badge.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    checkStationHealth(url).then(result => {
      updateHealthBadge(card, result);
    });
    return;
  }

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
    // Sync plCurrentIndex so playNext/playPrev work correctly from this position
    const filtered = getFilteredPlaylist();
    const clickedIdx = filtered.findIndex(s => (s.uuid || s.stationuuid) === uuid);
    if (clickedIdx >= 0) plCurrentIndex = clickedIdx;
    plShuffled = false; // Reset shuffle when manually selecting

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
  if (!station || (!station.uuid && !station.url)) return;
  if (playlist.some((s) => (s.uuid && s.uuid === station.uuid) || (s.url === station.url))) return;

  playlist.push(station);
  persistPlaylist();
  renderPlaylist();
  updateResultAddButton(station.uuid || station.url, true);
  updatePlayerFavButton();
  showToast(`❤️ "${station.name || 'Estación'}" guardada en playlist`);
  if (!station.is_sponsored) syncCuratedToServer(station);
}

function removeFromPlaylist(uuidOrUrl) {
  // Support removal by url fallback (for stations without proper uuid)
  const removed = playlist.find((s) => s.uuid === uuidOrUrl || s.url === uuidOrUrl);
  if (!removed) return;
  const realId = removed.uuid || removed.url;

  // Adjust plCurrentIndex if the removed item is before or at the current index
  if (plCurrentIndex >= 0) {
    const filtered = getFilteredPlaylist();
    const removedIdx = filtered.findIndex(s => (s.uuid || s.url) === realId);
    if (removedIdx >= 0 && removedIdx < plCurrentIndex) {
      plCurrentIndex--;
    } else if (removedIdx === plCurrentIndex) {
      plCurrentIndex = -1; // Current station removed, reset navigation
    }
  }

  playlist = playlist.filter((s) => s.uuid !== realId && s.url !== realId);
  persistPlaylist();
  renderPlaylist();
  updateResultAddButton(realId, false);
  updatePlayerFavButton();
  if (!removed.is_sponsored) removeCuratedFromServer(removed.uuid || removed.url);
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

function updatePlayerFavButton() {
  const btn = document.getElementById('btnFavPlayer');
  if (!btn) return;
  const cur = currentPlayingStation;
  if (!cur || (!cur.uuid && !cur.url)) {
    btn.classList.remove('is-fav');
    btn.title = 'Agregar a favoritos';
    btn.innerHTML = '<i class="far fa-heart"></i>';
    return;
  }
  // Match by uuid first, then by url
  const inPl = cur.uuid
    ? playlist.some(p => p.uuid === cur.uuid)
    : playlist.some(p => p.url === cur.url);
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
      // Use currentPlayingStation for reliable playing detection (DOM query fails during re-render)
      const isPlaying = currentPlayingStation && uuid && uuid === currentPlayingStation.uuid;
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
          <div class="pl-name-row">
            <button class="btn btn-play-small" title="Reproducir"><i class="fas fa-play"></i></button>
            <span class="pl-name">${escHtml(s.name || 'Sin nombre')}</span>
          </div>
          <div class="pl-meta">
            ${s.bitrate ? `<span class="badge badge-bitrate">${s.bitrate}k</span>` : ''}
            ${s.codec ? `<span class="badge badge-codec">${s.codec}</span>` : ''}
            ${s.country ? `<span class="badge badge-country">${escHtml(s.country)}</span>` : ''}
            ${s.language ? `<span class="badge badge-lang">${escHtml(s.language)}</span>` : ''}
          </div>
        </div>
        <div class="pl-actions">
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
  // Update playing highlight in playlist tab
  document.querySelectorAll('.pl-item').forEach((el) => el.classList.remove('playing'));
  const targetUuid = s.uuid || s.stationuuid;
  if (targetUuid) {
    const matching = document.querySelector(`.pl-item[data-uuid="${CSS.escape(targetUuid)}"]`);
    if (matching) matching.classList.add('playing');
  }
}

function playNext() {
  if (activeQueue === 'results' && searchResults.length > 0) {
    let idx = searchResults.findIndex(s => s.url === currentPlayingStation?.url);
    let nextIdx = idx + 1;
    if (nextIdx >= searchResults.length) nextIdx = 0;
    const nextStation = searchResults[nextIdx];
    if (nextStation) {
      play(nextStation.url, nextStation.name, nextStation.uuid);
    }
  } else {
    const filtered = getFilteredPlaylist();
    if (!filtered.length) return;
    if (plCurrentIndex < 0) { playlistPlayAll(); return; }
    plCurrentIndex++;
    if (plCurrentIndex >= filtered.length) plCurrentIndex = 0;
    const idx = plShuffled ? plShuffleOrder[plCurrentIndex] : plCurrentIndex;
    playPlItem(idx);
  }
}

function playPrev() {
  if (activeQueue === 'results' && searchResults.length > 0) {
    let idx = searchResults.findIndex(s => s.url === currentPlayingStation?.url);
    let prevIdx = idx - 1;
    if (prevIdx < 0) prevIdx = searchResults.length - 1;
    const prevStation = searchResults[prevIdx];
    if (prevStation) {
      play(prevStation.url, prevStation.name, prevStation.uuid);
    }
  } else {
    const filtered = getFilteredPlaylist();
    if (!filtered.length) return;
    if (plCurrentIndex < 0) { playlistPlayAll(); return; }
    plCurrentIndex--;
    if (plCurrentIndex < 0) plCurrentIndex = filtered.length - 1;
    const idx = plShuffled ? plShuffleOrder[plCurrentIndex] : plCurrentIndex;
    playPlItem(idx);
  }
}

function handlePlaybackError() {
  const display = document.getElementById('radioDisplay');
  if (display) display.textContent = '❌ Error al reproducir';
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
    const res = await fetch(getApiUrl('/api/version'));
    if (!res.ok) return;
    const data = await res.json();
    const serverVer = data.version;
    if (!serverVer || serverVer === APP_VERSION) return;

    const localParts = APP_VERSION.split('.').map(Number);
    const serverParts = serverVer.split('.').map(Number);

    const isNewer =
      serverParts[0] > localParts[0] ||
      (serverParts[0] === localParts[0] && serverParts[1] > localParts[1]) ||
      (serverParts[0] === localParts[0] && serverParts[1] === localParts[1] && serverParts[2] > localParts[2]);

    if (!isNewer) return;

    const dismissed = localStorage.getItem('version_dismissed');
    if (dismissed === serverVer) return;

    if (confirm(`📻 Nueva versión ${serverVer} disponible (tienes ${APP_VERSION}). ¿Actualizar ahora?`)) {
      await hardRefresh();
    } else {
      localStorage.setItem('version_dismissed', serverVer);
    }
  } catch (e) {
    console.warn('Version check failed:', e);
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

  // Start checking loop for alarm, sleep timer, and news
  if (alarmCheckerInterval) clearInterval(alarmCheckerInterval);
  alarmCheckerInterval = setInterval(() => {
    checkAlarm();
    updateSleepCountdown();
    checkNewsHour();
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

/* ── Noticias por Voz ── */
function initNewsFeature() {
  const btnToggle = document.getElementById('btnToggleNews');
  const statusDiv = document.getElementById('newsStatus');

  if (btnToggle) {
    btnToggle.textContent = newsEnabled ? 'Desactivar' : 'Activar';
    btnToggle.classList.toggle('active', newsEnabled);

    btnToggle.addEventListener('click', () => {
      newsEnabled = !newsEnabled;
      localStorage.setItem('radios_news_enabled', newsEnabled ? 'true' : 'false');
      btnToggle.textContent = newsEnabled ? 'Desactivar' : 'Activar';
      btnToggle.classList.toggle('active', newsEnabled);
      if (statusDiv) {
        statusDiv.innerHTML = newsEnabled
          ? '<span class="news-active">📰 Próximas noticias a la hora en punto.</span>'
          : '<span>Noticias desactivadas.</span>';
        statusDiv.classList.toggle('active', newsEnabled);
      }
    });
  }

  if (statusDiv) {
    if (newsEnabled) {
      statusDiv.innerHTML = '<span class="news-active">📰 Próximas noticias a la hora en punto.</span>';
      statusDiv.classList.add('active');
    }
  }
}

function checkNewsHour() {
  if (!newsEnabled) return;
  if (newsPlaying) return;
  if (!currentPlayingStation) return;
  if (!player || !player.playing) return;

  const now = new Date();
  const hour = now.getHours();
  const min = now.getMinutes();

  if (min === 0 && lastNewsHour !== hour) {
    lastNewsHour = hour;
    triggerNews();
  }
}

function duckRadio(shouldDuck) {
  if (!duckGain || !audioCtx) return;
  const now = audioCtx.currentTime;
  duckGain.gain.cancelScheduledValues(now);
  duckGain.gain.setValueAtTime(duckGain.gain.value, now);
  duckGain.gain.linearRampToValueAtTime(shouldDuck ? 0.12 : 1.0, now + 0.5);
}

async function triggerNews() {
  if (!currentPlayingStation) return;

  try {
    const res = await fetch(getApiUrl('/api/news'));
    if (!res.ok) return;
    const data = await res.json();
    const text = data.text || '';
    if (!text) return;

    newsPlaying = true;

    duckRadio(true);

    const ttsAudio = document.getElementById('ttsPlayer');
    if (!ttsAudio) {
      newsPlaying = false;
      return;
    }

    ttsAudio.src = getApiUrl('/api/tts?text=' + encodeURIComponent(text));
    ttsAudio.load();

    ttsAudio.oncanplay = () => {
      ttsAudio.play().catch(() => {
        duckRadio(false);
        newsPlaying = false;
      });
    };

    ttsAudio.onerror = () => {
      duckRadio(false);
      newsPlaying = false;
    };

    ttsAudio.onended = () => {
      duckRadio(false);
      newsPlaying = false;
      ttsAudio.src = '';
    };
  } catch (e) {
    duckRadio(false);
    newsPlaying = false;
  }
}

function isGenericOrArtifactTitle(title) {
  if (!title) return true;
  const low = String(title).toLowerCase().trim();
  return (
    low.includes('icecast streaming media server') ||
    low.includes('icecast streaming') ||
    low.includes('icecast') ||
    low.includes('shoutcast') ||
    low.includes('unspecified') ||
    low.includes('no title') ||
    low.includes('streamtitle=') ||
    low === 'radio' ||
    low === 'radios app' ||
    low.includes('sintonizando')
  );
}

/* ── Song Info Popup ── */
async function fetchSongInfo(title) {
  if (!title || isGenericOrArtifactTitle(title)) return;
  lastSongInfoTitle = title;
  try {
    const res = await fetch(getApiUrl(`/api/songinfo?title=${encodeURIComponent(title)}`));
    if (!res.ok) return;
    const data = await res.json();
    if (!data || data.error || (!data.artist && !data.genre && !data.album && !data.track)) return;
    showSongPopup(data);
  } catch {}
}

function showSongPopup(data) {
  const overlay = document.getElementById('songPopupOverlay');
  const trackEl = document.getElementById('popupTrack');
  const artistEl = document.getElementById('popupArtist');
  const detailsEl = document.getElementById('popupDetails');
  const coverWrap = document.getElementById('popupCoverWrap');
  const coverImg = document.getElementById('popupCover');
  const descEl = document.getElementById('popupDesc');
  const extrasEl = document.getElementById('popupExtras');
  const wikiLink = document.getElementById('popupWikiLink');
  if (!overlay || !trackEl || !artistEl || !detailsEl) return;

  const artist = data.artist || '';
  // Show parsed track if artist is known, otherwise show raw_title
  const track = (artist && data.track) ? data.track : (data.raw_title || data.track || '');

  trackEl.textContent = track;
  if (artist) {
    artistEl.textContent = artist;
    artistEl.classList.remove('hidden');
  } else {
    artistEl.classList.add('hidden');
  }

  /* ── Cover art: thumbnail from MB/Wiki, or radio favicon as fallback ── */
  const showCover = getInfoSetting('cover');
  const radioFavicon = currentPlayingStation?.favicon || '';
  const imgSrc = data.thumbnail || radioFavicon;
  if (showCover && imgSrc) {
    coverImg.src = imgSrc;
    coverImg.classList.toggle('is-favicon-fallback', !data.thumbnail && !!radioFavicon);
    coverImg.onerror = () => {
      // If the cover fails to load, try favicon or hide
      if (data.thumbnail && radioFavicon && coverImg.src !== radioFavicon) {
        coverImg.src = radioFavicon;
        coverImg.classList.add('is-favicon-fallback');
      } else {
        coverWrap.classList.add('hidden');
      }
    };
    coverWrap.classList.remove('hidden');
  } else {
    coverWrap.classList.add('hidden');
  }

  /* ── Description (settings-aware) ── */
  const showDesc = getInfoSetting('desc');
  if (showDesc && data.description) {
    descEl.textContent = data.description;
    descEl.classList.remove('hidden');
  } else {
    descEl.classList.add('hidden');

  }

  /* ── Details badges (genre, album, year, source) ── */
  const parts = [];
  if (data.genre) parts.push(`<span class="sp-badge"><i class="fas fa-tag"></i> ${escHtml(data.genre)}</span>`);
  if (data.album) parts.push(`<span class="sp-badge"><i class="fas fa-compact-disc"></i> ${escHtml(data.album)}</span>`);
  if (data.year) parts.push(`<span class="sp-badge"><i class="fas fa-calendar"></i> ${escHtml(data.year)}</span>`);
  if (data.source) parts.push(`<span class="sp-badge"><i class="fas fa-database"></i> ${escHtml(data.source)}</span>`);
  detailsEl.innerHTML = parts.join(' ');

  /* ── Extras rows (writer, producer, label, length) (settings-aware) ── */
  const showWriter = getInfoSetting('writer');
  const showProducer = getInfoSetting('producer');
  const showMeta = getInfoSetting('meta');
  const extraRows = [];
  if (showWriter && data.writer) {
    extraRows.push(`<div class="song-popup-extra-row"><i class="fas fa-feather"></i><span class="extra-label">Escrita por:</span><span class="extra-value">${escHtml(data.writer)}</span></div>`);
  }
  if (showProducer && data.producer) {
    extraRows.push(`<div class="song-popup-extra-row"><i class="fas fa-microphone"></i><span class="extra-label">Producida por:</span><span class="extra-value">${escHtml(data.producer)}</span></div>`);
  }
  if (showMeta) {
    if (data.label) {
      extraRows.push(`<div class="song-popup-extra-row"><i class="fas fa-tag"></i><span class="extra-label">Sello:</span><span class="extra-value">${escHtml(data.label)}</span></div>`);
    }
    if (data.length) {
      extraRows.push(`<div class="song-popup-extra-row"><i class="fas fa-clock"></i><span class="extra-label">Duración:</span><span class="extra-value">${escHtml(data.length)}</span></div>`);
    }
  }
  if (extraRows.length) {
    extrasEl.innerHTML = extraRows.join('');
    extrasEl.classList.remove('hidden');
  } else {
    extrasEl.classList.add('hidden');
  }

  /* ── Wikipedia link (settings-aware) ── */
  const showWikiLink = getInfoSetting('wikiLink');
  if (showWikiLink && data.wiki_url) {
    wikiLink.href = data.wiki_url;
    wikiLink.classList.remove('hidden');
  } else {
    wikiLink.classList.add('hidden');
  }

  /* ── Lyrics section (settings-aware, lazy-loaded on expand) ── */
  setupLyricsSection(data);

  clearTimeout(songPopupTimer);
  clearTimeout(songPopupDismissTimer);

  const addBtn = document.getElementById('popupAddBtn');
  if (addBtn) {
    addBtn.classList.remove('added');
    addBtn.onclick = () => saveSongToServerPlaylist(data);
  }

  /* ── Remove old playlist msg ── */
  const oldMsg = document.querySelector('.popup-playlist-msg');
  if (oldMsg) oldMsg.remove();

  /* ── Reset vote buttons ── */
  const voteLike = document.getElementById('popupVoteLike');
  const voteDislike = document.getElementById('popupVoteDislike');
  if (voteLike) { voteLike.classList.remove('active'); voteLike.onclick = null; }
  if (voteDislike) { voteDislike.classList.remove('active'); voteDislike.onclick = null; }

  // Check past votes
  checkSongVote(data.raw_title).then(vote => {
    if (vote === 'like' && voteLike) voteLike.classList.add('active');
    if (vote === 'dislike' && voteDislike) voteDislike.classList.add('active');
  });

  if (voteLike) {
    voteLike.onclick = () => sendSongVote('like', data);
  }
  if (voteDislike) {
    voteDislike.onclick = () => sendSongVote('dislike', data);
  }

  overlay.classList.remove('hidden');

  songPopupTimer = setTimeout(() => {
    hideSongPopup();
  }, 30000);
}

/* ── Guardar canción en playlist del servidor (desde popup 'Está Sonando') ── */
async function saveSongToServerPlaylist(data) {
  const addBtn = document.getElementById('popupAddBtn');
  const body = document.getElementById('songPopupBody');
  if (!body) return;

  let msgEl = body.querySelector('.popup-playlist-msg');
  if (!msgEl) {
    msgEl = document.createElement('div');
    msgEl.className = 'popup-playlist-msg';
    body.appendChild(msgEl);
  }

  if (addBtn) addBtn.classList.add('added');

  try {
    const res = await fetch(getApiUrl('/api/playlist/save'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        raw_title: data.raw_title,
        track: data.track,
        artist: data.artist,
        album: data.album,
        genre: data.genre,
        year: data.year,
        length: data.length,
        label: data.label,
      }),
    });
    if (!res.ok) throw new Error('Error al guardar');
    const result = await res.json();
    if (result.duplicate) {
      msgEl.innerHTML = '<i class="fas fa-check-circle"></i> Ya está en la playlist';
    } else {
      msgEl.innerHTML = `<i class="fas fa-check-circle"></i> Agregado a playlist (${result.count} temas)`;
    }
    msgEl.classList.add('visible');
    setTimeout(() => msgEl.classList.remove('visible'), 3000);
  } catch (e) {
    if (addBtn) addBtn.classList.remove('added');
    msgEl.innerHTML = '<i class="fas fa-exclamation-circle"></i> Error: ' + e.message;
    msgEl.classList.add('visible');
    setTimeout(() => msgEl.classList.remove('visible'), 3000);
  }
}

/* ── Info Panel Settings ── */
let infoActive = false;

function getInfoSetting(key) {
  const stored = localStorage.getItem('info_setting_' + key);
  if (stored === null) return true; // default all on
  return stored === 'true';
}

function setInfoSetting(key, value) {
  localStorage.setItem('info_setting_' + key, value);
}

function initInfoPanel() {
  const btnToggle = document.getElementById('btnInfoToggle');
  const panel = document.getElementById('infoPanel');
  if (!panel) return;

  function toggleInfo() {
    infoActive = !infoActive;
    panel.classList.toggle('hidden', !infoActive);
    if (btnToggle) btnToggle.classList.toggle('info-active', infoActive);
    // Close other panels
    if (infoActive && typeof eqActive !== 'undefined') {
      const eqPanel = document.getElementById('eqPanel');
      if (eqPanel && !eqPanel.classList.contains('hidden')) {
        eqActive = false;
        eqPanel.classList.add('hidden');
        const eqBtn = document.getElementById('btnEqToggle');
        if (eqBtn) eqBtn.classList.remove('eq-active');
      }
      const fxPanel = document.getElementById('effectsPanel');
      if (fxPanel && !fxPanel.classList.contains('hidden')) {
        effectsActive = false;
        fxPanel.classList.add('hidden');
        const fxBtn = document.getElementById('btnEffectsToggle');
        if (fxBtn) fxBtn.classList.remove('effects-active');
      }
    }
  }

  if (btnToggle) btnToggle.addEventListener('click', toggleInfo);

  // Wire all checkboxes to localStorage
  const toggles = {
    'infoCoverToggle': 'cover',
    'infoDescToggle': 'desc',
    'infoWriterToggle': 'writer',
    'infoProducerToggle': 'producer',
    'infoMetaToggle': 'meta',
    'infoWikiLinkToggle': 'wikiLink',
    'infoLyricsToggle': 'lyrics',
  };

  for (const [id, key] of Object.entries(toggles)) {
    const cb = document.getElementById(id);
    if (cb) {
      cb.checked = getInfoSetting(key);
      cb.addEventListener('change', () => {
        setInfoSetting(key, cb.checked);
      });
    }
  }

  // Reset all button
  const resetBtn = document.getElementById('btnInfoReset');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      for (const [id, key] of Object.entries(toggles)) {
        const cb = document.getElementById(id);
        if (cb) {
          cb.checked = true;
          setInfoSetting(key, true);
        }
      }
    });
  }
}

/* ── Song Vote (Like / Dislike) ── */
async function checkSongVote(rawTitle) {
  if (!rawTitle) return null;
  try {
    const res = await fetch(getApiUrl(`/api/feedback?raw_title=${encodeURIComponent(rawTitle)}`));
    if (!res.ok) return null;
    const data = await res.json();
    return data.vote || null;
  } catch {
    return null;
  }
}

async function sendSongVote(vote, data) {
  const voteLike = document.getElementById('popupVoteLike');
  const voteDislike = document.getElementById('popupVoteDislike');
  try {
    const res = await fetch(getApiUrl('/api/feedback'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        raw_title: data.raw_title || '',
        artist: data.artist || '',
        track: data.track || '',
        vote,
      }),
    });
    if (!res.ok) return;
    const result = await res.json();
    // Toggle visual state
    if (result.action === 'removed') {
      if (vote === 'like' && voteLike) voteLike.classList.remove('active');
      if (vote === 'dislike' && voteDislike) voteDislike.classList.remove('active');
    } else {
      if (vote === 'like') {
        if (voteLike) voteLike.classList.add('active');
        if (voteDislike) voteDislike.classList.remove('active');
      } else {
        if (voteDislike) voteDislike.classList.add('active');
        if (voteLike) voteLike.classList.remove('active');
      }
    }
  } catch {}
}

function hideSongPopup() {
  const overlay = document.getElementById('songPopupOverlay');
  if (overlay) overlay.classList.add('hidden');
  clearTimeout(songPopupTimer);
  clearTimeout(songPopupDismissTimer);
}

function initSongPopupDismiss() {
  const closeBtn = document.getElementById('popupCloseBtn');
  if (closeBtn) closeBtn.addEventListener('click', hideSongPopup);

  const overlay = document.getElementById('songPopupOverlay');
  if (overlay) overlay.addEventListener('click', (e) => {
    if (e.target === overlay) hideSongPopup();
  });
}

/* ── Lyrics (letra) section ── */
let lyricsRequestToken = 0;

function setupLyricsSection(data) {
  const wrap = document.getElementById('popupLyricsWrap');
  const toggle = document.getElementById('popupLyricsToggle');
  const body = document.getElementById('popupLyricsBody');
  const statusEl = document.getElementById('popupLyricsStatus');
  const textEl = document.getElementById('popupLyricsText');
  if (!wrap || !toggle || !body || !textEl) return;

  const showLyrics = getInfoSetting('lyrics');
  // Only makes sense when we have an artist + track parsed
  if (!showLyrics || !data.artist || !data.track) {
    wrap.classList.add('hidden');
    return;
  }

  // Reset collapsed state each time popup opens
  wrap.classList.remove('hidden');
  body.classList.add('hidden');
  toggle.classList.remove('expanded');
  textEl.textContent = '';
  statusEl.textContent = '';
  statusEl.classList.add('hidden');

  // Track which song this section is bound to (avoid stale renders)
  const myToken = ++lyricsRequestToken;
  let loaded = false;
  let loading = false;

  toggle.onclick = async () => {
    const isHidden = body.classList.contains('hidden');
    if (!isHidden) {
      // collapse
      body.classList.add('hidden');
      toggle.classList.remove('expanded');
      return;
    }
    // expand
    body.classList.remove('hidden');
    toggle.classList.add('expanded');
    // Keep popup open while reading lyrics
    clearTimeout(songPopupTimer);

    if (loaded || loading) return;
    loading = true;
    statusEl.classList.remove('hidden');
    statusEl.textContent = 'Buscando letra…';

    try {
      const params = new URLSearchParams({
        artist: data.artist || '',
        track: data.track || '',
        title: data.raw_title || '',
      });
      const res = await fetch(getApiUrl(`/api/lyrics?${params.toString()}`));
      if (myToken !== lyricsRequestToken) return; // popup changed
      const j = await res.json();
      loaded = true;
      loading = false;
      if (j && j.lyrics) {
        statusEl.classList.add('hidden');
        statusEl.textContent = '';
        textEl.textContent = j.lyrics;
      } else {
        statusEl.classList.remove('hidden');
        statusEl.textContent = 'No se encontró la letra de esta canción.';
        textEl.textContent = '';
      }
    } catch {
      if (myToken !== lyricsRequestToken) return;
      loading = false;
      statusEl.classList.remove('hidden');
      statusEl.textContent = 'No se pudo cargar la letra.';
    }
  };
}

/* ── Search Panel Overlay & Editable Dropdown ── */
function initSearchPanel() {
  const toggle = document.getElementById('btnSearchToggle');
  const panel = document.getElementById('searchPanel');
  const input = document.getElementById('searchPanelInput');
  const results = document.getElementById('searchPanelResults');
  const clear = document.getElementById('searchPanelClear');
  const deep = document.getElementById('searchPanelDeep');
  const dropdownToggle = document.getElementById('searchPanelDropdownToggle');
  const dropdownMenu = document.getElementById('searchPanelDropdown');
  const dropdownItems = dropdownMenu ? dropdownMenu.querySelectorAll('.search-dropdown-item') : [];
  if (!panel) return;

  function openPanel() {
    panel.classList.remove('hidden');
    if (input) input.focus();
    const tabRes = document.getElementById('tabResults');
    if (tabRes) tabRes.click();
  }

  function closePanel() {
    panel.classList.add('hidden');
    closeDropdown();
  }

  function togglePanel() {
    if (panel.classList.contains('hidden')) openPanel();
    else closePanel();
  }

  function openDropdown() {
    if (dropdownMenu) {
      dropdownMenu.classList.remove('hidden');
      if (dropdownToggle) dropdownToggle.classList.add('open');
      filterDropdownItems();
    }
  }

  function closeDropdown() {
    if (dropdownMenu) {
      dropdownMenu.classList.add('hidden');
      if (dropdownToggle) dropdownToggle.classList.remove('open');
    }
  }

  function toggleDropdown() {
    if (!dropdownMenu) return;
    if (dropdownMenu.classList.contains('hidden')) openDropdown();
    else closeDropdown();
  }

  function filterDropdownItems() {
    if (!input || !dropdownItems.length) return;
    const filter = input.value.trim().toLowerCase();
    dropdownItems.forEach(item => {
      const val = (item.getAttribute('data-value') || '').toLowerCase();
      if (!filter || val.includes(filter)) {
        item.style.display = 'flex';
      } else {
        item.style.display = 'none';
      }
    });
  }

  if (toggle) toggle.addEventListener('click', togglePanel);

  if (dropdownToggle) {
    dropdownToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDropdown();
    });
  }

  // Handle dropdown item click
  dropdownItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const val = item.getAttribute('data-value');
      if (val && input) {
        input.value = val;
        updateClear();
        closeDropdown();
        search(val);
      }
    });
  });

  function updateClear() {
    if (clear) clear.classList.toggle('visible', input.value.length > 0);
  }

  if (clear) {
    clear.addEventListener('click', () => {
      input.value = '';
      clear.classList.remove('visible');
      filterDropdownItems();
      // Restore playlist/favorites in the main carousel
      renderResults(playlist);
      setTimeout(initCarousel, 50);
      input.focus();
    });
  }

  if (input) {
    let deb;
    input.addEventListener('focus', () => {
      openDropdown();
    });
    input.addEventListener('click', () => {
      openDropdown();
    });
    input.addEventListener('input', () => {
      updateClear();
      filterDropdownItems();
      if (dropdownMenu && dropdownMenu.classList.contains('hidden')) {
        openDropdown();
      }
      clearTimeout(deb);
      const q = input.value.trim();
      if (q.length < 2) {
        // Restore playlist/favorites in the main carousel when query is cleared or < 2 chars
        renderResults(playlist);
        setTimeout(initCarousel, 50);
        return;
      }
      deb = setTimeout(() => {
        search(q);
      }, 400);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(deb);
        closeDropdown();
        const q = input.value.trim();
        if (q.length >= 2) { search(q); }
      } else if (e.key === 'Escape') {
        closeDropdown();
      }
    });
  }

  if (deep) deep.addEventListener('click', () => { deepSearch(); closePanel(); });

  // Close when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.isTrusted) return; // Prevent programmatic clicks from closing the panel
    if (!e.target.closest('#searchPanelInputWrap')) {
      closeDropdown();
    }
    if (panel.classList.contains('hidden')) return;
    if (!e.target.closest('#searchPanel') && !e.target.closest('#btnSearchToggle')) {
      closePanel();
    }
  });
}



/* ── Toast Notification ── */
function showToast(msg, duration = 2500) {
  let toast = document.getElementById('app-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'app-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className = 'app-toast show';
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, duration);
}

/* ── Helpers ── */
function escAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ── Pinch to Zoom & Dynamic UI Scale ── */
let currentUiScale = parseFloat(localStorage.getItem('radios_ui_scale')) || 1.0;
let zoomToastTimer = null;

function updateUiScale(scaleVal, showToast = true) {
  currentUiScale = Math.min(Math.max(scaleVal, 0.70), 1.60);
  document.documentElement.style.setProperty('--ui-scale', currentUiScale);
  localStorage.setItem('radios_ui_scale', currentUiScale.toFixed(2));

  const slider = document.getElementById('uiScaleSlider');
  const label = document.getElementById('uiScaleValue');
  if (slider) slider.value = Math.round(currentUiScale * 100);
  if (label) label.textContent = `${Math.round(currentUiScale * 100)}%`;

  if (showToast) {
    showZoomToast(currentUiScale);
  }
}

function showZoomToast(scaleVal) {
  let toast = document.getElementById('zoomToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'zoomToast';
    toast.className = 'zoom-toast';
    document.body.appendChild(toast);
  }
  const pct = Math.round(scaleVal * 100);
  toast.innerHTML = `<i class="fas fa-magnifying-glass-plus"></i> Escala UI: <strong>${pct}%</strong>`;
  toast.classList.add('show');

  clearTimeout(zoomToastTimer);
  zoomToastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, 1000);
}

function initPinchToZoom() {
  updateUiScale(currentUiScale, false);

  let pinchStartDist = 0;
  let pinchStartScale = 1.0;
  let isPinching = false;
  let lastTwoFingerTapTime = 0;
  let touchStartTime = 0;

  document.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      isPinching = true;
      touchStartTime = Date.now();
      pinchStartDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      pinchStartScale = currentUiScale;
    }
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (isPinching && e.touches.length === 2) {
      const currentDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      if (pinchStartDist > 0) {
        const ratio = currentDist / pinchStartDist;
        const newScale = pinchStartScale * ratio;
        updateUiScale(newScale, true);
        if (e.cancelable) e.preventDefault();
      }
    }
  }, { passive: false });

  document.addEventListener('touchend', (e) => {
    if (isPinching && e.touches.length < 2) {
      const duration = Date.now() - touchStartTime;
      if (duration < 300) {
        const now = Date.now();
        if (now - lastTwoFingerTapTime < 400) {
          updateUiScale(1.0, true);
          if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
        }
        lastTwoFingerTapTime = now;
      }
      isPinching = false;
      pinchStartDist = 0;
    }
  });

  const slider = document.getElementById('uiScaleSlider');
  const btnReset = document.getElementById('btnResetUiScale');
  if (slider) {
    slider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value) / 100;
      updateUiScale(val, true);
    });
  }
  if (btnReset) {
    btnReset.addEventListener('click', () => {
      updateUiScale(1.0, true);
      if (navigator.vibrate) navigator.vibrate(30);
    });
  }
}

/* ── Boot ── */
document.addEventListener('DOMContentLoaded', () => {
  init();
  initSongPopupDismiss();
  initPinchToZoom();

  // Click on now-playing minicard (#htmxNowPlaying) or track element to open song popup modal
  const popupTriggers = [
    document.getElementById('htmxNowPlaying'),
    document.getElementById('nowPlayingTrack')
  ];

  popupTriggers.forEach(el => {
    if (!el) return;
    let _pDown = false;
    el.addEventListener('pointerdown', () => {
      _pDown = true;
    });
    el.addEventListener('pointerup', (e) => {
      if (_pDown) {
        if (lastSongInfoTitle && !isGenericOrArtifactTitle(lastSongInfoTitle)) {
          fetchSongInfo(lastSongInfoTitle);
        } else {
          const titleEl = el.querySelector('.htmx-np-title');
          if (titleEl && titleEl.textContent && !isGenericOrArtifactTitle(titleEl.textContent)) {
            fetchSongInfo(titleEl.textContent.trim());
          }
        }
      }
      _pDown = false;
    });
    el.addEventListener('pointercancel', () => { _pDown = false; });
  });
});
