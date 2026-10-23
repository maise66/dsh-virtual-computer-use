/**
 * 宿主挂载冒烟测试：用**模拟的 cordis Context** 调用真实的 `apply(ctx, config)`。
 *
 * 这是"插件真的能装进 DSH"的最后一道验证 —— 前面各模块测试都只验证了库函数，
 * 而这里验证的是 host.js 的接线：
 *   - 它注册的工具定义是否合法（name/description/parameters/output/execute 齐全）
 *   - 它注册的 HTTP 路由是否可响应
 *   - 初始化链路（含动态 import 各视觉模块）是否不抛异常
 *   - 关闭时的清理是否不抛异常
 *
 * 之所以能这么做：host.js 只依赖 cordis 的 ctx.inject / ctx.effect / ctx.get 这几个
 * 约定，用一个小 stub 就能忠实模拟。任何接线错误（字段名写错、返回值形状不对）
 * 都会在这里暴露，而不是等到用户装上后才发现。
 */
import { apply } from '../host.js';

let pass = 0, fail = 0;
const failures = [];
const check = (n, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; failures.push(n); console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`); } };
const info = (k, v) => console.log(`        · ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

/** 构造一个最小但忠实的 cordis Context stub。 */
function makeCtx() {
  const registeredTools = [];
  const registeredRoutes = [];
  const disposers = [];
  const injections = [];

  /** 每个 scope 都是一个可注入的 context（services 按需可见）。 */
  function makeScope(services) {
    return {
      tools: services.tools,
      webServer: services.webServer,
      connection: services.connection,
      get: (name) => services[name],
      /** host.js 用 ctx.inject(names, cb) 声明依赖。 */
      inject(names, cb) {
        injections.push(names);
        const wanted = {};
        for (const n of names) wanted[n] = services[n];
        // 服务齐全才调用回调，与 cordis 语义一致。
        if (names.every((n) => services[n] !== undefined)) cb(makeScope(services));
        return { dispose: () => {} };
      },
      /** host.js 用 ctx.effect(fn, label) 注册可释放副作用。 */
      effect(factory, label) {
        const d = factory();
        if (typeof d === 'function') disposers.push({ label, d });
        return d;
      },
    };
  }

  const services = {
    tools: {
      register(def) {
        registeredTools.push(def);
        return () => {};
      },
    },
    webServer: {
      register(route) {
        registeredRoutes.push(route);
        return () => {};
      },
    },
    connection: {
      requestRejection: () => undefined,
    },
  };

  const ctx = makeScope(services);
  ctx.__registeredTools = registeredTools;
  ctx.__registeredRoutes = registeredRoutes;
  ctx.__disposers = disposers;
  ctx.__injections = injections;
  return ctx;
}

/** 模拟一个最小的 HTTP req/res，用于验证路由处理器。 */
function fakeHttp(method = 'GET', url = '/') {
  const chunks = [];
  const res = {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k] = v; return this; },
    end(data) { this.body = data; },
  };
  const req = {
    method,
    url,
    headers: {},
    on() { return this; },
    destroy() {},
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; },
  };
  return { req, res };
}

console.log('=== 1. 用模拟 cordis Context 调用 apply() ===\n');
const ctx = makeCtx();
let applyError;
try {
  apply(ctx, {
    overlay: true,
    overlayText: 'AI 正在操作电脑',
    vision: true,
    tools: true,
    lingerMs: 200,
    escAbort: { enabled: true, thresholdMs: 400, cooldownMs: 400 },
  });
} catch (error) {
  applyError = error;
}
info('apply() 是否抛异常', applyError === undefined ? '未抛异常' : applyError.message);
check('apply() 不抛异常（宿主不会因插件加载失败而崩溃）', applyError === undefined, applyError?.message);
check('apply() 注册了 ctx.inject 依赖', ctx.__injections.length > 0,
  JSON.stringify(ctx.__injections));

console.log('\n=== 2. 工具注册契约 ===\n');
const tools = ctx.__registeredTools;
info('注册的工具数', tools.length);
check('注册了工具且数量合理（>=20）', tools.length >= 20, `count=${tools.length}`);

