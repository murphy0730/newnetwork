'use strict';
const C = require('../forecast-core');

// User-facing demonstration data; the large stress-test fixture stays independent.
function demo() {
  const s = C.empty(), t = s.tables, version = C.today(), start = version.slice(0, 7);
  s.kind = 'sample'; s.updated_at = new Date().toISOString();
  const departments = ['整机产业', '总装产业', '模组产业', '电子产业', '电机产业', '电控产业', '结构件产业', '注塑产业', '钣金产业', '材料产业', '热处理产业', '精密加工产业'];
  const groups = [['FG', 12], ['MD', 36], ['PT', 60], ['SB', 72], ['RM', 60]], levels = [], items = [];
  for (const [level, [prefix, count]] of groups.entries()) {
    const codes = [];
    for (let i = 0; i < count; i++) {
      const code = prefix + '-' + String(i + 1).padStart(3, '0'), index = items.length;
      codes.push(code); items.push({ code, index, level });
      t.attributes.push({ code, make_dept: departments[(i + level * 3) % 12], name: ['整机', '模组', '部件', '结构件', '基础材料'][level] + String(i + 1).padStart(3, '0'), lead_mean: 2 + level * 2 + i % 5, lead_cv: [.12, .2, .35, .5][i % 4], sample_count: 60 + i % 40, source: '演示样例', part_category: ['成品', '半成品', '部件', '结构件', '材料'][level] });
      if (level) {
        const parents = levels[level - 1], parent = parents[i % parents.length];
        t.bom.push({ id: 'BOM-' + t.bom.length, parent, child: code, qty: 1 + i % 3 });
        if (i % 4 === 0) t.bom.push({ id: 'BOM-' + t.bom.length, parent: parents[(i + 1) % parents.length], child: code, qty: 1 });
      }
    }
    levels.push(codes);
  }
  const graph = C.topology(t), index = new Map(items.map(x => [x.code, x]));
  for (let k = 0; k < 11; k++) {
    const month = C.addMonth(start, k), quantities = new Map();
    for (const code of graph.order) {
      const item = index.get(code), parents = graph.parents.get(code);
      const demand = parents.reduce((sum, edge) => sum + quantities.get(edge.parent) * edge.qty, 0);
      const qty = Math.round(parents.length ? demand * [.8, 1, 1.2, .95][item.index % 4] : (100 + item.index * 10) * (1 + k * .03));
      quantities.set(code, qty);
      const site = n => ({ site_code: 'S' + String(n % 10 + 1).padStart(3, '0'), site_name: '加工地' + String(n % 10 + 1).padStart(2, '0') });
      const main = item.index % 3 === 0 ? qty : Math.round(qty * (item.index % 3 === 1 ? .9 : .6));
      t.forecast.push({ plan_date: version, code, month, origin_month: start, qty: main, ...site(item.index) });
      if (main < qty) t.forecast.push({ plan_date: version, code, month, origin_month: start, qty: qty - main, ...site(item.index + 1) });
      t.inventory.push({ id: code + '-' + month, date: month + '-01', code, qty: Math.round(qty * (item.index % 4 === 0 ? .1 : .25)), sub_type: '正常库存' });
      t.mo.push({ mo_no: 'MO-' + code + '-' + month, code, qty: Math.round(qty * .9), due_date: month + '-25', sched_date: month + '-24', status: '已排产', ...site(item.index) });
    }
  }
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
