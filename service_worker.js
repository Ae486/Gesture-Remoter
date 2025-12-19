import { DEFAULT_CONTENT_CONFIG, DEFAULT_FEATURES, DEFAULT_TUNING } from "./shared/defaults.js";

const state = {
  running: false,
  cameraState: "Inactive",
  handDetected: false,
  lastError: null,
  needsCameraPermission: false,
  lastFrameAt: 0,
  contentScriptSeenAt: 0,
  lastForwardError: null,
  lastDebug: null,
  features: { ...DEFAULT_FEATURES },
  tuning: { ...DEFAULT_TUNING },
  contentConfig: { ...DEFAULT_CONTENT_CONFIG },
};

let zoomTask = {
  timer: null,
  pendingMultiplier: 1,
  lastAppliedAt: 0,
};

let currentPreviewTabId = null;
let debuggerAttachedTabId = null;
let cameraGrantWindowId = null;
let cameraGrantTabId = null;
let lastStartRequestedAt = 0;
let didAutoOpenGrantForStartAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function broadcastState() {
  chrome.runtime.sendMessage({ source: "sw", type: "STATE_CHANGED", payload: state }).catch(() => {});
}

function isCameraPermissionError(message) {
  if (!message) return false;
  const m = String(message).toLowerCase();
  return (
    m.includes("permission dismissed") ||
    m.includes("notallowederror") ||
    m.includes("permission denied") ||
    m.includes("permissiondeniederror") ||
    m.includes("not allowed")
  );
}

async function loadFeatures() {
  const { features } = await chrome.storage.local.get("features");
  state.features = { ...DEFAULT_FEATURES, ...(features || {}) };
}

async function saveFeatures() {
  await chrome.storage.local.set({ features: state.features });
}

async function loadSettings() {
  const { tuning, contentConfig } = await chrome.storage.local.get(["tuning", "contentConfig"]);
  state.tuning = { ...DEFAULT_TUNING, ...(tuning || {}) };
  // Invariants: always-on pinch clutch scrolling; open-palm gating disabled.
  state.tuning.scrollUsePinchClutch = true;
  state.tuning.scrollRequireOpenPalm = false;
  state.contentConfig = { ...DEFAULT_CONTENT_CONFIG, ...(contentConfig || {}) };
}

async function saveSettings() {
  await chrome.storage.local.set({ tuning: state.tuning, contentConfig: state.contentConfig });
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({});
  const hasOffscreen = contexts.some((c) => c.contextType === "OFFSCREEN_DOCUMENT");
  if (hasOffscreen) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Use the camera to run on-device hand tracking for gesture control.",
  });
}

async function closeOffscreenIfPresent() {
  const contexts = await chrome.runtime.getContexts({});
  const hasOffscreen = contexts.some((c) => c.contextType === "OFFSCREEN_DOCUMENT");
  if (!hasOffscreen) return;
  await chrome.offscreen.closeDocument();
}

async function closeCameraGrantWindow() {
  if (cameraGrantWindowId == null) return;
  const winId = cameraGrantWindowId;
  cameraGrantWindowId = null;
  cameraGrantTabId = null;
  await chrome.windows.remove(winId).catch(() => {});
}

async function openCameraGrantWindow() {
  if (cameraGrantWindowId != null) {
    await chrome.windows.update(cameraGrantWindowId, { focused: true }).catch(() => {});
    if (cameraGrantTabId != null) {
      await chrome.tabs.update(cameraGrantTabId, { active: true }).catch(() => {});
    }
    return;
  }

  const url = chrome.runtime.getURL("grant_camera.html");
  const win = await chrome.windows
    .create({ url, type: "popup", width: 420, height: 560, focused: true })
    .catch(() => null);

  cameraGrantWindowId = win?.id ?? null;
  cameraGrantTabId = win?.tabs?.[0]?.id ?? null;
}

async function hidePreviewIfPresent(tabId) {
  if (!tabId || typeof tabId !== "number") return;
  chrome.tabs.sendMessage(tabId, { source: "sw", type: "HIDE_PREVIEW" }).catch(() => {});
}

