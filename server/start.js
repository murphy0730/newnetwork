'use strict';
// The launcher also handles repeated double-clicks without stopping a live service.
const http = require('node:http');

function health(host, port) {
  return new Promise(resolve => {
    let done = false;
    const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    const req = http.get({ hostname: host, port, path: '/api/health' }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; if (body.length > 16384) { finish({ occupied: true }); req.destroy(); } });
      res.on('end', () => {
        let data;
        try { data = JSON.parse(body); } catch {}
        finish({ occupied: true, tower: res.statusCode === 200 && data?.ok === true && data?.engine === 'prebuilt-artifact', data });
      });
      res.on('error', () => finish({ occupied: true }));
    });
    const timer = setTimeout(() => { finish({ occupied: true }); req.destroy(); }, 3000);
    req.on('error', error => finish({ occupied: error.code !== 'ECONNREFUSED', error }));
  });
}

async function start() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw Error(`当前 Node.js ${process.version} 不支持此服务，请安装 Node.js 24 或更高版本。`);
  const raw = process.argv[2] || '8787';
  if (!/^\d{1,5}$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) throw Error('端口必须是 1–65535 的整数。例如：start.cmd 9000');
  process.env.PORT = String(Number(raw));
  const host = process.env.HOST || '127.0.0.1';
  const probeHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  const url = `http://${probeHost.includes(':') ? '[' + probeHost + ']' : probeHost}:${process.env.PORT}/`;
  const result = await health(probeHost, Number(raw));
  if (result.tower) {
    if (result.data.loadError) throw Error(`控制塔已在运行，但数据装载失败：${result.data.loadError}。请打开 ${url} 检查数据管理。`);
    console.log(`[start] 控制塔已在运行${result.data.ready ? '' : '，正在装载数据'}，无需重复启动。\n[start] 请在浏览器打开 ${url}`);
    return;
  }
  if (result.occupied) throw Error(`无法在 ${url} 启动：端口已被占用或现有服务未正常响应${result.error ? '（' + result.error.message + '）' : ''}。请检查原服务窗口，或使用 start.cmd 9000 选择其他端口。`);
  console.log(`[start] 正在启动控制塔，访问地址：${url}\n[start] 请保持此窗口打开；按 Ctrl+C 停止服务。`);
  require('./main');
}

start().catch(error => { console.error('[start] ' + error.message); process.exitCode = 1; });
