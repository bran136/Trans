(() => {
  const form = document.querySelector(".login-form");
  if (!form) return;
  const submit = form.querySelector(".login-submit");
  const button = document.getElementById("passkeyLoginBtn");
  const message = document.getElementById("loginError");
  const countdown = document.getElementById("loginCountdown");
  const otpStep = form.dataset.otpStep === "true";
  let controller = null;
  let retryUntil = 0;
  let countdownTimer = null;
  let submittingForm = false;
  const password = document.getElementById("loginPassword");
  const visibility = document.getElementById("loginPasswordVisibility");
  let visibilityTimer = null;

  function hidePassword() {
    clearTimeout(visibilityTimer);
    visibilityTimer = null;
    if (!password || !visibility) return;
    password.type = "password";
    visibility.setAttribute("aria-pressed", "false");
    visibility.setAttribute("aria-label", "显示密码 3 秒");
    visibility.title = "显示密码 3 秒";
  }

  if (password && visibility) {
    visibility.hidden = false;
    // Preserve the input's focus/selection without opening the mobile keyboard.
    visibility.addEventListener("pointerdown", event => event.preventDefault());
    visibility.addEventListener("click", () => {
      if (password.type === "text") return hidePassword();
      password.type = "text";
      visibility.setAttribute("aria-pressed", "true");
      visibility.setAttribute("aria-label", "隐藏密码");
      visibility.title = "隐藏密码";
      visibilityTimer = setTimeout(hidePassword, 3000);
    });
    window.addEventListener("blur", hidePassword);
  }

  function updateControls() {
    const busy = Boolean(controller);
    const waiting = retryUntil > Date.now();
    // Keep credential fields visible and editable while verification is pending.
    // Disabling/removing them can look like a completed sign-in to password managers.
    submit.disabled = busy || waiting;
    submit.classList.toggle("is-loading", busy && submittingForm);
    submit.setAttribute("aria-label", busy && submittingForm ? "正在验证" : "登录");
    form.setAttribute("aria-busy", String(busy));
    if (button) {
      button.disabled = busy || waiting;
      button.querySelector("span").textContent = busy && !submittingForm ? "正在验证…" : "使用通行密钥登录";
    }
  }

  function showError(text) {
    message.textContent = text;
    message.hidden = !text;
    message.classList.remove("login-error-bounce");
    if (text) {
      void message.offsetWidth;
      message.classList.add("login-error-bounce");
    }
  }

  function updateCountdown() {
    const remaining = Math.max(0, Math.ceil((retryUntil - Date.now()) / 1000));
    countdown.hidden = remaining === 0;
    if (remaining) {
      countdown.textContent = `请在 ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")} 后重试`;
    } else {
      clearInterval(countdownTimer);
      countdownTimer = null;
      if (retryUntil) showError("");
      retryUntil = 0;
    }
    updateControls();
  }

  function startCountdown(seconds) {
    const wait = Number(seconds);
    if (!Number.isFinite(wait) || wait <= 0) return;
    retryUntil = Date.now() + wait * 1000;
    clearInterval(countdownTimer);
    countdownTimer = setInterval(updateCountdown, 1000);
    updateCountdown();
  }

  function csrfToken() {
    return form.elements.csrf_token.value;
  }

  async function readResponse(response) {
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== "object") throw new Error("登录请求失败，请刷新页面后重试");
    if (data.csrf_token) {
      form.elements.csrf_token.value = data.csrf_token;
      document.querySelector('meta[name="csrf-token"]').content = data.csrf_token;
    }
    if (!response.ok) {
      const error = new Error(data.error || "登录失败，请重试");
      error.retryAfter = data.retry_after || Number(response.headers.get("Retry-After"));
      error.otpExpired = otpStep && data.otp_step === false;
      throw error;
    }
    return data;
  }

  form.addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
    if (!event.target.matches(".login-password, .login-password-visibility")) return;
    event.preventDefault();
    if (!event.repeat && !submit.disabled) form.requestSubmit(submit);
  });

  form.addEventListener("submit", async event => {
    event.preventDefault();
    hidePassword();
    if (controller || retryUntil > Date.now()) return;
    const body = new URLSearchParams(new FormData(form));
    controller = new AbortController();
    submittingForm = true;
    const active = controller;
    const timeout = setTimeout(() => active.abort(), 15000);
    showError("");
    updateControls();
    let navigating = false;
    try {
      const response = await fetch(form.action, {
        method: "POST", signal: active.signal,
        headers: { "Accept": "application/json", "X-CSRF-Token": csrfToken() }, body,
      });
      const data = await readResponse(response);
      if (!data.ok || !data.redirect) throw new Error(data.error || "登录失败，请重试");
      if (!otpStep) {
        // Save heuristics must see the password that the server actually checked,
        // even if the field was edited during the request. An existing session
        // redirect is not a successful verification of the entered password.
        form.elements.password.value = data.password_verified ? body.get("password") : "";
      }
      navigating = true;
      window.location.replace(data.redirect);
    } catch (error) {
      if (error.otpExpired) {
        navigating = true;
        window.location.replace("/login");
      } else {
        showError(error.name === "AbortError" ? "请求超时，请稍后重试" : error.message);
        startCountdown(error.retryAfter);
      }
    } finally {
      clearTimeout(timeout);
      controller = null;
      if (!navigating) updateControls();
    }
  });

  if (button && !otpStep && window.TransPasskeys.supported()) {
    button.hidden = false;
    button.addEventListener("click", async () => {
      hidePassword();
      if (controller || retryUntil > Date.now()) return;
      controller = new AbortController();
      submittingForm = false;
      const active = controller;
      const timeout = setTimeout(() => active.abort(), 90000);
      showError("");
      updateControls();
      let navigating = false;
      async function post(step, body = {}) {
        return readResponse(await fetch(`/api/passkeys/login/${step}`, {
          method: "POST", signal: active.signal,
          headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken() },
          body: JSON.stringify(body),
        }));
      }
      try {
        const options = await post("options");
        const credential = await window.TransPasskeys.get(options, active.signal);
        const data = await post("verify", { credential });
        // Passkey success does not validate a password typed into the other field.
        if (form.elements.password) form.elements.password.value = "";
        navigating = true;
        window.location.replace(data.redirect);
      } catch (error) {
        showError(window.TransPasskeys.message(error));
        startCountdown(error.retryAfter);
      } finally {
        clearTimeout(timeout);
        controller = null;
        if (!navigating) updateControls();
      }
    });
  }
  startCountdown(form.dataset.retryAfter);
  window.addEventListener("pageshow", () => {
    hidePassword();
    if (retryUntil > Date.now() && !countdownTimer) countdownTimer = setInterval(updateCountdown, 1000);
    updateCountdown();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hidePassword();
    if (!document.hidden) updateCountdown();
  });
  window.addEventListener("pagehide", () => {
    hidePassword();
    controller?.abort();
    clearInterval(countdownTimer);
    countdownTimer = null;
  });
})();
