// ==UserScript==
// @name         Twitter/X 媒体批量保存器
// @namespace    https://github.com/Eiranya/Tampermonkey-JS
// @version      1.3.1
// @description  在 Twitter/X 用户主页一键记录并批量保存图片和视频（打包 ZIP），支持去重、已保存记忆、无效视频过滤、小文件过滤、自动滚动、推文标记、满量自动保存、可视化设置面板、视频日期自动还原
// @author       QClaw / Eiranya
// @updateURL    https://raw.githubusercontent.com/Eiranya/Tampermonkey-JS/main/twitter-image-saver.user.js
// @downloadURL  https://raw.githubusercontent.com/Eiranya/Tampermonkey-JS/main/twitter-image-saver.user.js
// @match        https://twitter.com/*
// @match        https://x.com/*
// @grant        GM_download
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_info
// @connect      pbs.twimg.com
// @connect      video.twimg.com
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
  // note: your browser will automatically convert UTF-16 U+FEFF to EF BB BF
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
// We just need to check for 'Safari' because all other browsers (besides Firefox) include that too
// https://www.whatismybrowser.com/guides/the-latest-user-agent/macos
var isMacOSWebView = _global.navigator && /Macintosh/.test(navigator.userAgent) && /AppleWebKit/.test(navigator.userAgent) && !/Safari/.test(navigator.userAgent)

var saveAs = _global.saveAs || (
  // probably in some web worker
  (typeof window !== 'object' || window !== _global)
    ? function saveAs () { /* noop */ }

  // Use download attribute first if possible (#193 Lumia mobile) unless this is a macOS WebView
  : ('download' in HTMLAnchorElement.prototype && !isMacOSWebView)
  ? function saveAs (blob, name, opts) {
    var URL = _global.URL || _global.webkitURL
    // Namespace is used to prevent conflict w/ Chrome Poper Blocker extension (Issue #561)
    var a = document.createElementNS('http://www.w3.org/1999/xhtml', 'a')
    name = name || blob.name || 'download'

    a.download = name
    a.rel = 'noopener' // tabnabbing

    // TODO: detect chrome extensions & packaged apps
    // a.target = '_blank'

    if (typeof blob === 'string') {
      // Support regular links
      a.href = blob
      if (a.origin !== location.origin) {
        corsEnabled(a.href)
          ? download(blob, name, opts)
          : click(a, a.target = '_blank')
      } else {
        click(a)
      }
    } else {
      // Support blobs
      a.href = URL.createObjectURL(blob)
      setTimeout(function () { URL.revokeObjectURL(a.href) }, 4E4) // 40s
      setTimeout(function () { click(a) }, 0)
    }
  }

  // Use msSaveOrOpenBlob as a second approach
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

  // Fallback to using FileReader and a popup
  : function saveAs (blob, name, opts, popup) {
    // Open a popup immediately do go around popup blocker
    // Mostly only available on user interaction and the fileReader is async so...
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
      // Safari doesn't allow downloading of blob URLs
      var reader = new FileReader()
      reader.onloadend = function () {
        var url = reader.result
        url = isChromeIOS ? url : url.replace(/^data:[^;]*;/, 'data:attachment/file;')
        if (popup) popup.location.href = url
        else location = url
        popup = null // reverse-tabnabbing #460
      }
      reader.readAsDataURL(blob)
    } else {
      var URL = _global.URL || _global.webkitURL
      var url = URL.createObjectURL(blob)
      if (popup) popup.location = url
      else location.href = url
      popup = null // reverse-tabnabbing #460
      setTimeout(function () { URL.revokeObjectURL(url) }, 4E4) // 40s
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
    console.log('[Twitter媒体保存] 已启用 MV3 GM_xhr 并行修复');
  } catch (e) {
    console.warn('[Twitter媒体保存] MV3 修复安装失败:', e);
  }
})();

