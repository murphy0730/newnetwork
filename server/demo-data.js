'use strict';
const C = require('../forecast-core');

// 演示数据：真实模拟复杂 BOM（DAG 而非树）。
// 与 forecast-core.sampleLarge 的不同点：sampleLarge 面向压力测试（5000 编码）；
// 本 demo 面向"加载示例"按钮，规模约 1000 编码，但结构同样真实——
// 关键特征：同一编码可被多个父项引用、父项可跨 1-3 层、存在共用料池，
// 因此大量编码的 minLevel ≠ maxLevel（即同一编码在 BOM 中跨越多个层级）。
function demo() {
  const s = C.empty(), t = s.tables, version = C.today(), start = version.slice(0, 7);
  s.kind = 'sample'; s.updated_at = new Date().toISOString();
  const months = []; for (let i = 0; i < 11; i++) months.push(C.addMonth(start, i));
  const N = months.length;

  let seed = 20260915;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const code = (p, n) => p + '-' + String(n).padStart(3, '0');
  const gIndex = c => Number(c.split('-')[1]);

  // 12 个制造部门（覆盖整机/总装/模组/电子/电机/电控/结构/注塑/钣金/材料/热处理/精密加工）
  const departments = ['整机产业', '总装产业', '模组产业', '电子产业', '电机产业', '电控产业', '结构件产业', '注塑产业', '钣金产业', '材料产业', '热处理产业', '精密加工产业'];
  // 7 层 BOM 结构（数量刻意金字塔型，越底层越多）
  const LEVEL = ['FG', 'MD', 'PT', 'SB', 'RW', 'BS', 'RM'];
  const GRP = { FG: 24, MD: 60, PT: 110, SB: 160, RW: 200, BS: 230, RM: 220 };
  const NM = { FG: '整机', MD: '模组', PT: '部件', SB: '结构件', RW: '基础料', BS: '深基础料', RM: '原料' };
  const PART_CAT = { FG: '成品', MD: '半成品', PT: '部件', SB: '结构件', RW: '基础料', BS: '深基础料', RM: '材料' };
  const RANGE = { FG: [5, 9], MD: [7, 13], PT: [8, 15], SB: [10, 18], RW: [14, 26], BS: [20, 42], RM: [25, 50] };
  // 每层编码在本层的加工地片区（约 60 个加工地）
  const SITE_COUNT = { FG: 4, MD: 6, PT: 8, SB: 10, RW: 10, BS: 10, RM: 10 };
  const REGION = ['东莞', '深圳', '苏州', '成都', '武汉', '西安', '合肥', '长沙', '重庆', '天津', '宁波', '青岛'];
  const SITES = {}; { let si = 0; for (const g of LEVEL) { SITES[g] = []; for (let i = 0; i < SITE_COUNT[g]; i++) { si++; SITES[g].push({ code: 'S' + String(si).padStart(3, '0'), name: REGION[si % REGION.length] + NM[g] + '加工地' }); } } }

  const by = {}, all = [];
  for (const g of LEVEL) { by[g] = []; for (let i = 1; i <= GRP[g]; i++) { const c = code(g, i); by[g].push(c); all.push(c); } }

  // 属性表：制造部门按编码序号跨 12 个部门轮换
  for (const g of LEVEL) for (const c of by[g]) {
    const gi = gIndex(c);
    t.attributes.push({ code: c, make_dept: departments[(gi + LEVEL.indexOf(g) * 3) % 12], name: NM[g] + '-' + String(gi), lead_mean: ri(RANGE[g][0], RANGE[g][1]), lead_cv: g === 'BS' || g === 'RM' ? .32 : +(0.13 + (gi % 5) * .05).toFixed(2), sample_count: ri(20, 140), source: '演示样例', part_category: PART_CAT[g] });
  }

  // —— 核心：真实 DAG BOM ——
  // 1) 逐层父子：父项可跨 1-3 层（70% 相邻 / 25% 跨 2 层 / 5% 跨 3 层）
  // 2) 每编码 1-3 个父项（汇聚）
  // 3) 每层前 20% 编码为"共用料池"，承接约 60% 的引用（真实共用与汇聚）
  // 结果是大量编码 minLevel ≠ maxLevel，真实体现"同一编码跨多层归属"
  let bid = 0;
  const bom = (parent, child, qty) => { bid++; t.bom.push({ id: 'BOM-' + String(bid).padStart(4, '0'), parent, child, qty }); };
  const hotPool = P => P.slice(0, Math.max(2, Math.floor(P.length * 0.2)));
  const parentsOf = {};
  for (let li = 1; li < LEVEL.length; li++) {
    const g = LEVEL[li];
    for (const c of by[g]) {
      const list = [], chosen = new Set();
      const pn = rnd() < .25 ? 1 : rnd() < .7 ? 2 : 3;
      for (let p = 0; p < pn; p++) {
        const back = rnd() < .7 ? 1 : rnd() < .85 ? 2 : 3;
        const P = by[LEVEL[Math.max(0, li - back)]], hot = hotPool(P);
        const parent = rnd() < .6 ? hot[ri(0, hot.length - 1)] : P[ri(0, P.length - 1)];
        if (chosen.has(parent)) continue;
        chosen.add(parent);
        bom(parent, c, ri(1, 3));
        list.push([parent, ri(1, 3)]);
      }
      parentsOf[c] = list;
    }
  }

  // 需求与供应：顶层整机需求逐月展开，下层需求 = Σ父项需求 × 配比，供应按覆盖系数形成少量真实缺口
  const need = {}, factor = {};
  for (const c of all) { need[c] = new Array(N).fill(0); factor[c] = 0.94 + rnd() * 0.18; }
  const emit = (c, mm, qty) => {
    if (qty <= 0) return;
    const g = c.slice(0, 2), gi = gIndex(c), sites = SITES[g], len = sites.length;
    const shape = gi % 20 === 0 ? 'single' : gi % 20 === 1 || gi % 20 === 2 ? 'conc' : gi % 6 === 2 ? 'tri' : 'dual';
    const put = (q, si) => { if (q > 0) t.forecast.push({ plan_date: version, code: c, month: mm, origin_month: start, qty, site_code: sites[si].code, site_name: sites[si].name, supplier_code: 'V-' + sites[si].code, supplier_name: '供应商-' + sites[si].code, type: NM[g] }); };
    if (shape === 'single') { put(qty, gi % len); return; }
    if (shape === 'tri') { const shares = [.5, .3, .2], off = gi % len; let acc = 0; shares.forEach((sh, i) => { const q = i === 2 ? qty - acc : Math.round(qty * sh); acc += q; put(q, (off + i) % len); }); return; }
    const main = Math.round(qty * (shape === 'conc' ? .9 : .55 + rnd() * .2)), rest = qty - main, a = gi % len, b = (gi + 1) % len;
    put(main, a); put(rest, b);
  };
  by.FG.forEach((fg, i) => { const base = 120 + (i % 20) * 6; for (let k = 0; k < N; k++) { const q = Math.round(base * (1 + k * .02) * (.94 + rnd() * .12)); need[fg][k] = q; emit(fg, months[k], q); } });
  for (const g of LEVEL.slice(1)) by[g].forEach(c => {
    const ps = parentsOf[c] || [];
    for (let k = 0; k < N; k++) { let d = 0; for (const [p, q] of ps) d += need[p][k] * q; need[c][k] = Math.round(d); emit(c, months[k], Math.round(d * factor[c])); }
  });

  // 库存快照：整机与部分共用模组/部件月初覆盖一部分
  const invCodes = new Set([...by.FG, ...by.MD.filter((c, i) => i % 10 === 1), ...by.PT.filter((c, i) => i % 17 === 3)]);
  for (const c of invCodes) for (let k = 0; k < N; k++) {
    const cover = c.startsWith('FG') ? .08 : .12;
    t.inventory.push({ id: c + months[k], date: months[k] + '-01', code: c, qty: Math.round((need[c][k] || 0) * cover * (0.5 + rnd())), sub_type: '正常库存' });
  }
  // 工单：随预测按比例生成
  for (const c of all) for (let k = 0; k < N; k++) {
    const q = need[c][k];
    if (q <= 0) continue;
    const g = c.slice(0, 2), sites = SITES[g], si = gIndex(c) % sites.length;
    t.mo.push({ mo_no: 'MO-' + c + '-' + months[k], code: c, qty: Math.round(q * .9), due_date: months[k] + '-25', sched_date: months[k] + '-24', status: '已排产', site_code: sites[si].code, site_name: sites[si].name });
  }

  // 表2覆盖100个编码，按真实BOM最长路径层级均匀选取（不是按编码前缀）。
  // 每个编码、每个月同时演示采购补充和独立使用剔除；不向表1重复加减。
  s.config.input_mode = 'raw';
  const graph = C.topology(t), layers = new Map(), forecasts = new Map();
  for (const c of graph.order) {
    const level = graph.level.get(c);
    if (!layers.has(level)) layers.set(level, []);
    layers.get(level).push(c);
  }
  for (const r of t.forecast) {
    const key = JSON.stringify([r.code, r.month]);
    forecasts.set(key, (forecasts.get(key) || 0) + r.qty);
  }
  const levels = [...layers.keys()].sort((a, b) => a - b), selected = [];
  levels.forEach((level, i) => {
    const candidates = layers.get(level).sort(), count = Math.floor(100 / levels.length) + Number(i < 100 % levels.length);
    if (candidates.length < count) throw Error('示例BOM该层编码不足，无法均匀生成100个调整编码');
    for (let j = 0; j < count; j++) selected.push(candidates[Math.floor(j * candidates.length / count)]);
  });
  selected.forEach((c, i) => months.forEach((month, k) => {
    const forecast = forecasts.get(JSON.stringify([c, month]));
    if (!(forecast > 0)) throw Error('示例调整编码缺少正数预测：' + c + '/' + month);
    const add = Math.max(1, Math.round(forecast * (5 + (i + k) % 11) / 100));
    const remove = Math.min(forecast, Math.max(1, Math.round(forecast * (3 + (i + k) % 6) / 100)));
    t.adjust.push({ code: c, purchase_code: 'BUY-' + c, direction: '供应', month, qty: add });
    t.adjust.push({ code: c, purchase_code: '', direction: '使用', month, qty: remove });
  }));
  return s;
}

