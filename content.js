/**
 * RedMux Content Script (Chrome / Chromium) — Supports www/sh.reddit.com & old.reddit.com
 *
 *  - Detects Reddit video posts dynamically via debounced MutationObserver
 *  - Injects a lightweight "Download MP4" button with live percentage progress
 *  - Responds to popup queries (GET_PAGE_VIDEOS) with DOM metadata
 */
(function () {
  "use strict";

  const BUTTON_CLASS = "redmux-dl-btn";
  const INJECTED_ATTR = "data-redmux-bound";
  const activeButtons = new Map(); // jobId -> { btn, labelEl }
  let injectEnabled = true;

  function extractVideoId(str) {
    if (!str) return null;
    const m = str.match(/https?:\/\/v\.redd\.it\/([a-zA-Z0-9]+)/i);
    return m ? m[1] : null;
  }

  function queryDeep(root, selector) {
    if (!root) return null;
    const direct = root.querySelector(selector);
    if (direct) return direct;
    const all = root.querySelectorAll("*");
    for (const el of all) {
      if (el.shadowRoot) {
        const found = queryDeep(el.shadowRoot, selector);
        if (found) return found;
      }
    }
    return null;
  }

  // -------------------- Modern Reddit (<shreddit-post>) --------------------

  function extractModernPostHint(postEl) {
    const contentHref = postEl.getAttribute("content-href") || "";
    const player =
      postEl.querySelector("shreddit-player, shreddit-player-2") ||
      queryDeep(postEl, "shreddit-player, shreddit-player-2");

    const src = player?.getAttribute("src") || "";
    const packagedMediaJson = player?.getAttribute("packaged-media-json") || "";

    const videoId =
      extractVideoId(src) ||
      extractVideoId(contentHref) ||
      extractVideoId(packagedMediaJson);

    if (!videoId && !src.includes("v.redd.it") && !packagedMediaJson.includes("v.redd.it")) {
      return null;
    }

    const permalinkAttr = postEl.getAttribute("permalink") || "";
    const permalink = permalinkAttr
      ? new URL(permalinkAttr, window.location.origin).toString()
      : window.location.href;

    const title =
      postEl.getAttribute("post-title") ||
      postEl.querySelector("h1, [slot='title']")?.textContent?.trim() ||
      document.title.replace(/\s*:\s*r\/\S+\s*$/, "").trim();

    const subreddit = (postEl.getAttribute("subreddit-prefixed-name") || "")
      .replace(/^r\//i, "");

    const postId = (postEl.getAttribute("id") || "").replace(/^t3_/, "");

    return {
      videoId,
      mpdUrl: src.includes("DASHPlaylist.mpd") ? src : null,
      packagedMediaJson: packagedMediaJson || null,
      title,
      subreddit,
      postId,
      permalink,
      url: permalink
    };
  }

  function createModernButton(hint) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = BUTTON_CLASS;
    btn.title = "Download Reddit video with audio (local MP4 muxer)";

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("class", "redmux-icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "15");
    svg.setAttribute("height", "15");
    svg.setAttribute("aria-hidden", "true");

    const path = document.createElementNS(svgNS, "path");
    path.setAttribute("fill", "currentColor");
    path.setAttribute(
      "d",
      "M12 3a1 1 0 0 1 1 1v9.59l2.3-2.3a1 1 0 1 1 1.4 1.42l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.42L11 13.59V4a1 1 0 0 1 1-1Zm-7 15a1 1 0 0 1 1-1h12a1 1 0 1 1 0 2H6a1 1 0 0 1-1-1Z"
    );
    svg.appendChild(path);

    const labelEl = document.createElement("span");
    labelEl.className = "redmux-label";
    labelEl.textContent = "Download MP4";

    btn.append(svg, labelEl);

    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.disabled) return;

      const jobId = `btn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      btn.disabled = true;
      btn.classList.remove("redmux-done", "redmux-error");
      btn.classList.add("redmux-busy");
      labelEl.textContent = "Resolving...";
      activeButtons.set(jobId, { btn, labelEl });

      try {
        const res = await chrome.runtime.sendMessage({
          type: "DOWNLOAD_VIDEO",
          hint,
          jobId
        });

        if (!res || !res.ok) {
          throw new Error(res?.error || "Download failed.");
        }

        btn.classList.remove("redmux-busy");
        btn.classList.add("redmux-done");
        labelEl.textContent = res.combinedAudio ? "Saved ✓" : "Saved (No Audio)";
        setTimeout(() => {
          btn.disabled = false;
          btn.classList.remove("redmux-done");
          labelEl.textContent = "Download MP4";
          activeButtons.delete(jobId);
        }, 3500);
      } catch (err) {
        btn.classList.remove("redmux-busy");
        btn.classList.add("redmux-error");
        labelEl.textContent = "Failed";
        showToast(err.message || "Download failed.", "error");
        setTimeout(() => {
          btn.disabled = false;
          btn.classList.remove("redmux-error");
          labelEl.textContent = "Download MP4";
          activeButtons.delete(jobId);
        }, 3000);
      }
    });

    return btn;
  }

  function injectModernButtons() {
    const posts = document.querySelectorAll("shreddit-post");
    for (const post of posts) {
      if (post.hasAttribute(INJECTED_ATTR)) continue;
      const hint = extractModernPostHint(post);
      if (!hint) continue;

      post.setAttribute(INJECTED_ATTR, "1");
      const wrap = document.createElement("div");
      wrap.className = "redmux-bar";
      wrap.appendChild(createModernButton(hint));

      const mediaSlot =
        post.querySelector("[slot='post-media-container']") ||
        post.querySelector("shreddit-player, shreddit-player-2")?.parentElement;

      if (mediaSlot && mediaSlot.parentElement) {
        mediaSlot.insertAdjacentElement("afterend", wrap);
      } else {
        post.appendChild(wrap);
      }
    }
  }

  // -------------------- Old Reddit (old.reddit.com) --------------------

  function extractOldPostHint(thingEl) {
    const dataUrl = thingEl.getAttribute("data-url") || "";
    const playerRoot = thingEl.querySelector(".reddit-video-player-root");
    const mpdUrl = playerRoot?.getAttribute("data-mpd-url") || "";
    const videoId = extractVideoId(mpdUrl) || extractVideoId(dataUrl);

    if (!videoId) return null;

    const permalinkAttr = thingEl.getAttribute("data-permalink") || "";
    const permalink = permalinkAttr
      ? new URL(permalinkAttr, "https://www.reddit.com").toString()
      : window.location.href;

    const title =
      thingEl.querySelector("a.title")?.textContent?.trim() ||
      document.title.replace(/\s*:\s*\S+\s*$/, "").trim();

    const subreddit = thingEl.getAttribute("data-subreddit") || "";
    const postId = (thingEl.getAttribute("data-fullname") || "").replace(/^t3_/, "");

    return {
      videoId,
      mpdUrl: mpdUrl || null,
      title,
      subreddit,
      postId,
      permalink,
      url: permalink
    };
  }

  function injectOldRedditButtons() {
    const things = document.querySelectorAll(".thing.link");
    for (const thing of things) {
      if (thing.hasAttribute(INJECTED_ATTR)) continue;
      const hint = extractOldPostHint(thing);
      if (!hint) continue;

      thing.setAttribute(INJECTED_ATTR, "1");
      const btnList = thing.querySelector("ul.flat-list.buttons");
      if (!btnList) continue;

      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = "#";
      a.className = "redmux-old-link";
      a.textContent = "download mp4";
      a.title = "Download Reddit video with audio (RedMux)";

      a.addEventListener("click", async (e) => {
        e.preventDefault();
        if (a.dataset.busy === "1") return;
        const jobId = `old_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        a.dataset.busy = "1";
        a.textContent = "downloading...";
        activeButtons.set(jobId, { btn: a, labelEl: a });

        try {
          const res = await chrome.runtime.sendMessage({
            type: "DOWNLOAD_VIDEO",
            hint,
            jobId
          });
          if (!res || !res.ok) throw new Error(res?.error || "Download failed.");
          a.textContent = res.combinedAudio ? "saved ✓" : "saved (no audio)";
        } catch (err) {
          a.textContent = "download failed";
          showToast(err.message || "Download failed.", "error");
        } finally {
          setTimeout(() => {
            a.dataset.busy = "0";
            a.textContent = "download mp4";
            activeButtons.delete(jobId);
          }, 3000);
        }
      });

      li.appendChild(a);
      btnList.appendChild(li);
    }
  }

  // -------------------- Toast Notification --------------------

  function showToast(message, level = "info") {
    const existing = document.querySelector(".redmux-toast");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.className = `redmux-toast redmux-toast-${level}`;
    toast.textContent = `RedMux: ${message}`;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.classList.add("redmux-toast-hide");
      setTimeout(() => toast.remove(), 250);
    }, 4000);
  }

  // -------------------- Collect Videos for Toolbar Popup --------------------

  function collectPageVideos() {
    const found = [];
    const seenIds = new Set();

    for (const post of document.querySelectorAll("shreddit-post")) {
      const hint = extractModernPostHint(post);
      if (hint && !seenIds.has(hint.videoId || hint.permalink)) {
        seenIds.add(hint.videoId || hint.permalink);
        found.push(hint);
      }
    }

    for (const thing of document.querySelectorAll(".thing.link")) {
      const hint = extractOldPostHint(thing);
      if (hint && !seenIds.has(hint.videoId || hint.permalink)) {
        seenIds.add(hint.videoId || hint.permalink);
        found.push(hint);
      }
    }

    return found;
  }

  // -------------------- Scan & Observer --------------------

  function scanPage() {
    if (!injectEnabled) return;
    if (window.location.hostname === "old.reddit.com") {
      injectOldRedditButtons();
    } else {
      injectModernButtons();
    }
  }

  let debounceTimer = null;
  function scheduleScan() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scanPage, 350);
  }

  // -------------------- Message Listeners --------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return false;

    if (msg.type === "GET_PAGE_VIDEOS") {
      sendResponse({
        videos: collectPageVideos(),
        pageUrl: window.location.href
      });
      return false;
    }

    if (msg.type === "DOWNLOAD_PROGRESS" && msg.jobId && activeButtons.has(msg.jobId)) {
      const entry = activeButtons.get(msg.jobId);
      if (msg.stage === "downloading" && typeof msg.percent === "number") {
        entry.labelEl.textContent = `${msg.percent}%`;
      } else if (msg.stage === "muxing") {
        entry.labelEl.textContent = "Muxing...";
      } else if (msg.stage === "saving") {
        entry.labelEl.textContent = "Saving...";
      }
      return false;
    }

    if (msg.type === "SHOW_TOAST") {
      showToast(msg.message, msg.level);
      return false;
    }

    if (msg.type === "SETTINGS_UPDATED") {
      injectEnabled = msg.settings?.injectButtons !== false;
      if (injectEnabled) {
        scanPage();
      } else {
        document.querySelectorAll(".redmux-bar, .redmux-old-link").forEach((el) => el.remove());
        document.querySelectorAll(`[${INJECTED_ATTR}]`).forEach((el) => el.removeAttribute(INJECTED_ATTR));
      }
      return false;
    }

    return false;
  });

  chrome.runtime
    .sendMessage({ type: "GET_SETTINGS" })
    .then((res) => {
      injectEnabled = res?.settings?.injectButtons !== false;
      scanPage();
      const observer = new MutationObserver(scheduleScan);
      observer.observe(document.body, { childList: true, subtree: true });
    })
    .catch(() => {
      scanPage();
    });
})();
