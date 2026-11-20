/**
 * RedMux Background Service Worker (Chrome / Chromium Manifest V3)
 *
 * Coordinates:
 *  - Offscreen document lifecycle (for DOMParser, Blob URLs, and local MP4 muxing)
 *  - Settings storage (chrome.storage.local)
 *  - File downloads (chrome.downloads.download) & Blob URL cleanup
 *  - Right-click context menus & live progress forwarding to popup/content scripts
 */
"use strict";

const OFFSCREEN_PATH = "offscreen.html";

const DEFAULT_SETTINGS = {
  preferredQuality: "best", // "best" | "1080" | "720" | "480" | "360"
  filenamePattern: "subreddit_title", // "subreddit_title" | "title_only" | "subreddit_id"
  includeAudio: true,
  saveAs: false,
  injectButtons: true
};

let creatingOffscreen = null;
let activeJobs = 0;
let idleCloseTimer = null;
const activeBlobUrls = new Map(); // downloadId -> blobUrl

async function getSettings() {
  const stored = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

async function saveSettings(partial) {
  const current = await getSettings();
  const updated = { ...current, ...partial };
  await chrome.storage.local.set({ settings: updated });
  return updated;
}

// -------------------- Offscreen Document Management --------------------

async function hasOffscreenDocument() {
  if (typeof chrome.offscreen.hasDocument === "function") {
    return chrome.offscreen.hasDocument();
  }
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  if (typeof chrome.runtime.getContexts === "function") {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });
    return contexts.length > 0;
  }
  return false;
}

async function ensureOffscreenDocument() {
  if (idleCloseTimer) {
    clearTimeout(idleCloseTimer);
    idleCloseTimer = null;
  }

  if (await hasOffscreenDocument()) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["BLOBS", "DOM_PARSER"],
    justification:
      "Parse Reddit DASHPlaylist.mpd XML manifests with DOMParser, combine video/audio tracks into an MP4 Blob, and generate temporary Blob URLs for chrome.downloads."
  });

  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

function scheduleOffscreenCleanup() {
  if (idleCloseTimer) clearTimeout(idleCloseTimer);
  idleCloseTimer = setTimeout(async () => {
    if (activeJobs > 0 || activeBlobUrls.size > 0) return;
    try {
      if (await hasOffscreenDocument()) {
        await chrome.offscreen.closeDocument();
      }
    } catch {
      // Ignore if already closed
    }
  }, 45 * 1000);
}

async function revokeBlob(downloadId) {
  const blobUrl = activeBlobUrls.get(downloadId);
  if (!blobUrl) return;
  activeBlobUrls.delete(downloadId);

  try {
    if (await hasOffscreenDocument()) {
      await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "OFFSCREEN_REVOKE_BLOB",
        blobUrl
      });
    }
  } catch {
    // Ignore if offscreen already closed
  }
  scheduleOffscreenCleanup();
}

// -------------------- Context Menu Registration --------------------

function registerContextMenus() {
  chrome.contextMenus.removeAll(() => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create(
      {
        id: "redmux-download-page",
        title: "Download Reddit Video (with Audio)",
        contexts: ["page", "video", "link"],
        documentUrlPatterns: [
          "https://www.reddit.com/*",
          "https://old.reddit.com/*",
          "https://sh.reddit.com/*",
          "https://new.reddit.com/*"
        ]
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
  });
}

chrome.runtime.onInstalled.addListener(() => {
  registerContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  registerContextMenus();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "redmux-download-page") return;
  const targetUrl = info.linkUrl || info.pageUrl || tab?.url;
  if (!targetUrl) return;

  try {
    let hint = { url: targetUrl };
    if (!info.linkUrl && tab?.id) {
      const pageResp = await chrome.tabs
        .sendMessage(tab.id, { type: "GET_PAGE_VIDEOS" })
        .catch(() => null);
      if (pageResp?.videos?.length > 0) {
        hint = pageResp.videos[0];
      }
    }
    await handleDownload({ hint, tabId: tab?.id || null });
  } catch (err) {
    if (tab?.id) {
      chrome.tabs
        .sendMessage(tab.id, {
          type: "SHOW_TOAST",
          level: "error",
          message: err.message || "Download failed."
        })
        .catch(() => {});
    }
  }
});

