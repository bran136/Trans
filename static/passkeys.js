/* Native WebAuthn; no biometric data is exposed to this page. */
(() => {
  function decode(value) {
    const text = value.replace(/-/g, "+").replace(/_/g, "/");
    return Uint8Array.from(atob(text.padEnd(Math.ceil(text.length / 4) * 4, "=")), char => char.charCodeAt(0));
  }

  function encode(value) {
    return btoa(String.fromCharCode(...new Uint8Array(value)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function options(value, registering) {
    const result = { ...value, challenge: decode(value.challenge) };
    if (registering) result.user = { ...value.user, id: decode(value.user.id) };
    const key = registering ? "excludeCredentials" : "allowCredentials";
    const androidChrome = /Android/.test(navigator.userAgent) && /(?:Chrome|Chromium)\//.test(navigator.userAgent);
    if (value[key]) result[key] = value[key].map(item => {
      const descriptor = { ...item, id: decode(item.id) };
      if (registering && androidChrome && !item.transports?.length) {
        // Chrome expands missing hints to include smart-card, which older Android
        // providers may fail to parse. Keep all preceding transports for legacy keys.
        descriptor.transports = ["usb", "nfc", "ble", "hybrid", "internal"];
      }
      return descriptor;
    });
    return result;
  }

  function serialize(credential) {
    if (!credential) throw new DOMException("操作已取消", "NotAllowedError");
    const response = {};
    for (const key of ["clientDataJSON", "attestationObject", "authenticatorData", "signature", "userHandle"]) {
      if (credential.response[key] != null) response[key] = encode(credential.response[key]);
    }
    if (typeof credential.response.getTransports === "function") {
      try { response.transports = credential.response.getTransports(); }
      catch (_) { /* Optional hints must not discard a successfully created key. */ }
    }
    return { id: credential.id, rawId: encode(credential.rawId), type: credential.type, response };
  }

  function message(error) {
    if (["NotAllowedError", "AbortError"].includes(error.name)) return "验证已取消或超时，请重试";
    if (error.name === "InvalidStateError") return "此设备或密码管理器已保存通行密钥";
    if (error.name === "SecurityError") return "请使用当前网站的 HTTPS 域名";
    if (error.name === "NotSupportedError") return "当前设备不支持，请使用最新版 Chrome 或 Safari 并设置设备锁屏";
    if (error.name === "NotReadableError") return "设备未能完成通行密钥操作，请重试或尝试其他密码管理器";
    return error.message || "通行密钥操作失败，请重试";
  }

  window.TransPasskeys = {
    supported: () => Boolean(window.isSecureContext && window.PublicKeyCredential
      && navigator.credentials?.create && navigator.credentials?.get),
    create: async (value, signal) => serialize(await navigator.credentials.create({
      publicKey: options(value, true), signal,
    })),
    get: async (value, signal) => serialize(await navigator.credentials.get({
      publicKey: options(value, false), signal,
    })),
    message,
  };
})();
