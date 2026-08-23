/**
 * M3U8 Ad-Strip Cloudflare Worker
 *
 * 参考:
 *   - https://github.com/ltxlong/M3U8-Filter-Ad-Script  (切片广告过滤算法)
 *   - https://github.com/eraycc/m3u8-proxy-script          (m3u8 解析/重写框架)
 *
 * 特点:
 *   1. 过滤插播广告，返回纯净 m3u8
 *   2. 把原始 m3u8 中的相对片段链接改写成绝对链接，不代理/缓存视频片段
 *   3. 主页 / 提供一个 webui，输入 m3u8 链接后跳转到 /m3u8/<原始链接> 播放
 */

// ==================== 配置 ====================
const CONFIG = {
  // 调试
  // 智能统计过滤(基于片段时长/位置/不连续标记的 z-score 分析)
  FILTER_ADS_STATISTICALLY: true,
  // 可选正则过滤规则(null 表示不使用)
  FILTER_REGEX: null,
  // 主播放列表递归深度上限
  MAX_RECURSION: 5,
  // 是否打印调试日志
  DEBUG: true,
  // 随机 User-Agent
  USER_AGENTS: [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
  ]
};

// ==================== 通用工具函数 ====================

/**
 * 从完整 URL 中提取 base(去掉最后一段文件名，保留目录及结尾斜杠)
 */
function getBaseUrl(url) {
  try {
    const parsedUrl = new URL(url);
    const pathParts = parsedUrl.pathname.split('/');
    pathParts.pop(); // 去掉文件名
    return `${parsedUrl.origin}${pathParts.join('/')}/`;
  } catch (e) {
    const lastSlashIndex = url.lastIndexOf('/');
    return lastSlashIndex > 8 ? url.substring(0, lastSlashIndex + 1) : url;
  }
}

/**
 * 将相对 URL 基于 baseUrl 解析为绝对 URL
 */
function resolveUrl(baseUrl, relativeUrl) {
  if (relativeUrl.match(/^https?:\/\//i)) {
    return relativeUrl;
  }
  try {
    return new URL(relativeUrl, baseUrl).toString();
  } catch (e) {
    if (relativeUrl.startsWith('/')) {
      try {
        const urlObj = new URL(baseUrl);
        return `${urlObj.origin}${relativeUrl}`;
      } catch (_) {
        return `${baseUrl}${relativeUrl}`;
      }
    }
    return `${baseUrl}${relativeUrl}`;
  }
}

/**
 * 判断内容是否为合法 m3u8
 */
function isM3u8Content(content, contentType) {
  if (contentType && (
    contentType.includes('application/vnd.apple.mpegurl') ||
    contentType.includes('application/x-mpegurl')
  )) {
    return true;
  }
  if (content && content.trim().startsWith('#EXTM3U')) {
    return true;
  }
  return false;
}

/**
 * 随机 User-Agent
 */
function getRandomUserAgent() {
  return CONFIG.USER_AGENTS[Math.floor(Math.random() * CONFIG.USER_AGENTS.length)];
}

/**
 * 直接抓取目标 m3u8(不经过任何代理)，返回内容与 Content-Type
 */
async function fetchContentWithType(url) {
  const headers = new Headers({
    'User-Agent': getRandomUserAgent(),
    'Accept': '*/*',
    'Referer': new URL(url).origin
  });
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
  }
  const content = await response.text();
  const contentType = response.headers.get('Content-Type') || '';
  return { content, contentType };
}

async function fetchContent(url) {
  const { content } = await fetchContentWithType(url);
  return content;
}

function debugLog(...args) {
  if (CONFIG.DEBUG) console.log('[m3u8-ad-strip]', ...args);
}

// ==================== ltxlong 模式识别广告过滤算法 ====================
/**
 * 匹配 .ts 前的数字序列号。例如 000123.ts => 123
 */
