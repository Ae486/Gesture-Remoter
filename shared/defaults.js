export const DEFAULT_FEATURES = Object.freeze({
  scroll: true,
  zoom: true,
  video: true,
});

export const DEFAULT_TUNING = Object.freeze({
  // General filtering
  minHandednessScore: 0.6,
  poseStableFrames: 4,
  activationHoldMs: 180,

  // Hand selection: "any" | "left" | "right"
  scrollHand: "left",
  zoomHand: "right",
  videoHand: "left",
  videoModeHand: "right",

  // Preview (for in-page overlay)
  previewEnabled: true,
  previewFps: 5,

  // Delegate (GPU may print OpenGL/WebGL errors on some systems; default to CPU for stability)
  useGpuDelegate: false,

  // Scroll (pinch-hold clutch + vertical drag)
  scrollUsePinchClutch: true,
  scrollRequireOpenPalm: false,
  // Touch-like direction: hand up => page down; hand down => page up.
  scrollInvert: true,
  scrollGain: 1500,
  scrollDeadzonePx: 6,
  scrollClampPxPerTick: 90,
  ySmoothingAlpha: 0.22,
  dySmoothingAlpha: 0.25,

  // Pinch detection (normalized by hand scale)
  pinchStartRatio: 0.18,
  pinchEndRatio: 0.28,

  // Zoom (pinch-hold clutch + vertical drag => zoom)
  zoomInvert: true,
  zoomDragGain: 8.0,
  zoomDeadzoneLog: 0.008,
  zoomClampPerTick: 1.08,

  // Pose (normalized by hand scale)
  fistEnterRatio: 0.82,
  fistExitRatio: 0.95,
  openEnterRatio: 1.25,
  openExitRatio: 1.1,

  // Video
  videoCooldownMs: 1200,
  videoModeCooldownMs: 900,
  videoRequireOpenToFist: false,
});

export const DEFAULT_CONTENT_CONFIG = Object.freeze({
  scrollTargetMode: "auto", // "auto" | "document"
  previewMirror: false,
  previewEnabled: true,
});
