/* AAC/M4A -> fragmented MP4, without decoding or re-encoding audio.
 * Only the AAC-LC / 24 kHz / mono files produced by Trans are accepted.
 * The persistent IndexedDB files are never changed. */
const ReaderAudio = (() => {
  const MIME = 'audio/mp4; codecs="mp4a.40.2"';
  const RATE = 24000;
  const FRAME = 1024;
  const fail = () => { throw new Error("音频缓存格式损坏或不受支持，请重新下载对应章节"); };
  const join = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
  };
  const words = (...values) => {
    const bytes = new Uint8Array(values.length * 4);
    const view = new DataView(bytes.buffer);
    values.forEach((value, i) => view.setUint32(i * 4, value));
    return bytes;
  };
  const box = (type, ...parts) => join(words(8 + parts.reduce((n, p) => n + p.length, 0)),
    Uint8Array.from(type, (c) => c.charCodeAt(0)), ...parts);

  function remux(buffer, sequence, ticks) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const u32 = (offset) => view.getUint32(offset);
    const children = (start, end) => {
      const result = [];
      while (start < end) {
        if (start + 8 > end) fail();
        const length = u32(start) || end - start;
        if (length < 8 || start + length > end) fail();
        result.push({ start, end: start + length,
          type: String.fromCharCode(...bytes.subarray(start + 4, start + 8)) });
        start += length;
      }
      return result;
    };
    const child = (parent, type) => children(parent.start + 8, parent.end).find((item) => item.type === type) || fail();
    const raw = (item) => bytes.slice(item.start, item.end);
    const full = (item, minLength) => {
      if (item.end - item.start < minLength || bytes[item.start + 8] !== 0) fail();
      return item.start;
    };
    const table = (item, columns, header = 16) => {
      const start = full(item, header);
      const count = u32(start + header - 4);
      if (count > 1000000 || header + count * columns * 4 !== item.end - start) fail();
      return Array.from({ length: count }, (_, i) => Array.from({ length: columns },
        (_, j) => u32(start + header + (i * columns + j) * 4)));
    };
    const roots = children(0, bytes.length);
    const moov = roots.find((item) => item.type === "moov") || fail();
    const tracks = children(moov.start + 8, moov.end).filter((item) => item.type === "trak");
    if (tracks.length !== 1) fail();
    const trak = tracks[0], mdia = child(trak, "mdia"), minf = child(mdia, "minf"), stbl = child(minf, "stbl");
    const mvhd = raw(child(moov, "mvhd")), tkhd = raw(child(trak, "tkhd")), mdhd = raw(child(mdia, "mdhd"));
    if (mvhd[8] || tkhd[8] || mdhd[8] || mdhd.length < 32 || tkhd.length < 92 || mvhd.length < 108) fail();
    if (new DataView(mdhd.buffer).getUint32(20) !== RATE) fail();
    const stsd = child(stbl, "stsd");
    if (u32(full(stsd, 52) + 12) !== 1) fail();
    const entry = children(stsd.start + 16, stsd.end)[0];
    if (entry.type !== "mp4a" || entry.end - entry.start < 36
      || view.getUint16(entry.start + 16) !== 0
      || view.getUint16(entry.start + 24) !== 1 || u32(entry.start + 32) !== RATE * 65536) fail();
    const esds = children(entry.start + 36, entry.end).find((item) => item.type === "esds") || fail();
    const descriptor = (pos, end, tag) => {
      if (bytes[pos++] !== tag) fail();
      let length = 0, count = 0, value;
      do {
        if (pos >= end || ++count > 4) fail();
        value = bytes[pos++]; length = length * 128 + (value & 127);
      } while (value & 128);
      if (pos + length > end) fail();
      return { pos, end: pos + length };
    };
    const es = descriptor(esds.start + 12, esds.end, 3);
    // Trans's FFmpeg writer emits no optional ES dependencies or URL fields.
    if (es.pos + 3 > es.end || bytes[es.pos + 2] !== 0) fail();
    const decoder = descriptor(es.pos + 3, es.end, 4);
    if (decoder.pos + 13 > decoder.end || bytes[decoder.pos] !== 0x40) fail();
    const asc = descriptor(decoder.pos + 13, decoder.end, 5);
    if (asc.end - asc.pos < 2 || bytes[asc.pos] !== 0x13 || bytes[asc.pos + 1] !== 0x08) fail();

    const sizesBox = child(stbl, "stsz"), sizeStart = full(sizesBox, 20);
    const fixedSize = u32(sizeStart + 12), count = u32(sizeStart + 16);
    if (!count || count > 1000000 || sizesBox.end - sizeStart !== 20 + (fixedSize ? 0 : count * 4)) fail();
    const sizes = Array.from({ length: count }, (_, i) => fixedSize || u32(sizeStart + 20 + i * 4));
    const durations = table(child(stbl, "stts"), 2);
    if (durations.reduce((n, row) => n + row[0], 0) !== count
      || durations.some(([n, d]) => !n || !d || d > FRAME)) fail();
    const chunks = table(child(stbl, "stco"), 1);
    const runs = table(child(stbl, "stsc"), 3);
    if (!chunks.length || !runs.length || runs[0][0] !== 1
      || runs.some(([first, n, id], i) => !n || id !== 1 || first > chunks.length || (i && first <= runs[i - 1][0]))) fail();
    const media = roots.filter((item) => item.type === "mdat");
    const payloadSize = sizes.reduce((n, size) => n + size, 0);
    if (payloadSize > bytes.length) fail();
    const payload = new Uint8Array(payloadSize);
    let sample = 0, output = 0, run = 0;
    chunks.forEach(([offset], i) => {
      if (runs[run + 1]?.[0] === i + 1) run += 1;
      for (let j = 0; j < runs[run][1]; j += 1) {
        const size = sizes[sample++];
        if (!size || !media.some((part) => offset >= part.start + 8 && offset + size <= part.end)) fail();
        payload.set(bytes.subarray(offset, offset + size), output);
        output += size; offset += size;
      }
    });
    if (sample !== count) fail();
    let priming = 0;
    const edts = children(trak.start + 8, trak.end).find((item) => item.type === "edts");
    if (edts) {
      const elst = child(edts, "elst"), start = full(elst, 28);
      if (u32(start + 12) !== 1 || u32(start + 24) !== 65536) fail();
      priming = view.getInt32(start + 20);
      if (priming < 0 || priming > FRAME * 2) fail();
    }
    // Normalize the track ID and remove finite file durations / edit lists.
    // Preserve priming frames; sentence timestamps account for their delay.
    new DataView(tkhd.buffer).setUint32(20, 1);
    new DataView(tkhd.buffer).setUint32(28, 0);
    new DataView(mvhd.buffer).setUint32(24, 0);
    new DataView(mdhd.buffer).setUint32(24, 0);
    const init = join(box("ftyp", Uint8Array.from("iso6", c => c.charCodeAt(0)), words(0),
      Uint8Array.from("iso6mp41", c => c.charCodeAt(0))),
    box("moov", mvhd, box("trak", tkhd, box("mdia", mdhd, raw(child(mdia, "hdlr")),
      box("minf", raw(child(minf, "smhd")), raw(child(minf, "dinf")),
        box("stbl", raw(stsd), box("stts", words(0, 0)), box("stsc", words(0, 0)),
          box("stsz", words(0, 0, 0)), box("stco", words(0, 0)))))),
    box("mvex", box("trex", words(0, 1, 1, FRAME, 0, 0)))));
    const sampleSizes = new Uint8Array(count * 4);
    const sizeView = new DataView(sampleSizes.buffer);
    sizes.forEach((size, i) => sizeView.setUint32(i * 4, size));
    const makeMoof = (offset) => box("moof", box("mfhd", words(0, sequence)),
      box("traf", box("tfhd", words(0x020008, 1, FRAME)),
        box("tfdt", words(0x01000000, Math.floor(ticks / 4294967296), ticks % 4294967296)),
        box("trun", words(0x201, count, offset), sampleSizes)));
    const moof = makeMoof(0);
    // Old multi-sentence packs may contain shortened samples at concatenation
    // boundaries. AAC still decodes 1024 samples per frame. Map the original
    // sentence timestamps through stts instead of accumulating padding drift.
    const sourceTicks = durations.reduce((total, [n, d]) => total + n * d, 0);
    const mapTime = (seconds) => {
      const target = Math.max(0, Math.min(sourceTicks, seconds * RATE + priming));
      let source = 0, output = 0;
      for (const [n, d] of durations) {
        if (target <= source + n * d) return (output + (target - source) * FRAME / d) / RATE;
        source += n * d;
        output += n * FRAME;
      }
      return output / RATE;
    };
    return { init, fragment: join(makeMoof(moof.length + 8), box("mdat", payload)),
      ticks: count * FRAME, duration: count * FRAME / RATE,
      sourceDuration: (sourceTicks - priming) / RATE, mapTime };

  }

  function mediaSourceClass() {
    return [window.MediaSource, window.ManagedMediaSource].find((type) => type?.isTypeSupported(MIME));
  }

  class Timeline {
    constructor(audio, signal, wake) {
      this.audio = audio;
      this.signal = signal;
      this.media = new (mediaSourceClass())();
      this.url = URL.createObjectURL(this.media);
      this.ticks = 0;
      this.sequence = 0;
      this.fragments = [];
      this.wake = wake;
      this.media.addEventListener("startstreaming", wake, { signal });
    }
    async open() {
      const ready = this.wait(this.media, "sourceopen");
      // iPhone's ManagedMediaSource requires remote playback to be disabled.
      this.audio.disableRemotePlayback = true;
      this.audio.src = this.url;
      await ready;
      this.buffer = this.media.addSourceBuffer(MIME);
      this.buffer.addEventListener("bufferedchange", () => {
        if (this.needsRepair()) this.wake();
      }, { signal: this.signal });
    }
    wait(target, event, action) {
      return new Promise((resolve, reject) => {
        const done = (error) => {
          target.removeEventListener(event, success);
          target.removeEventListener("error", failed);
          this.signal.removeEventListener("abort", aborted);
          clearTimeout(timer);
          error ? reject(error) : resolve();
        };
        const success = () => done();
        const failed = () => done(new Error("连续音频解码失败"));
        const aborted = () => done(new DOMException("播放已停止", "AbortError"));
        const timer = setTimeout(() => done(new Error("连续音频处理超时")), 15000);
        target.addEventListener(event, success, { once: true });
        target.addEventListener("error", failed, { once: true });
        this.signal.addEventListener("abort", aborted, { once: true });
        if (this.signal.aborted) { aborted(); return; }
        try { action?.(); } catch (error) { done(error); }
      });
    }
    async append(blob, expectedDuration) {
      const data = remux(await blob.arrayBuffer(), this.sequence + 1, this.ticks);
      if (this.signal.aborted) throw new DOMException("播放已停止", "AbortError");
      if (!Number.isFinite(expectedDuration) || Math.abs(data.sourceDuration - expectedDuration) > 0.1) fail();
      const cutoff = Math.max(0, this.audio.currentTime - 30);
      if (this.buffer.buffered.length && this.buffer.buffered.start(0) + 10 < cutoff) {
        await this.wait(this.buffer, "updateend", () => this.buffer.remove(0, cutoff));
      }
      if (!this.sequence) await this.wait(this.buffer, "updateend", () => this.buffer.appendBuffer(data.init));
      await this.wait(this.buffer, "updateend", () => this.buffer.appendBuffer(data.fragment));
      const offset = this.ticks / RATE;
      this.fragments = this.fragments.filter((item) => item.end >= cutoff);
      this.fragments.push({ start: offset, end: offset + data.duration, data: data.fragment });
      this.ticks += data.ticks;
      this.sequence += 1;
      return { offset, duration: data.duration, position: data.mapTime };
    }
    missing(fragment, ahead = 15) {
      const start = Math.max(fragment.start, this.audio.currentTime);
      const end = Math.min(fragment.end, this.audio.currentTime + ahead);
      if (end <= start + 0.02) return false;
      const ranges = this.buffer.buffered;
      for (let i = 0; i < ranges.length; i += 1) {
        if (ranges.start(i) <= start + 0.02 && ranges.end(i) >= end - 0.02) return false;
      }
      return true;
    }
    needsRepair() { return !!this.buffer && this.fragments.some((item) => this.missing(item)); }
    async repair() {
      // ManagedMediaSource may evict unplayed data. Retain only the current
      // compressed window and restore the next 15 seconds, without re-download
      // or fighting the browser's decision to discard more distant buffers.
      this.fragments = this.fragments.filter((item) => item.end >= this.audio.currentTime - 30);
      for (const fragment of this.fragments) {
        if (this.missing(fragment)) {
          await this.wait(this.buffer, "updateend", () => this.buffer.appendBuffer(fragment.data));
        }
      }
    }
    end() {
      if (this.media.readyState === "open" && !this.buffer.updating
        && !this.fragments.some((item) => this.missing(item, Infinity))) this.media.endOfStream();
    }
    close() { this.fragments = []; URL.revokeObjectURL(this.url); }
  }
  return { mediaSourceClass, Timeline, remux };
})();
