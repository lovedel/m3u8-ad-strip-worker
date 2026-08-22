/**
 * Node.js HTTP/HTTPS 部署入口
 *
 * 复用 worker.js 的 fetch 处理器，所以行为与 Cloudflare Worker 完全一致：
 *   - /m3u8/<url> 或 /m3u8?url=<url>：返回去广告后的 m3u8
 *   - /play/<url> 或 /play?url=<url>：返回带 hls.js 的播放页
 *   - /：主页
 *
 * 启动：
 *   node node-server.mjs [PORT]
 *
 * 默认监听 0.0.0.0:3099。
 */

import http from 'http';
import { URL } from 'url';
import worker from './worker.js';

const PORT = parseInt(process.argv[2], 10) || 3099;
const HOST = process.env.HOST || '0.0.0.0';

async function nodeRequestToFetch(req, res) {
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `${HOST}:${PORT}`;
  const url = new URL(req.url, `${protocol}://${host}`);

  // Node.js 的 IncomingMessage 没有 ReadableStream 接口，
  // GET/HEAD 请求通常没有 body；若需要支持 body 可以在这里扩展。
  const init = {
    method: req.method,
    headers: req.headers,
  };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = req;
  }

  const request = new Request(url.toString(), init);
  const response = await worker.fetch(request);
  res.statusCode = response.status;
  res.statusMessage = response.statusText;

  for (const [key, value] of response.headers.entries()) {
    res.setHeader(key, value);
  }

  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  }

  res.end();
}

const server = http.createServer((req, res) => {
  nodeRequestToFetch(req, res).catch((err) => {
    console.error('[node-server error]', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end(`Internal Server Error: ${err.message}`);
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`M3U8 Ad Strip Node server running at http://${HOST}:${PORT}`);
});
