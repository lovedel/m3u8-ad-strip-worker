// 验证 Node HTTP 服务器：mock fetch 后启动服务，用本地 HTTP 请求测试各路由
const sampleAdM3u8 = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:8
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-DISCONTINUITY
#EXTINF:4.000000,
ad001.ts
#EXTINF:4.000000,
ad002.ts
#EXT-X-DISCONTINUITY
#EXTINF:7.500000,
7e5d00293ac5c7bfc009d3c89919d5ff.ts
#EXTINF:7.500000,
7e5d00293ac5c7bfc009d3c89919d5ff1.ts
#EXTINF:7.500000,
7e5d00293ac5c7bfc009d3c89919d5ff2.ts
#EXT-X-ENDLIST`;

const fakeResponses = {
  'https://xx.com/xx/video.m3u8': sampleAdM3u8
};

globalThis.fetch = async (url, opts) => {
  const u = typeof url === 'string' ? url : url.url;
  const body = fakeResponses[u];
  if (body === undefined) {
    return new Response('', { status: 404, statusText: 'Not Found' });
  }
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/vnd.apple.mpegurl' }
  });
};

// 动态导入 worker（此时 globalThis.fetch 已就绪）
const worker = (await import('./worker.js')).default;
const http = await import('http');

const PORT = 4099;
const server = http.createServer((req, res) => {
  const protocol = 'http';
  const host = req.headers.host || `localhost:${PORT}`;
  const url = new URL(req.url, `${protocol}://${host}`);
  const request = new Request(url.toString(), { method: req.method, headers: req.headers });
  worker.fetch(request).then((response) => {
    res.statusCode = response.status;
    for (const [key, value] of response.headers.entries()) {
      res.setHeader(key, value);
    }
    response.text().then((body) => {
      res.end(body);
    });
  }).catch((err) => {
    res.statusCode = 500;
    res.end(err.message);
  });
});

await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}${path}`, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg); }
  else { failed++; console.log('  ❌', msg); }
}

console.log('[测试 1] /m3u8 路径');
const r1 = await get('/m3u8/' + encodeURIComponent('https://xx.com/xx/video.m3u8'));
assert(r1.status === 200, '状态码 200');
assert(r1.headers['content-type'].includes('mpegurl'), 'Content-Type mpegurl');
assert(!r1.body.includes('ad001.ts') && !r1.body.includes('ad002.ts'), '广告被移除');
assert(r1.body.includes('https://xx.com/xx/7e5d00293ac5c7bfc009d3c89919d5ff.ts'), '正片绝对链接');

console.log('\n[测试 2] /m3u8?url= 查询参数');
const r2 = await get('/m3u8?url=' + encodeURIComponent('https://xx.com/xx/video.m3u8'));
assert(r2.status === 200, '?url= 状态码 200');
assert(r2.body.includes('https://xx.com/xx/7e5d00293ac5c7bfc009d3c89919d5ff.ts'), '?url= 绝对链接');

console.log('\n[测试 3] 主页');
const r3 = await get('/');
assert(r3.status === 200, '主页 200');
assert(r3.headers['content-type'].includes('text/html'), '主页 html');
assert(r3.body.includes('获取 M3U8') && r3.body.includes('直接播放'), '主页双按钮');

console.log('\n[测试 4] /play 播放页');
const r4 = await get('/play/' + encodeURIComponent('https://xx.com/xx/video.m3u8'));
assert(r4.status === 200, '播放页 200');
assert(r4.body.includes('hls.js'), '播放页 hls.js');
assert(r4.body.includes('/m3u8/'), '播放页指向 /m3u8/');

console.log('\n[测试 5] /play?url= 查询参数');
const r5 = await get('/play?url=' + encodeURIComponent('https://xx.com/xx/video.m3u8'));
assert(r5.status === 200, '播放页 ?url= 200');
assert(r5.body.includes('/m3u8/'), '播放页 ?url= 指向 /m3u8/');

console.log('\n[测试 6] 缺少 url');
const r6 = await get('/m3u8/');
assert(r6.status === 400, '缺少 url 返回 400');

console.log(`\n========== 通过 ${passed} / 失败 ${failed} ==========`);
server.close();
if (failed > 0) process.exit(1);
