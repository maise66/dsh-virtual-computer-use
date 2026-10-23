/**
 * 回归测试：工具出口包装（summary 兜底 / JSON 安全化 / render 附加结构化数据）。
 *
 * 这些是"模型看到 invalid output、拿不到任何数据"的直接原因，必须锁住。
 */
import { buildTools } from '../lib/tools.js';
import * as vi from '../lib/virtual-input.js';
import { __internals } from '../host.js';

const { toJsonSafe, withSummary, withRender } = __internals;

let pass = 0;
let fail = 0;
function check(name, condition, detail) {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

console.log('=== 1. toJsonSafe 产出无损 JSON ===');
const messy = {
  ok: true,
  summary: 's',
  nan: Number.NaN,
  inf: Number.POSITIVE_INFINITY,
  big: 10n,
  missing: undefined,
  nested: { alsoMissing: undefined, keep: 1 },
  when: new Date('2026-01-01T00:00:00.000Z'),
  buf: Buffer.from('hi'),
  list: [1, undefined, Number.NaN],
};
const clean = toJsonSafe(messy);
const roundTrip = JSON.parse(JSON.stringify(clean));
check('不含 undefined 属性', !('missing' in clean) && !('alsoMissing' in clean.nested));
check('NaN/Infinity → null', clean.nan === null && clean.inf === null);
check('BigInt → 字符串', clean.big === '10');
check('Date → ISO 字符串', clean.when === '2026-01-01T00:00:00.000Z');
check('Buffer → base64 字符串', typeof clean.buf === 'string');
check('数组里 undefined 被剔除', clean.list.length === 2);
check('round-trip 完全相等（无损）', JSON.stringify(clean) === JSON.stringify(roundTrip));

console.log('\n=== 2. withSummary 永远给出非空 summary ===');
check('失败结果补 summary 并带上原因',
  withSummary({ ok: false, reason: '拒绝访问' }, 'vcu_click').summary.includes('拒绝访问'));
check('空对象成功结果补 summary', withSummary({ ok: true }, 'vcu_x').summary.length > 0);
check('已有 summary 不被覆盖', withSummary({ ok: true, summary: 'keep' }, 'vcu_x').summary === 'keep');
check('字符串结果被包成对象', withSummary('hello', 'vcu_x').summary === 'hello');

console.log('\n=== 3. withRender 输出结构化 JSON（模型才看得见数据）===');
const fakeTool = {
  name: 'vcu_list_windows',
  output: { render: (_a, v) => [{ type: 'text', text: v.summary }] },
};
const rendered = withRender(fakeTool).output.render({}, {
  ok: true,
  summary: '共 2 个窗口。',
  count: 2,
  windows: [{ hwnd: 1, title: 'A' }, { hwnd: 2, title: 'B' }],
});
const joined = rendered.map((b) => b.text).join('\n');
check('第一个 block 仍是摘要', rendered[0].text === '共 2 个窗口。');
check('第二个 block 含窗口数据', joined.includes('"hwnd": 1') && joined.includes('"title": "A"'));
check('摘要不重复出现在 JSON 块里', (joined.match(/共 2 个窗口/g) ?? []).length === 1);

console.log('\n=== 4. 真实工具：失败也带 summary ===');
const tracker = { status: () => ({ aborted: false }), begin: () => () => {} };
const tools = buildTools({
  virtualInput: vi,
  tracker,
  resetAbort: async () => ({ ok: true }),
  status: () => ({ ok: true, summary: 'stub' }),
});
for (const name of ['vcu_click', 'vcu_type_text', 'vcu_press_key']) {
  const tool = tools.find((t) => t.name === name);
  const result = await tool.execute({ hwnd: 0, x: 0, y: 0, text: 'x', keys: 'esc' }, {});
  const wrapped = toJsonSafe(withSummary(result, name));
  check(`${name} 结果有 summary`, typeof wrapped.summary === 'string' && wrapped.summary.length > 0);
  check(`${name} 符合 required(ok,summary)`, 'ok' in wrapped && 'summary' in wrapped);
}

console.log(`\n=== 汇总: ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail === 0 ? 0 : 1);
