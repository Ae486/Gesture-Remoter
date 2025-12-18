import { FilesetResolver, HandLandmarker } from "./libs/vision_bundle.mjs";
import { DEFAULT_FEATURES, DEFAULT_TUNING } from "./shared/defaults.js";

let features = { ...DEFAULT_FEATURES };
let tuning = { ...DEFAULT_TUNING };

let running = false;
let videoEl = null;
let mediaStream = null;
let handLandmarker = null;
let activeDelegate = "CPU";

let lastVideoToggleAt = 0;
let lastVideoModeAt = 0;

let lastStatusSentAt = 0;
let lastFrameSentAt = 0;
let previewCanvas = null;
let previewCtx = null;
let lastVideoSize = { w: 0, h: 0 };
let lastLandmarkCount = 0;
let lastLandmarks = null;
let frameSeq = 0;
let tickTimer = null;
let inTick = false;
let tickCount = 0;
let lastTickAt = 0;

let lastHandScale = 0;
let lastHandedness = null;
let lastHandednessScore = null;

const handRuntimeByLabel = new Map();

function createHandRuntime() {
  return {
    smoothedY: null,
    pinchActive: false,
    pinchSinceMs: null,
    pinchQualified: false,
    pinchQualifiedPrev: false,
    presentSinceMs: null,
    poseCandidate: "UNKNOWN",
    poseCandidateCount: 0,
    stablePose: "UNKNOWN",
    prevStablePose: "UNKNOWN",
    // Per-mode baselines/filters (so scroll/zoom don't interfere even if misconfigured).
    scrollLastY: null,
    scrollDyFiltered: 0,
    zoomLastY: null,
    zoomDyFiltered: 0,
  };
}

function resetHandRuntime(rt) {
  rt.smoothedY = null;
  rt.pinchActive = false;
  rt.pinchSinceMs = null;
  rt.pinchQualified = false;
  rt.pinchQualifiedPrev = false;
  rt.presentSinceMs = null;
  rt.poseCandidate = "UNKNOWN";
  rt.poseCandidateCount = 0;
  rt.stablePose = "UNKNOWN";
  rt.prevStablePose = "UNKNOWN";
  rt.scrollLastY = null;
  rt.scrollDyFiltered = 0;
  rt.zoomLastY = null;
  rt.zoomDyFiltered = 0;
}

function getHandRuntime(label) {
  const key = label || "unknown";
  let rt = handRuntimeByLabel.get(key);
  if (!rt) {
    rt = createHandRuntime();
    handRuntimeByLabel.set(key, rt);
  }
  return rt;
}

function nowMs() {
  return performance.now();
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function hypot2(dx, dy) {
  return Math.hypot(dx, dy);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function safeRatio(num, den, fallback = null) {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 1e-6) return fallback;
  return num / den;
}

function normalizeHandLabel(label) {
  if (!label) return null;
  const s = String(label).toLowerCase();
  if (s.includes("left")) return "left";
  if (s.includes("right")) return "right";
  return null;
}

function maybeFlipHand(label) {
  if (!label) return null;
  // MediaPipe handedness is based on the camera image; many UIs show mirrored preview,
  // which makes "left/right" feel reversed to users. Flip by default to match the user's real hand.
  return label === "left" ? "right" : label === "right" ? "left" : label;
}

function handAllowed(kind, label) {
  const k = String(kind || "any").toLowerCase();
  if (k === "any") return true;
  return k === label;
}

async function initModelIfNeeded() {
  if (handLandmarker) return;

  const basePath = chrome.runtime.getURL("libs");
  const fileset = await FilesetResolver.forVisionTasks(basePath);
  const modelAssetPath = chrome.runtime.getURL("libs/hand_landmarker.task");

  const wantGpu = !!tuning.useGpuDelegate;
  if (!wantGpu) {
    handLandmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath, delegate: "CPU" },
      runningMode: "VIDEO",
      numHands: 2,
    });
    activeDelegate = "CPU";
    return;
  }

  try {
    handLandmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath, delegate: "GPU" },
      runningMode: "VIDEO",
      numHands: 2,
    });
    activeDelegate = "GPU";
  } catch {
    // If GPU delegate fails (often shows OpenGL/WebGL errors), fall back to CPU.
    handLandmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath, delegate: "CPU" },
      runningMode: "VIDEO",
      numHands: 2,
    });
    activeDelegate = "CPU";
  }
}