function extractNumberBeforeTs(str) {
  const match = str.match(/(\d+)\.ts/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * 参考 ltxlong/M3U8-Filter-Ad-Script 的 filter_lines 思路：
 * - ts_type=0: 带递增数字的序列 .ts
 * - ts_type=1: 非数字/哈希类 .ts，依赖 EXT-X-DISCONTINUITY 判断
 * - ts_type=2: 暴力拆解模式，只移除 DISCONTINUITY
 */
function filterLines(lines) {
  const result = [];

  const first_extinf_rows = [];
  let first_extinf_row = '';
  let the_same_extinf_name_n = 0;
  let the_extinf_benchmark_n = 5;
  let the_ext_x_mode = 0;

  let ts_name_len = 0;
  const ts_name_len_extend = 1;
  let prev_ts_name_index = -1;
  let first_ts_name_index = -1;
  let ts_type = 0;

  // ---------- 第一阶段：识别 ts 命名模式 ----------
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (first_extinf_rows.length < 2 && line.startsWith('#EXTINF')) {
      first_extinf_rows.push(line);
    }
    if (first_extinf_rows.length === 2 && first_extinf_rows[0] !== first_extinf_rows[1]) {
      // do nothing special
    }

    const the_ts_name_len = line.indexOf('.ts');
    if (the_ts_name_len <= 0) continue;

    if (ts_name_len === 0) {
      ts_name_len = the_ts_name_len;
    }

    const ts_name_index = extractNumberBeforeTs(line);
    if (ts_name_index === null) {
      // 无数字 -> 可能哈希类命名
      if (ts_type === 0) {
        ts_type = 1;
      }
      continue;
    }

    if (prev_ts_name_index === -1) {
      prev_ts_name_index = ts_name_index;
      first_ts_name_index = ts_name_index;
      prev_ts_name_index = first_ts_name_index - 1;
      continue;
    }

    if (the_ts_name_len !== ts_name_len) {
      if (the_ts_name_len === ts_name_len + 1 && ts_name_index === prev_ts_name_index + 1) {
        // 长度允许增加 1
        ts_name_len = the_ts_name_len;
      }
    }

    if (ts_name_index === prev_ts_name_index + 1) {
      prev_ts_name_index = ts_name_index;
    } else {
      if (ts_type === 0 && ts_name_index > prev_ts_name_index + 1) {
        ts_type = 2;
        debugLog('识别ts模式2-序列号跳跃');
        break;
      }
      prev_ts_name_index = ts_name_index;
    }

    if (i === lines.length - 1) {
      ts_type = 2;
      debugLog('默认进入暴力拆解模式');
    }
  }

  // 若全程无数字 .ts，默认暴力拆解
  if (ts_type === 0 && prev_ts_name_index === -1) {
    ts_type = 2;
    debugLog('未识别到递增序列，进入暴力拆解模式');
  }

   // ---------- 第二阶段：遍历过滤 ----------
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

    if (ts_type === 0) {
      // 模式 0：基于序列号的数字递增 .ts
      if (line.startsWith('#EXT-X-DISCONTINUITY') && lines[i + 1] && lines[i + 2]) {
        if (i > 0 && lines[i - 1].startsWith('#EXT-X-')) {
          result.push(line);
          continue;
        }
        const the_ts_name_len = lines[i + 2].indexOf('.ts');
        if (the_ts_name_len > 0) {
          if (the_ts_name_len - ts_name_len > ts_name_len_extend) {
            debugLog('过滤规则:#EXT-X-DISCONTINUITY-ts文件名长度', lines[i + 2]);
            if (lines[i + 3] && lines[i + 3].startsWith('#EXT-X-DISCONTINUITY')) {
              i += 3;
            } else {
              i += 2;
            }
            continue;
          }
          const the_ts_name_index = extractNumberBeforeTs(lines[i + 2]);
          if (the_ts_name_index !== undefined && the_ts_name_index !== null && the_ts_name_index !== prev_ts_name_index + 1) {
            debugLog('过滤规则:#EXT-X-DISCONTINUITY-ts序列号', lines[i + 2]);
            if (lines[i + 3] && lines[i + 3].startsWith('#EXT-X-DISCONTINUITY')) {
              i += 3;
            } else {
              i += 2;
            }
            continue;
          }
        }
      }

      if (line.startsWith('#EXTINF') && lines[i + 1]) {
        const the_ts_name_len = lines[i + 1].indexOf('.ts');
        if (the_ts_name_len > 0) {
          if (the_ts_name_len - ts_name_len > ts_name_len_extend) {
            debugLog('过滤规则:#EXTINF-ts文件名长度', lines[i + 1]);
            if (lines[i + 2] && lines[i + 2].startsWith('#EXT-X-DISCONTINUITY')) {
              i += 2;
            } else {
              i += 1;
            }
            continue;
          }
          const the_ts_name_index = extractNumberBeforeTs(lines[i + 1]);
          if (the_ts_name_index === prev_ts_name_index + 1) {
            prev_ts_name_index = the_ts_name_index;
          } else {
            debugLog('过滤规则:#EXTINF-ts序列号', lines[i + 1]);
            if (lines[i + 2] && lines[i + 2].startsWith('#EXT-X-DISCONTINUITY')) {
              i += 2;
            } else {
              i += 1;
            }
            continue;
          }
        }
      }
    } else if (ts_type === 1) {
      // 模式 1：哈希/非数字类 .ts，使用 EXTINF 重复 + DISCONTINUITY 判断
      if (line.startsWith('#EXTINF')) {
        if (line === first_extinf_row && the_same_extinf_name_n <= the_extinf_benchmark_n && the_ext_x_mode === 0) {
          the_same_extinf_name_n++;
        } else {
          the_ext_x_mode = 1;
        }
        if (the_same_extinf_name_n > the_extinf_benchmark_n) {
          the_ext_x_mode = 1;
        }
      }

      if (line.startsWith('#EXT-X-DISCONTINUITY')) {
        if (i > 0 && lines[i - 1].startsWith('#EXT-X-PLAYLIST-TYPE')) {
          result.push(line);
          continue;
        }
        if (lines[i + 1] && lines[i + 1].startsWith('#EXTINF') && lines[i + 2] && lines[i + 2].indexOf('.ts') > 0) {
          let the_ext_x_discontinuity_condition_flag = false;
          if (the_ext_x_mode === 1) {
            the_ext_x_discontinuity_condition_flag = lines[i + 1] !== first_extinf_row && the_same_extinf_name_n > the_extinf_benchmark_n;
          }
          if (lines[i + 3] && lines[i + 3].startsWith('#EXT-X-DISCONTINUITY') && the_ext_x_discontinuity_condition_flag) {
            debugLog('过滤规则:#EXT-X-DISCONTINUITY-广告-#EXT-X-DISCONTINUITY过滤');
            i += 3;
            continue;
          }
          debugLog('过滤规则:#EXT-X-DISCONTINUITY-单个标识过滤');
          continue;
        }
      }
    } else {
      // 模式 2：暴力拆解，只移除 DISCONTINUITY 标记
      if (line.startsWith('#EXT-X-DISCONTINUITY')) {
        if (i > 0 && lines[i - 1].startsWith('#EXT-X-PLAYLIST-TYPE')) {
          result.push(line);
          continue;
        }
        debugLog('过滤规则:#EXT-X-DISCONTINUITY-单个标识过滤');
        continue;
      }
    }

    result.push(line);
  }

  return result;
}

