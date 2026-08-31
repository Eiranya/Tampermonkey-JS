// ==UserScript==
// @name         Instagram 媒体批量保存器
// @namespace    https://github.com/Eiranya/Tampermonkey-JS
// @version      1.3.0
// @description  在 Instagram 用户主页 / 帖子页一键批量保存图片和视频（打包 ZIP），JSON 优先解析内嵌数据（_sharedData / __additionalDataLoaded / xdt_api__v1__），支持轮播全量、增量去重、已保存记忆、小文件过滤（HEAD/Range 预筛 + 下载后实际字节复核）、自动排除快拍/精选封面、自动巡览逐帖采集、每半小时请求预算与风控熔断、断点续抓、可视化设置面板
// @author       WorkBuddy
// @updateURL    https://raw.githubusercontent.com/Eiranya/Tampermonkey-JS/main/instagram-image-saver.user.js
// @downloadURL  https://raw.githubusercontent.com/Eiranya/Tampermonkey-JS/main/instagram-image-saver.user.js
// @match        https://www.instagram.com/*
// @match        https://instagram.com/*
// @grant        GM_download
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_info
// @connect      www.instagram.com
// @connect      instagram.com
// @connect      *.cdninstagram.com
// @connect      *.fbcdn.net
// Round 4 (v1.1.1)：裸域名条目自动覆盖全部子域（含多级），比通配符更稳；
// 双保险：scontent-*.cdninstagram.com / video-*.cdninstagram.com / scontent.cdninstagram.com / scontent-*.fbcdn.net 全覆盖
// @connect      cdninstagram.com
// @connect      fbcdn.net
// v1.1.2：图片文件名日期段优先采用图片 HTTP 响应头 Last-Modified（解析 GM_xmlhttpRequest 的 responseHeaders），拿不到时回退原 taken_at 逻辑
// @run-at       document-start
// ==/UserScript==

// ════════════════════════════════════════════════════════════════
// 📦 内联 FileSaver（提供全局 saveAs，不依赖 CDN；可读版便于审查）
// ════════════════════════════════════════════════════════════════
/*
* FileSaver.js
* A saveAs() FileSaver implementation.
*
* By Eli Grey, http://eligrey.com
*
* License : https://github.com/eligrey/FileSaver.js/blob/master/LICENSE.md (MIT)
* source  : http://purl.eligrey.com/github/FileSaver.js
*/

// The one and only way of getting global scope in all environments
// https://stackoverflow.com/q/3277182/1008999
var _global = typeof window === 'object' && window.window === window
  ? window : typeof self === 'object' && self.self === self
  ? self : typeof global === 'object' && global.global === global
  ? global
  : this

function bom (blob, opts) {
  if (typeof opts === 'undefined') opts = { autoBom: false }
  else if (typeof opts !== 'object') {
    console.warn('Deprecated: Expected third argument to be a object')
    opts = { autoBom: !opts }
  }

  // prepend BOM for UTF-8 XML and text/* types (including HTML)
  if (opts.autoBom && /^\s*(?:text\/\S*|application\/xml|\S*\/\S*\+xml)\s*;.*charset\s*=\s*utf-8/i.test(blob.type)) {
    return new Blob([String.fromCharCode(0xFEFF), blob], { type: blob.type })
  }
  return blob
}

function download (url, name, opts) {
  var xhr = new XMLHttpRequest()
  xhr.open('GET', url)
  xhr.responseType = 'blob'
  xhr.onload = function () {
    saveAs(xhr.response, name, opts)
  }
  xhr.onerror = function () {
    console.error('could not download file')
  }
  xhr.send()
}

function corsEnabled (url) {
  var xhr = new XMLHttpRequest()
  // use sync to avoid popup blocker
  xhr.open('HEAD', url, false)
  try {
    xhr.send()
  } catch (e) {}
  return xhr.status >= 200 && xhr.status <= 299
}

// `a.click()` doesn't work for all browsers (#465)
function click (node) {
  try {
    node.dispatchEvent(new MouseEvent('click'))
  } catch (e) {
    var evt = document.createEvent('MouseEvents')
    evt.initMouseEvent('click', true, true, window, 0, 0, 0, 80,
                          20, false, false, false, false, 0, null)
    node.dispatchEvent(evt)
  }
}

// Detect WebView inside a native macOS app by ruling out all browsers
var isMacOSWebView = _global.navigator && /Macintosh/.test(navigator.userAgent) && /AppleWebKit/.test(navigator.userAgent) && !/Safari/.test(navigator.userAgent)

var saveAs = _global.saveAs || (
  (typeof window !== 'object' || window !== _global)
    ? function saveAs () { /* noop */ }

  : ('download' in HTMLAnchorElement.prototype && !isMacOSWebView)
  ? function saveAs (blob, name, opts) {
    var URL = _global.URL || _global.webkitURL
    var a = document.createElementNS('http://www.w3.org/1999/xhtml', 'a')
    name = name || blob.name || 'download'

    a.download = name
    a.rel = 'noopener' // tabnabbing

    if (typeof blob === 'string') {
      a.href = blob
      if (a.origin !== location.origin) {
        corsEnabled(a.href)
          ? download(blob, name, opts)
          : click(a, a.target = '_blank')
      } else {
        click(a)
      }
    } else {
      a.href = URL.createObjectURL(blob)
      setTimeout(function () { URL.revokeObjectURL(a.href) }, 4E4) // 40s
      setTimeout(function () { click(a) }, 0)
    }
  }

  : 'msSaveOrOpenBlob' in navigator
  ? function saveAs (blob, name, opts) {
    name = name || blob.name || 'download'

    if (typeof blob === 'string') {
      if (corsEnabled(blob)) {
        download(blob, name, opts)
      } else {
        var a = document.createElement('a')
        a.href = blob
        a.target = '_blank'
        setTimeout(function () { click(a) })
      }
    } else {
      navigator.msSaveOrOpenBlob(bom(blob, opts), name)
    }
  }

  : function saveAs (blob, name, opts, popup) {
    popup = popup || open('', '_blank')
    if (popup) {
      popup.document.title =
      popup.document.body.innerText = 'downloading...'
    }

    if (typeof blob === 'string') return download(blob, name, opts)

    var force = blob.type === 'application/octet-stream'
    var isSafari = /constructor/i.test(_global.HTMLElement) || _global.safari
    var isChromeIOS = /CriOS\/[\d]+/.test(navigator.userAgent)

    if ((isChromeIOS || (force && isSafari) || isMacOSWebView) && typeof FileReader !== 'undefined') {
      var reader = new FileReader()
      reader.onloadend = function () {
        var url = reader.result
        url = isChromeIOS ? url : url.replace(/^data:[^;]*;/, 'data:attachment/file;')
        if (popup) popup.location.href = url
        else location = url
        popup = null
      }
      reader.readAsDataURL(blob)
    } else {
      var URL = _global.URL || _global.webkitURL
      var url = URL.createObjectURL(blob)
      if (popup) popup.location = url
      else location.href = url
      popup = null
      setTimeout(function () { URL.revokeObjectURL(url) }, 4E4)
    }
  }
)

_global.saveAs = saveAs.saveAs = saveAs

if (typeof module !== 'undefined') {
  module.exports = saveAs;
}


// ════════════════════════════════════════════════════════════════
// 🔧 Chrome MV3 GM_xmlhttpRequest 并行挂起修复（gh_2215 workaround）
// 参考：https://github.com/Tampermonkey/tampermonkey/issues/2215
// Chrome MV3 下扩展无法在重定向时设置/删除 header（webextensions #694），
// 导致 GM_xmlhttpRequest 并发 GET 永久挂起。用 redirect:'manual' 手动跟随重定向绕过。
// 平台无关，直接复用。
// ════════════════════════════════════════════════════════════════
(function () {
  try {
    if (typeof GM_info === 'undefined' || typeof GM_xmlhttpRequest === 'undefined') return;
    if (GM_info.scriptHandler !== 'Tampermonkey') return;
    function cmp(a, b) {
      const pa = String(a).split('.').map(Number);
      const pb = String(b).split('.').map(Number);
      const len = Math.max(pa.length, pb.length);
      for (let i = 0; i < len; i++) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x > y) return 1;
        if (x < y) return -1;
      }
      return 0;
    }
    if (cmp(GM_info.version, '5.3.2') < 0) return;

    const orig = GM_xmlhttpRequest;
    GM_xmlhttpRequest = function (details) {
      if (details.redirect !== undefined) return orig(details);
      const onload = details.onload, onerror = details.onerror,
        onabort = details.onabort, ontimeout = details.ontimeout,
        onloadend = details.onloadend;

      function handle(initial) {
        return orig(Object.assign({}, initial, {
          redirect: 'manual',
          onload: function (res) {
            if (res.status >= 300 && res.status < 400) {
              const m = String(res.responseHeaders || '').match(/Location:\s*(\S+)/i);
              if (m && m[1]) {
                handle(Object.assign({}, initial, { url: new URL(m[1], initial.url).href }));
                return;
              }
            }
            if (onload) onload.call(this, res);
            if (onloadend) onloadend.call(this, res);
          },
          onerror: function (res) { if (onerror) onerror.call(this, res); if (onloadend) onloadend.call(this, res); },
          onabort: function (res) { if (onabort) onabort.call(this, res); if (onloadend) onloadend.call(this, res); },
          ontimeout: function (res) { if (ontimeout) ontimeout.call(this, res); if (onloadend) onloadend.call(this, res); },
        }));
      }
      return handle(details);
    };
    console.log('[Instagram媒体保存] 已启用 MV3 GM_xhr 并行修复');
  } catch (e) {
    console.warn('[Instagram媒体保存] MV3 修复安装失败:', e);
  }
})();

