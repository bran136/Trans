(() => {
  // Keep native selects as the source of truth (values, forms and change handlers).
  // Only replace their system picker; older browsers retain the native control.
  if (!("showPopover" in HTMLElement.prototype)) return;
  document.documentElement.classList.add("custom-selects");
  let active = null;
  let press = null;
  let pointerSelection = null;

  const isSelect = (node) => node instanceof HTMLSelectElement
    && !node.multiple && node.size <= 1 && !node.matches(":disabled");
  const isDisabled = (option) => option.disabled || option.parentElement?.disabled;

  function close(restoreFocus = false) {
    if (!active) return;
    const { select, menu, abort, observer, attributes } = active;
    active = null;
    abort.abort();
    observer.disconnect();
    if (menu.matches(":popover-open")) menu.hidePopover();
    menu.remove();
    for (const [name, value] of attributes) {
      if (value === null) select.removeAttribute(name);
      else select.setAttribute(name, value);
    }
    if (restoreFocus && select.isConnected && !select.matches(":disabled")) {
      select.focus({ preventScroll: true });
    }
  }

  function highlight(index) {
    const state = active;
    if (!state || !state.items[index] || isDisabled(state.items[index].option)) return;
    state.index = index;
    state.items.forEach(({ row }, i) => row.classList.toggle("is-focused", i === index));
    const row = state.items[index].row;
    state.menu.setAttribute("aria-activedescendant", row.id);
    // Scroll only this menu, never its parent dialog or the reader underneath.
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < state.menu.scrollTop) state.menu.scrollTop = top;
    else if (bottom > state.menu.scrollTop + state.menu.clientHeight) {
      state.menu.scrollTop = bottom - state.menu.clientHeight;
    }
  }

  function positionMenu() {
    if (!active) return;
    const { select, menu } = active;
    if (!select.isConnected || !select.getClientRects().length) { close(); return; }
    const bounds = select.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = (viewport?.offsetLeft || 0) + 8;
    const top = (viewport?.offsetTop || 0) + 8;
    const right = left + (viewport?.width || innerWidth) - 16;
    const bottom = top + (viewport?.height || innerHeight) - 16;
    const width = Math.min(Math.max(bounds.width, 220), right - left);
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(left, Math.min(bounds.left, right - width))}px`;
    const below = bottom - bounds.bottom - 6;
    const above = bounds.top - top - 6;
    const upward = below < Math.min(menu.scrollHeight + 2, 260) && above > below;
    menu.style.maxHeight = `${Math.max(40, Math.min(320, upward ? above : below))}px`;
    menu.style.top = `${Math.max(top, Math.min(upward ? bounds.top - menu.offsetHeight - 6 : bounds.bottom + 6,
      bottom - menu.offsetHeight))}px`;
    highlight(active.index);
  }

  function choose(index) {
    const state = active;
    const option = state?.items[index]?.option;
    if (!option || isDisabled(option) || !isSelect(state.select)
        || !state.select.contains(option)) return;
    const { select } = state;
    const changed = select.selectedIndex !== option.index;
    select.selectedIndex = option.index;
    close(true);
    if (changed) {
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function typeAhead(key) {
    const state = active;
    const now = performance.now();
    state.query = now - state.typedAt < 700 ? state.query + key : key;
    state.typedAt = now;
    const query = /^(.)\1+$/u.test(state.query) ? key : state.query;
    const start = query.length === 1 ? state.index + 1 : Math.max(0, state.index);
    for (let step = 0; step < state.items.length; step++) {
      const index = (start + step) % state.items.length;
      const option = state.items[index].option;
      if (!isDisabled(option) && option.label.trim().toLocaleLowerCase().startsWith(query)) {
        highlight(index);
        break;
      }
    }
  }

  function open(select) {
    if (!select.getClientRects().length) return;
    if (active?.select === select) { close(true); return; }
    close();
    const options = [...select.options].filter((option) => !option.hidden && !option.parentElement.hidden);
    if (!options.length) return;
    const menu = document.createElement("div");
    menu.id = "trans-select-menu";
    menu.className = "ui-select-menu";
    menu.setAttribute("popover", "manual");
    menu.setAttribute("role", "listbox");
    menu.tabIndex = -1;
    const label = select.labels?.[0]?.cloneNode(true);
    label?.querySelectorAll("select, details, button, svg").forEach((node) => node.remove());
    const labelledBy = select.getAttribute("aria-labelledby");
    if (labelledBy) menu.setAttribute("aria-labelledby", labelledBy);
    else menu.setAttribute("aria-label", select.getAttribute("aria-label") || label?.textContent.trim() || "选择选项");
    let group = null;
    const items = options.map((option, index) => {
      if (option.parentElement instanceof HTMLOptGroupElement && option.parentElement !== group) {
        group = option.parentElement;
        const heading = document.createElement("div");
        heading.className = "ui-select-group";
        heading.textContent = group.label;
        menu.appendChild(heading);
      }
      const row = document.createElement("div");
      row.id = `trans-select-option-${index}`;
      row.className = "ui-select-option";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(option.selected));
      row.setAttribute("aria-disabled", String(Boolean(isDisabled(option))));
      row.textContent = option.label;
      row.addEventListener("click", () => choose(index));
      row.addEventListener("pointermove", (event) => {
        if (event.pointerType === "mouse") highlight(index);
      });
      menu.appendChild(row);
      return { row, option };
    });
    const abort = new AbortController();
    // Async option/config changes invalidate the open snapshot, without polling.
    const observer = new MutationObserver(() => close());
    active = { select, menu, items, index: -1, abort, observer, query: "", typedAt: 0,
      attributes: ["aria-expanded", "aria-controls"].map((name) => [name, select.getAttribute(name)]) };
    select.setAttribute("aria-expanded", "true");
    select.setAttribute("aria-controls", menu.id);
    const dialog = select.closest("dialog");
    (dialog || document.body).appendChild(menu);

    menu.showPopover();
    positionMenu();
    menu.focus({ preventScroll: true });
    let index = items.findIndex(({ option }) => option.selected && !isDisabled(option));
    if (index < 0) index = items.findIndex(({ option }) => !isDisabled(option));
    highlight(index);
    observer.observe(select, { subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: ["disabled", "hidden", "label", "selected", "value"] });
    for (let parent = select.parentElement; parent; parent = parent.parentElement) {
      observer.observe(parent, { attributes: true, attributeFilter: ["hidden", "disabled"] });
    }
    const dismiss = () => close();
    const listen = { signal: abort.signal };
    // A closing mobile keyboard resizes the viewport; reposition instead of dismissing.
    window.addEventListener("resize", positionMenu, listen);
    window.addEventListener("pagehide", dismiss, listen);
    window.visualViewport?.addEventListener("resize", positionMenu, listen);
    window.visualViewport?.addEventListener("scroll", positionMenu, listen);
    dialog?.addEventListener("close", dismiss, listen);
    document.addEventListener("focusin", (event) => {
      if (event.target !== select && !menu.contains(event.target)) close();
    }, listen);
    document.addEventListener("scroll", (event) => {
      if (event.target !== menu && !menu.contains(event.target)) close();
    }, { capture: true, passive: true, signal: abort.signal });
  }

  document.addEventListener("pointerdown", (event) => {
    press = null;
    pointerSelection = null;
    const select = event.target.closest("select");
    if (isSelect(select) && event.button === 0 && event.isPrimary) {
      // Prevent the OS picker opening before click, while keeping native layout.
      event.preventDefault();
      select.focus({ preventScroll: true });
      press = { select, id: event.pointerId, x: event.clientX, y: event.clientY };
    } else if (active && !active.menu.contains(event.target)) close();
  }, true);
  document.addEventListener("pointerup", (event) => {
    if (!press || event.pointerId !== press.id) return;
    const { select, x, y } = press;
    press = null;
    pointerSelection = select;
    event.preventDefault();
    // Safari suppresses click after a cancelled touch pointerdown; Chrome may
    // still send it. Handle a tap here once, without opening after a drag.
    if (isSelect(select) && Math.hypot(event.clientX - x, event.clientY - y) < 10) open(select);
  }, true);
  document.addEventListener("pointercancel", () => { press = null; }, true);
  document.addEventListener("click", (event) => {
    const select = event.target.closest("select");
    if (!isSelect(select)) return;
    event.preventDefault();
    if (pointerSelection === select && event.detail > 0) {
      pointerSelection = null;
      return;
    }
    // Label activation and assistive technology can dispatch click directly.
    open(select);
  });
  document.addEventListener("keydown", (event) => {
    const select = isSelect(event.target) ? event.target : null;
    if (!active && !select) return;
    if (event.ctrlKey || event.metaKey || event.isComposing) return;
    const typed = event.key.length === 1 && event.key !== " " && !event.altKey;
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Enter", " ", "Escape", "Tab"].includes(event.key) && !typed) return;
    if (event.key === "Tab") { if (active) close(true); return; }
    if (event.key === "Escape") {
      if (active) { event.preventDefault(); event.stopPropagation(); close(true); }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (!active) { open(select); if (typed && active) typeAhead(event.key.toLocaleLowerCase()); return; }
    if (typed) { typeAhead(event.key.toLocaleLowerCase()); return; }
    if (event.key === "Enter" || event.key === " ") { choose(active.index); return; }
    const enabled = active.items.map((item, i) => isDisabled(item.option) ? -1 : i).filter((i) => i >= 0);
    if (!enabled.length) return;
    const current = enabled.indexOf(active.index);
    const index = event.key === "Home" ? 0 : event.key === "End" ? enabled.length - 1
      : Math.max(0, Math.min(enabled.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)));
    highlight(enabled[index]);
  }, true);
})();
