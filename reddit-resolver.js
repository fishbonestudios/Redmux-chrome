/**
 * RedMuxResolver — Discovers all video resolutions & audio streams for a Reddit video post.
 *
 * Resolution cascade (handles 2026 Reddit CMAF & legacy DASH, plus unauthenticated .json lockouts):
 *  1. DOM-extracted hints (MPD URL, v.redd.it videoId, packaged-media-json) when triggered on a Reddit page
 *  2. Redirect resolution for /s/ mobile share links and redd.it short links
 *  3. Authenticated .json endpoint (credentials: 'include') — handles crossposts too
 *  4. Direct HTML page scraping fallback (extracts packaged-media-json & v.redd.it URLs)
 *  5. DASHPlaylist.mpd XML parser (returns all CMAF_* / DASH_* video & audio streams)
 *  6. Parallel HEAD probe fallback if MPD is unavailable or incomplete
 */
(function (global) {
  "use strict";

  const VREDDIT_ID_RE = /https?:\/\/v\.redd\.it\/([a-zA-Z0-9]+)/i;
  const MPD_URL_RE = /https?:\/\/v\.redd\.it\/[a-zA-Z0-9]+\/DASHPlaylist\.mpd[^"'\\\s<]*/i;

  function decodeHtmlEntities(str) {
    if (!str) return "";
    return str
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  }

  function extractVideoId(str) {
    if (!str) return null;
    const m = str.match(VREDDIT_ID_RE);
    return m ? m[1] : null;
  }

  function normalizePostUrl(inputUrl) {
    const trimmed = (inputUrl || "").trim();
    if (!trimmed) throw new Error("Please enter a valid Reddit URL.");
    let parsed;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error("Invalid URL format.");
    }
    const host = parsed.hostname.toLowerCase();
    const isReddit =
      host === "reddit.com" ||
      host.endsWith(".reddit.com") ||
      host === "redd.it" ||
      host === "v.redd.it";
    if (!isReddit) {
      throw new Error("URL must be a Reddit link (reddit.com, redd.it, or v.redd.it).");
    }
    return parsed.toString();
  }

  function parseSubredditFromUrl(url) {
    const m = (url || "").match(/\/r\/([^/?#]+)/i);
    return m ? m[1] : "";
  }

  function parsePostIdFromUrl(url) {
    const m = (url || "").match(/\/comments\/([a-z0-9]+)/i);
    return m ? m[1] : "";
  }

  function parsePackagedMediaJson(rawJson) {
    const result = { videoId: null, mpdUrl: null, fallbackUrl: null };
    if (!rawJson) return result;
    try {
      const obj = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
      const text = JSON.stringify(obj);
      const mpdMatch = text.match(MPD_URL_RE);
      if (mpdMatch) result.mpdUrl = mpdMatch[0];
      const idMatch = text.match(VREDDIT_ID_RE);
      if (idMatch) result.videoId = idMatch[1];

      // Check playbackMp4s array if present
      const mp4s = obj?.playbackMp4s?.permutations;
      if (Array.isArray(mp4s) && mp4s.length > 0) {
        const best = mp4s[mp4s.length - 1];
        const url = best?.source?.url;
        if (url) {
          result.fallbackUrl = decodeHtmlEntities(url);
          if (!result.videoId) result.videoId = extractVideoId(result.fallbackUrl);
        }
      }
    } catch {
      // Ignore malformed JSON
    }
    return result;
  }

  async function resolveShortOrShareUrl(url) {
    const parsed = new URL(url);
    const needsFollow =
      parsed.hostname === "redd.it" ||
      /\/r\/[^/]+\/s\/[a-zA-Z0-9]+/i.test(parsed.pathname);
    if (!needsFollow) return url;

    const resp = await fetch(url, {
      method: "GET",
      credentials: "include",
      redirect: "follow"
    });
    return resp.url || url;
  }

  async function tryFetchPostJson(postUrl) {
    const u = new URL(postUrl);
    const cleanPath = u.pathname.replace(/\/+$/, "");
    const jsonUrl = `https://www.reddit.com${cleanPath}.json?raw_json=1`;

    const resp = await fetch(jsonUrl, {
      credentials: "include",
      headers: { Accept: "application/json" }
    });
    if (!resp.ok) return null;

    const ct = resp.headers.get("content-type") || "";
    if (!ct.includes("json")) return null;

    const data = await resp.json();
    const post = data?.[0]?.data?.children?.[0]?.data;
    if (!post) return null;

    let rv = post.secure_media?.reddit_video || post.media?.reddit_video;
    if (!rv && Array.isArray(post.crosspost_parent_list)) {
      for (const cp of post.crosspost_parent_list) {
        rv = cp?.secure_media?.reddit_video || cp?.media?.reddit_video;
        if (rv) break;
      }
    }

    const fallbackUrl = rv?.fallback_url ? decodeHtmlEntities(rv.fallback_url) : null;
    const mpdUrl = rv?.dash_url ? decodeHtmlEntities(rv.dash_url) : null;
    const videoId =
      extractVideoId(mpdUrl) ||
      extractVideoId(fallbackUrl) ||
      extractVideoId(post.url_overridden_by_dest) ||
      extractVideoId(post.url);

    return {
      title: post.title || "",
      subreddit: post.subreddit || parseSubredditFromUrl(postUrl),
      postId: post.id || parsePostIdFromUrl(postUrl),
      permalink: post.permalink ? `https://www.reddit.com${post.permalink}` : postUrl,
      videoId,
      mpdUrl,
      fallbackUrl,
      hasAudioHint: rv?.has_audio
    };
  }

  async function tryFetchPostHtml(postUrl) {
    const resp = await fetch(postUrl, {
      credentials: "include",
      headers: { Accept: "text/html" }
    });
    if (!resp.ok) return null;
    const html = await resp.text();

    let title = "";
    const titleAttr = html.match(/post-title="([^"]+)"/i);
    if (titleAttr) {
      title = decodeHtmlEntities(titleAttr[1]);
    } else {
      const titleTag = html.match(/<title>([^<]+)<\/title>/i);
      if (titleTag) {
        title = decodeHtmlEntities(titleTag[1]).replace(/\s*:\s*r\/\S+\s*$/, "").trim();
      }
    }

    let videoId = null;
    let mpdUrl = null;
    let fallbackUrl = null;

    // 1. Check packaged-media-json attribute in shreddit-player
    const pkgMatch = html.match(/packaged-media-json="([^"]+)"/i);
    if (pkgMatch) {
      const parsed = parsePackagedMediaJson(decodeHtmlEntities(pkgMatch[1]));
      videoId = parsed.videoId;
      mpdUrl = parsed.mpdUrl;
      fallbackUrl = parsed.fallbackUrl;
    }

    // 2. Direct MPD URL anywhere in HTML
    if (!mpdUrl) {
      const mpdMatch = html.match(MPD_URL_RE);
      if (mpdMatch) {
        mpdUrl = decodeHtmlEntities(mpdMatch[0]);
      }
    }

    // 3. Any v.redd.it video ID
    if (!videoId) {
      videoId = extractVideoId(mpdUrl) || extractVideoId(html);
    }

    if (!videoId && !mpdUrl) return null;

    return {
      title,
      subreddit: parseSubredditFromUrl(postUrl),
      postId: parsePostIdFromUrl(postUrl),
      permalink: postUrl,
      videoId,
      mpdUrl,
      fallbackUrl
    };
  }

  function resolveRelativeUrl(baseUrl, candidate) {
    if (!candidate) return null;
    if (/^https?:\/\//i.test(candidate)) return candidate;
    return new URL(candidate, baseUrl).toString();
  }

  async function parseDashPlaylist(mpdUrl, videoId) {
    const targetMpd = mpdUrl || `https://v.redd.it/${videoId}/DASHPlaylist.mpd`;
    const baseDir = `https://v.redd.it/${videoId}/`;

    const resp = await fetch(targetMpd, { credentials: "omit" });
    if (!resp.ok) return null;
    const xmlText = await resp.text();
    if (!xmlText || !xmlText.includes("<MPD")) return null;

    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, "application/xml");
    if (doc.querySelector("parsererror")) return null;

    const videos = [];
    const audios = [];

    const adaptationSets = Array.from(doc.getElementsByTagName("AdaptationSet"));
    for (const set of adaptationSets) {
      const setMime = (set.getAttribute("mimeType") || "").toLowerCase();
      const setContent = (set.getAttribute("contentType") || "").toLowerCase();
      const reps = Array.from(set.getElementsByTagName("Representation"));

      for (const rep of reps) {
        const repMime = (rep.getAttribute("mimeType") || setMime).toLowerCase();
        const codecs = (rep.getAttribute("codecs") || set.getAttribute("codecs") || "").toLowerCase();
        const width = parseInt(rep.getAttribute("width") || "0", 10);
        const height = parseInt(rep.getAttribute("height") || "0", 10);
        const bandwidth = parseInt(rep.getAttribute("bandwidth") || "0", 10);
        const frameRate = rep.getAttribute("frameRate") || "";

        const baseEl = rep.getElementsByTagName("BaseURL")[0];
        if (!baseEl || !baseEl.textContent) continue;
        const rawBase = baseEl.textContent.trim();
        const streamUrl = resolveRelativeUrl(baseDir, rawBase);

        const isAudio =
          setContent === "audio" ||
          repMime.startsWith("audio/") ||
          codecs.startsWith("mp4a") ||
          codecs.startsWith("opus") ||
          /audio/i.test(rawBase);

        const isVideo =
          !isAudio &&
          (setContent === "video" ||
            repMime.startsWith("video/") ||
            height > 0 ||
            codecs.startsWith("avc") ||
            codecs.startsWith("hev") ||
            codecs.startsWith("hvc") ||
            codecs.startsWith("vp09") ||
            codecs.startsWith("av01"));

        if (isVideo) {
          const inferredHeight =
            height || parseInt((rawBase.match(/(?:CMAF|DASH)_(\d+)\.mp4/i) || [])[1] || "0", 10);
          videos.push({
            url: streamUrl,
            width,
            height: inferredHeight,
            bandwidth,
            codecs,
            frameRate,
            label: inferredHeight ? `${inferredHeight}p` : `${Math.round(bandwidth / 1000)} kbps`,
            filenameHint: rawBase
          });
        } else if (isAudio) {
          const kbps =
            Math.round(bandwidth / 1000) ||
            parseInt((rawBase.match(/AUDIO_(\d+)/i) || [])[1] || "128", 10);
          audios.push({
            url: streamUrl,
            bandwidth,
            codecs,
            kbps,
            label: `${kbps} kbps`,
            filenameHint: rawBase
          });
        }
      }
    }

    // Deduplicate and sort descending
    const dedupeByUrl = (list) => {
      const seen = new Set();
      return list.filter((item) => {
        if (seen.has(item.url)) return false;
        seen.add(item.url);
        return true;
      });
    };

    const sortedVideos = dedupeByUrl(videos).sort(
      (a, b) => b.height - a.height || b.bandwidth - a.bandwidth
    );
    const sortedAudios = dedupeByUrl(audios).sort((a, b) => b.bandwidth - a.bandwidth);

    return { videos: sortedVideos, audios: sortedAudios };
  }

  async function probeUrl(url) {
    try {
      const resp = await fetch(url, { method: "HEAD", credentials: "omit" });
      if (resp.ok) {
        const len = parseInt(resp.headers.get("content-length") || "0", 10);
        return { ok: true, size: len };
      }
    } catch {
      // ignore
    }
    return { ok: false, size: 0 };
  }

  async function probeFallbackStreams(videoId, fallbackUrl) {
    const base = `https://v.redd.it/${videoId}/`;
    const videoCandidates = [
      { file: "CMAF_1080.mp4", height: 1080 },
      { file: "CMAF_720.mp4", height: 720 },
      { file: "CMAF_480.mp4", height: 480 },
      { file: "CMAF_360.mp4", height: 360 },
      { file: "DASH_1080.mp4", height: 1080 },
      { file: "DASH_720.mp4", height: 720 },
      { file: "DASH_480.mp4", height: 480 },
      { file: "DASH_360.mp4", height: 360 }
    ];
    const audioCandidates = [
      { file: "CMAF_AUDIO_128.mp4", kbps: 128 },
      { file: "CMAF_AUDIO_64.mp4", kbps: 64 },
      { file: "DASH_AUDIO_128.mp4", kbps: 128 },
      { file: "DASH_AUDIO_64.mp4", kbps: 64 },
      { file: "DASH_audio.mp4", kbps: 128 },
      { file: "audio", kbps: 128 }
    ];

    const videos = [];
    const seenHeights = new Set();

    if (fallbackUrl) {
      const cleanFallback = fallbackUrl.split("?")[0];
      const h = parseInt((cleanFallback.match(/(?:CMAF|DASH)_(\d+)/i) || [])[1] || "0", 10);
      videos.push({
        url: cleanFallback,
        width: 0,
        height: h,
        bandwidth: h * 3000,
        codecs: "",
        label: h ? `${h}p` : "Default",
        filenameHint: cleanFallback.split("/").pop()
      });
      if (h) seenHeights.add(h);
    }

    const vChecks = await Promise.all(
      videoCandidates.map(async (c) => {
        const url = base + c.file;
        const r = await probeUrl(url);
        return r.ok ? { ...c, url, size: r.size } : null;
      })
    );
    for (const hit of vChecks) {
      if (!hit || seenHeights.has(hit.height)) continue;
      seenHeights.add(hit.height);
      videos.push({
        url: hit.url,
        width: 0,
        height: hit.height,
        bandwidth: hit.height * 3000,
        codecs: "",
        label: `${hit.height}p`,
        filenameHint: hit.file
      });
    }

    const aChecks = await Promise.all(
      audioCandidates.map(async (c) => {
        const url = base + c.file;
        const r = await probeUrl(url);
        return r.ok ? { ...c, url, size: r.size } : null;
      })
    );
    const audios = aChecks
      .filter(Boolean)
      .map((hit) => ({
        url: hit.url,
        bandwidth: hit.kbps * 1000,
        codecs: "",
        kbps: hit.kbps,
        label: `${hit.kbps} kbps`,
        filenameHint: hit.file
      }));

    videos.sort((a, b) => b.height - a.height);
    audios.sort((a, b) => b.bandwidth - a.bandwidth);
    return { videos, audios };
  }

  /**
   * Main entry point: resolves full metadata + available video & audio streams.
   * @param {Object} input — { url?, videoId?, mpdUrl?, fallbackUrl?, packagedMediaJson?, title?, subreddit?, postId? }
   */
  async function resolve(input) {
    let meta = {
      title: input.title || "",
      subreddit: input.subreddit || "",
      postId: input.postId || "",
      permalink: input.url || input.permalink || "",
      videoId: input.videoId || extractVideoId(input.mpdUrl) || extractVideoId(input.fallbackUrl) || extractVideoId(input.url),
      mpdUrl: input.mpdUrl || null,
      fallbackUrl: input.fallbackUrl || null
    };

    if (input.packagedMediaJson) {
      const parsed = parsePackagedMediaJson(input.packagedMediaJson);
      meta.videoId = meta.videoId || parsed.videoId;
      meta.mpdUrl = meta.mpdUrl || parsed.mpdUrl;
      meta.fallbackUrl = meta.fallbackUrl || parsed.fallbackUrl;
    }

    // If we don't have a videoId yet (e.g. user pasted a Reddit post link or right-clicked a link)
    if (!meta.videoId && meta.permalink) {
      const normalized = normalizePostUrl(meta.permalink);
      const resolvedUrl = await resolveShortOrShareUrl(normalized);
      meta.permalink = resolvedUrl;
      meta.subreddit = meta.subreddit || parseSubredditFromUrl(resolvedUrl);
      meta.postId = meta.postId || parsePostIdFromUrl(resolvedUrl);

      const directId = extractVideoId(resolvedUrl);
      if (directId) {
        meta.videoId = directId;
      } else {
        // Try authenticated JSON first, then HTML scraping fallback
        const fromJson = await tryFetchPostJson(resolvedUrl).catch(() => null);
        if (fromJson && (fromJson.videoId || fromJson.mpdUrl)) {
          meta = {
            ...meta,
            title: meta.title || fromJson.title,
            subreddit: meta.subreddit || fromJson.subreddit,
            postId: meta.postId || fromJson.postId,
            videoId: fromJson.videoId,
            mpdUrl: fromJson.mpdUrl,
            fallbackUrl: fromJson.fallbackUrl
          };
        } else {
          const fromHtml = await tryFetchPostHtml(resolvedUrl).catch(() => null);
          if (fromHtml && (fromHtml.videoId || fromHtml.mpdUrl)) {
            meta = {
              ...meta,
              title: meta.title || fromHtml.title,
              subreddit: meta.subreddit || fromHtml.subreddit,
              postId: meta.postId || fromHtml.postId,
              videoId: fromHtml.videoId,
              mpdUrl: fromHtml.mpdUrl,
              fallbackUrl: fromHtml.fallbackUrl
            };
          }
        }
      }
    }

    if (!meta.videoId && meta.mpdUrl) {
      meta.videoId = extractVideoId(meta.mpdUrl);
    }

    if (!meta.videoId) {
      throw new Error(
        "No Reddit-hosted video (v.redd.it) found on this post. External embeds (YouTube, RedGIFs, Streamable) are not hosted on v.redd.it."
      );
    }

    // Parse DASHPlaylist.mpd for authoritative list of CMAF/DASH video & audio streams
    let streams = await parseDashPlaylist(meta.mpdUrl, meta.videoId).catch(() => null);

    // If MPD had a missing higher-res fallbackUrl (rare legacy 1080p edge case), merge it in
    if (streams && streams.videos.length > 0 && meta.fallbackUrl) {
      const cleanFb = meta.fallbackUrl.split("?")[0];
      const fbHeight = parseInt((cleanFb.match(/(?:CMAF|DASH)_(\d+)/i) || [])[1] || "0", 10);
      const maxMpdHeight = streams.videos[0].height || 0;
      if (fbHeight > maxMpdHeight) {
        const probe = await probeUrl(cleanFb);
        if (probe.ok) {
          streams.videos.unshift({
            url: cleanFb,
            width: 0,
            height: fbHeight,
            bandwidth: fbHeight * 3000,
            codecs: "",
            label: `${fbHeight}p`,
            filenameHint: cleanFb.split("/").pop()
          });
        }
      }
    }

    // Fallback to parallel HEAD probing if MPD failed or had no streams
    if (!streams || streams.videos.length === 0) {
      streams = await probeFallbackStreams(meta.videoId, meta.fallbackUrl);
    }

    // Extra audio probe if MPD listed video-only (some older posts omit audio from MPD)
    if (streams.audios.length === 0) {
      const probed = await probeFallbackStreams(meta.videoId, null);
      if (probed.audios.length > 0) {
        streams.audios = probed.audios;
      }
    }

    if (streams.videos.length === 0) {
      throw new Error("Could not locate any downloadable video stream for this Reddit post.");
    }

    return {
      ...meta,
      videos: streams.videos,
      audios: streams.audios,
      hasAudio: streams.audios.length > 0
    };
  }

  function sanitizeFilename(name) {
    return (name || "reddit_video")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 110);
  }

  function buildFilename(meta, videoStream, pattern) {
    const cleanTitle = sanitizeFilename(meta.title) || `reddit_${meta.videoId}`;
    const sub = sanitizeFilename(meta.subreddit).replace(/^r\//i, "");
    const resTag = videoStream?.height ? `${videoStream.height}p` : "";

    let base;
    if (pattern === "subreddit_id") {
      base = sub ? `r_${sub}_${meta.videoId}` : `reddit_${meta.videoId}`;
    } else if (pattern === "title_only") {
      base = cleanTitle;
    } else {
      // default: subreddit_title
      base = sub ? `[r_${sub}] ${cleanTitle}` : cleanTitle;
    }

    const suffix = resTag ? ` (${resTag})` : "";
    return `${sanitizeFilename(base)}${suffix}.mp4`;
  }

  global.RedMuxResolver = {
    resolve,
    buildFilename
  };
})(typeof self !== "undefined" ? self : window);
