# 手势遥控（Chrome / Edge 扩展，MV3）

本扩展使用本地 MediaPipe HandLandmarker 模型（离线）通过摄像头手势控制网页：滚动 / 缩放 / 视频。

## 快速开始

1. 打开扩展管理页：`chrome://extensions` 或 `edge://extensions`
2. 开启「开发者模式」→「加载已解压的扩展程序」→ 选择本目录 `gesture-remoter-extension/`
3. 点击扩展图标打开弹窗：
   - 先点「授权摄像头」（会打开授权窗口；允许后自动关闭）
   - 再点「启动」

## 默认手势（可在弹窗调整左右手）

- 滚动：指定手「捏合按住」+ 上下移动
- 缩放：另一只手「捏合按住」+ 上下移动（控制页面缩放）
- 视频播放/暂停：指定手「握拳」触发一次（等价于点击视频播放层）
- 全屏切换：另一只手「握拳」触发（当前实现为发送 `F` 键；常见视频站点可用）

## 重要提示

- 受限页面：扩展无法在 `chrome://*` / `edge://*` / Chrome Web Store 等页面注入内容脚本
- iframe：仅在顶层页面运行，避免误控子页面滚动
- 本地 `file://` / PDF：
  - 需要在扩展详情页开启「允许访问文件网址」
  - PDF 滚动/按键模拟会使用 `chrome.debugger`，浏览器可能显示「正在调试此标签页」
- 若看到 `NotAllowedError` 且没有弹出授权窗口：
  - 检查系统摄像头隐私权限（Windows 设置 → 隐私和安全 → 摄像头）
  - 检查浏览器摄像头设置（`chrome://settings/content/camera` / `edge://settings/content/camera`）

## 模型与资源

- 所有 WASM 与模型位于本地 `gesture-remoter-extension/libs/`，不依赖 CDN
- 使用的模型文件：`gesture-remoter-extension/libs/hand_landmarker.task`

## 权限与隐私

- 摄像头画面仅用于本地手势识别，不上传、不出网
- `debugger` 权限仅用于 PDF 滚动与按键注入（例如全屏 `F`）

## 许可证

MIT License（见 `gesture-remoter-extension/LICENSE`，仓库根目录也有 `LICENSE`）。