const names = tools.map((t) => t.name);
info('工具名', names.join(', '));
check('工具名唯一无重复', new Set(names).size === names.length);
check('工具名前缀统一为 vcu_', names.every((n) => n.startsWith('vcu_')));
// 核心能力都在
for (const required of ['vcu_click', 'vcu_type_text', 'vcu_press_key', 'vcu_scroll',
  'vcu_right_click', 'vcu_drag', 'vcu_scroll_lines', 'vcu_screenshot', 'vcu_ocr',
  'vcu_ui_tree', 'vcu_find_image', 'vcu_status', 'vcu_reset_abort']) {
  check(`包含必需工具 ${required}`, names.includes(required));
}
// 结构完整性
const malformed = tools.filter((t) => !t.name || typeof t.name !== 'string'
  || !t.description || typeof t.description !== 'string'
  || t.parameters === undefined || typeof t.parameters !== 'object'
  || !t.output || !t.output.schema || typeof t.output.render !== 'function'
  || typeof t.execute !== 'function');
info('结构不完整的工具', malformed.length === 0 ? '无' : malformed.map((t) => t.name).join(','));
check('所有工具结构完整（name/description/parameters/output{ schema,render }/execute）',
  malformed.length === 0, malformed.map((t) => t.name).join(', '));

// output.schema 必须有 type
const badSchema = tools.filter((t) => t.output.schema.type === undefined);
check('所有 output.schema 都有 type 字段', badSchema.length === 0, badSchema.map((t) => t.name).join(', '));

// parameters 必须是 JSON Schema object
const badParams = tools.filter((t) => t.parameters.type !== 'object');
check('所有 parameters 都是 type:object 的 JSON Schema', badParams.length === 0,
  badParams.map((t) => t.name).join(', '));

// render 必须返回 content block 数组
const renderBad = [];
for (const t of tools) {
  try {
    const out = t.output.render({}, { ok: true, summary: '测试汇总' });
    if (!Array.isArray(out) || out.length === 0 || typeof out[0].type !== 'string') {
      renderBad.push(t.name);
    }
  } catch (error) {
    // 兜底：用最小合法形状再试一次，避免个别工具对字段有额外要求。
    try {
      const out = t.output.render({}, { ok: true, summary: 'x' });
      if (!Array.isArray(out) || out.length === 0) renderBad.push(t.name);
    } catch (e2) {
      renderBad.push(`${t.name}(${e2.message.slice(0, 40)})`);
    }
  }
}
check('所有工具 render() 返回合法 content block 数组', renderBad.length === 0, renderBad.join(', '));

console.log('\n=== 3. HTTP 诊断路由 ===\n');
const routes = ctx.__registeredRoutes;
info('注册的路由', routes.map((r) => r.path).join(', '));
check('注册了状态路由 /virtual-computer-use/status',
  routes.some((r) => r.path === '/virtual-computer-use/status'));
check('注册了控制路由 /virtual-computer-use/control',
  routes.some((r) => r.path === '/virtual-computer-use/control'));

const statusRoute = routes.find((r) => r.path === '/virtual-computer-use/status');
if (statusRoute !== undefined) {
  const { req, res } = fakeHttp('GET');
  let routeError;
  try { statusRoute.handler(req, res); } catch (error) { routeError = error; }
  check('status 路由可响应 GET 且不抛异常', routeError === undefined, routeError?.message);
  info('status 状态码', res.statusCode);
  check('status 返回 200', res.statusCode === 200, String(res.statusCode));
  let parsed;
  try { parsed = JSON.parse(res.body); } catch { /* ignore */ }
  check('status 返回合法 JSON', parsed !== undefined);
  if (parsed !== undefined) {
    info('status.ok / supported', `${parsed.ok} / ${parsed.supported}`);
    info('status.vision', JSON.stringify(parsed.vision));
    info('status.config', JSON.stringify(parsed.config));
    check('status 报告 supported=true（FFI 可用）', parsed.supported === true, JSON.stringify(parsed.reason));
    check('status 含 operation / escAbort / overlay / vision 字段',
      parsed.operation !== undefined && parsed.escAbort !== undefined
      && parsed.overlay !== undefined && parsed.vision !== undefined);
    check('status 不暴露内部错误（initErrors 为空）',
      Array.isArray(parsed.initErrors) && parsed.initErrors.length === 0,
      JSON.stringify(parsed.initErrors));
  }
  // 方法限制
  const { req: r2, res: res2 } = fakeHttp('DELETE');
  statusRoute.handler(r2, res2);
  check('status 路由拒绝非 GET 方法（405）', res2.statusCode === 405, String(res2.statusCode));
}

