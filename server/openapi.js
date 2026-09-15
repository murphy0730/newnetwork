'use strict';
const queryProperties = { summary: { type: 'integer', enum: [1], description: 'analysis供应汇总表专用；仅支持supply角色，code精确聚焦；跨产业取上层产业链顶端，targets含逐月来源贡献；span最多6个月。总条数按供应编码计。' }, span: { type: 'integer', minimum: 1, maximum: 120 }, industry: { type: 'string' }, graphRelations: { enum: ['scope', 'bom'] }, version: { type: 'string', description: '预测版本计划日期，YYYY-MM-DD' }, month: { type: 'string', description: '产出月份YYYY-MM' }, mode: { type: 'string', enum: ['direct', 'cross', 'top'] }, source: { type: 'string', enum: ['forecast', 'mo'] }, revision: { type: 'integer' }, scenario: { type: 'string' }, code: { type: 'string' }, role: { type: 'string', enum: ['supply', 'demand'] }, search: { type: 'string' }, site: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: '加工地多选；HTTP query 使用 JSON 数组，单值兼容' }, codes: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }], description: '编码精确多选；HTTP query 使用 JSON 数组' }, category: { type: 'string' }, risk: { type: 'string', enum: ['shortage', 'coverage', 'single', 'concentrated', 'incomplete', 'all'] }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 1000, description: '列表分页条数；graph 接口忽略该参数，不截断节点或边' }, depth: { type: 'integer', minimum: 1, maximum: 10 } };
const scenario = { type: 'object', required: ['version', 'month'], properties: { ...queryProperties, baseRevision: { type: 'integer' }, type: { type: 'string', enum: ['forecast', 'quality', 'outage'] }, code: { type: 'string' }, site_code: { type: 'string' }, scrapQty: { type: 'number', minimum: 0 }, delayDays: { type: 'integer', minimum: 0, maximum: 365 }, changes: { type: 'array', maxItems: 1000, items: { type: 'object', required: ['code', 'month', 'operation', 'value'], properties: { code: { type: 'string' }, month: { type: 'string' }, site_code: { type: 'string' }, operation: { enum: ['set', 'add', 'percent'] }, value: { type: 'number' } } } } } };
function toolsManifest() {
  return { instructions: '工具输出携带trace。回答时注明数据版本、预测版本、月份、分析范围、基线或推演；未知数据不能视为零。下层总缺口不得分别当成每个上层的分配缺口。导入与配置需要管理员，模拟需要planner权限；模型没有执行SQL、代码或发布基线的工具。', tools: [
    ['summarize_code', '\u751f\u6210\u7f16\u7801\u4f9b\u9700\u3001\u4e0b\u5c42\u98ce\u9669\u3001\u5468\u671f\u548c\u52a0\u5de5\u5730\u7684\u53ef\u6838\u9a8c\u6d1e\u5bdf\uff0c\u542b\u8bc1\u636e\u4e0e\u63a8\u6f14\u5efa\u8bae\u3002'], ['analyze_supply', '查看三口径供需匹配，可切换需求方查看下层总量风险。'], ['explain_code', '查看编码需求贡献、加工地、周期、累计覆盖及来源。'], ['inspect_network', '获取完整所选范围的BOM图和关键/风险路径。'], ['get_reports', '获取风险榜单、加工地集中度及逐月热力数据。'], ['simulate_forecast', '创建独立预测增减、产出损失或加工地延期情景，不修改基线。']
  ].map(([name, description]) => ({ type: 'function', function: { name, description, parameters: name === 'simulate_forecast' ? scenario : { type: 'object', properties: queryProperties, ...(name === 'summarize_code' ? { required: ['code'] } : {}), additionalProperties: false } } })) };
}
function createOpenAPI() {
  const paths = {}, response = { description: '结果包含trace；分页响应包含total、offset、limit。', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } };
  const reads = { '/api/insights': ['summarize_code', '\u7f16\u7801\u89c4\u5219\u6d1e\u5bdf\u4e0e\u8bc1\u636e'], '/api/meta': ['metadata', '数据规模、版本、加工地、配置、历史快照'], '/api/analysis': ['analyze_supply', '供需匹配分页查询'], '/api/nodes': ['explain_code', '编码详情及来源'], '/api/graph': ['inspect_network', '完整范围图谱（节点和边不截断）'], '/api/reports': ['get_reports', '风险报告'], '/api/tables': ['read_table', '数据表分页查询'], '/api/jobs/{id}': ['get_job', '异步任务状态'], '/api/ai/tools': ['ai_tools', '模型工具定义'] };
  for (const [p, [operationId, summary]] of Object.entries(reads)) paths[p] = { get: { operationId, summary, parameters: p.includes('{id}') ? [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] : Object.entries(queryProperties).map(([name, schema]) => ({ name, in: 'query', schema })), responses: { 200: response, 401: response, 422: response } } };
  const importSchema = {
    type: 'object', required: ['baseRevision'], properties: {
      baseRevision: { type: 'integer' },
      files: { type: 'array', description: '在线上传文件ID；同一版本的全部分片须一次提交', items: { type: 'object', required: ['id', 'selections'], properties: { id: { type: 'string' }, selections: { type: 'array', items: { type: 'object', properties: { sheet: { type: 'string' }, table: { type: 'string' }, headerRow: { type: 'integer', minimum: 0, maximum: 9 } } } } } } },
      batches: { type: 'array', items: { type: 'object', required: ['table', 'rows'], properties: {
        table: { enum: ['forecast', 'bom', 'inventory', 'attributes', 'adjust', 'mo'] },
        rows: { type: 'array', items: { type: 'object' } }
      } } }
    }
  };
  const writes = {
    '/api/scenarios/prepare': ['prepare_simulation', { type: 'object', properties: { revision: { type: 'integer' }, version: { type: 'string' }, month: { type: 'string' } } }],
    '/api/scenarios': ['simulate_forecast', scenario],
    '/api/import/preview': ['preview_import', importSchema],
    '/api/import/commit': ['commit_import', { type: 'object', required: ['previewId'], properties: { previewId: { type: 'string' } } }],
    '/api/config': ['save_config', { type: 'object', required: ['baseRevision', 'config'] }],
    '/api/maintain': ['maintain_table', { type: 'object', required: ['baseRevision', 'table', 'rows'] }],
    '/api/restore': ['restore_snapshot', { type: 'object', required: ['baseRevision', 'revision'] }],
    '/api/sample': ['load_sample', { type: 'object', required: ['baseRevision'] }],
    '/api/sample-large': ['load_sample_large', { type: 'object', required: ['baseRevision'] }],
    '/api/builds/rebuild': ['rebuild_data', { type: 'object', required: ['baseRevision'], properties: { baseRevision: { type: 'integer' } } }],
    '/api/ai/invoke': ['invoke_tool', { type: 'object', required: ['tool', 'arguments'] }]
  };
  for (const [p, [operationId, schema]] of Object.entries(writes)) paths[p] = { post: { operationId, requestBody: { required: true, content: { 'application/json': { schema } } }, responses: { 202: { description: '后台任务已入队，返回jobId。GET /api/jobs/{id}获取completed/failed和结果。' }, 403: response, 409: response, 422: response } } };
  paths['/api/import/file'] = { post: { operationId: 'upload_file', parameters: [{ name: 'name', in: 'query', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, responses: { 202: { description: '返回解析任务jobId；结果包含文件id及各工作表识别信息。' } } } };
  paths['/api/import/artifact'] = { post: { operationId: 'upload_artifact', description: '流式上传.supply；独立校验后返回previewId，commit只装载并原子切换，不重算。', parameters: [{ name: 'name', in: 'query', required: true, schema: { type: 'string' } }, { name: 'baseRevision', in: 'query', required: true, schema: { type: 'integer' } }], requestBody: paths['/api/import/file'].post.requestBody, responses: { 202: { description: '返回jobId；完成结果包含previewId、buildId、规模和告警。' }, 422: response } } };
  paths['/api/builds'] = { get: { operationId: 'list_builds', description: '当前身份最近30项任务，保存7天；包含phase、message、percent、错误清单和产物预览ID。', responses: { 200: response } } };
  paths['/api/jobs/{id}/cancel'] = { post: { operationId: 'cancel_build', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: response, 409: response } } };
  paths['/api/import/discard'] = { post: { operationId: 'discard_uploads', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } } } } } }, responses: { 200: response, 409: response } } };
  paths['/api/diagnostics'] = { get: { operationId: 'diagnostics', description: 'Admin only: bounded queue, latency, event loop and memory metrics', responses: { 200: response, 403: response } } };
  paths['/api/ready'] = { get: { operationId: 'readiness', responses: { 200: response, 503: response } } };
  paths['/api/import/schema'] = { get: { operationId: 'import_schema', responses: { 200: response } } };
  paths['/api/jobs/{id}/issues'] = { get: { operationId: 'download_import_issues', description: '下载所属任务的完整问题CSV，含原始来源与行内容。成功和失败任务均可下载，保留7天；table为空时下载全部。', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'table', in: 'query', schema: { enum: ['forecast', 'adjust', 'bom', 'inventory', 'attributes', 'mo', 'unknown'] } }], responses: { 200: { description: 'UTF-8 BOM CSV，逐行输出，不受页面预览100条限制', content: { 'text/csv': { schema: { type: 'string' } } } }, 404: response, 409: response } } };
  paths['/api/export'] = { get: { operationId: 'export_data', parameters: [{ name: 'kind', in: 'query', schema: { enum: ['template', 'sample', 'data', 'artifact', 'csv'] } }, { name: 'table', in: 'query', description: 'kind=csv时必填；kind=template时可选，指定后只导出该表，附3条样例和填写说明', schema: { type: 'string' } }], responses: { 200: { description: 'Excel模板/样例/小规模数据，完整.supply产物，或按表流式CSV', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, 422: response } } };
  return { openapi: '3.0.3', info: { title: '供应网络预测协同API', version: '2.0.0' }, servers: [{ url: '/' }], security: [{ bearerAuth: [] }], components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } }, schemas: { Scenario: scenario } }, paths };
}
module.exports = { createOpenAPI, toolsManifest };
