/* Shared operation feedback. Timers belong to a message slot, not a request. */
(() => {
  function createFeedback(clock = globalThis) {
    const messages = new WeakMap();
    const buttons = new WeakMap();
    function feedback(node, text = '', type = 'info', collapse = true, onClear = null, successDuration = 4000) {
      if (!node) return;
      const previous = messages.get(node);
      if (previous?.text === text && previous.type === type && previous.collapse === collapse && previous.successDuration === successDuration) return;
      if (previous) clock.clearTimeout(previous.timer);
      const entry = { text, type, collapse, successDuration, timer: null };
      messages.set(node, entry);
      node.textContent = text;
      node.dataset.feedback = type;
      node.hidden = collapse && !text;
      if (text && type === 'success' && successDuration > 0) {
        entry.timer = clock.setTimeout(() => {
          if (messages.get(node) !== entry) return;
          node.textContent = '';
          node.hidden = collapse;
          messages.delete(node);
          if (onClear) onClear();
        }, successDuration);
      }
    }
    function busyButton(button) {
      if (!button) return () => {};
      const entry = { disabled: buttons.get(button)?.disabled ?? button.disabled };
      buttons.set(button, entry);
      button.disabled = true;
      button.classList.add('ui-busy');
      button.setAttribute('aria-busy', 'true');
      return () => {
        if (buttons.get(button) !== entry) return;
        buttons.delete(button);
        button.disabled = entry.disabled;
        button.classList.remove('ui-busy');
        button.removeAttribute('aria-busy');
      };
    }
    return { feedback, busyButton };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { createFeedback };
  else globalThis.TransFeedback = createFeedback();
})();
