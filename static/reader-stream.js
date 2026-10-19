/* One listening session owns the timeline, sentence position and media events.
 * Browsers consume the same AAC packs from IndexedDB or the server. */
function streamIsCurrent(stream) {
  return readerState.ttsStream === stream && readerState.ttsToken === stream.token && !stream.closed;
}

async function streamRequest(path, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const parent = options.signal;
  const abort = () => controller.abort();
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) abort();
  const timeout = window.setTimeout(abort, timeoutMs);
  try {
    return await api(path, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
    parent?.removeEventListener("abort", abort);
  }
}

class ReaderPackSource {
  constructor(stream, index) {
    this.stream = stream;
    this.chapter = readerState.currentChapter;
    this.index = index;
    this.chapters = new Map([[this.chapter, Promise.resolve({
      book: readerState.currentBook, chapter: readerState.currentChapterData,
    })]]);
    this.pending = new Map();
  }
  async chapterData(index) {
    if (!this.chapters.has(index)) {
      const pending = streamRequest(`/api/books/${this.stream.bookId}/chapters/${index}`,
        { signal: this.stream.abort.signal }).then((data) => {
        if (data.book.content_revision !== this.stream.revision) throw new Error("书籍内容已变化，请重新打开书籍");
        return data;
      }).catch((error) => { this.chapters.delete(index); throw error; });
      this.chapters.set(index, pending);
    }
    return this.chapters.get(index);
  }
  request(chapter, index, text, priority) {
    const key = `${chapter}:${index}`;
    if (!this.pending.has(key)) {
      // Store rejections as values: speculative failures are retried only when needed.
      const promise = this.read(chapter, index, text, priority)
        .then((pack) => ({ pack }), (error) => ({ error }));
      this.pending.set(key, promise);
    }
    return this.pending.get(key);
  }
  async read(chapter, index, text, priority) {
    const stream = this.stream;
    const local = await promiseWithTimeout(localOfflinePackForChapter(
      stream.bookId, stream.profile, chapter, index, text), 8000, "读取本机缓存超时").catch(() => null);
    if (!streamIsCurrent(stream)) throw new DOMException("播放已停止", "AbortError");
    let raw = local, blob = local?.blob;
    if (!local) {
      if (navigator.onLine === false) {
        const error = new Error("本机缺少后续音频，请联网后继续");
        error.name = "NetworkError";
        throw error;
      }
      const started = performance.now();
      raw = await streamRequest("/api/reader/tts-pack", { method: "POST", signal: stream.abort.signal,
        body: JSON.stringify({ book_id: stream.bookId, chapter_index: chapter,
          sentence_index: index, prefetch_distance: priority }) }, TTS_AUDIO_READY_TIMEOUT_MS);
      if (!streamIsCurrent(stream)) throw new DOMException("播放已停止", "AbortError");
      blob = await fetchPackBlob(raw.url, stream.abort.signal);
      stream.prepareMs = Math.max(performance.now() - started, stream.prepareMs * 0.75);
    }
    return { ...normalizedPackManifest(raw, blob, text, {
      bookId: stream.bookId, chapterIndex: chapter, profileKey: stream.profile,
    }), blob, source: local ? "local" : "server" };
  }
  async next() {
    while (this.chapter < this.stream.chapterCount && streamIsCurrent(this.stream)) {
      const data = await this.chapterData(this.chapter);
      const text = chapterSentenceTextMap(data.chapter);
      const index = [...text.keys()].find((i) => i >= this.index && hasReadableText(text.get(i)));
      if (index === undefined) { this.chapter += 1; this.index = 0; continue; }
      const key = `${this.chapter}:${index}`;
      const result = await this.request(this.chapter, index, text, 0);
      this.pending.delete(key);
      if (!streamIsCurrent(this.stream)) throw new DOMException("播放已停止", "AbortError");
      if (result.error) throw result.error;
      const pack = result.pack;
      if (!pack.segments.some((segment) => segment.index === index)) throw new Error("播放包缺少当前句，请重新生成对应章节");
      this.index = pack.endSentenceIndex + 1;
      for (const key of this.pending.keys()) {
        const [chapter, index] = key.split(":").map(Number);
        if (chapter < this.chapter || chapter === this.chapter && index < this.index) this.pending.delete(key);
      }
      // Two nearby packs in flight, independent of the source. No chapter-wide download.
      if (!readerState.paused && !readerState.sleepPausePending) {
        for (const [distance, next] of pack.nextStartSentenceIndexes.slice(0, 2).entries()) {
          this.request(this.chapter, next, text, distance + 1);
        }
      }
      return pack;
    }
    return null;
  }
  prune(sentences) {
    const keep = new Set(sentences.map((item) => item.chapterIndex));
    keep.add(this.chapter);
    for (const index of this.chapters.keys()) if (!keep.has(index)) this.chapters.delete(index);
  }
}

