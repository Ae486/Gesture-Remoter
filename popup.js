const els = {
  start: document.getElementById("start"),
  stop: document.getElementById("stop"),
  grantCamera: document.getElementById("grantCamera"),
  enableScroll: document.getElementById("enableScroll"),
  enableZoom: document.getElementById("enableZoom"),
  enableVideo: document.getElementById("enableVideo"),
  running: document.getElementById("running"),
  camera: document.getElementById("camera"),
  hand: document.getElementById("hand"),
  error: document.getElementById("error"),
  debug: document.getElementById("debug"),
  scrollTargetMode: document.getElementById("scrollTargetMode"),
  scrollSensitivity: document.getElementById("scrollSensitivity"),
  scrollSensitivityVal: document.getElementById("scrollSensitivityVal"),
  scrollDeadzone: document.getElementById("scrollDeadzone"),
  scrollDeadzoneVal: document.getElementById("scrollDeadzoneVal"),
  scrollClamp: document.getElementById("scrollClamp"),
  scrollClampVal: document.getElementById("scrollClampVal"),
  scrollInvert: document.getElementById("scrollInvert"),
  previewFps: document.getElementById("previewFps"),
  previewFpsVal: document.getElementById("previewFpsVal"),
  previewEnabled: document.getElementById("previewEnabled"),
  zoomSensitivity: document.getElementById("zoomSensitivity"),
  zoomSensitivityVal: document.getElementById("zoomSensitivityVal"),
  zoomDeadzone: document.getElementById("zoomDeadzone"),
  zoomDeadzoneVal: document.getElementById("zoomDeadzoneVal"),
  zoomInvert: document.getElementById("zoomInvert"),
  activationHold: document.getElementById("activationHold"),
  activationHoldVal: document.getElementById("activationHoldVal"),
  scrollHand: document.getElementById("scrollHand"),
  zoomHand: document.getElementById("zoomHand"),
  videoHand: document.getElementById("videoHand"),
  videoModeHand: document.getElementById("videoModeHand"),
  previewMirror: document.getElementById("previewMirror"),
  useGpuDelegate: document.getElementById("useGpuDelegate"),
};

function setText(el, text) {
  el.textContent = text ?? "—";
}

function formatCameraState(state) {
  const s = String(state || "").toLowerCase();
  if (!s) return "—";
  if (s === "active") return "已开启";
  if (s === "inactive") return "未开启";
  return state;
}

function applyState(state) {
  setText(els.running, state?.running ? "是" : "否");
  setText(els.camera, formatCameraState(state?.cameraState));
  setText(els.hand, state?.handDetected ? "检测到" : "未检测");
  setText(els.error, state?.lastError ?? "—");
  if (state?.lastDebug) {
    const d = state.lastDebug;
    const text = `v:${d.videoWidth}x${d.videoHeight} lm:${d.lastLandmarkCount} seq:${d.frameSeq} tick:${d.tickCount} pose:${d.pose} hand:${d.handedness || "-"} delegate:${d.delegate || "-"}`;
    setText(els.debug, text);
  } else {
    setText(els.debug, "—");
  }

  els.enableScroll.checked = !!state?.features?.scroll;
  els.enableZoom.checked = !!state?.features?.zoom;
  els.enableVideo.checked = !!state?.features?.video;

  els.start.disabled = !!state?.running;
  els.stop.disabled = !state?.running;
  els.grantCamera.disabled = false;

  if (state?.needsCameraPermission) {
    els.grantCamera.classList.add("primary");
  } else {
    els.grantCamera.classList.remove("primary");
  }

  const tuning = state?.tuning || {};
  const contentConfig = state?.contentConfig || {};

  if (els.scrollTargetMode) {
    els.scrollTargetMode.value = contentConfig.scrollTargetMode || "auto";
  }

  if (els.scrollSensitivity) {
    const mult = Number(tuning.scrollGain ?? 1500) / 1500;
    els.scrollSensitivity.value = String(mult);
    els.scrollSensitivityVal.textContent = `×${mult.toFixed(2)}`;
  }
  if (els.scrollDeadzone) {
    els.scrollDeadzone.value = Number(tuning.scrollDeadzonePx ?? 6);
    els.scrollDeadzoneVal.textContent = String(els.scrollDeadzone.value);
  }
  if (els.scrollClamp) {
    els.scrollClamp.value = Number(tuning.scrollClampPxPerTick ?? 90);
    els.scrollClampVal.textContent = String(els.scrollClamp.value);
  }
  if (els.scrollInvert) {
    els.scrollInvert.checked = tuning.scrollInvert !== false;
  }
  if (els.previewFps) {
    els.previewFps.value = Number(tuning.previewFps ?? 5);
    els.previewFpsVal.textContent = String(els.previewFps.value);
  }
  if (els.previewEnabled) {
    els.previewEnabled.checked = tuning.previewEnabled !== false;
  }
  if (els.zoomSensitivity) {
    const mult = Number(tuning.zoomDragGain ?? 8) / 8;
    els.zoomSensitivity.value = String(mult);
    els.zoomSensitivityVal.textContent = `×${mult.toFixed(2)}`;
  }
  if (els.zoomDeadzone) {
    const dz = Number(tuning.zoomDeadzoneLog ?? 0.008);
    const ui = Math.round(dz * 1000);
    els.zoomDeadzone.value = String(ui);
    els.zoomDeadzoneVal.textContent = String(ui);
  }
  if (els.zoomInvert) {
    els.zoomInvert.checked = tuning.zoomInvert !== false;
  }
  if (els.scrollHand) {
    els.scrollHand.value = String(tuning.scrollHand || "any");
  }
  if (els.zoomHand) {
    els.zoomHand.value = String(tuning.zoomHand || "any");
  }
  if (els.videoHand) {
    els.videoHand.value = String(tuning.videoHand || "any");
  }
  if (els.videoModeHand) {
    els.videoModeHand.value = String(tuning.videoModeHand || "right");
  }
  if (els.previewMirror) {
    els.previewMirror.checked = !!contentConfig.previewMirror;
  }
  if (els.activationHold) {
    els.activationHold.value = String(Number(tuning.activationHoldMs ?? 180));
    els.activationHoldVal.textContent = `${els.activationHold.value}ms`;
  }
  if (els.useGpuDelegate) {
    els.useGpuDelegate.checked = !!tuning.useGpuDelegate;
  }
}

