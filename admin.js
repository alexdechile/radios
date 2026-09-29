(() => {
  "use strict";

  function getApiUrl(path) {
    const prefix = window.location.pathname.startsWith('/radios') ? '/radios' : '';
    const cleanPath = path.startsWith('/') ? path : '/' + path;
    return prefix + cleanPath;
  }

  const API = getApiUrl('/api/curated');
  const RADIO_BROWSER = "https://de1.api.radio-browser.info/json";

  let stations = [];
  let filtered = [];
  let previewUuid = null;

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  const ADMIN_TOKEN_KEY = "radios_admin_token";
  const TOKEN_REQUIRED = { value: false };

  function getAdminToken() {
    return sessionStorage.getItem(ADMIN_TOKEN_KEY) || "";
  }

  function setAdminToken(token) {
    if (token) sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
    else sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  }

  function adminFetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    const token = getAdminToken();
    if (token) headers.set("X-Admin-Token", token);
    return fetch(url, {
      ...options,
      headers,
      credentials: "same-origin",
    });
  }

  async function adminAuthCheck() {
    try {
      const res = await adminFetch(getApiUrl("/api/admin/check"));
      return res.ok;
    } catch (_) {
      return false;
    }
  }

  // ── Init ──
  document.addEventListener("DOMContentLoaded", async () => {
    loadStations();
    bindTabs();
    bindLocalFilter();
    bindPreview();
    bindModal();
    bindDiscovery();
    await initAdminAuth();
  });

  // ── Admin token login ──
  async function initAdminAuth() {
    const overlay = $("#adminLoginOverlay");
    const form = $("#adminLoginForm");
    const input = $("#adminTokenInput");
    const error = $("#adminLoginError");
    const logout = $("#btnAdminLogout");
    if (!overlay || !form || !input) return;

    let status = {};
    try {
      const res = await fetch(getApiUrl("/api/admin/status"), { credentials: "same-origin" });
      if (res.ok) status = await res.json();
    } catch (_) {}

    TOKEN_REQUIRED.value = !!status.token_required;
    if (!TOKEN_REQUIRED.value) {
      if (logout) logout.style.display = "none";
      overlay.classList.remove("open");
      return;
    }

    if (logout) {
      logout.style.display = "inline-flex";
      logout.addEventListener("click", () => {
        setAdminToken("");
        overlay.classList.add("open");
        input.value = "";
        if (error) error.textContent = "";
      });
    }

    if (getAdminToken() && await adminAuthCheck()) {
      overlay.classList.remove("open");
      return;
    }
    setAdminToken("");
    overlay.classList.add("open");
    input.focus();

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const token = input.value.trim();
      if (!token) {
        if (error) error.textContent = "Ingresa un token.";
        return;
      }
      setAdminToken(token);
      if (await adminAuthCheck()) {
        if (error) error.textContent = "";
        input.value = "";
        overlay.classList.remove("open");
        loadStations();
      } else {
        setAdminToken("");
        if (error) error.textContent = "Token inválido.";
      }
    });
  }

  // ── Tabs ──
  function bindTabs() {
    $$(".admin-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        $$(".admin-tab").forEach((t) => t.classList.remove("active"));
        $$(".tab-panel").forEach((p) => p.classList.remove("active"));
        tab.classList.add("active");
        $(`#panel-${tab.dataset.tab}`).classList.add("active");
      });
    });
  }

  // ── Load curated stations ──
  async function loadStations() {
    try {
      const res = await adminFetch(API);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      stations = await res.json();
      filtered = [...stations];
      renderStats();
      renderGrid();
    } catch (e) {
      $("#stationGrid").innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>Error cargando estaciones: ${e.message}</p></div>`;
    }
  }

  // ── Stats bar ──
  function renderStats() {
    const total = stations.length;
    const featured = stations.filter((s) => s.is_featured).length;
    const countries = [...new Set(stations.map((s) => s.country).filter(Boolean))].length;
    const withNotes = stations.filter((s) => s.editorial_notes && s.editorial_notes.trim()).length;
    $("#statsBar").innerHTML = `
      <div class="stat-chip"><i class="fas fa-radio"></i> <span class="num">${total}</span> curadas</div>
      <div class="stat-chip"><i class="fas fa-star"></i> <span class="num">${featured}</span> destacadas</div>
      <div class="stat-chip"><i class="fas fa-globe"></i> <span class="num">${countries}</span> países</div>
      <div class="stat-chip"><i class="fas fa-pen"></i> <span class="num">${withNotes}</span> con editorial</div>
    `;
  }

  // ── Local filter ──
  function bindLocalFilter() {
    $("#localFilter").addEventListener("input", (e) => {
      const q = e.target.value.toLowerCase().trim();
      if (!q) {
        filtered = [...stations];
      } else {
        filtered = stations.filter(
          (s) =>
            (s.name || "").toLowerCase().includes(q) ||
            (s.voice_name || "").toLowerCase().includes(q) ||
            (s.country || "").toLowerCase().includes(q) ||
            (s.tags || "").toLowerCase().includes(q) ||
            (s.editorial_notes || "").toLowerCase().includes(q)
        );
      }
      renderGrid();
    });
  }

  // ── Render grid ──
  function renderGrid() {
    if (!filtered.length) {
      $("#stationGrid").innerHTML = `<div class="empty-state"><i class="fas fa-inbox"></i><p>No se encontraron estaciones</p></div>`;
      return;
    }

    $("#stationGrid").innerHTML = filtered
      .map((s, i) => {
        const pos = s.position || i;
        const favicon = s.favicon
          ? `<img class="station-favicon" src="${esc(s.favicon)}" alt="" onerror="this.outerHTML='<div class=\\'station-favicon-placeholder\\'><i class=\\'fas fa-radio\\'></i></div>'">`
          : `<div class="station-favicon-placeholder"><i class="fas fa-radio"></i></div>`;

        const tags = (s.tags || "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
          .slice(0, 4)
          .map((t) => `<span class="tag">${esc(t)}</span>`)
          .join("");

        const featuredTag = s.is_featured ? `<span class="tag featured"><i class="fas fa-star"></i> Destacada</span>` : "";

        const editorial = s.editorial_notes
          ? `<div class="station-editorial">"${esc(s.editorial_notes)}"</div>`
          : "";
        const voiceAlias = s.voice_name
          ? `<div class="station-voice-alias"><i class="fas fa-microphone-lines"></i> ${esc(s.voice_name)}</div>`
          : "";

        const playing = previewUuid === s.uuid ? "playing" : "";
        const playIcon = previewUuid === s.uuid ? "fa-stop" : "fa-play";

        return `
        <div class="station-card" data-uuid="${esc(s.uuid)}">
          <div class="position-badge">
            <span>#${pos}</span>
            <button class="btn-pos btn-move-up" data-uuid="${esc(s.uuid)}" title="Subir posición (aparece antes en la app)"><i class="fas fa-chevron-up"></i></button>
            <button class="btn-pos btn-move-down" data-uuid="${esc(s.uuid)}" title="Bajar posición (aparece después en la app)"><i class="fas fa-chevron-down"></i></button>
          </div>
          <div class="station-card-top">
            ${favicon}
            <div class="station-info">
              <div class="station-name" title="${esc(s.name)}">${esc(s.name)}</div>
              <div class="station-meta">
                <span><i class="fas fa-globe"></i> ${esc(s.country || "—")}</span>
                <span><i class="fas fa-signal"></i> ${esc(s.bitrate || "?")} ${esc(s.codec || "")}</span>
              </div>
            </div>
          </div>
          <div class="station-tags">${featuredTag}${tags}</div>
          ${voiceAlias}
          ${editorial}
          <div class="station-actions">
            <button class="btn-action ${playing}" data-action="preview" data-uuid="${esc(s.uuid)}" data-url="${esc(s.url)}" data-name="${esc(s.name)}">
              <i class="fas ${playIcon}"></i> ${previewUuid === s.uuid ? "Detener" : "Probar"}
            </button>
            <button class="btn-action" data-action="edit" data-uuid="${esc(s.uuid)}">
              <i class="fas fa-pen"></i> Editar
            </button>
            <button class="btn-action danger" data-action="delete" data-uuid="${esc(s.uuid)}" data-name="${esc(s.name)}">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        </div>`;
      })
      .join("");

    // Bind card actions
    $$("#stationGrid .btn-action").forEach((btn) => {
      btn.addEventListener("click", handleCardAction);
    });

    // Bind position change buttons
    $$("#stationGrid .btn-move-up").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        movePosition(btn.dataset.uuid, -1);
      });
    });
    $$("#stationGrid .btn-move-down").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        movePosition(btn.dataset.uuid, 1);
      });
    });
  }

  // ── Reorder positions ──
  async function movePosition(uuid, direction) {
    // stations is sorted by position ASC
    const idx = stations.findIndex((s) => s.uuid === uuid);
    if (idx < 0) return;
    const targetIdx = idx + direction;
    if (targetIdx < 0 || targetIdx >= stations.length) return;

    // Swap stations in array
    const temp = stations[idx];
    stations[idx] = stations[targetIdx];
    stations[targetIdx] = temp;

    // Recalculate 1-based sequential positions
    const orders = stations.map((s, i) => {
      s.position = i + 1;
      return { uuid: s.uuid, position: i + 1 };
    });

    // Optimistic UI update
    filtered = [...stations];
    renderGrid();

    try {
      const res = await adminFetch(getApiUrl("/api/curated/reorder"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orders }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadStations();
    } catch (e) {
      alert(`Error al reordenar: ${e.message}`);
      await loadStations();
    }
  }

  // ── Card actions ──
  function handleCardAction(e) {
    const btn = e.currentTarget;
    const action = btn.dataset.action;
    const uuid = btn.dataset.uuid;

    if (action === "preview") {
      togglePreview(uuid, btn.dataset.url, btn.dataset.name);
    } else if (action === "edit") {
      openEditModal(uuid);
    } else if (action === "delete") {
      if (confirm(`¿Eliminar "${btn.dataset.name}" de la lista curada?`)) {
        deleteStation(uuid);
      }
    }
  }

  // ── Audio preview ──
  function bindPreview() {
    const audio = $("#previewAudio");
    audio.addEventListener("error", () => {
      showPreviewBar(previewUuid, "Error de conexión");
    });
    audio.addEventListener("playing", () => {
      showPreviewBar(previewUuid, "Transmitiendo...");
    });
    $("#btnPreviewStop").addEventListener("click", stopPreview);
  }

  function togglePreview(uuid, url, name) {
    const audio = $("#previewAudio");
    if (previewUuid === uuid) {
      stopPreview();
    } else {
      stopPreview();
      previewUuid = uuid;
      audio.src = getApiUrl(`/proxy?url=${encodeURIComponent(url)}`);
      audio.play().catch(() => {});
      showPreviewBar(uuid, name);
      renderGrid();
    }
  }

  function stopPreview() {
    const audio = $("#previewAudio");
    audio.pause();
    audio.removeAttribute("src");
    previewUuid = null;
    $("#previewBar").classList.remove("visible");
    renderGrid();
  }

  function showPreviewBar(uuid, name) {
    const bar = $("#previewBar");
    $("#previewName").textContent = name;
    bar.classList.add("visible");
  }

  // ── Delete ──
  async function deleteStation(uuid) {
    try {
      const res = await adminFetch(`${API}?uuid=${encodeURIComponent(uuid)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (previewUuid === uuid) stopPreview();
      await loadStations();
    } catch (e) {
      alert(`Error eliminando: ${e.message}`);
    }
  }

  // ── Edit Modal ──
  function bindModal() {
    $("#btnModalClose").addEventListener("click", closeModal);
    $("#btnModalCancel").addEventListener("click", closeModal);
    $("#modalOverlay").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeModal();
    });

    $("#editFeaturedToggle").addEventListener("click", () => {
      const toggle = $("#editFeaturedToggle");
      toggle.classList.toggle("active");
      $("#editFeaturedLabel").textContent = toggle.classList.contains("active") ? "Sí" : "No";
    });

    $("#btnModalSave").addEventListener("click", saveStation);
  }

  function openEditModal(uuid) {
    const s = stations.find((st) => st.uuid === uuid);
    if (!s) return;

    $("#modalTitle").textContent = "Editar Estación";
    $("#editUuid").value = s.uuid;
    $("#editName").value = s.name || "";
    $("#editVoiceName").value = s.voice_name || "";
    $("#editUrl").value = s.url || "";
    $("#editCountry").value = s.country || "";
    $("#editTags").value = s.tags || "";
    $("#editFavicon").value = s.favicon || "";
    $("#editPosition").value = s.position || 0;
    $("#editBitrate").value = s.bitrate || "";
    $("#editCodec").value = s.codec || "";
    $("#editHomepage").value = s.homepage || "";
    $("#editLanguage").value = s.language || "";
    $("#editEditorialNotes").value = s.editorial_notes || "";

    const toggle = $("#editFeaturedToggle");
    if (s.is_featured) {
      toggle.classList.add("active");
      $("#editFeaturedLabel").textContent = "Sí";
    } else {
      toggle.classList.remove("active");
      $("#editFeaturedLabel").textContent = "No";
    }

    $("#modalOverlay").classList.add("open");
  }

  function openCreateModal(data) {
    $("#modalTitle").textContent = "Añadir a Curadas";
    const stUuid = data.uuid || data.stationuuid || (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : "gen-" + Date.now());
    $("#editUuid").value = stUuid;
    $("#editName").value = data.name || "";
    $("#editVoiceName").value = data.voice_name || "";
    $("#editUrl").value = data.url_resolved || data.url || "";
    $("#editCountry").value = data.country || "";
    $("#editTags").value = data.tags || "";
    $("#editFavicon").value = data.favicon || "";
    $("#editPosition").value = stations.length;
    $("#editBitrate").value = data.bitrate || "";
    $("#editCodec").value = data.codec || "";
    $("#editHomepage").value = data.homepage || "";
    $("#editLanguage").value = data.language || "";
    $("#editEditorialNotes").value = "";

    const toggle = $("#editFeaturedToggle");
    toggle.classList.remove("active");
    $("#editFeaturedLabel").textContent = "No";

    $("#modalOverlay").classList.add("open");
  }

  function closeModal() {
    $("#modalOverlay").classList.remove("open");
  }

  async function saveStation() {
    const uuid = $("#editUuid").value;
    const payload = {
      uuid,
      name: $("#editName").value,
      voice_name: $("#editVoiceName").value.trim(),
      url: $("#editUrl").value,
      country: $("#editCountry").value,
      tags: $("#editTags").value,
      favicon: $("#editFavicon").value,
      position: parseInt($("#editPosition").value) || 0,
      bitrate: $("#editBitrate").value,
      codec: $("#editCodec").value,
      homepage: $("#editHomepage").value,
      language: $("#editLanguage").value,
      editorial_notes: $("#editEditorialNotes").value,
      is_featured: $("#editFeaturedToggle").classList.contains("active") ? 1 : 0,
    };

    const existing = stations.find((s) => s.uuid === uuid);
    const endpoint = existing ? `${API}/update` : API;
    const method = existing ? "POST" : "POST";

    try {
      const res = await adminFetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        let errDetail = `HTTP ${res.status}`;
        try {
          const errData = await res.json();
          if (errData && errData.error) errDetail += `: ${errData.error}`;
        } catch (_) {}
        throw new Error(errDetail);
      }
      closeModal();
      await loadStations();
    } catch (e) {
      alert(`Error guardando: ${e.message}`);
    }
  }

  // ── Discovery ──
  function bindDiscovery() {
    const input = $("#discoveryInput");
    const btn = $("#btnDiscoverySearch");

    btn.addEventListener("click", () => searchDiscovery(input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") searchDiscovery(input.value);
    });
  }

  async function searchDiscovery(query) {
    if (!query.trim()) return;

    const results = $("#discoveryResults");
    results.innerHTML = `<div class="loading"><i class="fas fa-spinner"></i><p>Buscando en Radio Browser...</p></div>`;

    try {
      const res = await fetch(
        `${RADIO_BROWSER}/stations/search?name=${encodeURIComponent(query)}&limit=20&order=votes&reverse=true`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (!data.length) {
        results.innerHTML = `<div class="empty-state"><i class="fas fa-search"></i><p>No se encontraron resultados para "${esc(query)}"</p></div>`;
        return;
      }

      results.innerHTML = data
        .map(
          (s) => `
        <div class="discovery-card">
          <div class="station-favicon-placeholder" style="width:48px;height:48px;font-size:1.2rem">
            ${s.favicon ? `<img src="${esc(s.favicon)}" style="width:48px;height:48px;border-radius:8px;object-fit:cover" onerror="this.outerHTML='<i class=\\'fas fa-radio\\'></i>'">` : '<i class="fas fa-radio"></i>'}
          </div>
          <div class="discovery-card-info">
            <div class="station-name">${esc(s.name)}</div>
            <div class="station-meta">
              <span><i class="fas fa-globe"></i> ${esc(s.country || "—")}</span>
              <span><i class="fas fa-signal"></i> ${esc(s.bitrate || "?")} ${esc(s.codec || "")}</span>
              <span><i class="fas fa-tags"></i> ${esc((s.tags || "").split(",").slice(0, 3).join(", "))}</span>
            </div>
          </div>
          <button class="btn-add" data-station='${JSON.stringify(s).replace(/'/g, "&#39;")}'>
            <i class="fas fa-plus"></i> Añadir
          </button>
        </div>`
        )
        .join("");

      $$(".btn-add").forEach((btn) => {
        btn.addEventListener("click", () => {
          const data = JSON.parse(btn.dataset.station);
          openCreateModal(data);
        });
      });
    } catch (e) {
      results.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>Error: ${e.message}</p></div>`;
    }
  }

  // ── Helpers ──
  function esc(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  }
})();