async function resetModel() {
  try {
    handLandmarker?.close?.();
  } catch {}
  handLandmarker = null;
  await initModelIfNeeded();
}

async function initCameraIfNeeded() {
  if (mediaStream) return;
  if (!videoEl) videoEl = document.getElementById("video");

  mediaStream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 30, max: 60 },
      facingMode: "user",
    },
    audio: false,
  });

  videoEl.srcObject = mediaStream;
  await videoEl.play();
}

function stopCamera() {
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) track.stop();
    mediaStream = null;
  }
  if (videoEl) {
    videoEl.pause();
    videoEl.srcObject = null;
  }
}

function send(type, payload) {
  chrome.runtime.sendMessage({ source: "offscreen", type, payload }).catch(() => {});
}

async function maybeSendPreviewFrame() {
  if (!tuning.previewEnabled) return;
  // ~5 FPS
  const t = nowMs();
  const fps = clamp(Number(tuning.previewFps) || 0, 1, 15);
  const minInterval = 1000 / fps;
  if (t - lastFrameSentAt < minInterval) return;
  lastFrameSentAt = t;

  if (!videoEl || videoEl.readyState < 2) return;
  lastVideoSize = { w: videoEl.videoWidth || 0, h: videoEl.videoHeight || 0 };

  if (!previewCanvas) {
    previewCanvas = document.createElement("canvas");
    previewCanvas.width = 160;
    previewCanvas.height = 120;
    // Hint to prefer CPU paths and avoid extra GPU/GL initialization where possible.
    previewCtx = previewCanvas.getContext("2d", {
      alpha: false,
      desynchronized: true,
      willReadFrequently: true,
    });
  }
  if (!previewCtx) return;

  try {
    previewCtx.drawImage(videoEl, 0, 0, previewCanvas.width, previewCanvas.height);
    if (Array.isArray(lastLandmarks) && lastLandmarks.length) {
      previewCtx.save();
      previewCtx.fillStyle = "rgba(79, 140, 255, 0.95)";
      for (const p of lastLandmarks) {
        const x = p.x * previewCanvas.width;
        const y = p.y * previewCanvas.height;
        previewCtx.beginPath();
        previewCtx.arc(x, y, 2.2, 0, Math.PI * 2);
        previewCtx.fill();
      }
      previewCtx.restore();
    }
    const dataUrl = previewCanvas.toDataURL("image/jpeg", 0.6);
    frameSeq += 1;
    send("FRAME", { dataUrl, seq: frameSeq });
  } catch {
    // Ignore preview errors.
  }
}

function sendStatus(handDetected, extra = {}) {
  const t = nowMs();
  if (t - lastStatusSentAt < 500) return;
  lastStatusSentAt = t;
  const extraDebug = extra?.debug && typeof extra.debug === "object" ? extra.debug : null;
  const baseDebug = {
    videoWidth: lastVideoSize.w,
    videoHeight: lastVideoSize.h,
    lastLandmarkCount,
    frameSeq,
    tickCount,
    lastTickDtMs: lastTickAt ? Math.round(t - lastTickAt) : null,
    pose: extraDebug?.pose ?? null,
    pinch: extraDebug?.pinch ?? null,
    handScale: Number.isFinite(lastHandScale) ? Number(lastHandScale.toFixed(3)) : null,
    scrollMode: "PINCH",
    scrollInvert: !!tuning.scrollInvert,
    handedness: lastHandedness,
    handednessScore: Number.isFinite(lastHandednessScore)
      ? Number(lastHandednessScore.toFixed(2))
      : null,
    delegate: activeDelegate,
  };
  send("STATUS", {
    running,
    cameraState: mediaStream ? "Active" : "Inactive",
    handDetected: !!handDetected,
    debug: { ...baseDebug, ...(extraDebug || {}) },
    ...Object.fromEntries(Object.entries(extra || {}).filter(([k]) => k !== "debug")),
  });
}