// ==================== eraycc 统计式广告过滤 ====================

/**
 * 可选正则预处理
 */
function applyRegexFilter(content, regexFilter) {
  try {
    const regex = new RegExp(regexFilter, 'gi');
    return content.replace(regex, '');
  } catch (e) {
    debugLog('正则过滤失败:', e);
    return content;
  }
}

/**
 * 解析 m3u8 结构为 segments/headers
 */
function parseM3U8Structure(content) {
  const lines = content.split('\n');
  const segments = [];
  const headers = { main: [], other: [] };
  let currentDiscontinuity = false;
  let currentMap = null;
  let segmentIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (i < 10 && !line.startsWith('#EXTINF') && line.startsWith('#EXT')) {
      headers.main.push(line);
      continue;
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      currentMap = line;
      continue;
    }

    if (line.includes('#EXT-X-DISCONTINUITY')) {
      currentDiscontinuity = true;
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      const durationMatch = line.match(/#EXTINF:([\d.]+)/);
      if (durationMatch && lines[i + 1] && !lines[i + 1].startsWith('#')) {
        const duration = parseFloat(durationMatch[1]);
        const url = lines[i + 1].trim();
        segments.push({
          index: segmentIndex++,
          startLine: i,
          endLine: i + 1,
          duration,
          url,
          hasDiscontinuity: currentDiscontinuity,
          hasMap: currentMap !== null,
          content: currentMap ? [currentMap, line, lines[i + 1]].join('\n') : [line, lines[i + 1]].join('\n'),
          isAd: false,
          adScore: 0
        });
        currentDiscontinuity = false;
        currentMap = null;
        i++;
      }
    } else if (line.startsWith('#')) {
      headers.other.push(line);
    }
  }

  return { segments, headers };
}

