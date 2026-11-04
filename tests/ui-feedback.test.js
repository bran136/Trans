const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFeedback } = require('../static/ui-feedback.js');

function fixture() {
  let now = 0, serial = 0;
  const timers = new Map();
  const feedback = createFeedback({
    setTimeout(fn, delay) { const id = ++serial; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  function advance(ms) {
    now += ms;
    for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn(); }
  }
  const node = { textContent: '', hidden: false, dataset: {} };
  return { ...feedback, advance, node };
}

test('success expires after four seconds and repeated operations can show it again', () => {
  const { feedback, advance, node } = fixture();
  feedback(node, '已保存', 'success');
  advance(3000); feedback(node, '已保存', 'success');
  advance(999); assert.equal(node.textContent, '已保存');
  advance(1); assert.equal(node.hidden, true);
  feedback(node, '已保存', 'success');
  assert.equal(node.hidden, false);
  advance(4000); assert.equal(node.textContent, '');
});

test('old success timer cannot clear a new error or operation in progress', () => {
  for (const type of ['error', 'pending', 'info']) {
    const { feedback, advance, node } = fixture();
    let cleared = false;
    feedback(node, '完成', 'success', true, () => { cleared = true; });
    advance(2000); feedback(node, '新的状态', type);
    advance(60000); assert.equal(node.textContent, '新的状态');
    assert.equal(node.hidden, false);
    assert.equal(cleared, false);
  }
});

test('message slots and completion callbacks are independent', () => {
  const { feedback, advance, node } = fixture();
  const other = { dataset: {} };
  let cleared = 0;
  feedback(node, '完成', 'success', false, () => cleared++);
  feedback(other, '失败', 'error');
  advance(4000);
  assert.equal(cleared, 1); assert.equal(node.hidden, false);
  assert.equal(other.textContent, '失败');
  feedback(node, '导入完成', 'success', true, null, 10000);
  feedback(other, '本机下载完成', 'success', false, null, 0);
  advance(9999); assert.equal(node.textContent, '导入完成');
  advance(1); assert.equal(node.hidden, true);
  advance(60000); assert.equal(other.textContent, '本机下载完成');
});

test('busy button preserves previous disabled state and stale completion cannot unlock it', () => {
  const { busyButton } = fixture();
  const classes = new Set(), attrs = new Map();
  const button = { disabled: false, classList: { add: x => classes.add(x), remove: x => classes.delete(x) },
    setAttribute: (k, v) => attrs.set(k, v), removeAttribute: k => attrs.delete(k) };
  const old = busyButton(button), current = busyButton(button);
  old(); assert.equal(button.disabled, true); assert.equal(attrs.get('aria-busy'), 'true');
  current(); assert.equal(button.disabled, false); assert.equal(classes.size, 0);
  button.disabled = true; busyButton(button)(); assert.equal(button.disabled, true);
});
