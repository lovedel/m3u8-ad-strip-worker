# M3U8 Ad Strip (Cloudflare Worker)

参考 [ltxlong/M3U8-Filter-Ad-Script](https://github.com/ltxlong/M3U8-Filter-Ad-Script) 与 [eraycc/m3u8-proxy-script](https://github.com/eraycc/m3u8-proxy-script) 实现的 Cloudflare Worker 脚本。

## 功能

1. **去广告**：结合 ltxlong 的模式识别算法与 eraycc 的统计学分析算法，过滤 m3u8 中的插播广告片段。
2. **绝对链接**：不代理/缓存视频片段，仅把 m3u8 中的相对片段链接改写成绝对链接。
3. **WebUI**：主页提供输入框，可选择：
   - **获取 M3U8** → 返回纯净的 `application/vnd.apple.mpegurl`。
   - **直接播放** → 打开 `/play/<url>` 页面，内置 hls.js 播放器。

## 路由

| 路由 | 说明 |
|------|------|
| `/` | 主页，输入 m3u8 链接 |
| `/m3u8/<url>` 或 `/m3u8?url=<url>` | 返回去广告后的 m3u8 |
| `/play/<url>` 或 `/play?url=<url>` | 在线播放页面 |

> `<url>` 需经过 `encodeURIComponent` 编码。

## 部署

1. 登录 [Cloudflare Workers](https://dash.cloudflare.com/)。
2. 创建新的 Worker。
3. 将 `worker.js` 的内容复制到 Worker 编辑器中。
4. 保存并部署。

无需 KV、无需额外依赖。

## 本地测试

需要 Node.js 18+：

```bash
cd m3u8-ad-strip
node --check worker.js
node test-worker.mjs
```

## 注意事项

- 不代理/缓存 TS 片段，只返回带绝对链接的 m3u8。
- 主播放列表（master playlist）会自动递归解析到第一个子播放列表。
- 过滤算法相对保守，尽量避免误删正片。