/**
 * 统计信息：均值、标准差、百分位等
 */
function calculateSegmentStats(segments) {
  const durations = segments.map(s => s.duration);
  const totalDuration = durations.reduce((sum, d) => sum + d, 0);
  const avgDuration = totalDuration / durations.length;
  const squaredDiffs = durations.map(d => Math.pow(d - avgDuration, 2));
  const stdDev = Math.sqrt(squaredDiffs.reduce((sum, sd) => sum + sd, 0) / durations.length);
  const sortedDurations = [...durations].sort((a, b) => a - b);

  return {
    avgDuration,
    stdDev,
    p10: sortedDurations[Math.floor(durations.length * 0.1)],
    p90: sortedDurations[Math.floor(durations.length * 0.9)],
    totalDuration,
    segmentCount: segments.length,
    durationRange: [sortedDurations[0], sortedDurations[sortedDurations.length - 1]]
  };
}

/**
 * 多维度片段分析
 */
function analyzeSegments(segments, stats) {
  const { avgDuration, stdDev, p10 } = stats;

  return segments.map(segment => {
    const deviation = Math.abs(segment.duration - avgDuration);
    const zScore = stdDev > 0 ? deviation / stdDev : 0;

    const durationAbnormality = Math.min(1, zScore / 3);
    let positionFactor = 0;
    if (segment.index < 3 && segment.duration < p10) {
      positionFactor = 0.8;
    } else if (segment.index > segments.length - 3 && segment.duration < p10) {
      positionFactor = 0.5;
    }

    const discontinuityFactor = segment.hasDiscontinuity ? 0.3 : 0;
    const adScore = Math.min(1,
      (durationAbnormality * 0.6) +
      (positionFactor * 0.3) +
      (discontinuityFactor * 0.1)
    );
    const isAd = adScore > 0.65;
    return {
      ...segment,
      adScore,
      isAd,
      stats: { deviation, zScore }
    };
  });
}

/**
 * 智能过滤决策
 */
function applyFilterDecision(segments, stats) {
  const { avgDuration, stdDev } = stats;
  const baseThreshold = 0.5;
  const dynamicThreshold = Math.min(0.8, Math.max(0.5,
    baseThreshold - (stdDev / Math.max(avgDuration, 0.01)) * 0.2
  ));

  const sortedByScore = [...segments].sort((a, b) => b.adScore - a.adScore || a.duration - b.duration);
  const keepCandidates = new Set();
  for (const segment of sortedByScore) {
    if (segment.adScore >= dynamicThreshold || segment.hasMap || segment.duration >= avgDuration) {
      keepCandidates.add(segment.index);
    }
  }

  return segments.filter(segment => {
    if (segment.isAd && segment.adScore > dynamicThreshold) return false;
    if (segment.duration < 1.0 && segment.index > 3) return false;
    if (segment.hasMap) return true;
    if (keepCandidates.has(segment.index)) return true;
    return segment.adScore <= dynamicThreshold && segment.index > 2 && segment.duration < avgDuration && segment.hasDiscontinuity;
  });
}

/**
 * 重建 m3u8
 */
function rebuildM3U8(headers, segments, originalContent) {
  const keepLines = new Set();
  headers.main.forEach((_, i) => keepLines.add(i));

  segments.forEach(segment => {
    for (let i = segment.startLine; i <= segment.endLine; i++) {
      keepLines.add(i);
    }
  });

  const lines = originalContent.split('\n');
  const criticalTags = [
    '#EXT-X-VERSION',
    '#EXT-X-TARGETDURATION',
    '#EXT-X-MEDIA-SEQUENCE',
    '#EXT-X-PLAYLIST-TYPE',
    '#EXT-X-ENDLIST'
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (criticalTags.some(tag => line.startsWith(tag))) {
      keepLines.add(i);
    }
  }

  const filteredLines = lines.filter((_, i) => keepLines.has(i));
  updateM3U8Headers(filteredLines, segments);
  return filteredLines.join('\n');
}

/**
 * 更新关键头部字段
 */
function updateM3U8Headers(lines, segments) {
  if (segments.length === 0) return;

  const maxDuration = Math.max(...segments.map(s => s.duration));
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-TARGETDURATION')) {
      lines[i] = `#EXT-X-TARGETDURATION:${Math.ceil(maxDuration)}`;
      break;
    }
  }

  if (segments[0].index > 0) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-MEDIA-SEQUENCE')) {
        lines[i] = `#EXT-X-MEDIA-SEQUENCE:${segments[0].index}`;
        break;
      }
    }
  }
}