function classifyPoseByRatio(avgTipToWristRatio, stablePose) {
  // Hysteresis around FIST/OPEN to reduce flicker.
  if (stablePose === "FIST") {
    if (avgTipToWristRatio > tuning.fistExitRatio) return "OTHER";
    return "FIST";
  }
  if (stablePose === "OPEN") {
    if (avgTipToWristRatio < tuning.openExitRatio) return "OTHER";
    return "OPEN";
  }

  if (avgTipToWristRatio < tuning.fistEnterRatio) return "FIST";
  if (avgTipToWristRatio > tuning.openEnterRatio) return "OPEN";
  return "OTHER";
}

function updateStablePose(rt, nextPose) {
  if (nextPose === rt.poseCandidate) {
    rt.poseCandidateCount += 1;
  } else {
    rt.poseCandidate = nextPose;
    rt.poseCandidateCount = 1;
  }

  if (rt.poseCandidateCount >= tuning.poseStableFrames && rt.stablePose !== rt.poseCandidate) {
    rt.prevStablePose = rt.stablePose;
    rt.stablePose = rt.poseCandidate;
    return { changed: true, prev: rt.prevStablePose, next: rt.stablePose };
  }
  return { changed: false, prev: rt.prevStablePose, next: rt.stablePose };
}

function processHand({
  landmarks,
  handednessLabel,
  handednessScore,
  dtMs,
  actions,
  debugSummary,
}) {
  if (!Array.isArray(landmarks) || !landmarks.length) return;
  const rt = getHandRuntime(handednessLabel);
  const tNow = nowMs();

  if (rt.presentSinceMs == null) rt.presentSinceMs = tNow;
  const holdMs = clamp(Number(tuning.activationHoldMs ?? 180), 0, 800);
  const presenceOk = holdMs <= 0 ? true : tNow - rt.presentSinceMs >= holdMs;

  const handY = landmarks[9]?.y;
  if (typeof handY !== "number") return;

  if (rt.smoothedY == null) {
    rt.smoothedY = handY;
    rt.scrollLastY = handY;
    rt.zoomLastY = handY;
  } else {
    rt.smoothedY = lerp(rt.smoothedY, handY, tuning.ySmoothingAlpha);
  }

  const thumb = landmarks[4];
  const index = landmarks[8];
  const wrist = landmarks[0];
  const mid = landmarks[9];
  const tips = [landmarks[8], landmarks[12], landmarks[16], landmarks[20]];

  const pinchDist = thumb && index ? hypot2(thumb.x - index.x, thumb.y - index.y) : null;

  // Normalize distances by hand scale to reduce sensitivity to hand-to-camera distance.
  const handScale =
    wrist && mid ? hypot2(mid.x - wrist.x, mid.y - wrist.y) : null;
  lastHandScale = Number.isFinite(handScale) ? handScale : lastHandScale;

  const pinchMetric =
    pinchDist != null
      ? safeRatio(pinchDist, handScale, pinchDist)
      : null;

  let avgTipToWrist = null;
  if (wrist && tips.every(Boolean)) {
    avgTipToWrist =
      tips.reduce((sum, t) => sum + hypot2(t.x - wrist.x, t.y - wrist.y), 0) /
      tips.length;
  }

  const avgTipToWristMetric =
    avgTipToWrist != null
      ? safeRatio(avgTipToWrist, handScale, avgTipToWrist)
      : null;

  // --- Pinch state (used as a clutch for scroll/zoom)
  if (typeof pinchMetric === "number") {
    if (!rt.pinchActive && pinchMetric < tuning.pinchStartRatio) {
      rt.pinchActive = true;
      rt.pinchSinceMs = tNow;
    } else if (rt.pinchActive && pinchMetric > tuning.pinchEndRatio) {
      rt.pinchActive = false;
      rt.pinchSinceMs = null;
    }
  } else {
    // If we lose pinch metric, treat as released.
    rt.pinchActive = false;
    rt.pinchSinceMs = null;
  }

  rt.pinchQualifiedPrev = rt.pinchQualified;
  rt.pinchQualified =
    rt.pinchActive && rt.pinchSinceMs != null && (holdMs <= 0 ? true : tNow - rt.pinchSinceMs >= holdMs);

  if (rt.pinchQualified && !rt.pinchQualifiedPrev) {
    // When clutch becomes "armed", reset baselines to avoid a jump.
    rt.scrollLastY = rt.smoothedY;
    rt.scrollDyFiltered = 0;
    rt.zoomLastY = rt.smoothedY;
    rt.zoomDyFiltered = 0;
  }

  // --- Pose stability
  let instantPose = "UNKNOWN";
  let poseTransition = { changed: false, prev: rt.prevStablePose, next: rt.stablePose };
  if (features.video || tuning.scrollRequireOpenPalm) {
    if (typeof avgTipToWristMetric === "number") {
      instantPose = classifyPoseByRatio(avgTipToWristMetric, rt.stablePose);
      poseTransition = updateStablePose(rt, instantPose);
    } else {
      instantPose = "UNKNOWN";
      poseTransition = updateStablePose(rt, "UNKNOWN");
    }
  }

  // --- Video toggle: OPEN -> FIST transition (stable)
  if (
    features.video &&
    poseTransition.changed &&
    poseTransition.next === "FIST"
  ) {
    if (!tuning.videoRequireOpenToFist || poseTransition.prev === "OPEN") {
      const t = nowMs();
      if (handAllowed(tuning.videoModeHand, handednessLabel)) {
        if (t - lastVideoModeAt > tuning.videoModeCooldownMs) {
          send("CYCLE_VIDEO_MODE", {});
          lastVideoModeAt = t;
        }
      } else if (handAllowed(tuning.videoHand, handednessLabel)) {
        if (t - lastVideoToggleAt > tuning.videoCooldownMs) {
          send("TOGGLE_VIDEO", {});
          lastVideoToggleAt = t;
        }
      }
    }
  }

  const dtScale = clamp(dtMs / 33.33, 0.5, 2.0);

  // --- Scroll (pinch-hold clutch)
  if (features.scroll && !actions.scrollSent) {
    const handGateOk = handAllowed(tuning.scrollHand, handednessLabel);
    const clutchOk = presenceOk && rt.pinchQualified && instantPose !== "FIST";
    if (!handGateOk || !clutchOk || typeof rt.scrollLastY !== "number") {
      rt.scrollDyFiltered = 0;
      rt.scrollLastY = rt.smoothedY;
    } else {
      const rawDy = rt.smoothedY - rt.scrollLastY;
      rt.scrollLastY = rt.smoothedY;
      rt.scrollDyFiltered = lerp(rt.scrollDyFiltered, rawDy, tuning.dySmoothingAlpha);

      let dyPx = rt.scrollDyFiltered * tuning.scrollGain * dtScale;
      dyPx = clamp(dyPx, -tuning.scrollClampPxPerTick, tuning.scrollClampPxPerTick);
      if (tuning.scrollInvert) dyPx = -dyPx;
      if (Math.abs(dyPx) >= tuning.scrollDeadzonePx) {
        send("SCROLL", { dyPx });
        actions.scrollSent = true;
      }
    }
  }

  // --- Zoom (pinch-hold clutch + vertical drag => zoom)
  if (features.zoom && !actions.zoomSent) {
    const handGateOk = handAllowed(tuning.zoomHand, handednessLabel);
    const clutchOk = presenceOk && rt.pinchQualified && instantPose !== "FIST";
    if (!handGateOk || !clutchOk || typeof rt.zoomLastY !== "number") {
      rt.zoomDyFiltered = 0;
      rt.zoomLastY = rt.smoothedY;
    } else {
      const rawDy = rt.smoothedY - rt.zoomLastY;
      rt.zoomLastY = rt.smoothedY;
      rt.zoomDyFiltered = lerp(rt.zoomDyFiltered, rawDy, tuning.dySmoothingAlpha);

      let logDelta = rt.zoomDyFiltered * Number(tuning.zoomDragGain || 8) * dtScale;
      if (tuning.zoomInvert) logDelta = -logDelta;

      const dead = Math.max(0, Number(tuning.zoomDeadzoneLog ?? 0.008));
      if (Math.abs(logDelta) >= dead) {
        const clampMax = clamp(Number(tuning.zoomClampPerTick || 1.08), 1.01, 1.3);
        const maxLog = Math.log(clampMax);
        logDelta = clamp(logDelta, -maxLog, maxLog);
        const zoomDelta = Math.exp(logDelta);
        send("ZOOM_DELTA", { zoomDelta });
        actions.zoomSent = true;
      }
    }
  }

  // Debug summaries for popup.
  if (debugSummary) {
    debugSummary.push({
      hand: handednessLabel || "-",
      pose: rt.stablePose,
      pinch: rt.pinchQualified ? "ON" : rt.pinchActive ? "HOLD" : "OFF",
    });
  }

  // Keep some "last" fields for status UI.
  lastHandedness = handednessLabel;
  lastHandednessScore = Number.isFinite(handednessScore) ? handednessScore : null;
  lastHandScale = Number.isFinite(handScale) ? handScale : lastHandScale;
}

