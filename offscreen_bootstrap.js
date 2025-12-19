// Suppress known noisy logs emitted by some Chromium/Edge builds when initializing
// media pipelines (GL) or TFLite CPU delegates. This does not affect functionality.
(() => {
  const patterns = [
    /gl_context\.cc:\d+\]\s+OpenGL error checking is disabled/i,
    /Created TensorFlow Lite XNNPACK delegate for CPU/i,
  ];

  const shouldSuppress = (args) => {
    if (!args || args.length === 0) return false;
    const first = args[0];
    if (typeof first !== "string") return false;
    return patterns.some((re) => re.test(first));
  };

  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const orig = console[level];
    if (typeof orig !== "function") continue;
    console[level] = (...args) => {
      if (shouldSuppress(args)) return;
      orig.apply(console, args);
    };
  }
})();

