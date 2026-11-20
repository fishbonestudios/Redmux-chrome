(function () {
  "use strict";

  const HOST_ORIGINS = [
    "https://*.reddit.com/*",
    "https://v.redd.it/*",
    "https://redd.it/*"
  ];

  const el = {
    permBanner: document.getElementById("permBanner"),
    grantPermBtn: document.getElementById("grantPermBtn"),
    settingsToggle: document.getElementById("settingsToggle"),
    mainView: document.getElementById("mainView"),
    settingsView: document.getElementById("settingsView"),
    urlInput: document.getElementById("urlInput"),
    analyzeBtn: document.getElementById("analyzeBtn"),
    pageVideoPicker: document.getElementById("pageVideoPicker"),
    pageVideoSelect: document.getElementById("pageVideoSelect"),
    videoCard: document.getElementById("videoCard"),
    subBadge: document.getElementById("subBadge"),
    audioBadge: document.getElementById("audioBadge"),
    videoTitle: document.getElementById("videoTitle"),
    qualitySelect: document.getElementById("qualitySelect"),
    includeAudioCheck: document.getElementById("includeAudioCheck"),
    downloadBtn: document.getElementById("downloadBtn"),
    progressWrap: document.getElementById("progressWrap"),
    progressBar: document.getElementById("progressBar"),
    progressText: document.getElementById("progressText"),
    statusBox: document.getElementById("statusBox"),
    prefQuality: document.getElementById("prefQuality"),
    prefFilename: document.getElementById("prefFilename"),
    prefInject: document.getElementById("prefInject"),
    prefSaveAs: document.getElementById("prefSaveAs"),
    saveSettingsBtn: document.getElementById("saveSettingsBtn")
  };

  let currentResolved = null;
  let pageHints = [];
  let activeJobId = null;
  let activeTabId = null;

  function showStatus(msg, type = "info") {
    el.statusBox.textContent = msg;
    el.statusBox.className = `status-box ${type}`;
    el.statusBox.classList.remove("hidden");
  }

  function hideStatus() {
    el.statusBox.classList.add("hidden");
  }

  async function checkPermissions() {
    try {
      const granted = await chrome.permissions.contains({ origins: HOST_ORIGINS });
      el.permBanner.classList.toggle("hidden", granted);
      return granted;
    } catch {
      return true;
    }
  }

  el.grantPermBtn.addEventListener("click", async () => {
    try {
      const ok = await chrome.permissions.request({ origins: HOST_ORIGINS });
      if (ok) {
        el.permBanner.classList.add("hidden");
        initActiveTab();
      }
    } catch (err) {
      showStatus(err.message || "Could not grant permissions.", "error");
    }
  });

  function renderResolvedVideo(data) {
    currentResolved = data;
    hideStatus();
    el.videoCard.classList.remove("hidden");

    el.subBadge.textContent = data.subreddit ? `r/${data.subreddit}` : "v.redd.it";
    el.videoTitle.textContent = data.title || `Reddit Video (${data.videoId})`;

    if (data.hasAudio) {
      const bestAudio = data.audios[0];
      el.audioBadge.textContent = `Audio ${bestAudio?.label || "Ready"}`;
      el.audioBadge.className = "badge badge-audio";
      el.includeAudioCheck.disabled = false;
      el.includeAudioCheck.checked = true;
    } else {
      el.audioBadge.textContent = "No audio track";
      el.audioBadge.className = "badge badge-muted";
      el.includeAudioCheck.checked = false;
      el.includeAudioCheck.disabled = true;
    }

    el.qualitySelect.textContent = "";
    for (const v of data.videos) {
      const opt = document.createElement("option");
      opt.value = v.url;
      const kbps = v.bandwidth ? ` • ${Math.round(v.bandwidth / 1000)} kbps` : "";
      opt.textContent = `${v.label}${kbps}`;
      el.qualitySelect.appendChild(opt);
    }

    el.progressWrap.classList.add("hidden");
    el.progressBar.style.width = "0%";
  }

  async function loadHintOrUrl(hint) {
    el.analyzeBtn.disabled = true;
    el.videoCard.classList.add("hidden");
    showStatus("Inspecting Reddit video streams...");

    try {
      const res = await chrome.runtime.sendMessage({
        type: "RESOLVE_VIDEO",
        hint
      });
      if (!res || !res.ok) {
        throw new Error(res?.error || "Could not find a Reddit video.");
      }
      renderResolvedVideo(res.data);
    } catch (err) {
      showStatus(err.message || "Failed to load video.", "error");
    } finally {
      el.analyzeBtn.disabled = false;
    }
  }

  el.analyzeBtn.addEventListener("click", () => {
    const url = el.urlInput.value.trim();
    if (!url) {
      showStatus("Paste a Reddit post URL first.", "error");
      return;
    }
    loadHintOrUrl({ url });
  });

  el.urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") el.analyzeBtn.click();
  });

  el.pageVideoSelect.addEventListener("change", () => {
    const idx = parseInt(el.pageVideoSelect.value, 10);
    const chosen = pageHints[idx];
    if (chosen) {
      el.urlInput.value = chosen.permalink || chosen.url || "";
      loadHintOrUrl(chosen);
    }
  });

  el.downloadBtn.addEventListener("click", async () => {
    if (!currentResolved) return;
    activeJobId = `popup_${Date.now()}`;
    el.downloadBtn.disabled = true;
    el.progressWrap.classList.remove("hidden");
    el.progressBar.style.width = "8%";
    el.progressText.textContent = "Starting download...";
    hideStatus();

    const selectedVideoUrl = el.qualitySelect.value;
    const includeAudio = el.includeAudioCheck.checked && currentResolved.hasAudio;

    try {
      const res = await chrome.runtime.sendMessage({
        type: "DOWNLOAD_VIDEO",
        hint: {
          videoId: currentResolved.videoId,
          mpdUrl: currentResolved.mpdUrl,
          fallbackUrl: currentResolved.fallbackUrl,
          title: currentResolved.title,
          subreddit: currentResolved.subreddit,
          postId: currentResolved.postId,
          permalink: currentResolved.permalink
        },
        videoUrl: selectedVideoUrl,
        includeAudio,
        tabId: activeTabId,
        jobId: activeJobId
      });

      if (!res || !res.ok) {
        throw new Error(res?.error || "Download failed.");
      }

      el.progressBar.style.width = "100%";
      el.progressText.textContent = res.combinedAudio
        ? `Done! Saved ${res.filename}`
        : `Done (no audio track): ${res.filename}`;
      showStatus(`Saved: ${res.filename}`, "success");
    } catch (err) {
      el.progressWrap.classList.add("hidden");
      showStatus(err.message || "Download failed.", "error");
    } finally {
      el.downloadBtn.disabled = false;
    }
  });

  // Live progress listener
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "DOWNLOAD_PROGRESS") return false;
    if (activeJobId && msg.jobId !== activeJobId) return false;
    el.progressWrap.classList.remove("hidden");
    if (typeof msg.percent === "number") {
      el.progressBar.style.width = `${msg.percent}%`;
    }
    if (msg.text) {
      el.progressText.textContent = msg.text;
    }
    return false;
  });

  // Settings drawer
  el.settingsToggle.addEventListener("click", () => {
    const showingSettings = !el.settingsView.classList.contains("hidden");
    el.settingsView.classList.toggle("hidden", showingSettings);
    el.mainView.classList.toggle("hidden", !showingSettings);
  });

  async function loadSettingsUI() {
    const res = await chrome.runtime.sendMessage({ type: "GET_SETTINGS" }).catch(() => null);
    const s = res?.settings;
    if (!s) return;
    el.prefQuality.value = s.preferredQuality || "best";
    el.prefFilename.value = s.filenamePattern || "subreddit_title";
    el.prefInject.checked = s.injectButtons !== false;
    el.prefSaveAs.checked = Boolean(s.saveAs);
  }

  el.saveSettingsBtn.addEventListener("click", async () => {
    const updated = {
      preferredQuality: el.prefQuality.value,
      filenamePattern: el.prefFilename.value,
      injectButtons: el.prefInject.checked,
      saveAs: el.prefSaveAs.checked
    };
    const res = await chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings: updated });
    if (activeTabId && res?.settings) {
      chrome.tabs
        .sendMessage(activeTabId, { type: "SETTINGS_UPDATED", settings: res.settings })
        .catch(() => {});
    }
    el.settingsView.classList.add("hidden");
    el.mainView.classList.remove("hidden");
    showStatus("Preferences saved.", "success");
  });

  async function initActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab) return;
    activeTabId = tab.id;

    const url = tab.url || "";
    const isReddit = /^https?:\/\/([a-z0-9-]+\.)?(reddit\.com|redd\.it)\//i.test(url);
    if (!isReddit) {
      showStatus("Open a Reddit video post or paste any Reddit URL above.");
      return;
    }

    el.urlInput.value = url;

    const pageResp = await chrome.tabs
      .sendMessage(tab.id, { type: "GET_PAGE_VIDEOS" })
      .catch(() => null);

    if (pageResp?.videos?.length > 0) {
      pageHints = pageResp.videos;
      if (pageHints.length > 1) {
        el.pageVideoPicker.classList.remove("hidden");
        el.pageVideoSelect.textContent = "";
        pageHints.forEach((h, i) => {
          const opt = document.createElement("option");
          opt.value = String(i);
          opt.textContent = `${h.subreddit ? `r/${h.subreddit} — ` : ""}${h.title || h.videoId}`;
          el.pageVideoSelect.appendChild(opt);
        });
      }
      await loadHintOrUrl(pageHints[0]);
    } else if (/\/comments\/|\/s\/|v\.redd\.it/i.test(url)) {
      await loadHintOrUrl({ url });
    } else {
      showStatus("No Reddit video detected on this page yet. Open a video post or paste a URL above.");
    }
  }

  (async function boot() {
    await checkPermissions();
    await loadSettingsUI();
    await initActiveTab();
  })();
})();
