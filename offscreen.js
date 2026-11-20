/**
 * RedMux Offscreen Document (Chrome / Chromium MV3)
 *
 * Chrome MV3 service workers do not expose DOMParser or URL.createObjectURL().
 * This hidden offscreen document executes:
 *  - Stream resolution & DASHPlaylist.mpd XML parsing (DOMParser)
 *  - Streaming video + audio fetch with live progress reporting
 *  - Local MP4 muxing via RedMuxMP4 (CMAF & legacy DASH -> faststart MP4)
 *  - Zero-copy Blob URL creation (URL.createObjectURL) & cleanup (URL.revokeObjectURL)
 */
(function () {
  "use strict";

  const activeBlobs = new Set();

  async function fetchBinaryWithProgress(url, onChunkProgress) {
    const resp = await fetch(url, { credentials: "omit" });
    if (!resp.ok) {
      throw new Error(`Failed to fetch media stream (HTTP ${resp.status}).`);
    }

    const contentLength = parseInt(resp.headers.get("content-length") || "0", 10);
    if (!resp.body || !resp.body.getReader) {
      const buf = new Uint8Array(await resp.arrayBuffer());
      if (onChunkProgress) onChunkProgress(buf.length, buf.length);
      return buf;
    }

    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (onChunkProgress) onChunkProgress(received, contentLength);
    }

    const combined = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    return combined;
  }

  function pickVideoStream(videos, requestedHeight, preferredQuality) {
    if (!videos || videos.length === 0) return null;
    if (requestedHeight) {
      const exact = videos.find((v) => v.height === requestedHeight);
      if (exact) return exact;
    }
    if (preferredQuality && preferredQuality !== "best") {
      const cap = parseInt(preferredQuality, 10);
      if (cap > 0) {
        const underCap = videos.find((v) => v.height && v.height <= cap);
        if (underCap) return underCap;
      }
    }
    return videos[0];
  }

  function sendProgress(jobId, tabId, payload) {
    chrome.runtime
      .sendMessage({
        target: "background",
        type: "OFFSCREEN_PROGRESS",
        jobId,
        tabId,
        ...payload
      })
      .catch(() => {});
  }

  async function processDownload(req) {
    const {
      hint,
      videoUrl,
      audioUrl,
      requestedHeight,
      includeAudio,
      settings,
      tabId,
      jobId
    } = req;

    const wantAudio = typeof includeAudio === "boolean" ? includeAudio : settings.includeAudio;
    const id = jobId || `job_${Date.now()}`;

    sendProgress(id, tabId, { stage: "resolving", percent: 5, text: "Resolving streams..." });

    const resolved = await RedMuxResolver.resolve(hint || {});
    const chosenVideo =
      (videoUrl && resolved.videos.find((v) => v.url === videoUrl)) ||
      pickVideoStream(resolved.videos, requestedHeight, settings.preferredQuality);

    if (!chosenVideo) {
      throw new Error("No video stream selected.");
    }

    const chosenAudio = wantAudio
      ? (audioUrl && resolved.audios.find((a) => a.url === audioUrl)) || resolved.audios[0] || null
      : null;

    let vLoaded = 0;
    let vTotal = 0;
    let aLoaded = 0;
    let aTotal = 0;
    let lastEmit = 0;

    const emitProgress = (force = false) => {
      const now = Date.now();
      if (!force && now - lastEmit < 120) return;
      lastEmit = now;

      const total = vTotal + aTotal;
      const loaded = vLoaded + aLoaded;
      let pct = 20;
      if (total > 0) {
        pct = Math.min(88, Math.round(10 + (loaded / total) * 78));
      }
      const mb = (loaded / (1024 * 1024)).toFixed(1);
      sendProgress(id, tabId, {
        stage: "downloading",
        percent: pct,
        text: chosenAudio ? `Downloading video + audio (${mb} MB)...` : `Downloading video (${mb} MB)...`
      });
    };

    const videoPromise = fetchBinaryWithProgress(chosenVideo.url, (loaded, total) => {
      vLoaded = loaded;
      vTotal = total;
      emitProgress();
    });

    const audioPromise = chosenAudio
      ? fetchBinaryWithProgress(chosenAudio.url, (loaded, total) => {
          aLoaded = loaded;
          aTotal = total;
          emitProgress();
        }).catch(() => null)
      : Promise.resolve(null);

    const [videoBytes, audioBytes] = await Promise.all([videoPromise, audioPromise]);

    sendProgress(id, tabId, {
      stage: "muxing",
      percent: 92,
      text: audioBytes ? "Combining video & audio..." : "Finalizing MP4..."
    });

    let finalBlob;
    let combinedAudio = false;

    if (audioBytes && audioBytes.byteLength > 0) {
      finalBlob = RedMuxMP4.mux(videoBytes, audioBytes);
      combinedAudio = true;
    } else {
      try {
        finalBlob = RedMuxMP4.mux(videoBytes, null);
      } catch {
        finalBlob = new Blob([videoBytes], { type: "video/mp4" });
      }
    }

    const filename = RedMuxResolver.buildFilename(resolved, chosenVideo, settings.filenamePattern);
    const blobUrl = URL.createObjectURL(finalBlob);
    activeBlobs.add(blobUrl);

    return {
      ok: true,
      blobUrl,
      filename,
      combinedAudio,
      resolution: chosenVideo.label
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== "offscreen") return false;

    if (message.type === "OFFSCREEN_RESOLVE") {
      RedMuxResolver.resolve(message.hint || { url: message.url })
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err) => sendResponse({ ok: false, error: err.message || "Failed to resolve video." }));
      return true;
    }

    if (message.type === "OFFSCREEN_DOWNLOAD") {
      processDownload(message)
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: err.message || "Download failed." }));
      return true;
    }

    if (message.type === "OFFSCREEN_REVOKE_BLOB") {
      if (message.blobUrl && activeBlobs.has(message.blobUrl)) {
        URL.revokeObjectURL(message.blobUrl);
        activeBlobs.delete(message.blobUrl);
      }
      sendResponse({ ok: true, remaining: activeBlobs.size });
      return false;
    }

    return false;
  });
})();