function closeContinuousListening() {
  const stream = readerState.ttsStream;
  if (!stream) return;
  readerState.ttsStream = null;
  stream.closed = true;
  stream.abort.abort();
  window.clearTimeout(stream.pumpTimer);
  stream.timeline?.close();
  stream.source?.pending.clear();
  stream.source?.chapters.clear();
}

function syncStreamSentence(stream, segmentOverride = null) {
  if (!streamIsCurrent(stream)) return Promise.resolve();
  if (stream.syncing) return stream.syncing;
  const task = (async () => {
    const segment = segmentOverride || playbackSegmentAtTime(stream.sentences, readerState.ttsAudio.currentTime);
    if (!segment) return;
    try {
      let changedChapter = false;
      if (segment.chapterIndex !== readerState.currentChapter) {
        const data = await stream.source.chapterData(segment.chapterIndex);
        if (!streamIsCurrent(stream)) return;
        readerState.currentBook = data.book;
        readerState.currentChapter = data.chapter.index;
        syncChapterSelection();
        renderChapter(data.chapter);
        setStatus(data.book.title);
        changedChapter = true;
      }
      readerState.ttsPlaybackSegments = stream.sentences;
      if (changedChapter || readerState.currentSentence !== segment.index || !readerState.progressFollowsAudio) {
        highlightSentence(segment.index, true);
        updateMediaSessionMetadata();
        saveProgressSoon();
        if (!readerState.paused) setListenStatus(`正在朗读：第 ${Number(segment.index) + 1} 句`);
      }
    } catch { /* A text refresh failure must not interrupt already buffered audio. */ }
  })();
  stream.syncing = task.finally(() => { stream.syncing = null; });
  return stream.syncing;
}

function failContinuousListening(stream, error) {
  if (!streamIsCurrent(stream)) return;
  recordPlaybackEvent("play_error", error);
  setListenStatus(error.message || "连续播放失败，请重试");
  stopListening(false);
}

async function appendListeningPack(stream, pack) {
  const timing = await stream.timeline.append(pack.blob, pack.duration);
  if (!streamIsCurrent(stream)) return;
  const offset = timing.offset;
  const first = stream.sentences.length === 0 && !stream.started;
  const sentences = pack.segments.filter((item) => !first || (pack.chapterIndex !== stream.startChapter || item.index >= stream.startIndex))
    .map((item) => ({ chapterIndex: pack.chapterIndex, index: item.index,
      start: offset + timing.position(item.start), end: offset + timing.position(item.end) }));
  if (first) stream.initial = sentences[0].start;
  stream.sentences.push(...sentences);
  stream.end = timing.offset + timing.duration;
  readerState.ttsPlaybackSegments = stream.sentences;
  recordPlaybackEvent("buffer_ready");
}

