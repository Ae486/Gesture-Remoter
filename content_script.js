(() => {
  if (globalThis.__gestureRemoterContentScriptLoaded) return;
  globalThis.__gestureRemoterContentScriptLoaded = true;

  if (window.top !== window) return;

function isEditableTarget(el) {
  if (!el) return false;
  const tag = el.tagName?.toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    el.isContentEditable ||
    el.getAttribute?.("role") === "textbox"
  );
}

function getScrollableAncestor(startEl) {
  const canScroll = (el) => {
    if (!el || el === document.documentElement) return false;
    const style = window.getComputedStyle(el);
    const overflowY = style.overflowY;
    const scrollable = overflowY === "auto" || overflowY === "scroll";
    return scrollable && el.scrollHeight > el.clientHeight + 2;
  };

  let el = startEl;
  for (let i = 0; i < 12 && el; i += 1) {
    if (canScroll(el)) return el;
    el = el.parentElement;
  }
  return null;
}

let scrollTargetMode = "auto"; // "auto" | "document"
let previewMirror = false;
let previewEnabled = true;
let previewDismissed = false;
let cachedScrollTarget = null;
let cachedScrollTargetMode = null;

function isScrollable(el) {
  if (!el) return false;
  if (el === document.documentElement || el === document.body) return true;
  const style = window.getComputedStyle(el);
  const overflowY = style.overflowY;
  const scrollable = overflowY === "auto" || overflowY === "scroll";
  return scrollable && el.scrollHeight > el.clientHeight + 2;
}

function getDocumentScrollTarget() {
  return document.scrollingElement || document.documentElement || document.body;
}

function getCenterScrollTarget() {
  const x = Math.floor(window.innerWidth / 2);
  const y = Math.floor(window.innerHeight / 2);
  const hit = document.elementFromPoint(x, y);
  return getScrollableAncestor(hit);
}

function getPrimaryScrollTarget() {
  if (
    cachedScrollTarget &&
    cachedScrollTargetMode === scrollTargetMode &&
    cachedScrollTarget.isConnected
  ) {
    return cachedScrollTarget;
  }

  let target = null;
  if (scrollTargetMode === "document") {
    target = getDocumentScrollTarget();
  } else {
    // auto: prefer document, fall back to center container if the document doesn't scroll.
    const docTarget = getDocumentScrollTarget();
    if (isScrollable(docTarget) && docTarget.scrollHeight > docTarget.clientHeight + 2) {
      target = docTarget;
    } else {
      target = getCenterScrollTarget() || docTarget;
    }
  }

  cachedScrollTarget = target;
  cachedScrollTargetMode = scrollTargetMode;
  return target;
}

function scrollByPx(dyPx) {
  const active = document.activeElement;
  if (isEditableTarget(active)) return;

  const target = getPrimaryScrollTarget();
  try {
    target.scrollBy({ top: dyPx, left: 0, behavior: "auto" });
  } catch {
    // Fallback for elements not supporting scrollBy options.
    target.scrollTop += dyPx;
  }
}

function visibleArea(rect) {
  const left = Math.max(0, rect.left);
  const right = Math.min(window.innerWidth, rect.right);
  const top = Math.max(0, rect.top);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  const w = Math.max(0, right - left);
  const h = Math.max(0, bottom - top);
  return w * h;
}

function getBestVideoElement() {
  const videos = Array.from(document.querySelectorAll("video"));
  let best = null;
  let bestScore = 0;

  for (const v of videos) {
    const rect = v.getBoundingClientRect();
    const area = visibleArea(rect);
    if (area < 160 * 90) continue;
    // Favor the one closest to center.
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = cx - window.innerWidth / 2;
    const dy = cy - window.innerHeight / 2;
    const dist2 = dx * dx + dy * dy;
    const score = area / (1 + dist2 * 0.001);
    if (score > bestScore) {
      best = v;
      bestScore = score;
    }
  }
  return best;
}

async function toggleVideo() {
  const v = getBestVideoElement();
  if (!v) return;

  // Prefer direct media control.
  try {
    if (v.paused) {
      await v.play();
    } else {
      v.pause();
    }
    return;
  } catch {
    // Autoplay / gesture restrictions may block play(). Fall back to click.
  }

  try {
    v.click();
  } catch {
    // Ignore.
  }
}

function pick(selectorList) {
  for (const sel of selectorList) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function safeClick(el) {
  if (!el) return false;
  try {
    el.click();
    return true;
  } catch {
    return false;
  }
}

function cycleBilibiliMode() {
  // Minimal mode toggle for bilibili: fullscreen <-> normal (equivalent to pressing "F").
  const playerRoot =
    document.querySelector(".bpx-player-container") ||
    document.querySelector(".bilibili-player") ||
    document.querySelector("#bilibiliPlayer") ||
    document;

  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const getLabel = (el) =>
    norm(
      el?.getAttribute?.("aria-label") ||
        el?.getAttribute?.("data-tooltip") ||
        el?.getAttribute?.("data-text") ||
        el?.getAttribute?.("title") ||
        el?.title ||
        el?.textContent
    );

  function findBiliClickable(keywords) {
    // Different bilibili builds use button/div/a with tooltips.
    const candidates = Array.from(
      playerRoot.querySelectorAll(
        "button,[role='button'],a,.bpx-player-ctrl-btn,[class*='bpx-player-ctrl'],[class*='player-ctrl'],[class*='video-btn']"
      )
    );
    for (const el of candidates) {
      if (!el) continue;
      if (el.disabled) continue;
      const label = getLabel(el);
      if (!label) continue;
      for (const k of keywords) {
        if (label.includes(k)) return el;
      }
    }
    return null;
  }

  const webFs =
    pick([
      ".bpx-player-ctrl-web",
      ".bpx-player-ctrl-web-enter",
      ".bilibili-player-video-web-fullscreen",
      ".squirtle-video-pagefullscreen",
    ]) || findBiliClickable(["网页全屏", "退出网页全屏"]);

  const wide =
    pick([
      ".bpx-player-ctrl-wide",
      ".bpx-player-ctrl-wide-enter",
      ".bilibili-player-video-btn-widescreen",
      ".squirtle-video-widescreen",
    ]) || findBiliClickable(["宽屏", "退出宽屏"]);

  const fs =
    pick([
      ".bpx-player-ctrl-full",
      ".bpx-player-ctrl-full-enter",
      ".bilibili-player-video-btn-fullscreen",
      ".squirtle-video-fullscreen",
    ]) || findBiliClickable(["全屏", "退出全屏"]);

  const requestDebugKey = (key, code, vk) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { source: "cs", type: "REQUEST_DEBUG_KEY", payload: { key, code, vk } },
          (resp) => resolve(resp === true)
        );
      } catch {
        resolve(false);
      }
    });

  // Prefer clicking the player's fullscreen toggle; fall back to "F" via debugger key injection.
  // Some bilibili builds reject synthetic click() due to user-gesture gating after exiting fullscreen.
  // Prefer key injection (matches user expectation) and fall back to click when debugger isn't available.
  requestDebugKey("f", "KeyF", 70).then((ok) => {
    if (ok) return;
    safeClick(fs);
  });
  void webFs;
  void wide;
}