async function sendToOffscreenWithRetry(type, payload, { retries = 12, delayMs = 80 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await chrome.runtime.sendMessage({ target: "offscreen", type, payload });
    } catch (e) {
      lastErr = e;
      // Offscreen doc may exist but not be ready to receive messages yet; retry briefly.
      await sleep(delayMs);
    }
  }
  throw lastErr || new Error("Failed to reach offscreen document");
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

async function ensureContentScript(tabId) {
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ["content_script.js"],
    });

    // Push latest content config.
    chrome.tabs
      .sendMessage(tabId, { source: "sw", type: "SET_CONTENT_CONFIG", payload: state.contentConfig })
      .catch(() => {});
  } catch {
    // If we don't have permission or it's a restricted page, ignore.
  }
}

async function hidePreviewEverywhere() {
  // Best-effort cleanup: try all tabs (prevents “stuck last frame” on tabs we no longer track).
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs
      .map((t) => t?.id)
      .filter((tabId) => typeof tabId === "number")
      .map((tabId) => chrome.tabs.sendMessage(tabId, { source: "sw", type: "HIDE_PREVIEW" }).catch(() => {}))
  );
  currentPreviewTabId = null;
}

async function sendToActiveTab(message) {
  const tabId = await getActiveTabId();
  if (!tabId) return;
  await ensureContentScript(tabId);
  await chrome.tabs.sendMessage(tabId, message);
}

async function ensureDebuggerAttached(tabId) {
  if (!tabId) return false;
  if (debuggerAttachedTabId === tabId) return true;
  try {
    if (debuggerAttachedTabId != null) {
      await chrome.debugger.detach({ tabId: debuggerAttachedTabId });
    }
  } catch {
    // ignore detach errors
  }

  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    debuggerAttachedTabId = tabId;
    return true;
  } catch (e) {
    state.lastError = e?.message || String(e);
    broadcastState();
    debuggerAttachedTabId = null;
    return false;
  }
}

async function getDebuggerViewportCenter(tabId) {
  // CDP Input.* coordinates are in CSS pixels relative to the viewport.
  try {
    const metrics = await chrome.debugger.sendCommand({ tabId }, "Page.getLayoutMetrics", {});
    const vv = metrics?.visualViewport || metrics?.layoutViewport || null;
    const w = Number(vv?.clientWidth) || Number(metrics?.layoutViewport?.clientWidth) || 800;
    const h = Number(vv?.clientHeight) || Number(metrics?.layoutViewport?.clientHeight) || 600;
    return { x: Math.round(w / 2), y: Math.round(h / 2) };
  } catch {
    return { x: 400, y: 300 };
  }
}

async function debuggerScroll(tabId, dyPx) {
  const ok = await ensureDebuggerAttached(tabId);
  if (!ok) return;
  try {
    const { x, y } = await getDebuggerViewportCenter(tabId);
    const deltaY = Math.max(-1200, Math.min(1200, Number(dyPx) || 0));

    // Preferred: dispatchMouseEvent(type=mouseWheel). Some Chromium builds don't expose dispatchMouseWheel.
    try {
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX: 0,
        deltaY,
        modifiers: 0,
        pointerType: "mouse",
      });
      return;
    } catch (e) {
      // Fallback for older protocol implementations.
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseWheel", {
        x,
        y,
        deltaX: 0,
        deltaY,
      });
      void e;
    }
  } catch (e) {
    state.lastError = e?.message || String(e);
    broadcastState();
  }
}

