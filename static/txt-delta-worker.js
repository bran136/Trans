/* Byte-based copy/insert delta; UTF-8 avoids JS/Python character-offset differences. */
let previewOriginal = '';
self.onmessage = async ({ data }) => {
  try {
    if (data.preview) {
      if (typeof data.original === 'string') previewOriginal = data.original;
      self.postMessage(previewChanges(previewOriginal, data.text)); return;
    }
    const encoder = new TextEncoder();
    const original = encoder.encode(data.original), edited = encoder.encode(data.text);
    if (edited.length > data.maxBytes) throw new Error('正文超过 UTF-8 的 50 MB 上限，未保存');
    if (data.original === data.text) { self.postMessage({ unchanged: true }); return; }
    const block = 256, index = new Map();
    let power = 1;
    for (let i = 1; i < block; i++) power = Math.imul(power, 31);
    function hash(bytes, start) {
      let value = 0;
      for (let i = start; i < start + block; i++) value = (Math.imul(value, 31) + bytes[i]) | 0;
      return value;
    }
    // Limit candidates per hash. Every candidate is byte-verified before reuse.
    for (let at = 0; at + block <= original.length; at += block) {
      const key = hash(original, at), positions = index.get(key);
      if (!positions) index.set(key, [at]);
      else if (positions.length < 4) positions.push(at);
    }
    const ops = [];
    function insert(start, end) {
      if (end <= start) return;
      let binary = '';
      for (let at = start; at < end; at += 16384) binary += String.fromCharCode(...edited.subarray(at, Math.min(end, at + 16384)));
      ops.push({ insert: btoa(binary) });
    }
    let at = 0, pending = 0, rolling = edited.length >= block ? hash(edited, 0) : 0;
    while (at + block <= edited.length) {
      let match = -1;
      for (const candidate of index.get(rolling) || []) {
        let i = 0;
        while (i < block && original[candidate + i] === edited[at + i]) i++;
        if (i === block) { match = candidate; break; }
      }
      if (match >= 0) {
        insert(pending, at);
        let length = block;
        while (match + length < original.length && at + length < edited.length && original[match + length] === edited[at + length]) length++;
        const last = ops[ops.length - 1];
        if (last?.copy && last.copy[0] + last.copy[1] === match) last.copy[1] += length;
        else ops.push({ copy: [match, length] });
        at += length; pending = at;
        if (at + block <= edited.length) rolling = hash(edited, at);
      } else {
        rolling = (Math.imul((rolling - Math.imul(edited[at], power)) | 0, 31) + (edited[at + block] || 0)) | 0;
        at++;
      }
    }
    insert(pending, edited.length);
    if (typeof CompressionStream !== 'function') throw new Error('此浏览器不支持压缩保存，请升级浏览器后重试；修改仍保留在编辑框中');
    const payload = JSON.stringify({ version: 1, revision: data.revision, parse: data.parse, size: edited.length, ops });
    const body = await new Response(new Blob([payload]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
    self.postMessage({ body, originalBytes: edited.length, uploadBytes: body.byteLength }, [body]);
  } catch (error) { self.postMessage({ error: error.message || '生成差异失败，请重试' }); }
};

// Preview alignment is independent of the byte-level upload format.
// Trim identical text first so a small deletion cannot shift the rest of a book.
function trimChange(original, edited, oldStart, oldEnd, newStart, newEnd) {
  while (oldStart < oldEnd && newStart < newEnd && original[oldStart] === edited[newStart]) { oldStart++; newStart++; }
  if (oldStart > 0 && /[\uD800-\uDBFF]/.test(original[oldStart - 1])) { oldStart--; newStart--; }
  while (oldEnd > oldStart && newEnd > newStart && original[oldEnd - 1] === edited[newEnd - 1]) { oldEnd--; newEnd--; }
  if (oldEnd < original.length && /[\uDC00-\uDFFF]/.test(original[oldEnd])) { oldEnd++; newEnd++; }
  return { oldStart, oldEnd, newStart, newEnd };
}

// Myers alignment finds a shortest sequence of inserted/deleted lines, instead
// of greedily matching a nearby repeated sentence or blank line. Work and trace
// memory are bounded; complex wholesale rewrites are shown as a merged region.
function alignChangedLines(before, after) {
  const n = before.length, m = after.length;
  if (!n || !m) return { ranges: [[0, n, 0, m]], merged: false };
  const trace = [];
  let work = 0;
  function at(row, depth, diagonal) {
    return Math.abs(diagonal) > depth ? -1 : row[diagonal + depth];
  }
  for (let depth = 0; depth <= Math.min(n + m, 1024); depth++) {
    const row = new Int32Array(2 * depth + 1);
    row.fill(-1);
    const previous = trace[depth - 1];
    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      if (++work > 4000000) return { ranges: [[0, n, 0, m]], merged: true };
      let x;
      if (depth === 0) x = 0;
      else if (diagonal === -depth || (diagonal !== depth && at(previous, depth - 1, diagonal - 1) < at(previous, depth - 1, diagonal + 1))) x = at(previous, depth - 1, diagonal + 1);
      else x = at(previous, depth - 1, diagonal - 1) + 1;
      let y = x - diagonal;
      while (x < n && y < m && before[x] === after[y]) {
        x++; y++;
        if (++work > 4000000) return { ranges: [[0, n, 0, m]], merged: true };
      }
      row[diagonal + depth] = x;
      if (x >= n && y >= m) {
        const steps = [];
        for (let d = depth; d > 0; d--) {
          const k = x - y, prev = trace[d - 1];
          const prevK = k === -d || (k !== d && at(prev, d - 1, k - 1) < at(prev, d - 1, k + 1)) ? k + 1 : k - 1;
          const prevX = at(prev, d - 1, prevK), prevY = prevX - prevK;
          while (x > prevX && y > prevY) { steps.push(0); x--; y--; }
          if (x === prevX) { steps.push(1); y--; }
          else { steps.push(-1); x--; }
        }
        while (x > 0 && y > 0) { steps.push(0); x--; y--; }
        steps.reverse();
        const ranges = [];
        let oldAt = 0, newAt = 0, start = null;
        for (const step of steps) {
          if (step === 0) {
            if (start) { ranges.push([start[0], oldAt, start[1], newAt]); start = null; }
            oldAt++; newAt++;
          } else {
            if (!start) start = [oldAt, newAt];
            if (step < 0) oldAt++; else newAt++;
          }
        }
        if (start) ranges.push([start[0], oldAt, start[1], newAt]);
        return { ranges, merged: false };
      }
    }
    trace.push(row);
  }
  return { ranges: [[0, n, 0, m]], merged: true };
}

function previewChanges(original, edited) {
  if (original === edited) return { changes: [], total: 0, merged: false };
  const region = trimChange(original, edited, 0, original.length, 0, edited.length);
  const oldLines = original.slice(region.oldStart, region.oldEnd).match(/[^\n]*\n|[^\n]+$/g) || [];
  const newLines = edited.slice(region.newStart, region.newEnd).match(/[^\n]*\n|[^\n]+$/g) || [];
  const oldOffsets = [region.oldStart], newOffsets = [region.newStart];
  for (const line of oldLines) oldOffsets.push(oldOffsets[oldOffsets.length - 1] + line.length);
  for (const line of newLines) newOffsets.push(newOffsets[newOffsets.length - 1] + line.length);
  const aligned = alignChangedLines(oldLines, newLines), changes = [];
  let total = 0;
  for (const [oldStart, oldEnd, newStart, newEnd] of aligned.ranges) {
    const change = trimChange(original, edited, oldOffsets[oldStart], oldOffsets[oldEnd], newOffsets[newStart], newOffsets[newEnd]);
    const removed = original.slice(change.oldStart, change.oldEnd), added = edited.slice(change.newStart, change.newEnd);
    if (!removed && !added) continue;
    total++;
    if (changes.length < 80) changes.push({ start: change.newStart, end: change.newEnd, oldStart: change.oldStart, oldEnd: change.oldEnd,
      before: edited.slice(Math.max(0, change.newStart - 40), change.newStart), after: edited.slice(change.newEnd, change.newEnd + 40),
      removed: removed.slice(0, 1000), added: added.slice(0, 1000), clipped: removed.length > 1000 || added.length > 1000 });
  }
  return { changes, total, merged: aligned.merged };
}