function tick() {
  if (!running) return;
  if (inTick) return;
  inTick = true;
  tickCount += 1;

  try {
    if (!videoEl || videoEl.readyState < 2 || !handLandmarker) {
      sendStatus(false);
      return;
    }

    const t = nowMs();
    const dt = lastTickAt ? t - lastTickAt : 33.33;
    lastTickAt = t;

    maybeSendPreviewFrame();
    const result = handLandmarker.detectForVideo(videoEl, t);
    const hands = Array.isArray(result?.landmarks) ? result.landmarks : [];
    const handednesses = Array.isArray(result?.handednesses) ? result.handednesses : [];

    const handDetected = hands.length > 0;
    lastLandmarkCount = handDetected ? hands.reduce((n, arr) => n + (arr?.length || 0), 0) : 0;
    lastLandmarks = handDetected ? hands.flat() : null;

    const seen = new Set();
    const actions = { scrollSent: false, zoomSent: false };
    const debugSummary = [];

    for (let i = 0; i < hands.length; i += 1) {
      const landmarks = hands[i];
      const handednessScore = handednesses?.[i]?.[0]?.score;
      if (Number.isFinite(handednessScore) && handednessScore < tuning.minHandednessScore) continue;

      const handednessLabelRaw =
        handednesses?.[i]?.[0]?.categoryName ??
        handednesses?.[i]?.[0]?.displayName ??
        handednesses?.[i]?.[0]?.label;
      const handednessLabel = maybeFlipHand(normalizeHandLabel(handednessLabelRaw)) || "unknown";
      seen.add(handednessLabel);

      processHand({
        landmarks,
        handednessLabel,
        handednessScore,
        dtMs: dt,
        actions,
        debugSummary,
      });
    }

    // Reset runtime for hands not seen this tick (prevents stale baselines).
    for (const [label, rt] of handRuntimeByLabel.entries()) {
      if (!seen.has(label)) resetHandRuntime(rt);
    }

    const poseText = debugSummary.map((h) => `${h.hand}:${h.pose}`).join(" ");
    const pinchText = debugSummary.map((h) => `${h.hand}:${h.pinch}`).join(" ");
    sendStatus(handDetected, { debug: { pose: poseText || null, pinch: pinchText || null } });
  } catch (e) {
    send("ERROR", { message: `${e?.name || "Error"}: ${e?.message || String(e)}` });
  } finally {
    inTick = false;
  }
}

