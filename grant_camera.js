let stream = null;

function setStatus(text, { error = false } = {}) {
  const el = document.getElementById("status");
  el.textContent = text;
  el.classList.toggle("error", !!error);
}

async function stopStream() {
  if (!stream) return;
  for (const t of stream.getTracks()) t.stop();
  stream = null;
  const video = document.getElementById("video");
  video.pause();
  video.srcObject = null;
}

async function requestCamera() {
  try {
    setStatus("正在请求摄像头权限…");
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30, max: 60 },
        facingMode: "user",
      },
      audio: false,
    });

    const video = document.getElementById("video");
    video.srcObject = stream;
    await video.play().catch(() => {});

    setStatus("已获得摄像头权限，正在尝试启动手势识别…");
    await chrome.runtime.sendMessage({ source: "grant", type: "CAMERA_GRANTED" });
    // Release the camera so the background offscreen document can open it.
    await stopStream();
  } catch (e) {
    const msg = `${e?.name || "Error"}: ${e?.message || String(e)}`;
    setStatus(msg, { error: true });
    await chrome.runtime
      .sendMessage({ source: "grant", type: "CAMERA_ERROR", payload: { message: msg } })
      .catch(() => {});
  }
}

document.getElementById("btnGrant").addEventListener("click", () => {
  requestCamera().catch(() => {});
});

document.getElementById("btnClose").addEventListener("click", async () => {
  await stopStream();
  window.close();
});

window.addEventListener("beforeunload", () => {
  stopStream().catch(() => {});
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.source !== "sw" || msg.type !== "STATE_CHANGED") return;
  const s = msg.payload;
  if (!s) return;
  if (s.running && s.cameraState === "Active" && !s.needsCameraPermission && !s.lastError) {
    setStatus("启动成功，可以关闭此窗口。");
    // Let UI update once.
    setTimeout(() => window.close(), 350);
  }
});