const controlRoute = routes.find((r) => r.path === '/virtual-computer-use/control');
if (controlRoute !== undefined) {
  const { req, res } = fakeHttp('GET');
  let e;
  try { await controlRoute.handler(req, res); } catch (error) { e = error; }
  check('control 路由拒绝 GET（405）', e === undefined && res.statusCode === 405,
    `${e?.message ?? ''} status=${res.statusCode}`);
}

console.log('\n=== 4. 工具执行（经 withInit 包装，会触发动态 import）===\n');
const statusTool = tools.find((t) => t.name === 'vcu_status');
if (statusTool !== undefined) {
  let result;
  let execError;
  try {
    result = await statusTool.execute({}, { signal: new AbortController().signal });
  } catch (error) {
    execError = error;
  }
  check('vcu_status 可执行且不抛异常', execError === undefined, execError?.message);
  if (result !== undefined) {
    info('vcu_status 返回 ok/summary', `${result.ok} / ${String(result.summary).slice(0, 70)}`);
    check('vcu_status 返回 ok', result.ok === true, JSON.stringify(result.reason));
    check('vcu_status 的 summary 是中文可读文本',
      typeof result.summary === 'string' && result.summary.length > 0);
  }
}

// 视觉工具：截图（这一步会真正触发 capture.js 的动态 import 与真实抓屏）
const shotTool = tools.find((t) => t.name === 'vcu_screenshot');
if (shotTool !== undefined) {
  let shot;
  let shotError;
  try {
    shot = await shotTool.execute({ maxWidth: 320 }, { signal: new AbortController().signal });
  } catch (error) {
    shotError = error;
  }
  check('vcu_screenshot 可执行且不抛异常', shotError === undefined, shotError?.message);
  if (shot !== undefined) {
    info('vcu_screenshot 返回', `ok=${shot.ok} size=${shot.width}x${shot.height} method=${shot.method}`);
    check('vcu_screenshot 成功（说明 capture.js 已正确动态加载）', shot.ok === true, shot.reason);
    check('vcu_screenshot 返回了规范化附件引用（ImageBlock 需要）',
      typeof shot.image?.attachmentId === 'string' && /^sha256:[a-f0-9]{64}$/.test(shot.image.attachmentId),
      `attachmentId=${shot.image?.attachmentId ?? '(none)'}`);
    check('vcu_screenshot 标注了截图方式', typeof shot.method === 'string' && shot.method.length > 0);
  }
}

// 只读视觉工具在"中断"状态下也应可用（设计如此：中断后仍能看图汇报）
console.log('\n=== 5. 清理（disposer）不抛异常 ===\n');
info('注册的 disposer 数', ctx.__disposers.length);
let cleanupError;
try {
  for (const { d } of ctx.__disposers) {
    if (typeof d === 'function') d();
  }
} catch (error) {
  cleanupError = error;
}
check('所有 disposer 可调用且不抛异常', cleanupError === undefined, cleanupError?.message);

// 等一下让异步清理有机会跑完
await new Promise((r) => setTimeout(r, 600));

console.log(`\n=== 汇总: ${pass} 通过 / ${fail} 失败 ===`);
if (fail > 0) {
  console.log('失败项:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('宿主挂载冒烟测试全部通过：插件可被 DSH 正常加载、注册工具与路由、并被清理。');