/**
 * 超级过滤器入口
 */
function SuperFilterAdsFromM3U8(m3u8Content, regexFilter = null) {
  if (!m3u8Content) return '';

  let processedContent = regexFilter ? applyRegexFilter(m3u8Content, regexFilter) : m3u8Content;
  const { segments, headers } = parseM3U8Structure(processedContent);
  if (segments.length === 0) return processedContent;

  const stats = calculateSegmentStats(segments);
  const analyzedSegments = analyzeSegments(segments, stats);
  const filteredSegments = applyFilterDecision(analyzedSegments, stats);

  return rebuildM3U8(headers, filteredSegments, processedContent);
}

// ==================== 组合过滤(先 ltxlong 模式过滤，再 eraycc 统计过滤) ====================

function filterAds(content) {
  const lineFiltered = filterLines(content.split('\n')).join('\n');
  if (CONFIG.FILTER_ADS_STATISTICALLY) {
    return SuperFilterAdsFromM3U8(lineFiltered, CONFIG.FILTER_REGEX);
  }
  return lineFiltered;
}

// ==================== 播放列表处理(绝对链接，不代理) ====================

function processKeyLine(line, baseUrl) {
  return line.replace(/URI="([^"]+)"/, (match, uri) => {
    const absoluteUri = resolveUrl(baseUrl, uri);
    return `URI="${absoluteUri}"`;
  });
}

function processMapLine(line, baseUrl) {
  return line.replace(/URI="([^"]+)"/, (match, uri) => {
    const absoluteUri = resolveUrl(baseUrl, uri);
    return `URI="${absoluteUri}"`;
  });
}

function processMediaPlaylist(url, content) {
  const baseUrl = getBaseUrl(url);
  const lines = content.split('\n');
  const output = [];

  let isNextLineSegment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-KEY')) {
      output.push(processKeyLine(line, baseUrl));
      continue;
    }

    if (line.startsWith('#EXT-X-MAP')) {
      output.push(processMapLine(line, baseUrl));
      continue;
    }

    if (line.startsWith('#EXTINF')) {
      isNextLineSegment = true;
      output.push(line);
      continue;
    }

    if (isNextLineSegment && !line.startsWith('#')) {
      output.push(resolveUrl(baseUrl, line));
      isNextLineSegment = false;
      continue;
    }

    output.push(line);
  }

  const joined = output.join('\n');
  return filterAds(joined);
}

async function processMasterPlaylist(url, content, recursionDepth) {
  if (recursionDepth > CONFIG.MAX_RECURSION) {
    throw new Error(`Maximum recursion depth (${CONFIG.MAX_RECURSION}) exceeded`);
  }

  const baseUrl = getBaseUrl(url);
  const lines = content.split('\n');
  let variantUrl = '';

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j].trim();
        if (line && !line.startsWith('#')) {
          variantUrl = resolveUrl(baseUrl, line);
          break;
        }
      }
      if (variantUrl) break;
    }
  }

  if (!variantUrl) {
    throw new Error('No variant stream found in master playlist');
  }

  debugLog(`[Master playlist] selected variant: ${variantUrl}`);
  const variantContent = await fetchContent(variantUrl);
  return processM3u8Content(variantUrl, variantContent, recursionDepth + 1);
}

async function processM3u8Content(url, content, recursionDepth = 0) {
  if (content.includes('#EXT-X-STREAM-INF')) {
    debugLog(`[Master playlist detected] ${url}`);
    return processMasterPlaylist(url, content, recursionDepth);
  }

  debugLog(`[Media playlist] ${url}`);
  return processMediaPlaylist(url, content);
}

// ==================== WebUI ====================