async function scrollActive(dyPx) {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  const tabId = tab.id;

  const url = tab.url || "";
  const isPdf = /\.pdf($|[?#])/i.test(url);
  // PDF viewer scrolling is often not scriptable; prefer a wheel event via debugger.
  if (isPdf) {
    await debuggerScroll(tabId, dyPx);
    return;
  }

  // Prefer content script scrolling; fall back to debugger wheel (works for PDF viewer / file:// when injection is blocked).
  try {
    await sendToActiveTab({ source: "sw", type: "SCROLL", payload: { dyPx } });
  } catch (e) {
    const msg = e?.message || String(e);
    state.lastForwardError = msg;
    broadcastState();
    await debuggerScroll(tabId, dyPx);
  }
}

async function applyZoomMultiplier(multiplier) {
  const tabId = await getActiveTabId();
  if (!tabId) return;

  const current = await chrome.tabs.getZoom(tabId);
  const next = Math.max(0.25, Math.min(5, current * multiplier));
  await chrome.tabs.setZoom(tabId, next);
}

function scheduleZoom(multiplier) {
  if (!state.features.zoom) return;
  zoomTask.pendingMultiplier *= multiplier;

  if (zoomTask.timer) return;
  zoomTask.timer = setTimeout(async () => {
    zoomTask.timer = null;
    const mult = zoomTask.pendingMultiplier;
    zoomTask.pendingMultiplier = 1;

    const t = Date.now();
    // Small extra guard against rapid zoom calls.
    if (t - zoomTask.lastAppliedAt < 120) {
      scheduleZoom(mult);
      return;
    }
    zoomTask.lastAppliedAt = t;

    try {
      await applyZoomMultiplier(mult);
    } catch (e) {
      state.lastError = e?.message || String(e);
      broadcastState();
    }
  }, 120);
}

async function start() {
  state.lastError = null;
  state.needsCameraPermission = false;
  lastStartRequestedAt = Date.now();
  await loadFeatures();
  await loadSettings();
  const tabId = await getActiveTabId();
  if (tabId) await ensureContentScript(tabId);
  await ensureOffscreen();
  try {
    await sendToOffscreenWithRetry("START", { features: state.features, tuning: state.tuning });
    state.running = true;
    broadcastState();
  } catch (e) {
    state.lastError = e?.message || String(e);
    state.running = false;
    broadcastState();
  }
}

async function stop() {
  try {
    await sendToOffscreenWithRetry("STOP", null, { retries: 2, delayMs: 50 }).catch(() => {});
    await hidePreviewEverywhere().catch(() => {});
    await closeCameraGrantWindow().catch(() => {});
    if (debuggerAttachedTabId != null) {
      await chrome.debugger.detach({ tabId: debuggerAttachedTabId }).catch(() => {});
      debuggerAttachedTabId = null;
    }
    await closeOffscreenIfPresent().catch(() => {});
  } finally {
    state.running = false;
    state.cameraState = "Inactive";
    state.handDetected = false;
    broadcastState();
  }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (!state.running) return;
  if (state.contentConfig.previewEnabled && currentPreviewTabId != null && currentPreviewTabId !== tabId) {
    await hidePreviewIfPresent(currentPreviewTabId);
    currentPreviewTabId = null;
  }
  await ensureContentScript(tabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!state.running) return;
  if (changeInfo.status !== "complete") return;
  await ensureContentScript(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (currentPreviewTabId === tabId) currentPreviewTabId = null;
  if (debuggerAttachedTabId === tabId) {
    debuggerAttachedTabId = null;
  }
  if (cameraGrantTabId === tabId) {
    cameraGrantTabId = null;
    cameraGrantWindowId = null;
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (cameraGrantWindowId === windowId) {
    cameraGrantWindowId = null;
    cameraGrantTabId = null;
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get("features");
  if (!existing?.features) {
    await chrome.storage.local.set({ features: { ...DEFAULT_FEATURES } });
  }
  const existingTuning = await chrome.storage.local.get(["tuning", "contentConfig"]);
  if (!existingTuning?.tuning) await chrome.storage.local.set({ tuning: { ...DEFAULT_TUNING } });
  if (!existingTuning?.contentConfig)
    await chrome.storage.local.set({ contentConfig: { ...DEFAULT_CONTENT_CONFIG } });
  await loadFeatures();
  await loadSettings();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.source === "cs" && msg.type === "HELLO") {
        state.contentScriptSeenAt = Date.now();
        state.lastForwardError = null;
        broadcastState();
        if (_sender?.tab?.id) {
          chrome.tabs
            .sendMessage(_sender.tab.id, {
              source: "sw",
              type: "SET_CONTENT_CONFIG",
              payload: state.contentConfig,
            })
            .catch(() => {});
        }
        return sendResponse(true);
      }

      if (msg?.source === "cs" && msg.type === "REQUEST_DEBUG_KEY") {
        const tabId = _sender?.tab?.id;
        const key = msg.payload?.key;
        const code = msg.payload?.code;
        const vk = msg.payload?.vk;
        if (!tabId || typeof key !== "string") return sendResponse(false);
        const ok = await ensureDebuggerAttached(tabId);
        if (!ok) return sendResponse(false);
        try {
          const windowsVirtualKeyCode = Number.isFinite(vk) ? Number(vk) : undefined;
          const nativeVirtualKeyCode = windowsVirtualKeyCode;
          await chrome.debugger.sendCommand(
            { tabId },
            "Input.dispatchKeyEvent",
            {
              type: "keyDown",
              key,
              code: typeof code === "string" ? code : undefined,
              windowsVirtualKeyCode,
              nativeVirtualKeyCode,
            }
          );
          await chrome.debugger.sendCommand(
            { tabId },
            "Input.dispatchKeyEvent",
            {
              type: "keyUp",
              key,
              code: typeof code === "string" ? code : undefined,
              windowsVirtualKeyCode,
              nativeVirtualKeyCode,
            }
          );
        } catch (e) {
          state.lastError = e?.message || String(e);
          broadcastState();
          return sendResponse(false);
        }
        return sendResponse(true);
      }

      if (msg?.source === "popup") {
        if (msg.type === "GET_STATE") return sendResponse(state);
        if (msg.type === "START") {
          await start();
        return sendResponse(state);
      }
      if (msg.type === "STOP") {
        await stop();
        return sendResponse(state);
      }
      if (msg.type === "OPEN_CAMERA_GRANT") {
        await openCameraGrantWindow();
        return sendResponse(true);
      }
      if (msg.type === "CAMERA_GRANTED") {
        state.lastError = null;
        state.needsCameraPermission = false;
        broadcastState();
        // Auto-start if not running.
          if (!state.running) {
            await start();
          }
          return sendResponse(true);
        }
        if (msg.type === "CAMERA_ERROR") {
          state.lastError = msg.payload?.message ?? "Camera error";
          state.needsCameraPermission = true;
          broadcastState();
          return sendResponse(true);
        }
        if (msg.type === "SET_FEATURES") {
          state.features = { ...state.features, ...(msg.payload || {}) };
          await saveFeatures();
          broadcastState();
          // Keep offscreen in sync if already running.
          if (state.running) {
            sendToOffscreenWithRetry("SET_FEATURES", state.features, { retries: 2, delayMs: 50 }).catch(
              () => {}
            );
          }
          return sendResponse(state);
        }

        if (msg.type === "SET_SETTINGS") {
          if (msg.payload?.tuning) state.tuning = { ...state.tuning, ...msg.payload.tuning };
          if (msg.payload?.contentConfig)
            state.contentConfig = { ...state.contentConfig, ...msg.payload.contentConfig };
          // v2 invariants: pinch clutch is always enabled for scroll; open-palm gating disabled.
          state.tuning.scrollUsePinchClutch = true;
          state.tuning.scrollRequireOpenPalm = false;

          if (state.contentConfig.previewEnabled === false) {
            await hidePreviewEverywhere().catch(() => {});
          }
          await saveSettings();
          broadcastState();

          const tabId = await getActiveTabId();
          if (tabId) await ensureContentScript(tabId);

          if (state.running) {
            sendToOffscreenWithRetry("SET_TUNING", state.tuning, { retries: 2, delayMs: 50 }).catch(
              () => {}
            );
          }

          return sendResponse(state);
        }
      }

      if (msg?.source === "grant") {
        if (msg.type === "CAMERA_GRANTED") {
          state.lastError = null;
          state.needsCameraPermission = false;
          broadcastState();
          if (!state.running) {
            await start();
          }
          return sendResponse(true);
        }
        if (msg.type === "CAMERA_ERROR") {
          state.lastError = msg.payload?.message ?? "Camera error";
          state.needsCameraPermission = true;
          broadcastState();
          return sendResponse(true);
        }
        return sendResponse(true);
      }

      if (msg?.source === "offscreen") {
        if (msg.type === "STATUS") {
          state.cameraState = msg.payload?.cameraState ?? state.cameraState;    
          state.handDetected = !!msg.payload?.handDetected;
          state.lastFrameAt = Date.now();
          state.lastDebug = msg.payload?.debug ?? null;
          broadcastState();
          return sendResponse(true);
        }
        if (msg.type === "ERROR") {
          state.lastError = msg.payload?.message ?? "Unknown error";
          state.running = false;
          state.cameraState = "Inactive";
          state.handDetected = false;
          if (isCameraPermissionError(state.lastError)) {
            state.needsCameraPermission = true;
            const now = Date.now();
            if (
              now - lastStartRequestedAt < 2500 &&
              now - didAutoOpenGrantForStartAt > 2500 &&
              cameraGrantWindowId == null
            ) {
              didAutoOpenGrantForStartAt = now;
              openCameraGrantWindow().catch(() => {});
            }
          }
          await hidePreviewEverywhere();

          if (debuggerAttachedTabId != null) {
            chrome.debugger.detach({ tabId: debuggerAttachedTabId }).catch(() => {});
            debuggerAttachedTabId = null;
          }
          broadcastState();
          return sendResponse(true);
        }
        if (!state.running) return sendResponse(true);

        if (msg.type === "SCROLL" && state.features.scroll) {
          const dyPx = msg.payload?.dyPx;
          if (Number.isFinite(dyPx)) {
            scrollActive(dyPx).catch(() => {});
          }
          return sendResponse(true);
        }
      if (msg.type === "FRAME") {
        if (!state.contentConfig.previewEnabled) return sendResponse(true);
        // Forward to active tab for in-page preview overlay.
        const tabId = await getActiveTabId();
        if (tabId) {
          await ensureContentScript(tabId);
          chrome.tabs
            .sendMessage(tabId, { source: "sw", type: "FRAME", payload: msg.payload })
            .then(() => {
              state.lastForwardError = null;
              if (currentPreviewTabId != null && currentPreviewTabId !== tabId) {
                chrome.tabs
                  .sendMessage(currentPreviewTabId, { source: "sw", type: "HIDE_PREVIEW" })
                  .catch(() => {});
              }
              currentPreviewTabId = tabId;
            })
            .catch((e) => {
              state.lastForwardError = e?.message || String(e);
            })
            .finally(() => {
                broadcastState();
              });
        }
        return sendResponse(true);
      }
        if (msg.type === "ZOOM_DELTA") {
          const zoomDelta = msg.payload?.zoomDelta;
          if (Number.isFinite(zoomDelta)) scheduleZoom(zoomDelta);
          return sendResponse(true);
        }
        if (msg.type === "TOGGLE_VIDEO" && state.features.video) {
          sendToActiveTab({ source: "sw", type: "TOGGLE_VIDEO" }).catch(() => {});
          return sendResponse(true);
        }
        if (msg.type === "CYCLE_VIDEO_MODE" && state.features.video) {
          sendToActiveTab({ source: "sw", type: "CYCLE_VIDEO_MODE" }).catch(() => {});
          return sendResponse(true);
        }
      }

      return sendResponse(null);
    } catch (e) {
      state.lastError = e?.message || String(e);
      broadcastState();
      return sendResponse(state);
    }
  })();

  // Keep message channel open for async sendResponse.
  return true;
});
