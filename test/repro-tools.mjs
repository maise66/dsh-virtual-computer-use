import { buildTools } from '../lib/tools.js';
import * as vi from '../lib/virtual-input.js';

const tracker = {
  status: () => ({ aborted: false, active: false }),
  begin: () => () => {},
};
const tools = buildTools({
  virtualInput: vi,
  tracker,
  resetAbort: async () => ({ ok: true }),
  status: () => ({ ok: true, summary: 'stub' }),
});

const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

function check(name, value) {
  const tool = byName[name];
  const schema = tool?.output?.schema;
  const problems = [];
  if (schema) {
    if (schema.required && !schema.required.every((k) => value != null && typeof value === 'object' && k in value)) {
      problems.push('missing required: ' + schema.required.filter((k) => !(value && k in value)).join(','));
    }
    for (const [k, spec] of Object.entries(schema.properties ?? {})) {
      if (value?.[k] !== undefined && spec.type === 'string' && typeof value[k] !== 'string') problems.push(`${k} not string`);
    }
  }
  // JSON lossless check like DSH does
  let jsonOk = true;
  try { JSON.parse(JSON.stringify(value)); } catch { jsonOk = false; }
  return { jsonOk, problems };
}

const cases = [
  ['vcu_status', {}],
  ['vcu_list_windows', {}],
  ['vcu_find_window', { hwnd: 20974306 }],
  ['vcu_window_info', { hwnd: 20974306 }],
  ['vcu_foreground_window', {}],
  ['vcu_click', { hwnd: 20974306, x: 800, y: 300 }],
  ['vcu_type_text', { hwnd: 1642008, text: 'abc' }],
  ['vcu_press_key', { hwnd: 20974306, keys: 'esc' }],
  ['vcu_ocr', { hwnd: 20974306, query: '维护' }],
  ['vcu_ui_tree', { hwnd: 20974306 }],
];

for (const [name, args] of cases) {
  const tool = byName[name];
  if (!tool) { console.log(`MISSING TOOL ${name}`); continue; }
  let out;
  try {
    out = await tool.execute(args, {});
  } catch (error) {
    out = { THREW: error?.message ?? String(error), stack: error?.stack };
  }
  const verdict = check(name, out ?? {});
  const summary = typeof out?.summary === 'string' ? out.summary.slice(0, 80) : '(none)';
  console.log(`\n=== ${name} jsonOk=${verdict.jsonOk} problems=[${verdict.problems.join('; ')}]`);
  console.log('   summary:', summary);
  if (out?.THREW) console.log('   THREW:', out.THREW);
  else if (verdict.problems.length) console.log('   raw:', JSON.stringify(out)?.slice(0, 400));
}