(function () {
  'use strict';

  // ════════════════════════════════════════════════════════════════
  // 🐞 Debug 模式（v1.1.20）：由油猴菜单操控（工具栏图标 → 菜单切换），状态持久化。
  // 开启后：设置面板显示「导出诊断JSON」按钮与高级参数（视频打包阈值/ZIP 分卷阈值）、
  // 注册「📤 导出诊断 JSON」菜单命令。默认关闭，页面零干扰。
  // ════════════════════════════════════════════════════════════════
  let debugMode = false;
  try { debugMode = !!GM_getValue('igDebugMode', false); } catch (e) {}

  // v1.1.22：脚本版本号（与 @version 元数据同步，设置面板 Debug 小节展示）
  const SCRIPT_VERSION = '1.3.0';

  // ════════════════════════════════════════════════════════════════
  // 📌 配置区
  // ════════════════════════════════════════════════════════════════
  // 可在设置面板里调整的配置项（内部单位：字节 / 毫秒 / 百分比整数）
  // 说明：Instagram 信息流是图片密集型、风控敏感，滚动节奏显著慢于 Twitter 工具。
  // 默认滚动间隔 10s 基准 ±30% 抖动（约 7–13s，落在设计文档建议的 5–15s 区间）。
  const CONFIG_DEFAULTS = Object.freeze({
    // v1.2.1：每半小时媒体抓取/下载请求预算（次），接近即自动暂停采集。
    // 窗口时长由内部常量 BUDGET_WINDOW_MS 控制（30 分钟），请与面板标签保持一致。
    REQUEST_BUDGET: 80,
    // v1.1.19/v1.1.20：满量自动保存触发阈值（按"已采集帖子数"计）。
    // 已与"缓存上限"合并为一个功能——达到该帖数即自动保存；媒体缓存硬上限由它派生（×20），
    // 不再单独暴露配置。
    MAX_AUTO_SAVE_POSTS: 50,
    // 每个 ZIP 打包的媒体数量上限（避免单 zip 内存爆炸）
    BATCH_SIZE: 150,
    // v1.2.1：拉取 Blob 并发数默认降为 1（串行），并移入 Debug 高级参数。
    // 串行下载对 Instagram CDN 更"像人"，显著降低触发风控的概率；代价是打包速度变慢。
    DOWNLOAD_CONCURRENCY: 1,
    // v1.1.20：媒体最小体积（字节）——图片与视频统一阈值，小于该值的媒体视为无效/损坏跳过
    MIN_MEDIA_SIZE: 50 * 1024,
    // 轮播点击展开上限（次/帖），JSON 缺失时兜底用
    MAX_CAROUSEL_CLICKS: 15,
    // Round 9：自动巡览帖子（默认关闭）——自动打开帖子详情页、采集完成后自动切下一帖、末页自动停止
    AUTO_TOUR: false,
    // 单帖等待渲染超时（毫秒）：进入详情页后等主媒体/JSON 就绪的最长时间，超时跳过该帖防卡死
    TOUR_WAIT_MS: 15000,
    // 巡览帖子数上限（防无限巡览，达到后自动停止并保存）
    TOUR_MAX_POSTS: 100,
    // v1.1.17：ZIP 分卷阈值（MB）——打包后单个 ZIP 超过该值则分开打包
    ZIP_SPLIT_MB: 1024,
    // v1.1.22：视频打包阈值（MB）——小于该值的视频打包进 ZIP；≥ 该值的大视频保存时单独下载（GM_download）
    VIDEO_ZIP_MAX_MB: 150,
    // v1.2.2：下载请求随机间隔（毫秒）——每次下载类请求（HEAD/Range 探测、Blob 拉取、GM_download）
    // 发出前随机等待，呈"短间隔为主、长间隔稀少"的偏态分布，避免请求集中发送触发风控
    DOWNLOAD_DELAY_MIN_MS: 400,
    DOWNLOAD_DELAY_MAX_MS: 5000,
  });

  // 设置面板的字段描述：scale = 显示单位 → 内部单位的换算
  const TUNABLE = [
    { key: 'REQUEST_BUDGET',       label: '每半小时请求预算', unit: '次', scale: 1, min: 20,  max: 1000,  step: 10 },
    { key: 'MAX_AUTO_SAVE_POSTS',  label: '满量自动保存', unit: '帖', scale: 1,    min: 10,  max: 2000,  step: 10 },
    { key: 'BATCH_SIZE',           label: '每包数量',     unit: '个', scale: 1,    min: 10,  max: 500,   step: 10 },
    { key: 'MIN_MEDIA_SIZE',       label: '媒体最小体积', unit: 'KB', scale: 1024, min: 0,   max: 10240, step: 5 },
    { key: 'MAX_CAROUSEL_CLICKS',  label: '轮播点击上限', unit: '次', scale: 1,    min: 1,   max: 50,    step: 1 },
    { key: 'TOUR_WAIT_MS',         label: '巡览等待渲染', unit: '秒', scale: 1000, min: 3,   max: 120,   step: 1 },
    { key: 'TOUR_MAX_POSTS',       label: '巡览帖子上限', unit: '篇', scale: 1,    min: 5,   max: 1000,  step: 5 },
    // v1.1.22：仅 Debug 模式显示的高级参数（视频打包阈值 / ZIP 分卷阈值）
    // v1.2.1：下载并发也移入本组（默认 1 路串行，普通用户无需调整）
    { key: 'DOWNLOAD_CONCURRENCY', label: '下载并发',     unit: '路', scale: 1,    min: 1,   max: 8,     step: 1, debugOnly: true },
    { key: 'VIDEO_ZIP_MAX_MB',     label: '视频打包阈值', unit: 'MB', scale: 1,    min: 10,  max: 1024,  step: 10, debugOnly: true },
    { key: 'ZIP_SPLIT_MB',         label: 'ZIP 分卷阈值', unit: 'MB', scale: 1,    min: 100, max: 4096,  step: 100, debugOnly: true },
    // v1.2.2：下载请求随机间隔（毫秒），仅 Debug 模式显示
    { key: 'DOWNLOAD_DELAY_MIN_MS', label: '下载间隔下限', unit: '毫秒', scale: 1, min: 0,  max: 60000,  step: 10, debugOnly: true },
    { key: 'DOWNLOAD_DELAY_MAX_MS', label: '下载间隔上限', unit: '毫秒', scale: 1, min: 10, max: 120000, step: 50, debugOnly: true },
  ];

  const CONFIG = {
    ...CONFIG_DEFAULTS,
    // ── 内部常量（面板不可调）──
    // v1.2.1：请求预算窗口时长（毫秒）——由"每小时"下调为"每半小时"。
    // 窗口越短，爆发式请求被摊平得越保守；与 REQUEST_BUDGET 一起决定实际速率上限。
    BUDGET_WINDOW_MS: 30 * 60 * 1000,
    // v1.3.0：下载间隔偏斜指数——delay = min + (max-min) * rand^SKEW，>1 时短间隔出现概率更高
    // ★ 内部常量，不进设置面板（用户明确要求从设置菜单移除，仅改代码调整）
    // SKEW=2 时：约 15% 的间隔 < 0.5s、约 36% < 1s、约 32% > 2.5s（min=400ms / max=5000ms 基准）
    // 相比 SKEW=4 把约 45% 间隔压在 0.3–0.5s 的"节拍器式"密集簇，SKEW=2 拉长间隔、制造偶发长停顿，更贴近真人节奏、更抗风控
    DOWNLOAD_DELAY_SKEW: 2,
    // v1.3.0：下载顺序随机打乱（抗风控——避免请求按采集顺序规律排列）。
    // ★ 内部常量，不进设置面板；置 false 可恢复原始顺序（调试用）。
    SHUFFLE_DOWNLOAD_ORDER: true,
    // HEAD 请求并发数
    HEAD_CONCURRENCY: 4,
    // 轮播点击展开的最小/最大间隔（毫秒，随机化）
    CLICK_MIN_DELAY_MS: 800,
    CLICK_MAX_DELAY_MS: 1600,
    // 空闲自动停止：记录数量在该窗口内持续没有增长就自动结束记录并打包
    IDLE_TIMEOUT_MS: 120 * 1000,
    IDLE_CHECK_INTERVAL_MS: 10 * 1000,
    // 已处理短码集合上限
    PROCESSED_MAX: 5000,
    // 已保存媒体 key 集合上限
    SAVED_KEYS_MAX: 5000,
    // 单个媒体拉取超时
    REQUEST_TIMEOUT_MS: 60000,
    // 按钮位置
    BUTTON_POSITION: { bottom: '24px', right: '24px' },
    BUTTON_Z_INDEX: 999999,
  };

  const CONFIG_STORE_KEY = 'igSaverConfig';
  // v1.1.13：布尔开关配置（设置面板 checkbox，非 TUNABLE 数值项）同样需要持久化——
  // 否则刷新后开关重置为默认（用户反馈"巡览模式按钮每次刷新都会重置"）。
  const BOOL_KEYS = ['AUTO_TOUR'];

  function loadUserConfig() {
    let raw = {};
    try { raw = JSON.parse(GM_getValue(CONFIG_STORE_KEY, '{}') || '{}'); } catch (e) {}
    for (const t of TUNABLE) {
      if (t.type === 'select') {
        if (t.options.some((o) => o.v === raw[t.key])) CONFIG[t.key] = raw[t.key];
        continue;
      }
      const v = Number(raw[t.key]);
      if (Number.isFinite(v) && v >= t.min && v <= t.max) CONFIG[t.key] = v;
    }
    // v1.1.13：恢复布尔开关
    for (const k of BOOL_KEYS) {
      if (typeof raw[k] === 'boolean') CONFIG[k] = raw[k];
    }
  }
  loadUserConfig();

  function saveUserConfig() {
    const out = {};
    for (const t of TUNABLE) out[t.key] = CONFIG[t.key];
    // v1.1.13：布尔开关一并持久化
    for (const k of BOOL_KEYS) out[k] = CONFIG[k];
    try { GM_setValue(CONFIG_STORE_KEY, JSON.stringify(out)); } catch (e) { log('保存配置失败:', e); }
  }

  // ════════════════════════════════════════════════════════════════
  // 📦 状态管理
  // ════════════════════════════════════════════════════════════════
  const state = {
    isRecording: false,
    saving: false,
    autoSaving: false,
    // 已记录媒体 Map：key = `ig:{shortcode}:{slideIndex}` 或 CDN 内容签名基址
    media: new Map(),
    // v1.1.14/v1.1.17：已入库媒体 URL 归一化基址 → 当前 key 映射（同一媒体只存一次；
    // 若先采到缩略图、后到原图，则高清替换低清）
    mediaBaseKey: new Map(),
    // 帖级元数据 Map：shortcode -> meta 对象（随 ZIP 一并打包）
    postMeta: new Map(),
    // 分页游标（next_max_id / end_cursor）
    cursor: null,
    // 风控熔断状态：null | {kind, message}
    fuse: null,
    // 请求预算暂停
    budgetPaused: false,
    // Round 4 (v1.1.1)：Tampermonkey @connect 白名单拦截标记（下载失败特征命中时置位，面板/按钮引导）
    connectBlocked: false,
    // 轮播点击展开进行中
    clicking: false,
    observer: null,
    _discoverTimer: null,
    btnEl: null,
    hookInstalled: false,
    settingsOpen: false,
    panelStatusEl: null,
    // 空闲自动停止用
    lastCount: 0,
    lastGrowthAt: 0,
    idleTimer: null,
    // Round 6：诊断导出（捕获真实页面结构，供离线精修抓取逻辑）
    diagNodes: new Map(),    // shortcode -> 原始帖子 JSON 节点
    diagEmbedded: [],        // 内嵌 <script type="application/json"> 文本样本
    diagRaw: [],             // 原始 GraphQL/SSR 载荷（含 shortcode/display_url 等标记），绕过 scanForMediaJson 识别
    // Round 9：自动巡览帖子状态机（全程 SPA 导航，不刷新页面 → state.media 内存不丢）
    tour: {
      active: false,         // 巡览进行中
      queue: [],             // 网格页收集的待巡览 shortcode 队列
      queueIdx: 0,
      visited: new Set(),    // 本次巡览已进入的 URL（去重防循环）
      lastUrl: '',           // URL 轮询基准
      urlTimer: null,        // URL 变化轮询定时器（250ms，借鉴 ig-helper 思路）
      waitTimer: null,       // 单帖等待渲染轮询定时器
      postsDone: 0,          // 已巡览帖数
      failStreak: 0,         // 连续无进展计数（渲染超时/导航无变化），>=3 自动停止
      waiting: false,        // 等待渲染中（防止重复调度）
      lastNavAt: 0,          // 上次导航时间（防导航风暴）
      gate: true,            // v1.1.10 巡览门控：true=在网格页/未进帖（暂停采集），false=已进帖（正常采集）
      currentSc: null,       // v1.1.11 当前巡览帖子短码（只采当前帖，过滤相关网格等旁支内容）
      username: null,        // v1.1.11 巡览起始账号名（网格页 URL 提取，供文件名前缀兜底）
    },
    // v1.1.11 当前采集到的账号名（从帖子 JSON 节点 owner/user.username 提取，优先用于文件名前缀）
    ownerUsername: null,
  };

  // 已保存媒体去重集合（持久化，避免重新记录已保存过的媒体）
  let _savedRaw = [];
  try { _savedRaw = JSON.parse(GM_getValue('savedMediaKeys', '[]') || '[]'); } catch (e) {}
  const savedMediaKeys = new Set(_savedRaw);

  // ── 断点续抓状态（ResumeState）──
  const RESUME_KEY = 'igResumeState';
  function freshResumeState() {
    return { processedShortcodes: [], cursor: null, startedAt: Date.now(), failedItems: [] };
  }
  function loadResumeState() {
    try {
      const raw = JSON.parse(GM_getValue(RESUME_KEY, 'null') || 'null');
      if (!raw || typeof raw !== 'object') return null;
      if (!Array.isArray(raw.processedShortcodes)) raw.processedShortcodes = [];
      if (!Array.isArray(raw.failedItems)) raw.failedItems = [];
      return raw;
    } catch (e) {
      return null;
    }
  }
  function saveResumeState() {
    try {
      GM_setValue(RESUME_KEY, JSON.stringify({
        processedShortcodes: Array.from(processedShortcodes).slice(-CONFIG.PROCESSED_MAX),
        cursor: resumeState.cursor,
        startedAt: resumeState.startedAt,
        failedItems: (resumeState.failedItems || []).slice(0, 500),
      }));
    } catch (e) {
      log('保存断点状态失败:', e);
    }
  }

  // 断点状态：无历史时也要给一个默认对象，避免任何 saveResumeState 调用点拿到 null
  let resumeState = loadResumeState() || freshResumeState();
  let processedShortcodes = new Set(resumeState.processedShortcodes || []);
  // 启动时发现上次有进度 → 点击"开始采集"即断点续抓
  let hasPendingResume = !!(resumeState && resumeState.processedShortcodes && resumeState.processedShortcodes.length);

  function trimProcessed() {
    if (processedShortcodes.size > CONFIG.PROCESSED_MAX) {
      const arr = Array.from(processedShortcodes);
      processedShortcodes = new Set(arr.slice(arr.length - CONFIG.PROCESSED_MAX));
    }
  }

  // 保存成功后标记为已保存并持久化
  function markSaved(keys) {
    for (const k of keys) savedMediaKeys.add(k);
    try {
      const arr = Array.from(savedMediaKeys).slice(-CONFIG.SAVED_KEYS_MAX);
      GM_setValue('savedMediaKeys', JSON.stringify(arr));
    } catch (e) {
      log('持久化已保存列表失败:', e);
    }
  }

  const MARK_CLASS = 'ig-media-saver-mark';

  // ════════════════════════════════════════════════════════════════
  // 🛠 工具函数
  // ════════════════════════════════════════════════════════════════

  function log(msg, ...args) {
    console.log(`[Instagram媒体保存] ${msg}`, ...args);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function runConcurrent(items, concurrency, fn) {
    const results = [];
    let index = 0;
    async function worker() {
      while (index < items.length) {
        const i = index++;
        try { results[i] = await fn(items[i], i); }
        catch (e) { results[i] = { error: e }; }
      }
    }
    const workers = [];
    for (let i = 0; i < Math.min(concurrency, items.length); i++) workers.push(worker());
    await Promise.all(workers);
    return results;
  }

  function getPageWindow() {
    try {
      return (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    } catch (e) {
      return window;
    }
  }

  function currentUsername() {
    // v1.1.11：优先已记录的账号名（JSON 帖子节点 owner/user.username），
    // 其次巡览起始网格页记录；URL 解析时排除 p/reel/tv 类型段（/p/sc/ /reel/sc/ 无用户名）。
    if (state.ownerUsername) return state.ownerUsername;
    if (state.tour && state.tour.active && state.tour.username) return state.tour.username;
    const seg = (location.pathname || '').split('/').filter(Boolean)[0];
    if (!seg || seg === 'p' || seg === 'reel' || seg === 'tv') return state.ownerUsername || 'instagram';
    return seg;
  }

  /**
   * 短码识别：从 /p/<shortcode>/ /reel/<shortcode>/ /tv/<shortcode>/ 链接提取 shortcode
   * IG 短码是 base64url 字母表（A-Za-z0-9_-），通常 11 位
   */
  function extractShortcode(urlOrPath) {
    const m = String(urlOrPath || '').match(/\/(?:p|reel|tv)\/([A-Za-z0-9_-]{5,})/);
    return m ? m[1] : null;
  }

  // HTML 实体反转义（application/json 脚本块里可能有 &quot; 等）
  function decodeHtmlEntities(s) {
    return String(s)
      .replace(/&quot;/g, '"')
      .replace(/&#34;/g, '"')
      .replace(/&#x27;|&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\\u0022/g, '"')
      .replace(/\\u0026/g, '&');
  }

  function parseJsonRobust(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) {}
    try { return JSON.parse(decodeHtmlEntities(text)); } catch (e) {}
    return null;
  }

  /**
   * srcset 原图化：取最大档候选；对 CDN URL 只剥离纯尺寸参数，
   * 保留签名参数（stp / _nc_* / oh / oe 等不可乱删）。
   */
  function pickSrcsetMax(img) {
    const srcset = (img && (img.getAttribute('srcset') || img.srcset)) || '';
    if (!srcset) {
      const s = (img && (img.src || img.getAttribute('src'))) || '';
      return s || null;
    }
    let best = null;
    let bestW = -1;
    for (const part of srcset.split(',')) {
      const t = part.trim();
      if (!t) continue;
      const pieces = t.split(/\s+/);
      const url = pieces[0];
      if (!url) continue;
      const w = pieces[1] && pieces[1].endsWith('w') ? parseInt(pieces[1], 10) : 0;
      if (w > bestW) { bestW = w; best = url; }
    }
    return best || img.src || img.getAttribute('src') || null;
  }

  /** 是否为 IG 媒体 CDN 域（cdninstagram.com / fbcdn.net 及子域） */
  function isCdnHost(hostname) {
    return /cdninstagram\.com$/i.test(hostname) || /\.cdninstagram\.com$/i.test(hostname) ||
      /\.fbcdn\.net$/i.test(hostname) || hostname === 'fbcdn.net';
  }

  function toHighResUrl(url) {
    try {
      const u = new URL(url);
      if (!isCdnHost(u.hostname)) return url;
      // 只剥离纯尺寸参数（s/size/width/height/w/h），签名参数一律保留
      for (const k of ['s', 'size', 'width', 'height', 'w', 'h']) u.searchParams.delete(k);
      return u.toString();
    } catch (e) {
      return url;
    }
  }

  // CDN URL 的内容签名参数（签名不可乱删；stp 是尺寸 token，不参与内容签名）
  const SIGNATURE_PARAMS = ['_nc_cat', '_nc_ht', '_nc_ohc', '_nc_zt', '_nc_rid', '_nc_eui2', '_nc_sid', '_nc_oc', '_nc_auc', 'ccb', 'oh', 'oe', 'edm'];

  /**
   * 去重基址（内容签名）：保留签名参数、剥离尺寸类参数。
   * 用于跨滚动轮次累计去重（Instagram 虚拟化滚动会把滚出视口的帖子移出 DOM）。
   * v1.1.23：优先用 ig_cache_key（IG 内容签名）——同一图片无论尺寸档（640/2048）、
   * 无论请求签名（_nc_gid/_nc_ss/_nc_ht/_nc_oc 等）如何变化，ig_cache_key 都相同。
   * 用它归一化可让"DOM 640 缩略图 + JSON 原图"正确合并并高清替换（此前签名差异导致
   * 同一张图被当作两张，640 未被原图替换——用户反馈"部分图没获取到原图"的根因）。
   */
  function getBaseUrl(url) {
    try {
      const u = new URL(url);
      if (isCdnHost(u.hostname)) {
        const ck = u.searchParams.get('ig_cache_key');
        if (ck) return u.origin + u.pathname + '?ig_cache_key=' + encodeURIComponent(ck);
        const p = new URLSearchParams();
        for (const [k, v] of u.searchParams) if (SIGNATURE_PARAMS.includes(k)) p.set(k, v);
        const q = p.toString();
        return u.origin + u.pathname + (q ? '?' + q : '');
      }
      return u.origin + u.pathname;
    } catch (e) {
      return url;
    }
  }

  /**
   * v1.1.17：媒体清晰度评分——从 URL 的尺寸 token（stp 参数里的 pWxH / sWxH）估算像素数；
   * 无尺寸 token 视为原图级（高分）。用于"先采到缩略图、后到原图"时高清替换低清。
   */
  function resScore(url) {
    const s = String(url || '');
    const m = s.match(/[ps](\d{2,4})x(\d{2,4})/);
    if (!m) return 100000000; // 无尺寸 token → 原图级
    return parseInt(m[1], 10) * parseInt(m[2], 10);
  }
  function isHigherResUrl(a, b) {
    return resScore(a) > resScore(b);
  }

  /**
   * 媒体去重 key：优先 `ig:{shortcode}:{slideIndex}`（内容签名去重），
   * 拿不到短码时退回 CDN 基址。
   */
  function getMediaKey(item) {
    if (item && item.key) return item.key;
    if (item && item.shortcode && typeof item.slideIndex === 'number') return 'ig:' + item.shortcode + ':' + item.slideIndex;
    return getBaseUrl(item && item.url);
  }

  function getExtension(url) {
    try {
      const u = new URL(url);
      const m = u.pathname.match(/\.(jpg|jpeg|png|webp|gif|mp4|heic)(?=$|\.)/i);
      if (m) return m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    } catch (e) {}
    return 'jpg';
  }

  /** 从去重 key `ig:{shortcode}:{slideIndex}` 还原 shortcode（失败重试恢复上下文用） */
  function shortcodeFromKey(key) {
    const m = String(key || '').match(/^ig:([A-Za-z0-9_-]+):\d+$/);
    return m ? m[1] : null;
  }

  function formatSize(bytes) {
    if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
    if (bytes > 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${bytes}B`;
  }

  function currentDateStamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  }

  // ════════════════════════════════════════════════════════════════
  // 🔍 选择器集中管理（IG 改版时单点修复）
  // 语义特征优先（aria-label / role / 链接特征），class 只作辅助
  // ════════════════════════════════════════════════════════════════
  const SELECTORS = {
    // 帖子链接（网格/feed/单帖页）：语义特征是 href 含 /p/ /reel/ /tv/
    postLink: 'a[href*="/p/"], a[href*="/reel/"], a[href*="/tv/"]',
    // 网格图（CDN 域名特征）
    gridImg: 'img[srcset*="cdninstagram.com"], img[src*="cdninstagram.com"]',
    // 主内容容器
    mainContainer: 'main',
    // v1.1.14：当前帖主媒体区（article）——详情页 main 内还含"相关帖子"网格，
    // DOM 兜底必须限定在 article 内，否则会把不属于当前帖的推荐图采进来
    postArticle: 'main article, article',
    // 主区域图片（单帖页/对话框内）
    mainImg: 'main img[srcset*="cdninstagram.com"], main img[src*="cdninstagram.com"], img[src*="cdninstagram.com"][srcset]',
    // 视频元素
    video: 'video',
    // 轮播"下一张"按钮：语义特征 aria-label（中英）。v1.1.15：去掉全局 [aria-label="Next"]——
    // 详情页顶部"下一帖"按钮同样带该 aria-label，全局匹配会把单图帖误判成多图。
    carouselNext: 'div[role="dialog"] [aria-label="Next"], div[role="dialog"] [aria-label="下一步"], article [aria-label="Next"], article [aria-label="下一步"]',
    // Round 9：详情页"下一帖"按钮（自动巡览切帖用）：IG 桌面端右上角箭头，aria-label 中英多候选
    tourNext: 'div[role="dialog"] [aria-label="Next"], div[role="dialog"] [aria-label="下一个"], svg[aria-label="Next"], [aria-label="Next"], [aria-label="下一个"], [aria-label="下一步"]',
    // 登录墙特征（P1：页内弹窗登录时 URL 不变，需检测 HTML）
    loginForm: 'form input[name="username"], input[name="username"]',
    // 登录弹窗：dialog 内的 username 输入框（语义特征）
    loginDialog: 'div[role="dialog"] input[name="username"]',
    // 登录文案/aria 特征（中英）
    loginText: '[aria-label="Log in to Instagram"], [aria-label="登录 Instagram"], [aria-label="Log in"]',
  };

  // ════════════════════════════════════════════════════════════════
  // 🚦 请求预算 & 风控熔断
  // ════════════════════════════════════════════════════════════════
  // 油猴脚本运行在用户真实登录的浏览器会话里，UA 由浏览器控制、IP 由网络出口决定，
  // 因此代理池切换 / UA 轮换在油猴边界内技术上不可实现，也不应伪造。
  // 等价反爬策略：人在回路人速滚动 + 全随机抖动 + 请求预算封顶 + 命中即停 + JSON 优先最小化请求。
  const budget = {
    windowStart: Date.now(),
    count: 0,
    paused: false,
  };

  function countRequest(n = 1) {
    budget.count += n;
    if (budget.count >= CONFIG.REQUEST_BUDGET && !budget.paused) {
      setBudgetPaused(true);
    }
  }

  // 检查预算窗口是否翻转（v1.2.1：由每小时改为每半小时，见 CONFIG.BUDGET_WINDOW_MS）
  function checkBudget() {
    const now = Date.now();
    if (now - budget.windowStart >= CONFIG.BUDGET_WINDOW_MS) {
      budget.windowStart = now;
      budget.count = 0;
      if (budget.paused) setBudgetPaused(false);
    }
    return budget.count >= CONFIG.REQUEST_BUDGET;
  }

  function setBudgetPaused(v) {
    budget.paused = v;
    state.budgetPaused = v;
    if (v) {
      stopAutoTour();
      log(`请求预算已用尽（${budget.count}/${CONFIG.REQUEST_BUDGET}），自动暂停采集，等待窗口重置`);
      try {
        GM_notification({ title: 'Instagram 媒体保存', text: `请求预算已用尽（${budget.count}/${CONFIG.REQUEST_BUDGET}），已暂停自动采集` });
      } catch (e) {}
      updatePanel();
    } else {
      log('预算窗口已重置，恢复采集');
      updatePanel();
    }
  }

  function clearBudgetPause() {
    budget.windowStart = Date.now();
    budget.count = 0;
    budget.paused = false;
    state.budgetPaused = false;
    log('已手动重置请求预算');
    updateButton();
    updatePanel();
  }

  /**
   * 风控检测：429 / Challenge / Action Blocked / 登录墙。
   * 返回 null 表示正常；否则返回 { kind, message }。
   */
  function detectBlock(response, bodyText) {
    const status = (response && response.status) || 0;
    const body = String(bodyText || '');
    const url = String((response && (response.finalUrl || response.url)) || '');
    if (status === 429 || /rate[_ -]?limit/i.test(body)) {
      return { kind: 'RATE_LIMIT', message: '请求过于频繁（429），已触发风控熔断，请稍后再试' };
    }
    if (status === 403) {
      // IG 站内接口 403 通常是登录态失效 / 被拒；CDN 资源 403 多为签名过期，不误判
      let host = '';
      try { host = new URL(url).hostname; } catch (e) {}
      if (host === 'instagram.com' || host === 'www.instagram.com' || /\.instagram\.com$/.test(host)) {
        return { kind: 'LOGIN', message: '请求被拒绝（403）：登录态可能已失效，请重新登录后再试' };
      }
    }
    if (body.includes('login_required') || body.includes('Please log in') || url.includes('/accounts/login/')) {
      return { kind: 'LOGIN', message: '检测到登录墙：请先登录 Instagram 或稍后再试' };
    }
    if (body.includes('consent_required')) {
      return { kind: 'LOGIN', message: '检测到 consent_required：需要登录确认' };
    }
    if (body.includes('challenge') || url.includes('/challenge/')) {
      return { kind: 'CHALLENGE', message: '检测到验证码/Challenge：已自动停止，请手动完成验证后重试' };
    }
    if (/action[_ -]?blocked/i.test(body)) {
      return { kind: 'BLOCKED', message: '检测到 Action Blocked：请停止操作，稍后（建议数小时）再试' };
    }
    return null;
  }

  /** 风控熔断：立即停止自动巡览/采集 + 面板醒目提示，绝不重试硬闯 */
  function triggerFuse(det) {
    if (!det || !det.kind) return;
    state.fuse = det;
    stopAutoTour();
    stopIdleWatch();
    updateButton();
    updatePanel();
    try { GM_notification({ title: 'Instagram 媒体保存', text: det.message }); } catch (e) {}
    log('⚠ 风控熔断:', det.kind, det.message);
  }

  function clearFuse() {
    state.fuse = null;
    updateButton();
    updatePanel();
  }

  // 从 GM_xhr 响应里检测风控并熔断
  function maybeFuseResponse(response, bodyText) {
    const det = detectBlock(response, bodyText);
    if (det) triggerFuse(det);
    return det;
  }

  // DOM 层登录墙检测：URL 跳转（/accounts/login /challenge/）+ 页内登录弹窗 HTML 特征
  function checkLoginWallDom() {
    try {
      const path = location.pathname || '';
      const forcedLogin = path.startsWith('/accounts/login') || path.startsWith('/challenge/');
      // 页内登录弹窗：URL 未变但出现 dialog 内登录表单 / aria 登录文案 → 同样熔断
      const inPageLogin = !!(document.querySelector(SELECTORS.loginDialog) || document.querySelector(SELECTORS.loginText));
      if ((forcedLogin || inPageLogin) && !state.fuse) {
        triggerFuse({ kind: 'LOGIN', message: '检测到登录墙/验证页（含页内登录弹窗）：请先登录 Instagram 或稍后再试' });
      }
    } catch (e) {}
  }

  // ════════════════════════════════════════════════════════════════
  // 📦 JSON 优先：内嵌结构化数据解析
  // 覆盖 _sharedData / __additionalDataLoaded / xdt_api__v1__ 等
  // <script type="application/json"> 块，一次拿到整帖全量媒体
  // ════════════════════════════════════════════════════════════════

  const SCAN_BUDGET = 300000;
  let scanBudget = SCAN_BUDGET;
  function resetScanBudget() { scanBudget = SCAN_BUDGET; }

  // 从 candidates 里挑最大档
  function pickBestCandidate(candidates) {
    if (!Array.isArray(candidates) || !candidates.length) return null;
    let best = null;
    let bestScore = -1;
    for (const c of candidates) {
      if (!c || !c.url) continue;
      const score = (c.width || 0) * (c.height || 0) || (c.width || 0);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best && best.url ? { url: best.url, width: best.width, height: best.height } : null;
  }

  // 从 video_versions 里挑最高清
  function pickBestVideo(versions) {
    if (!Array.isArray(versions) || !versions.length) return null;
    let best = null;
    let bestScore = -1;
    for (const v of versions) {
      if (!v || !v.url) continue;
      const score = (v.width || 0) * (v.height || 0) || (v.width || 0);
      if (score > bestScore) { bestScore = score; best = v; }
    }
    return best && best.url ? { url: best.url, width: best.width, height: best.height } : null;
  }

  // Round 7：2026 Polaris 字段名适配 —— 主图 URL 解析优先 display_url，
  // 其次 display_uri（2026 常用，常替代 display_url），最后 image_versions2.candidates 最高清。
  function pickImageUrl(node) {
    if (!node || typeof node !== 'object') return null;
    if (typeof node.display_url === 'string' && node.display_url) return node.display_url;
    if (typeof node.display_uri === 'string' && node.display_uri) return node.display_uri;
    const c = pickBestCandidate(node.image_versions2 && node.image_versions2.candidates);
    return c ? c.url : null;
  }

  function extractCaption(node) {
    let text = '';
    if (node.edge_media_to_caption && Array.isArray(node.edge_media_to_caption.edges)) {
      for (const e of node.edge_media_to_caption.edges) {
        if (e && e.node && typeof e.node.text === 'string') text += e.node.text;
      }
    }
    if (!text && typeof node.caption === 'string') text = node.caption;
    if (!text && node.caption && typeof node.caption.text === 'string') text = node.caption.text;
    return text;
  }

  function extractHashtags(text) {
    const m = String(text || '').match(/#[\p{L}\p{N}_]+/gu);
    return m ? m : [];
  }

  /**
   * 从帖子 JSON 节点构建 Bundle（纯函数，供测试直接调用）
   * Bundle 结构：{ shortcode, postUrl, media:[{url,type,slideIndex,mediaId}], caption, takenAt, likeCount, commentCount, mediaId }
   */
  function buildBundleFromNode(node) {
    if (!node || typeof node !== 'object') return null;
    // 修复1（Round 3）防御：精选封面节点特征 —— 带 cover_media / crop_thumbnail
    // 且无 taken_at_timestamp 且无 dimensions → 视为精选封面，拒绝成包。
    // （与 scanForMediaJson 的 key 路径黑名单双保险）
    if ((node.cover_media || node.crop_thumbnail) && !node.taken_at_timestamp && !node.dimensions) {
      return null;
    }
    // Round 7：2026 Polaris 字段名适配 —— 短码优先 code（新）再 shortcode（旧）；
    // 相关媒体网格(profile_grid_items[].media)只有 pk、无 code，回退用 pk 当 key。
    const shortcode = typeof node.shortcode === 'string' && node.shortcode ? node.shortcode
      : typeof node.code === 'string' && node.code ? node.code
      : (typeof node.pk === 'string' && node.pk ? node.pk : null);
    if (!shortcode) return null;
    // Round 6：缓存原始节点供诊断导出
    captureDiagNode(shortcode, node);

    const media = [];
    // 1) carousel_media（新版 API）
    if (Array.isArray(node.carousel_media)) {
      if (node.carousel_media.length === 0) {
        // P2-7：空轮播数组 + 带单图/单视频字段 → 按单图/单视频处理，杜绝静默漏采
        const vid = pickBestVideo(node.video_versions) || (node.video_url ? { url: String(node.video_url) } : null);
        if (vid) {
          media.push({ url: vid.url, type: 'video', slideIndex: 0, mediaId: node.id });
        } else {
          const imgUrl = pickImageUrl(node);
          if (imgUrl) media.push({ url: imgUrl, type: 'image', slideIndex: 0, mediaId: node.id });
        }
      } else {
        node.carousel_media.forEach((cm, i) => {
          if (!cm) return;
          // Round 6 修复：优先显式 display_url / video_url（常见轮播 slide 仅暴露这两项，
          // 仅读 image_versions2 会漏采二层图片），再回退 candidates。
          if (cm.video_url) {
            media.push({ url: String(cm.video_url), type: 'video', slideIndex: i, mediaId: cm.id });
          } else if (cm.display_url || cm.display_uri) {
            const u = cm.display_url || cm.display_uri;
            media.push({ url: String(u), type: 'image', slideIndex: i, mediaId: cm.id });
          } else {
            const img = pickBestCandidate(cm.image_versions2 && cm.image_versions2.candidates);
            if (img) media.push({ url: img.url, type: 'image', slideIndex: i, mediaId: cm.id });
            const vid = pickBestVideo(cm.video_versions);
            if (vid) media.push({ url: vid.url, type: 'video', slideIndex: i, mediaId: cm.id });
          }
        });
      }
    } else if (node.edge_sidecar_to_children && Array.isArray(node.edge_sidecar_to_children.edges)) {
      // 2) edge_sidecar_to_children（GraphQL 轮播）
      node.edge_sidecar_to_children.edges.forEach((edge, i) => {
        const c = edge && edge.node ? edge.node : {};
        if (c.video_url) {
          media.push({ url: String(c.video_url), type: 'video', slideIndex: i, mediaId: c.id });
        } else if (c.display_url) {
          media.push({ url: String(c.display_url), type: 'image', slideIndex: i, mediaId: c.id });
        } else {
          const img = pickBestCandidate(c.image_versions2 && c.image_versions2.candidates);
          if (img) media.push({ url: img.url, type: 'image', slideIndex: i, mediaId: c.id });
        }
      });
    } else {
      // 3) 单图 / 单视频 / Reels
      const vid = pickBestVideo(node.video_versions) || (node.video_url ? { url: String(node.video_url) } : null);
      if (vid) {
        media.push({ url: vid.url, type: 'video', slideIndex: 0, mediaId: node.id });
      } else {
        const imgUrl = pickImageUrl(node);
        if (imgUrl) media.push({ url: imgUrl, type: 'image', slideIndex: 0, mediaId: node.id });
      }
    }

    if (!media.length) return null;

    // Round 5：递归深搜嵌套媒体（评论/回复/富文本/@提及），归属本帖，按 URL 去重
    const nested = deepExtractMedia(node, shortcode)
      .filter((m) => m.shortcode === shortcode && m.source !== 'post')
      // v1.1.14：按归一化基址去重（同图不同尺寸档位视为同一媒体，杜绝"拆分成不同 ID 重复保存"）
      .filter((m) => !media.some((p) => getBaseUrl(p.url) === getBaseUrl(m.url)));
    let _nIdx = media.length;
    for (const m of nested) {
      media.push({
        url: m.url, type: m.type, slideIndex: _nIdx, mediaId: m.mediaId,
        source: m.source, key: 'ig:' + shortcode + ':x' + hashUrl(m.url),
      });
      _nIdx++;
    }

    return {
      shortcode,
      postUrl: 'https://www.instagram.com/p/' + shortcode + '/',
      media,
      caption: extractCaption(node),
      takenAt: node.taken_at_timestamp || node.taken_at || null,
      likeCount: (node.edge_media_preview_like && node.edge_media_preview_like.count) || node.like_count || null,
      commentCount: (node.edge_media_to_comment && node.edge_media_to_comment.count) || node.comment_count || null,
      mediaId: node.id || null,
      // v1.1.11：账号名（2026 节点 user.username / 旧版 owner.username），供文件名前缀
      ownerUsername: (node.user && node.user.username) || (node.owner && node.owner.username) || null,
    };
  }

  /**
   * 递归扫描 JSON，找出所有"帖子节点"并构建 Bundle 列表（纯函数）。
   * 帖子节点判定：有 shortcode 且带媒体字段（display_url / video_url /
   * carousel_media / edge_sidecar_to_children / video_versions）。
   */
  // 修复1（Round 3）：JSON 递归下降时的 key 路径黑名单 ——
  // 快拍/精选（edge_highlight_reels / edge_reel_media / reel_media / tray /
  // feed_reels_tray）与相关账号推荐（edge_related_profiles）子树整棵跳过，
  // 其内节点带 shortcode + 封面媒体字段会被误判为帖子。
  const HIGHLIGHT_SUBTREE_KEYS = new Set([
    'edge_highlight_reels', 'edge_reel_media', 'reel_media', 'tray',
    'feed_reels_tray', 'edge_related_profiles',
  ]);

  function scanForMediaJson(obj, bundles, depth) {
    if (!obj || typeof obj !== 'object' || scanBudget-- <= 0 || depth > 40) return bundles;
    if (Array.isArray(obj)) {
      for (const item of obj) scanForMediaJson(item, bundles, depth + 1);
      return bundles;
    }
    const hasMedia = !!(obj.display_url || obj.display_uri || obj.video_url || obj.edge_sidecar_to_children ||
      Array.isArray(obj.carousel_media) || Array.isArray(obj.video_versions) ||
      (obj.image_versions2 && Array.isArray(obj.image_versions2.candidates)));
    // Round 7：2026 Polaris 字段名适配 —— 短码优先 code（新）/ shortcode（旧）；
    // 相关媒体网格(profile_grid_items[].media)只有 pk、无 code，回退用 pk 当 key（需 hasMedia 防误判用户节点）。
    const sc = typeof obj.code === 'string' && obj.code ? obj.code
      : typeof obj.shortcode === 'string' && obj.shortcode ? obj.shortcode
      : (typeof obj.pk === 'string' && obj.pk && hasMedia ? obj.pk : null);
    if (sc && hasMedia) {
      const b = buildBundleFromNode(obj);
      if (b && b.media.length) {
        bundles.push(b);
        return bundles; // 帖子节点内部已全量提取，不再递归避免重复
      }
    }
    for (const key in obj) {
      // 修复1：黑名单 key 子树整体跳过（不进 scanForMediaJson）
      if (HIGHLIGHT_SUBTREE_KEYS.has(key)) continue;
      const v = obj[key];
      if (v && typeof v === 'object') scanForMediaJson(v, bundles, depth + 1);
    }
    return bundles;
  }

  // ════════════════════════════════════════════════════════════════
  // 🕸 Round 5：递归深搜嵌套媒体
  // 逐层遍历帖子（及评论连接）JSON 结构，提取所有层级的图片/视频：
  //   · 帖子主媒体（display_url / video_url / image_versions2 / video_versions）
  //   · 嵌套评论 / threaded 回复（edge_media_to_comment / edge_threaded_comments /
  //     edge_media_preview_comment）
  //   · 富文本区块（caption/comment 的 blocks，含 inline_style_ranges.media_id 引用解析）
  //   · 被 @提及的媒体（edge_mentioned_media）
  // 通过就近继承 shortcode 把深层媒体归属到对应帖子；按 URL 去重；
  // 命中 HIGHLIGHT 黑名单子树整棵跳过；visited 集合防环；深度上限防爆栈。
  // 仅读取已知媒体键（display_url / video_url / image_versions2 / video_versions /
  // thumbnail_src / og_video_url），天然排除头像(profile_pic_url)与迷你缩略图。
  // ════════════════════════════════════════════════════════════════

  function hashUrl(s) {
    s = String(s || '');
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return s.length.toString(36) + '_' + h.toString(36);
  }

  function classifyMediaUrl(url) {
    if (typeof url !== 'string') return null;
    if (/\.(mp4|mov|webm|m4v)(\?|$)/i.test(url)) return 'video';
    if (/\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(url)) return 'image';
    return null;
  }

  // 从已知媒体键收集候选（不含头像/profile_pic_url）
  function mediaCandidatesFromNode(node) {
    const out = [];
    if (!node || typeof node !== 'object') return out;
    const push = (url, type) => {
      if (typeof url !== 'string' || !url) return;
      const t = type || classifyMediaUrl(url);
      if (t) out.push({ url, type: t });
    };
    if (typeof node.display_url === 'string') push(node.display_url, 'image');
    if (typeof node.display_uri === 'string') push(node.display_uri, 'image');
    if (typeof node.video_url === 'string') push(node.video_url, 'video');
    if (typeof node.thumbnail_src === 'string') push(node.thumbnail_src, 'image');
    if (typeof node.og_video_url === 'string') push(node.og_video_url, 'video');
    // v1.1.14：video_versions / image_versions2.candidates 只取最高清一档——
    // 否则同图多个尺寸候选会被 deepExtractMedia 当作"嵌套媒体"逐条提取，
    // 与主媒体（最高清）URL 不同导致"同一张图被拆成不同 ID 重复保存"。
    if (Array.isArray(node.video_versions)) {
      const best = pickBestVideo(node.video_versions);
      if (best) push(best.url, 'video');
    }
    // v1.1.26：覆盖 2026 视频字段变体（video 内嵌对象 / playback_scenario）——
    // 部分轮播视频节点不再直接给 video_versions，直链藏在子对象里，漏掉则动态图存不下来。
    // 仅在尚无视频直链时兜底补充（避免与 video_versions 最高清重复）。
    if (!out.some((m) => m.type === 'video')) {
      if (node.video && typeof node.video === 'object') {
        if (typeof node.video.url === 'string') push(node.video.url, 'video');
        if (Array.isArray(node.video.video_versions)) {
          const best = pickBestVideo(node.video.video_versions);
          if (best) push(best.url, 'video');
        }
      }
      if (!out.some((m) => m.type === 'video') && node.playback_scenario && typeof node.playback_scenario === 'object') {
        const urls = node.playback_scenario.urls || node.playback_scenario.encoded_urls || [];
        if (Array.isArray(urls)) {
          for (const u of urls) {
            if (u && typeof u.url === 'string') push(u.url, 'video');
          }
        }
      }
    }
    if (node.image_versions2 && Array.isArray(node.image_versions2.candidates)) {
      const best = pickBestCandidate(node.image_versions2.candidates);
      if (best) push(best.url, 'image');
    }
    return out;
  }

  function isCommentNode(n) {
    if (!n || typeof n !== 'object') return false;
    if (n.edge_threaded_comments && Array.isArray(n.edge_threaded_comments.edges)) return true;
    if (n.edge_comment_media && typeof n.edge_comment_media === 'object') return true;
    if (typeof n.text === 'string' && (n.created_at || n.comment_type || n.edge_media_to_comment || n.edge_liked_by)) return true;
    return false;
  }

  /**
   * 递归深搜：在任意 JSON 子树内逐层遍历，提取所有层级的图片/视频。
   * 返回 [{url, type, shortcode, source, mediaId}]；source ∈
   * 'post'|'comment'|'richtext'|'mentioned'。按 URL 去重（首次命中优先）。
   * @param {object} root 要遍历的根对象（帖子节点或评论连接载荷）
   * @param {string|null} fallbackShortcode 无就近 shortcode 时的兜底归属
   */
  function deepExtractMedia(root, fallbackShortcode) {
    const out = [];
    const seen = new Set();
    const visited = new Set();
    const mediaMap = new Map(); // media_id -> 带媒体 URL 的节点（富文本 inline media 解析用）
    // 预扫：收集所有富文本 inline_style_ranges 引用的 media_id（与遍历顺序无关）
    const richMediaIds = new Set();
    (function prePass(o, d) {
      if (!o || typeof o !== 'object' || d > 40) return;
      if (Array.isArray(o)) { for (const it of o) prePass(it, d + 1); return; }
      if (Array.isArray(o.blocks)) {
        for (const blk of o.blocks) {
          if (blk && Array.isArray(blk.inline_style_ranges)) {
            for (const r of blk.inline_style_ranges) {
              if (r && typeof r.media_id === 'string') richMediaIds.add(r.media_id);
            }
          }
        }
      }
      for (const k in o) { const v = o[k]; if (v && typeof v === 'object') prePass(v, d + 1); }
    })(root, 0);
    const push = (url, type, shortcode, source, mediaId) => {
      if (!url || seen.has(url)) return;
      const t = type || classifyMediaUrl(url);
      if (!t) return;
      seen.add(url);
      out.push({ url, type: t, shortcode: shortcode || fallbackShortcode || null, source, mediaId: mediaId || null });
    };
    function walk(obj, depth, ctx) {
      if (!obj || typeof obj !== 'object' || depth > 60) return;
      if (visited.has(obj)) return;
      visited.add(obj);
      if (Array.isArray(obj)) { for (const it of obj) walk(it, depth, ctx); return; }
      // 就近继承 shortcode（帖子自身 / 父级 media.shortcode）
      let nctx = ctx;
      const sc = (typeof obj.shortcode === 'string' && obj.shortcode) ? obj.shortcode
        : (obj.media && typeof obj.media.shortcode === 'string') ? obj.media.shortcode
        : ctx.shortcode;
      if (sc !== ctx.shortcode) nctx = Object.assign({}, ctx, { shortcode: sc });
      // 收集 media_id -> 媒体节点（供富文本 inline media 解析）
      if (typeof obj.id === 'string' && (obj.display_url || obj.video_url || (obj.image_versions2 && obj.image_versions2.candidates))) {
        mediaMap.set(obj.id, obj);
      }
      // 本节点媒体（仅已知媒体键，排除头像）
      let source = nctx.source;
      if (richMediaIds.has(obj.id)) source = 'richtext';
      else if (isCommentNode(obj)) source = 'comment'; // 评论判定优先于继承的 'post'
      const cands = mediaCandidatesFromNode(obj);
      for (const c of cands) push(c.url, c.type, nctx.shortcode, source, obj.id || null);
      // 富文本区块
      if (Array.isArray(obj.blocks)) {
        for (const blk of obj.blocks) {
          if (!blk || typeof blk !== 'object') continue;
          const bc = mediaCandidatesFromNode(blk);
          for (const c of bc) push(c.url, c.type, nctx.shortcode, 'richtext', blk.media_id || null);
          if (blk.media && typeof blk.media === 'object') {
            const bm = mediaCandidatesFromNode(blk.media);
            for (const c of bm) push(c.url, c.type, nctx.shortcode, 'richtext', blk.media_id || null);
          }
          if (Array.isArray(blk.inline_style_ranges)) {
            for (const r of blk.inline_style_ranges) {
              if (r && typeof r.media_id === 'string') {
                const mnode = mediaMap.get(r.media_id);
                if (mnode) {
                  const mc = mediaCandidatesFromNode(mnode);
                  for (const c of mc) push(c.url, c.type, nctx.shortcode, 'richtext', r.media_id);
                }
              }
            }
          }
        }
      }
      // 被 @提及的媒体
      if (obj.edge_mentioned_media && Array.isArray(obj.edge_mentioned_media.edges)) {
        for (const e of obj.edge_mentioned_media.edges) {
          const mn = e && e.node ? e.node : null;
          if (!mn) continue;
          const mc = mediaCandidatesFromNode(mn);
          for (const c of mc) push(c.url, c.type, nctx.shortcode, 'mentioned', mn.id || null);
        }
      }
      // 递归子节点（HIGHLIGHT 黑名单子树整棵跳过）
      for (const k in obj) {
        if (HIGHLIGHT_SUBTREE_KEYS.has(k)) continue;
        const v = obj[k];
        if (v && typeof v === 'object') walk(v, depth + 1, nctx);
      }
    }
    walk(root, 0, { shortcode: fallbackShortcode || null, source: 'post' });
    return out;
  }

  /** 评论分页载荷（顶层无帖子 shortcode，但含 media.shortcode）：提取嵌套评论/富文本媒体，归属到对应帖子 */
  function scanCommentConnections(root) {
    const items = deepExtractMedia(root, null);
    const bySc = new Map();
    for (const m of items) {
      if (!m.shortcode || m.source === 'post') continue; // 仅嵌套媒体，避免与主扫描重复
      if (!bySc.has(m.shortcode)) bySc.set(m.shortcode, []);
      bySc.get(m.shortcode).push(m);
    }
    const bundles = [];
    for (const [sc, ms] of bySc) {
      const media = ms.map((m) => ({
        url: m.url, type: m.type, slideIndex: 0, mediaId: m.mediaId, source: m.source,
        key: 'ig:' + sc + ':x' + hashUrl(m.url),
      }));
      if (!media.length) continue;
      bundles.push({
        shortcode: sc, postUrl: 'https://www.instagram.com/p/' + sc + '/',
        media, caption: '', takenAt: null, likeCount: null, commentCount: null, mediaId: null,
      });
    }
    return bundles;
  }

  /** 从 JSON 中提取分页游标（next_max_id / pagination_info.end_cursor） */
  function captureCursor(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 30) return null;
    if (typeof obj.next_max_id === 'string') return obj.next_max_id;
    if (obj.pagination_info && typeof obj.pagination_info.end_cursor === 'string') return obj.pagination_info.end_cursor;
    if (Array.isArray(obj)) {
      for (const x of obj) {
        const c = captureCursor(x, depth + 1);
        if (c) return c;
      }
      return null;
    }
    for (const k in obj) {
      const v = obj[k];
      if (v && typeof v === 'object') {
        const c = captureCursor(v, depth + 1);
        if (c) return c;
      }
    }
    return null;
  }

  /** 处理任意 JSON 对象：扫描 bundle + 更新游标 */
  function processJsonObject(obj) {
    try {
      const bundles = scanForMediaJson(obj, []);
      for (const b of bundles) ingestBundle(b);
      // Round 5：评论分页载荷中的嵌套媒体（独立 shortcode 上下文，避免与主扫描碰撞）
      const commentBundles = scanCommentConnections(obj);
      for (const b of commentBundles) {
        const items = b.media.map((m) => ({
          key: m.key, url: m.url, type: m.type, slideIndex: m.slideIndex,
          mediaId: m.mediaId, shortcode: b.shortcode, postUrl: b.postUrl, source: m.source,
        }));
        ingestItems(b.shortcode, items, null);
      }
      // Round 6（增强）：scanForMediaJson 未认出任何帖子、但对象本身含帖子标记时，
      // 仍把原始载荷存进诊断——用于精修识别器（真实 IG 结构变更时不会静默漏抓）
      if (bundles.length === 0 && commentBundles.length === 0) {
        try {
          const s = JSON.stringify(obj);
          if (s.length >= 200 && (s.includes('shortcode') || s.includes('display_url') ||
              s.includes('edge_media_to_caption') || s.includes('xdt_api') || s.includes('edge_sidecar'))) {
            captureDiagRaw(obj, 'processJsonObject-no-match');
          }
        } catch (e) {}
      }
      const cursor = captureCursor(obj, 0);
      if (cursor && cursor !== resumeState.cursor) {
        resumeState.cursor = cursor;
        state.cursor = cursor;
        saveResumeState();
      }
    } catch (e) {
      log('JSON 扫描异常:', e);
    }
  }

  // 高频 hook（JSON.parse / Response）处理队列：每个载荷依次处理（间隔 400ms），不丢数据。
  // v1.1.16：原"同 400ms 窗口只处理第一个"会漏掉详情页并发到达的 web_info（含原图/视频），
  // 导致部分帖子只采到 DOM 640 缩略图、视频帖完全漏采——改为队列化，全部载荷最终都会处理。
  let pendingJsonQueue = [];
  let lastHookProcessAt = 0;
  let hookTimer = null;

  /** v1.1.22：浅探测载荷是否含详情页帖子数据（xdt_api__v1__media__shortcode__web_info）——原图/视频全量依赖它 */
  function hasWebInfoKey(obj, depth) {
    try {
      if (!obj || typeof obj !== 'object' || depth > 6) return false;
      if (Array.isArray(obj)) {
        for (const x of obj) if (hasWebInfoKey(x, depth + 1)) return true;
        return false;
      }
      for (const k in obj) {
        if (k === 'xdt_api__v1__media__shortcode__web_info') return true;
        if (hasWebInfoKey(obj[k], depth + 1)) return true;
      }
    } catch (e) {}
    return false;
  }

  function throttledProcess(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (pendingJsonQueue.length >= 60) pendingJsonQueue.shift(); // 防爆（只丢最旧的）
    // v1.1.22：详情页帖子数据（web_info）插队到队首优先处理——图帖原图依赖它，
    // 避免被并发到达的 comments/相关网格等载荷挤压导致 JSON 处理过晚/被挤掉。
    if (hasWebInfoKey(obj, 0)) pendingJsonQueue.unshift(obj);
    else pendingJsonQueue.push(obj);
    scheduleHookProcess();
  }
  function scheduleHookProcess() {
    if (hookTimer) return;
    const wait = Math.max(0, 400 - (Date.now() - lastHookProcessAt));
    hookTimer = setTimeout(() => {
      hookTimer = null;
      const obj = pendingJsonQueue.shift();
      if (obj) {
        lastHookProcessAt = Date.now();
        resetScanBudget();
        try { processJsonObject(obj); } catch (e) { log('JSON 处理异常:', e); }
      }
      if (pendingJsonQueue.length) scheduleHookProcess();
    }, wait);
  }

  /** 扫描页面内嵌 <script type="application/json"> 块（防抖调用） */
  function scanEmbeddedScriptBlocks() {
    try {
      const blocks = document.querySelectorAll('script[type="application/json"]');
      for (const b of blocks) {
        if (b.__igScanned) continue;
        b.__igScanned = true;
        const text = b.textContent || '';
        if (!text || text.length < 8) continue;
        // Round 6：缓存内嵌 JSON 文本样本供诊断导出（最多 12 段，控内存）
        if (state.diagEmbedded.length < 12) state.diagEmbedded.push(text);
        const obj = parseJsonRobust(text);
        if (obj) processJsonObject(obj);
      }
    } catch (e) {}
  }

  // ════════════════════════════════════════════════════════════════
  // 🎥 视频/媒体直链捕获 — hook 页面 JSON 通道（_sharedData / Response / fetch / XHR）
  // ════════════════════════════════════════════════════════════════

  // 兜底视频直链缓存（DOM video 元素 src 是 blob: 时从 hook 拿真实 URL）
  const pendingVideoUrls = new Set();
  const PENDING_MAX = 2000;

  function addPendingVideoUrl(url) {
    if (!url) return;
    if (pendingVideoUrls.size >= PENDING_MAX) {
      pendingVideoUrls.delete(pendingVideoUrls.values().next().value);
    }
    pendingVideoUrls.add(url);
  }

  function installHooks() {
    if (state.hookInstalled) return;
    state.hookInstalled = true;

    const w = getPageWindow();
    const rawParse = (w.JSON && w.JSON.parse) || JSON.parse;

    // 1) JSON.parse hook：捕获 _sharedData / 内嵌对象（JSON.parse 路径）
    try {
      if (w.JSON && !w.JSON.__igMediaHooked) {
        const orig = w.JSON.parse;
        w.JSON.__igMediaHooked = true;
        w.JSON.parse = function (text, reviver) {
          const obj = orig.call(this, text, reviver);
          try {
            if (typeof text === 'string' && (text.includes('cdninstagram.com') || text.includes('shortcode'))) {
              captureDiagRaw(obj, 'JSON.parse');
              throttledProcess(obj);
            }
          } catch (e) {}
          return obj;
        };
        log('已安装 JSON.parse hook');
      }
    } catch (e) {}

    // 2) Response.prototype.json / .text hook：捕获 await response.json() 路径
    try {
      const RP = w.Response && w.Response.prototype;
      if (RP) {
        for (const method of ['json', 'text']) {
          if (typeof RP[method] !== 'function' || RP[method].__igMediaHooked) continue;
          const orig = RP[method];
          const hooked = (method === 'text')
            ? function () {
                return orig.apply(this, arguments).then((text) => {
                  try {
                    if (typeof text === 'string' && (text.includes('cdninstagram.com') || text.includes('shortcode'))) {
                      const o = rawParse(text);
                      captureDiagRaw(o, 'Response.text');
                      throttledProcess(o);
                    }
                  } catch (e) {}
                  return text;
                });
              }
            : function () {
                return orig.apply(this, arguments).then((obj) => {
                  try { captureDiagRaw(obj, 'Response.json'); throttledProcess(obj); } catch (e) {}
                  return obj;
                });
              };
          hooked.__igMediaHooked = true;
          RP[method] = hooked;
        }
        log('已安装 Response.prototype json/text hook');
      }
    } catch (e) {}

    // 3) XHR hook：捕获视频 mp4 直链 + 响应文本（v1.1.24：详情页帖子数据若走 XHR 路径，
    // 此前是盲区——诊断 JSON 证实 web_info 从未被 JSON.parse/Response hook 捕获，导致该帖只有 DOM 兜底图）
    try {
      const XHRProto = (w.XMLHttpRequest && w.XMLHttpRequest.prototype) || XMLHttpRequest.prototype;
      if (XHRProto && !XHRProto.open.__igMediaHooked) {
        const origOpen = XHRProto.open;
        XHRProto.open = function (method, url, ...rest) {
          try {
            const s = String(url || '');
            if (s.includes('.mp4') && s.includes('cdninstagram.com')) addPendingVideoUrl(s);
            // v1.1.24：XHR 响应文本探针（addEventListener 不覆盖页面自身 handler）
            const self = this;
            if (self && typeof self.addEventListener === 'function' && typeof rawParse === 'function') {
              self.addEventListener('readystatechange', function xhrIgProbe() {
                try {
                  if (self.readyState === 4 && self.status === 200) {
                    self.removeEventListener('readystatechange', xhrIgProbe);
                    // v1.1.26：responseText 必须独立 try——responseType='json' 时访问它抛 DOMException，
                    // 原实现抛错会跳出 try 导致 json 分支也失效（XHR 探针整体失灵的可能原因之一）。
                    let text = '';
                    try { text = (typeof self.responseText === 'string') ? self.responseText : ''; } catch (e) {}
                    if (text && (text.includes('cdninstagram.com') || text.includes('shortcode') || text.includes('xdt_api'))) {
                      const o = rawParse(text);
                      if (o) { captureDiagRaw(o, 'XHR'); throttledProcess(o); }
                    } else if (self.response && typeof self.response === 'object') {
                      // responseType='json'：responseText 为空，直接处理 response 对象
                      captureDiagRaw(self.response, 'XHR-json');
                      throttledProcess(self.response);
                    }
                  }
                } catch (e) {}
              });
            }
          } catch (e) {}
          return origOpen.call(this, method, url, ...rest);
        };
        XHRProto.open.__igMediaHooked = true;
      }
    } catch (e) {}

    // 4) fetch hook：兜底捕获视频 mp4 直链
    try {
      if (typeof w.fetch === 'function' && !w.fetch.__igMediaHooked) {
        const origFetch = w.fetch;
        w.fetch = function (input, init) {
          try {
            const url = String((typeof input === 'string') ? input : (input && input.url) || '');
            if (url.includes('.mp4') && url.includes('cdninstagram.com')) addPendingVideoUrl(url);
          } catch (e) {}
          return origFetch.call(this, input, init);
        };
        w.fetch.__igMediaHooked = true;
      }
    } catch (e) {}

    // 5) window._sharedData setter hook（document-start 时先于页面脚本定义）
    try {
      if (w && !Object.getOwnPropertyDescriptor(w, '_sharedData')) {
        let captured = null;
        Object.defineProperty(w, '_sharedData', {
          configurable: true,
          get() { return captured; },
          set(v) {
            captured = v;
            try { resetScanBudget(); processJsonObject(v); } catch (e) {}
          },
        });
      }
    } catch (e) {}

    // 6) __additionalDataLoaded hook（单帖页增量数据）
    // 用 setter 陷阱而非直接赋值：页面脚本随后会执行
    // `window.__additionalDataLoaded = function(...)`，直接赋值会被覆盖。
    try {
      if (w && !Object.getOwnPropertyDescriptor(w, '__additionalDataLoaded')) {
        let orig = null;
        const hooked = function (...args) {
          try {
            if (args && args[1]) { captureDiagRaw(args[1], '__additionalDataLoaded'); resetScanBudget(); processJsonObject(args[1]); }
          } catch (e) {}
          if (typeof orig === 'function') return orig.apply(this, args);
        };
        Object.defineProperty(w, '__additionalDataLoaded', {
          configurable: true,
          get() { return hooked; },
          set(fn) { orig = (typeof fn === 'function') ? fn : null; },
        });
      }
    } catch (e) {}

    log('已安装 JSON 捕获 hook（_sharedData / __additionalDataLoaded / Response）');
  }

  // ════════════════════════════════════════════════════════════════
  // 🏷 帖标记（网格瓦片角标）
  // ════════════════════════════════════════════════════════════════

  function markTile(link, text, bg) {
    if (!link || !link.querySelector) return;
    let badge = link.querySelector('.' + MARK_CLASS);
    if (!badge) {
      badge = document.createElement('div');
      badge.className = MARK_CLASS;
      badge.style.cssText = 'position:absolute;top:4px;right:4px;background:' + bg +
        ';color:#fff;font-size:11px;font-weight:600;border-radius:10px;padding:1px 6px;' +
        'z-index:9999;pointer-events:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
        'box-shadow:0 1px 3px rgba(0,0,0,0.3);white-space:nowrap';
      link.appendChild(badge);
    }
    badge.textContent = text;
    badge.style.background = bg;
  }

  function clearAllMarks() {
    document.querySelectorAll('.' + MARK_CLASS).forEach((el) => el.remove());
  }

  /** Round 6：该帖是否已被 JSON 通道捕获多张（轮播）媒体（slideIndex>=1 存在） */
  function jsonHasMultiSlides(shortcode) {
    return state.media.has('ig:' + shortcode + ':1') || savedMediaKeys.has('ig:' + shortcode + ':1');
  }

  // Round 6：诊断捕获（仅缓存原始节点/文本，不影响主流程；用于导出真实页面结构精修抓取逻辑）
  function captureDiagNode(shortcode, node) {
    try {
      if (!shortcode || state.diagNodes.has(shortcode)) return;
      if (state.diagNodes.size >= 8) return; // 仅保留前若干帖，控内存
      state.diagNodes.set(shortcode, node);
    } catch (e) {}
  }

  // Round 6（增强）：捕获原始 GraphQL/SSR 载荷文本——绕过 scanForMediaJson 识别，
  // 直接存"含帖子媒体标记"的 JSON 原文片段，确保诊断导出能拿到真实结构用于精修。
  // 触发标记：shortcode / display_url / edge_media_to_caption / xdt_api / edge_sidecar
  function captureDiagRaw(obj, label) {
    try {
      if (!obj || typeof obj !== 'object') return;
      const s = JSON.stringify(obj);
      if (s.length < 200) return;
      const hit = s.includes('shortcode') || s.includes('display_url') ||
        s.includes('edge_media_to_caption') || s.includes('xdt_api') || s.includes('edge_sidecar');
      if (!hit) return;
      // v1.1.30：详情页帖子数据（web_info）永久保留进诊断——即使捕获段数达上限也允许入列，
      // 否则并发载荷（相关网格/feed 等）会把 web_info 挤掉，导致诊断里看不到当前帖（此前无法定位动态视频根因）。
      const isWebInfo = s.includes('xdt_api__v1__media__shortcode__web_info');
      if (state.diagRaw.length >= 12 && !isWebInfo) return; // 控内存（最多 12 段；web_info 豁免）
      state.diagRaw.push({
        label,
        capturedAt: new Date().toISOString(),
        size: s.length,
        snippet: s.length > 80000 ? s.slice(0, 80000) : s,
      });
    } catch (e) {}
  }

  function isAvatar(img) {
    if (!img) return true;
    const src = (img.src || img.getAttribute('src') || '');
    // 头像 CDN 路径特征：t51.2885-19 / s150x150 等小图段
    if (src.includes('t51.2885-19') || /\/s\d{1,4}x\d{1,4}\//.test(src)) return true;
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w > 0 && h > 0 && w <= 60 && h <= 60) return true;
    return false;
  }

  function getVideoSrc(v) {
    if (!v) return null;
    let src = v.currentSrc || v.src || v.getAttribute('src') || '';
    if (!src || src.startsWith('blob:')) {
      const s = v.querySelector && v.querySelector('source[src]');
      if (s) src = s.getAttribute('src') || s.src || '';
    }
    if (!src || src.startsWith('blob:')) return null;
    if (src.includes('cdninstagram.com') || src.includes('fbcdn.net')) return src;
    return null;
  }

  // ════════════════════════════════════════════════════════════════
  // 🖼 媒体记录（DOM 通道）
  // ════════════════════════════════════════════════════════════════

  /** 记录任意 MediaItem[]（DOM 通道；不标记帖级 processed） */
  function ingestItems(shortcode, items, meta) {
    // v1.1.27：一律只在当前详情页入库——
    // ① 网格页守卫（URL 无短码直接挡）防止首页/网格页面媒体入库；
    // ② 短码严格匹配当前页：DOM 兜底采到的图片必须归属当前帖子（防止跨帖混入）；
    //   （用户反馈"关闭自动巡览、手动点进帖子会采到无关内容"——非巡览详情页下，
    //   其他帖/相关网格的 DOM 也可能被收集进来，这里按 currentPostShortcode 统一过滤）
    const curSc = currentPostShortcode();
    if (!curSc || shortcode !== curSc) return 0;
    // v1.1.10 巡览门控：自动巡览未进入帖子前（网格页）不采集任何媒体。
    if (state.tour.active && state.tour.gate) return 0;
    if (!shortcode || !items || !items.length) return 0;
    let recorded = 0;
    for (const item of items) {
      if (state.media.size >= mediaHardLimit()) break;
      const key = item.key || getMediaKey(item);
      item.key = key;
      // v1.1.14/v1.1.17：按归一化基址去重——同一图片/视频无论以何种 key 出现只保存一次；
      // 若先采到的是缩略图（DOM 兜底 640）、后到的是原图（JSON 2048），用高清替换低清。
      const base = getBaseUrl(item.url);
      const existingKey = state.mediaBaseKey.get(base);
      if (existingKey) {
        const existing = state.media.get(existingKey);
        if (existing && isHigherResUrl(item.url, existing.url)) {
          state.media.delete(existingKey);
          state.media.set(key, item);
          if (existingKey !== key) state.mediaBaseKey.set(base, key);
          recorded++;
          log(`发现媒体(高清替换) #${state.media.size}: ${item.type} ${shortUrl(item.url)}`);
        }
        continue;
      }
      if (state.media.has(key)) continue;
      if (savedMediaKeys.has(key)) continue;
      state.media.set(key, item);
      state.mediaBaseKey.set(base, key);
      recorded++;
      log(`发现媒体 #${state.media.size}: ${item.type} ${item.url}`);
      // v1.1.21：取消"边采集边下载"——视频与图片统一在打包时并入 ZIP，浏览过程不下任何文件
    }
    if (!state.postMeta.has(shortcode)) {
      const metaObj = meta || buildDomMeta(shortcode, items);
      state.postMeta.set(shortcode, metaObj);
      trimPostMeta();
    }
    updateButton();
    checkAutoSave();
    return recorded;
  }

  function buildDomMeta(shortcode, items) {
    return {
      shortcode,
      media_id: null,
      post_url: 'https://www.instagram.com/p/' + shortcode + '/',
      taken_at: null,
      like_count: null,
      comment_count: null,
      caption: null,
      hashtags: [],
      media: items.map((m) => ({ type: m.type, index: m.slideIndex, url: m.url })),
    };
  }

  function buildMeta(bundle) {
    return {
      shortcode: bundle.shortcode,
      media_id: bundle.mediaId || null,
      post_url: bundle.postUrl,
      taken_at: bundle.takenAt ? new Date(bundle.takenAt * 1000).toISOString() : null,
      like_count: bundle.likeCount,
      comment_count: bundle.commentCount,
      caption: bundle.caption,
      hashtags: extractHashtags(bundle.caption),
      media: bundle.media.map((m) => ({ type: m.type, index: m.slideIndex, url: m.url })),
    };
  }

  function trimPostMeta() {
    if (state.postMeta.size > 3000) {
      const first = state.postMeta.keys().next().value;
      if (first) state.postMeta.delete(first);
    }
  }

  /**
   * 记录 JSON Bundle（JSON 通道）：整帖全量媒体 + 帖级去重标记。
   * Bundle 来自内嵌 JSON / API 响应，意味着该帖全部 slide 已拿到 → 标记 processed。
   * 返回本次实际新记录的数量。
   */
  function ingestBundle(bundle) {
    if (!bundle || !bundle.shortcode) return 0;
    // v1.1.27：一律只在当前详情页入库——
    // ① 网格页守卫（URL 无短码直接挡）防止 feed JSON 批量入库；
    // ② 短码严格匹配当前页：防止主页/相关网格/旁支 JSON 被错误归到当前帖
    //   （用户反馈"关闭自动巡览、手动点进帖子会采到无关内容"——非巡览详情页下，
    //   feed/相关网格 bundle 的 shortcode ≠ currentPostShortcode 仍被入库）。
    const curSc = currentPostShortcode();
    if (!curSc || bundle.shortcode !== curSc) return 0;
    if (processedShortcodes.has(bundle.shortcode)) return 0;
    // v1.1.11：记录账号名（文件名前缀优先来源）
    if (bundle.ownerUsername) state.ownerUsername = bundle.ownerUsername;
    const items = bundle.media.map((m) => ({
      key: 'ig:' + bundle.shortcode + ':' + m.slideIndex,
      url: m.url,
      type: m.type,
      postUrl: bundle.postUrl,
      slideIndex: m.slideIndex,
      mediaId: m.mediaId || null,
      shortcode: bundle.shortcode,
      takenAt: bundle.takenAt || null,
    }));
    const recorded = ingestItems(bundle.shortcode, items, buildMeta(bundle));
    processedShortcodes.add(bundle.shortcode);
    trimProcessed();
    saveResumeState();
    return recorded;
  }

  // v1.1.31：详情页 JSON 缺失时主动请求帖子数据（网页端 __a=1 接口）。
  // 根因：用户从主页 feed 点开帖子（SPA）时 IG 复用 feed 缓存、不再请求详情页 web_info，
  // 导致动态视频/原图失去 JSON 来源（诊断证实：详情页无任何 web_info 载荷，仅主页 feed 含该帖节点）。
  const fetchedPostJson = new Set();
  async function fetchPostJson(sc) {
    try {
      if (!sc || fetchedPostJson.has(sc)) return;
      fetchedPostJson.add(sc);
      if (downloadBlocked()) return;
      if (!state.isRecording) return; // 未在采集时不主动请求
      countRequest(1);
      const res = await fetch(location.origin + '/p/' + sc + '/?__a=1&__d=dis', {
        headers: { 'x-ig-app-id': '936619743392459' },
      });
      if (!res || !res.ok) return;
      const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
      if (ct.includes('json')) {
        const obj = await res.json();
        processJsonObject(obj);
      } else {
        const text = await res.text();
        const o = parseJsonRobust(text);
        if (o) processJsonObject(o);
      }
    } catch (e) {}
  }

  /** 从容器收集 DOM 媒体项（单帖页用） */
  function collectDomItems(shortcode, container) {
    const items = [];
    const seenBase = new Set();
    let idx = 0;
    const imgs = container.querySelectorAll ? container.querySelectorAll('img[srcset*="cdninstagram.com"], img[src*="cdninstagram.com"]') : [];
    for (const img of imgs) {
      if (isAvatar(img)) continue;
      // 修复1（Round 3）：快拍/精选封面图（外层 <a href*="/stories/">）直接跳过
      if (typeof img.closest === 'function') {
        const storyLink = img.closest('a[href*="/stories/"]');
        if (storyLink) continue;
      }
      const src = pickSrcsetMax(img);
      if (!src || !src.includes('cdninstagram.com')) continue;
      // v1.1.15：头像小图 URL 特征过滤（评论/相关用户头像 s150x150 / profile_pic / avatar）——
      // 详情页 article 内评论区头像会命中 CDN 图片选择器，不过滤会把"非当前帖媒体"采进来。
      if (/s150x150|profile_pic|avatar/i.test(src)) continue;
      const url = toHighResUrl(src);
      const base = getBaseUrl(url);
      if (seenBase.has(base)) continue;
      seenBase.add(base);
      items.push({ key: 'ig:' + shortcode + ':' + idx, url, type: 'image', slideIndex: idx, shortcode, postUrl: 'https://www.instagram.com/p/' + shortcode + '/' });
      idx++;
    }
    const vids = container.querySelectorAll ? container.querySelectorAll('video') : [];
    for (const v of vids) {
      let src = getVideoSrc(v);
      if (!src) {
        // 兜底：从 pendingVideoUrls 里找（无法精确关联，取最近的）。
        // v1.1.14：巡览模式禁用此兜底——快速切帖时 pendingVideoUrls 可能残留上一帖的视频，
        // 会把"不属于当前帖的视频"错配进来（宁缺勿错，JSON 通道保证完整视频）。
        if (!state.tour.active) src = pendingVideoUrls.values().next().value || null;
      }
      if (src) {
        items.push({ key: 'ig:' + shortcode + ':' + idx, url: src, type: 'video', slideIndex: idx, shortcode, postUrl: 'https://www.instagram.com/p/' + shortcode + '/' });
        idx++;
      }
    }
    return items;
  }

  // ════════════════════════════════════════════════════════════════
  // 🎠 轮播点击兜底（JSON 缺失时）：串行、限次、随机间隔
  // ════════════════════════════════════════════════════════════════
  const clickedShortcodes = new Set();

  function currentMainBases() {
    const out = new Set();
    const imgs = document.querySelectorAll(SELECTORS.mainImg);
    for (const img of imgs) {
      if (isAvatar(img)) continue;
      const src = pickSrcsetMax(img);
      if (src) out.add(getBaseUrl(toHighResUrl(src)));
    }
    return out;
  }

  async function expandCarouselViaClicks(shortcode) {
    if (state.clicking || clickedShortcodes.has(shortcode)) return;
    state.clicking = true;
    clickedShortcodes.add(shortcode);
    try {
      let clicked = 0;
      let noGrowth = 0;
      let lastBaseSet = new Set(currentMainBases());
      while (clicked < CONFIG.MAX_CAROUSEL_CLICKS) {
        const nextBtn = document.querySelector(SELECTORS.carouselNext);
        if (!nextBtn) break;
        const delay = CONFIG.CLICK_MIN_DELAY_MS + Math.floor(Math.random() * (CONFIG.CLICK_MAX_DELAY_MS - CONFIG.CLICK_MIN_DELAY_MS));
        await sleep(delay);
        try { nextBtn.click(); } catch (e) { break; }
        countRequest(1);
        clicked++;
        await sleep(800 + Math.floor(Math.random() * 700));
        // 统计本次点击新增的 slide 基址；连续 2 次无新增才结束（兼容 DOM 累积/替换两种渲染模型）
        const newBaseSet = new Set(currentMainBases());
        let added = 0;
        for (const b of newBaseSet) if (!lastBaseSet.has(b)) added++;
        lastBaseSet = newBaseSet;
        noGrowth = added === 0 ? noGrowth + 1 : 0;
        if (noGrowth >= 2) break;
        try { discoverMedia(); } catch (e) {}
      }
      log(`轮播点击展开结束：${shortcode} 共点击 ${clicked} 次`);
    } finally {
      state.clicking = false;
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 🔍 媒体发现（discoverMedia）
  // 通道优先级：JSON hook（已由 processJsonObject 处理）→ DOM → 点击兜底
  // ════════════════════════════════════════════════════════════════

  function discoverMedia() {
    if (!state.isRecording) return;
    try { checkLoginWallDom(); } catch (e) {}
    try { scanEmbeddedScriptBlocks(); } catch (e) {}

    const single = extractShortcode(location.pathname);
    if (single) {
      // 单帖页 /p/ /reel/ /tv/
      if (processedShortcodes.has(single)) return;
      // v1.1.31：JSON 通道缺失时主动请求帖子数据——用户从主页 feed 点开帖子时，
      // IG 复用 feed 缓存、不请求详情页 web_info（诊断证实），动态视频/原图失去 JSON 来源。
      fetchPostJson(single);
      // v1.1.11/v1.1.14/v1.1.28：容器一律只认当前帖主媒体区（<main> 内的 <article>）——
      // 详情页 main 里还含"相关帖子"网格，手动模式（非巡览）此前用 main/body 兜底
      // 会把推荐图采进来（用户反馈"手动点进帖子依然会保存不相关内容"的根因）。
      // 现在两种模式统一：无 article 时回退 main；main 也没有则不做 DOM 兜底（JSON 通道仍可全量）。
      let container = document.querySelector(SELECTORS.postArticle) || document.querySelector(SELECTORS.mainContainer);
      if (!container) { try { scanEmbeddedScriptBlocks(); } catch (e) {} return; }
      const items = collectDomItems(single, container);
      ingestItems(single, items, null);
      // 轮播兜底：JSON 没给全量且页面有"下一张"
      if (!processedShortcodes.has(single) && document.querySelector(SELECTORS.carouselNext)) {
        expandCarouselViaClicks(single);
      }
      return;
    }

    // 网格 / feed 页
    const seen = new Set();
    const links = document.querySelectorAll(SELECTORS.postLink);
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      // 修复1（Round 3）：快拍/精选链接显式跳过（postLink 选择器理论上已排除，
      // 加显式守卫防选择器改版回归）
      if (href.includes('/stories/')) continue;
      const sc = extractShortcode(href);
      if (!sc || seen.has(sc)) continue;
      seen.add(sc);
      const key0 = 'ig:' + sc + ':0';
      // Round 6：JSON 通道已捕获该帖多张（轮播）→ 直接标记完成，避免 DOM 单图重复/覆盖
      if (jsonHasMultiSlides(sc)) {
        if (!processedShortcodes.has(sc)) markTile(link, '✅', 'rgba(22, 163, 74, 0.9)');
        continue;
      }
      if (processedShortcodes.has(sc) || savedMediaKeys.has(key0)) {
        markTile(link, '✅', 'rgba(22, 163, 74, 0.9)');
        continue;
      }
      // Round 6：瓦片内可能堆叠多张图（轮播预览），全部抓取而非仅第一张
      const imgEls = link.querySelectorAll('img[srcset*="cdninstagram.com"], img[src*="cdninstagram.com"]');
      const items = [];
      let idx = 0;
      for (const img of imgEls) {
        if (isAvatar(img)) continue;
        const src = pickSrcsetMax(img) || img.getAttribute('src');
        if (!src || !src.includes('cdninstagram.com')) continue;
        items.push({
          key: 'ig:' + sc + ':' + idx,
          url: toHighResUrl(src),
          type: 'image',
          slideIndex: idx,
          shortcode: sc,
          postUrl: 'https://www.instagram.com/p/' + sc + '/',
        });
        idx++;
      }
      if (!items.length) continue;
      const n = ingestItems(sc, items, null);
      if (n > 0) markTile(link, '📷', 'rgba(225, 48, 108, 0.9)');
    }

    updateButton();
  }

  // ════════════════════════════════════════════════════════════════
  // 🚗 自动巡览帖子（Round 9 / v1.1.8）
  // 流程：网格页自动点开首帖 → 详情页等渲染 → 采集（含多图检测）→ 自动切下一帖 → 末页停止保存。
  // 全程 SPA 导航（点链接 / 点"下一帖"按钮 / history.back），不整页刷新 → state.media 内存不丢。
  // 等待渲染采用轮询（借鉴 ig-helper）；去重：visited + processedShortcodes + savedMediaKeys。
  // ════════════════════════════════════════════════════════════════

  function currentPostShortcode() {
    return extractShortcode(location.pathname) || null;
  }

  function baseGridUrl() {
    const seg = location.pathname.split('/').filter(Boolean);
    if (!seg.length) return location.origin + '/';
    seg.pop(); // 短码段
    // 去掉末尾类型段（p/reel/tv）
    while (seg.length && (seg[seg.length - 1] === 'p' || seg[seg.length - 1] === 'reel' || seg[seg.length - 1] === 'tv')) seg.pop();
    if (!seg.length) return location.origin + '/'; // /p/sc/ /reel/sc/ → 首页
    return location.origin + '/' + seg[0] + '/';   // /username/p/sc/ → /username/
  }

  /** 网格页收集待巡览 shortcode 队列（过滤已处理/已保存/本次已访问/快拍精选） */
  function collectTourQueue() {
    const out = [];
    const seen = new Set();
    const links = document.querySelectorAll(SELECTORS.postLink);
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      if (href.includes('/stories/')) continue;
      const sc = extractShortcode(href);
      if (!sc || seen.has(sc)) continue;
      seen.add(sc);
      if (state.tour.visited.has(sc)) continue;
      if (processedShortcodes.has(sc)) continue;
      if (savedMediaKeys.has('ig:' + sc + ':0')) continue;
      out.push(sc);
    }
    return out;
  }

  function findPostLink(sc) {
    const links = document.querySelectorAll(SELECTORS.postLink);
    for (const l of links) {
      const href = l.getAttribute('href') || '';
      if (href.includes('/stories/')) continue;
      if (extractShortcode(href) === sc) return l;
    }
    return null;
  }

  function tourShouldStop() {
    if (!state.isRecording || state.fuse) return true;
    if (state.saving || state.autoSaving) return true;
    if (budget.paused || budget.count >= CONFIG.REQUEST_BUDGET) return true;
    if (collectedPostCount() >= CONFIG.MAX_AUTO_SAVE_POSTS) return true;
    if (state.tour.postsDone >= CONFIG.TOUR_MAX_POSTS) return true;
    if (state.tour.failStreak >= 3) return true;
    return false;
  }

  function tourTryStop(reason) {
    if (!state.tour.active) return;
    log(`[巡览] 自动停止：${reason}`);
    stopAutoTour();
    if (state.isRecording && !state.saving && !state.autoSaving) {
      state.autoSaving = true;
      setTimeout(() => stopAndSave(true), 300);
    }
  }

  function startAutoTour() {
    stopAutoTour();
    state.tour.active = true;
    state.tour.visited.clear();
    state.tour.queue = [];
    state.tour.queueIdx = 0;
    state.tour.postsDone = 0;
    state.tour.failStreak = 0;
    state.tour.waiting = false;
    // v1.1.10：lastNavAt 初始化为 5s 前——否则下方立即调用 tourOnGrid 会被防风暴守卫
    // (now - lastNavAt < 1200) 拦下，首帖永远不会打开（"自动巡览没自动点进帖子"根因）。
    state.tour.lastNavAt = Date.now() - 5000;
    // v1.1.10 巡览门控：未进帖前（网格页）暂停一切媒体采集，进入帖子后才开始
    state.tour.gate = true;
    // v1.1.11：记录起始账号名（网格页 URL 提取，文件名前缀兜底）
    state.tour.username = currentUsername();
    state.tour.currentSc = null;
    state.tour.lastUrl = location.href;
    log('自动巡览已启动：自动打开帖子 → 采集完自动切下一帖 → 末页自动停止保存');
    startUrlWatcher();
    const sc = currentPostShortcode();
    if (sc) { tourOnPost(sc); }  // 已在详情页（开关开启前就在）
    else { tourOnGrid(); }       // 网格页：收集并打开首帖
  }

  function stopAutoTour() {
    state.tour.active = false;
    state.tour.waiting = false;
    // v1.1.11：停止巡览必须复位门控与当前帖——否则残留的 currentSc 会继续过滤，
    // 导致停止后手动采集也被"只采当前帖"拦截（R9-20 实测暴露）
    state.tour.gate = true;
    state.tour.currentSc = null;
    if (state.tour.urlTimer) { clearInterval(state.tour.urlTimer); state.tour.urlTimer = null; }
    if (state.tour.waitTimer) { clearTimeout(state.tour.waitTimer); state.tour.waitTimer = null; }
  }

  /** URL 变化轮询（250ms，SPA 路由变化检测；ig-helper 同款思路） */
  function startUrlWatcher() {
    stopUrlWatcher();
    state.tour.lastUrl = location.href;
    state.tour.urlTimer = setInterval(() => {
      if (!state.tour.active || !state.isRecording || state.fuse) return;
      if (location.href === state.tour.lastUrl) return;
      const prev = state.tour.lastUrl;
      state.tour.lastUrl = location.href;
      try { onTourUrlChange(prev, location.href); } catch (e) { log('巡览 URL 变化处理异常:', e); }
    }, 250);
  }

  function stopUrlWatcher() {
    if (state.tour.urlTimer) { clearInterval(state.tour.urlTimer); state.tour.urlTimer = null; }
  }

  function onTourUrlChange(prev, cur) {
    const sc = currentPostShortcode();
    if (sc) tourOnPost(sc);  // 进入详情页
    else tourOnGrid();       // 回到网格页
  }

  /** 网格页流程：收集队列 → 空则停止 → 否则自动点开首帖（SPA） */
  function tourOnGrid() {
    if (!state.tour.active || !state.isRecording || state.fuse) return;
    if (Date.now() - state.tour.lastNavAt < 1200) return; // 防导航风暴
    state.tour.lastNavAt = Date.now();
    // v1.1.10 巡览门控：回到网格页 → 暂停采集（避免"还没点帖子就开始采集"）
    state.tour.gate = true;
    // v1.1.11：离开帖子 → 清空当前帖（此后只采新进入的帖子）
    state.tour.currentSc = null;
    const queue = collectTourQueue();
    state.tour.queue = queue;
    state.tour.queueIdx = 0;
    if (!queue.length) {
      // v1.1.10：空队列给出明确原因（processedShortcodes/savedMediaKeys 全过滤）
      log('[巡览] 网格页无可巡览帖子：全部已被处理或已保存（可在设置面板「清除断点进度」后重新巡览）');
      try { GM_notification({ title: 'Instagram 媒体保存', text: '无可巡览的帖子：全部已处理/已保存，可「清除断点进度」后重试' }); } catch (e) {}
      tourTryStop('网格页无可巡览帖子');
      return;
    }
    const sc = queue[0];
    log(`[巡览] 网格页待巡览 ${queue.length} 帖，自动打开首帖 ${sc}`);
    const link = findPostLink(sc);
    if (link) { try { link.click(); } catch (e) {} return; } // SPA 导航进详情页
    // 链接尚未渲染 → 稍后重试
    setTimeout(() => { if (state.tour.active) tourOnGrid(); }, 1500);
  }

  /** 详情页流程：等渲染 → 采集（多图检测先行）→ 切下一帖 */
  async function tourOnPost(sc) {
    if (!state.tour.active || !state.isRecording || state.fuse) return;
    if (state.tour.waiting) return; // 防重复调度
    if (!sc) { tourTryStop('详情页无短码'); return; }
    // 防循环：同一帖被再次进入（URL 未推进）→ 计失败，尝试切下一帖
    if (state.tour.visited.has(sc)) {
      state.tour.failStreak++;
      if (state.tour.failStreak >= 3) { tourTryStop('连续无进展（重复进入同一帖）'); return; }
      log(`[巡览] 重复进入 ${sc}，尝试跳过`);
      await sleep(1500);
      tourNextPost(sc);
      return;
    }
    state.tour.visited.add(sc);
    state.tour.waiting = true;
    // v1.1.10 巡览门控：已进入帖子详情页 → 关闭门控，恢复采集（JSON/DOM 均可入库）
    state.tour.gate = false;
    // v1.1.11：记录当前巡览帖子短码（只采当前帖，过滤相关网格等旁支内容）
    state.tour.currentSc = sc;
    if (tourShouldStop()) { state.tour.waiting = false; tourTryStop('达到停止条件'); return; }
    log(`[巡览] 进入帖子 ${sc}（第 ${state.tour.postsDone + 1} 帖），等待渲染...`);

    // 1) 等待渲染（主媒体出现 或 JSON 已处理该帖），超时跳过防卡死
    const ready = await waitForTourRender(sc);
    if (!state.tour.active || !state.isRecording) return;
    if (!ready) {
      state.tour.failStreak++;
      log(`[巡览] ${sc} 渲染等待超时（${Math.round(CONFIG.TOUR_WAIT_MS / 1000)}s），跳过`);
      state.tour.waiting = false;
      tourNextPost(sc);
      return;
    }
    state.tour.failStreak = 0;

    // 2) 采集当前帖（JSON 通道 hook 已自动 ingest；DOM 兜底补漏）
    try { discoverMedia(); } catch (e) {}

    // 3) 多图检测先行：JSON 未给全量 且 DOM 有轮播"下一张" → 点击展开补全全部图片
    const needExpand = !jsonHasMultiSlides(sc) && document.querySelector(SELECTORS.carouselNext);
    if (needExpand && !state.clicking && !clickedShortcodes.has(sc)) {
      log(`[巡览] ${sc} 检测到多图（DOM 轮播按钮），展开补全 slide...`);
      try { await expandCarouselViaClicks(sc); } catch (e) {}
    }
    try { discoverMedia(); } catch (e) {}

    state.tour.postsDone++;
    log(`[巡览] ${sc} 采集完成，累计 ${state.tour.postsDone} 帖`);
    state.tour.waiting = false;
    tourNextPost(sc);
  }

  /** 等待单帖渲染就绪：轮询主媒体 img/video 出现 或 JSON 已处理；超时返回 false */
  async function waitForTourRender(sc) {
    const deadline = Date.now() + CONFIG.TOUR_WAIT_MS;
    while (Date.now() < deadline) {
      if (!state.tour.active || !state.isRecording || state.fuse) return false;
      let mediaReady = false;
      try {
        // v1.1.15：主媒体就绪 = 出现 <video> 或"非头像"CDN 大图。
        // 之前仅凭 main 里任意 img（含评论头像/骨架图）就判定就绪，导致视频帖在主媒体加载前
        // 就被采集并切走——第二帖只采到评论头像、视频/封面全丢的根因。
        if (document.querySelectorAll(SELECTORS.video).length > 0) mediaReady = true;
        if (!mediaReady) {
          const imgs = document.querySelectorAll(SELECTORS.mainImg);
          for (const img of imgs) {
            const src = String((img && (img.currentSrc || img.src || img.getAttribute && img.getAttribute('src'))) || '');
            if (src && src.includes('cdninstagram.com') && !/s150x150|profile_pic|avatar/i.test(src)) { mediaReady = true; break; }
          }
        }
      } catch (e) {}
      const jsonDone = processedShortcodes.has(sc);
      if (mediaReady || jsonDone) {
        // v1.1.15：仅 DOM 就绪而 JSON 尚未处理该帖时，再给 JSON 一小段缓冲
        // （视频帖 web_info JSON 加载较慢，过早采集会漏掉完整视频/封面）。
        if (mediaReady && !jsonDone) {
          await sleep(1200);
          if (processedShortcodes.has(sc)) { await sleep(400); return true; }
        }
        await sleep(600); // 等 DOM/JSON 稳定后再采集
        return true;
      }
      await sleep(250);
    }
    return false;
  }

  /** 等 URL 从 before 变化（SPA 导航确认），超时返回 false */
  function waitUrlChange(before, timeoutMs) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const t = setInterval(() => {
        if (location.href !== before) { clearInterval(t); resolve(true); }
        else if (Date.now() >= deadline) { clearInterval(t); resolve(false); }
      }, 200);
    });
  }

  /** 切下一帖：优先详情页原生"下一帖"按钮（SPA 不刷新）；无按钮/无效 → history.back 回网格继续 */
  async function tourNextPost(sc) {
    if (!state.tour.active || !state.isRecording) return;
    if (tourShouldStop()) { tourTryStop('达到停止条件'); return; }
    const now = Date.now();
    if (now - state.tour.lastNavAt < 1200) await sleep(1200 - (now - state.tour.lastNavAt));
    state.tour.lastNavAt = Date.now();

    const nextBtn = document.querySelector(SELECTORS.tourNext);
    if (nextBtn) {
      const before = location.href;
      try { nextBtn.click(); } catch (e) {}
      const ok = await waitUrlChange(before, 5000);
      if (ok) { state.tour.failStreak = 0; return; } // watcher 检测到新帖 URL → tourOnPost
      state.tour.failStreak++;
      log('[巡览] 下一帖按钮点击后 URL 未变化，回退返回网格');
    } else {
      log('[巡览] 详情页无下一帖按钮，返回网格继续');
    }

    // 回退：history.back() 回网格页（SPA 历史栈，不刷新）→ watcher → tourOnGrid
    if (typeof history !== 'undefined' && history.length > 1) {
      try { history.back(); } catch (e) { location.href = baseGridUrl(); }
    } else {
      location.href = baseGridUrl();
    }
  }

  // ════════════════════════════════════════════════════════════════
  // ⏱ 空闲自动停止
  // ════════════════════════════════════════════════════════════════

  function startIdleWatch() {
    stopIdleWatch();
    if (CONFIG.IDLE_TIMEOUT_MS <= 0) {
      log('空闲自动停止：已关闭（IDLE_TIMEOUT_MS = 0）');
      return;
    }
    state.lastCount = state.media.size;
    state.lastGrowthAt = Date.now();

    state.idleTimer = setInterval(() => {
      if (!state.isRecording) { stopIdleWatch(); return; }
      if (state.saving || state.autoSaving) return;

      const count = state.media.size;
      if (count > state.lastCount) {
        state.lastCount = count;
        state.lastGrowthAt = Date.now();
        return;
      }
      if (Date.now() - state.lastGrowthAt < CONFIG.IDLE_TIMEOUT_MS) return;

      stopIdleWatch();
      state.autoSaving = true;
      log(`${Math.round(CONFIG.IDLE_TIMEOUT_MS / 1000)} 秒内没有新增媒体，自动停止记录...`);
      setTimeout(() => stopAndSave(true), 200);
    }, CONFIG.IDLE_CHECK_INTERVAL_MS);
  }

  function stopIdleWatch() {
    if (state.idleTimer) { clearInterval(state.idleTimer); state.idleTimer = null; }
  }

  // ════════════════════════════════════════════════════════════════
  // 🔍 MutationObserver
  // ════════════════════════════════════════════════════════════════

  function startObserver() {
    stopObserver();
    state.observer = new MutationObserver((mutations) => {
      if (!state.isRecording) return;
      let hasAdded = false;
      for (const m of mutations) {
        if (m.addedNodes.length) { hasAdded = true; break; }
      }
      if (!hasAdded) return;
      clearTimeout(state._discoverTimer);
      state._discoverTimer = setTimeout(() => {
        try { discoverMedia(); } catch (e) { log('discoverMedia 异常:', e); }
      }, 300);
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (state.observer) { state.observer.disconnect(); state.observer = null; }
    if (state._discoverTimer) { clearTimeout(state._discoverTimer); state._discoverTimer = null; }
  }

  // ════════════════════════════════════════════════════════════════
  // 📦 自动保存
  // ════════════════════════════════════════════════════════════════

  /** v1.1.19：本次已采集帖子数（媒体按 shortcode 去重计数） */
  function collectedPostCount() {
    const s = new Set();
    for (const m of state.media.values()) if (m.shortcode) s.add(m.shortcode);
    return s.size;
  }

  /** v1.1.20：媒体缓存硬上限（内存保护）——由"满量自动保存(帖)"派生（每帖按至多 20 个媒体估算），不再单独配置 */
  function mediaHardLimit() {
    return CONFIG.MAX_AUTO_SAVE_POSTS * 20;
  }

  /**
   * v1.1.19：保存前预算预判——估算完成已采集媒体保存所需的请求数（每项约 HEAD+下载 2 次），
   * 若剩余预算不足以完成，则立即终止采集并保存（避免采集更多后保存时预算用尽卡住）。
   */
  function budgetAheadExceeded() {
    const estNeeded = state.media.size * 2;
    return budget.count + estNeeded >= CONFIG.REQUEST_BUDGET;
  }

  function checkAutoSave() {
    if (!state.isRecording || state.saving || state.autoSaving) return;
    // v1.1.19：满量自动保存按"帖子数"触发（原按媒体数）
    if (collectedPostCount() >= CONFIG.MAX_AUTO_SAVE_POSTS) {
      state.autoSaving = true;
      log(`满量自动保存触发：已采集 ${collectedPostCount()} 帖（≥${CONFIG.MAX_AUTO_SAVE_POSTS} 帖）`);
      setTimeout(() => stopAndSave(true), 200);
      return;
    }
    // v1.1.19：预算前瞻——剩余预算不足完成已采集媒体的保存 → 提前终止采集直接保存
    if (budgetAheadExceeded()) {
      state.autoSaving = true;
      log(`预算前瞻：剩余预算不足以完成 ${state.media.size} 个媒体的保存（估算需 ${state.media.size * 2} 请求），提前终止采集并保存`);
      try { GM_notification({ title: 'Instagram 媒体保存', text: '剩余请求预算不足以完成本次保存，已提前终止采集并保存' }); } catch (e) {}
      setTimeout(() => stopAndSave(true), 200);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 🔎 小文件过滤（HEAD 探测 + Range 兜底；下载后实际字节复核为权威门槛）
  // ════════════════════════════════════════════════════════════════

  /**
   * v1.2.2：下载请求随机间隔——每次下载类请求（HEAD/Range 探测、Blob 拉取、GM_download，
   * 含失败重试）发出前调用。时长在 [DOWNLOAD_DELAY_MIN_MS, DOWNLOAD_DELAY_MAX_MS] 内呈偏态分布：
   * delay = min + (max-min) * rand^SKEW，SKEW>1 → 短间隔为主、长间隔稀少，
   * 避免请求集中发送触发 CDN 风控。min>max 时自动钳制；两者均 ≤0 时零等待（测试/关闭用）。
   */
  function downloadDelayRange() {
    let lo = Math.max(0, Math.floor(CONFIG.DOWNLOAD_DELAY_MIN_MS) || 0);
    let hi = Math.max(0, Math.floor(CONFIG.DOWNLOAD_DELAY_MAX_MS) || 0);
    if (hi < lo) { const t = lo; lo = hi; hi = t; }
    return [lo, hi];
  }

  function downloadJitter() {
    const [lo, hi] = downloadDelayRange();
    if (hi <= 0) return Promise.resolve();
    const skew = (typeof CONFIG.DOWNLOAD_DELAY_SKEW === 'number' && CONFIG.DOWNLOAD_DELAY_SKEW > 0) ? CONFIG.DOWNLOAD_DELAY_SKEW : 4;
    const r = Math.pow(Math.random(), skew);
    const ms = Math.round(lo + (hi - lo) * r);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * v1.2.2：以"先随机间隔、再发起请求"的方式执行 issueFn。
   * 间隔未启用（上限 ≤0）时**同步**调用 issueFn——保持与 v1.2.1 完全一致的调用语义
   * （关闭间隔时不引入额外微任务时序，依赖同步发起路径的调用方/单测不受影响）。
   */
  function withDownloadJitter(issueFn) {
    const [, hi] = downloadDelayRange();
    if (hi <= 0) return issueFn();
    return downloadJitter().then(issueFn);
  }

  /**
   * Range 兜底探测：HEAD 无 Content-Length（CDN 拒 HEAD / 无长度头 / 重定向）时，
   * 改发 Range: bytes=0-0 的 GET，从 Content-Range: bytes 0-0/TOTAL 或 206
   * 响应的 Content-Length 取总大小；仍失败返回 null（保守放行，靠下载复核兜底）。
   */
  function probeRangeSize(url, done) {
    countRequest(1);
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); done(v); } };
    const timer = setTimeout(() => finish(null), 15000);
    // v1.2.2：请求前随机间隔
    withDownloadJitter(() => {
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url: url,
          timeout: 10000,
          headers: { 'Referer': 'https://www.instagram.com/', 'Range': 'bytes=0-0' },
          onload: (response) => {
            try {
              const status = (response && response.status) || 0;
              const headers = String((response && response.responseHeaders) || '');
              // Content-Range: bytes 0-0/TOTAL → TOTAL
              const cr = headers.match(/content-range:\s*bytes\s+\d+-\d+\/(\d+)/i);
              if (cr) { finish(parseInt(cr[1], 10)); return; }
              // 206 响应的 Content-Length 兜底
              if (status === 206) {
                const cl = headers.match(/content-length:\s*(\d+)/i);
                if (cl) { finish(parseInt(cl[1], 10)); return; }
              }
              finish(null);
            } catch (e) { finish(null); }
          },
          onerror: () => finish(null),
          ontimeout: () => finish(null),
          onabort: () => finish(null),
        });
      } catch (e) { finish(null); }
    });
  }

  function getMediaSize(url) {
    countRequest(1);
    // v1.2.2：请求前随机间隔（超时窗口自请求实际发出起算）
    return withDownloadJitter(() => new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
      const timer = setTimeout(() => done(null), 15000);
      try {
        GM_xmlhttpRequest({
          method: 'HEAD',
          url: url,
          timeout: 10000,
          headers: { 'Referer': 'https://www.instagram.com/' },
          onload: (response) => {
            try {
              const status = (response && response.status) || 0;
              if (status >= 400) {
                log(`[HEAD] ${status}，不参与小文件过滤: ${url}`);
                maybeFuseResponse(response, '');
                done(null);
                return;
              }
              const headers = String((response && response.responseHeaders) || '');
              const cl = headers.match(/content-length:\s*(\d+)/i);
              if (cl) {
                const sz = parseInt(cl[1], 10);
                // v1.1.7：HEAD 返回异常小值（< 视频最小体积）不可信——部分 IG CDN 节点对
                // HEAD 可能回 content-length: 0 或极小值，直接采信会把"有效视频误判为无效跳过"。
                // 改走 Range 兜底，用 Content-Range: bytes 0-0/TOTAL 的真实总大小再判定。
                if (sz < CONFIG.MIN_MEDIA_SIZE) { probeRangeSize(url, done); return; }
                done(sz); return;
              }
              // Round 3 修复3：HEAD 无 Content-Length → Range GET 兜底取总大小
              probeRangeSize(url, done);
            } catch (e) {
              done(null);
            }
          },
          onerror: () => done(null),
          ontimeout: () => done(null),
          onabort: () => done(null),
        });
      } catch (e) {
        done(null);
      }
    }));
  }

  async function filterSmallFiles(mediaList) {
    log(`开始小文件过滤，共 ${mediaList.length} 个媒体...`);
    let skipped = 0;
    const kept = [];

    await runConcurrent(mediaList, CONFIG.HEAD_CONCURRENCY, async (item) => {
      // P2-9：保存期请求同样受预算约束，超限暂停、不再发 HEAD
      if (budget.paused || budget.count >= CONFIG.REQUEST_BUDGET) {
        setBudgetPaused(true);
        kept.push(item); // 预算用尽不探测，保留该项（宁多勿漏）
        return { skip: false };
      }
      if (item.type === 'video') {
        const size = await getMediaSize(item.url);
        if (size !== null && size < CONFIG.MIN_MEDIA_SIZE) {
          log(`[跳过] 无效视频 ${(size / 1024).toFixed(1)}KB: ${item.url}`);
          skipped++;
          return { skip: true };
        }
        // v1.1.17：探测大小写回媒体项（下载时据此分流：小视频进 ZIP、大视频单独下载）
        item.probedSize = size;
        kept.push(item);
        return { skip: false, size };
      }
      const size = await getMediaSize(item.url);
      if (size !== null && size < CONFIG.MIN_MEDIA_SIZE) {
        log(`[跳过] 小文件 ${(size / 1024).toFixed(1)}KB: ${item.url}`);
        skipped++;
        return { skip: true };
      }
      item.probedSize = size;
      kept.push(item);
      return { skip: false, size };
    });

    const urlSet = new Set(kept.map((k) => k.url));
    const ordered = mediaList.filter((m) => urlSet.has(m.url));
    log(`过滤完成：保留 ${ordered.length} 个，跳过 ${skipped} 个小文件`);
    return { filtered: ordered, skipped };
  }

  // ════════════════════════════════════════════════════════════════
  // 💾 下载保存（ZIP 打包；Round 3：始终一次性 ZIP，移除逐文件保存模式）
  // ════════════════════════════════════════════════════════════════

  // Round 4 (v1.1.1)：Tampermonkey @connect 白名单拦截特征文本。
  // 命中仅限该特征（connect / not allowed / blocked / not part of），普通网络错误（timeout / network_error 等）不误伤。
  const CONNECT_BLOCK_RE = /connect|not allowed|blocked|not part of/i;
  const CONNECT_BLOCK_HINT = 'CDN 域名被 Tampermonkey 拦截：请在扩展面板中允许访问 cdninstagram.com 后重试';

  /**
   * Round 4 (v1.1.1)：检测下载/探测失败的错误文本是否为 Tampermonkey @connect 白名单拦截。
   * 命中则置位 state.connectBlocked 并给出面板/按钮醒目提示 + 日志标注（不抛异常、不影响原失败流程）。
   * @param {*} errText 错误文本（字符串或可 String() 化的对象）
   * @returns {boolean} 是否命中 @connect 拦截特征
   */
  function flagConnectBlocked(errText) {
    const text = String(errText || '');
    if (!CONNECT_BLOCK_RE.test(text)) return false;
    if (state.connectBlocked) return true;
    state.connectBlocked = true;
    log('⚠ ' + CONNECT_BLOCK_HINT + '（原始错误: ' + text + '）');
    try {
      GM_notification({ title: 'Instagram 媒体保存', text: CONNECT_BLOCK_HINT });
    } catch (e) {}
    updateButton();
    updatePanel();
    return true;
  }

  function fetchMediaBlob(url, timeoutMs, label) {
    countRequest(1);
    // v1.2.2：请求前随机间隔（超时窗口自请求实际发出起算）
    return withDownloadJitter(() => new Promise((resolve) => {
      let settled = false;
      const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
      const timer = setTimeout(() => finish({ success: false, data: null, size: 0, error: '超时' }), timeoutMs);
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url: url,
          responseType: 'arraybuffer',
          timeout: timeoutMs,
          headers: { 'Referer': 'https://www.instagram.com/' },
          onload: (response) => {
            const lm = (() => { const h = String((response && response.responseHeaders) || '').match(/last-modified:\s*([^\r\n]+)/i); return h ? h[1].trim() : null; })();
            if (response.status && response.status >= 400) {
              maybeFuseResponse(response, response.responseText || '');
              finish({ success: false, data: null, size: 0, error: `HTTP ${response.status}` });
              return;
            }
            const data = response.response;
            if (data == null) {
              finish({ success: false, data: null, size: 0, error: '空响应' });
              return;
            }
            let buf;
            if (data instanceof ArrayBuffer) {
              buf = data;
            } else if (ArrayBuffer.isView(data)) {
              buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
            } else if (data instanceof Blob) {
              data.arrayBuffer().then((ab) => finish({ success: ab.byteLength > 0, data: ab, size: ab.byteLength, lastModified: lm }));
              return;
            } else {
              finish({ success: false, data: null, size: 0, error: '未知响应类型' });
              return;
            }
            finish({ success: buf.byteLength > 0, data: buf, size: buf.byteLength, lastModified: lm });
          },
          onerror: (err) => {
            const errText = (err && err.error) || '网络错误';
            flagConnectBlocked(errText);
            finish({ success: false, data: null, size: 0, error: errText });
          },
          ontimeout: () => finish({ success: false, data: null, size: 0, error: '超时' }),
        });
      } catch (e) {
        const errText = (e && e.message) || 'GM异常';
        flagConnectBlocked(errText);
        finish({ success: false, data: null, size: 0, error: errText });
      }
    }));
  }

  // ════════════════════════════════════════════════════════════════
  // 📦 同步 ZIP 打包器（STORE 模式，100% 同步，不依赖 JSZip 异步调度器）
  // ════════════════════════════════════════════════════════════════
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    return t;
  })();

  function crc32(data, table) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function buildZip(files) {
    const encoder = new TextEncoder();
    const chunks = [];
    const central = [];
    let offset = 0;
    const now = new Date();
    const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
    const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

    for (const f of files) {
      let data = f.data;
      if (data instanceof ArrayBuffer) data = new Uint8Array(data);
      else if (ArrayBuffer.isView(data)) data = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      else if (!(data instanceof Uint8Array)) data = new Uint8Array(data);
      const nameBytes = encoder.encode(f.name);
      const crc = crc32(data, CRC_TABLE);

      const lfh = new Uint8Array(30 + nameBytes.length);
      const dv = new DataView(lfh.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0x0800, true); // UTF-8 文件名标志
      dv.setUint16(8, 0, true);
      dv.setUint16(10, dosTime, true);
      dv.setUint16(12, dosDate, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true);
      dv.setUint32(22, data.length, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      lfh.set(nameBytes, 30);
      chunks.push(lfh, data);

      const cd = new Uint8Array(46 + nameBytes.length);
      const cdv = new DataView(cd.buffer);
      cdv.setUint32(0, 0x02014b50, true);
      cdv.setUint16(4, 20, true);
      cdv.setUint16(6, 20, true);
      cdv.setUint16(8, 0x0800, true);
      cdv.setUint16(10, 0, true);
      cdv.setUint16(12, dosTime, true);
      cdv.setUint16(14, dosDate, true);
      cdv.setUint32(16, crc, true);
      cdv.setUint32(20, data.length, true);
      cdv.setUint32(24, data.length, true);
      cdv.setUint16(28, nameBytes.length, true);
      cdv.setUint16(30, 0, true);
      cdv.setUint16(32, 0, true);
      cdv.setUint16(34, 0, true);
      cdv.setUint16(36, 0, true);
      cdv.setUint32(38, 0, true);
      cdv.setUint32(42, offset, true);
      cd.set(nameBytes, 46);
      central.push(cd);
      offset += lfh.length + data.length;
    }

    const centralSize = central.reduce((s, c) => s + c.length, 0);
    const centralOffset = offset;
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, centralOffset, true);
    ev.setUint16(20, 0, true);

    const total = offset + centralSize + eocd.length;
    const result = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) { result.set(c, pos); pos += c.length; }
    for (const c of central) { result.set(c, pos); pos += c.length; }
    result.set(eocd, pos);
    return result;
  }

  /**
   * 构造 ZIP 文件清单（纯函数，便于离线测试）。
   * v1.1.18：不再附带 meta/ 文件夹（按用户要求移除该功能）。
   * @param {Array<{task:{type,filename}}>} fetched 已拉取成功的媒体任务
   * @returns {Array<{name,data}>}
   */
  function buildImageZipFiles(fetched) {
    return fetched.map((r) => ({
      name: (r.task.type === 'video' ? 'videos/' : 'images/') + r.task.filename,
      data: r.data,
    }));
  }

  /** 发布日期戳：epoch 秒 → YYYYMMDD（与 currentDateStamp 同款 pad 风格）；非法/空返回 null */
  function dateStampFromTs(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return null;
    const d = new Date(n * 1000);
    if (Number.isNaN(d.getTime())) return null;
    const pad = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  }

  /**
   * 解析媒体项发布日期段（Round 3 修复4）：
   * 优先级 m.takenAt（epoch 秒）→ state.postMeta.get(shortcode).taken_at
   * （ISO 字符串，取前 10 位去 '-'）→ null（不写"今天日期"冒充发布日期）
   */
  function resolveDateStamp(m, sc) {
    if (m && m.takenAt != null) {
      const d = dateStampFromTs(m.takenAt);
      if (d) return d;
    }
    if (sc && state.postMeta.has(sc)) {
      const meta = state.postMeta.get(sc);
      const takenAt = meta && meta.taken_at;
      if (typeof takenAt === 'string' && takenAt) {
        const m2 = takenAt.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m2) return m2[1] + m2[2] + m2[3];
      }
    }
    return null;
  }

  /**
   * 从图片 HTTP 响应头 Last-Modified（RFC 1123，如 "Wed, 21 Oct 2015 07:28:00 GMT"）
   * 解析出 YYYYMMDD 日期段；解析失败返回 null。Round 5：图片文件名日期段优先采用它。
   */
  function dateStampFromHttpDate(s) {
    if (!s || typeof s !== 'string') return null;
    const d = new Date(s.trim());
    if (Number.isNaN(d.getTime())) return null;
    const pad = (x) => String(x).padStart(2, '0');
    // 用 UTC：Last-Modified 本身是 GMT，文件名日期段须严格等于响应头里的 GMT 日期（不受本地时区影响）
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  }

  /**
   * 图片最终文件名：优先用图片响应头 Last-Modified 的日期段；
   * 拿不到则回退 buildDownloadTasks 已按 taken_at 生成的 task.filename。仅作用于图片。
   */
  function finalImageName(task, lastModifiedRaw) {
    const lm = dateStampFromHttpDate(lastModifiedRaw);
    if (lm) {
      const username = currentUsername();
      const idx = String((typeof task.slideIndex === 'number' ? task.slideIndex : 0) + 1).padStart(2, '0');
      const ext = task.type === 'video' ? 'mp4' : getExtension(task.url);
      const sc = task.shortcode || 'post';
      return `${username}_${lm}_${sc}_${idx}.${ext}`;
    }
    return task.filename;
  }

  /**
   * v1.1.17：ZIP 分卷（纯函数）——数量达 maxCount 或累计体积超 maxBytes 即开新包。
   * @param {Array<{data:Uint8Array|Blob}>} fetched
   * @returns {Array<Array>} 分卷数组
   */
  function buildZipChunks(fetched, maxCount, maxBytes) {
    const parts = [];
    let chunk = [];
    let chunkBytes = 0;
    for (const r of fetched) {
      const size = (r && r.data && r.data.byteLength) || 0;
      if (chunk.length && (chunk.length >= maxCount || chunkBytes + size > maxBytes)) {
        parts.push(chunk);
        chunk = [];
        chunkBytes = 0;
      }
      chunk.push(r);
      chunkBytes += size;
    }
    if (chunk.length) parts.push(chunk);
    return parts;
  }

  /** v1.1.18：媒体文件名 {username}[_{YYYYMMDD}]_{shortcode}_{序号}.{ext}（有发布日期才带日期段） */
  function makeMediaFilename(m, sc) {
    const username = currentUsername();
    const idx = String((typeof m.slideIndex === 'number' ? m.slideIndex : 0) + 1).padStart(2, '0');
    const ext = m.type === 'video' ? 'mp4' : getExtension(m.url);
    const dateStamp = resolveDateStamp(m, sc === 'post' ? null : sc);
    const datePart = dateStamp ? `${dateStamp}_` : '';
    return `${username}_${datePart}${sc}_${idx}.${ext}`;
  }

  /** 生成下载任务：文件名 {username}[_{YYYYMMDD}]_{shortcode}_{序号}.{ext}（有发布日期才带日期段） */
  function buildDownloadTasks(mediaList) {
    const tasks = [];
    const byPost = new Map();
    for (const m of mediaList) {
      const sc = m.shortcode || (m.postUrl ? extractShortcode(m.postUrl) : null);
      const key = sc || ('url_' + getBaseUrl(m.url));
      if (!byPost.has(key)) byPost.set(key, []);
      byPost.get(key).push(m);
    }
    for (const [key, group] of byPost) {
      const sc = key.startsWith('url_') ? 'post' : key;
      group.forEach((m) => {
        tasks.push({
          url: m.url,
          filename: makeMediaFilename(m, sc),
          type: m.type,
          key: m.key || getMediaKey(m),
          // P2-5：保留真实 slideIndex / shortcode，供失败重试与命名
          slideIndex: (typeof m.slideIndex === 'number') ? m.slideIndex : 0,
          shortcode: sc === 'post' ? null : sc,
          // v1.1.22：小文件过滤阶段探测的字节大小（保存时视频分流：< 阈值进 ZIP，≥ 阈值单独下载）
          size: (typeof m.probedSize === 'number') ? m.probedSize : null,
        });
      });
    }
    return tasks;
  }

  function generateZipFilename(part) {
    const base = `${currentUsername()}_media_${currentDateStamp()}`;
    return part > 0 ? `${base}_part${part}.zip` : `${base}.zip`;
  }

  function fallbackDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 3000);
  }

  /** 构造失败重试项（P2-5：保留真实 slideIndex / shortcode） */
  function makeFailedItem(task) {
    const sc = shortcodeFromKey(task.key);
    return {
      key: task.key,
      url: task.url,
      type: task.type,
      postUrl: sc ? 'https://www.instagram.com/p/' + sc + '/' : null,
      slideIndex: (typeof task.slideIndex === 'number') ? task.slideIndex : 0,
      shortcode: sc,
    };
  }

  /** 日志截断 URL（避免打满控制台） */
  function shortUrl(u) {
    const s = String(u || '');
    return s.length > 110 ? s.slice(0, 110) + '…' : s;
  }

  /** GM_download 单个文件（Promise 化）；onload/onerror 遇 429/403 交 maybeFuseResponse 判定 */
  function gmDownloadPromise(task) {
    // v1.2.2：请求前随机间隔（硬超时窗口自请求实际发出起算）
    return withDownloadJitter(() => new Promise((resolve) => {
      let done = false;
      const settle = (ok, msg) => { if (done) return; done = true; if (msg) log(msg); resolve(ok); };
      try {
        GM_download({
          url: task.url,
          name: task.filename,
          onload: (res) => {
            // v1.1.7 P2 修复：GM_download 回调携带 >=400 状态 = 下载实际失败
            // （CDN 403 / 签名过期 / 限流等）。必须记失败（进 failedItems 可重试），
            // 绝不能 settle(true) 误标"已保存"——否则该 key 被写入 savedMediaKeys，
            // 下次采集直接跳过、永不重试（"仍然没有下载"的根因之一）。429/403 顺带熔断判定。
            if (res && res.status && res.status >= 400) {
              if (res.status === 403 || res.status === 429) maybeFuseResponse(res, '');
              settle(false, `[✗] 下载被拒 ${res.status}: ${task.filename} (${shortUrl(task.url)})`);
              return;
            }
            settle(true, `[✓] 已下载: ${task.filename}`);
          },
          onerror: (e) => {
            maybeFuseResponse(e || {}, '');
            const errText = (e && e.error) || '错误';
            flagConnectBlocked(errText);
            settle(false, `[✗] 下载失败: ${task.filename} (${errText})`);
          },
          ontimeout: () => settle(false, `[✗] 下载超时: ${task.filename}`),
        });
      } catch (e) {
        flagConnectBlocked(e && e.message);
        settle(false, `[✗] GM_download 异常: ${task.filename} (${e.message})`);
      }
      setTimeout(() => settle(false, `[✗] 下载超时(硬): ${task.filename}`), CONFIG.REQUEST_TIMEOUT_MS);
    }));
  }

  /** 预算/熔断守卫：超限或熔断时置位并返回 true */
  function downloadBlocked() {
    if (state.fuse) return true;
    if (budget.paused || budget.count >= CONFIG.REQUEST_BUDGET) {
      setBudgetPaused(true);
      return true;
    }
    return false;
  }

  // v1.1.22：浏览过程不下任何文件（无即时下载）；保存时——图片 + 小视频（< 视频打包阈值）进 ZIP，
  // 大视频（≥ 阈值，或大小未知时补探测一次）走 GM_download 单独下载。
  // v1.3.0：Fisher–Yates 原地打乱（返回新数组，不修改入参）——用于下载顺序随机化
  function shuffleArray(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  async function downloadAsZip(mediaList) {
    if (state.fuse) {
      log('风控熔断：中止保存');
      return { saved: 0, failed: 0, failedItems: [], savedKeys: [], zipSize: 0, filteredOut: 0 };
    }
    // v1.3.0：下载顺序随机打乱（抗风控——避免请求按采集顺序规律排列）
    if (CONFIG.SHUFFLE_DOWNLOAD_ORDER && mediaList && mediaList.length > 1) {
      mediaList = shuffleArray(mediaList);
      log(`下载顺序已随机打乱（${mediaList.length} 个媒体）`);
    }
    const tasks = buildDownloadTasks(mediaList);
    // v1.1.22：视频分流（白名单制）——只有"明确探测到 ≥ VIDEO_ZIP_MAX_MB"的视频单独下载；
    // 其余（含大小未知）一律打包进 ZIP；未知大小视频保存时补探测一次（预算内）。
    const videoZipLimit = CONFIG.VIDEO_ZIP_MAX_MB * 1024 * 1024;
    for (const t of tasks) {
      if (t.type === 'video' && typeof t.size !== 'number' && !downloadBlocked()) {
        t.size = await getMediaSize(t.url);
      }
    }
    const isBigVideo = (t) => t.type === 'video' && typeof t.size === 'number' && t.size >= videoZipLimit;
    const zipTasks = tasks.filter(t => t.type === 'image' || !isBigVideo(t));
    const directVideos = tasks.filter(isBigVideo);
    const failedItems = [];
    const savedKeys = [];
    // Round 3 修复3：下载后实际字节复核跳过的小文件计数（永久跳过，非失败）
    let filteredOut = 0;

    log(`开始保存 ${tasks.length} 个媒体（ZIP 打包 ${zipTasks.length} 个：图片 + <${CONFIG.VIDEO_ZIP_MAX_MB}MB 视频；单独下载 ${directVideos.length} 个：大视频）...`);
    updateButtonStage('保存中…');

    // ── 大视频：直接 GM_download 单独下载（P1-3：避免整段大视频缓冲进内存）──
    if (directVideos.length) {
      let vDone = 0;
      updateButtonStage(`下载大视频中… 0/${directVideos.length}`);
      await runConcurrent(directVideos, CONFIG.DOWNLOAD_CONCURRENCY, async (task) => {
        if (downloadBlocked()) { failedItems.push(makeFailedItem(task)); return; }
        countRequest(1);
        let ok = await gmDownloadPromise(task);
        // v1.1.7：视频下载失败自动重试一次（CDN 瞬态拒绝/限流常见，避免一次失败就进重试队列）
        if (!ok && !downloadBlocked()) {
          await sleep(1000 + Math.random() * 1500);
          if (downloadBlocked()) { failedItems.push(makeFailedItem(task)); vDone++; updateButtonProgress(vDone, directVideos.length); return; }
          countRequest(1);
          ok = await gmDownloadPromise(task);
        }
        if (ok) savedKeys.push(task.key);
        else failedItems.push(makeFailedItem(task));
        vDone++;
        updateButtonProgress(vDone, directVideos.length);
      });
    }

    // ── 图片 + 小视频：Blob 拉取 + ZIP 打包 ──
    if (zipTasks.length) {
      const total = zipTasks.length;
      const fetched = [];
      updateButtonStage('拉取媒体中…');
      for (let batchStart = 0; batchStart < total; batchStart += CONFIG.BATCH_SIZE) {
        if (downloadBlocked()) {
          for (let i = batchStart; i < zipTasks.length; i++) failedItems.push(makeFailedItem(zipTasks[i]));
          log('熔断/预算用尽：中止媒体拉取，剩余项记入失败重试');
          break;
        }
        const batch = zipTasks.slice(batchStart, batchStart + CONFIG.BATCH_SIZE);
        const batchNo = Math.floor(batchStart / CONFIG.BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(total / CONFIG.BATCH_SIZE);
        log(`[拉取] 批次 ${batchNo}/${totalBatches}（${batch.length} 个）...`);
        updateButtonStage(`拉取媒体中… ${batchStart}/${total}`);

        const results = await runConcurrent(batch, CONFIG.DOWNLOAD_CONCURRENCY, async (task) => {
          if (downloadBlocked()) return { task, data: null, lastModified: null };
          const result = await fetchMediaBlob(task.url, CONFIG.REQUEST_TIMEOUT_MS, task.filename);
          if (result.success) {
            log(`[✓] 已拉取: ${task.filename} (${formatSize(result.size)})${result.lastModified ? ' [LM ' + result.lastModified + ']' : ''}`);
            return { task, data: result.data, lastModified: result.lastModified || null };
          }
          log(`[✗] 拉取失败: ${task.filename} (${result ? result.error : '未知'})`);
          return { task, data: null, lastModified: null };
        });

        for (const r of results) {
          if (!r) continue;
          if (r.data == null) {
            failedItems.push(makeFailedItem(r.task));
            continue;
          }
          const bytes = r.data.byteLength || 0;
          if (bytes < CONFIG.MIN_MEDIA_SIZE) {
            log(`[跳过] 小文件过滤(下载复核) ${formatSize(bytes)}: ${r.task.filename}`);
            filteredOut++;
            continue;
          }
          const finalTask = Object.assign({}, r.task, { filename: finalImageName(r.task, r.lastModified) });
          fetched.push({ task: finalTask, data: r.data });
        }
      }

      if (fetched.length) {
        // v1.1.17：ZIP 分卷 = 数量(BATCH_SIZE) 或 体积(ZIP_SPLIT_MB) 任一超限即开新包
        const zipParts = buildZipChunks(fetched, CONFIG.BATCH_SIZE, CONFIG.ZIP_SPLIT_MB * 1024 * 1024).map((files, i) => ({ files, partNo: i + 1 }));

        let zipSaved = 0;
        for (const part of zipParts) {
          updateButtonStage(`正在打包 ZIP… 第 ${part.partNo}/${zipParts.length} 批 (${part.files.length} 个)`);
          log(`[打包] 第 ${part.partNo} 批：${part.files.length} 个媒体...`);
          // v1.1.18：ZIP 文件清单（images/ 图片 + videos/ 小视频；不再生成 meta/ 文件夹）
          const files = buildImageZipFiles(part.files);
          const zipData = buildZip(files);
          log(`[打包] 第 ${part.partNo} 批完成，大小: ${formatSize(zipData.byteLength)}`);
          const filename = generateZipFilename(zipParts.length > 1 ? part.partNo : 0);
          updateButtonStage(`正在下载 ZIP… ${part.partNo}/${zipParts.length}`);
          log(`[保存] ${filename} (${formatSize(zipData.byteLength)})`);
          try {
            const blob = new Blob([zipData], { type: 'application/zip' });
            if (typeof saveAs === 'function') {
              saveAs(blob, filename);
            } else {
              const url = URL.createObjectURL(blob);
              fallbackDownload(url, filename);
            }
            zipSaved++;
            log(`[✓] ZIP 下载已触发: ${filename}`);
            await sleep(800);
          } catch (e) {
            log(`[✗] ZIP 保存失败: ${filename} (${e.message})`);
          }
        }
        savedKeys.push(...fetched.map(r => r.task.key));
        log(`打包完成：共 ${zipParts.length} 个 ZIP，成功 ${zipSaved}`);
      }
    }

    log(`保存完成：成功 ${savedKeys.length}，失败 ${failedItems.length}`);
    return { saved: savedKeys.length, failed: failedItems.length, failedItems, savedKeys, zipSize: 0, filteredOut };
  }

  // ════════════════════════════════════════════════════════════════
  // 🎛 浮动按钮 UI + 设置面板
  // ════════════════════════════════════════════════════════════════
  const PANEL_ID = 'ig-media-saver-panel';
  const GEAR_ID = 'ig-media-saver-settings';

  const ICON = {
    gear: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M3 12c0-1.1.9-2 2-2s2 .9 2 2-.9 2-2 2-2-.9-2-2zm9 2c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm7 0c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z"/></svg>',
    tune: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="4" y1="7" x2="20" y2="7"/><circle cx="9.5" cy="7" r="2.4" fill="#fff"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2.4" fill="#fff"/><line x1="4" y1="17" x2="20" y2="17"/><circle cx="8" cy="17" r="2.4" fill="#fff"/></svg>',
    camera: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 8a5 5 0 100 10 5 5 0 000-10zm0 2.5a2.5 2.5 0 110 5 2.5 2.5 0 010-5zM9.5 3l-1.3 1.5H5a2 2 0 00-2 2v11a2 2 0 002 2h14a2 2 0 002-2v-11a2 2 0 00-2-2h-3.2L14.5 3h-5z"/></svg>',
    stop: '<span style="width:10px;height:10px;background:currentColor;display:inline-block;flex:none;margin-right:2px" aria-hidden="true"></span>',
    save: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 2.59l5.7 5.7-1.41 1.42L13 6.41V16h-2V6.41l-3.3 3.3-1.41-1.42L12 2.59zM21 15l-.02 3.51c0 1.38-1.12 2.49-2.5 2.49H5.5C4.11 21 3 19.88 3 18.5V15h2v3.5c0 .28.22.5.5.5h12.98c.28 0 .5-.22.5-.5L19 15h2z"/></svg>',
  };

  function makeEl(tag, cssText, text) {
    const n = document.createElement(tag);
    if (cssText) n.style.cssText = cssText;
    if (text != null) n.textContent = text;
    return n;
  }

  // 面板专属一次性样式块：数字输入框隐藏 spinner、复选框自定义为方案 B 紫罗兰
  // （勾选 #7c5cff + 白勾、未勾选 #c4b5fd 边框）—— 作用域限定为面板 ID，不污染宿主页
  function ensurePanelStyles() {
    const styleId = PANEL_ID + '-styles';
    if (document.getElementById(styleId)) return;
    const s = document.createElement('style');
    s.id = styleId;
    s.textContent =
      '#' + PANEL_ID + ' input[type=number]{appearance:textfield;-moz-appearance:textfield}' +
      '#' + PANEL_ID + ' input[type=number]::-webkit-outer-spin-button,' +
      '#' + PANEL_ID + ' input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}' +
      '#' + PANEL_ID + ' input[type=checkbox]{-webkit-appearance:none;appearance:none;width:18px;height:18px;border:1.5px solid #c4b5fd;border-radius:4px;background-color:#fff;cursor:pointer;position:relative;vertical-align:middle;margin:0;padding:0;flex:none}' +
      '#' + PANEL_ID + ' input[type=checkbox]:checked{background-color:#7c5cff;border-color:#7c5cff;background-image:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 16 16\'%3E%3Cpath d=\'M4 8l3 3 5-6\' stroke=\'white\' stroke-width=\'2.5\' fill=\'none\' stroke-linecap=\'round\' stroke-linejoin=\'round\'/%3E%3C/svg%3E");background-size:12px 12px;background-position:center;background-repeat:no-repeat}';
    document.head.appendChild(s);
  }

  function updatePanel() {
    const el = document.getElementById('ig-panel-status');
    if (!el) return;
    const fuse = state.fuse;
    if (fuse) {
      el.textContent = `⚠ ${fuse.message}`;
      el.style.background = 'rgba(244,33,46,0.1)';
      el.style.color = '#f4212e';
    } else if (state.connectBlocked) {
      el.textContent = `⚠ ${CONNECT_BLOCK_HINT}`;
      el.style.background = 'rgba(244,33,46,0.1)';
      el.style.color = '#f4212e';
    } else if (state.budgetPaused) {
      el.textContent = `⏸ 请求预算已用尽（${budget.count}/${CONFIG.REQUEST_BUDGET}），等待窗口重置`;
      el.style.background = 'rgba(255,179,0,0.12)';
      el.style.color = '#b45309';
    } else {
      const savedCount = savedMediaKeys.size;
      el.textContent = `已记录 ${state.media.size} 个媒体 ｜ 已保存 ${savedCount} 条 ｜ 预算 ${budget.count}/${CONFIG.REQUEST_BUDGET} ｜ 游标 ${resumeState.cursor ? '有' : '无'}`;
      el.style.background = 'rgba(22,163,74,0.08)';
      el.style.color = '#0f1419';
    }
  }

  function onPanelOutsideClick(e) {
    const p = document.getElementById(PANEL_ID);
    if (!p || p.contains(e.target)) return;
    const gear = document.getElementById(GEAR_ID);
    if (gear && gear.contains(e.target)) return;
    closeSettings();
  }

  // v1.1.22：设置面板「🔧 Debug/版本」小节——展开/收起（显示脚本版本号 + Debug 模式开关 + 诊断导出）
  // v1.1.27：Debug/版本 浮动弹层（紧邻 🔧 一级按钮，与 panel 内容保持视觉距离；
  // 仅脚本版本 + Debug 开关；导出诊断已移至 footer 始终可见；
  // cb change 不重建（避免 sec 视觉消失/重新出现造成"点一次收回"错觉）；
  // 仅再次点击 🔧 才关闭——关闭整个设置面板时自然清理）
  function toggleDebugSection(panel) {
    const id = PANEL_ID + '-dbg';
    const existing = panel.querySelector ? panel.querySelector('#' + id) : null;
    if (existing) { existing.remove(); return; }
    const sec = makeEl('div', [
      'position: absolute',
      'top: 44px',          // 距一级菜单按钮（panel header）约 10px 视觉距离
      'right: 14px',
      'min-width: 200px',
      'background: #fff',
      'border: 0.5px solid rgba(15,20,25,0.12)',
      'border-radius: 12px',
      'padding: 10px 12px',
      'box-shadow: rgba(0,0,0,0.12) 0px 4px 16px',
      'z-index: 2',
      'font-size: 13px',
      'color: #0f1419',
    ].join('; '));
    sec.id = id;
    sec.appendChild(makeEl('div', 'margin-bottom:6px;color:#536471;font-size:12px', '脚本版本：v' + SCRIPT_VERSION));
    const row = makeEl('div', 'display:flex;align-items:center;justify-content:space-between;padding:4px 0');
    row.appendChild(makeEl('span', 'color:#0f1419', 'Debug 模式'));
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = debugMode;
    cb.style.cssText = 'width:18px;height:18px;cursor:pointer';
    cb.addEventListener('change', () => {
      debugMode = cb.checked;
      try { GM_setValue('igDebugMode', debugMode); } catch (e) {}
      log('Debug 模式：' + (debugMode ? '已开启（导出诊断按钮已显示；高级参数需重新打开设置面板生效）' : '已关闭'));
      // v1.1.29/v1.1.30：即时增删 footer 的导出诊断按钮 + 切换 debugOnly 高级参数行可见性（均不必重开面板）
      try {
        if (panel.querySelectorAll) {
          panel.querySelectorAll('[data-debugonly]').forEach((el) => { el.style.display = debugMode ? '' : 'none'; });
        }
        const foot = panel.querySelector ? panel.querySelector('#' + PANEL_ID + '-foot') : null;
        const existingDiag = panel.querySelector ? panel.querySelector('#' + PANEL_ID + '-diag') : null;
        if (debugMode && !existingDiag && foot) {
          const btn = makeEl('div', 'width:100%;padding:7px 0;margin-top:6px;border-radius:9999px;font-size:13px;font-weight:500;cursor:pointer;border:0.5px solid #cfd9de;text-align:center;box-sizing:border-box;background:#fff;color:#0f1419', '📤 导出诊断JSON');
          btn.id = PANEL_ID + '-diag';
          btn.addEventListener('click', () => { exportDiagnostic(); });
          foot.appendChild(btn);
        } else if (!debugMode && existingDiag) {
          existingDiag.remove();
        }
      } catch (e) {}
      // 故意不重建面板：保留 sec 状态、避免"点 cb 后 sec 视觉消失"的错觉；
      // 高级参数可见性会在用户下次打开面板（buildSettingsPanel）时按当前 debugMode 渲染。
    });
    row.appendChild(cb);
    sec.appendChild(row);
    panel.appendChild(sec);
  }

  function closeSettings() {
    const p = document.getElementById(PANEL_ID);
    if (p) p.remove();
    state.settingsOpen = false;
    document.removeEventListener('mousedown', onPanelOutsideClick, true);
  }

  function buildSettingsPanel() {
    const old = document.getElementById(PANEL_ID);
    if (old) old.remove();

    ensurePanelStyles();

    const panel = makeEl('div', [
      'position: fixed',
      `bottom: calc(${CONFIG.BUTTON_POSITION.bottom} + 56px)`,
      `right: ${CONFIG.BUTTON_POSITION.right}`,
      `z-index: ${CONFIG.BUTTON_Z_INDEX}`,
      'width: 264px', 'box-sizing: border-box', 'background: #fff',
      'border: 0.5px solid rgba(15,20,25,0.08)', 'border-radius: 16px',
      'box-shadow: rgba(101,119,134,0.2) 0px 0px 15px, rgba(101,119,134,0.15) 0px 0px 3px 1px',
      'overflow: visible', // v1.1.27：允许 Debug 浮动弹层溢出 panel
      'pointer-events: auto', 'color: #0f1419',
      'padding-bottom: 10px', 'user-select: none',
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif',
    ].join('; '));
    panel.id = PANEL_ID;

    const head = makeEl('div', 'display:flex;align-items:center;justify-content:space-between;padding:11px 14px 9px;border-bottom:1px solid rgba(15,20,25,0.08)');
    head.appendChild(makeEl('span', 'font-size:14px;font-weight:700', 'Instagram 媒体保存'));
    // v1.1.22：头部右侧「Debug/版本」按钮——展开 Debug 小节（版本号 + Debug 开关）
    // 图标：单色「调节滑块」SVG（方案 A，用户选定）——随 currentColor；原 emoji 扳手
    // 跨平台字形/配色不一，已弃用
    // 移除右上角 × 关闭按钮：面板仍可经浮动齿轮按钮（再次点击）/ 点击面板外部 /
    // 油猴菜单「打开设置面板」三种方式关闭（closeSettings 保留）
    const headRight = makeEl('div', 'display:flex;align-items:center;gap:10px');
    const dbgGear = makeEl('span', 'cursor:pointer;display:inline-flex;align-items:center;color:#536471;padding:0 2px', null);
    dbgGear.innerHTML = ICON.tune;
    dbgGear.title = 'Debug / 版本';
    dbgGear.addEventListener('click', () => { toggleDebugSection(panel); });
    headRight.appendChild(dbgGear);
    head.appendChild(headRight);
    panel.appendChild(head);

    // 状态行
    const statusEl = makeEl('div', 'margin:8px 14px 0;padding:7px 9px;border-radius:8px;font-size:12px;line-height:1.5;word-break:break-all');
    statusEl.id = 'ig-panel-status';
    panel.appendChild(statusEl);

    // 可调配置项
    const body = makeEl('div', 'padding:6px 0 2px');
    for (const t of TUNABLE) {
      const row = makeEl('div', 'display:flex;align-items:center;justify-content:space-between;padding:6px 14px');
      // v1.1.20/v1.1.30：高级参数（视频打包阈值 / ZIP 分卷阈值）仅 debug 模式显示——
      // 始终创建行但用 data-debugonly 标记 + display 控制，使 Debug 开关可即时显示/隐藏（无需重开面板）
      if (t.debugOnly) {
        row.setAttribute('data-debugonly', '1');
        if (!debugMode) row.style.display = 'none';
      }
      row.appendChild(makeEl('span', 'font-size:13px;color:#0f1419', t.label));
      const right = makeEl('div', 'display:flex;align-items:center');
      if (t.type === 'select') {
        const sel = document.createElement('select');
        sel.style.cssText = 'width:132px;border:0.5px solid #cfd9de;border-radius:6px;padding:3px 4px;font-size:12px;color:#0f1419;outline:none;box-sizing:border-box;background:#fff';
        for (const o of t.options) {
          const opt = document.createElement('option');
          opt.value = o.v;
          opt.textContent = o.t;
          sel.appendChild(opt);
        }
        sel.value = CONFIG[t.key];
        sel.addEventListener('change', () => {
          CONFIG[t.key] = sel.value;
          saveUserConfig();
          log(`配置已更新：${t.label} = ${sel.value}`);
        });
        right.appendChild(sel);
      } else {
        const input = document.createElement('input');
        input.type = 'number';
        input.min = String(t.min);
        input.max = String(t.max);
        input.step = String(t.step);
        input.value = String(Math.round(CONFIG[t.key] / t.scale));
        input.style.cssText = 'width:80px;appearance:textfield;-moz-appearance:textfield;text-align:right;border:0.5px solid #cfd9de;border-radius:6px;padding:3px 6px;font-size:13px;color:#0f1419;outline:none;box-sizing:border-box;background:#fff';
        input.addEventListener('change', () => {
          let v = Number(input.value);
          if (!Number.isFinite(v)) v = CONFIG[t.key] / t.scale;
          v = Math.min(t.max, Math.max(t.min, v));
          input.value = String(Math.round(v));
          CONFIG[t.key] = Math.round(v * t.scale);
          saveUserConfig();
          log(`配置已更新：${t.label} = ${Math.round(v)}${t.unit}`);
        });
        right.appendChild(input);
        right.appendChild(makeEl('span', 'margin-left:6px;font-size:12px;color:#536471;width:30px;white-space:nowrap', t.unit));
      }
      row.appendChild(right);
      body.appendChild(row);
    }
    // Round 9：自动巡览帖子开关（自动打开帖子 → 采集 → 自动切下一帖 → 末页停止）
    {
      const row = makeEl('div', 'display:flex;align-items:center;justify-content:space-between;padding:6px 14px');
      row.appendChild(makeEl('span', 'font-size:13px;color:#0f1419', '自动巡览帖子'));
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!CONFIG.AUTO_TOUR;
      cb.style.cssText = 'width:18px;height:18px;cursor:pointer';
      cb.addEventListener('change', () => { CONFIG.AUTO_TOUR = cb.checked; saveUserConfig(); log('配置已更新：自动巡览 = ' + cb.checked + (cb.checked ? '（下次开始采集时自动打开帖子并逐帖切换）' : '')); });
      row.appendChild(cb);
      body.appendChild(row);
      const tip = makeEl('div', 'padding:0 14px 6px;font-size:11px;color:#536471', '开启后：网格页自动点开首帖 → 详情页采集完自动切下一帖 → 翻到末页自动停止并保存');
      body.appendChild(tip);
    }
    panel.appendChild(body);

    // 历史记录区
    const foot = makeEl('div', 'padding:10px 14px 0;margin-top:6px;border-top:0.5px solid rgba(15,20,25,0.08)');
    foot.id = PANEL_ID + '-foot'; // v1.1.29：供 Debug 开关即时增删导出诊断按钮定位
    const histRow = makeEl('div', 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px');
    histRow.appendChild(makeEl('span', 'font-size:13px;color:#0f1419', '已保存记录'));
    const histCount = makeEl('span', 'font-size:13px;color:#536471', `${savedMediaKeys.size} 条`);
    histRow.appendChild(histCount);
    foot.appendChild(histRow);

    const btnCss = 'width:100%;padding:7px 0;margin-top:6px;border-radius:9999px;font-size:13px;font-weight:500;cursor:pointer;border:0.5px solid;text-align:center;box-sizing:border-box;background:#fff';
    const clearBtn = makeEl('div', btnCss + ';color:#f4212e;border-color:rgba(244,33,46,0.4)', '清除历史记录');
    clearBtn.addEventListener('click', () => {
      if (!confirm(`确定清除全部 ${savedMediaKeys.size} 条已保存记录？\n\n清除后，下次采集会重新记录所有媒体。`)) return;
      savedMediaKeys.clear();
      try { GM_setValue('savedMediaKeys', '[]'); } catch (e) {}
      try { GM_notification({ title: 'Instagram 媒体保存', text: '已清除历史记录，下次采集将包含所有媒体' }); } catch (e) {}
      log('已清除历史保存记录');
      histCount.textContent = '0 条';
    });
    foot.appendChild(clearBtn);

    const resetBtn = makeEl('div', btnCss + ';color:#536471;border-color:#cfd9de', '恢复默认设置');
    resetBtn.addEventListener('click', () => {
      if (!confirm('确定恢复默认设置？')) return;
      for (const t of TUNABLE) CONFIG[t.key] = CONFIG_DEFAULTS[t.key];
      // v1.1.13：布尔开关一并恢复默认
      for (const k of BOOL_KEYS) CONFIG[k] = CONFIG_DEFAULTS[k];
      saveUserConfig();
      buildSettingsPanel();
      log('已恢复默认设置');
    });
    foot.appendChild(resetBtn);

    const resumeResetBtn = makeEl('div', btnCss + ';color:#0f1419;border-color:#cfd9de', '清除断点进度');
    resumeResetBtn.addEventListener('click', () => {
      if (!confirm('确定清除断点进度（已处理短码 / 游标 / 失败重试项）？\n\n清除后下次采集将从零开始。')) return;
      processedShortcodes = new Set();
      resumeState = freshResumeState();
      state.cursor = null;
      saveResumeState();
      log('已清除断点进度');
      buildSettingsPanel();
    });
    foot.appendChild(resumeResetBtn);

    // v1.1.27/v1.1.28/v1.1.29：导出诊断按钮——仅 Debug 模式开启时显示（默认隐藏）；
    // buildSettingsPanel 按当前 debugMode 渲染；Debug 开关即时增删（syncDiagButton）
    if (debugMode) {
      const diagBtn = makeEl('div', btnCss + ';color:#0f1419;border-color:#cfd9de', '📤 导出诊断JSON');
      diagBtn.id = PANEL_ID + '-diag';
      diagBtn.addEventListener('click', () => { exportDiagnostic(); });
      foot.appendChild(diagBtn);
    }

    panel.appendChild(foot);

    document.body.appendChild(panel);
    state.settingsOpen = true;
    updatePanel();
    setTimeout(() => document.addEventListener('mousedown', onPanelOutsideClick, true), 0);
  }

  // Round 6：导出诊断 JSON（本地 Blob 下载，无需联网/@connect）。
  // 打包已捕获的原始帖子节点 + 内嵌 script JSON 文本样本，供离线精修抓取逻辑
  // （尤其二层嵌套媒体 / 主页多图 / 完整视频）。
  function exportDiagnostic() {
    try {
      const captured = [];
      for (const [sc, node] of state.diagNodes) captured.push({ shortcode: sc, node });
      const payload = {
        exportedAt: new Date().toISOString(),
        note: '将本文件内容粘贴给开发者，用于精修 Instagram 抓取逻辑（二层嵌套媒体 / 主页多图 / 完整视频）。',
        capturedPostNodes: captured,
        embeddedScriptSamples: state.diagEmbedded.slice(),
        rawCaptures: state.diagRaw.slice(),
        currentUrl: (typeof location !== 'undefined' ? location.href : null),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ig-diagnostic-' + Date.now() + '.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { try { document.body.removeChild(a); URL.revokeObjectURL(url); } catch (e) {} }, 1000);
      log('诊断 JSON 已导出（' + captured.length + ' 帖节点 + ' + payload.embeddedScriptSamples.length + ' 段内嵌 JSON）');
      try { if (typeof GM_notification === 'function') GM_notification({ title: 'Instagram 媒体保存', text: '诊断 JSON 已导出，可粘贴给开发者精修' }); } catch (e) {}
    } catch (e) {
      log('诊断导出失败：' + (e && e.message));
    }
  }

  // v1.1.22：油猴菜单平铺命令（不再用父子菜单）——Debug 开关 / 导出诊断 / 打开设置
  function toggleDebugMode() {
    debugMode = !debugMode;
    try { GM_setValue('igDebugMode', debugMode); } catch (e) {}
    log('Debug 模式：' + (debugMode ? '已开启（诊断按钮/高级参数可用）' : '已关闭'));
    try {
      GM_notification({ title: 'Instagram 媒体保存', text: 'Debug 模式：' + (debugMode ? '已开启' : '已关闭') + '（重新打开设置面板生效）' });
    } catch (e) {}
  }
  function openSettingsFromMenu() {
    if (state.settingsOpen) closeSettings();
    else buildSettingsPanel();
  }
  if (typeof GM_registerMenuCommand === 'function') {
    try {
      GM_registerMenuCommand('🐞 Debug 模式：' + (debugMode ? '开（点击关闭）' : '关（点击开启）'), toggleDebugMode);
      GM_registerMenuCommand('📤 导出诊断 JSON', exportDiagnostic);
      GM_registerMenuCommand('⚙️ 打开设置面板', openSettingsFromMenu);
      log('已注册油猴菜单命令');
    } catch (e) {}
  }

  function createButton() {
    if (state.btnEl && document.body.contains(state.btnEl)) return;

    const container = document.createElement('div');
    container.id = 'ig-media-saver-container';
    container.style.cssText = [
      'position: fixed',
      `bottom: ${CONFIG.BUTTON_POSITION.bottom}`,
      `right: ${CONFIG.BUTTON_POSITION.right}`,
      `z-index: ${CONFIG.BUTTON_Z_INDEX}`,
      'display: flex',
      'align-items: center',
      'gap: 8px',
      'pointer-events: none',
    ].join('; ');

    const gear = document.createElement('div');
    gear.id = GEAR_ID;
    gear.innerHTML = ICON.gear;
    gear.title = '更多选项（设置 / 清除历史记录）';
    gear.style.cssText = [
      'width: 32px', 'height: 32px', 'border-radius: 50%',
      'background: #fff', 'color: #536471',
      'display: flex', 'align-items: center', 'justify-content: center',
      'cursor: pointer', 'border: 0.5px solid rgba(15,20,25,0.08)',
      'box-shadow: rgba(101,119,134,0.2) 0px 0px 10px, rgba(101,119,134,0.15) 0px 0px 2px 1px',
      'transition: all 0.15s ease', 'pointer-events: auto', 'user-select: none',
    ].join('; ');
    gear.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.settingsOpen) closeSettings();
      else buildSettingsPanel();
    });

    const btn = document.createElement('div');
    btn.id = 'ig-media-saver-btn';
    btn.innerHTML = ICON.camera + '<span>开始采集</span>';
    btn.style.cssText = [
      'height: 34px', 'padding: 0 15px',
      'background: linear-gradient(45deg, #f58529, #dd2a7b, #8134af)',
      'color: #fff',
      'border-radius: 9999px', 'font-size: 14px', 'font-weight: 500',
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif',
      'cursor: pointer', 'border: 0.5px solid rgba(15,20,25,0.08)',
      'box-shadow: rgba(101,119,134,0.2) 0px 0px 10px, rgba(101,119,134,0.15) 0px 0px 2px 1px',
      'user-select: none', 'transition: all 0.15s ease',
      'display: flex', 'align-items: center', 'gap: 5px',
      'pointer-events: auto',
    ].join('; ');
    btn.addEventListener('click', onButtonClick);

    container.appendChild(gear);
    container.appendChild(btn);
    document.body.appendChild(container);
    state.btnEl = btn;
  }

  function updateButton() {
    if (!state.btnEl) return;
    const btn = state.btnEl;
    if (state.saving || btn.dataset.busy === 'true') {
      btn.innerHTML = ICON.save + '<span>打包中…</span>';
      btn.style.cursor = 'not-allowed';
    } else if (state.fuse) {
      btn.innerHTML = ICON.stop + '<span>⚠ 已熔断（点击继续）</span>';
      btn.style.background = '#f4212e';
      btn.style.cursor = 'pointer';
    } else if (state.connectBlocked) {
      btn.innerHTML = ICON.stop + '<span>⚠ CDN 被拦截（点击重试）</span>';
      btn.style.background = '#dc2626';
      btn.style.cursor = 'pointer';
    } else if (state.budgetPaused) {
      btn.innerHTML = ICON.stop + '<span>⏸ 预算暂停（点击恢复）</span>';
      btn.style.background = '#f59e0b';
      btn.style.cursor = 'pointer';
    } else if (state.isRecording) {
      const count = state.media.size;
      btn.innerHTML = count >= mediaHardLimit()
        ? ICON.stop + '<span>已满 ' + count + '</span>'
        : ICON.stop + '<span>采集中 ' + count + '</span>';
      btn.style.background = 'linear-gradient(45deg, #f58529, #dd2a7b, #8134af)';
      btn.style.cursor = 'pointer';
    } else {
      btn.innerHTML = ICON.camera + '<span>开始采集</span>';
      btn.style.background = 'linear-gradient(45deg, #f58529, #dd2a7b, #8134af)';
      btn.style.cursor = 'pointer';
    }
  }

  function updateButtonProgress(done, total) {
    if (!state.btnEl) return;
    state.btnEl.innerHTML = ICON.save + '<span>下载 ' + done + '/' + total + '</span>';
  }

  function updateButtonStage(text) {
    if (!state.btnEl) return;
    state.btnEl.innerHTML = ICON.save + '<span>' + text + '</span>';
  }

  async function onButtonClick() {
    if (state.btnEl && state.btnEl.dataset.busy === 'true') return;
    if (state.fuse) { clearFuse(); return; }
    if (state.budgetPaused) { clearBudgetPause(); return; }
    if (!state.isRecording) {
      startRecording();
    } else {
      await stopAndSave(false);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // ▶️ 开始采集（含断点续抓）
  // ════════════════════════════════════════════════════════════════

  // 把上次下载失败的项恢复到本次采集队列（跳过已保存/已在队列的）
  function restoreFailedItems() {
    let restored = 0;
    if (Array.isArray(resumeState.failedItems) && resumeState.failedItems.length) {
      for (const f of resumeState.failedItems) {
        if (!f || !f.key || !f.url) continue;
        if (state.media.has(f.key) || savedMediaKeys.has(f.key)) continue;
        state.media.set(f.key, f);
        restored++;
      }
    }
    return restored;
  }

  function startRecording() {
    state.isRecording = true;
    state.fuse = null;
    state.budgetPaused = false;
    // Round 4 (v1.1.1)：重新开始采集时清除 @connect 拦截引导标记（点击重试入口）
    state.connectBlocked = false;
    budget.paused = false;
    clearAllMarks();

    if (hasPendingResume && resumeState) {
      // 断点续抓（脚本重启/刷新后）：恢复已处理短码、游标、失败重试项
      processedShortcodes = new Set(resumeState.processedShortcodes || []);
      state.cursor = resumeState.cursor || null;
      const restored = restoreFailedItems();
      log(`断点续抓：已处理 ${processedShortcodes.size} 帖，游标 ${state.cursor || '无'}，恢复失败重试 ${restored} 项`);
      try {
        GM_notification({ title: 'Instagram 媒体保存', text: `断点续抓：已处理 ${processedShortcodes.size} 帖，从上次位置继续` });
      } catch (e) {}
      hasPendingResume = false;
    } else {
      // 同页重新开始（P2-10）：保留断点进度（live processedShortcodes 即最新，仅同步快照），
      // 仅清空本次缓存；除非用户在设置面板显式"清除断点进度"
      state.media.clear();
      state.mediaBaseKey.clear(); // v1.1.17：URL 去重映射同步清空
      state.postMeta.clear();
      state.cursor = resumeState.cursor || null;
      resumeState.startedAt = Date.now();
      resumeState.processedShortcodes = Array.from(processedShortcodes).slice(-CONFIG.PROCESSED_MAX);
      const restored = restoreFailedItems();
      saveResumeState();
      log(`开始采集媒体...（保留断点进度：已处理 ${processedShortcodes.size} 帖，恢复失败重试 ${restored} 项）`);
    }
    clickedShortcodes.clear();

    // Round 9/v1.1.9：自动巡览（默认关，面板开关）。非巡览模式不自动导航——
    // 用户手动浏览（滚动/点帖）由 MutationObserver + discoverMedia 自动采集。
    // v1.1.12：巡览模式先启动（门控 active/gate 生效）再 discoverMedia——
    // 否则 discoverMedia 在 startAutoTour 之前执行时 tour.active=false，门控拦不住网格瓦片。
    if (CONFIG.AUTO_TOUR) {
      startAutoTour();
    }
    discoverMedia();
    startObserver();
    startIdleWatch();
    updateButton();
    checkAutoSave();
    updatePanel();
  }

  // ════════════════════════════════════════════════════════════════
  // ⏹ 停止并保存
  // ════════════════════════════════════════════════════════════════

  async function stopAndSave(isAuto) {
    if (state.saving) return;
    state.saving = true;

    state.isRecording = false;
    stopObserver();
    stopAutoTour();
    stopIdleWatch();
    saveResumeState();

    log(`记录停止，共记录 ${state.media.size} 个媒体`);

    if (state.btnEl) state.btnEl.dataset.busy = 'true';
    updateButton();

    const allMedia = Array.from(state.media.values()).slice(0, mediaHardLimit());

    if (allMedia.length === 0) {
      log('没有媒体可保存');
      if (state.btnEl) state.btnEl.dataset.busy = '';
      state.saving = false;
      state.autoSaving = false;
      updateButton();
      try { GM_notification({ title: 'Instagram 媒体保存', text: '没有记录到任何媒体' }); } catch (e) {}
      return;
    }

    // 小文件过滤
    const { filtered, skipped } = await filterSmallFiles(allMedia);

    // 打包下载（Round 3：始终一次性 ZIP 打包）
    const result = await downloadAsZip(filtered);
    const saved = result.saved;
    const failed = result.failed;

    // 保存成功的媒体标记为已保存（下次自动跳过）
    markSaved(result.savedKeys || []);

    // 失败项记入断点状态，续抓时自动重试
    resumeState.failedItems = (result.failedItems || []).slice(0, 500);
    saveResumeState();

    const totalSkipped = skipped + failed + (result.filteredOut || 0);
    log(`全部完成！共下载 ${saved} 个媒体，跳过 ${totalSkipped} 个（小文件预筛 ${skipped} / 下载复核 ${result.filteredOut || 0} / 失败 ${failed}）`);

    try {
      GM_notification({
        title: 'Instagram 媒体保存',
        text: `保存完成！共下载 ${saved} 个媒体，跳过 ${totalSkipped} 个（小文件/失败）`,
      });
    } catch (e) {}

    if (state.btnEl) state.btnEl.dataset.busy = '';
    state.saving = false;
    state.autoSaving = false;
    updateButton();
    updatePanel();
    log('保存流程结束。可点击按钮开始新一轮采集。');
  }

  // ════════════════════════════════════════════════════════════════
  // 🚀 初始化
  // ════════════════════════════════════════════════════════════════

  function init() {
    try {
      createButton();
      installHooks();
    } catch (e) {
      log('初始化失败:', e);
    }
  }

  // 尽早安装 hook（document-start），首屏内嵌 JSON 不能漏
  try { installHooks(); } catch (e) { log('hook 预安装失败:', e); }

  const bootUI = () => {
    try {
      createButton();
      installHooks();
      if (hasPendingResume && resumeState) {
        try {
          GM_notification({
            title: 'Instagram 媒体保存',
            text: `发现上次采集进度（已处理 ${resumeState.processedShortcodes.length} 帖），点击「开始采集」将断点续抓`,
          });
        } catch (e) {}
        log(`发现上次采集进度：${resumeState.processedShortcodes.length} 帖，点击「开始采集」将断点续抓`);
      }
    } catch (e) {
      log('UI 初始化失败:', e);
    }
  };
  if (document.readyState === 'complete') {
    setTimeout(bootUI, 300);
  } else if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', () => setTimeout(bootUI, 300));
  } else {
    window.addEventListener('load', () => setTimeout(bootUI, 300));
  }

  // SPA 路由变化
  let lastUrl = window.location.href;
  const attachUrlObserver = () => {
    if (!document.body) return false;
    const urlObserver = new MutationObserver(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        clickedShortcodes.clear();
        pendingVideoUrls.clear();
        setTimeout(() => {
          if (!state.btnEl || !document.body.contains(state.btnEl)) init();
          if (state.isRecording) { try { discoverMedia(); } catch (e) {} }
        }, 1000);
      }
    });
    urlObserver.observe(document.body, { childList: true, subtree: true });
    return true;
  };
  if (!attachUrlObserver()) {
    const waitBody = setInterval(() => {
      if (attachUrlObserver()) clearInterval(waitBody);
    }, 200);
    setTimeout(() => clearInterval(waitBody), 30000);
  }

  log('脚本 v1.1.1 已加载，捕获 hook 已就位...');
})();
