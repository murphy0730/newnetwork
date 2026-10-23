'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const C = require('../forecast-core'), Engine = require('../server/engine'), { Service } = require('../server/service');
const month = '2026-09', version = '2026-09-24', modes = ['direct', 'cross', 'top'];
function fixture(nodes, edges) {
  const s = C.empty();
  for (const [code, dept, qty] of nodes) {
    if (dept !== null) s.tables.attributes.push({ code, make_dept: dept, lead_mean: 1 });
    if (qty !== null) forecast(s, code, qty);
  }
  edges.forEach(([parent, child, qty = 1, parent_template = 'AI', child_template = 'AI'], i) => s.tables.bom.push({ id: String(i), parent, child, qty, parent_template, child_template }));
  return s;
}
function forecast(s, code, qty, m = month, v = version) { s.tables.forecast.push({ code, qty, month: m, plan_date: v, site_code: 'S' }); }
function chain({ a = 100, b = 80, ad = 'X', bd = 'X', cd = 'X' } = {}) { return fixture([['A', ad, a], ['B', bd, b], ['C', cd, 50]], [['A', 'B'], ['B', 'C']]); }
function service(engine) {
  const s = Object.create(Service.prototype);
  s.context = q => ({ engine, month: q.month || month, mode: q.mode, source: q.source || 'forecast', trace: { revision: 0, version } });
  return s;
}
const same = (d, g, partial = false) => modes.map(() => [d, g, partial]);
const cases = [];
const add = (id, title, conditions, build, expected, extra = {}) => cases.push({ id, title, conditions, build, expected, ...extra });
add('S1', '全部有预测，同产业', 'A/B/C均属X；A=100、B=80、C=50。', () => chain(), [[80, 30], [100, 50], [100, 50]]);
add('S2', '全部有预测，跨产业边界B', 'A/B属X，C属Y；A=100、B=80、C=50。', () => chain({ cd: 'Y' }), [[80, 30], [80, 30], [100, 50]]);
add('S3', '同产业，中间B无预测', 'A/B/C属X；A=100、C=50，B当月无记录且本版本全无记录。', () => chain({ b: null }), [[0, -50], [100, 50], [100, 50]]);
add('S4', '跨产业，中间边界B无预测', 'A/B属X，C属Y；A=100、C=50，B无记录。', () => chain({ b: null, cd: 'Y' }), [[0, -50], [100, 50], [100, 50]]);
add('S5', 'B无制造属性维护行', 'A属X、C属Y；B无预测、无表6，归为未知部门；A=100、C=50。', () => chain({ b: null, bd: null, cd: 'Y' }), [[0, -50], [100, 50], [100, 50]]);
add('S6', 'B制造部门为空', 'A属X、C属Y；B有表6但make_dept为空、无预测，归为未知部门。', () => chain({ b: null, bd: '', cd: 'Y' }), [[0, -50], [100, 50], [100, 50]]);
add('S7', '上游全部无预测', 'A/B/C属X；A、B在本版本全无预测；C=50。', () => chain({ a: null, b: null }), [[0, -50], [null, null], [null, null]]);
add('S8', '连续两层无预测', 'A→B1→B2→C，全部属X；A=100、C=50，B1/B2无预测。', () => fixture([['A', 'X', 100], ['B1', 'X', null], ['B2', 'X', null], ['C', 'X', 50]], [['A', 'B1'], ['B1', 'B2'], ['B2', 'C']]), [[0, -50], [100, 50], [100, 50]]);
add('S9', '已知正数与未知路径混合', 'B1→C、D→B2→C，全部属X；B1=30、C=50，D/B2无预测。', () => fixture([['B1', 'X', 30], ['D', 'X', null], ['B2', 'X', null], ['C', 'X', 50]], [['B1', 'C'], ['D', 'B2'], ['B2', 'C']]), [[30, -20], [30, -20, true], [30, -20, true]]);
add('S10', '汇聚DAG与配比乘积', 'P1→M×2、P2→M×3、M→C×1，全部属X；P1=10、P2=20、C=5，M无预测。', () => fixture([['P1', 'X', 10], ['P2', 'X', 20], ['M', 'X', null], ['C', 'X', 5]], [['P1', 'M', 2], ['P2', 'M', 3], ['M', 'C']]), [[0, -5], [80, 75], [80, 75]]);
add('S11', '边界B显式预测0', 'A/B属X，C属Y；A=100、B有记录且qty=0、C=50。', () => chain({ b: 0, cd: 'Y' }), [[0, -50], [0, -50], [100, 50]]);
add('S12', 'POC上游排除，未知部门AI编码成为新根', 'A(POC)→B(AI)→C(AI)；A/B无预测且无表6，C属X、预测50。对应02233VXE→02302155→下层的根变化。', () => fixture([['A', null, null], ['B', null, null], ['C', 'X', 50]], [['A', 'B', 1, 'POC', 'AI'], ['B', 'C']]), [[0, -50], [null, null], [null, null]]);
add('S13', '非AI中间层断链', 'A(AI)→B(POC)→C(AI)，A/B属Y、C属X；预测100/80/50。两条边不参与，不跨B重连。', () => fixture([['A', 'Y', 100], ['B', 'Y', 80], ['C', 'X', 50]], [['A', 'B', 1, 'AI', 'POC'], ['B', 'C', 1, 'POC', 'AI']]), same(null, 0));
add('S14', '同编码AI/POC模板冲突保留', 'A/B属X，C属Y；B作为子项模板AI、作为父项模板POC，提示并保留；预测100/80/50。', () => { const s = chain({ cd: 'Y' }); s.tables.bom[1].parent_template = 'POC'; return s; }, [[80, 30], [80, 30], [100, 50]]);
add('S15', '模板缺失保留，继续跳过无预测边界', 'A/B属X，C属Y；B无预测、两处模板都为空，提示并保留；A=100、C=50。', () => { const s = chain({ b: null, cd: 'Y' }); s.tables.bom[0].child_template = ''; s.tables.bom[1].parent_template = ''; return s; }, [[0, -50], [100, 50], [100, 50]]);
add('S16', '空模板与POC混用保留', 'A/B属X，C属Y；B子项模板空、父项模板POC，记录缺失和冲突并保留；预测100/80/50。', () => { const s = chain({ cd: 'Y' }); s.tables.bom[0].child_template = ''; s.tables.bom[1].parent_template = 'POC'; return s; }, [[80, 30], [80, 30], [100, 50]]);
add('S17', '新AI根有预测，同产业回退到新根', 'A(POC)→B(AI)→C(AI)，全部属X，预测100/80/50；有效根为B。', () => { const s = chain(); s.tables.bom[0].parent_template = 'POC'; return s; }, same(80, 30));
add('S18', '所有编码都归未知部门', 'A/B/C均无表6维护行，预测100/80/50；本例为表6全空，导入范围预处理跳过。未知部门之间是同产业。', () => chain({ ad: null, bd: null, cd: null }), [[80, 30], [100, 50], [100, 50]]);
add('S19', '上游显式0，中间无预测', '全部属X；A有记录且为0，B无记录，C=50。B上游需求不为正，不标透传。', () => chain({ a: 0, b: null }), same(0, -50));
add('S20', '已知0与未知路径混合', 'P(Y)=0→C(X)=50；D(Z,无记录)→B(X,无记录)→C。显式0是已知贡献。', () => fixture([['P', 'Y', 0], ['D', 'Z', null], ['B', 'X', null], ['C', 'X', 50]], [['P', 'C'], ['D', 'B'], ['B', 'C']]), [[0, -50], [0, -50, true], [0, -50, true]]);
add('S21', '跳过边界后返回目标产业', 'D(Z,200)→A(X,100)→B(Y,无记录)→C(X,50)。cross始终相对C的X产业查找，因此取D。', () => fixture([['D', 'Z', 200], ['A', 'X', 100], ['B', 'Y', null], ['C', 'X', 50]], [['D', 'A'], ['A', 'B'], ['B', 'C']]), [[0, -50], [200, 150], [200, 150]]);
add('S22', '本月缺失，其他月份有预测', 'A/B属X，C属Y；9月A/B无记录、C=50；同版本10月A=100。9月来源仍未知。', () => { const s = chain({ a: null, b: null, cd: 'Y' }); forecast(s, 'A', 100, '2026-10'); return s; }, [[0, -50], [null, null], [null, null]]);
add('S23', '其他版本预测不混入', 'A(X)→C(Y)，本版本9月只有C=50；A=999属于2025-01-01版本。', () => { const s = fixture([['A', 'X', null], ['C', 'Y', 50]], [['A', 'C']]); forecast(s, 'A', 999, month, '2025-01-01'); return s; }, [[0, -50], [null, null], [null, null]]);
function adjusted(mode) {
  const s = fixture([['A', 'Y', 100], ['C', 'X', 50]], [['A', 'C']]); s.config.input_mode = mode;
  s.tables.adjust.push({ code: 'A', direction: '使用', month, qty: 120 }, { code: 'C', direction: '供应', month, qty: 10 }, { code: 'C', direction: '使用', month, qty: 5 });
  s.tables.inventory.push({ code: 'C', date: month + '-01', qty: 10 }); return s;
}
add('S24', 'raw模式调整与负净需求', 'A(Y)预测100、使用剔除120；C(X)预测50、供应添加10、使用剔除5、库存10。上游净需求-20按绝对值20折算。', () => adjusted('raw'), same(20, -35), { coverage: -45 });
add('S25', 'net模式不重复应用表2', '与S24相同输入，但input_mode=net，所有表2调整不重复应用。', () => adjusted('net'), same(100, 50), { coverage: 40 });
add('S26', '全局最新快照缺少本编码按0', 'A(Y)=100→C(X)=50；C在9月1日库存20，但9月2日全局快照只有A库存5。使用9月2日快照，C库存0。', () => { const s = fixture([['A', 'Y', 100], ['C', 'X', 50]], [['A', 'C']]); s.tables.inventory.push({ code: 'C', date: month + '-01', qty: 20 }, { code: 'A', date: month + '-02', qty: 5 }); return s; }, same(100, 50), { coverage: 50 });
add('S27', '负库存按减法计入', 'A(Y)=100→C(X)=50；9月1日C库存-10。', () => { const s = fixture([['A', 'Y', 100], ['C', 'X', 50]], [['A', 'C']]); s.tables.inventory.push({ code: 'C', date: month + '-01', qty: -10 }); return s; }, same(100, 50), { coverage: 60 });
add('S28', '备件、三品库存排除', 'A(Y)=100→C(X)=50；C正常库存86+5+16+21=128；备件2、三品76+5不计。', () => { const s = fixture([['A', 'Y', 100], ['C', 'X', 50]], [['A', 'C']]); for (const [qty, sub_type] of [[86, '生产-半成品子库'], [5, '生产-成品子库'], [16, '生产-成品子库'], [21, '生产-成品在制'], [2, '备件-坏件子库'], [76, '生产-三品-故障品子库'], [5, '生产-三品-待处理品子库']]) s.tables.inventory.push({ code: 'C', date: month + '-01', qty, sub_type }); return s; }, same(100, 50), { coverage: -78 });
add('S29', '未完工指令作为供应来源', 'A(Y)=100→C(X)=50；C未完工指令40，另有已完工100不计；库存10。需求仍来自预测。', () => { const s = fixture([['A', 'Y', 100], ['C', 'X', 50]], [['A', 'C']]); s.tables.mo.push({ mo_no: 'open', code: 'C', qty: 40, due_date: month + '-20', site_code: 'S' }, { mo_no: 'done', code: 'C', qty: 100, due_date: month + '-20', actual_date: month + '-21', site_code: 'S' }); s.tables.inventory.push({ code: 'C', date: month + '-01', qty: 10 }); return s; }, same(100, 60), { source: 'mo', coverage: 50 });
add('S30', '指令模式无指令数据', 'A(Y)=100→C(X)=50，但完全没有导入指令表。供应未知，不能凭空计算缺口。', () => fixture([['A', 'Y', 100], ['C', 'X', 50]], [['A', 'C']]), same(null, null), { source: 'mo' });
add('S31', '透传节点自身不计缺口', 'A(Y)=100→C(X,无预测)；C有表6。C保留原部门X，可展示上游需求100，但供应未知、自身缺口不计算。', () => fixture([['A', 'Y', 100], ['C', 'X', null]], [['A', 'C']]), same(100, null), { passThrough: true });
add('S32', '无父项的独立供应编码', 'C属X、预测50、库存20；没有有效BOM父项。图内部上层需求0、缺口不适用；表格需求—、结余0。', () => { const s = fixture([['C', 'X', 50]], []); s.tables.inventory.push({ code: 'C', date: month + '-01', qty: 20 }); return s; }, same(null, 0), { coverage: 0 });
add('S33', '预测有值但缺表6被导入范围过滤', '导入前A=100但无表6，C属Y、预测50；表6非空。预测范围预处理移除A预测，AI边A→C保留。', () => { const s = fixture([['A', null, 100], ['C', 'Y', 50]], [['A', 'C']]); C.scopeTables(s.tables); return s; }, [[0, -50], [null, null], [null, null]]);

