// 本地测试：用 mock fetch 验证 worker 的路由 /m3u8、/play、主页两按钮
import worker from './worker.js';

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

const sampleMasterM3u8 = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=1280000
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=640000
480p/index.m3u8`;

const fakeResponses = {
  'https://xx.com/xx/video.m3u8': sampleAdM3u8,
  'https://xx.com/xx/master.m3u8': sampleMasterM3u8,
  'https://xx.com/xx/720p/index.m3u8': sampleAdM3u8
};

globalThis.fetch = async (url, opts) => {
  const u = typeof url === 'string' ? url : url.url;
  const body = fakeResponses[u];
  if (body === undefined) {
    return { ok: false, status: 404, statusText: 'Not Found', headers: { get: () => '' }, text: async () => '' };
  }
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (k) => k.toLowerCase() === 'content-type' ? 'application/vnd.apple.mpegurl' : '' },
    text: async () => body
  };
};

function urlFor(pathOrUrl) {
  if (/^https?:\/\//i.test(pathOrUrl)) return 'https://worker.dev/m3u8/' + encodeURIComponent(pathOrUrl);
  return 'https://worker.dev' + pathOrUrl;
}

async function run() {
  let passed = 0;
  let failed = 0;
  function assert(cond, msg) {
    if (cond) { passed++; console.log('  ✅', msg); }
    else { failed++; console.log('  ❌', msg); }
  }

  console.log('[测试 1] /m3u8 去广告 + 绝对链接');
  const req1 = new Request(urlFor('https://xx.com/xx/video.m3u8'));
  const res1 = await worker.fetch(req1);
  const text1 = await res1.text();
  assert(res1.status === 200, '状态码 200');
  assert(res1.headers.get('Content-Type').includes('mpegurl'), 'Content-Type 为 mpegurl');
  assert(res1.headers.get('Access-Control-Allow-Origin') === '*', 'CORS 通配');
  assert(!text1.includes('ad001.ts'), '广告片段 ad001 被移除');
  assert(!text1.includes('ad002.ts'), '广告片段 ad002 被移除');
  assert(text1.startsWith('#EXTM3U'), '保留 #EXTM3U 头');
  assert(text1.includes('#EXT-X-ENDLIST'), '保留 #EXT-X-ENDLIST');
  assert(text1.includes('https://xx.com/xx/7e5d00293ac5c7bfc009d3c89919d5ff.ts'), '正片片段变绝对链接');
  assert(text1.includes('#EXTINF:7.500000,'), '保留正片 EXTINF');
  assert(!text1.includes('/m3u8/https'), '视频片段未被代理');

  console.log('\n[测试 2] master playlist 递归');
  const req2 = new Request(urlFor('https://xx.com/xx/master.m3u8'));
  const res2 = await worker.fetch(req2);
  const text2 = await res2.text();
  assert(res2.status === 200, 'master 递归状态码 200');
  assert(text2.startsWith('#EXTM3U'), 'master 递归后返回 media playlist');
  assert(!text2.includes('#EXT-X-STREAM-INF'), '不再含 STREAM-INF');
  assert(text2.includes('https://xx.com/xx/720p/'), '子列表片段为绝对链接');

  console.log('\n[测试 3] /m3u8?url= 查询参数');
  const req3 = new Request('https://worker.dev/m3u8?url=' + encodeURIComponent('https://xx.com/xx/video.m3u8'));
  const res3 = await worker.fetch(req3);
  const text3 = await res3.text();
  assert(res3.status === 200, '?url= 状态码 200');
  assert(text3.includes('https://xx.com/xx/7e5d00293ac5c7bfc009d3c89919d5ff.ts'), '?url= 方式绝对链接正确');

  console.log('\n[测试 4] 主页');
  const req4 = new Request('https://worker.dev/');
  const res4 = await worker.fetch(req4);
  const text4 = await res4.text();
  assert(res4.status === 200, '主页状态码 200');
  assert(res4.headers.get('Content-Type').includes('text/html'), '主页 Content-Type 为 html');
  assert(text4.includes('M3U8 Ad Strip'), '主页含标题');
  assert(text4.includes('获取 M3U8'), '主页有获取按钮');
  assert(text4.includes('直接播放'), '主页有播放按钮');
  assert(text4.includes('/m3u8/'), '主页说明含 /m3u8/');
  assert(text4.includes('/play/'), '主页说明含 /play/');
  assert(text4.includes("window.location.href = '/' + action + '/' + encoded"), '主页按钮提交生成 /m3u8/ 或 /play/');

  console.log('\n[测试 5] /play 播放页');
  const req5 = new Request('https://worker.dev/play/' + encodeURIComponent('https://xx.com/xx/video.m3u8'));
  const res5 = await worker.fetch(req5);
  const text5 = await res5.text();
  assert(res5.status === 200, '播放页状态码 200');
  assert(res5.headers.get('Content-Type').includes('text/html'), '播放页 html');
  assert(text5.includes('M3U8 Ad Strip Player'), '播放页标题');
  assert(text5.includes('hls.js'), '播放页 hls.js');
  assert(text5.includes('/m3u8/'), '播放页指向 /m3u8/');

  console.log('\n[测试 6] /play?url= 查询参数');
  const req6 = new Request('https://worker.dev/play?url=' + encodeURIComponent('https://xx.com/xx/video.m3u8'));
  const res6 = await worker.fetch(req6);
  const text6 = await res6.text();
  assert(res6.status === 200, '播放页 ?url= 状态码 200');
  assert(text6.includes('/m3u8/'), '播放页 ?url= 指向 /m3u8/');

  console.log('\n[测试 7] 缺少 url 参数');
  const req7 = new Request('https://worker.dev/m3u8/');
  const res7 = await worker.fetch(req7);
  assert(res7.status === 400, '缺少 url 返回 400');

  console.log('\n[测试 8] OPTIONS 预检');
  const req8 = new Request('https://worker.dev/m3u8/xxx', { method: 'OPTIONS' });
  const res8 = await worker.fetch(req8);
  assert(res8.status === 204, 'OPTIONS 返回 204');
  assert(res8.headers.get('Access-Control-Allow-Origin') === '*', 'OPTIONS CORS');

  console.log(`\n========== 通过 ${passed} / 失败 ${failed} ==========`);
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