function templateSample() {
  const s = C.empty(), t = s.tables, version = C.today(), month = version.slice(0, 7);
  const codes = ['DEMO-001', 'DEMO-002', 'DEMO-003'];
  for (const [i, code] of codes.entries()) {
    const qty = [100, 250, 800][i], site_code = 'S00' + (i + 1), site_name = '示例加工地' + (i + 1);
    t.forecast.push({ plan_date: version, code, month, qty, site_code, site_name });
    t.attributes.push({ code, name: ['示例整机', '示例模组', '示例材料'][i], make_dept: ['整机产业', '模组产业', '材料产业'][i], lead_mean: [3, 5, 8][i], lead_cv: [.15, .25, .35][i], sample_count: 60, source: '填写样例', part_category: ['成品', '半成品', '材料'][i] });
    t.inventory.push({ id: 'INV-00' + (i + 1), date: month + '-01', code, qty: [10, 20, 50][i], sub_type: '正常库存' });
    t.mo.push({ mo_no: 'MO-00' + (i + 1), code, qty, due_date: month + '-25', sched_date: month + '-24', site_code, site_name, status: '已排产' });
    t.adjust.push({ code, purchase_code: i === 1 ? '' : 'BUY-00' + (i + 1), direction: i === 1 ? '使用' : '供应', month, qty: [10, 20, 30][i] });
  }
  t.bom.push({ id: 'BOM-001', parent: codes[0], child: codes[1], qty: 2 }, { id: 'BOM-002', parent: codes[0], child: codes[2], qty: 1 }, { id: 'BOM-003', parent: codes[1], child: codes[2], qty: 3 });
  return s;
}
module.exports = { demo, templateSample };