function status(r) { return r.passThrough ? '透传' : !r.applicable ? '不适用' : !r.complete ? '数据不完整' : r.partial ? '部分来源缺失' : '完整'; }
function verify(c) {
  const s = c.build(), e = new Engine(s, version), shared = new C.Engine(s, version), svc = service(e), results = [];
  for (const [i, mode] of modes.entries()) {
    const q = { summary: 1, code: 'C', month, mode, source: c.source || 'forecast' }, response = svc.list(q, 'scenario'), r = response.rows[0];
    const expected = c.expected[i], normalized = [expected[0], expected[1], !!expected[2]];
    for (const row of [e.row('C', month, mode, q.source), shared.compute(month, mode, q.source).get('C'), r]) {
      const applicable = e.graph.parents.get('C').length > 0;
      assert.deepEqual([applicable ? row.demand : null, applicable ? row.gap : 0, !!row.partial], normalized, c.id + '/' + mode);
    }
    assert.equal(r.complete, expected[1] != null, c.id + '/' + mode + '/complete');
    assert.equal(r.passThrough, !!c.passThrough, c.id + '/' + mode + '/passThrough');
    if (c.coverage !== undefined) assert.equal(r.coverageGap, c.coverage, c.id + '/' + mode + '/inventory');
    assert.equal(response.dashboard.incomplete, Number(!r.complete && !r.passThrough));
    assert.equal(response.dashboard.shortage, Number(r.gap > C.EPS));
    assert.equal(svc.list({ ...q, risk: 'incomplete' }, 'scenario').total, response.dashboard.incomplete);
    assert.equal(svc.list({ ...q, risk: 'shortage' }, 'scenario').total, response.dashboard.shortage);
    assert.equal(r.targets.reduce((sum, t) => sum + (t.demand || 0), 0), e.row('C', month, mode, q.source).knownDemand, c.id + '/' + mode + '/contributions');
    results.push({ mode, sources: r.targets.map(t => t.code).sort().join('、') || '—', demand: r.demand, gap: r.gap, coverageGap: r.coverageGap, status: status(r) });
  }
  return results;
}
const cell = value => value == null ? '—' : String(value);
function periodMarkdown() {
  const changing = chain({ b: null, cd: 'Y' });
  for (const [code, qty] of [['A', 200], ['B', 80], ['C', 50]]) forecast(changing, code, qty, '2026-10');
  const svc = service(new Engine(changing, version)), q = { summary: 1, code: 'C', month, mode: 'cross', span: 2 };
  const changed = svc.list(q, 'scenario').rows[0], cumulative = svc.list({ ...q, periodMode: 'cumulative' }, 'scenario').rows[0];
  assert.deepEqual(changed.periods.map(r => r.demand), [100, 80]); assert.equal(cumulative.demand, 180); assert.equal(cumulative.gap, 80);
  assert.equal(changed.periods[1].demand, svc.list({ ...q, month: '2026-10', span: 1 }, 'scenario').rows[0].demand);
  const table = r => `| ${r.start}${r.end !== r.start ? '～' + r.end : ''} | ${cell(r.supply)} | ${cell(r.demand)} | ${cell(r.gap)} | ${cell(r.coverageGap)} | ${r.inventoryIncluded ? '是' : '否'} |`;
  const heads = '| 期间 | 供应 | 需求 | 内部缺口 | 库存后内部缺口 | 启用库存 |\n|---|---:|---:|---:|---:|---|\n';
  let out = '### S34 不同月份的有效来源变化\n\nA/B属X、C属Y，AI链A→B→C。9月A=100、B无记录、C=50；10月A=200、B=80、C=50。下表为cross，前两行为单独月份，最后一行为累计月份。\n\n' + heads + [...changed.periods, cumulative.periods[0]].map(table).join('\n');
  out += '\n\n逐月来源并集：' + changed.targets.map(t => t.code + '的逐月贡献为' + t.monthly.map(m => cell(m.demand)).join('、')).join('；') + '。未作为当月来源时贡献为0，active=false，不是缺失预测补0。';
  const varying = fixture([['A', 'Z', 100], ['B1', 'Y', null], ['B2', 'X', null], ['C', 'X', 50]], [['A', 'B1', 2], ['A', 'B2', 3], ['B1', 'C'], ['B2', 'C']]);
  for (const [code, qty] of [['A', 100], ['B1', 30], ['C', 50]]) forecast(varying, code, qty, '2026-10');
  const v = service(new Engine(varying, version)).list(q, 'scenario').rows[0], a = v.targets.find(t => t.code === 'A');
  assert.deepEqual(v.periods.map(r => r.demand), [500, 330]); assert.deepEqual(a.monthly.map(r => r.coeff), [5, 3]); assert.equal(a.coeff, null);
  out += '\n\n### S35 同一来源的逐月路径系数变化\n\nA(Z)=100两月不变；A→B1×2、A→B2×3、B1→C×1、B2→C×1。B1属Y，9月无记录、10月30；B2属X且无记录；C属X且两月均50。cross结果：\n\n' + heads + v.periods.map(table).join('\n');
  out += '\n\n来源A的逐月系数为' + a.monthly.map(r => r.coeff).join('、') + '，顶层coeff=null；页面与Excel按月份说明系数，不沿用首月值。';
  const periodic = fixture([['A', 'Y', 100], ['C', 'X', 150]], [['A', 'C']]);
  forecast(periodic, 'A', 100, '2026-10'); forecast(periodic, 'C', 20, '2026-10'); periodic.tables.inventory.push({ code: 'C', date: month + '-01', qty: 30 });
  const ps = service(new Engine(periodic, version)), individual = ps.list(q, 'scenario').rows[0], total = ps.list({ ...q, periodMode: 'cumulative' }, 'scenario').rows[0];
  assert.deepEqual(individual.periods.map(r => r.gap), [-50, 80]); assert.deepEqual(individual.periods.map(r => r.coverageGap), [-80, null]); assert.equal(total.coverageGap, 0);
  out += '\n\n### S36 单独月份不结转，累计月份计一次库存\n\nAI链A(Y)→C(X)，A两月均100，C分别150、20，起始库存30。三种口径相同，下表前两行为单独月份，最后一行为累计月份。\n\n' + heads + [...individual.periods, total.periods[0]].map(table).join('\n');
  const outside = ps.list({ ...q, span: 3 }, 'scenario').rows[0]; assert.equal(outside.periods[2].complete, false); assert.equal(outside.periods[2].gap, null);
  out += '\n\n### S37 跨出版本覆盖月份\n\n沿用S36，版本只覆盖9～10月，查询9月起三个月；11月保留且未知，不补0。累计三个月结果也未知。\n\n' + heads + outside.periods.map(table).join('\n');
  const now = Date.now;
  try {
    Date.now = () => Date.parse('2026-10-23T15:59:00Z');
    const s = fixture([['A', 'Y', 100], ['C', 'X', 50]], [['A', 'C']]); s.tables.inventory.push({ code: 'C', date: '2026-10-23', qty: 10 }, { code: 'C', date: '2026-10-24', qty: 60 });
    const cached = service(new Engine(s, version)), before = cached.list({ ...q, span: 1 }, 'scenario').rows[0];
    Date.now = () => Date.parse('2026-10-23T16:01:00Z'); const after = cached.list({ ...q, span: 1 }, 'scenario').rows[0];
    assert.equal(before.inventory, 10); assert.equal(after.inventory, 60); assert.equal(after.coverageGap, -10);
    out += '\n\n### S38 同版本跨北京时间零点\n\nAI链A(Y)=100→C(X)=50，快照已包含10月23日库存10、24日库存60。同一缓存引擎在23日23:59查询时库存为' + before.inventory + '，24日00:01再次查询变为' + after.inventory + '，库存后内部缺口从' + before.coverageGap + '变为' + after.coverageGap + '。不重新计算供需矩阵，不主动拉取外部数据，仅切换已载入快照。';
  } finally { Date.now = now; }
  return out;
}
function markdown() {
  return cases.map(c => `### ${c.id} ${c.title}\n\n${c.conditions}\n\n| 口径 | C的来源 | C需求 | 内部缺口 | 库存后内部缺口 | 状态 |\n|---|---|---:|---:|---:|---|\n` + verify(c).map(r => `| ${r.mode} | ${r.sources} | ${cell(r.demand)} | ${cell(r.gap)} | ${cell(r.coverageGap)} | ${r.status} |`).join('\n')).join('\n\n') + '\n\n' + periodMarkdown();
}
for (const c of cases) test(`文档验算 ${c.id}：${c.title}`, () => verify(c));
test('文档验算 S34～S38：逐月来源、系数、累计、覆盖范围和跨日库存', () => periodMarkdown());
const document = path.join(__dirname, '../docs/供需计算口径与场景示例.md');
const start = '<!-- scenario-results:start -->', end = '<!-- scenario-results:end -->';
if (process.argv.includes('--write-doc')) {
  const current = fs.readFileSync(document, 'utf8'), a = current.indexOf(start), b = current.indexOf(end);
  assert.ok(a >= 0 && b > a, 'document scenario markers must exist');
  const generated = markdown();
  fs.writeFileSync(document, current.slice(0, a + start.length) + '\n\n' + generated + '\n\n' + current.slice(b));
}
test('场景文档表格与实际代码验算输出完全一致', () => {
  const current = fs.readFileSync(document, 'utf8'), a = current.indexOf(start), b = current.indexOf(end);
  assert.ok(a >= 0 && b > a);
  assert.equal(current.slice(a + start.length, b).trim(), markdown());
});