const PLAYER_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>M3U8 Ad Strip - Player</title>
  <style>
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: radial-gradient(circle at top left, #1f2937, #0f172a);
      color: #f8fafc;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      width: 100%;
      max-width: 960px;
      background: rgba(15, 23, 42, 0.75);
      backdrop-filter: blur(18px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 24px;
      padding: 28px;
      box-shadow: 0 30px 80px rgba(0, 0, 0, 0.35);
    }
    .title { margin: 0 0 6px; font-size: 22px; font-weight: 700; }
    .subtitle { margin: 0 0 18px; color: #94a3b8; font-size: 13px; }
    video {
      width: 100%;
      border-radius: 16px;
      background: black;
    }
    .info { margin-top: 14px; color: #cbd5e1; font-size: 12px; line-height: 1.6; word-break: break-all; }
    .info code { background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 6px; font-size: 11px; }
    .error { color: #f87171; }
    .ok { color: #4ade80; }
    a { color: #38bdf8; }
  </style>
</head>
<body>
  <div class="card">
    <h1 class="title">M3U8 Ad Strip Player</h1>
    <p class="subtitle">正在播放去广告后的 m3u8。</p>
    <video id="player" controls playsinline></video>
    <div class="info" id="status"></div>
    <div class="info">
      提示：播放器会从 <code>/m3u8/&amp;lt;url&amp;gt;</code> 拉取处理后的 m3u8，不会代理 TS 片段。回到输入页请访问 <a href="/">/</a>。
    </div>
  </div>

  <script>
    function hlsLoadError() {
      document.getElementById('status').innerHTML = '<span class="error">错误：hls.js 加载失败，请检查是否能访问 https://cdn.jsdelivr.net/npm/hls.js@latest</span>';
    }
  </script>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest" onerror="hlsLoadError()"></script>
  <script>
    (function() {
      const statusEl = document.getElementById('status');
      function setStatus(text, isError) {
        statusEl.innerHTML = text;
        statusEl.classList.remove('ok', 'error');
        statusEl.classList.add(isError ? 'error' : 'ok');
      }

      try {
        const rawPath = decodeURIComponent(location.pathname || '');
        const rawQuery = decodeURIComponent(location.search || '');
        let original = '';
        if (rawPath.startsWith('/play/') && rawPath.length > 6) {
          original = rawPath.slice(6);
        } else {
          const queryUrl = new URLSearchParams(rawQuery).get('url');
          if (queryUrl) original = queryUrl;
        }

        const playerUrl = original ? (location.origin + '/m3u8/' + encodeURIComponent(original)) : null;

        if (!original) {
          setStatus('错误：缺少 m3u8 链接。请在首页输入链接后点击“直接播放”。', true);
          return;
        }

        if (typeof Hls === 'undefined') {
          setStatus('错误：hls.js 未加载，无法播放。', true);
          return;
        }

        const isNativeHls = document.createElement('video').canPlayType('application/vnd.apple.mpegurl');
        if (!Hls.isSupported() && !isNativeHls) {
          setStatus('错误：当前浏览器不支持 HLS 播放。', true);
          return;
        }

        setStatus('原始链接：<code>' + original + '</code><br/>播放器正在加载：<code>' + playerUrl + '</code>');
        const video = document.getElementById('player');

        if (Hls.isSupported()) {
          const hls = new Hls({ debug: false });
          hls.loadSource(playerUrl);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            setStatus('HLS 解析成功，开始播放。', false);
            video.play().catch(() => {});
          });
          hls.on(Hls.Events.ERROR, (event, data) => {
            let msg = 'HLS 播放错误：' + data.type + ' / ' + data.details;
            if (data.response && data.response.code) {
              msg += ' (HTTP ' + data.response.code + ')';
            }
            setStatus(msg, true);
          });
        } else if (isNativeHls) {
          video.src = playerUrl;
          video.addEventListener('loadedmetadata', () => {
            setStatus('原生 HLS 加载成功。', false);
            video.play().catch(() => {});
          }, { once: true });
          video.addEventListener('error', () => {
            setStatus('原生 HLS 播放错误。', true);
          }, { once: true });
        }
      } catch (err) {
        setStatus('播放器初始化错误：' + err.message, true);
        console.error(err);
      }
    })();
  </script>
</body>
</html>
`;

const HOME_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>M3U8 Ad Strip</title>
  <style>
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: radial-gradient(circle at top left, #1f2937, #0f172a);
      color: #f8fafc;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      width: 100%;
      max-width: 720px;
      background: rgba(15, 23, 42, 0.75);
      backdrop-filter: blur(18px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 24px;
      padding: 28px;
      box-shadow: 0 30px 80px rgba(0, 0, 0, 0.35);
    }
    .title { margin: 0 0 6px; font-size: 28px; font-weight: 700; }
    .subtitle { margin: 0 0 22px; color: #94a3b8; font-size: 14px; }
    .row { display: flex; gap: 12px; }
    input[type="url"] {
      flex: 1;
      height: 48px;
      padding: 0 16px;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(15, 23, 42, 0.6);
      color: #f8fafc;
      font-size: 14px;
      outline: none;
    }
    input[type="url"]:focus {
      border-color: rgba(56, 189, 248, 0.7);
      box-shadow: 0 0 0 4px rgba(56, 189, 248, 0.12);
    }
    button {
      height: 48px;
      padding: 0 22px;
      border-radius: 12px;
      border: none;
      background: linear-gradient(135deg, #38bdf8, #818cf8);
      color: white;
      font-weight: 600;
      font-size: 14px;
      cursor: pointer;
    }
    button:hover { opacity: 0.92; }
    button:active { transform: scale(0.98); }
    .note { margin-top: 14px; color: #cbd5e1; font-size: 12px; line-height: 1.6; }
    .note code { background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 6px; font-size: 11px; }
  </style>
</head>
<body>
  <div class="card">
    <h1 class="title">M3U8 Ad Strip</h1>
    <p class="subtitle">输入原始 m3u8 链接，选择获取纯净 m3u8 或直接播放。</p>
    <form id="homeForm" class="row">
      <input id="urlInput" type="url" placeholder="https://example.com/path/video.m3u8" required />
      <button type="submit" name="action" value="m3u8">获取 M3U8</button>
      <button type="submit" name="action" value="play">直接播放</button>
    </form>
    <p class="note">
      提示：请输入可公网访问的 m3u8 链接。<br/>
      - <code>/m3u8/&lt;url&gt;</code>：返回去广告后的纯净 m3u8（绝对链接）。<br/>
      - <code>/play/&lt;url&gt;</code>：在线播放器页面。<br/>
      也可直接访问这两个路径，或使用 <code>?url=</code> 参数。
    </p>
  </div>
  <script>
    const form = document.getElementById('homeForm');
    const input = document.getElementById('urlInput');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const raw = input.value.trim();
      if (!raw) return;
      const encoded = encodeURIComponent(raw);
      const action = (e.submitter && e.submitter.value) || 'm3u8';
      window.location.href = '/' + action + '/' + encoded;
    });
  </script>
</body>
</html>
`;

// ==================== 请求路由 ====================

function getTargetUrl(url) {
  if (url.searchParams.has('url')) {
    return url.searchParams.get('url');
  }
  const pathMatch = url.pathname.match(/^\/(m3u8|play)\/(.+)/);
  if (pathMatch && pathMatch[1]) {
    return decodeURIComponent(pathMatch[2]);
  }
  return null;
}

function createM3u8Response(content, targetUrl) {
  const responseHeaders = new Headers({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/vnd.apple.mpegurl',
    'X-Content-Type-Options': 'nosniff'
  });

  // 保留原始 URL 的 host 便于调试
  if (targetUrl) {
    try { responseHeaders.set('X-Original-Url', targetUrl); } catch (_) {}
  }

  return new Response(content, {
    status: 200,
    headers: responseHeaders
  });
}

async function handleRequest(request) {
  const requestUrl = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400'
      }
    });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  if (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html') {
    return new Response(HOME_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  if (requestUrl.pathname === '/play' || requestUrl.pathname.startsWith('/play/')) {
    const targetUrl = getTargetUrl(requestUrl);
    if (!targetUrl) {
      return new Response('Missing m3u8 URL. Visit / or use /play/<url>.', {
        status: 400,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }

    return new Response(PLAYER_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }

  const targetUrl = getTargetUrl(requestUrl);
  if (!targetUrl) {
    return new Response('Missing m3u8 URL. Visit / or use /m3u8/<url>.', {
      status: 400,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }

  try {
    debugLog(`[Processing] ${targetUrl}`);
    const { content, contentType } = await fetchContentWithType(targetUrl);

    if (!isM3u8Content(content, contentType)) {
      return Response.redirect(targetUrl, 302);
    }

    const processed = await processM3u8Content(targetUrl, content, 0);
    debugLog(`[Done] ${targetUrl}`);
    return createM3u8Response(processed, targetUrl);
  } catch (error) {
    console.error(`[m3u8-ad-strip][Error] ${error.message}`);
    return new Response(`Failed to process m3u8: ${error.message}`, {
      status: 502,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request);
  }
};