// -------------------- Download Lifecycle & Cleanup --------------------

chrome.downloads.onChanged.addListener((delta) => {
  if (!activeBlobUrls.has(delta.id)) return;
  if (delta.state && (delta.state.current === "complete" || delta.state.current === "interrupted")) {
    revokeBlob(delta.id);
  }
});

// -------------------- Progress & Download Orchestration --------------------

function broadcastProgress(jobId, tabId, payload) {
  const msg = { type: "DOWNLOAD_PROGRESS", jobId, ...payload };
  chrome.runtime.sendMessage(msg).catch(() => {});
  if (tabId) {
    chrome.tabs.sendMessage(tabId, msg).catch(() => {});
  }
}

async function handleResolve(hintOrUrl) {
  activeJobs++;
  try {
    await ensureOffscreenDocument();
    const res = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "OFFSCREEN_RESOLVE",
      hint: hintOrUrl
    });
    if (!res || !res.ok) {
      throw new Error(res?.error || "Failed to resolve video.");
    }
    return res.data;
  } finally {
    activeJobs--;
    scheduleOffscreenCleanup();
  }
}

async function handleDownload({ hint, videoUrl, audioUrl, requestedHeight, includeAudio, tabId, jobId }) {
  const settings = await getSettings();
  const id = jobId || `job_${Date.now()}`;
  activeJobs++;

  try {
    await ensureOffscreenDocument();
    const res = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "OFFSCREEN_DOWNLOAD",
      hint,
      videoUrl,
      audioUrl,
      requestedHeight,
      includeAudio,
      settings,
      tabId,
      jobId: id
    });

    if (!res || !res.ok || !res.blobUrl) {
      throw new Error(res?.error || "Failed to build MP4 file.");
    }

    broadcastProgress(id, tabId, {
      stage: "saving",
      percent: 98,
      text: "Saving file..."
    });

    const downloadId = await chrome.downloads.download({
      url: res.blobUrl,
      filename: res.filename,
      saveAs: Boolean(settings.saveAs)
    });

    activeBlobUrls.set(downloadId, res.blobUrl);

    // Safety net cleanup after 10 minutes
    setTimeout(() => {
      if (activeBlobUrls.has(downloadId)) {
        revokeBlob(downloadId);
      }
    }, 10 * 60 * 1000);

    const statusText = res.combinedAudio
      ? `Saved ${res.resolution} (with audio)`
      : `Saved ${res.resolution} (no audio track)`;

    broadcastProgress(id, tabId, {
      stage: "done",
      percent: 100,
      text: statusText,
      filename: res.filename,
      combinedAudio: res.combinedAudio
    });

    return {
      ok: true,
      filename: res.filename,
      combinedAudio: res.combinedAudio,
      resolution: res.resolution,
      downloadId
    };
  } finally {
    activeJobs--;
    scheduleOffscreenCleanup();
  }
}

// -------------------- Message Router (Chrome sendResponse + return true) --------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;
  // Ignore messages intended for the offscreen document
  if (message.target === "offscreen") return false;

  if (message.type === "OFFSCREEN_PROGRESS") {
    broadcastProgress(message.jobId, message.tabId, {
      stage: message.stage,
      percent: message.percent,
      text: message.text
    });
    return false;
  }

  if (message.type === "RESOLVE_VIDEO") {
    handleResolve(message.hint || { url: message.url })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: err.message || "Failed to resolve video." }));
    return true;
  }

  if (message.type === "DOWNLOAD_VIDEO") {
    const tabId = message.tabId || sender?.tab?.id || null;
    handleDownload({ ...message, tabId })
      .then((res) => sendResponse(res))
      .catch((err) => {
        broadcastProgress(message.jobId || "", tabId, {
          stage: "error",
          percent: 0,
          text: err.message || "Download failed."
        });
        sendResponse({ ok: false, error: err.message || "Download failed." });
      });
    return true;
  }

  if (message.type === "GET_SETTINGS") {
    getSettings()
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "SAVE_SETTINGS") {
    saveSettings(message.settings || {})
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  return false;
});