async function send(type, payload) {
  return await chrome.runtime.sendMessage({ source: "popup", type, payload });
}

async function refresh() {
  const state = await send("GET_STATE");
  applyState(state);
}

els.start.addEventListener("click", async () => {
  await send("START");
  await refresh();
});

els.stop.addEventListener("click", async () => {
  await send("STOP");
  await refresh();
});

els.grantCamera.addEventListener("click", async () => {
  await send("OPEN_CAMERA_GRANT");
  await refresh();
});

function onToggleChange() {
  send("SET_FEATURES", {
    scroll: els.enableScroll.checked,
    zoom: els.enableZoom.checked,
    video: els.enableVideo.checked,
  }).then(refresh);
}

els.enableScroll.addEventListener("change", onToggleChange);
els.enableZoom.addEventListener("change", onToggleChange);
els.enableVideo.addEventListener("change", onToggleChange);

let settingsDebounce = null;
function sendSettings() {
  if (settingsDebounce) clearTimeout(settingsDebounce);
  settingsDebounce = setTimeout(() => {
    const previewEnabled = els.previewEnabled?.checked !== false;
    const scrollMult = Number(els.scrollSensitivity?.value);
    const zoomMult = Number(els.zoomSensitivity?.value);
    const tuning = {
      scrollGain: Number.isFinite(scrollMult) ? scrollMult * 1500 : undefined,
      scrollDeadzonePx: Number(els.scrollDeadzone?.value),
      scrollClampPxPerTick: Number(els.scrollClamp?.value),
      scrollInvert: !!els.scrollInvert?.checked,
      // v2: pinch clutch is always on (same feel as "drag to control").
      scrollUsePinchClutch: true,
      scrollRequireOpenPalm: false,
      previewEnabled,
      previewFps: Number(els.previewFps?.value),
      zoomDragGain: Number.isFinite(zoomMult) ? zoomMult * 8 : undefined,
      zoomDeadzoneLog: Number(els.zoomDeadzone?.value) / 1000,
      zoomInvert: !!els.zoomInvert?.checked,
      activationHoldMs: Number(els.activationHold?.value),
      useGpuDelegate: !!els.useGpuDelegate?.checked,
      scrollHand: els.scrollHand?.value || "any",
      zoomHand: els.zoomHand?.value || "any",
      videoHand: els.videoHand?.value || "any",
      videoModeHand: els.videoModeHand?.value || "right",
    };
    const contentConfig = {
      scrollTargetMode: els.scrollTargetMode?.value || "auto",
      previewMirror: !!els.previewMirror?.checked,
      previewEnabled,
    };
    send("SET_SETTINGS", { tuning, contentConfig }).then(refresh);
  }, 120);
}

[
  els.scrollTargetMode,
  els.scrollSensitivity,
  els.scrollDeadzone,
  els.scrollClamp,
  els.scrollInvert,
  els.activationHold,
  els.previewFps,
  els.previewEnabled,
  els.zoomSensitivity,
  els.zoomDeadzone,
  els.zoomInvert,
  els.scrollHand,
  els.zoomHand,
  els.videoHand,
  els.videoModeHand,
  els.previewMirror,
  els.useGpuDelegate,
].forEach((el) => {
  if (!el) return;
  el.addEventListener("change", () => {
    if (el === els.scrollSensitivity) els.scrollSensitivityVal.textContent = `×${Number(el.value).toFixed(2)}`;
    if (el === els.scrollDeadzone) els.scrollDeadzoneVal.textContent = String(el.value);
    if (el === els.scrollClamp) els.scrollClampVal.textContent = String(el.value);
    if (el === els.previewFps) els.previewFpsVal.textContent = String(el.value);
    if (el === els.zoomSensitivity) els.zoomSensitivityVal.textContent = `×${Number(el.value).toFixed(2)}`;
    if (el === els.zoomDeadzone) els.zoomDeadzoneVal.textContent = String(el.value);
    if (el === els.activationHold) els.activationHoldVal.textContent = `${el.value}ms`;
    if (el === els.videoModeHand) {
      // If user makes both video actions use the same hand, mode takes priority.
    }
    sendSettings();
  });
  el.addEventListener("input", () => {
    if (el === els.scrollSensitivity) els.scrollSensitivityVal.textContent = `×${Number(el.value).toFixed(2)}`;
    if (el === els.scrollDeadzone) els.scrollDeadzoneVal.textContent = String(el.value);
    if (el === els.scrollClamp) els.scrollClampVal.textContent = String(el.value);
    if (el === els.previewFps) els.previewFpsVal.textContent = String(el.value);
    if (el === els.zoomSensitivity) els.zoomSensitivityVal.textContent = `×${Number(el.value).toFixed(2)}`;
    if (el === els.zoomDeadzone) els.zoomDeadzoneVal.textContent = String(el.value);
    if (el === els.activationHold) els.activationHoldVal.textContent = `${el.value}ms`;
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.source === "sw" && msg?.type === "STATE_CHANGED") {
    applyState(msg.payload);
  }
});

refresh();