function pumpContinuousListening(stream = readerState.ttsStream) {
  if (!stream || !streamIsCurrent(stream) || !stream.started || !stream.timeline || stream.pumping) return;
  if (readerState.paused || readerState.sleepPausePending) return;
  const repair = stream.timeline.needsRepair();
  if (stream.done && !repair) { stream.timeline.end(); return; }
  if (stream.timeline.media.streaming === false && !repair) return;
  if (Date.now() < stream.retryAt) {
    window.clearTimeout(stream.pumpTimer);
    stream.pumpTimer = window.setTimeout(() => pumpContinuousListening(stream), Math.min(2147483647, stream.retryAt - Date.now()));
    return;
  }
  const audio = readerState.ttsAudio;
  const task = (async () => {
    await stream.timeline.repair();
    if (!streamIsCurrent(stream)) return;
    if (stream.done) { stream.timeline.end(); return; }
    while (streamIsCurrent(stream) && !readerState.paused && !readerState.sleepPausePending) {
      if (readerState.sleepDeadline && Date.now() >= readerState.sleepDeadline) { armSleepPause(); break; }
      if (stream.timeline.media.streaming === false) break;
      const rate = Math.max(0.8, audio.playbackRate || 1);
      const target = Math.min(120, Math.max(60, stream.prepareMs / 1000 * 3));
      const goal = readerState.sleepDeadline ? Math.min(target, Math.max(10, (readerState.sleepDeadline - Date.now()) / 1000 + 10)) : target;
      if ((stream.end - audio.currentTime) / rate >= goal) break;
      const pack = await stream.source.next();
      if (!streamIsCurrent(stream)) return;
      if (!pack) { stream.done = true; stream.timeline.end(); break; }
      try { await appendListeningPack(stream, pack); }
      catch (error) { failContinuousListening(stream, error); return; }
      stream.sentences = stream.sentences.filter((item) => item.end >= audio.currentTime - 30);
      readerState.ttsPlaybackSegments = stream.sentences;
      stream.source.prune(stream.sentences);
      stream.bufferError = null;
      stream.retryDelay = 0;
    }
  })().catch((error) => {
    if (!streamIsCurrent(stream)) return;
    recordPlaybackEvent("buffer_error", error);
    if (error.name === "Error" && (!error.status || [400, 401, 403, 404, 410].includes(error.status))) {
      failContinuousListening(stream, error); return;
    }
    stream.bufferError = error;
    stream.retryDelay = Math.min(60000, (stream.retryDelay || 2500) * 2);
    const retryAfter = Number(error.data?.retry_after);
    const delay = Math.max(stream.retryDelay, Number.isFinite(retryAfter * 1000) && retryAfter > 0 ? retryAfter * 1000 : 0);
    stream.retryAt = Date.now() + delay;
    // Keep playing ready audio. A temporary network failure never discards it.
    if (stream.end - audio.currentTime < 0.5) setListenStatus(error.message);
  }).finally(() => {
    stream.pumping = null;
    if (streamIsCurrent(stream) && !stream.done && !readerState.paused && !readerState.sleepPausePending
      && stream.timeline.media.streaming !== false) {
      window.clearTimeout(stream.pumpTimer);
      stream.pumpTimer = window.setTimeout(() => pumpContinuousListening(stream), 2000);
    }
  });
  stream.pumping = task;
}

function bindListeningEvents(stream, audio) {
  audio.onloadedmetadata = () => {
    if (!streamIsCurrent(stream) || stream.positioned) return;
    stream.positioned = true;
    audio.currentTime = stream.initial;
    applyAudioPlaybackRate(audio);
  };
  audio.onplaying = () => {
    if (!streamIsCurrent(stream)) return;
    readerState.paused = false;
    updateListenButtons();
    recordPlaybackEvent("playing");
    setMediaSessionPlaybackState("playing");
    setListenStatus(`正在朗读：第 ${readerState.currentSentence + 1} 句`);
    pumpContinuousListening();
    if (readerState.sleepPausePending) {
      if (!Number.isFinite(readerState.sleepPauseTarget?.time)) setSleepPauseTargetForCurrentAudio();
      scheduleSleepBoundaryPause();
    }
  };
  audio.onpause = () => {
    if (!streamIsCurrent(stream) || audio.ended) return;
    readerState.paused = true;
    updateListenButtons();
    recordPlaybackEvent("pause");
    setMediaSessionPlaybackState("paused");
    pumpContinuousListening();
  };
  audio.onwaiting = () => {
    if (!streamIsCurrent(stream)) return;
    recordPlaybackEvent("waiting");
    if (stream.bufferError) setListenStatus(stream.bufferError.message);
    pumpContinuousListening();
  };
  audio.onstalled = () => { if (streamIsCurrent(stream)) recordPlaybackEvent("stalled"); };
  audio.ontimeupdate = () => {
    if (!streamIsCurrent(stream)) return;
    if (readerState.sleepDeadline && Date.now() >= readerState.sleepDeadline) armSleepPause();
    const target = readerState.sleepPauseTarget;
    if (readerState.sleepPausePending && target && audio.currentTime >= target.time - 0.03) {
      finishListeningSleep(stream, target); return;
    }
    syncStreamSentence(stream);
    pumpContinuousListening();
    startSleepFadeIfNeeded(audio, target?.time);
  };
  audio.onended = async () => {
    if (!streamIsCurrent(stream)) return;
    recordPlaybackEvent("ended");
    try {
      if (!stream.done) throw new Error("音频流已中断，请点击继续重试");
      if (stream.syncing) await stream.syncing;
      await syncStreamSentence(stream);
      if (!streamIsCurrent(stream)) return;
      const synchronized = readerState.currentChapter === stream.sentences[stream.sentences.length - 1]?.chapterIndex;
      stopListening(false);
      if (synchronized) {
        readerState.chapterComplete = true;
        saveProgressSoon();
      }
      setListenStatus(synchronized ? "本书朗读完成" : "朗读已完成，章节进度同步失败，请刷新页面");
    } catch (error) { failContinuousListening(stream, error); }
  };
  audio.onerror = () => failContinuousListening(stream, new Error(audioErrorMessage(audio)));
}