async function start(payload) {
  features = { ...DEFAULT_FEATURES, ...(payload?.features || {}) };
  tuning = { ...DEFAULT_TUNING, ...(payload?.tuning || {}) };

  if (running) return;
  running = true;
  sendStatus(false);

  try {
    await initModelIfNeeded();
    await initCameraIfNeeded();
    lastTickAt = 0;
    handRuntimeByLabel.clear();
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(tick, 33);
    tick();
  } catch (e) {
    running = false;
    stopCamera();
    const msg = `${e?.name || "Error"}: ${e?.message || String(e)}`;
    send("ERROR", { message: msg });
    sendStatus(false);
  }
}

function stop() {
  running = false;
  handRuntimeByLabel.clear();
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  stopCamera();
  sendStatus(false);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "offscreen") return;
  if (msg.type === "START") start(msg.payload);
  if (msg.type === "STOP") stop();
  if (msg.type === "SET_FEATURES") {
    features = { ...features, ...(msg.payload || {}) };
  }
  if (msg.type === "SET_TUNING") {
    const prevGpu = !!tuning.useGpuDelegate;
    tuning = { ...tuning, ...(msg.payload || {}) };
    const nextGpu = !!tuning.useGpuDelegate;
    if (running && prevGpu !== nextGpu) {
      resetModel().catch(() => {});
    }
  }
});

sendStatus(false);
