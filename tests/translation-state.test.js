const test = require("node:test");
const assert = require("node:assert/strict");
const { createQueue, normalizeHistory, mergeHistory, createHistoryStore } = require("../static/translation-state.js");

function fakeClock() {
  let id = 0;
  const timers = new Map();
  return {
    setTimeout(fn) { timers.set(++id, fn); return id; },
    clearTimeout(key) { timers.delete(key); },
    fire() { const pending = [...timers.values()]; timers.clear(); pending.forEach((fn) => fn()); },
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("typing coalesces to the latest input before starting", async () => {
  const clock = fakeClock(), calls = [];
  const queue = createQueue(async (job) => calls.push(job.key), assert.fail, clock);
  queue.schedule({ key: "a" });
  queue.schedule({ key: "ab" });
  queue.schedule({ key: "abc" });
  clock.fire();
  await settle();
  assert.deepEqual(calls, ["abc"]);
});

test("only latest pending input runs, and stale results cannot render", async () => {
  const clock = fakeClock(), calls = [], rendered = [], releases = [];
  const queue = createQueue(async (job, isCurrent) => {
    calls.push(job.key);
    await new Promise((resolve) => releases.push(resolve));
    if (isCurrent()) rendered.push(job.key);
  }, assert.fail, clock);
  queue.schedule({ key: "a" }); clock.fire();
  queue.schedule({ key: "b" }); clock.fire();
  queue.schedule({ key: "c" }); clock.fire();
  assert.deepEqual(calls, ["a"]);
  releases.shift()(); await settle();
  assert.deepEqual(calls, ["a", "c"]);
  releases.shift()(); await settle();
  assert.deepEqual(rendered, ["c"]);
});

test("returning to an active input reuses its request", async () => {
  const clock = fakeClock(), rendered = [];
  let release, calls = 0;
  const queue = createQueue(async (job, isCurrent) => {
    calls++;
    await new Promise((resolve) => { release = resolve; });
    if (isCurrent()) rendered.push(job.key);
  }, assert.fail, clock);
  queue.schedule({ key: "a" }); clock.fire();
  queue.schedule({ key: "b" }); clock.fire();
  queue.schedule({ key: "a" });
  release(); await settle(); clock.fire(); await settle();
  assert.equal(calls, 1);
  assert.deepEqual(rendered, ["a"]);
});

test("opening history or starting composition cancels pending work and rendering", async () => {
  const clock = fakeClock(), rendered = [];
  let release, calls = 0;
  const queue = createQueue(async (job, isCurrent) => {
    calls++;
    await new Promise((resolve) => { release = resolve; });
    if (isCurrent()) rendered.push(job.key);
  }, assert.fail, clock);
  queue.schedule({ key: "a" }); clock.fire();
  queue.schedule({ key: "b" }); clock.fire();
  queue.cancel();
  release(); await settle(); clock.fire();
  assert.equal(calls, 1);
  assert.deepEqual(rendered, []);
});

function entry(target = "zh", model = "model-a", time = 1) {
  return normalizeHistory([{ text: "Hello", source: "en", target, targetName: target, time,
    results: [{ engine: "deepseek", name: "DeepSeek", text: "你好", ok: true, model }] }])[0];
}

test("history preserves separate language/model results and replaces only matching records", () => {
  let records = [entry()];
  records = mergeHistory(records, entry("fr", "model-a", 2));
  records = mergeHistory(records, entry("zh", "model-b", 3));
  records = mergeHistory(records, entry("zh", "model-a", 4));
  assert.equal(records.length, 3);
  assert.equal(records[0].time, 4);
  assert.equal(records[0].results[0].text, "你好");
  records = mergeHistory(records, entry("zh", "model-a", 1));
  assert.equal(records[0].time, 4);
});

test("legacy history remains readable without pretending it has a saved result", () => {
  const legacy = normalizeHistory([{ text: "Hello", source: "en", target: "zh", targetName: "中文" }]);
  assert.equal(legacy.length, 1);
  assert.deepEqual(legacy[0].results, []);
  assert.equal(normalizeHistory([{}, null, { text: "invalid" }]).length, 0);
});

test("history is bounded and excludes failed or malformed result contents", () => {
  const entries = Array.from({ length: 110 }, (_, i) => entry("zh", "m", i));
  assert.equal(normalizeHistory(entries).length, 100);
  assert.equal(normalizeHistory(entries)[0].time, 109);
  const item = entry();
  item.results.push({ engine: "google", name: "Google", text: "", ok: true });
  item.results.push({ engine: "google", name: "Google", text: "error", ok: false });
  assert.equal(normalizeHistory([item])[0].results.length, 1);
});

test("clearing history removes stored and legacy entries, while new translations can still be saved", async () => {
  const previous = globalThis.indexedDB;
  const entries = new Map();
  const db = {transaction() {
    const tx = {};
    const request = result => {
      const req = {result};
      queueMicrotask(() => { req.onsuccess?.(); queueMicrotask(() => tx.oncomplete?.()); });
      return req;
    };
    tx.objectStore = () => ({getAll:()=>request([...entries.values()]),
      clear:()=>{ entries.clear(); return request(); }, put:item=>entries.set(item.id,item)});
    return tx;
  }};
  globalThis.indexedDB = {open() {
    const req = {result:db}; queueMicrotask(()=>req.onsuccess()); return req;
  }};
  try {
    const history = createHistoryStore([entry()]);
    assert.equal((await history.load()).length,1);
    await history.clear(); assert.equal(entries.size,0);
    assert.deepEqual(await history.load(),[]);
    assert.equal((await history.save(entry('fr'))).length,1);
    assert.equal((await history.load())[0].target,'fr');
    const unmigrated = createHistoryStore([entry()]);
    await unmigrated.clear(); assert.deepEqual(await unmigrated.load(),[]);
  } finally {
    if (previous === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = previous;
  }
});