async function finishListeningSleep(stream, target) {
  if (!streamIsCurrent(stream) || stream.finishingSleep) return;
  stream.finishingSleep = true;
  readerState.ttsAudio.pause();
  if (stream.syncing) await stream.syncing;
  await syncStreamSentence(stream, target);
  if (!streamIsCurrent(stream)) return;
  if (readerState.currentChapter === target.chapterIndex) finishSleepPause(target.index);
  else {
    stopListening(false);
    readerState.paused = true;
    updateListenButtons();
    setListenStatus("定时已暂停，章节进度同步失败，请刷新页面");
  }
}

async function startContinuousListening(index, token) {
  const stream = { token, bookId: readerState.currentBookId, revision: readerState.currentBook?.content_revision,
    profile: readerState.ttsConfig?.offline_profile_key, chapterCount: readerState.chapters.length,
    startIndex: index, startChapter: readerState.currentChapter, closed: false, abort: new AbortController(), sentences: [],
    initial: 0, end: 0, started: false, done: false, prepareMs: 0, retryAt: 0 };
  readerState.ttsStream = stream;
  const audio = readerState.ttsAudio || new Audio();
  readerState.ttsAudio = audio;
  audio.autoplay = false;
  audio.preload = "auto";
  audio.volume = 1;
  applyAudioPlaybackRate(audio);
  highlightSentence(index, true);
  setListenStatus("正在准备连续音频");
  updateMediaSessionMetadata();
  try {
    if (!ReaderAudio.mediaSourceClass()) {
      throw new Error("当前浏览器不支持连续听书，请使用最新版Chrome或者Safari浏览器");
    }
    stream.transport = "mse";
    stream.source = new ReaderPackSource(stream, index);
    stream.timeline = new ReaderAudio.Timeline(audio, stream.abort.signal, () => pumpContinuousListening(stream));
    await stream.timeline.open();
    const pack = await stream.source.next();
    if (!streamIsCurrent(stream)) return;
    if (!pack) throw new Error("没有可朗读文本");
    await appendListeningPack(stream, pack);
    if (!streamIsCurrent(stream)) return;
    bindListeningEvents(stream, audio);
    if (audio.readyState >= 1) audio.onloadedmetadata();
    stream.started = true;
    // One source and one initial play(), across packs, chapters and cache misses.
    const playing = audio.play();
    pumpContinuousListening(stream);
    await playing;
    if (streamIsCurrent(stream)) await syncStreamSentence(stream);
  } catch (error) {
    if (!streamIsCurrent(stream)) return;
    if (error.name === "NotAllowedError" && stream.started) {
      recordPlaybackEvent("play_error", error);
      readerState.paused = true;
      updateListenButtons();
      setMediaSessionPlaybackState("paused");
      pumpContinuousListening();
      setListenStatus("音频已准备好，请点击继续播放");
    } else failContinuousListening(stream, error);
  }
}