(function () {
  'use strict';

  // ════════════════════════════════════════════════════════════════
  // 📌 配置区
  // ════════════════════════════════════════════════════════════════
  // 可在设置面板里调整的配置项（内部单位：字节 / 毫秒）
  const CONFIG_DEFAULTS = Object.freeze({
    // 图片小文件过滤阈值（字节）
    MIN_FILE_SIZE: 50 * 1024,
    // 视频最小有效大小（字节），用于过滤无效/损坏的小视频
    // v1.2：100KB → 20KB。原阈值把大量正常的短视频/低码率视频误判成"损坏小视频"丢掉，
    // 而且 HEAD 拿到 403 时错误响应体的 content-length 也远小于 100KB，会被一并误杀。
    MIN_VIDEO_SIZE: 20 * 1024,
    // 缓存容量上限（图片+视频），达到后自动保存
    MAX_MEDIA: 200,
    // 每个 ZIP 打包的媒体数量上限（避免单 zip 内存爆炸）
    BATCH_SIZE: 150,
    // 拉取 Blob 并发数
    DOWNLOAD_CONCURRENCY: 3,
    // 自动滚动间隔（毫秒，基准值；实际间隔会加随机抖动）
    SCROLL_INTERVAL_MS: 2000,
    // 视频文件名日期来源：'tweet' = 推文时间优先（拿不到再退回视频 ID）
    //                   'snowflake' = 视频 ID 的 Snowflake 时间优先
    VIDEO_DATE_SOURCE: 'tweet',
  });

  // 设置面板的字段描述：scale = 显示单位 → 内部单位的换算
  const TUNABLE = [
    { key: 'MIN_FILE_SIZE',        label: '图片最小体积', unit: 'KB', scale: 1024, min: 0,    max: 5120,  step: 5 },
    { key: 'MIN_VIDEO_SIZE',       label: '视频最小体积', unit: 'KB', scale: 1024, min: 0,    max: 10240, step: 10 },
    { key: 'MAX_MEDIA',            label: '满量自动保存', unit: '个', scale: 1,    min: 10,   max: 1000,  step: 10 },
    { key: 'BATCH_SIZE',           label: '每包数量',     unit: '个', scale: 1,    min: 10,   max: 500,   step: 10 },
    { key: 'DOWNLOAD_CONCURRENCY', label: '下载并发',     unit: '路', scale: 1,    min: 1,    max: 10,    step: 1 },
    { key: 'SCROLL_INTERVAL_MS',   label: '滚动间隔',     unit: 'ms', scale: 1,    min: 500,  max: 10000, step: 250 },
    { key: 'VIDEO_DATE_SOURCE', label: '视频日期', type: 'select', options: [
      { v: 'tweet',     t: '推文时间优先' },
      { v: 'snowflake', t: '视频ID优先' },
    ] },
  ];

  const CONFIG = {
    ...CONFIG_DEFAULTS,
    // HEAD 请求并发数
    HEAD_CONCURRENCY: 5,
    // 自动滚动间隔随机抖动范围（±毫秒）
    SCROLL_INTERVAL_JITTER_MS: 800,
    // 滚动距离范围（像素）
    SCROLL_MIN_PX: 800,
    SCROLL_MAX_PX: 1200,
    // 按钮位置
    BUTTON_POSITION: { bottom: '24px', right: '24px' },
    BUTTON_Z_INDEX: 999999,
  };

  const CONFIG_STORE_KEY = 'twSaverConfig';

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
  }
  loadUserConfig();

  function saveUserConfig() {
    const out = {};
    for (const t of TUNABLE) out[t.key] = CONFIG[t.key];
    try { GM_setValue(CONFIG_STORE_KEY, JSON.stringify(out)); } catch (e) { log('保存配置失败:', e); }
  }

  // ════════════════════════════════════════════════════════════════
  // 📦 状态管理
  // ════════════════════════════════════════════════════════════════
  const state = {
    isRecording: false,
    saving: false,
    autoSaving: false,
    // 已记录媒体 Map：key = baseUrl, value = { url, type, tweetTime, tweetUrl }
    media: new Map(),
    observer: null,
    scrollTimer: null,
    btnEl: null,
    hookInstalled: false,
    settingsOpen: false,
  };

  // 视频直链缓存：key = videoId, value = 最高清 mp4 URL
  const videoCandidates = new Map();

  // 推文创建时间缓存：key = videoId, value = ISO 时间字符串
  // 从 GraphQL 响应里提取，recordVideo 时用于视频日期兜底
  const tweetCreatedAtCache = new Map();

  // 已保存媒体去重集合（持久化，避免重新记录已保存过的图片/视频）
  let _savedRaw = [];
  try { _savedRaw = JSON.parse(GM_getValue('savedMediaKeys', '[]') || '[]'); } catch (e) {}
  const savedMediaKeys = new Set(_savedRaw);
  const SAVED_KEYS_MAX = 5000;

  // 计算媒体去重 key（图片用去 name 参数的 baseUrl，视频用 video:<id>）
  function getMediaKey(item) {
    if (item.type === 'video') {
      const id = extractVideoId(item.url);
      return id ? `video:${id}` : getBaseUrl(item.url);
    }
    return getBaseUrl(item.url);
  }

  // 保存成功后标记为已保存并持久化
  function markSaved(keys) {
    for (const k of keys) savedMediaKeys.add(k);
    try {
      const arr = Array.from(savedMediaKeys).slice(-SAVED_KEYS_MAX);
      GM_setValue('savedMediaKeys', JSON.stringify(arr));
    } catch (e) {
      log('持久化已保存列表失败:', e);
    }
  }

  const MARK_CLASS = 'tw-media-saver-mark';
  const articleMarkCache = new WeakMap();

  // ════════════════════════════════════════════════════════════════
  // 🛠 工具函数
  // ════════════════════════════════════════════════════════════════

  function log(msg, ...args) {
    console.log(`[Twitter媒体保存] ${msg}`, ...args);
  }

  function toHighResUrl(url) {
    try {
      const u = new URL(url);
      if (u.hostname !== 'pbs.twimg.com') return url;
      u.searchParams.set('name', 'large');
      return u.toString();
    } catch (e) {
      return url.replace(/([?&]name=)([^&]+)/, '$1large');
    }
  }

  function getBaseUrl(url) {
    try {
      const u = new URL(url);
      if (u.hostname === 'pbs.twimg.com') {
        const format = u.searchParams.get('format') || 'jpg';
        return `${u.origin}${u.pathname}?format=${format}`;
      }
      if (u.hostname === 'video.twimg.com') {
        const id = extractVideoId(url);
        if (id) return `video:${id}`;
        return `video:${u.pathname}`;
      }
      return `${u.origin}${u.pathname}`;
    } catch (e) {
      return url.replace(/([?&]name=)([^&]+)/, '');
    }
  }

  /**
   * 从视频 URL 提取 videoId（兼容 ext_tw_video / amplify_video / tweet_video）
   */
  function extractVideoId(url) {
    const s = String(url);
    let m = s.match(/ext_tw_video\/([^/]+)/);
    if (m) return m[1];
    m = s.match(/amplify_video\/([^/]+)/);
    if (m) return m[1];
    m = s.match(/tweet_video\/([^/]+)/);
    if (m) return m[1];
    return null;
  }

  // 视频缩略图路径 → videoId（ext_tw_video_thumb / amplify_video_thumb / tweet_video_thumb）
  const THUMB_ID_RE = /(?:ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\/([^/?#]+)/;

  function extractThumbId(s) {
    const m = String(s).match(THUMB_ID_RE);
    return m ? m[1] : null;
  }

  /**
   * 从 video 元素提取 videoId
   * v1.2 补的两类漏判：
   *  - 推文用了自定义封面时，poster 是 pbs.twimg.com/media/xxx，没有 _video_thumb 段
   *  - 视频开始播放后 src 会变成 blob: URL，此时只能靠 poster 或容器里的缩略图
   */
  function getVideoIdFromElement(v) {
    // 1) poster（最常见）
    const poster = v.getAttribute('poster') || v.poster || '';
    if (poster) {
      const id = extractThumbId(poster) || extractVideoId(poster);
      if (id) return id;
    }
    // 2) src / currentSrc
    const src = v.src || v.getAttribute('src') || v.currentSrc || '';
    if (src) {
      if (String(src).includes('video.twimg.com')) {
        const id = extractVideoId(src);
        if (id) return id;
      }
      const id = extractThumbId(src);
      if (id) return id;
    }
    // 3) 兜底：向上找容器里的视频缩略图 img
    let node = v.parentElement;
    for (let i = 0; i < 8 && node; i++) {
      const img = node.querySelector && node.querySelector('img[src*="_video_thumb"]');
      if (img) {
        const id = extractThumbId(img.getAttribute('src') || img.src || '');
        if (id) return id;
      }
      node = node.parentElement;
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // Twitter Snowflake ID 解码（用于单推文页等找不到 time 元素的场景）
  // Twitter epoch: 1288834974657ms（2010-11-04 01:42:54.657 UTC）
  // 格式：|timestamp(42bits)|machine(10bits)|sequence(12bits)
  // ═══════════════════════════════════════════════════════════════
  function decodeSnowflakeTime(snowflakeId) {
    try {
      // 只有纯数字的 ID 才是 Snowflake。amplify_video 的 ID 可能含字母
      // （如 18665094345456w6944），GIF 的 tweet_video ID 是 base62 字符串，
      // 这类 BigInt() 解不出有意义的时间，直接判 null。
      if (typeof snowflakeId === 'string' && !/^\d{15,25}$/.test(snowflakeId)) return null;
      const id = BigInt(snowflakeId);
      const TWITTER_EPOCH = 1288834974657n;
      const timestampMs = (id >> 22n) + TWITTER_EPOCH;
      const date = new Date(Number(timestampMs));
      // 合理性校验：Twitter 2006-03-21 上线，不可能出现更早或未来的时间
      if (date.getTime() < Date.UTC(2006, 2, 21)) return null;
      if (date.getTime() > Date.now() + 86400000) return null;
      return date;
    } catch (e) {
      return null;
    }
  }

  /**
   * 视频文件名用的日期（YYYY-MM-DD）
   * 优先级：推文真实时间 → videoId 的 Snowflake 时间 → unknown
   * ext_tw_video/<19位数字> 里的 ID 就是 Snowflake，能还原视频上传时间。
   */
  function resolveVideoDateKey(m) {
    const fromTweet = () => (m.tweetTime ? formatDateOnly(m.tweetTime) : null);
    const fromSnowflake = () => {
      const vid = extractVideoId(m.url);
      if (!vid) return null;
      const dt = decodeSnowflakeTime(vid);
      return dt ? formatDateOnly(dt.toISOString()) : null;
    };
    const first = (CONFIG.VIDEO_DATE_SOURCE === 'snowflake') ? fromSnowflake : fromTweet;
    const second = (CONFIG.VIDEO_DATE_SOURCE === 'snowflake') ? fromTweet : fromSnowflake;
    let d = first();
    if (d && d !== 'nodate') return d;
    d = second();
    if (d && d !== 'nodate') return d;
    return 'unknown';
  }

  function getCurrentPageTweetId() {
    // 单推文页 URL 格式: https://x.com/user/status/1234567890123456789
    const match = location.pathname.match(/\/status\/(\d+)/);
    return match ? match[1] : null;
  }

  function getTweetTime(el) {
    // 遍历路径时收集 /status/ 链接，用于兜底解码 Snowflake ID
    const statusLinks = [];
    let node = el;
    // 深度 30：主页 timeline 的媒体元素嵌套很深，15 层可能不够
    for (let i = 0; i < 30; i++) {
      if (!node || !node.parentElement) break;
      node = node.parentElement;
      // 找 time 元素
      const timeEl = node.querySelector && node.querySelector('time');
      if (timeEl && timeEl.getAttribute('datetime')) return timeEl.getAttribute('datetime');
      // 收集 /status/ 链接
      if (node.querySelectorAll) {
        node.querySelectorAll('a[href*="/status/"]').forEach((link) => {
          const href = link.getAttribute('href') || '';
          const match = href.match(/\/status\/(\d+)/);
          if (match && !statusLinks.includes(match[1])) statusLinks.push(match[1]);
        });
      }
    }
    // 兜底 1：当前页面 URL 里的 Snowflake ID
    const pageTweetId = getCurrentPageTweetId();
    if (pageTweetId) {
      const date = decodeSnowflakeTime(pageTweetId);
      if (date) return date.toISOString();
    }
    // 兜底 2：从遍历中收集到的 status 链接解码（主页 timeline 场景）
    for (const id of statusLinks) {
      const date = decodeSnowflakeTime(id);
      if (date) return date.toISOString();
    }
    return null;
  }

  function getTweetUrl(el) {
    // 优先：DOM 向上查找 /status/ 链接
    let node = el;
    for (let i = 0; i < 15; i++) {
      if (!node || !node.parentElement) break;
      node = node.parentElement;
      const links = node.querySelectorAll('a[href*="/status/"]');
      for (const link of links) {
        const href = link.getAttribute('href');
        if (href) return href;
      }
    }
    // 兜底：当前页面是单推文页，直接用页面 URL
    const pageTweetId = getCurrentPageTweetId();
    if (pageTweetId) {
      return '/' + location.pathname.split('/status/')[0].replace(/^\//, '') + '/status/' + pageTweetId;
    }
    return null;
  }

  function formatTimeForFilename(isoString) {
    try {
      const d = new Date(isoString);
      if (isNaN(d.getTime())) return 'nodate';
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
             `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    } catch (e) {
      return 'nodate';
    }
  }

  // 只取日期部分，用于视频文件名
  function formatDateOnly(isoString) {
    try {
      const d = new Date(isoString);
      if (isNaN(d.getTime())) return 'nodate';
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    } catch (e) {
      return 'nodate';
    }
  }

  function getExtension(url) {
    try {
      const u = new URL(url);
      if (u.hostname === 'video.twimg.com') return 'mp4';
      const format = u.searchParams.get('format');
      if (format) return format;
    } catch (e) {}
    return 'jpg';
  }

  function formatSize(bytes) {
    if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
    if (bytes > 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${bytes}B`;
  }

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

  // ════════════════════════════════════════════════════════════════
  // 🎥 视频直链捕获 — hook JSON.parse 拦截 GraphQL 响应中的 variants
  // ════════════════════════════════════════════════════════════════

  /**
   * 从 GraphQL JSON 对象中递归扫描 video variants
   * Twitter 的响应里 video_info.variants 数组包含：
   *   { content_type: 'video/mp4', bitrate: ..., url: 'https://video.twimg.com/...' }
   */
  // 单次扫描节点预算，防止超大 GraphQL payload 把主线程卡死
  const SCAN_BUDGET = 200000;
  let scanBudget = SCAN_BUDGET;
  function resetScanBudget() { scanBudget = SCAN_BUDGET; }

  function scanForVideoVariants(obj, parentCreatedAt) {
    if (!obj || typeof obj !== 'object') return;
    if (scanBudget-- <= 0) return;
    if (Array.isArray(obj)) {
      for (const item of obj) scanForVideoVariants(item, parentCreatedAt);
      return;
    }
    // 尝试从当前节点提取 createdAt（Twitter GraphQL 里推文对象有 legacy.createdAt）
    let createdAt = parentCreatedAt || null;
    if (typeof obj.createdAt === 'string') createdAt = obj.createdAt;
    if (!createdAt && obj.legacy && typeof obj.legacy.createdAt === 'string') createdAt = obj.legacy.createdAt;

    for (const key in obj) {
      const val = obj[key];
      if (key === 'variants' && Array.isArray(val)) {
        handleVariants(val, createdAt);
      }
      if (val && typeof val === 'object') {
        scanForVideoVariants(val, createdAt);
      }
    }
  }

  // GraphQL 的时间有两种形态：ISO（createdAt）和 legacy 的
  // "Wed Aug 20 07:31:33 +0000 2025"，统一成 ISO 再存，避免后面 new Date() 解析失败
  function normalizeCreatedAt(createdAt) {
    if (!createdAt || typeof createdAt !== 'string') return null;
    const d = new Date(createdAt);
    if (isNaN(d.getTime())) return createdAt;
    return d.toISOString();
  }

  function handleVariants(variants, createdAt) {
    let best = null;      // 最高码率 mp4 直链
    let bestHls = null;   // m3u8：长视频 / amplify 只有 HLS，没有 mp4 variant

    for (const v of variants) {
      if (!v || !v.url) continue;
      const url = String(v.url);
      if (url.indexOf('video.twimg.com') === -1) continue;
      const ct = v.content_type || '';
      if (ct === 'video/mp4' || /\.mp4(\?|$)/i.test(url)) {
        const bitrate = v.bitrate || extractBitrate(url);
        if (!best || bitrate > best.bitrate) best = { url, bitrate };
      } else if (ct === 'application/x-mpegURL' || ct === 'application/vnd.apple.mpegurl' || /\.m3u8(\?|$)/i.test(url)) {
        if (!bestHls) bestHls = { url };
      }
    }
    // v1.2 关键修复：原实现只认 video/mp4，HLS-only 视频（content_type 只有
    // application/x-mpegURL）整条链路直接被丢弃 → "识别不到"。
    if (!best && !bestHls) return;

    const isHls = !best;
    const pick = best || bestHls;
    const videoId = extractVideoId(pick.url);
    if (!videoId) return;

    // v1.2：统一存 { url, bitrate, hls }。原实现拿"URL 分辨率乘积"和"真实码率"
    // 两种不同量纲比较（extractBitrate(prev) < best.bitrate），几乎必然覆盖，
    // 会用低码率链接顶掉高码率链接。
    const prev = videoCandidates.get(videoId);
    const pickBitrate = best ? best.bitrate : 0;
    if (!prev || prev.bitrate < pickBitrate) {
      videoCandidates.set(videoId, { url: pick.url, bitrate: pickBitrate, hls: isHls });
    }

    const iso = normalizeCreatedAt(createdAt);
    if (iso) tweetCreatedAtCache.set(videoId, iso);

    if (isHls) log(`捕获 HLS 视频（无 mp4 variant）:`, pick.url);
    else log(`捕获视频直链:`, pick.url);

    // 立即记录，不等 discoverMedia 关联
    recordVideo(pick.url, isHls);
  }

  /**
   * 在页面中查找包含指定 videoId 的视频元素，返回推文上下文
   */
  function findVideoContext(videoId) {
    const videos = document.querySelectorAll('article video');
    for (const v of videos) {
      if (getVideoIdFromElement(v) === videoId) {
        const article = findArticle(v);
        return { tweetTime: getTweetTime(v), tweetUrl: getTweetUrl(v), article };
      }
    }
    return { tweetTime: null, tweetUrl: null, article: null };
  }

  /**
   * 记录视频到 state.media（捕获到直链即调用）
   * 即使暂时匹配不到推文上下文也先记录，保证视频能保存
   */
  // 缓存已捕获的视频直链，即使用户还没点"开始记录"也先存着
  // v1.2：同时记住捕获时所在页面，避免跨用户/跨页面串号；加上限防内存膨胀
  const pendingVideos = new Map(); // videoId -> { url, page, hls }
  const PENDING_MAX = 800;

  function currentPageKey() {
    // 取 pathname 第一段（/user/...），SPA 切到 /status/xxx 时也能对上
    return location.pathname.split('/').filter(Boolean)[0] || '';
  }

  function recordVideo(mp4Url, isHls) {
    const videoId = extractVideoId(mp4Url);
    if (!videoId) return;

    // 无论是否在记录，都缓存直链
    if (pendingVideos.size >= PENDING_MAX) {
      pendingVideos.delete(pendingVideos.keys().next().value);
    }
    pendingVideos.set(videoId, { url: mp4Url, page: currentPageKey(), hls: !!isHls });
    log(`缓存视频直链${isHls ? '(HLS)' : ''}:`, mp4Url);

    if (!state.isRecording) return;
    if (state.media.size >= CONFIG.MAX_MEDIA) return;

    const baseUrl = `video:${videoId}`;
    if (state.media.has(baseUrl)) return;
    if (savedMediaKeys.has(baseUrl)) return; // 已保存过，跳过

    // 尝试从 DOM 匹配推文上下文
    const ctx = findVideoContext(videoId);
    // 兜底：从 GraphQL 响应缓存中取推文创建时间
    const createdAt = ctx.tweetTime || tweetCreatedAtCache.get(videoId) || null;

    state.media.set(baseUrl, {
      url: mp4Url,
      type: 'video',
      hls: !!isHls,
      tweetTime: createdAt,
      tweetUrl: ctx.tweetUrl,
    });

    log(`发现视频 #${state.media.size}:`, mp4Url, '时间:', createdAt);

    if (ctx.article) {
      setArticleMark(ctx.article, '🎬 已记录视频', 'rgba(147, 51, 234, 0.9)');
    }

    updateButton();
    checkAutoSave();
  }

  function extractBitrate(url) {
    // 无法从 URL 直接拿 bitrate，这里用分辨率近似
    const m = String(url).match(/(\d{2,4})x(\d{2,4})/);
    if (m) return parseInt(m[1], 10) * parseInt(m[2], 10);
    return 0;
  }

  function getPageWindow() {
    try {
      return (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    } catch (e) {
      return window;
    }
  }

  /**
   * 安装媒体捕获 hook（page context）
   *
   * v1.2 修的两个致命问题：
   * 1) 原实现把 `const w` 声明在第一个 try 块内，下面 fetch hook 里引用 w 会抛
   *    ReferenceError（严格模式），被 `catch (e) {}` 静默吞掉 → **fetch hook 从未生效**。
   *    主捕获通道因此只剩 JSON.parse hook。
   * 2) 只 hook JSON.parse 不够：X 的 GraphQL 大多是 `await response.json()`，
   *    这是 Blink 原生解析，不会调用页面上的 JSON.parse 函数 → 滚动加载的推文
   *    视频大面积漏抓。这里补上 Response.prototype.json / .text hook。
   */
  function installVideoHook() {
    if (state.hookInstalled) return;
    state.hookInstalled = true;

    const w = getPageWindow();                                  // ← 函数作用域，下面各 hook 共用
    const rawParse = (w.JSON && w.JSON.parse) || JSON.parse;    // 未被 hook 的原始解析器

    // ── 1) JSON.parse hook ─────────────────────────────────────────
    try {
      if (w.JSON && !w.JSON.__twMediaHooked) {
        const origParse = w.JSON.parse;
        w.JSON.__twMediaHooked = true;
        w.JSON.parse = function (text, reviver) {
          const obj = origParse.call(this, text, reviver);
          try {
            if (typeof text === 'string' && text.indexOf('video.twimg.com') !== -1) {
              resetScanBudget();
              scanForVideoVariants(obj);
            }
          } catch (e) {}
          return obj;
        };
        log('已安装 JSON.parse hook（视频直链捕获）');
      }
    } catch (e) {
      log('JSON.parse hook 安装失败:', e);
    }

    // ── 2) Response.prototype.json / .text hook（v1.2 新增，主捕获通道）──
    try {
      const RP = w.Response && w.Response.prototype;
      if (RP) {
        for (const method of ['json', 'text']) {
          if (typeof RP[method] !== 'function' || RP[method].__twMediaHooked) continue;
          const orig = RP[method];
          const hooked = (method === 'text')
            ? function () {
                return orig.apply(this, arguments).then((text) => {
                  try {
                    if (typeof text === 'string' && text.indexOf('video.twimg.com') !== -1) {
                      resetScanBudget();
                      scanForVideoVariants(rawParse(text));
                    }
                  } catch (e) {}
                  return text;
                });
              }
            : function () {
                return orig.apply(this, arguments).then((obj) => {
                  try { resetScanBudget(); scanForVideoVariants(obj); } catch (e) {}
                  return obj;
                });
              };
          hooked.__twMediaHooked = true;
          RP[method] = hooked;
        }
        log('已安装 Response.prototype json/text hook（视频直链捕获）');
      }
    } catch (e) {
      log('Response hook 安装失败:', e);
    }

    // ── 3) XHR hook：捕获直接的 mp4 请求（兜底）─────────────────────
    try {
      const XHRProto = (w.XMLHttpRequest && w.XMLHttpRequest.prototype) || XMLHttpRequest.prototype;
      if (XHRProto && !XHRProto.open.__twMediaHooked) {
        const origOpen = XHRProto.open;
        const hookedOpen = function (method, url, ...rest) {
          try {
            const s = String(url || '');
            if (s.indexOf('video.twimg.com') !== -1 && s.indexOf('.mp4') !== -1) {
              const videoId = extractVideoId(s);
              if (videoId) {
                const px = extractBitrate(s);
                const prev = videoCandidates.get(videoId);
                if (!prev || prev.bitrate < px) {
                  videoCandidates.set(videoId, { url: s, bitrate: px, hls: false });
                  log(`XHR 捕获视频直链:`, s);
                }
                recordVideo(s, false);
              }
            }
          } catch (e) {}
          return origOpen.call(this, method, url, ...rest);
        };
        hookedOpen.__twMediaHooked = true;
        XHRProto.open = hookedOpen;
      }
    } catch (e) {}

    // ── 4) fetch hook：只兜底直连 mp4（GraphQL 已由 Response hook 覆盖）──
    try {
      if (typeof w.fetch === 'function' && !w.fetch.__twMediaHooked) {
        const origFetch = w.fetch;
        const hookedFetch = function (input, init) {
          try {
            const url = String((typeof input === 'string') ? input : (input && input.url) || '');
            if (url.indexOf('video.twimg.com') !== -1 && url.indexOf('.mp4') !== -1) {
              const videoId = extractVideoId(url);
              if (videoId) {
                const px = extractBitrate(url);
                const prev = videoCandidates.get(videoId);
                if (!prev || prev.bitrate < px) {
                  videoCandidates.set(videoId, { url, bitrate: px, hls: false });
                  log(`fetch 捕获视频直链:`, url);
                }
                recordVideo(url, false);
              }
            }
          } catch (e) {}
          return origFetch.call(this, input, init);
        };
        hookedFetch.__twMediaHooked = true;
        try { Object.defineProperty(hookedFetch, 'name', { value: 'fetch', configurable: true }); } catch (e) {}
        w.fetch = hookedFetch;
        log('已安装 fetch hook（mp4 直连兜底）');
      }
    } catch (e) {
      log('fetch hook 安装失败:', e);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 🏷 推文标记
  // ════════════════════════════════════════════════════════════════

  function findArticle(el) {
    let node = el;
    for (let i = 0; i < 20; i++) {
      if (!node) return null;
      if (node.tagName === 'ARTICLE') return node;
      node = node.parentElement;
    }
    return null;
  }

  function setArticleMark(article, text, bg) {
    // 防止 Twitter 虚拟滚动替换 article 后，缓存的旧节点仍被引用
    if (article && !document.contains(article)) {
      articleMarkCache.delete(article);
    }
    const cached = articleMarkCache.get(article);
    if (cached && cached.text === text && cached.bg === bg) return;
    articleMarkCache.set(article, { text, bg });

    const existing = article ? article.querySelector('.' + MARK_CLASS) : null;
    if (existing) existing.remove();

    const badge = document.createElement('div');
    badge.className = MARK_CLASS;
    badge.innerHTML = text;
    badge.style.cssText = [
      'position: absolute', 'top: 4px', 'right: 4px', `background: ${bg}`,
      'color: #fff', 'font-size: 12px', 'font-weight: 600', 'border-radius: 10px',
      'padding: 2px 8px', 'z-index: 9999', 'pointer-events: none',
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      'box-shadow: 0 1px 4px rgba(0,0,0,0.3)', 'white-space: nowrap',
    ].join('; ');

    const computedPos = window.getComputedStyle(article).position;
    if (computedPos === 'static' || computedPos === '') article.style.position = 'relative';
    // 防止 overflow:hidden 裁掉角标
    if (window.getComputedStyle(article).overflow !== 'visible') {
      article.style.overflow = 'visible';
    }

    article.appendChild(badge);
  }

  function clearAllMarks() {
    document.querySelectorAll('.' + MARK_CLASS).forEach((el) => el.remove());
  }

  // ════════════════════════════════════════════════════════════════
  // 🖼 媒体发现与记录
  // ════════════════════════════════════════════════════════════════

  function discoverMedia() {
    // ═══════════════════════════════════════════════════════════════
    // 图片发现策略：
    // 1. 宽泛选择器（主）：捕获所有推文图片（包括 timeline grid / carousel 等嵌套结构）
    // 2. article img（辅）：捕获 timeline 里嵌套在 article 下的图片
    // 3. 头像过滤：排除 profile picture（URL 含 _normal. 的是头像，非推文图片）
    // ═══════════════════════════════════════════════════════════════
    const broadSelectors = [
      'img[src*="pbs.twimg.com/media"]',
      'img[src*="pbs.twimg.com/ext_tw_image"]',
    ];
    const articleSelectors = [
      'article img[src*="pbs.twimg.com/media"]',
      'article img[src*="pbs.twimg.com/ext_tw_image"]',
    ];

    function isAvatar(img) {
      const src = img.src || img.getAttribute('src') || '';
      // 头像特征：URL 含 _normal.（小图）或宽高 ≤ 48px
      if (src.includes('_normal.') || src.includes('_normal.jpg') || src.includes('_normal.png')) return true;
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w > 0 && h > 0 && w <= 48 && h <= 48) return true;
      return false;
    }

    const allImgs = new Set();
    // 先加宽泛选择器（主）
    for (const sel of broadSelectors) {
      document.querySelectorAll(sel).forEach((img) => {
        if (!isAvatar(img)) allImgs.add(img);
      });
    }
    // 再加 article 选择器（可能包含 timeline 里 unique 的图片）
    for (const sel of articleSelectors) {
      document.querySelectorAll(sel).forEach((img) => {
        if (!isAvatar(img)) allImgs.add(img);
      });
    }

    const allVideos = new Set();
    document.querySelectorAll('article video').forEach((v) => allVideos.add(v));

    // 用 articleMediaMap 按 article 分组；article 不存在时用 img 自身作为 key
    const articleMediaMap = new Map();
    for (const img of allImgs) {
      // 优先用 closest article，其次用 findArticle，最后用 img 自身
      const article = (img.closest && img.closest('article')) || findArticle(img) || img;
      if (!articleMediaMap.has(article)) articleMediaMap.set(article, { images: [], videos: [] });
      articleMediaMap.get(article).images.push(img);
    }
    for (const v of allVideos) {
      const article = findArticle(v);
      if (!article) continue;
      if (!articleMediaMap.has(article)) articleMediaMap.set(article, { images: [], videos: [] });
      articleMediaMap.get(article).videos.push(v);
    }

    const allArticles = document.querySelectorAll('article');

    // ═══════════════════════════════════════════════════════════════
    // 遍历 articleMediaMap（已按媒体类型分组好）
    // 关键：不再遍历 allArticles，不再跳过没有 time 元素的 article
    // ═══════════════════════════════════════════════════════════════
    for (const [article, mediaInfo] of articleMediaMap) {
      let recordedCount = 0;
      let hasImage = false;
      let hasVideo = false;
      let savedSkipped = 0;

      // ── 图片 ──
      for (const img of mediaInfo.images) {
        if (state.media.size >= CONFIG.MAX_MEDIA) break;
        const src = img.src || img.getAttribute('src');
        if (!src) continue;
        const highResUrl = toHighResUrl(src);
        const baseUrl = getBaseUrl(highResUrl);
        if (state.media.has(baseUrl)) { recordedCount++; hasImage = true; continue; }
        if (savedMediaKeys.has(baseUrl)) { savedSkipped++; continue; } // 已保存过
        state.media.set(baseUrl, { url: highResUrl, type: 'image', tweetTime: getTweetTime(img), tweetUrl: getTweetUrl(img) });
        recordedCount++; hasImage = true;
        log(`发现图片 #${state.media.size}:`, highResUrl);
      }

      // ── 视频 ──
      for (const v of mediaInfo.videos) {
        const videoId = getVideoIdFromElement(v);
        if (!videoId) continue;

        // 优先从 pendingVideos 取最新 URL（pendingVideos 持续更新，不会过期）
        // v1.2：videoCandidates 现在是 { url, bitrate, hls } 结构
        const pending = pendingVideos.get(videoId);
        const cached = videoCandidates.get(videoId);
        const mp4Url = (pending && pending.url)
          || (typeof cached === 'string' ? cached : (cached && cached.url))
          || null;
        const isHls = !!(pending && pending.hls) || !!(cached && cached.hls);
        const baseUrl = `video:${videoId}`;

        if (state.media.has(baseUrl)) {
          // 已记录：若此前因时序问题缺时间，补上推文时间
          const existing = state.media.get(baseUrl);
          if (!existing.tweetTime) {
            existing.tweetTime = getTweetTime(v);
            existing.tweetUrl = existing.tweetUrl || getTweetUrl(v);
          }
          recordedCount++; hasVideo = true; continue;
        }
        if (savedMediaKeys.has(baseUrl)) { savedSkipped++; continue; } // 已保存过
        if (!mp4Url) continue; // 还没捕获到直链，等下次
        if (state.media.size >= CONFIG.MAX_MEDIA) break;

        state.media.set(baseUrl, { url: mp4Url, type: 'video', hls: isHls, tweetTime: getTweetTime(v), tweetUrl: getTweetUrl(v) });
        recordedCount++; hasVideo = true;
        log(`发现视频 #${state.media.size}:`, mp4Url);
      }

      // ── 标记（每次 discoverMedia 都重新打标，防止虚拟滚动替换后角标消失）──
      if (recordedCount > 0) {
        if (hasImage && hasVideo) setArticleMark(article, `🎫 已记录 ${recordedCount}个媒体`, 'rgba(6, 182, 212, 0.9)');
        else if (hasVideo) setArticleMark(article, '🎬 已记录视频', 'rgba(147, 51, 234, 0.9)');
        else setArticleMark(article, `📷 已记录 ${recordedCount}张图片`, 'rgba(29, 155, 240, 0.9)');
      } else if (savedSkipped > 0) {
        setArticleMark(article, '✅ 已保存', 'rgba(22, 163, 74, 0.9)');
      } else if (mediaInfo.videos.length > 0 && mediaInfo.images.length === 0) {
        // 有视频但直链还没捕获到，显示"等待视频"
        setArticleMark(article, '⏳ 等待视频…', 'rgba(245, 158, 11, 0.9)');
      } else if (mediaInfo.images.length > 0) {
        // 有图片但 URL 可能还是占位符，显示"等待图片"
        const img0 = mediaInfo.images[0];
        const src0 = img0 && (img0.src || img0.getAttribute('src'));
        if (src0 && !src0.startsWith('data:') && !src0.startsWith('about:')) {
          setArticleMark(article, '⏳ 等待图片…', 'rgba(245, 158, 11, 0.9)');
        }
      }

      updateButton();
      checkAutoSave();
    }

    // ── 遍历无媒体的 article，标记"无媒体"──
    for (const article of allArticles) {
      if (articleMediaMap.has(article)) continue;  // 已处理过，跳过
      setArticleMark(article, '⚪ 无媒体', 'rgba(107, 114, 128, 0.85)');
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 📜 自动保存
  // ════════════════════════════════════════════════════════════════

  function checkAutoSave() {
    if (state.isRecording && !state.saving && !state.autoSaving && state.media.size >= CONFIG.MAX_MEDIA) {
      state.autoSaving = true;
      log('缓存已达上限，自动触发保存...');
      setTimeout(() => stopAndSave(true), 200);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // 🔍 MutationObserver
  // ════════════════════════════════════════════════════════════════

  /**
   * 遍历所有 article，对已记录/已保存过媒体的重新打上角标
   * 用于 MutationObserver 触发时立即恢复角标（不等待 discoverMedia 防抖）
   */
  function restoreArticleMarks() {
    const allArticles = document.querySelectorAll('article');
    for (const article of allArticles) {
      const imgs = article.querySelectorAll('img[src*="pbs.twimg.com"]');
      const videos = article.querySelectorAll('video'); // v1.2：原来写成 'article video'，在 article 内再查 article 永远为空
      let hasImage = false, hasVideo = false;

      for (const img of imgs) {
        const src = img.src || img.getAttribute('src');
        if (!src) continue;
        const baseUrl = getBaseUrl(toHighResUrl(src));
        if (state.media.has(baseUrl)) { hasImage = true; break; }
        if (savedMediaKeys.has(baseUrl)) { hasImage = true; break; }
      }
      if (!hasImage) {
        for (const v of videos) {
          const videoId = getVideoIdFromElement(v);
          if (!videoId) continue;
          const baseUrl = `video:${videoId}`;
          if (state.media.has(baseUrl)) { hasVideo = true; break; }
          if (savedMediaKeys.has(baseUrl)) { hasVideo = true; break; }
        }
      }

      if (hasImage && hasVideo) setArticleMark(article, '🎫 已记录多个媒体', 'rgba(6, 182, 212, 0.9)');
      else if (hasVideo) setArticleMark(article, '🎬 已记录视频', 'rgba(147, 51, 234, 0.9)');
      else if (hasImage) setArticleMark(article, '📷 已记录图片', 'rgba(29, 155, 240, 0.9)');
      else if (savedMediaKeys.size > 0) {
        let allSaved = true;
        for (const img of imgs) {
          const src = img.src || img.getAttribute('src');
          if (!src) continue;
          const baseUrl = getBaseUrl(toHighResUrl(src));
          if (!savedMediaKeys.has(baseUrl)) { allSaved = false; break; }
        }
        for (const v of videos) {
          const videoId = getVideoIdFromElement(v);
          if (videoId && !savedMediaKeys.has(`video:${videoId}`)) { allSaved = false; break; }
        }
        if (allSaved && (imgs.length > 0 || videos.length > 0)) {
          setArticleMark(article, '✅ 已保存', 'rgba(22, 163, 74, 0.9)');
        }
      }
    }
  }


  function startObserver() {
    state.observer = new MutationObserver((mutations) => {
      if (!state.isRecording) return;
      let hasAddedNodes = false;
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) { hasAddedNodes = true; break; }
      }
      if (hasAddedNodes) {
        clearTimeout(state._discoverTimer);
        // 立即重新打标：新 article 渲染后立刻显示角标，不等待 discoverMedia 防抖
        restoreArticleMarks();
        // 防抖 discoverMedia（发现媒体需要等懒加载完成）
        state._discoverTimer = setTimeout(() => { discoverMedia(); }, 250);
      }
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (state.observer) { state.observer.disconnect(); state.observer = null; }
    if (state._discoverTimer) { clearTimeout(state._discoverTimer); state._discoverTimer = null; }
  }

  // ════════════════════════════════════════════════════════════════
  // 📜 自动滚动
  // ════════════════════════════════════════════════════════════════

  function startAutoScroll() {
    const scheduleNext = () => {
      if (!state.isRecording) return;
      // 间隔 = 基准值 ± 随机抖动（模拟人类浏览节奏，避免固定频率被限流）
      const jitter = Math.floor(Math.random() * (CONFIG.SCROLL_INTERVAL_JITTER_MS * 2 + 1)) - CONFIG.SCROLL_INTERVAL_JITTER_MS;
      const delay = Math.max(500, CONFIG.SCROLL_INTERVAL_MS + jitter);
      state.scrollTimer = setTimeout(() => {
        if (!state.isRecording) return;
        if (state.media.size >= CONFIG.MAX_MEDIA) {
          stopAutoScroll();
          checkAutoSave();
          return;
        }
        const scrollPx = CONFIG.SCROLL_MIN_PX + Math.floor(Math.random() * (CONFIG.SCROLL_MAX_PX - CONFIG.SCROLL_MIN_PX));
        window.scrollBy({ top: scrollPx, behavior: 'smooth' });
        setTimeout(discoverMedia, 500);
        scheduleNext();
      }, delay);
    };
    scheduleNext();
  }

  function stopAutoScroll() {
    if (state.scrollTimer) { clearInterval(state.scrollTimer); state.scrollTimer = null; }
  }

  // ════════════════════════════════════════════════════════════════
  // 🔎 小文件过滤
  // ════════════════════════════════════════════════════════════════

  function getMediaSize(url) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
      // 硬超时兜底：任何一个回调都没触发时也不能让保存流程卡死
      const timer = setTimeout(() => done(null), 15000);
      try {
        GM_xmlhttpRequest({
          method: 'HEAD',
          url: url,
          timeout: 10000,
          headers: { 'Referer': 'https://x.com/' },
          onload: (response) => {
            try {
              // v1.2：原来完全不判状态。403/404/重定向中间态返回的错误体只有几十字节，
              // content-length 会被当成"媒体太小"直接丢掉，表现就是"识别了但没保存"。
              const status = (response && response.status) || 0;
              if (status >= 400) {
                log(`[HEAD] ${status}，不参与小文件过滤: ${url}`);
                done(null);
                return;
              }
              const headers = String((response && response.responseHeaders) || '');
              const cl = headers.match(/content-length:\s*(\d+)/i);
              done(cl ? parseInt(cl[1], 10) : null);
            } catch (e) {
              // 异常也不能让 Promise 悬空，否则 await 永久挂起
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
    });
  }

  async function filterSmallFiles(mediaList) {
    log(`开始小文件过滤，共 ${mediaList.length} 个媒体...`);
    let skipped = 0;
    const kept = [];

    await runConcurrent(mediaList, CONFIG.HEAD_CONCURRENCY, async (item) => {
      if (item.type === 'video') {
        // HLS 没有单一 mp4 直链，HEAD 无意义，交给下载阶段判定
        if (item.hls) { kept.push(item); return { skip: false, size: null }; }
        // 视频用小文件阈值过滤无效/损坏的小视频（用 CONFIG.MIN_VIDEO_SIZE）
        const size = await getMediaSize(item.url);
        if (size !== null && size < CONFIG.MIN_VIDEO_SIZE) {
          log(`[跳过] 无效视频 ${(size / 1024).toFixed(1)}KB: ${item.url}`);
          skipped++;
          return { skip: true };
        }
        kept.push(item);
        return { skip: false, size };
      }
      const size = await getMediaSize(item.url);
      if (size !== null && size < CONFIG.MIN_FILE_SIZE) {
        log(`[跳过] 小文件 ${(size / 1024).toFixed(1)}KB: ${item.url}`);
        skipped++;
        return { skip: true };
      }
      kept.push(item);
      return { skip: false, size };
    });

    const urlSet = new Set(kept.map((k) => k.url));
    const ordered = mediaList.filter((m) => urlSet.has(m.url));
    log(`过滤完成：保留 ${ordered.length} 个，跳过 ${skipped} 个小文件`);
    return { filtered: ordered, skipped };
  }

  // ════════════════════════════════════════════════════════════════
  // 💾 下载保存（分批打包）
  // ════════════════════════════════════════════════════════════════

  function fetchMediaBlob(url, timeoutMs, label) {
    // 主路径：GM_xmlhttpRequest + arraybuffer（已通过头部 gh_2215 workaround 修复 MV3 挂起）
    return fetchViaGMArrayBuffer(url, timeoutMs, label).then((result) => {
      if (result.success) return result;
      log(`[降级] GM 失败(${result.error})，尝试 fetch: ${label}`);
      return fetchViaFetch(url, timeoutMs, label);
    });
  }

  function fetchViaGMArrayBuffer(url, timeoutMs, label) {
    return new Promise((resolve) => {
      let settled = false;
      log(`[拉取] 开始(GM/arraybuffer): ${label}`);

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        finish({ success: false, data: null, size: 0, error: '超时' });
      }, timeoutMs);

      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url: url,
          responseType: 'arraybuffer',
          timeout: timeoutMs,
          headers: { 'Referer': 'https://x.com/' },
          onload: (response) => {
            if (response.status && response.status >= 400) {
              finish({ success: false, data: null, size: 0, error: `HTTP ${response.status}` });
              return;
            }
            const data = response.response;
            if (data == null) {
              finish({ success: false, data: null, size: 0, error: '空响应' });
              return;
            }
            // 统一为 ArrayBuffer（JSZip 处理 ArrayBuffer 是同步的，不会挂起；Blob 会走异步 FileReader 挂起）
            let buf;
            if (data instanceof ArrayBuffer) {
              buf = data;
            } else if (ArrayBuffer.isView(data)) {
              buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
            } else if (data instanceof Blob) {
              // 极端情况：GM 返回 Blob，这里转回 ArrayBuffer（需 await，但 GM 正常返回 arraybuffer）
              data.arrayBuffer().then((ab) => finish({ success: ab.byteLength > 0, data: ab, size: ab.byteLength }));
              return;
            } else {
              finish({ success: false, data: null, size: 0, error: '未知响应类型' });
              return;
            }
            finish({ success: buf.byteLength > 0, data: buf, size: buf.byteLength });
          },
          onerror: (err) => {
            finish({ success: false, data: null, size: 0, error: (err && err.error) || '网络错误' });
          },
          ontimeout: () => {
            finish({ success: false, data: null, size: 0, error: '超时' });
          },
        });
      } catch (e) {
        finish({ success: false, data: null, size: 0, error: (e && e.message) || 'GM异常' });
      }
    });
  }

  function fetchViaFetch(url, timeoutMs, label) {
    return new Promise((resolve) => {
      const controller = new AbortController();
      let settled = false;
      log(`[拉取] 开始(fetch): ${label}`);

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        finish({ success: false, data: null, size: 0, error: '超时' });
        controller.abort();
      }, timeoutMs);

      try {
        fetch(url, {
          signal: controller.signal,
          credentials: 'omit',
          referrer: 'https://x.com/',
          referrerPolicy: 'no-referrer-when-downgrade',
        })
          .then((resp) => {
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return resp.arrayBuffer();
          })
          .then((buf) => {
            finish({ success: !!buf && buf.byteLength > 0, data: buf, size: buf ? buf.byteLength : 0 });
          })
          .catch((err) => {
            finish({ success: false, data: null, size: 0, error: (err && err.message) || '网络错误' });
          });
      } catch (e) {
        finish({ success: false, data: null, size: 0, error: (e && e.message) || 'fetch错误' });
      }
    });
  }

  // ════════════════════════════════════════════════════════════════
  // 🎞 HLS（m3u8）兜底下载 — v1.2 新增
  // 长视频 / amplify 视频只有 application/x-mpegURL，没有 mp4 variant。
  // 做法：拉 master playlist → 选 BANDWIDTH 最高的一路 → 拉该路 playlist →
  //       下载 #EXT-X-MAP 初始化段 + 全部分片 → 顺序拼接成可播放的 fMP4。
  // ════════════════════════════════════════════════════════════════
  function fetchTextViaGM(url, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
      const timer = setTimeout(() => finish(null), timeoutMs);
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url: url,
          timeout: timeoutMs,
          headers: { 'Referer': 'https://x.com/' },
          onload: (r) => {
            try {
              if (!r || (r.status && r.status >= 400)) return finish(null);
              const body = (r.responseText !== undefined && r.responseText !== null)
                ? r.responseText
                : String(r.response || '');
              finish(body || null);
            } catch (e) { finish(null); }
          },
          onerror: () => finish(null),
          ontimeout: () => finish(null),
          onabort: () => finish(null),
        });
      } catch (e) { finish(null); }
    });
  }

  function fetchBinaryViaGM(url, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
      const timer = setTimeout(() => finish(null), timeoutMs);
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url: url,
          responseType: 'arraybuffer',
          timeout: timeoutMs,
          headers: { 'Referer': 'https://x.com/' },
          onload: (r) => {
            try {
              if (!r || (r.status && r.status >= 400)) return finish(null);
              const d = r.response;
              if (d instanceof ArrayBuffer) return finish(d);
              if (ArrayBuffer.isView(d)) return finish(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
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

  async function resolveHls(m3u8Url) {
    try {
      let text = await fetchTextViaGM(m3u8Url, 30000);
      if (!text || text.indexOf('#EXTM3U') === -1) return null;

      if (text.indexOf('#EXT-X-STREAM-INF') !== -1) {
        // master playlist：挑 BANDWIDTH 最高的一路
        const lines = text.split('\n');
        let bestBw = -1;
        let bestUri = null;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].indexOf('#EXT-X-STREAM-INF') !== 0) continue;
          const bwM = lines[i].match(/BANDWIDTH=(\d+)/);
          const bw = bwM ? parseInt(bwM[1], 10) : 0;
          let uri = null;
          for (let j = i + 1; j < lines.length; j++) {
            const t = lines[j].trim();
            if (!t) continue;
            if (t.charAt(0) === '#') break;
            uri = t;
            break;
          }
          if (uri && bw > bestBw) { bestBw = bw; bestUri = uri; }
        }
        if (!bestUri) return null;
        const abs = new URL(bestUri, m3u8Url).href;
        text = await fetchTextViaGM(abs, 30000);
        if (!text) return null;
        m3u8Url = abs;
      }

      let init = null;
      const segments = [];
      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (line.charAt(0) === '#') {
          const mM = line.match(/^#EXT-X-MAP:.*URI="([^"]+)"/);
          if (mM) init = new URL(mM[1], m3u8Url).href;
          continue;
        }
        segments.push(new URL(line, m3u8Url).href);
      }
      if (segments.length === 0) return null;
      log(`[HLS] 解析成功：初始化段 ${init ? '有' : '无'}，分片 ${segments.length} 个`);
      return { init, segments };
    } catch (e) {
      log('[HLS] 解析失败:', e);
      return null;
    }
  }

  function concatBuffers(list) {
    let total = 0;
    for (const b of list) total += b.byteLength;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const b of list) { out.set(new Uint8Array(b), pos); pos += b.byteLength; }
    return out.buffer;
  }

  async function fetchHlsVideo(url, label) {
    const pl = await resolveHls(url);
    if (!pl) return { success: false, data: null, size: 0, error: 'HLS 解析失败' };

    const parts = [];
    if (pl.init) {
      const buf = await fetchBinaryViaGM(pl.init, 60000);
      if (!buf) return { success: false, data: null, size: 0, error: 'HLS 初始化段下载失败' };
      parts.push(buf);
    }
    for (let i = 0; i < pl.segments.length; i++) {
      const buf = await fetchBinaryViaGM(pl.segments[i], 60000);
      if (!buf) {
        return { success: false, data: null, size: 0, error: `HLS 分片 ${i + 1}/${pl.segments.length} 下载失败` };
      }
      parts.push(buf);
    }
    const merged = concatBuffers(parts);
    log(`[✓] HLS 合并完成: ${label} (${formatSize(merged.byteLength)}，${parts.length} 段)`);
    return { success: merged.byteLength > 0, data: merged, size: merged.byteLength };
  }

  function buildDownloadTasks(mediaList) {
    // 图片和视频分开分组、分开编号：
    //   图片 → 按完整推文时间分组 → YYYY-MM-DD_HHMMSS_xx（同条推文的多图共享时间，序号 01..04）
    //   视频 → 按日期分组       → video_YYYY-MM-DD_xx（同一天的视频连续编号）
    // v1.3 之前两者混在同一组里编号，且拿不到 tweetTime 的视频全部挤进 'unknown' 组，
    // 序号退化成全局流水号 —— 用户看到的 video_<id>_06 就是这么来的。
    const imgGroups = new Map();
    const imgOrder = [];
    const vidGroups = new Map();
    const vidOrder = [];

    for (const m of mediaList) {
      const isVideo = m.type === 'video';
      const key = isVideo ? resolveVideoDateKey(m) : (m.tweetTime || 'unknown');
      const groups = isVideo ? vidGroups : imgGroups;
      const order = isVideo ? vidOrder : imgOrder;
      if (!groups.has(key)) { groups.set(key, []); order.push(key); }
      groups.get(key).push(m);
    }

    const tasks = [];
    const emit = (groups, order, isVideo) => {
      for (const key of order) {
        const group = groups.get(key);
        const padLen = Math.max(2, String(group.length).length);
        group.forEach((m, index) => {
          const seq = String(index + 1).padStart(padLen, '0');
          const nameBase = isVideo ? ('video_' + key) : formatTimeForFilename(key);
          tasks.push({ url: m.url, filename: nameBase + '_' + seq + '.' + getExtension(m.url), type: m.type, hls: !!m.hls });
        });
      }
    };
    emit(imgGroups, imgOrder, false);
    emit(vidGroups, vidOrder, true);
    return tasks;
  }

  // ════════════════════════════════════════════════════════════════
  // 📦 同步 ZIP 打包器（STORE 模式，100% 同步，不依赖 JSZip 异步调度器）
  // 根因：JSZip 的 setImmediate shim 靠 postMessage 自投递做异步调度，
  // 在 userscript.html 隔离沙箱里失效 → generateAsync 永不 resolve。
  // 手写 STORE 打包器完全同步，规避所有异步调度问题。
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

  async function downloadAsZip(mediaList) {
    const tasks = buildDownloadTasks(mediaList);
    const videoTasks = tasks.filter(t => t.type === 'video');
    const imageTasks = tasks.filter(t => t.type === 'image');
    log(`开始拉取并打包 ${tasks.length} 个媒体（图片 ${imageTasks.length}，视频 ${videoTasks.length}，并发 ${CONFIG.DOWNLOAD_CONCURRENCY}）...`);
    if (videoTasks.length > 0) {
      videoTasks.forEach(t => log(`[视频任务] ${t.filename} ← ${t.url}`));
    }

    updateButtonStage('拉取媒体中…');

    // 分批拉取（每批 BATCH_SIZE 个，避免内存爆炸）
    const total = tasks.length;
    const fetched = [];
    let failed = 0;

    for (let batchStart = 0; batchStart < total; batchStart += CONFIG.BATCH_SIZE) {
      const batch = tasks.slice(batchStart, batchStart + CONFIG.BATCH_SIZE);
      const batchNo = Math.floor(batchStart / CONFIG.BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(total / CONFIG.BATCH_SIZE);

      log(`[拉取] 批次 ${batchNo}/${totalBatches}（${batch.length} 个）...`);
      updateButtonStage(`拉取媒体中… ${batchStart}/${total}`);

      const results = await runConcurrent(batch, CONFIG.DOWNLOAD_CONCURRENCY, async (task) => {
        const result = task.hls
          ? await fetchHlsVideo(task.url, task.filename)
          : await fetchMediaBlob(task.url, 120000, task.filename);
        if (result.success) {
          log(`[✓] 已拉取: ${task.filename} (${formatSize(result.size)})`);
          return { task, data: result.data };
        } else {
          log(`[✗] 拉取失败: ${task.filename} (${result ? result.error : '未知'})`);
          return { task, data: null };
        }
      });

      for (const r of results) {
        if (r && r.data != null) fetched.push(r);
        else failed++;
      }
    }

    log(`拉取完成：成功 ${fetched.length}，失败 ${failed}`);

    if (fetched.length === 0) {
      log('没有成功拉取到任何媒体，跳过打包');
      return { saved: 0, failed, savedKeys: [], zipSize: 0 };
    }

    // 分批打包（每批 BATCH_SIZE 个生成一个 zip，同步 buildZip 不依赖异步调度）
    const zipParts = [];
    for (let i = 0; i < fetched.length; i += CONFIG.BATCH_SIZE) {
      const chunk = fetched.slice(i, i + CONFIG.BATCH_SIZE);
      const partNo = zipParts.length + 1;
      updateButtonStage(`正在打包 ZIP… 第 ${partNo} 批 (${chunk.length} 个)`);
      log(`[打包] 第 ${partNo} 批：${chunk.length} 个媒体...`);

      const files = chunk.map(r => ({
        name: (r.task.type === 'video' ? 'videos/' : 'images/') + r.task.filename,
        data: r.data,
      }));

      const zipData = buildZip(files);
      log(`[打包] 第 ${partNo} 批完成，大小: ${formatSize(zipData.byteLength)}`);
      zipParts.push({ zipData, partNo });
    }

    // 保存所有 zip 分片
    let saved = 0;
    for (const part of zipParts) {
      const filename = generateZipFilename(zipParts.length > 1 ? part.partNo : 0);
      updateButtonStage(`正在下载 ZIP… ${part.partNo}/${zipParts.length}`);
      log(`[保存] ${filename} (${formatSize(part.zipData.byteLength)})`);
      try {
        const blob = new Blob([part.zipData], { type: 'application/zip' });
        if (typeof saveAs === 'function') {
          saveAs(blob, filename);
        } else {
          const url = URL.createObjectURL(blob);
          fallbackDownload(url, filename);
        }
        saved++;
        log(`[✓] ZIP 下载已触发: ${filename}`);
        await new Promise(r => setTimeout(r, 800)); // 分片之间稍作间隔
      } catch (e) {
        log(`[✗] ZIP 保存失败: ${filename} (${e.message})`);
      }
    }

    log(`打包完成：共 ${zipParts.length} 个 ZIP，成功 ${saved}`);
    const savedKeys = fetched.map((r) => getMediaKey({ type: r.task.type, url: r.task.url }));
    return { saved, failed, savedKeys, zipSize: zipParts.reduce((s, p) => s + p.zipData.byteLength, 0) };
  }

  async function downloadIndividually(mediaList) {
    const tasks = buildDownloadTasks(mediaList);
    const videoTasks = tasks.filter(t => t.type === 'video');
    const imageTasks = tasks.filter(t => t.type === 'image');
    log(`开始原生下载 ${tasks.length} 个媒体（图片 ${imageTasks.length}，视频 ${videoTasks.length}，并发 ${CONFIG.DOWNLOAD_CONCURRENCY}）...`);
    if (videoTasks.length > 0) {
      videoTasks.forEach(t => log(`[视频任务] ${t.filename} ← ${t.url}`));
    }
    let failed = 0;

    log(`开始原生下载 ${tasks.length} 个媒体（并发 ${CONFIG.DOWNLOAD_CONCURRENCY}）...`);

    await runConcurrent(tasks, CONFIG.DOWNLOAD_CONCURRENCY, async (task) => {
      const ok = await new Promise((resolve) => {
        let done = false;
        try {
          GM_download({
            url: task.url,
            name: task.filename,
            onload: () => {
              if (!done) { done = true; log(`[✓] 已下载: ${task.filename}`); resolve(true); }
            },
            onerror: (e) => {
              if (!done) { done = true; log(`[✗] 下载失败: ${task.filename} (${(e && e.error) || '错误'})`); resolve(false); }
            },
            ontimeout: () => {
              if (!done) { done = true; log(`[✗] 下载超时: ${task.filename}`); resolve(false); }
            },
          });
        } catch (e) {
          if (!done) { done = true; log(`[✗] GM_download 异常: ${task.filename} (${e.message})`); resolve(false); }
        }
        // 硬超时兜底
        setTimeout(() => {
          if (!done) { done = true; log(`[✗] 下载超时(硬): ${task.filename}`); resolve(false); }
        }, 120000);
      });
      if (ok) saved++; else failed++;
      updateButtonProgress(saved + failed, tasks.length);
    });

    log(`下载完成：成功 ${saved}，失败 ${failed}`);
    return { saved, failed, zipSize: 0 };
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

  function generateZipFilename(part) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
               `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return part > 0 ? `twitter_media_${ts}_part${part}.zip` : `twitter_media_${ts}.zip`;
  }

  // ════════════════════════════════════════════════════════════════
  // 🎛 浮动按钮 UI
  // ════════════════════════════════════════════════════════════════

  // ════════════════════════════════════════════════════════════════
  // ⚙️ 设置面板（可调配置 + 清除历史记录）
  // ════════════════════════════════════════════════════════════════
  const PANEL_ID = 'tw-media-saver-panel';
  const GEAR_ID = 'tw-media-saver-settings';

  // X 官方图标 SVG。用 SVG 而不是 Emoji：Emoji 在 macOS / Windows / 缺字体环境下
  // 字形和配色差异很大，按钮宽度和视觉重量都不可控。
  const ICON = {
    more: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M3 12c0-1.1.9-2 2-2s2 .9 2 2-.9 2-2 2-2-.9-2-2zm9 2c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm7 0c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z"/></svg>',
    photo: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M3 5.5C3 4.119 4.119 3 5.5 3h13C19.881 3 21 4.119 21 5.5v13c0 1.381-1.119 2.5-2.5 2.5h-13C4.119 21 3 19.881 3 18.5v-13zM5.5 5c-.276 0-.5.224-.5.5v9.086l3-3 3 3 5-5 3 3V5.5c0-.276-.224-.5-.5-.5h-13zM19 15.414l-3-3-5 5-3-3-3 3V18.5c0 .276.224.5.5.5h13c.276 0 .5-.224.5-.5v-3.086zM9.75 7C8.784 7 8 7.784 8 8.75s.784 1.75 1.75 1.75 1.75-.784 1.75-1.75S10.716 7 9.75 7z"/></svg>',
    // 录制中：实心方块（停止）。用 CSS 方块而不是 SVG，尺寸小一号、视觉更轻
    stop: '<span style="width:10px;height:10px;background:currentColor;display:inline-block;flex:none;margin-right:2px" aria-hidden="true"></span>',
    save: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 2.59l5.7 5.7-1.41 1.42L13 6.41V16h-2V6.41l-3.3 3.3-1.41-1.42L12 2.59zM21 15l-.02 3.51c0 1.38-1.12 2.49-2.5 2.49H5.5C4.11 21 3 19.88 3 18.5V15h2v3.5c0 .28.22.5.5.5h12.98c.28 0 .5-.22.5-.5L19 15h2z"/></svg>',
  };

  function makeEl(tag, cssText, text) {
    const n = document.createElement(tag);
    if (cssText) n.style.cssText = cssText;
    if (text != null) n.textContent = text;
    return n;
  }

  function onPanelOutsideClick(e) {
    const p = document.getElementById(PANEL_ID);
    if (!p || p.contains(e.target)) return;
    const gear = document.getElementById(GEAR_ID);
    if (gear && gear.contains(e.target)) return;
    closeSettings();
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

    const panel = makeEl('div', [
      'position: fixed',
      `bottom: calc(${CONFIG.BUTTON_POSITION.bottom} + 56px)`,
      `right: ${CONFIG.BUTTON_POSITION.right}`,
      `z-index: ${CONFIG.BUTTON_Z_INDEX}`,
      'width: 248px', 'box-sizing: border-box', 'background: #fff',
      'border: 0.5px solid rgba(15,20,25,0.08)', 'border-radius: 16px',
      'box-shadow: rgba(101,119,134,0.2) 0px 0px 15px, rgba(101,119,134,0.15) 0px 0px 3px 1px',
      'overflow: hidden', 'pointer-events: auto', 'color: #0f1419',
      'padding-bottom: 10px', 'user-select: none',
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif',
    ].join('; '));
    panel.id = PANEL_ID;

    // 标题栏
    const head = makeEl('div', 'display:flex;align-items:center;justify-content:space-between;padding:11px 14px 9px;border-bottom:1px solid rgba(15,20,25,0.08)');
    head.appendChild(makeEl('span', 'font-size:14px;font-weight:700', '设置'));
    const closeX = makeEl('span', 'cursor:pointer;font-size:18px;line-height:1;color:#536471;padding:0 2px', '×');
    closeX.addEventListener('click', closeSettings);
    head.appendChild(closeX);
    panel.appendChild(head);

    // 可调配置项
    const body = makeEl('div', 'padding:6px 0 2px');
    for (const t of TUNABLE) {
      const row = makeEl('div', 'display:flex;align-items:center;justify-content:space-between;padding:6px 14px');
      row.appendChild(makeEl('span', 'font-size:13px;color:#0f1419', t.label));
      const right = makeEl('div', 'display:flex;align-items:center');
      if (t.type === 'select') {
        const sel = document.createElement('select');
        sel.style.cssText = 'width:96px;border:0.5px solid #cfd9de;border-radius:6px;padding:3px 4px;font-size:12px;color:#0f1419;outline:none;box-sizing:border-box;background:#fff';
        sel.addEventListener('focus', () => { sel.style.borderColor = '#1d9bf0'; sel.style.boxShadow = '0 0 0 1px #1d9bf0'; });
        sel.addEventListener('blur', () => { sel.style.borderColor = '#cfd9de'; sel.style.boxShadow = 'none'; });
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
        input.style.cssText = 'width:56px;text-align:right;border:0.5px solid #cfd9de;border-radius:6px;padding:3px 6px;font-size:13px;color:#0f1419;outline:none;box-sizing:border-box;background:#fff';
        input.addEventListener('focus', () => { input.style.borderColor = '#1d9bf0'; input.style.boxShadow = '0 0 0 1px #1d9bf0'; });
        input.addEventListener('blur', () => { input.style.borderColor = '#cfd9de'; input.style.boxShadow = 'none'; });
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
        right.appendChild(makeEl('span', 'margin-left:6px;font-size:12px;color:#536471;width:22px', t.unit));
      }
      row.appendChild(right);
      body.appendChild(row);
    }
    panel.appendChild(body);

    // 历史记录区
    const foot = makeEl('div', 'padding:10px 14px 0;margin-top:6px;border-top:0.5px solid rgba(15,20,25,0.08)');
    const histRow = makeEl('div', 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px');
    histRow.appendChild(makeEl('span', 'font-size:13px;color:#0f1419', '已保存记录'));
    const histCount = makeEl('span', 'font-size:13px;color:#536471', `${savedMediaKeys.size} 条`);
    histRow.appendChild(histCount);
    foot.appendChild(histRow);

    const btnCss = 'width:100%;padding:7px 0;margin-top:6px;border-radius:9999px;font-size:13px;font-weight:500;cursor:pointer;border:0.5px solid;text-align:center;box-sizing:border-box;background:#fff';
    const clearBtn = makeEl('div', btnCss + ';color:#f4212e;border-color:rgba(244,33,46,0.4)', '清除历史记录');
    clearBtn.addEventListener('mouseenter', () => { clearBtn.style.background = 'rgba(244,33,46,0.08)'; });
    clearBtn.addEventListener('mouseleave', () => { clearBtn.style.background = '#fff'; });
    clearBtn.addEventListener('click', () => {
      if (!confirm(`确定清除全部 ${savedMediaKeys.size} 条已保存记录？\n\n清除后，下次点击「记录媒体」会重新记录所有媒体，不再跳过已保存项。`)) return;
      savedMediaKeys.clear();
      try { GM_setValue('savedMediaKeys', '[]'); } catch (e) {}
      GM_notification({ title: 'Twitter 媒体保存', text: '已清除历史记录，下次记录将包含所有媒体' });
      log('已清除历史保存记录');
      histCount.textContent = '0 条';
    });
    foot.appendChild(clearBtn);

    const resetBtn = makeEl('div', btnCss + ';color:#536471;border-color:#cfd9de', '恢复默认设置');
    resetBtn.addEventListener('mouseenter', () => { resetBtn.style.background = 'rgba(15,20,25,0.05)'; });
    resetBtn.addEventListener('mouseleave', () => { resetBtn.style.background = '#fff'; });
    resetBtn.addEventListener('click', () => {
      if (!confirm('确定恢复默认设置？')) return;
      for (const t of TUNABLE) CONFIG[t.key] = CONFIG_DEFAULTS[t.key];
      saveUserConfig();
      buildSettingsPanel();
      log('已恢复默认设置');
    });
    foot.appendChild(resetBtn);

    panel.appendChild(foot);
    document.body.appendChild(panel);
    state.settingsOpen = true;
    setTimeout(() => document.addEventListener('mousedown', onPanelOutsideClick, true), 0);
  }

  function createButton() {
    if (state.btnEl && document.body.contains(state.btnEl)) return;

    // X/Twitter 原生风格的浮动按钮组：白色圆角药丸 + 小齿轮，更低调、不挡内容
    const container = document.createElement('div');
    container.id = 'tw-media-saver-container';
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

    // 设置按钮：白色小圆，原生菜单图标风格
    const gear = document.createElement('div');
    gear.id = GEAR_ID;
    // X 官方「更多」三点图标 —— 和每条推文右上角的按钮一致，最原生也最不抢眼
    gear.innerHTML = ICON.more;
    gear.title = '更多选项（设置 / 清除历史记录）';
    gear.style.cssText = [
      'width: 32px', 'height: 32px', 'border-radius: 50%',
      'background: #fff', 'color: #536471',
      'display: flex', 'align-items: center', 'justify-content: center',
      'cursor: pointer', 'border: 0.5px solid rgba(15,20,25,0.08)',
      'box-shadow: rgba(101,119,134,0.2) 0px 0px 10px, rgba(101,119,134,0.15) 0px 0px 2px 1px',
      'transition: all 0.15s ease', 'pointer-events: auto', 'user-select: none',
    ].join('; ');
    gear.addEventListener('mouseenter', () => { gear.style.background = '#f7f9f9'; gear.style.transform = 'scale(1.08)'; });
    gear.addEventListener('mouseleave', () => { gear.style.background = '#fff'; gear.style.transform = 'scale(1)'; });
    gear.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.settingsOpen) closeSettings();
      else buildSettingsPanel();
    });

    // 主按钮：白色药丸，和 X 的浮动按钮/标签风格一致；录制时变红
    const btn = document.createElement('div');
    btn.id = 'tw-media-saver-btn';
    btn.innerHTML = ICON.photo + '<span>记录媒体</span>';
    btn.style.cssText = [
      'height: 34px', 'padding: 0 15px',
      'background: #fff', 'color: #0f1419',
      'border-radius: 9999px', 'font-size: 14px', 'font-weight: 500',
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif',
      'cursor: pointer', 'border: 0.5px solid rgba(15,20,25,0.08)',
      'box-shadow: rgba(101,119,134,0.2) 0px 0px 10px, rgba(101,119,134,0.15) 0px 0px 2px 1px',
      'user-select: none', 'transition: all 0.15s ease',
      'display: flex', 'align-items: center', 'gap: 5px',
      'pointer-events: auto',
    ].join('; ');
    btn.addEventListener('mouseenter', () => {
      if (state.isRecording) { btn.style.transform = 'scale(1.04)'; return; }
      btn.style.background = '#f7f9f9';
      btn.style.transform = 'scale(1.04)';
    });
    btn.addEventListener('mouseleave', () => {
      if (state.isRecording) { btn.style.transform = 'scale(1)'; return; }
      btn.style.background = '#fff';
      btn.style.transform = 'scale(1)';
    });
    btn.addEventListener('click', onButtonClick);

    container.appendChild(gear);
    container.appendChild(btn);
    document.body.appendChild(container);
    state.btnEl = btn;
  }

  function updateButton() {
    if (!state.btnEl) return;
    const btn = state.btnEl;
    if (state.isRecording) {
      const count = state.media.size;
      btn.innerHTML = count >= CONFIG.MAX_MEDIA
        ? ICON.stop + '<span>已满 ' + count + '</span>'
        : ICON.stop + '<span>已记录 ' + count + '</span>';
      btn.style.background = '#f4212e';
      btn.style.color = '#fff';
      btn.style.borderColor = 'transparent';
      btn.style.cursor = 'pointer';
    } else if (btn.dataset.busy === 'true') {
      btn.innerHTML = ICON.save + '<span>打包中…</span>';
      btn.style.background = '#f7f9f9';
      btn.style.color = '#536471';
      btn.style.borderColor = 'rgba(15,20,25,0.08)';
      btn.style.cursor = 'not-allowed';
    } else {
      btn.innerHTML = ICON.photo + '<span>记录媒体</span>';
      btn.style.background = '#fff';
      btn.style.color = '#0f1419';
      btn.style.borderColor = 'rgba(15,20,25,0.08)';
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
    if (!state.isRecording) {
      startRecording();
    } else {
      await stopAndSave(false);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // ▶️ 开始记录
  // ════════════════════════════════════════════════════════════════

  function startRecording() {
    state.isRecording = true;
    state.media.clear();
    videoCandidates.clear();
    clearAllMarks();

    log('开始记录媒体...');

    // 把开始记录前已缓存的视频直链灌入 state.media
    // v1.2：只恢复"当前页面"捕获的。原实现 pendingVideos 永不清理，
    // 从 A 用户主页切到 B 用户主页后会把 A 的视频也灌进来。
    const pageKey = currentPageKey();
    let skippedOtherPage = 0;
    if (pendingVideos.size > 0) {
      log(`从缓存恢复视频直链（缓存 ${pendingVideos.size} 个，当前页面 /${pageKey}）`);
      for (const [videoId, info] of pendingVideos) {
        if (state.media.size >= CONFIG.MAX_MEDIA) break;
        if (info.page && pageKey && info.page !== pageKey) { skippedOtherPage++; continue; }
        const baseUrl = `video:${videoId}`;
        if (savedMediaKeys.has(baseUrl)) { log(`跳过已保存视频: ${info.url}`); continue; } // 已保存过
        const ctx = findVideoContext(videoId);
        state.media.set(baseUrl, {
          url: info.url,
          type: 'video',
          hls: !!info.hls,
          tweetTime: ctx.tweetTime || tweetCreatedAtCache.get(videoId) || null,
          tweetUrl: ctx.tweetUrl,
        });
        log(`恢复视频 #${state.media.size}:`, info.url);
      }
    }
    if (skippedOtherPage > 0) log(`忽略 ${skippedOtherPage} 个其他页面残留的视频直链`);

    discoverMedia();
    startObserver();
    startAutoScroll();
    updateButton();
    checkAutoSave();
  }

  // ════════════════════════════════════════════════════════════════
  // ⏹ 停止并保存
  // ════════════════════════════════════════════════════════════════

  async function stopAndSave(isAuto) {
    if (state.saving) return;
    state.saving = true;

    state.isRecording = false;
    stopObserver();
    stopAutoScroll();

    log(`记录停止，共记录 ${state.media.size} 个媒体`);

    state.btnEl.dataset.busy = 'true';
    updateButton();

    const allMedia = Array.from(state.media.values()).slice(0, CONFIG.MAX_MEDIA);

    if (allMedia.length === 0) {
      log('没有媒体可保存');
      state.btnEl.dataset.busy = '';
      state.saving = false;
      state.autoSaving = false;
      updateButton();
      GM_notification({ title: 'Twitter 媒体保存', text: '没有记录到任何媒体' });
      return;
    }

    // 小文件过滤
    const { filtered, skipped } = await filterSmallFiles(allMedia);

    // 打包下载
    const result = await downloadAsZip(filtered);
    const saved = result.saved;
    const failed = result.failed;

    // 保存成功的媒体标记为已保存（下次记录自动跳过）
    const savedKeys = result.savedKeys || [];
    markSaved(savedKeys);

    const totalSkipped = skipped + failed;
    log(`全部完成！共下载 ${saved} 个媒体，跳过 ${totalSkipped} 个（小文件 ${skipped} / 下载失败 ${failed}）`);

    GM_notification({
      title: 'Twitter 媒体保存',
      text: `保存完成！共下载 ${saved} 个媒体，跳过 ${totalSkipped} 个（小文件/失败）`,
    });

    // 恢复状态（不删除角标，供用户查看）
    state.btnEl.dataset.busy = '';
    state.saving = false;
    state.autoSaving = false;
    updateButton();
    log('保存流程结束，已记录角标保留。可点击按钮重新开始记录。');
  }

  // ════════════════════════════════════════════════════════════════
  // 🚀 初始化
  // ════════════════════════════════════════════════════════════════

  function init() {
    createButton();
    installVideoHook();
  }

  // v1.2：捕获 hook 必须在最早时机装上。原来是 load + 1.5s 延迟，
  // 首屏 GraphQL 早就返回完了，这批视频永远抓不到，而且页面不会重放。
  try { installVideoHook(); } catch (e) { log('hook 预安装失败:', e); }

  const bootUI = () => {
    try { createButton(); installVideoHook(); } catch (e) { log('UI 初始化失败:', e); }
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
    if (!document.body) return false;   // document-start 时 body 还不存在
    const urlObserver = new MutationObserver(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        // v1.2：换页清掉旧页面的视频直链缓存，防止串号
        pendingVideos.clear();
        setTimeout(() => {
          if (!state.btnEl || !document.body.contains(state.btnEl)) init();
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

  log('脚本 v1.2 已加载，捕获 hook 已就位...');
})();
