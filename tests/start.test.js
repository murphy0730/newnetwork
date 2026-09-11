'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const root = path.resolve(__dirname, '..');

function launch(port, env) {
  const child = spawn('cmd.exe', ['/d', '/c', `call start.cmd ${port}`], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST: '127.0.0.1', TOWER_NO_PAUSE: '1', ...env }
  });
  child.output = '';
  child.stdout.on('data', b => { child.output += b.toString(); });
  child.stderr.on('data', b => { child.output += b.toString(); });
  child.finished = once(child, 'exit').then(([code]) => code);
  return child;
}
async function exit(child) {
  let timer;
  try { return await Promise.race([child.finished, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Launcher timeout: ' + child.output)), 10000); })]); }
  finally { clearTimeout(timer); }
}
async function stop(child) {
  if (child.exitCode !== null) return;
  const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  const [code] = await once(killer, 'exit');
  assert.equal(code, 0, 'Windows must allow cleanup of the test process tree');
}

test('Windows launcher starts service, accepts repeat starts, rejects other services and invalid ports', { skip: process.platform !== 'win32', timeout: 45000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-launcher-'));
  const listener = http.createServer((req, res) => res.end('another application'));
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port;
  t.after(() => listener.close());
  const env = { DB_PATH: path.join(dir, 'isolated.sqlite'), API_ADMIN_TOKEN: '', API_PLANNER_TOKEN: '', API_VIEWER_TOKEN: '' };
  const conflict = launch(port, env); t.after(() => stop(conflict));
  assert.equal(await exit(conflict), 1, conflict.output);
  assert.match(conflict.output, /start.cmd 9000/);
  await new Promise(resolve => listener.close(resolve));

  const running = launch(port, env); t.after(() => stop(running));
  const url = 'http://127.0.0.1:' + port;
  let ready = false;
  for (let n = 0; n < 100; n++) {
    if (running.exitCode !== null) throw Error(running.output);
    try { ready = (await fetch(url + '/api/ready', { signal: AbortSignal.timeout(500) })).ok; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, running.output);
  assert.equal((await fetch(url + '/')).status, 200);
  assert.equal((await (await fetch(url + '/api/meta')).json()).revision, 0);
  const repeated = launch(port, env); t.after(() => stop(repeated));
  assert.equal(await exit(repeated), 0, repeated.output);
  assert.ok(repeated.output.includes(url));
  assert.equal(running.exitCode, null);
  assert.equal((await fetch(url + '/api/ready')).status, 200);
  for (const value of ['invalid', '0', '65536']) {
    const invalid = launch(value, env); t.after(() => stop(invalid));
    assert.equal(await exit(invalid), 1, invalid.output);
    assert.match(invalid.output, /1–65535/);
  }
  const script = fs.readFileSync(path.join(root, 'start.cmd'), 'utf8');
  assert.ok(!/(?<!\r)\n/.test(script), 'cmd must retain CRLF');
});
