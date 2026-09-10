'use strict';
const queryProperties = { version: { type: 'string', description: '预测版本计划日期，YYYY-MM-DD' }, month: { type: 'string', description: '产出月份YYYY-MM' }, mode: { type: 'string', enum: ['direct', 'cross', 'top'] }, source: { type: 'string', enum: ['forecast', 'mo'] }, revision: { type: 'integer' }, scenario: { type: 'string' }, code: { type: 'string' }, role: { type: 'string', enum: ['supply', 'demand'] }, search: { type: 'string' }, site: { type: 'string' }, risk: { type: 'string', enum: ['shortage', 'coverage', 'single', 'concentrated', 'incomplete', 'all'] }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 1000 }, depth: { type: 'integer', minimum: 1, maximum: 10 } };
const scenario = { type: 'object', required: ['version', 'month'], properties: { ...queryProperties, baseRevision: { type: 'integer' }, type: { type: 'string', enum: ['forecast', 'quality', 'outage'] }, code: { type: 'string' }, site_code: { type: 'string' }, scrapQty: { type: 'number', minimum: 0 }, delayDays: { type: 'integer', minimum: 0, maximum: 365 }, changes: { type: 'array', maxItems: 1000, items: { type: 'object', required: ['code', 'month', 'operation', 'value'], properties: { code: { type: 'string' }, month: { type: 'string' }, site_code: { type: 'string' }, operation: { enum: ['set', 'add', 'percent'] }, value: { type: 'number' } } } } } };
function toolsManifest() {
  return { instructions: '工具输出携带trace。回答时注明数据版本、预测版本、月份、分析范围、基线或推演；未知数据不能视为零。下层总缺口不得分别当成每个上层的分配缺口。导入与配置需要管理员，模拟需要planner权限；模型没有执行SQL、代码或发布基线的工具。', tools: [
    ['analyze_supply', '查看三口径供需匹配，可切换需求方查看下层总量风险。'], ['explain_code', '查看编码需求贡献、加工地、周期、累计覆盖及来源。'], ['inspect_network', '获取有界BOM子图和关键/风险路径。'], ['get_reports', '获取风险榜单、加工地集中度及逐月热力数据。'], ['simulate_forecast', '创建独立预测增减、产出损失或加工地延期情景，不修改基线。']
  ].map(([name, description]) => ({ type: 'function', function: { name, description, parameters: name === 'simulate_forecast' ? scenario : { type: 'object', properties: queryProperties, additionalProperties: false } } })) };
}
function createOpenAPI() {
  const paths = {}, response = { description: '结果包含trace；分页响应包含total、offset、limit。', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } };
  const reads = { '/api/meta': ['metadata', '数据规模、版本、加工地、配置、历史快照'], '/api/analysis': ['analyze_supply', '供需匹配分页查询'], '/api/nodes': ['explain_code', '编码详情及来源'], '/api/graph': ['inspect_network', '有界图谱'], '/api/reports': ['get_reports', '风险报告'], '/api/tables': ['read_table', '数据表分页查询'], '/api/jobs/{id}': ['get_job', '异步任务状态'], '/api/ai/tools': ['ai_tools', '模型工具定义'] };
  for (const [p, [operationId, summary]] of Object.entries(reads)) paths[p] = { get: { operationId, summary, parameters: p.includes('{id}') ? [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] : Object.entries(queryProperties).map(([name, schema]) => ({ name, in: 'query', schema })), responses: { 200: response, 401: response, 422: response } } };
  const importSchema = {
    type: 'object', required: ['baseRevision'], properties: {
      baseRevision: { type: 'integer' },
      batches: { type: 'array', items: { type: 'object', required: ['table', 'rows'], properties: {
        table: { enum: ['forecast', 'bom', 'inventory', 'attributes', 'adjust', 'industry', 'mo'] },
        rows: { type: 'array', items: { type: 'object' } }
      } } }
    }
  };
  const writes = {
    '/api/scenarios': ['simulate_forecast', scenario],
    '/api/import/preview': ['preview_import', importSchema],
    '/api/import/commit': ['commit_import', { type: 'object', required: ['previewId'], properties: { previewId: { type: 'string' } } }],
    '/api/config': ['save_config', { type: 'object', required: ['baseRevision', 'config'] }],
    '/api/maintain': ['maintain_table', { type: 'object', required: ['baseRevision', 'table', 'rows'] }],
    '/api/restore': ['restore_snapshot', { type: 'object', required: ['baseRevision', 'revision'] }],
    '/api/sample': ['load_sample', { type: 'object', required: ['baseRevision'] }],
    '/api/sample-large': ['load_sample_large', { type: 'object', required: ['baseRevision'] }],
    '/api/ai/invoke': ['invoke_tool', { type: 'object', required: ['tool', 'arguments'] }]
  };
  for (const [p, [operationId, schema]] of Object.entries(writes)) paths[p] = { post: { operationId, requestBody: { required: true, content: { 'application/json': { schema } } }, responses: { 202: { description: '后台任务已入队，返回jobId。GET /api/jobs/{id}获取completed/failed和结果。' }, 403: response, 409: response, 422: response } } };
  paths['/api/import/file'] = { post: { operationId: 'upload_file', parameters: [{ name: 'name', in: 'query', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, responses: { 202: { description: '返回解析任务jobId；结果包含文件id及各工作表识别信息。' } } } };
  paths['/api/export'] = { get: { operationId: 'export_workbook', parameters: [{ name: 'kind', in: 'query', schema: { enum: ['template', 'sample', 'data'] } }], responses: { 200: { description: '完整Excel工作簿', content: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { schema: { type: 'string', format: 'binary' } } } } } } };
  return { openapi: '3.0.3', info: { title: '供应网络预测协同API', version: '2.0.0' }, servers: [{ url: '/' }], security: [{ bearerAuth: [] }], components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } }, schemas: { Scenario: scenario } }, paths };
}
module.exports = { createOpenAPI, toolsManifest };
