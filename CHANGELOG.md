# 更新日志

twitter-image-saver.user.js 的版本更新记录。

## v1.4.0（2026-08-29）

新增「空闲自动停止」功能：

- 记录过程中定时轮询已记录数量，若在设定的时间窗口内数量持续没有增长，则自动结束记录。
- 新增两个脚本顶部可配置项（带合理默认值）：
  - `IDLE_TIMEOUT_MS`：空闲超时窗口，默认 `60 * 1000`（60 秒）；设为 `0` 可关闭该功能。
  - `IDLE_CHECK_INTERVAL_MS`：轮询间隔，默认 `5 * 1000`（5 秒）。
- 实现细节：
  - 已记录数量取自 `state.media.size`（Map 天然去重）。
  - 新增内部状态 `lastCount` / `lastGrowthAt` / `idleTimer` 及 `startIdleWatch()` / `stopIdleWatch()`。
  - 复用既有「满量自动保存」收尾逻辑：置 `state.autoSaving = true` 后延迟调用 `stopAndSave(true)`。
  - `startRecording()` 启动轮询，`stopAndSave()` 停止轮询。
- 约束：仅改动实现该功能所必需的代码，未更换依赖、未重构无关逻辑、未改动原有输出格式。

## 历史版本

### v1.3 — 视频日期还原 + 设置面板
- 还原视频媒体日期；引入设置面板（`TUNABLE` / `CONFIG_DEFAULTS`）。

### v1.2 — 视频漏识别修复（fixed 分支）
- 修复视频漏识别问题；该修复已合入主文件，原 `fixed` 快照为静态历史版本，不再维护。
