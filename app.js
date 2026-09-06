(() => {
  "use strict";

  const SPECTRUM_ORDER = ["sloppy", "dive", "casual", "craft", "upscale", "jacket"];
  const SPECTRUM_LABEL = {
    sloppy: "Sloppy",
    dive: "Dive",
    casual: "Casual",
    craft: "Craft",
    upscale: "Upscale",
    jacket: "Jacket",
  };
  const LEVELS = [
    { min: 0, name: "Wanderer" },
    { min: 3, name: "Night Owl" },
    { min: 8, name: "Regular" },
    { min: 15, name: "Stamp Collector" },
    { min: 25, name: "Passport Pro" },
    { min: 40, name: "ATX Legend" },
  ];
  const STAMPS_KEY = "atx-passport-stamps-v1";
  const HUNT_KEY = "atx-passport-active-hunt-v1";
  const HOP_KEY = "atx-passport-hop-v1";
  const ETH_KEY = "atx-passport-eth-v1";
  const MAP_CENTER = [30.2672, -97.7431];

  const state = {
    bars: [],
    hunts: [],
    spectrumMin: 0,
    spectrumMax: 5,
    mode: "btc", // btc | eth
    gaydar: "off", // derived from mode
    openNow: false,
    query: "",
    screen: "explore",
    stamps: loadStamps(),
    hop: loadHop(),
    activeHuntId: loadActiveHunt(),
    viewingHuntId: null,
    map: null,
    markers: new Map(),
    huntLine: null,
    mapReady: false,
    openCardId: null,
    cryptoOnly: false,
    userLoc: null, // {lat,lng,accuracy}
    maxDistanceM: 0, // 0 = any
    locBusy: false,
  };

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

  function loadStamps() {
    try {
      const raw = localStorage.getItem(STAMPS_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }
  function saveStamps() {
    localStorage.setItem(STAMPS_KEY, JSON.stringify(state.stamps));
  }
  function loadHop() {
    try {
      const raw = localStorage.getItem(HOP_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }
  function saveHop() {
    localStorage.setItem(HOP_KEY, JSON.stringify(state.hop));
  }
  function loadActiveHunt() {
    try {
      return localStorage.getItem(HUNT_KEY) || null;
    } catch {
      return null;
    }
  }
  function saveActiveHunt() {
    if (state.activeHuntId) localStorage.setItem(HUNT_KEY, state.activeHuntId);
    else localStorage.removeItem(HUNT_KEY);
  }

  function toast(msg) {
    const el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 2000);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function barById(id) {
    return state.bars.find((b) => b.id === id);
  }
  function huntById(id) {
    return state.hunts.find((h) => h.id === id);
  }
  function isStamped(id) {
    return Boolean(state.stamps[id]);
  }
  function stampCount() {
    return Object.keys(state.stamps).length;
  }
  function levelInfo() {
    const n = stampCount();
    let lvl = LEVELS[0];
    let idx = 0;
    for (let i = 0; i < LEVELS.length; i++) {
      if (n >= LEVELS[i].min) {
        lvl = LEVELS[i];
        idx = i;
      }
    }
    const next = LEVELS[idx + 1];
    const span = next ? next.min - lvl.min : 1;
    const progress = next ? Math.min(1, (n - lvl.min) / span) : 1;
    return { level: idx + 1, name: lvl.name, progress, next, count: n };
  }

  function updateXp() {
    const info = levelInfo();
    $("#xpLevel").textContent = `Lv ${info.level}`;
    $("#xpCount").textContent = `${info.count} stamp${info.count === 1 ? "" : "s"}`;
    const fill = $("#levelFill");
    const cap = $("#levelCaption");
    if (fill) fill.style.width = `${Math.round(info.progress * 100)}%`;
    if (cap) {
      cap.textContent = info.next
        ? `Level ${info.level} · ${info.name} · ${info.next.min - info.count} to ${info.next.name}`
        : `Level ${info.level} · ${info.name}`;
    }
    const sub = $("#passportSub");
    if (sub) {
      sub.textContent = info.count
        ? `${info.count} wax seal${info.count === 1 ? "" : "s"} in your book.`
        : "Collect wax seals as you hop.";
    }
  }

  function playStampBurst(label) {
    const el = $("#stampBurst");
    el.textContent = "Stamped";
    el.classList.remove("go");
    void el.offsetWidth;
    el.classList.add("go");
    clearTimeout(playStampBurst._t);
    playStampBurst._t = setTimeout(() => el.classList.remove("go"), 750);
  }

  // Geo fence for stamps — past the doors / at the bar — tighter than sidewalk
  // ~45 m ≈ inside / at the bar, not a sidewalk pass-by
  const GEO_RADIUS_M = 45;
  const GEO_RADIUS_PARTNER_M = 55; // ON BOARD: still inside-scale, slight slack
  const GEO_MAX_ACCURACY_M = 50; // reject fuzzy GPS that could fake a walk-by
  const demoGeo = new URLSearchParams(location.search).get("demo") === "1";

  function haversineM(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function getPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("Geolocation not supported on this device."));
        return;
      }
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 15000,
      });
    });
  }

  function radiusFor(bar) {
    return bar.partner ? GEO_RADIUS_PARTNER_M : GEO_RADIUS_M;
  }

  function formatDistance(m) {
    if (m < 1000) return `${Math.round(m)} m`;
    return `${(m / 1000).toFixed(1)} km`;
  }

  async function stampBar(id, { silent } = {}) {
    const bar = barById(id);
    if (!bar) return;
    if (isStamped(id)) {
      if (!silent) toast(`Already stamped · ${bar.name}`);
      return;
    }
    if (bar.lat == null || bar.lng == null) {
      if (!silent) toast("No pin on file for this stop yet.");
      return;
    }

    // Demo mode for remote testing: ?demo=1 skips the fence
    if (!demoGeo) {
      if (!silent) toast("Finding you…");
      let pos;
      try {
        pos = await getPosition();
      } catch (err) {
        const code = err && err.code;
        if (code === 1) toast("Location permission needed to stamp.");
        else if (code === 3) toast("Location timed out — try again outside.");
        else toast("Couldn't get location. Check Settings → Location.");
        return;
      }
      const { latitude, longitude, accuracy } = pos.coords;
      const acc = accuracy || 99;
      if (acc > GEO_MAX_ACCURACY_M) {
        toast(`GPS too fuzzy (${Math.round(acc)} m) — step outside / wait a sec`);
        return;
      }
      const dist = haversineM(latitude, longitude, bar.lat, bar.lng);
      const need = radiusFor(bar);
      // Tiny jitter only — not enough to stamp from the sidewalk across the street
      const effective = Math.max(0, dist - Math.min(acc, 12));
      if (effective > need) {
        toast(`Get closer · ${formatDistance(dist)} out (need inside ~${need} m)`);
        return;
      }
    }

    state.stamps[id] = Date.now();
    saveStamps();
    updateXp();
    if (!silent) {
      playStampBurst(bar.name);
      toast(demoGeo ? `Stamped · ${bar.name} (demo)` : `Stamped · ${bar.name}`);
    }
    render();
  }


  function barDistanceM(bar) {
    if (!state.userLoc || bar.lat == null || bar.lng == null) return null;
    return haversineM(state.userLoc.lat, state.userLoc.lng, bar.lat, bar.lng);
  }

  function formatMiles(m) {
    if (m == null) return "";
    if (m < 160) return `${Math.round(m)} m`;
    const mi = m / 1609.344;
    if (mi < 0.1) return `${Math.round(m)} m`;
    if (mi < 10) return `${mi.toFixed(1)} mi`;
    return `${Math.round(mi)} mi`;
  }

  function mapsUrl(bar) {
    const q = encodeURIComponent(`${bar.name}, ${bar.address}, Austin, TX`);
    return `https://maps.apple.com/?q=${q}`;
  }

  function teaserVibe(bar) {
    const raw = (bar.vibe || "").trim();
    if (!raw) return "";
    if (raw.length <= 100) return raw;
    const cut = raw.slice(0, 97);
    const sp = cut.lastIndexOf(" ");
    return (sp > 60 ? cut.slice(0, sp) : cut) + "…";
  }

  function matchesEthCircuit(bar) {
    if (state.mode !== "eth") return true;
    // ETH = gay meme mode: primary + curated adjacent (not "friendly coffee")
    return bar.gaydar === "hard" || bar.gaydar === "soft";
  }

  function austinNow() {
    try {
      return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
    } catch {
      return new Date();
    }
  }

  // Approximate hours (Austin nightlife). Marked estimated — good enough for "Open now".
  function barHours(bar) {
    // [openHour, closeHour) in local 24h; close < open means past midnight
    if (bar.id === "jos-coffee-2nd-st") return { open: 7, close: 21, kind: "day" };
    if (bar.musicAnchor) return { open: 19, close: 2, kind: "show" };
    if (bar.spectrum === "jacket") return { open: 17, close: 1, kind: "night" };
    if (bar.spectrum === "upscale") return { open: 16, close: 1, kind: "night" };
    if (bar.spectrum === "craft") return { open: 16, close: 2, kind: "night" };
    if (bar.spectrum === "casual") return { open: 15, close: 2, kind: "night" };
    // sloppy / dive
    return { open: 14, close: 2, kind: "night" };
  }

  function isLikelyOpen(bar, when = austinNow()) {
    const { open, close } = barHours(bar);
    const h = when.getHours() + when.getMinutes() / 60;
    if (close > open) return h >= open && h < close;
    // overnight window e.g. 16 → 2
    return h >= open || h < close;
  }


  function spectrumAllowed(spec) {
    const i = SPECTRUM_ORDER.indexOf(spec);
    if (i < 0) return true;
    return i >= state.spectrumMin && i <= state.spectrumMax;
  }

  function filteredBars() {
    const q = state.query.trim().toLowerCase();
    const maxM = state.maxDistanceM;
    return state.bars
      .filter((b) => spectrumAllowed(b.spectrum))
      .filter(matchesEthCircuit)
      .filter((b) => !state.openNow || isLikelyOpen(b))
      .filter((b) => !state.cryptoOnly || b.crypto)
      .filter((b) => {
        if (!maxM || !state.userLoc) return true;
        const d = barDistanceM(b);
        return d != null && d <= maxM;
      })
      .filter((b) => {
        if (!q) return true;
        return (
          b.name.toLowerCase().includes(q) ||
          b.area.toLowerCase().includes(q) ||
          b.address.toLowerCase().includes(q) ||
          b.cluster.toLowerCase().includes(q) ||
          (b.vibe || "").toLowerCase().includes(q) ||
        (b.about || "").toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        if (state.userLoc) {
          const da = barDistanceM(a);
          const db = barDistanceM(b);
          if (da != null && db != null && da !== db) return da - db;
          if (da != null && db == null) return -1;
          if (db != null && da == null) return 1;
        }
        const ca = a.crypto ? 0 : 1;
        const cb = b.crypto ? 0 : 1;
        if (ca !== cb) return ca - cb;
        const sa = SPECTRUM_ORDER.indexOf(a.spectrum);
        const sb = SPECTRUM_ORDER.indexOf(b.spectrum);
        if (sa !== sb) return sa - sb;
        return a.name.localeCompare(b.name);
      });
  }

  function huntProgress(hunt) {
    const done = hunt.stopIds.filter((id) => isStamped(id)).length;
    return { done, total: hunt.stopIds.length, pct: Math.round((done / hunt.stopIds.length) * 100) };
  }

  function updateDialUI() {
    const min = state.spectrumMin;
    const max = state.spectrumMax;
    const fill = $("#dialFill");
    if (fill) {
      const left = (min / 5) * 100;
      const right = ((5 - max) / 5) * 100;
      fill.style.left = `${left}%`;
      fill.style.right = `${right}%`;
    }
    const lo = SPECTRUM_LABEL[SPECTRUM_ORDER[min]];
    const hi = SPECTRUM_LABEL[SPECTRUM_ORDER[max]];
    $("#dialReadout").textContent = min === max ? lo : `${lo} → ${hi}`;
  }

  function renderExplore() {
    const list = $("#barList");
    const bars = filteredBars();
    const cryptoCount = state.bars.filter((b) => b.crypto).length;
    if (state.cryptoOnly) {
      $("#countMeta").textContent = `${bars.length} crypto`;
    } else if (state.mode === "eth") {
      $("#countMeta").textContent = `${bars.length} gay circuit`;
    } else {
      $("#countMeta").textContent = `${bars.length} entries · ${cryptoCount}₿`;
    }

    if (!bars.length) {
      const emptyMsg = state.maxDistanceM && state.userLoc
        ? "Nothing in that distance — try a wider radius."
        : state.mode === "eth"
          ? "No gay-circuit matches — loosen the dress dial or distance."
          : "No entries match these filters.";
      list.innerHTML = `<div class="empty-state">${emptyMsg}</div>`;
      return;
    }

    list.innerHTML = bars
      .map((b) => {
        const open = state.openCardId === b.id ? "open" : "";
        const stamped = isStamped(b.id);
        const dist = barDistanceM(b);
        const distHtml = dist != null ? `<span class="dossier-dist">${formatMiles(dist)}</span>` : "";
        return `
        <article class="dossier ${open}${b.crypto ? " crypto-featured" : ""}" data-spec="${b.spectrum}" data-id="${b.id}">
          <div class="dossier-top">
            <button type="button" data-expand="${b.id}" style="all:unset;cursor:pointer;display:block;min-width:0">
              <div class="dossier-kicker">
                <span class="spec-mark">${SPECTRUM_LABEL[b.spectrum] || b.spectrum}</span>
                ${distHtml}
                ${isLikelyOpen(b) ? `<span class="dossier-open">Open</span>` : ""}
                ${(b.flags || []).includes("coming-soon") ? `<span class="dossier-soon">Soon</span>` : ""}
                ${b.partner ? `<span class="onboard">On Board</span>` : ""}
                ${b.crypto ? `<span class="btc-seal-sm" title="${escapeHtml(b.cryptoMethods || "Crypto")}">₿</span>` : ""}
              </div>
              <h2 class="dossier-title">${escapeHtml(b.name)}</h2>
              <p class="dossier-vibe">${escapeHtml(teaserVibe(b))}</p>
            </button>
            <div class="dossier-actions">
              <button type="button" class="stamp-btn ${stamped ? "stamped" : ""}" data-stamp="${b.id}" aria-label="${stamped ? "Stamped" : "Stamp"}">
                ${stamped ? "✓" : "Stamp"}
              </button>
            </div>
          </div>
          <div class="dossier-body">
            <p class="dossier-about">${escapeHtml(b.about || b.vibe || "")}</p>
            <p class="dossier-addr">${escapeHtml(b.address)}</p>
            <p class="dossier-meta">${escapeHtml(b.area)} · ${escapeHtml(b.cluster)}${b.crypto && b.cryptoMethods ? ` · ${escapeHtml(b.cryptoMethods)}` : ""}</p>
            <div class="btn-row">
              ${b.website ? `<a class="btn" href="${escapeHtml(b.website)}" target="_blank" rel="noopener">Website</a>` : ""}
              <a class="btn" href="${mapsUrl(b)}" target="_blank" rel="noopener">Maps</a>
              <button type="button" class="btn" data-show-on-map="${b.id}">Map pin</button>
              <button type="button" class="btn primary" data-stamp="${b.id}">${stamped ? "Stamped ✓" : "Collect stamp"}</button>
            </div>
          </div>
        </article>`;
      })
      .join("");
    if (window.__atxSyncExploreChrome) window.__atxSyncExploreChrome();
  }

  function renderHunts() {
    const detail = $("#huntDetail");
    const list = $("#huntList");
    const intro = $(".section-intro", $("#screen-hunts"));

    if (state.viewingHuntId) {
      const hunt = huntById(state.viewingHuntId);
      if (!hunt) {
        state.viewingHuntId = null;
      } else {
        list.style.display = "none";
        if (intro) intro.style.display = "none";
        detail.classList.remove("hidden");
        const prog = huntProgress(hunt);
        const active = state.activeHuntId === hunt.id;
        detail.innerHTML = `
          <div class="hunt-detail-head">
            <button type="button" class="back-btn" id="huntBack" aria-label="Back">←</button>
            <div>
              <div class="mission-diff" style="color:${escapeHtml(hunt.accent || "#c4a05a")}">${escapeHtml(hunt.difficulty)} · ${prog.done}/${prog.total}</div>
              <h2>${escapeHtml(hunt.title)}</h2>
              <p class="tagline">${escapeHtml(hunt.tagline)}</p>
            </div>
          </div>
          <div class="clue-list">
            ${hunt.stopIds
              .map((id, i) => {
                const b = barById(id);
                const done = isStamped(id);
                const clue = (hunt.clues && hunt.clues[id]) || "";
                const partner = (hunt.partnerIds || []).includes(id);
                return `
                <div class="clue ${done ? "done" : ""}">
                  <div class="clue-n">${String(i + 1).padStart(2, "0")}</div>
                  <div>
                    <h3>${escapeHtml(b ? b.name : id)}${partner ? ' <span class="onboard">On Board</span>' : ""}</h3>
                    <p>${escapeHtml(clue)}</p>
                  </div>
                  <button type="button" class="mini-stamp ${done ? "stamped" : ""}" data-stamp="${id}">${done ? "Sealed" : "Stamp"}</button>
                </div>`;
              })
              .join("")}
          </div>
          <div class="hunt-detail-actions">
            <button type="button" class="btn primary" id="activateHunt">${active ? "Mission active ✓" : "Start mission"}</button>
            <button type="button" class="btn" id="showHuntMap">Show on map</button>
          </div>
          <p style="margin-top:14px;font-size:12px;color:var(--ink-dim)">Reward: <span style="color:var(--gold)">${escapeHtml(hunt.reward)}</span></p>
        `;
        return;
      }
    }

    detail.classList.add("hidden");
    list.style.display = "";
    if (intro) intro.style.display = "";
    list.innerHTML = state.hunts
      .map((h) => {
        const prog = huntProgress(h);
        const active = state.activeHuntId === h.id ? " · Active" : "";
        return `
        <article class="mission" data-open-hunt="${h.id}" style="--mission-accent:${escapeHtml(h.accent || "#c4a05a")}">
          <div class="mission-top">
            <div>
              <div class="mission-diff">${escapeHtml(h.difficulty)}${active}</div>
              <h3 class="mission-title">${escapeHtml(h.title)}</h3>
              <p class="mission-tag">${escapeHtml(h.tagline)}</p>
            </div>
            <div class="ring" style="--pct:${prog.pct}"><span>${prog.done}/${prog.total}</span></div>
          </div>
          <div class="mission-foot">
            <span>${h.stopIds.length} stops · ${(h.partnerIds || []).length} on board</span>
            <span class="reward-label">${escapeHtml(h.reward)}</span>
          </div>
        </article>`;
      })
      .join("");
  }

  function renderPassport() {
    updateXp();
    const grid = $("#stampGrid");
    const stamped = Object.keys(state.stamps)
      .map((id) => ({ id, t: state.stamps[id], bar: barById(id) }))
      .filter((x) => x.bar)
      .sort((a, b) => b.t - a.t);

    const ghosts = Math.max(6, 12 - stamped.length);
    const slots = [];

    stamped.forEach((s) => {
      slots.push(`
        <div class="stamp-slot filled ${s.bar.crypto ? "crypto" : ""}" title="${escapeHtml(s.bar.name)}">
          ${s.bar.partner ? `<span class="partner-dot" title="On Board"></span>` : ""}
          <div class="wax">${s.bar.crypto ? "₿" : "ATX"}</div>
          <div class="name">${escapeHtml(s.bar.name)}</div>
        </div>`);
    });
    for (let i = 0; i < ghosts; i++) {
      slots.push(`
        <div class="stamp-slot">
          <div class="ghost"></div>
          <div class="name">Empty page</div>
        </div>`);
    }
    grid.innerHTML = slots.join("");
  }

  function ensureMap() {
    if (state.mapReady) {
      setTimeout(() => state.map.invalidateSize(), 60);
      return;
    }
    state.map = L.map("map", { zoomControl: true, attributionControl: true }).setView(MAP_CENTER, 14);
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      { attribution: "Tiles &copy; Esri", maxZoom: 16 }
    ).addTo(state.map);
    state.mapReady = true;
    updateMapMarkers();
    setTimeout(() => state.map.invalidateSize(), 80);
  }

  function markerIcon(bar) {
    const stamped = isStamped(bar.id) ? " stamped" : "";
    const crypto = bar.crypto ? " crypto" : "";
    return L.divIcon({
      className: "",
      html: `<div class="marker-dot ${bar.spectrum}${crypto}${stamped}"></div>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7],
      popupAnchor: [0, -8],
    });
  }

  function updateMapMarkers() {
    if (!state.mapReady) return;
    const bars = filteredBars();
    const keep = new Set(bars.map((b) => b.id));

    // Always include active hunt stops
    const hunt = state.activeHuntId ? huntById(state.activeHuntId) : null;
    if (hunt) {
      hunt.stopIds.forEach((id) => {
        const b = barById(id);
        if (b) keep.add(id);
      });
    }

    for (const [id, m] of state.markers) {
      if (!keep.has(id)) {
        state.map.removeLayer(m);
        state.markers.delete(id);
      }
    }

    const showBars = state.bars.filter((b) => keep.has(b.id));
    showBars.forEach((b) => {
      const stamped = isStamped(b.id);
      if (state.markers.has(b.id)) {
        state.map.removeLayer(state.markers.get(b.id));
        state.markers.delete(b.id);
      }
      const m = L.marker([b.lat, b.lng], { icon: markerIcon(b) });
      m.bindPopup(`
        <strong>${escapeHtml(b.name)}</strong><br/>
        <span style="color:#9a9080;font-size:0.8em">${escapeHtml(SPECTRUM_LABEL[b.spectrum] || b.spectrum)} · ${escapeHtml(b.area)}</span><br/>
        ${escapeHtml(b.address)}<br/>
        ${b.partner ? '<span style="display:inline-block;margin-top:4px;font-size:9px;letter-spacing:0.1em;text-transform:uppercase;background:#8b2e1f;color:#f3ead7;padding:2px 6px;border-radius:3px">On Board</span><br/>' : ""}
        <button type="button" class="popup-stamp ${stamped ? "stamped" : ""}" onclick="window.__atxStamp('${b.id}')">
          ${stamped ? "Stamped ✓" : "Stamp here"}
        </button>
      `);
      m.addTo(state.map);
      state.markers.set(b.id, m);
    });

    drawHuntLine();
  }

  function drawHuntLine() {
    if (!state.mapReady) return;
    if (state.huntLine) {
      state.map.removeLayer(state.huntLine);
      state.huntLine = null;
    }
    const banner = $("#huntBanner");
    if (!state.activeHuntId) {
      banner.classList.add("hidden");
      return;
    }
    const hunt = huntById(state.activeHuntId);
    if (!hunt) {
      banner.classList.add("hidden");
      return;
    }
    const pts = hunt.stopIds.map((id) => barById(id)).filter(Boolean).map((b) => [b.lat, b.lng]);
    if (pts.length >= 2) {
      state.huntLine = L.polyline(pts, {
        color: hunt.accent || "#f7931a",
        weight: 3,
        opacity: 0.85,
        dashArray: "6 8",
      }).addTo(state.map);
    }
    const prog = huntProgress(hunt);
    $("#huntBannerText").textContent = `${hunt.title} · ${prog.done}/${prog.total}`;
    banner.classList.remove("hidden");
  }

  function setScreen(name) {
    state.screen = name;
    $$(".hud-btn").forEach((b) => b.classList.toggle("on", b.dataset.nav === name));
    $$(".screen").forEach((s) => s.classList.toggle("on", s.dataset.screen === name));
    if (name !== "explore") {
      document.querySelector(".app")?.classList.remove("explore-scrolled");
      const compact = $("#exploreCompact");
      if (compact) compact.hidden = true;
    }
    if (name === "map") {
      ensureMap();
      updateMapMarkers();
    }
    render();
    if (window.__atxSyncExploreChrome) window.__atxSyncExploreChrome();
  }

  function render() {
    updateXp();
    if (state.screen === "explore") renderExplore();
    else if (state.screen === "hunts") renderHunts();
    else if (state.screen === "passport") renderPassport();
    else if (state.screen === "map") updateMapMarkers();
  }

  function setMode(mode, { toastOn } = {}) {
    const next = mode === "eth" ? "eth" : "btc";
    const changing = state.mode !== next;
    state.mode = next;
    state.gaydar = next === "eth" ? "on" : "off";
    document.body.classList.toggle("gaydar-mode", next === "eth");
    const btn = $("#chainToggle");
    if (btn) {
      btn.setAttribute("aria-pressed", next === "eth" ? "true" : "false");
      btn.dataset.mode = next;
      btn.title = next === "eth" ? "ETH · the gay chain" : "BTC · orange default";
    }
    const eye = $("#modeEyebrow");
    if (eye) {
      eye.textContent = next === "eth" ? "ETH mode · Gay circuit" : "BTC mode · Night Series";
    }
    try {
      localStorage.setItem(ETH_KEY, next === "eth" ? "1" : "0");
    } catch {}
    if (toastOn && changing && next === "eth") toast("ETH unlocked — yes, the gay chain");
    if (toastOn && changing && next === "btc") toast("Back to BTC · orange pill");
  }


  function updateDistStatus(msg, { error } = {}) {
    const el = $("#distStatus");
    if (!el) return;
    if (!msg) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = msg;
    el.style.color = error ? "#c45c4e" : "";
  }

  async function locateUser({ silent } = {}) {
    if (state.locBusy) return false;
    state.locBusy = true;
    const btn = $("#locBtn");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Locating…";
    }
    if (!silent) updateDistStatus("Finding you…");
    try {
      const pos = await getPosition();
      state.userLoc = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy || null,
      };
      updateDistStatus(
        state.maxDistanceM
          ? `Near you · filtering within ${formatMiles(state.maxDistanceM)}`
          : `Near you · sorting closest first`
      );
      if (btn) btn.textContent = "Update location";
      renderExplore();
      return true;
    } catch (err) {
      const code = err && err.code;
      if (code === 1) updateDistStatus("Location permission needed for distance.", { error: true });
      else updateDistStatus("Couldn't get location.", { error: true });
      if (btn) btn.textContent = "Locate me";
      toast("Location needed for distance filter");
      return false;
    } finally {
      state.locBusy = false;
      const b = $("#locBtn");
      if (b) b.disabled = false;
    }
  }

  function bindExploreChrome() {
    const screen = $("#screen-explore");
    const controls = $("#exploreControls") || $(".explore-controls");
    const compact = $("#exploreCompact");
    if (!screen || !controls || !compact) return;

    const sync = () => {
      if (state.screen !== "explore") {
        compact.hidden = true;
        document.querySelector(".app")?.classList.remove("explore-scrolled");
        return;
      }
      const cRect = controls.getBoundingClientRect();
      const sRect = screen.getBoundingClientRect();
      // Controls have scrolled up out of the visible screen top
      const collapsed = cRect.bottom < sRect.top + 12;
      compact.hidden = !collapsed;
      document.querySelector(".app")?.classList.toggle("explore-scrolled", collapsed);
      const meta = $("#compactMeta");
      const count = $("#countMeta");
      if (meta && count) meta.textContent = count.textContent || "";
    };

    screen.addEventListener("scroll", sync, { passive: true });
    compact.addEventListener("click", () => {
      screen.scrollTo({ top: 0, behavior: "smooth" });
      // ensure chrome expands after scroll settles
      setTimeout(sync, 320);
    });

    // Re-sync after list re-renders
    const _renderExplore = typeof renderExplore === "function" ? null : null;
    window.__atxSyncExploreChrome = sync;
  }

  function bindEvents() {
    const minEl = $("#specMin");
    const maxEl = $("#specMax");
    const syncDial = (which) => {
      let min = Number(minEl.value);
      let max = Number(maxEl.value);
      if (min > max) {
        if (which === "min") max = min;
        else min = max;
        minEl.value = min;
        maxEl.value = max;
      }
      state.spectrumMin = min;
      state.spectrumMax = max;
      updateDialUI();
      render();
    };
    minEl.addEventListener("input", () => syncDial("min"));
    maxEl.addEventListener("input", () => syncDial("max"));
    updateDialUI();


    const distChips = $("#distChips");
    if (distChips) {
      distChips.addEventListener("click", async (e) => {
        const chip = e.target.closest(".dist-chip");
        if (!chip) return;
        const m = Number(chip.dataset.m || 0);
        state.maxDistanceM = m;
        $$(".dist-chip").forEach((c) => c.classList.toggle("on", c === chip));
        if (m > 0 && !state.userLoc) {
          const ok = await locateUser();
          if (!ok) return;
        } else if (state.userLoc) {
          updateDistStatus(
            m
              ? `Near you · filtering within ${formatMiles(m)}`
              : `Near you · sorting closest first`
          );
        } else if (m === 0) {
          updateDistStatus("");
        }
        renderExplore();
      });
    }
    const locBtn = $("#locBtn");
    if (locBtn) {
      locBtn.addEventListener("click", () => locateUser());
    }

    $("#cryptoFilter").addEventListener("click", () => {
      state.cryptoOnly = !state.cryptoOnly;
      $("#cryptoFilter").classList.toggle("on", state.cryptoOnly);
      $("#cryptoFilter").setAttribute("aria-pressed", state.cryptoOnly ? "true" : "false");
      render();
    });

    $("#search").addEventListener("input", (e) => {
      state.query = e.target.value;
      render();
    });

    $$(".hud-btn").forEach((btn) => {
      btn.addEventListener("click", () => setScreen(btn.dataset.nav));
    });

    const chain = $("#chainToggle");
    if (chain) {
      chain.addEventListener("click", () => {
        setMode(state.mode === "eth" ? "btc" : "eth", { toastOn: true });
        render();
      });
    }
    const openBtn = $("#openNowFilter");
    if (openBtn) {
      openBtn.addEventListener("click", () => {
        state.openNow = !state.openNow;
        openBtn.classList.toggle("on", state.openNow);
        openBtn.setAttribute("aria-pressed", state.openNow ? "true" : "false");
        renderExplore();
      });
    }

    $("#clearHuntMap").addEventListener("click", () => {
      state.activeHuntId = null;
      saveActiveHunt();
      drawHuntLine();
      render();
    });

    document.addEventListener("click", (e) => {
      const expand = e.target.closest("[data-expand]");
      if (expand) {
        const id = expand.dataset.expand;
        state.openCardId = state.openCardId === id ? null : id;
        renderExplore();
        return;
      }

      const stamp = e.target.closest("[data-stamp]");
      if (stamp) {
        e.stopPropagation();
        stamp.disabled = true;
        Promise.resolve(stampBar(stamp.dataset.stamp)).finally(() => {
          stamp.disabled = false;
        });
        return;
      }

      const showMap = e.target.closest("[data-show-on-map]");
      if (showMap) {
        const id = showMap.dataset.showOnMap;
        const b = barById(id);
        setScreen("map");
        ensureMap();
        if (b) {
          state.map.setView([b.lat, b.lng], 16);
          const m = state.markers.get(id);
          if (m) m.openPopup();
        }
        return;
      }

      const openHunt = e.target.closest("[data-open-hunt]");
      if (openHunt) {
        state.viewingHuntId = openHunt.dataset.openHunt;
        renderHunts();
        return;
      }

      if (e.target.id === "huntBack") {
        state.viewingHuntId = null;
        renderHunts();
        return;
      }

      if (e.target.id === "activateHunt") {
        const id = state.viewingHuntId;
        if (!id) return;
        state.activeHuntId = state.activeHuntId === id ? null : id;
        saveActiveHunt();
        toast(state.activeHuntId ? "Mission active" : "Mission cleared");
        renderHunts();
        return;
      }

      if (e.target.id === "showHuntMap") {
        if (state.viewingHuntId) {
          state.activeHuntId = state.viewingHuntId;
          saveActiveHunt();
        }
        setScreen("map");
        ensureMap();
        const hunt = huntById(state.activeHuntId);
        if (hunt && state.huntLine) {
          state.map.fitBounds(state.huntLine.getBounds(), { padding: [40, 40] });
        } else if (hunt) {
          drawHuntLine();
          if (state.huntLine) state.map.fitBounds(state.huntLine.getBounds(), { padding: [40, 40] });
        }
        return;
      }
    });

    window.__atxStamp = (id) => { stampBar(id); };
  }

  async function init() {
    const [bars, hunts] = await Promise.all([
      fetch("data/bars.json").then((r) => r.json()),
      fetch("data/hunts.json").then((r) => r.json()),
    ]);
    state.bars = bars;
    state.hunts = hunts;

    let ethOn = false;
    try {
      ethOn = localStorage.getItem(ETH_KEY) === "1";
    } catch {}
    if (new URLSearchParams(location.search).get("eth") === "1") ethOn = true;
    setMode(ethOn ? "eth" : "btc");

    bindEvents();
    bindExploreChrome();
    updateXp();
    const screenParam = new URLSearchParams(location.search).get("screen");
    if (screenParam && ["explore", "hunts", "passport", "map"].includes(screenParam)) {
      setScreen(screenParam);
    } else {
      renderExplore();
    }

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }

    if (demoGeo) {
      toast("Demo mode · geo fence off");
      const hint = document.querySelector(".eyebrow");
      if (hint) hint.textContent = "Austin · Night Series · Demo geo";
    }
  }

  init().catch((err) => {
    console.error(err);
    $("#barList").innerHTML = `<div class="empty-state">Failed to load passport data.</div>`;
  });
})();