function cycleVideoMode() {
  const host = location.hostname || "";
  if (host.includes("bilibili.com")) {
    cycleBilibiliMode();
    return;
  }
  // Generic fallback: toggle fullscreen for best video element.
  const v = getBestVideoElement();
  if (!v) return;
  const root = v.closest("div") || v;
  const isFs =
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.mozFullScreenElement ||
    document.msFullscreenElement;
  try {
    if (!isFs) root.requestFullscreen?.();
    else document.exitFullscreen?.();
  } catch {
    // ignore
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.source !== "sw") return;
  if (msg.type === "SCROLL") {
    const dyPx = msg.payload?.dyPx;
    if (Number.isFinite(dyPx)) scrollByPx(dyPx);
  }
  if (msg.type === "TOGGLE_VIDEO") {
    toggleVideo();
  }
  if (msg.type === "CYCLE_VIDEO_MODE") {
    cycleVideoMode();
  }
  if (msg.type === "HIDE_PREVIEW") {
    hidePreview();
  }
  if (msg.type === "SET_CONTENT_CONFIG") {
    const mode = msg.payload?.scrollTargetMode;
    if (mode === "auto" || mode === "document") {
      scrollTargetMode = mode;
      cachedScrollTarget = null;
      cachedScrollTargetMode = null;
    }
    if (typeof msg.payload?.previewMirror === "boolean") {
      previewMirror = msg.payload.previewMirror;
      if (previewImg) {
        previewImg.style.transform = previewMirror ? "scaleX(-1)" : "";
      }
    }
    if (typeof msg.payload?.previewEnabled === "boolean") {
      previewEnabled = msg.payload.previewEnabled;
      if (!previewEnabled) hidePreview();
      if (previewEnabled) previewDismissed = false;
    }
  }
  if (msg.type === "FRAME") {
    showPreviewFrame(msg.payload);
  }
});

