'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

test('browser graph lays out nodes without a separate layout script or global', () => {
  const window = { G6: {} };
  const source = fs.readFileSync(path.join(__dirname, '../forecast-graph.js'), 'utf8');
  vm.runInNewContext(source, { window, console });
  assert.equal(typeof window.ForecastGraph, 'function');
  delete window.ForecastLayout;
  const graph = Object.create(window.ForecastGraph.prototype);
  Object.assign(graph, {
    nodes: [{ code: 'TOP', level: 0 }, { code: 'LOW', level: 1 }],
    edges: [{ source: 'TOP', target: 'LOW' }], cluster: 'none',
    el: { getBoundingClientRect: () => ({ width: 1000, height: 700 }) }
  });
  const top = graph._presetPos(graph.nodes[0]), lower = graph._presetPos(graph.nodes[1]);
  assert.ok(top.every(Number.isFinite)); assert.ok(lower.every(Number.isFinite));
  assert.ok(top[1] < lower[1]);
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.ok(!html.includes('src="forecast-layout.js"'));
  assert.ok(html.indexOf('src="forecast-graph.js"') < html.indexOf('src="forecast-app.js"'));
});
