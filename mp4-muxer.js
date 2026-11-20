/**
 * RedMuxMP4 — Pure-JavaScript ISO-BMFF (MP4) Demuxer & Faststart Muxer
 *
 * Combines separate video-only and audio-only MP4 files (both legacy non-fragmented
 * DASH MP4s and modern fragmented CMAF/fMP4s used by Reddit's v.redd.it) into a
 * single standard, faststart (moov-before-mdat), interleaved .mp4 Blob.
 *
 * Zero external dependencies. Runs 100% locally inside Chrome/Chromium.
 */
(function (global) {
  "use strict";

  // -------------------- Binary Read / Write Helpers --------------------

  function readU16(b, o) {
    return (b[o] << 8) | b[o + 1];
  }

  function readI16(b, o) {
    const v = readU16(b, o);
    return v & 0x8000 ? v - 0x10000 : v;
  }

  function readU32(b, o) {
    return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  }

  function readI32(b, o) {
    return (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
  }

  function readU64(b, o) {
    const hi = readU32(b, o);
    const lo = readU32(b, o + 4);
    return hi * 4294967296 + lo;
  }

  function readI64(b, o) {
    const hi = readI32(b, o);
    const lo = readU32(b, o + 4);
    return hi * 4294967296 + lo;
  }

  function readStr(b, o, len) {
    let s = "";
    for (let i = 0; i < len; i++) {
      s += String.fromCharCode(b[o + i]);
    }
    return s;
  }

  function writeU16(b, o, v) {
    b[o] = (v >>> 8) & 0xff;
    b[o + 1] = v & 0xff;
  }

  function writeU32(b, o, v) {
    b[o] = (v >>> 24) & 0xff;
    b[o + 1] = (v >>> 16) & 0xff;
    b[o + 2] = (v >>> 8) & 0xff;
    b[o + 3] = v & 0xff;
  }

  function writeI32(b, o, v) {
    writeU32(b, o, v >>> 0);
  }

  function writeU64(b, o, v) {
    const hi = Math.floor(v / 4294967296);
    const lo = v >>> 0;
    writeU32(b, o, hi);
    writeU32(b, o + 4, lo);
  }

  function writeStr(b, o, s) {
    for (let i = 0; i < s.length; i++) {
      b[o + i] = s.charCodeAt(i) & 0xff;
    }
  }

  function concatBytes(parts) {
    let total = 0;
    for (let i = 0; i < parts.length; i++) total += parts[i].length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (let i = 0; i < parts.length; i++) {
      out.set(parts[i], pos);
      pos += parts[i].length;
    }
    return out;
  }

  function makeBox(type, ...payloads) {
    let payloadLen = 0;
    for (let i = 0; i < payloads.length; i++) payloadLen += payloads[i].length;
    const total = 8 + payloadLen;
    const out = new Uint8Array(total);
    writeU32(out, 0, total);
    writeStr(out, 4, type);
    let pos = 8;
    for (let i = 0; i < payloads.length; i++) {
      out.set(payloads[i], pos);
      pos += payloads[i].length;
    }
    return out;
  }

  function makeFullBox(type, version, flags, ...payloads) {
    const header = new Uint8Array(4);
    header[0] = version & 0xff;
    header[1] = (flags >>> 16) & 0xff;
    header[2] = (flags >>> 8) & 0xff;
    header[3] = flags & 0xff;
    return makeBox(type, header, ...payloads);
  }

  // -------------------- ISO-BMFF Box Tree Reader --------------------

  function readBoxes(bytes, start, end) {
    const boxes = [];
    let offset = start;
    while (offset + 8 <= end) {
      let size = readU32(bytes, offset);
      const type = readStr(bytes, offset + 4, 4);
      let headerSize = 8;

      if (size === 1) {
        if (offset + 16 > end) break;
        size = readU64(bytes, offset + 8);
        headerSize = 16;
      } else if (size === 0) {
        size = end - offset;
      }

      if (size < headerSize) break;
      const boxEnd = Math.min(offset + size, end);
      boxes.push({
        type,
        offset,
        size: boxEnd - offset,
        headerSize,
        dataOffset: offset + headerSize,
        dataEnd: boxEnd
      });
      offset = boxEnd;
    }
    return boxes;
  }

  function findBox(boxes, type) {
    return boxes.find((b) => b.type === type) || null;
  }

  function findAllBoxes(boxes, type) {
    return boxes.filter((b) => b.type === type);
  }

  // -------------------- Track & Sample Demuxing --------------------

  function parseTrexMap(bytes, moovChildren) {
    const map = new Map();
    const mvex = findBox(moovChildren, "mvex");
    if (!mvex) return map;
    const mvexChildren = readBoxes(bytes, mvex.dataOffset, mvex.dataEnd);
    for (const trex of findAllBoxes(mvexChildren, "trex")) {
      const o = trex.dataOffset;
      if (o + 24 > trex.dataEnd) continue;
      const trackId = readU32(bytes, o + 4);
      map.set(trackId, {
        trackId,
        defaultSampleDescriptionIndex: readU32(bytes, o + 8),
        defaultSampleDuration: readU32(bytes, o + 12),
        defaultSampleSize: readU32(bytes, o + 16),
        defaultSampleFlags: readU32(bytes, o + 20)
      });
    }
    return map;
  }

  function parseElst(bytes, trakChildren) {
    const edts = findBox(trakChildren, "edts");
    if (!edts) return [];
    const edtsChildren = readBoxes(bytes, edts.dataOffset, edts.dataEnd);
    const elst = findBox(edtsChildren, "elst");
    if (!elst) return [];

    const o = elst.dataOffset;
    const version = bytes[o];
    const count = readU32(bytes, o + 4);
    const entries = [];
    let pos = o + 8;

    for (let i = 0; i < count; i++) {
      if (version === 1) {
        if (pos + 20 > elst.dataEnd) break;
        entries.push({
          segmentDuration: readU64(bytes, pos),
          mediaTime: readI64(bytes, pos + 8),
          mediaRateInteger: readI16(bytes, pos + 16),
          mediaRateFraction: readI16(bytes, pos + 18)
        });
        pos += 20;
      } else {
        if (pos + 12 > elst.dataEnd) break;
        entries.push({
          segmentDuration: readU32(bytes, pos),
          mediaTime: readI32(bytes, pos + 4),
          mediaRateInteger: readI16(bytes, pos + 8),
          mediaRateFraction: readI16(bytes, pos + 10)
        });
        pos += 12;
      }
    }
    return entries;
  }

  function extractStandardSamples(bytes, stblChildren) {
    const stsz = findBox(stblChildren, "stsz");
    if (!stsz) return [];
    const sampleSizeConst = readU32(bytes, stsz.dataOffset + 4);
    const sampleCount = readU32(bytes, stsz.dataOffset + 8);
    if (sampleCount === 0) return [];

    // Sample sizes
    const sizes = new Uint32Array(sampleCount);
    if (sampleSizeConst !== 0) {
      sizes.fill(sampleSizeConst);
    } else {
      let pos = stsz.dataOffset + 12;
      for (let i = 0; i < sampleCount; i++) {
        sizes[i] = readU32(bytes, pos);
        pos += 4;
      }
    }

    // Durations (stts)
    const durations = new Uint32Array(sampleCount);
    const stts = findBox(stblChildren, "stts");
    if (stts) {
      const entryCount = readU32(bytes, stts.dataOffset + 4);
      let pos = stts.dataOffset + 8;
      let idx = 0;
      for (let i = 0; i < entryCount && idx < sampleCount; i++) {
        const cnt = readU32(bytes, pos);
        const delta = readU32(bytes, pos + 4);
        pos += 8;
        for (let j = 0; j < cnt && idx < sampleCount; j++) {
          durations[idx++] = delta;
        }
      }
    }

    // Composition time offsets (ctts)
    const ctsArr = new Int32Array(sampleCount);
    const ctts = findBox(stblChildren, "ctts");
    if (ctts) {
      const version = bytes[ctts.dataOffset];
      const entryCount = readU32(bytes, ctts.dataOffset + 4);
      let pos = ctts.dataOffset + 8;
      let idx = 0;
      for (let i = 0; i < entryCount && idx < sampleCount; i++) {
        const cnt = readU32(bytes, pos);
        const off = version === 1 ? readI32(bytes, pos + 4) : readU32(bytes, pos + 4);
        pos += 8;
        for (let j = 0; j < cnt && idx < sampleCount; j++) {
          ctsArr[idx++] = off;
        }
      }
    }

    // Sync samples (stss)
    let syncSet = null;
    const stss = findBox(stblChildren, "stss");
    if (stss) {
      syncSet = new Set();
      const entryCount = readU32(bytes, stss.dataOffset + 4);
      let pos = stss.dataOffset + 8;
      for (let i = 0; i < entryCount; i++) {
        syncSet.add(readU32(bytes, pos));
        pos += 4;
      }
    }

    // Chunk offsets (stco or co64)
    const chunkOffsets = [];
    const stco = findBox(stblChildren, "stco");
    const co64 = findBox(stblChildren, "co64");
    if (stco) {
      const count = readU32(bytes, stco.dataOffset + 4);
      let pos = stco.dataOffset + 8;
      for (let i = 0; i < count; i++) {
        chunkOffsets.push(readU32(bytes, pos));
        pos += 4;
      }
    } else if (co64) {
      const count = readU32(bytes, co64.dataOffset + 4);
      let pos = co64.dataOffset + 8;
      for (let i = 0; i < count; i++) {
        chunkOffsets.push(readU64(bytes, pos));
        pos += 8;
      }
    }

    // Sample-to-chunk (stsc)
    const stscEntries = [];
    const stsc = findBox(stblChildren, "stsc");
    if (stsc) {
      const count = readU32(bytes, stsc.dataOffset + 4);
      let pos = stsc.dataOffset + 8;
      for (let i = 0; i < count; i++) {
        stscEntries.push({
          firstChunk: readU32(bytes, pos),
          samplesPerChunk: readU32(bytes, pos + 4),
          sampleDescIndex: readU32(bytes, pos + 8)
        });
        pos += 12;
      }
    }

    // Map each sample to its byte offset
    const samples = [];
    let sampleIdx = 0;
    let stscIdx = 0;

    for (let chunkNum = 1; chunkNum <= chunkOffsets.length && sampleIdx < sampleCount; chunkNum++) {
      while (stscIdx + 1 < stscEntries.length && stscEntries[stscIdx + 1].firstChunk <= chunkNum) {
        stscIdx++;
      }
      const spc = stscEntries[stscIdx] ? stscEntries[stscIdx].samplesPerChunk : 1;
      let bytePos = chunkOffsets[chunkNum - 1];

      for (let k = 0; k < spc && sampleIdx < sampleCount; k++) {
        const sz = sizes[sampleIdx];
        if (bytePos >= 0 && bytePos + sz <= bytes.length) {
          samples.push({
            offset: bytePos,
            size: sz,
            duration: durations[sampleIdx],
            cts: ctsArr[sampleIdx],
            isSync: syncSet ? syncSet.has(sampleIdx + 1) : true
          });
        }
        bytePos += sz;
        sampleIdx++;
      }
    }

    return samples;
  }

  function extractFragmentedSamples(bytes, topBoxes, trackId, trex) {
    const samples = [];

    for (let bi = 0; bi < topBoxes.length; bi++) {
      const box = topBoxes[bi];
      if (box.type !== "moof") continue;

      // Find the mdat immediately following this moof (fallback when data_offset is omitted)
      let nextMdat = null;
      for (let j = bi + 1; j < topBoxes.length; j++) {
        if (topBoxes[j].type === "mdat") {
          nextMdat = topBoxes[j];
          break;
        }
        if (topBoxes[j].type === "moof") break;
      }

      const moofChildren = readBoxes(bytes, box.dataOffset, box.dataEnd);
      for (const traf of findAllBoxes(moofChildren, "traf")) {
        const trafChildren = readBoxes(bytes, traf.dataOffset, traf.dataEnd);
        const tfhd = findBox(trafChildren, "tfhd");
        if (!tfhd) continue;

        const o = tfhd.dataOffset;
        const tfhdFlags = (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3];
        const trafTrackId = readU32(bytes, o + 4);
        if (trafTrackId !== trackId) continue;

        let pos = o + 8;
        let baseDataOffset = null;
        let defaultDuration = trex ? trex.defaultSampleDuration : 0;
        let defaultSize = trex ? trex.defaultSampleSize : 0;
        let defaultFlags = trex ? trex.defaultSampleFlags : 0;

        if (tfhdFlags & 0x000001) {
          baseDataOffset = readU64(bytes, pos);
          pos += 8;
        }
        if (tfhdFlags & 0x000002) {
          pos += 4; // sample_description_index
        }
        if (tfhdFlags & 0x000008) {
          defaultDuration = readU32(bytes, pos);
          pos += 4;
        }
        if (tfhdFlags & 0x000010) {
          defaultSize = readU32(bytes, pos);
          pos += 4;
        }
        if (tfhdFlags & 0x000020) {
          defaultFlags = readU32(bytes, pos);
          pos += 4;
        }

        const baseOffset = baseDataOffset !== null ? baseDataOffset : box.offset;
        let runningPos = null;

        for (const trun of findAllBoxes(trafChildren, "trun")) {
          const to = trun.dataOffset;
          const trunVersion = bytes[to];
          const trunFlags = (bytes[to + 1] << 16) | (bytes[to + 2] << 8) | bytes[to + 3];
          const count = readU32(bytes, to + 4);
          let tpos = to + 8;

          const hasDataOffset = Boolean(trunFlags & 0x000001);
          let dataOffset = 0;
          if (hasDataOffset) {
            dataOffset = readI32(bytes, tpos);
            tpos += 4;
          }

          const hasFirstSampleFlags = Boolean(trunFlags & 0x000004);
          let firstSampleFlags = 0;
          if (hasFirstSampleFlags) {
            firstSampleFlags = readU32(bytes, tpos);
            tpos += 4;
          }

          let samplePos;
          if (hasDataOffset) {
            samplePos = baseOffset + dataOffset;
          } else if (runningPos !== null) {
            samplePos = runningPos;
          } else if (baseDataOffset !== null) {
            samplePos = baseDataOffset;
          } else if (nextMdat) {
            samplePos = nextMdat.dataOffset;
          } else {
            samplePos = baseOffset;
          }

          for (let i = 0; i < count; i++) {
            let duration = defaultDuration;
            let size = defaultSize;
            let flags = i === 0 && hasFirstSampleFlags ? firstSampleFlags : defaultFlags;
            let cts = 0;

            if (trunFlags & 0x000100) {
              duration = readU32(bytes, tpos);
              tpos += 4;
            }
            if (trunFlags & 0x000200) {
              size = readU32(bytes, tpos);
              tpos += 4;
            }
            if (trunFlags & 0x000400) {
              flags = readU32(bytes, tpos);
              tpos += 4;
            }
            if (trunFlags & 0x000800) {
              cts = trunVersion === 0 ? readU32(bytes, tpos) : readI32(bytes, tpos);
              tpos += 4;
            }

            // ISO 14496-12 Section 8.8.3.1: bit 16 = sample_is_non_sync_sample (0 => keyframe)
            const isSync = ((flags >>> 16) & 1) === 0;

            if (samplePos >= 0 && samplePos + size <= bytes.length) {
              samples.push({
                offset: samplePos,
                size,
                duration,
                cts,
                isSync
              });
            }
            samplePos += size;
          }
          runningPos = samplePos;
        }
      }
    }

    return samples;
  }

  function extractTrack(bytes, expectedHandler) {
    const topBoxes = readBoxes(bytes, 0, bytes.length);
    const moov = findBox(topBoxes, "moov");
    if (!moov) {
      throw new Error("Invalid MP4: missing moov box.");
    }

    const moovChildren = readBoxes(bytes, moov.dataOffset, moov.dataEnd);
    const mvhd = findBox(moovChildren, "mvhd");
    let sourceMovieTimescale = 1000;
    if (mvhd) {
      const v = bytes[mvhd.dataOffset];
      sourceMovieTimescale = readU32(bytes, mvhd.dataOffset + (v === 1 ? 20 : 12)) || 1000;
    }

    const trexMap = parseTrexMap(bytes, moovChildren);
    const traks = findAllBoxes(moovChildren, "trak");
    if (traks.length === 0) {
      throw new Error("Invalid MP4: no tracks found in moov.");
    }

    let fallbackTrack = null;

    for (const trak of traks) {
      const trakChildren = readBoxes(bytes, trak.dataOffset, trak.dataEnd);
      const tkhd = findBox(trakChildren, "tkhd");
      const mdia = findBox(trakChildren, "mdia");
      if (!tkhd || !mdia) continue;

      const mdiaChildren = readBoxes(bytes, mdia.dataOffset, mdia.dataEnd);
      const mdhd = findBox(mdiaChildren, "mdhd");
      const hdlr = findBox(mdiaChildren, "hdlr");
      const minf = findBox(mdiaChildren, "minf");
      if (!mdhd || !hdlr || !minf) continue;

      const handlerType = readStr(bytes, hdlr.dataOffset + 8, 4);
      const minfChildren = readBoxes(bytes, minf.dataOffset, minf.dataEnd);
      const stbl = findBox(minfChildren, "stbl");
      if (!stbl) continue;

      const stblChildren = readBoxes(bytes, stbl.dataOffset, stbl.dataEnd);
      const stsd = findBox(stblChildren, "stsd");
      if (!stsd) continue;

      const tkhdVersion = bytes[tkhd.dataOffset];
      const trackId = readU32(bytes, tkhd.dataOffset + (tkhdVersion === 1 ? 20 : 12));

      const mdhdVersion = bytes[mdhd.dataOffset];
      const timescale = readU32(bytes, mdhd.dataOffset + (mdhdVersion === 1 ? 20 : 12)) || 1000;

      // Extract samples from standard stbl OR fragmented moof/mdat
      let samples = extractStandardSamples(bytes, stblChildren);
      const isFragmented = samples.length === 0;
      if (isFragmented) {
        samples = extractFragmentedSamples(bytes, topBoxes, trackId, trexMap.get(trackId));
      }

      if (samples.length === 0) continue;

      const mediaHeaderBox =
        findBox(minfChildren, "vmhd") ||
        findBox(minfChildren, "smhd") ||
        findBox(minfChildren, "nmhd");
      const dinfBox = findBox(minfChildren, "dinf");

      const parsed = {
        bytes,
        handlerType,
        trackId,
        timescale,
        sourceMovieTimescale,
        tkhdRaw: bytes.slice(tkhd.offset, tkhd.dataEnd),
        mdhdRaw: bytes.slice(mdhd.offset, mdhd.dataEnd),
        hdlrRaw: bytes.slice(hdlr.offset, hdlr.dataEnd),
        mediaHeaderRaw: mediaHeaderBox ? bytes.slice(mediaHeaderBox.offset, mediaHeaderBox.dataEnd) : null,
        dinfRaw: dinfBox ? bytes.slice(dinfBox.offset, dinfBox.dataEnd) : null,
        stsdRaw: bytes.slice(stsd.offset, stsd.dataEnd),
        elstEntries: parseElst(bytes, trakChildren),
        samples
      };

      if (!expectedHandler || handlerType === expectedHandler) {
        return parsed;
      }
      if (!fallbackTrack) fallbackTrack = parsed;
    }

    if (fallbackTrack) return fallbackTrack;
    throw new Error(`No usable ${expectedHandler || "media"} track found in MP4.`);
  }

  // -------------------- Standard Faststart MP4 Builder --------------------

  function groupSamplesIntoChunks(track, targetChunkSec) {
    const chunks = [];
    const targetTicks = Math.max(1, Math.round(track.timescale * targetChunkSec));
    let i = 0;
    let currentTicks = 0;

    while (i < track.samples.length) {
      const startTimeSec = currentTicks / track.timescale;
      const chunkSamples = [];
      let chunkTicks = 0;
      let chunkByteSize = 0;

      while (i < track.samples.length) {
        const s = track.samples[i];
        chunkSamples.push(s);
        chunkTicks += s.duration;
        chunkByteSize += s.size;
        currentTicks += s.duration;
        i++;
        if (chunkTicks >= targetTicks && chunkSamples.length > 0) break;
      }

      chunks.push({
        track,
        startTimeSec,
        samples: chunkSamples,
        byteSize: chunkByteSize,
        relOffset: 0
      });
    }

    return chunks;
  }

  function buildFtyp() {
    const payload = new Uint8Array(24);
    writeStr(payload, 0, "isom");
    writeU32(payload, 4, 0x00000200);
    writeStr(payload, 8, "isom");
    writeStr(payload, 12, "iso2");
    writeStr(payload, 16, "avc1");
    writeStr(payload, 20, "mp41");
    return makeBox("ftyp", payload);
  }

  function buildMvhd(movieTimescale, movieDuration, nextTrackId) {
    const useV1 = movieDuration > 0xffffffff;
    if (useV1) {
      const p = new Uint8Array(108);
      writeU64(p, 0, 0); // creation_time
      writeU64(p, 8, 0); // modification_time
      writeU32(p, 16, movieTimescale);
      writeU64(p, 20, movieDuration);
      writeU32(p, 28, 0x00010000); // rate 1.0
      writeU16(p, 32, 0x0100);     // volume 1.0
      // matrix at offset 44
      writeU32(p, 44, 0x00010000);
      writeU32(p, 60, 0x00010000);
      writeU32(p, 76, 0x40000000);
      writeU32(p, 104, nextTrackId);
      return makeFullBox("mvhd", 1, 0, p);
    }
    const p = new Uint8Array(96);
    writeU32(p, 0, 0); // creation_time
    writeU32(p, 4, 0); // modification_time
    writeU32(p, 8, movieTimescale);
    writeU32(p, 12, movieDuration);
    writeU32(p, 16, 0x00010000); // rate 1.0
    writeU16(p, 20, 0x0100);     // volume 1.0
    // identity matrix at offset 32
    writeU32(p, 32, 0x00010000);
    writeU32(p, 48, 0x00010000);
    writeU32(p, 64, 0x40000000);
    writeU32(p, 92, nextTrackId);
    return makeFullBox("mvhd", 0, 0, p);
  }

  function patchTkhd(tkhdRaw, newTrackId, durationMs, isAudio) {
    const out = new Uint8Array(tkhdRaw);
    // Box header is 8 bytes (standard size < 4GB)
    const version = out[8];
    // flags: track_enabled (1) | track_in_movie (2)
    out[9] = 0;
    out[10] = 0;
    out[11] = 3;

    if (version === 1) {
      writeU32(out, 8 + 20, newTrackId);
      writeU64(out, 8 + 28, durationMs);
      if (isAudio && readU16(out, 8 + 48) === 0) {
        writeU16(out, 8 + 48, 0x0100);
      }
    } else {
      writeU32(out, 8 + 12, newTrackId);
      writeU32(out, 8 + 20, Math.min(durationMs, 0xffffffff));
      if (isAudio && readU16(out, 8 + 36) === 0) {
        writeU16(out, 8 + 36, 0x0100);
      }
    }
    return out;
  }

  function patchMdhd(mdhdRaw, trackDuration) {
    const out = new Uint8Array(mdhdRaw);
    const version = out[8];
    if (version === 1) {
      writeU64(out, 8 + 24, trackDuration);
    } else {
      writeU32(out, 8 + 16, Math.min(trackDuration, 0xffffffff));
    }
    return out;
  }

  function buildEdts(elstEntries, sourceMovieTimescale, movieTimescale, trackDurationMs) {
    if (!elstEntries || elstEntries.length === 0) return null;
    const scaled = elstEntries.map((e) => {
      let segDur =
        e.segmentDuration === 0
          ? trackDurationMs
          : Math.round((e.segmentDuration / (sourceMovieTimescale || 1000)) * movieTimescale);
      return {
        segmentDuration: Math.max(0, segDur),
        mediaTime: e.mediaTime,
        mediaRateInteger: e.mediaRateInteger,
        mediaRateFraction: e.mediaRateFraction
      };
    });

    const useV1 = scaled.some(
      (e) => e.segmentDuration > 0xffffffff || e.mediaTime > 0x7fffffff || e.mediaTime < -0x80000000
    );

    if (useV1) {
      const p = new Uint8Array(4 + scaled.length * 20);
      writeU32(p, 0, scaled.length);
      let pos = 4;
      for (const e of scaled) {
        writeU64(p, pos, e.segmentDuration);
        // signed 64-bit write
        const hi = Math.floor(e.mediaTime / 4294967296);
        const lo = e.mediaTime >>> 0;
        writeU32(p, pos + 8, hi >>> 0);
        writeU32(p, pos + 12, lo);
        writeU16(p, pos + 16, e.mediaRateInteger & 0xffff);
        writeU16(p, pos + 18, e.mediaRateFraction & 0xffff);
        pos += 20;
      }
      return makeBox("edts", makeFullBox("elst", 1, 0, p));
    }

    const p = new Uint8Array(4 + scaled.length * 12);
    writeU32(p, 0, scaled.length);
    let pos = 4;
    for (const e of scaled) {
      writeU32(p, pos, e.segmentDuration);
      writeI32(p, pos + 4, e.mediaTime);
      writeU16(p, pos + 8, e.mediaRateInteger & 0xffff);
      writeU16(p, pos + 10, e.mediaRateFraction & 0xffff);
      pos += 12;
    }
    return makeBox("edts", makeFullBox("elst", 0, 0, p));
  }

  function buildDefaultDinf() {
    const urlBox = makeFullBox("url ", 0, 1);
    const drefPayload = new Uint8Array(4 + urlBox.length);
    writeU32(drefPayload, 0, 1);
    drefPayload.set(urlBox, 4);
    return makeBox("dinf", makeFullBox("dref", 0, 0, drefPayload));
  }

  function buildStts(samples) {
    const runs = [];
    for (let i = 0; i < samples.length; i++) {
      const d = samples[i].duration;
      if (runs.length > 0 && runs[runs.length - 1].delta === d) {
        runs[runs.length - 1].count++;
      } else {
        runs.push({ count: 1, delta: d });
      }
    }
    const p = new Uint8Array(4 + runs.length * 8);
    writeU32(p, 0, runs.length);
    let pos = 4;
    for (const r of runs) {
      writeU32(p, pos, r.count);
      writeU32(p, pos + 4, r.delta);
      pos += 8;
    }
    return makeFullBox("stts", 0, 0, p);
  }

  function buildCtts(samples) {
    let hasNonZero = false;
    let hasNegative = false;
    for (let i = 0; i < samples.length; i++) {
      const c = samples[i].cts;
      if (c !== 0) hasNonZero = true;
      if (c < 0) hasNegative = true;
    }
    if (!hasNonZero) return null;

    const runs = [];
    for (let i = 0; i < samples.length; i++) {
      const c = samples[i].cts;
      if (runs.length > 0 && runs[runs.length - 1].offset === c) {
        runs[runs.length - 1].count++;
      } else {
        runs.push({ count: 1, offset: c });
      }
    }

    const p = new Uint8Array(4 + runs.length * 8);
    writeU32(p, 0, runs.length);
    let pos = 4;
    for (const r of runs) {
      writeU32(p, pos, r.count);
      if (hasNegative) writeI32(p, pos + 4, r.offset);
      else writeU32(p, pos + 4, r.offset);
      pos += 8;
    }
    return makeFullBox("ctts", hasNegative ? 1 : 0, 0, p);
  }

  function buildStss(samples) {
    const syncIndices = [];
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].isSync) syncIndices.push(i + 1);
    }
    // Omit stss if all samples are sync samples (standard MP4 convention)
    if (syncIndices.length === 0 || syncIndices.length === samples.length) {
      return null;
    }
    const p = new Uint8Array(4 + syncIndices.length * 4);
    writeU32(p, 0, syncIndices.length);
    let pos = 4;
    for (let i = 0; i < syncIndices.length; i++) {
      writeU32(p, pos, syncIndices[i]);
      pos += 4;
    }
    return makeFullBox("stss", 0, 0, p);
  }

  function buildStsc(trackChunks) {
    const entries = [];
    let prevSpc = -1;
    for (let i = 0; i < trackChunks.length; i++) {
      const spc = trackChunks[i].samples.length;
      if (spc !== prevSpc) {
        entries.push({ firstChunk: i + 1, samplesPerChunk: spc, descIndex: 1 });
        prevSpc = spc;
      }
    }
    const p = new Uint8Array(4 + entries.length * 12);
    writeU32(p, 0, entries.length);
    let pos = 4;
    for (const e of entries) {
      writeU32(p, pos, e.firstChunk);
      writeU32(p, pos + 4, e.samplesPerChunk);
      writeU32(p, pos + 8, e.descIndex);
      pos += 12;
    }
    return makeFullBox("stsc", 0, 0, p);
  }

  function buildStsz(samples) {
    const p = new Uint8Array(8 + samples.length * 4);
    writeU32(p, 0, 0); // variable sample sizes
    writeU32(p, 4, samples.length);
    let pos = 8;
    for (let i = 0; i < samples.length; i++) {
      writeU32(p, pos, samples[i].size);
      pos += 4;
    }
    return makeFullBox("stsz", 0, 0, p);
  }

  function buildChunkOffsetBox(trackChunks, mdatDataStart, useCo64) {
    if (useCo64) {
      const p = new Uint8Array(4 + trackChunks.length * 8);
      writeU32(p, 0, trackChunks.length);
      let pos = 4;
      for (let i = 0; i < trackChunks.length; i++) {
        writeU64(p, pos, mdatDataStart + trackChunks[i].relOffset);
        pos += 8;
      }
      return makeFullBox("co64", 0, 0, p);
    }
    const p = new Uint8Array(4 + trackChunks.length * 4);
    writeU32(p, 0, trackChunks.length);
    let pos = 4;
    for (let i = 0; i < trackChunks.length; i++) {
      writeU32(p, pos, mdatDataStart + trackChunks[i].relOffset);
      pos += 4;
    }
    return makeFullBox("stco", 0, 0, p);
  }

  function buildTrak(track, newTrackId, trackChunks, movieTimescale, mdatDataStart, useCo64) {
    const isAudio = track.handlerType === "soun";
    let trackDuration = 0;
    for (let i = 0; i < track.samples.length; i++) {
      trackDuration += track.samples[i].duration;
    }
    const trackDurationMs = Math.round((trackDuration / track.timescale) * movieTimescale);

    const tkhd = patchTkhd(track.tkhdRaw, newTrackId, trackDurationMs, isAudio);
    const edts = buildEdts(track.elstEntries, track.sourceMovieTimescale, movieTimescale, trackDurationMs);
    const mdhd = patchMdhd(track.mdhdRaw, trackDuration);

    const stblParts = [
      track.stsdRaw,
      buildStts(track.samples)
    ];
    const ctts = buildCtts(track.samples);
    if (ctts) stblParts.push(ctts);

    if (!isAudio) {
      const stss = buildStss(track.samples);
      if (stss) stblParts.push(stss);
    }

    stblParts.push(
      buildStsc(trackChunks),
      buildStsz(track.samples),
      buildChunkOffsetBox(trackChunks, mdatDataStart, useCo64)
    );

    const stbl = makeBox("stbl", ...stblParts);

    const mediaHeader =
      track.mediaHeaderRaw ||
      (isAudio ? makeFullBox("smhd", 0, 0, new Uint8Array(4)) : makeFullBox("vmhd", 0, 1, new Uint8Array(8)));
    const dinf = track.dinfRaw || buildDefaultDinf();
    const minf = makeBox("minf", mediaHeader, dinf, stbl);
    const mdia = makeBox("mdia", mdhd, track.hdlrRaw, minf);

    const trakParts = [tkhd];
    if (edts) trakParts.push(edts);
    trakParts.push(mdia);

    return {
      box: makeBox("trak", ...trakParts),
      durationMs: trackDurationMs
    };
  }

  /**
   * Mux a video-only MP4 (Uint8Array) and optional audio-only MP4 (Uint8Array | null)
   * into a single standard faststart MP4 Blob.
   */
  function mux(videoBytes, audioBytes) {
    const vBytes = videoBytes instanceof Uint8Array ? videoBytes : new Uint8Array(videoBytes);
    const videoTrack = extractTrack(vBytes, "vide");

    let audioTrack = null;
    if (audioBytes && audioBytes.byteLength > 0) {
      const aBytes = audioBytes instanceof Uint8Array ? audioBytes : new Uint8Array(audioBytes);
      audioTrack = extractTrack(aBytes, "soun");
    }

    // Group samples into ~1-second chunks and interleave chronologically
    const videoChunks = groupSamplesIntoChunks(videoTrack, 1.0);
    const audioChunks = audioTrack ? groupSamplesIntoChunks(audioTrack, 1.0) : [];

    const allChunks = [];
    let vi = 0;
    let ai = 0;
    while (vi < videoChunks.length || ai < audioChunks.length) {
      if (ai >= audioChunks.length) {
        allChunks.push(videoChunks[vi++]);
      } else if (vi >= videoChunks.length) {
        allChunks.push(audioChunks[ai++]);
      } else if (videoChunks[vi].startTimeSec <= audioChunks[ai].startTimeSec) {
        allChunks.push(videoChunks[vi++]);
      } else {
        allChunks.push(audioChunks[ai++]);
      }
    }

    // Assign relative offsets inside mdat payload & collect zero-copy sample slices
    let mdatPayloadSize = 0;
    const mediaSlices = [];
    for (let i = 0; i < allChunks.length; i++) {
      const ch = allChunks[i];
      ch.relOffset = mdatPayloadSize;
      const src = ch.track.bytes;
      for (let j = 0; j < ch.samples.length; j++) {
        const s = ch.samples[j];
        mediaSlices.push(src.subarray(s.offset, s.offset + s.size));
        mdatPayloadSize += s.size;
      }
    }

    const ftyp = buildFtyp();
    const movieTimescale = 1000;
    const useCo64 = mdatPayloadSize > 0xf0000000;
    const mdatHeaderSize = mdatPayloadSize + 8 > 0xffffffff ? 16 : 8;

    function buildMoov(mdatDataStart) {
      const vBuilt = buildTrak(videoTrack, 1, videoChunks, movieTimescale, mdatDataStart, useCo64);
      const traks = [vBuilt.box];
      let movieDurationMs = vBuilt.durationMs;

      if (audioTrack) {
        const aBuilt = buildTrak(audioTrack, 2, audioChunks, movieTimescale, mdatDataStart, useCo64);
        traks.push(aBuilt.box);
        movieDurationMs = Math.max(movieDurationMs, aBuilt.durationMs);
      }

      const mvhd = buildMvhd(movieTimescale, movieDurationMs, audioTrack ? 3 : 2);
      return makeBox("moov", mvhd, ...traks);
    }

    // Two-pass layout: pass 1 computes exact moov size, pass 2 writes exact stco/co64 offsets
    const moovPass1 = buildMoov(0);
    const mdatDataStart = ftyp.length + moovPass1.length + mdatHeaderSize;
    const moov = buildMoov(mdatDataStart);

    // Build mdat header
    let mdatHeader;
    if (mdatHeaderSize === 16) {
      mdatHeader = new Uint8Array(16);
      writeU32(mdatHeader, 0, 1);
      writeStr(mdatHeader, 4, "mdat");
      writeU64(mdatHeader, 8, mdatPayloadSize + 16);
    } else {
      mdatHeader = new Uint8Array(8);
      writeU32(mdatHeader, 0, mdatPayloadSize + 8);
      writeStr(mdatHeader, 4, "mdat");
    }

    return new Blob([ftyp, moov, mdatHeader, ...mediaSlices], { type: "video/mp4" });
  }

  global.RedMuxMP4 = {
    mux,
    extractTrack
  };
})(typeof self !== "undefined" ? self : window);
