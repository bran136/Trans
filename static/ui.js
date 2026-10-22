(() => {
  // Opt in only on entry pages: reject restored input focus until the user
  // chooses a field or navigates with the keyboard. Keep this guard active
  // after pageshow because browsers may restore focus later.
  if (document.body.hasAttribute("data-no-entry-input-focus")) {
    let inputFocusRequested = false;
    const isEditable = (node) => node instanceof Element && node.matches(
      'textarea, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="submit"]):not([type="button"]), [contenteditable="true"]'
    );
    const dismissRestoredFocus = () => {
      if (!inputFocusRequested && isEditable(document.activeElement)) document.activeElement.blur();
    };
    document.addEventListener("pointerdown", (event) => {
      const target = event.target;
      if (isEditable(target) || isEditable(target.closest?.("label")?.control)) inputFocusRequested = true;
    }, true);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Tab") inputFocusRequested = true;
    }, true);
    // Explicit form validation is allowed to focus a field needing correction.
    document.addEventListener("invalid", () => { inputFocusRequested = true; }, true);
    document.addEventListener("focusin", dismissRestoredFocus, true);
    window.addEventListener("pagehide", () => {
      inputFocusRequested = false;
      dismissRestoredFocus();
    });
    window.addEventListener("pageshow", dismissRestoredFocus);
    dismissRestoredFocus();
  }

  // Limit the larger editable text to iPhone Safari; other browsers stay compact.
  const browserAgent = navigator.userAgent;
  const isIPhoneSafari = /iPhone/.test(browserAgent)
    && /Version\/[\d.]+.*Safari\//.test(browserAgent)
    && !/(?:CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|GSA)\//.test(browserAgent);
  document.documentElement.classList.toggle("iphone-safari", isIPhoneSafari);
  const isAndroid = /Android/.test(browserAgent);
  document.documentElement.classList.toggle("android-browser", isAndroid);
  if (isAndroid) {
    // Let modern Chrome paint behind the gesture bar. Keep Safari's existing
    // viewport policy; page layouts already reserve the bottom safe area.
    const viewport = document.querySelector('meta[name="viewport"]');
    if (viewport && !/viewport-fit\s*=/.test(viewport.content)) {
      viewport.content += ", viewport-fit=cover";
    }
  }

  // Safari samples viewport edges; Chrome also samples the document canvas
  // for its bottom bar. Match the modal backdrop and restore the page theme.
  // Observe state changes only, never scroll/playback.
  if (isIPhoneSafari || isAndroid) {
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    const needsEdges = isIPhoneSafari && document.body.matches(".reader-body, .app-body");
    let modalOrder = [...document.querySelectorAll("dialog:modal")];
    const addEdges = (host) => {
      if (host.querySelector(":scope > .browser-edge-tint")) return;
      for (const edge of ["top", "bottom"]) {
        const tint = document.createElement("span");
        tint.className = `browser-edge-tint browser-edge-tint-${edge}`;
        tint.setAttribute("aria-hidden", "true");
        host.appendChild(tint);
      }
    };
    // All theme/backdrop colors in our styles resolve to rgb()/rgba().
    const channels = (color) => color.match(/[\d.]+/g)?.map(Number);
    const syncBrowserBars = () => {
      const base = channels(getComputedStyle(document.body).backgroundColor);
      if (!base || base.length < 3) return;
      let color = base.slice(0, 3);
      modalOrder = modalOrder.filter((dialog) => dialog.isConnected && dialog.matches(":modal"));
      for (const dialog of modalOrder) {
        const shade = channels(getComputedStyle(dialog, "::backdrop").backgroundColor);
        if (shade && shade.length >= 3) {
          const alpha = shade[3] ?? 1;
          color = color.map((value, i) => shade[i] * alpha + value * (1 - alpha));
        }
        if (needsEdges) {
          addEdges(dialog);
          dialog.style.setProperty("--browser-edge-color", `rgb(${color.map(Math.round).join(", ")})`);
        }
      }
      // Keep the page theme and document canvas in sync, including installed apps.
      const tint = `#${color.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
      if (themeMeta && themeMeta.content !== tint) themeMeta.content = tint;
      if (isAndroid) {
        document.documentElement.style.setProperty("--browser-canvas-color", tint);
      }
    };
    if (needsEdges) addEdges(document.body);
    // open mutations preserve showModal() order, including nested dialogs and
    // dynamically created text prompts. Ordinary content changes are ignored.
    new MutationObserver((records) => {
      for (const { target } of records) {
        if (!(target instanceof HTMLDialogElement)) continue;
        modalOrder = modalOrder.filter((dialog) => dialog !== target);
        if (target.matches(":modal")) modalOrder.push(target);
      }
      syncBrowserBars();
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] });
    const themeObserver = new MutationObserver(syncBrowserBars);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    // Reader settings can restore theme-color without changing a theme class.
    if (isAndroid && themeMeta) {
      themeObserver.observe(themeMeta, { attributes: true, attributeFilter: ["content"] });
    }
    window.addEventListener("pageshow", syncBrowserBars);
    syncBrowserBars();
  }

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
  function setupScrollFades(container, selector) {
    const regions = [...container.querySelectorAll(selector)];
    const isActive = () => !container.hidden && (container.tagName !== "DIALOG" || container.open);
    regions.forEach((region) => region.classList.add("scroll-fade"));
    let frame = 0;
    const update = () => {
      frame = 0;
      if (!isActive()) return;
      regions.forEach((region) => {
        const overflow = region.clientHeight > 0 && region.scrollHeight - region.clientHeight > 2
          && /^(auto|scroll)$/.test(getComputedStyle(region).overflowY);
        region.classList.toggle("can-scroll-up", overflow && region.scrollTop > 2);
        region.classList.toggle("can-scroll-down", overflow
          && region.scrollHeight - region.clientHeight - region.scrollTop > 2);
      });
    };
    const schedule = () => {
      if (isActive() && !frame) frame = window.requestAnimationFrame(update);
    };
    container.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    if ("ResizeObserver" in window) {
      const observer = new ResizeObserver(schedule);
      regions.forEach((region) => observer.observe(region));
    }
    // Includes opening, search results, cache progress and hidden sections.
    // Exclude class mutations so updating the fade cannot trigger another update.
    new MutationObserver(schedule).observe(container, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ["open", "hidden"],
    });
    container.addEventListener("close", () => {
      window.cancelAnimationFrame(frame);
      frame = 0;
    });
    schedule();
  }

  window.TransUI = {
    setupScrollFades,
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