let previewRoot = null;
let previewImg = null;
let previewClose = null;
let lastPreviewFrameAt = 0;
let previewWatchdog = null;

function ensurePreviewUI() {
  if (previewRoot) return;

  previewRoot = document.createElement("div");
  previewRoot.id = "gesture-remoter-preview";
  previewRoot.style.cssText =
    "position:fixed;top:12px;right:12px;z-index:2147483647;" +
    "width:160px;height:120px;border:1px solid rgba(255,255,255,0.18);" +
    "border-radius:10px;overflow:hidden;background:rgba(0,0,0,0.55);" +
    "box-shadow:0 8px 30px rgba(0,0,0,0.35);pointer-events:auto;";

  previewImg = document.createElement("img");
  previewImg.alt = "Gesture camera preview";
  previewImg.style.cssText =
    "width:100%;height:100%;object-fit:cover;display:block;pointer-events:none;";
  if (previewMirror) previewImg.style.transform = "scaleX(-1)";
  previewRoot.appendChild(previewImg);

  previewClose = document.createElement("button");
  previewClose.type = "button";
  previewClose.textContent = "×";
  previewClose.title = "隐藏预览";
  previewClose.style.cssText =
    "position:absolute;top:4px;right:4px;width:22px;height:22px;" +
    "border-radius:999px;border:1px solid rgba(255,255,255,0.25);" +
    "background:rgba(0,0,0,0.45);color:#fff;cursor:pointer;" +
    "font:16px/20px system-ui;pointer-events:auto;";
  previewClose.addEventListener("click", () => {
    // Close only this page's preview overlay; keep gestures running.
    previewDismissed = true;
    hidePreview();
  });
  previewRoot.appendChild(previewClose);

  document.documentElement.appendChild(previewRoot);
}

function hidePreview() {
  if (!previewRoot) return;
  previewRoot.remove();
  previewRoot = null;
  previewImg = null;
  previewClose = null;
  lastPreviewFrameAt = 0;
  if (previewWatchdog) {
    clearInterval(previewWatchdog);
    previewWatchdog = null;
  }
}

function showPreviewFrame(payload) {
  if (!previewEnabled) return;
  if (previewDismissed) return;
  if (!payload?.dataUrl) return;
  ensurePreviewUI();
  if (!previewImg) return;

  try {
    // Ensure reload even if browser decides to cache identical data URLs.
    const seq = payload?.seq ? String(payload.seq) : String(Date.now());
    previewImg.src = `${payload.dataUrl}#${seq}`;
    lastPreviewFrameAt = Date.now();
    if (!previewWatchdog) {
      previewWatchdog = setInterval(() => {
        if (!previewRoot) return;
        if (lastPreviewFrameAt && Date.now() - lastPreviewFrameAt > 2000) {
          hidePreview();
        }
      }, 500);
    }
  } catch {
    // Ignore.
  }
}

// Tell the service worker that this tab has a receiver (helps diagnostics / auto-injection).
try {
  chrome.runtime.sendMessage({ source: "cs", type: "HELLO", url: location.href }).catch(() => {});
} catch {
  // Ignore.
}
})();
