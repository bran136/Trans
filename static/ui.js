(() => {
  // Show keyboard focus only after keyboard navigation, not dialog auto-focus.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Tab") document.documentElement.classList.add("keyboard-navigation");
  }, true);
  document.addEventListener("pointerdown", () => {
    document.documentElement.classList.remove("keyboard-navigation");
  }, true);

  // Keep touch feedback visible briefly even after a quick tap.
  let pressedControl = null;
  let pressedAt = 0;
  let pressedTimer;
  function clearTouchFeedback() {
    window.clearTimeout(pressedTimer);
    pressedControl?.classList.remove("touch-pressed");
    pressedControl = null;
  }
  document.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    clearTouchFeedback();
    const control = event.target.closest("button, a, .engine-chip");
    if (!control || control.matches(":disabled, [aria-disabled='true']")) return;
    pressedControl = control;
    pressedAt = performance.now();
    control.classList.add("touch-pressed");
  }, { passive: true });
  document.addEventListener("pointerup", () => {
    if (pressedControl) pressedTimer = window.setTimeout(clearTouchFeedback, Math.max(80, 180 - (performance.now() - pressedAt)));
  }, { passive: true });
  document.addEventListener("pointercancel", clearTouchFeedback, { passive: true });
  window.addEventListener("blur", clearTouchFeedback);

  // Delay presentation actions only; playback, clipboard and browser-privileged
  // operations must retain the original user activation.
  const delayedTouchActions = [
    ".top-actions button", ".home-actions button", ".reader-actions button",
    ".dialog-head button", ".result-toggle", ".font-option",
    ".toc-edit-actions button", ".ui-text-actions button",
    ".tool-card", ".nav-home", ".reader-actions a",
  ].join(",");
  let pendingTouchAction = null;
  let replayingTouchAction = null;
  document.addEventListener("click", (event) => {
    const control = event.target.closest("button, a");
    if (!control || control === replayingTouchAction || event.detail === 0) return;
    if (control !== pressedControl || !control.matches(delayedTouchActions)) return;
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    if (control.matches(":disabled, [aria-disabled='true'], [download], [target='_blank']")) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (pendingTouchAction) return;
    window.clearTimeout(pressedTimer);
    pendingTouchAction = control;
    const parentDialog = control.closest("dialog");
    const wait = Math.max(0, 150 - (performance.now() - pressedAt));
    window.setTimeout(() => {
      pendingTouchAction = null;
      try {
        if (!control.isConnected || control.matches(":disabled, [aria-disabled='true']")) return;
        if (parentDialog && !parentDialog.open) return;
        replayingTouchAction = control;
        control.click();
      } finally {
        replayingTouchAction = null;
        if (pressedControl === control) clearTouchFeedback();
      }
    }, wait);
  }, true);

  function showTextDialog(title, message, initialValue) {
    return new Promise((resolve) => {
      const previousFocus = document.activeElement;
      const dialog = document.createElement("dialog");
      dialog.className = "ui-text-dialog";
      const form = document.createElement("form");
      form.className = "dialog-panel ui-text-panel";
      form.method = "dialog";
      const heading = document.createElement("h2");
      heading.id = "uiTextDialogTitle";
      heading.textContent = title;
      heading.tabIndex = -1;
      heading.autofocus = true;
      dialog.setAttribute("aria-labelledby", heading.id);
      form.appendChild(heading);
      let input;
      if (initialValue !== undefined) {
        const label = document.createElement("label");
        label.textContent = "章节标题";
        input = document.createElement("input");
        input.type = "text";
        input.value = initialValue;
        label.appendChild(input);
        form.appendChild(label);
      } else {
        const copy = document.createElement("p");
        copy.textContent = message || "";
        form.appendChild(copy);
      }
      const actions = document.createElement("div");
      actions.className = "ui-text-actions";
      if (input) {
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "ghost";
        cancel.textContent = "取消";
        cancel.addEventListener("click", () => dialog.close());
        actions.appendChild(cancel);
      }
      const submit = document.createElement("button");
      submit.type = "submit";
      submit.className = "ghost";
      submit.textContent = input ? "保存" : "知道了";
      actions.appendChild(submit);
      form.appendChild(actions);
      dialog.appendChild(form);
      let result = null;
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        result = input ? input.value : true;
        dialog.close();
      });
      dialog.addEventListener("close", () => {
        dialog.remove();
        if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
        resolve(result);
      }, { once: true });
      document.body.appendChild(dialog);
      dialog.showModal();
      heading.focus({ preventScroll: true });
    });
  }
  window.TransUI = {
    prompt: (title, value) => showTextDialog(title, "", value),
    message: (title, message) => showTextDialog(title, message),
  };

  const hideTimers = new WeakMap();

  function showScrollbar(target) {
    if (!(target instanceof Element)) return;
    target.classList.add("scrollbar-active");
    const previousTimer = hideTimers.get(target);
    if (previousTimer) window.clearTimeout(previousTimer);
    hideTimers.set(target, window.setTimeout(() => {
      target.classList.remove("scrollbar-active");
      hideTimers.delete(target);
    }, 550));
  }

  document.addEventListener("scroll", (event) => {
    if (event.target === document) {
      showScrollbar(document.documentElement);
      showScrollbar(document.body);
      return;
    }
    showScrollbar(event.target);
  }, true);
})();
