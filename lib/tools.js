/**
 * Agent 工具层 —— 把"虚拟鼠标键盘 + 画面识别"暴露成模型可调用的工具。
 *
 * 关键设计：**所有操作都经过 OperationTracker**。
 *
 * 模型每调一次工具，就走一次 begin/end：
 *   - 悬浮窗在第一个动作开始时亮起，最后一个动作结束后 linger 一段时间才熄灭；
 *   - 双击 ESC 触发的中断会让 tracker 进入 aborted 状态，此后每次工具调用
 *     都会被拒绝并明确告知模型"用户已中断"，而不是静默继续操作。
 *
 * 这一点很重要：如果中断只是杀掉了当前动作，模型下一次调用还会继续操作电脑，
 * 用户按的 ESC 就形同虚设。所以中断必须"粘住"，直到显式 reset。
 *
 * 只读的视觉工具（截图/OCR/UIA/模板匹配）**不**纳入 guard：观察屏幕不会
 * 改变电脑状态，中断后仍允许模型看图汇报情况，这比让它彻底失明更有用。
 */

import { loadWin32 } from './native.js';
import { describeClientArea, findWindow, findPopupMenus, closePopupMenus, foregroundWindow, listWindows, processImagePath } from './windows.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** 中断后给模型的标准回复，措辞要让模型停止操作并交还控制权。 */
const ABORTED_MESSAGE =
  '用户已通过连续按两下 ESC 中断了电脑操作。请立即停止操作电脑，向用户说明当前进展并等待进一步指示。若确认要继续，需要用户重新授权。';

/**
 * 构建工具定义列表。
 *
 * @param deps.virtualInput - lib/virtual-input.js 的模块导出。
 * @param deps.attachments - DSH 的 attachments 服务（`ctx.get('attachments')`）。
 *   截图的 PNG 必须先经它 saveImage() 落盘成持久引用，才能作为 ImageBlock
 *   交给模型；缺失时截图工具降级为纯文字结果。
 * @param deps.tracker - OperationTracker 实例。
 * @param deps.resetAbort - 复位中断状态的异步函数（同时清 tracker 与钩子）。
 */
export function buildTools(deps) {
  const { virtualInput, tracker, resetAbort } = deps;

  /** 所有工具共用的开头：检查中断、开悬浮窗、拿窗口上下文。 */
  function guard(label) {
    if (tracker.status().aborted) {
      return { blocked: true, result: { ok: false, aborted: true, message: ABORTED_MESSAGE } };
    }
    return { blocked: false, end: tracker.begin(label) };
  }

  /** 统一的错误包装。 */
  function failure(error) {
    return { ok: false, reason: error?.message ?? String(error) };
  }

  return [
    // -----------------------------------------------------------------------
    {
      name: 'vcu_status',
      description:
        '查询"虚拟鼠标键盘"电脑操作子系统的状态：FFI 是否可用、当前是否有操作进行中、是否已被双击 ESC 中断、'
        + '连续操作与中断的配置阈值。AI 准备操作电脑前，或怀疑上一步被用户中断时，应先调用它。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            supported: { type: 'boolean' },
            summary: { type: 'string' },
            native: { type: 'object', additionalProperties: true },
            operation: { type: 'object', additionalProperties: true },
            escAbort: { type: 'object', additionalProperties: true },
            overlay: { type: 'object', additionalProperties: true },
          },
          required: ['ok', 'summary'],
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute() {
        const report = deps.status();
        return { ok: report.ok !== false, ...report };
      },
    },

    // -----------------------------------------------------------------------
    {
      name: 'vcu_list_windows',
      description:
        '列出当前桌面上的顶层窗口（标题、类名、进程 id、位置尺寸、是否最小化）。'
        + '用于先看清屏幕上有什么，再决定操作哪个窗口。默认只列出可见且有标题的窗口，避免噪声。',
      parameters: {
        type: 'object',
        properties: {
          includeHidden: { type: 'boolean', description: '是否包含不可见窗口，默认 false。' },
          allTitles: { type: 'boolean', description: '是否包含无标题窗口（如工具栏），默认 false。' },
          limit: { type: 'integer', description: '最多返回多少个窗口，默认 40。' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            count: { type: 'integer' },
            summary: { type: 'string' },
            windows: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
          required: ['ok'],
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: value.summary ?? '' }],
      },
      async execute(args) {
        try {
          const listing = listWindows({
            visibleOnly: args?.includeHidden !== true,
            withTitleOnly: args?.allTitles !== true,
          });
          if (listing.ok !== true) return { ok: false, reason: listing.reason, summary: `无法枚举窗口：${listing.reason}` };
          const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 200) : 40;
          const windows = listing.windows.slice(0, limit).map((w) => ({
            hwnd: w.hwnd,
            title: w.title,
            className: w.className,
            pid: w.pid,
            minimized: w.minimized,
            rect: w.rect,
          }));
          return {
            ok: true,
            count: listing.count,
            windows,
            summary: `共 ${listing.count} 个窗口，返回前 ${windows.length} 个。`,
          };
        } catch (error) {
          return failure(error);
        }
      },
    },

    // -----------------------------------------------------------------------
    {
      name: 'vcu_find_window',
      description:
        '按标题子串、窗口类名或进程 id 定位一个窗口，返回它的 hwnd（后续所有操作都用这个 hwnd）。'
        + '标题匹配是**发现**手段，拿到 hwnd 后应一直复用它 —— 标题会随文档名变化，hwnd 不会。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '标题子串，大小写不敏感，例如 "记事本"。' },
          className: { type: 'string', description: '窗口类名精确匹配，例如 "Notepad"。' },
          pid: { type: 'integer', description: '进程 id。' },
          hwnd: { type: 'integer', description: '直接指定已知句柄，只校验有效性。' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            summary: { type: 'string' },
            window: { type: 'object', additionalProperties: true },
            otherMatches: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
          required: ['ok', 'summary'],
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute(args) {
        try {
          const found = findWindow({
            title: args?.title,
            className: args?.className,
            pid: args?.pid,
            hwnd: args?.hwnd,
          });
          if (found.ok !== true) return { ok: false, reason: found.reason, summary: `未找到窗口：${found.reason}` };
          const w = found.window;
          const extra = found.otherMatches?.length
            ? `，另有 ${found.otherMatches.length} 个相近窗口（hwnd: ${found.otherMatches.map((x) => x.hwnd).join(', ')}）`
            : '';
          return {
            ok: true,
            window: w,
            otherMatches: found.otherMatches,
            summary: `已定位窗口 hwnd=${w.hwnd}「${w.title}」类名 ${w.className}，pid ${w.pid}${extra}。`,
          };
        } catch (error) {
          return failure(error);
        }
      },
    },

    // -----------------------------------------------------------------------
    {
      name: 'vcu_click',
      description:
        '用**虚拟鼠标**点击窗口（不移动真实光标，用户可同时用自己的鼠标操作电脑）。'
        + '\n\n坐标空间由 space 决定：'
        + '默认 "client" 是目标窗口客户区坐标（左上角为原点）；'
        + '若你从 vcu_ocr 拿到了 screenBbox、或从 vcu_screenshot/vcu_find_image 拿到了屏幕坐标，'
        + '直接传 space:"screen" 即可，无需自己换算。'
        + '\n\n注意：本功能通过窗口消息投递实现，对大多数传统 Win32 程序有效；'
        + '对 UWP/部分 Chromium 控件可能无效（结果里会说明）。',
      parameters: {
        type: 'object',
        properties: {
          hwnd: { type: 'integer', description: '目标窗口句柄（来自 vcu_find_window）。' },
          x: { type: 'integer', description: 'X 坐标。' },
          y: { type: 'integer', description: 'Y 坐标。' },
          space: {
            type: 'string',
            enum: ['client', 'screen'],
            description: '坐标系：client=窗口客户区（默认）；screen=屏幕坐标（配 OCR/截图/找图结果用）。',
          },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: '鼠标键，默认 left。' },
          count: { type: 'integer', description: '点击次数，2 表示双击，默认 1。' },
        },
        required: ['hwnd', 'x', 'y'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            summary: { type: 'string' },
            messagesPosted: { type: 'integer' },
            cursorUnchanged: { type: 'boolean' },
            deliveredClient: { type: 'object', additionalProperties: true },
          },
          required: ['ok', 'summary'],
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute(args) {
        const gate = guard('click');
        if (gate.blocked) return gate.result;
        try {
          const space = args?.space === 'screen' ? 'screen' : 'client';
          const before = virtualInput.cursorPosition();
          const result = virtualInput.click(args.hwnd, args.x, args.y, {
            button: args?.button ?? 'left',
            count: Number.isInteger(args?.count) ? args.count : 1,
            space,
          });
          const after = virtualInput.cursorPosition();
          const unchanged = before.ok === true && after.ok === true && before.x === after.x && before.y === after.y;
          if (result.ok !== true) {
            return { ok: false, reason: result.reason, summary: `点击失败：${result.reason}` };
          }
          // 把实际投递的客户区坐标回显，方便模型核对换算是否符合预期。
          const deliveredClient = result.point ?? result.client ?? undefined;
          const where = space === 'screen'
            ? `屏幕坐标 (${args.x}, ${args.y})`
            : `客户区 (${args.x}, ${args.y})`;
          return {
            ...result,
            cursorUnchanged: unchanged,
            deliveredClient,
            summary: `已在窗口 ${args.hwnd} 的${where}投递${args?.count === 2 ? '双击' : '单击'}`
              + `${deliveredClient ? `（换算后客户区 ${deliveredClient.x}, ${deliveredClient.y}）` : ''}`
              + `，共 ${result.messagesPosted ?? result.posted ?? 0} 条窗口消息。`
              + `真实光标${unchanged ? '未移动' : '位置有变化（可能是用户自己在动鼠标）'}。`,
          };
        } catch (error) {
          return failure(error);
        } finally {
          gate.end();
        }
      },
    },

    // -----------------------------------------------------------------------
    {
      name: 'vcu_type_text',
      description:
        '用**虚拟键盘**向窗口输入文字（不占用真实键盘，用户可以同时正常打字）。支持中英文与 emoji。'
        + '实现方式是把字符作为键盘消息直接投递给目标窗口，因此不需要窗口处于前台。',
      parameters: {
        type: 'object',
        properties: {
          hwnd: { type: 'integer', description: '目标窗口句柄。' },
          text: { type: 'string', description: '要输入的文字。' },
          delayMs: { type: 'integer', description: '每个字符之间的间隔毫秒，默认 0（尽快投递）。网络类应用可能需要 10-30。' },
        },
        required: ['hwnd', 'text'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            summary: { type: 'string' },
            charactersSent: { type: 'integer' },
            messagesPosted: { type: 'integer' },
          },
          required: ['ok', 'summary'],
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute(args) {
        const gate = guard('type_text');
        if (gate.blocked) return gate.result;
        try {
          const result = await virtualInput.writeText(args.hwnd, String(args?.text ?? ''), {
            delayMs: Number.isInteger(args?.delayMs) ? args.delayMs : 0,
          });
          if (result.ok !== true) {
            return { ok: false, reason: result.reason, summary: `输入失败：${result.reason}` };
          }
          return {
            ...result,
            summary: `已向窗口 ${args.hwnd} 输入 ${result.charactersSent} 个字符（${result.messagesPosted} 条键盘消息）。`,
          };
        } catch (error) {
          return failure(error);
        } finally {
          gate.end();
        }
      },
    },

    // -----------------------------------------------------------------------
    {
      name: 'vcu_press_key',
      description:
        '用**虚拟键盘**按键或组合键，例如 "enter"、"esc"、"f5"、"ctrl+a"、"ctrl+shift+s"、"alt+f4"、"ctrl+v"。'
        + '适合触发菜单、快捷键、保存等操作。',
      parameters: {
        type: 'object',
        properties: {
          hwnd: { type: 'integer', description: '目标窗口句柄。' },
          keys: { type: 'string', description: '按键或组合键，用 + 连接，例如 "ctrl+a"。' },
        },
        required: ['hwnd', 'keys'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            summary: { type: 'string' },
            messagesPosted: { type: 'integer' },
          },
          required: ['ok', 'summary'],
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute(args) {
        const gate = guard('press_key');
        if (gate.blocked) return gate.result;
        try {
          const result = virtualInput.pressKey(args.hwnd, String(args?.keys ?? ''), {});
          if (result.ok !== true) {
            return { ok: false, reason: result.reason, summary: `按键失败：${result.reason}` };
          }
          return { ...result, summary: `已向窗口 ${args.hwnd} 投递按键「${args.keys}」（${result.messagesPosted} 条消息）。` };
        } catch (error) {
          return failure(error);
        } finally {
          gate.end();
        }
      },
    },

    // -----------------------------------------------------------------------
    {
      name: 'vcu_scroll',
      description:
        '用**虚拟鼠标**滚轮上下滚动窗口内容（不移动真实光标、不抢焦点，用户可同时用电脑）。'
        + 'delta 为正向上滚、为负向下滚，一格通常 120（要滚 3 格就传 -360）。'
        + '\n\n已验证：对标准编辑控件（如记事本）能真实改变可见内容。'
        + '\n若目标程序不响应滚轮消息（部分自绘界面、Chromium 内容区），'
        + '可用 vcu_press_key 发 pagedown/pageup 作为替代（对多数程序有效）。',
      parameters: {
        type: 'object',
        properties: {
          hwnd: { type: 'integer', description: '目标窗口句柄。' },
          x: { type: 'integer', description: '滚动位置（客户区 X 坐标）；省略则用客户区中心。' },
          y: { type: 'integer', description: '滚动位置（客户区 Y 坐标）；省略则用客户区中心。' },
          delta: { type: 'integer', description: '滚动量：正数向上、负数向下，一格 120。' },
          horizontal: { type: 'boolean', description: '是否横向滚动，默认 false（纵向）。' },
        },
        required: ['hwnd', 'delta'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, summary: { type: 'string' }, messagesPosted: { type: 'integer' } },
          required: ['ok', 'summary'],
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute(args) {
        const gate = guard('scroll');
        if (gate.blocked) return gate.result;
        try {
          const result = virtualInput.scroll(args.hwnd, Number(args?.delta ?? 0), {
            x: Number.isInteger(args?.x) ? args.x : undefined,
            y: Number.isInteger(args?.y) ? args.y : undefined,
            horizontal: args?.horizontal === true,
          });
          if (result.ok !== true) return { ok: false, reason: result.reason, summary: `滚动失败：${result.reason}` };
          const dir = Number(args.delta) > 0 ? '向上' : '向下';
          return {
            ...result,
            summary: `已在窗口 ${args.hwnd} ${dir}滚动 ${Math.abs(Number(args.delta))}`
              + `（约 ${(Math.abs(Number(args.delta)) / 120).toFixed(1)} 格，${result.messagesPosted ?? result.posted ?? 0} 条消息）。`,
          };
        } catch (error) {
          return failure(error);
        } finally {
          gate.end();
        }
      },
    },

    // -----------------------------------------------------------------------
    {
      name: 'vcu_right_click',
      description:
        '用**虚拟鼠标右键**点击，弹出**上下文菜单**（不移动真实光标、不抢焦点）。'
        + '\n\n已实测：对标准 Win32 程序能真实弹出菜单（菜单是独立的 #32768 弹出窗口）。'
        + '\n\n典型用法：先 vcu_right_click 弹菜单 → 用 vcu_popup_menu 看菜单里有什么'
        + '（或 vcu_screenshot + vcu_ocr 读菜单文字）→ 再用 vcu_click 点菜单项。'
        + '\n\n注意：菜单弹出后要操作的是**菜单窗口**，不是原窗口；用 vcu_popup_menu 拿它的 hwnd。'
        + '用完记得 vcu_close_menu 关掉。',
      parameters: {
        type: 'object',
        properties: {
          hwnd: { type: 'integer', description: '目标窗口句柄。' },
          x: { type: 'integer', description: 'X 坐标。' },
          y: { type: 'integer', description: 'Y 坐标。' },
          space: {
            type: 'string',
            enum: ['client', 'screen'],
            description: '坐标系：client=窗口客户区（默认）；screen=屏幕坐标。',
          },
        },
        required: ['hwnd', 'x', 'y'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            summary: { type: 'string' },
            menuAppeared: { type: 'boolean' },
            menus: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
          required: ['ok', 'summary'],
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute(args) {
        const gate = guard('right_click');
        if (gate.blocked) return gate.result;
        try {
          const space = args?.space === 'screen' ? 'screen' : 'client';
          const before = virtualInput.cursorPosition();
          const result = virtualInput.click(args.hwnd, args.x, args.y, { button: 'right', count: 1, space });
          const after = virtualInput.cursorPosition();
          const unchanged = before.ok === true && after.ok === true && before.x === after.x && before.y === after.y;
          if (result.ok !== true) {
            return { ok: false, reason: result.reason, summary: `右键点击失败：${result.reason}` };
          }
          // 给菜单一点时间弹出，然后检查是否真的出现了菜单窗口
          await new Promise((r) => setTimeout(r, 350));
          const menus = findPopupMenus();
          const list = menus.ok === true ? menus.menus : [];
          const appeared = list.length > 0;
          return {
            ok: true,
            menuAppeared: appeared,
            menus: list,
            cursorUnchanged: unchanged,
            summary: `已在窗口 ${args.hwnd} 投递右键点击（${result.messagesPosted ?? result.posted ?? 0} 条消息）。`
              + (appeared
                ? `检测到弹出菜单窗口 hwnd=${list.map((m) => m.hwnd).join(', ')}`
                  + `（尺寸 ${list[0].rect.width}×${list[0].rect.height}）。`
                  + '可用 vcu_popup_menu 查看菜单项，或用 vcu_click 点击菜单窗口的坐标选中某一项；'
                  + '完成后建议 vcu_close_menu 关闭。'
                : '未检测到弹出菜单（该位置/该程序可能没有上下文菜单，属正常）。')
              + `真实光标${unchanged ? '未移动' : '有变化（可能是用户自己在动鼠标）'}。`,
          };
        } catch (error) {
          return failure(error);
        } finally {
          gate.end();
        }
      },
    },

    // -----------------------------------------------------------------------
    {
      name: 'vcu_popup_menu',
      description:
        '查看当前**已弹出的上下文菜单**（右键菜单）信息：菜单窗口句柄、位置、尺寸。'
        + '\n\n重要局限（已实测）：Win32 原生菜单**不暴露 UIA 控件树**（#32768 只有一个空 Pane，'
        + '0 个子节点），所以无法用 vcu_ui_tree 读到菜单项列表。'
        + '\n\n要"看到"菜单里有什么，请用 **vcu_screenshot(hwnd=菜单hwnd)** 看图片，'
        + '或 **vcu_ocr(hwnd=菜单hwnd)** 读菜单文字（OCR 实测能读出菜单项文字，'
        + '但中文 UI 字体小而密时可能有个别识别误差）。'
        + '\n\n选中某一项：vcu_click(hwnd=菜单hwnd, x, y) 投递给**菜单窗口自身**（不是原窗口）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            summary: { type: 'string' },
            count: { type: 'integer' },
            menus: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
          required: ['ok', 'summary'],
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute() {
        try {
          const found = findPopupMenus();
          if (found.ok !== true) return { ok: false, reason: found.reason, summary: `查询失败：${found.reason}` };
          if (found.menus.length === 0) {
            return { ok: true, count: 0, menus: [], summary: '当前没有已弹出的上下文菜单。可先用 vcu_right_click 弹出菜单。' };
          }
          return {
            ok: true,
            count: found.menus.length,
            menus: found.menus,
            summary: `当前有 ${found.menus.length} 个弹出菜单：\n`
              + found.menus.map((m) => `- hwnd=${m.hwnd} 位置 (${m.rect.x}, ${m.rect.y}) 尺寸 ${m.rect.width}×${m.rect.height}`
                + `${m.isStandardMenu ? '（标准 Win32 菜单）' : ''}`).join('\n')
              + `\n\n下一步建议：vcu_screenshot(hwnd=${found.menus[0].hwnd}) 看菜单内容，`
              + `然后 vcu_click(hwnd=${found.menus[0].hwnd}, x, y) 选中菜单项（坐标相对菜单窗口）。`,
          };
        } catch (error) {
          return failure(error);
        }
      },
    },

    // -----------------------------------------------------------------------
    {
      name: 'vcu_close_menu',
      description:
        '关闭当前弹出的上下文菜单（相当于按 ESC 取消）。'
        + '\n\n已实测：向菜单窗口投递 ESC 对标准 Win32 菜单有效。'
        + '本操作不抢焦点、不产生真实按键。'
        + '\n\n何时用：右键菜单弹错了位置、或看完菜单不想选任何项时，'
        + '及时关闭以免挡住后续操作。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, summary: { type: 'string' }, remaining: { type: 'integer' } },
          required: ['ok', 'summary'],
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute() {
        try {
          const result = closePopupMenus();
          if (result.ok !== true) return { ok: false, reason: result.reason, summary: `关闭失败：${result.reason}` };
          if (result.closed === 0 && result.remaining === 0) {
            return { ok: true, remaining: 0, summary: '当前没有需要关闭的菜单。' };
          }
          return {
            ok: true,
            remaining: result.remaining,
            summary: `已关闭 ${result.closed} 个弹出菜单`
              + `${result.remaining > 0 ? `，仍有 ${result.remaining} 个未关闭` : ''}（方式：${result.method}）。`,
          };
        } catch (error) {
          return failure(error);
        }
      },
    },

    // -----------------------------------------------------------------------
    {
      name: 'vcu_drag',
      description:
        '用**虚拟鼠标左键长按拖动**。两种用途，能力与代价不同：'
        + '\n\n**1. 拖动内容**（默认，mode:"content"）：选中文字、拖动滑块、移动画布对象等。'
        + '纯窗口消息实现，**不移动真实光标**，用户可同时用电脑。'
        + '坐标用客户区坐标（from/to 都是点）。实测：记事本里同列拖出 16 字、跨行拖出 58 字选区都有效。'
        + '\n\n**2. 拖动窗口**（mode:"window"）：把窗口标题栏拖走。'
        + '⚠ **这条路会真实移动用户的光标并注入真实鼠标按键**（拖动结束会尽量把光标放回原处）。'
        + '原因是窗口拖动是窗口管理器的模态循环，它读系统的真实光标与按键状态，'
        + '纯消息注入完全无效（实测三种 PostMessage 方案全部失败，只有真实输入有效）。'
        + '因此**只在用户明确要求移动窗口时使用**。'
        + 'window 模式下 from 用**窗口坐标**（y=0 是窗口外框顶边，标题栏约 y=0..30），to 是**位移量**；'
        + '缺省 from 会自动取标题栏。',
      parameters: {
        type: 'object',
        properties: {
          hwnd: { type: 'integer', description: '目标窗口句柄。' },
          mode: {
            type: 'string',
            enum: ['content', 'window'],
            description: 'content=拖动内容（默认，不碰真实鼠标）；window=拖动窗口（会占用真实鼠标）。',
          },
          from: {
            type: 'object',
            description: '起点。content 模式为客户区坐标；window 模式为窗口坐标。',
            properties: { x: { type: 'integer' }, y: { type: 'integer' } },
            required: ['x', 'y'],
            additionalProperties: false,
          },
          to: {
            type: 'object',
            description: 'content 模式是终点坐标；window 模式是相对起点的**位移量**。',
            properties: { x: { type: 'integer' }, y: { type: 'integer' } },
            required: ['x', 'y'],
            additionalProperties: false,
          },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: '默认 left。' },
          space: { type: 'string', enum: ['client', 'screen'], description: 'content 模式的坐标系，默认 client。' },
          steps: { type: 'integer', description: '中间移动步数，默认按距离自适应。跨行拖动建议 12 以上。' },
        },
        required: ['hwnd', 'to'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            summary: { type: 'string' },
            mode: { type: 'string' },
            usesRealCursor: { type: 'boolean' },
            moved: { type: 'boolean' },
          },
          required: ['ok', 'summary'],
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute(args) {
        const gate = guard('drag');
        if (gate.blocked) return gate.result;
        try {
          const mode = args?.mode === 'window' ? 'window' : 'content';
          const result = virtualInput.drag(args.hwnd, args?.from, args?.to, {
            mode,
            button: args?.button ?? 'left',
            space: args?.space === 'screen' ? 'screen' : 'client',
            steps: Number.isInteger(args?.steps) ? args.steps : undefined,
          });
          if (result.ok !== true) {
            return { ok: false, reason: result.reason, summary: `拖动失败：${result.reason}` };
          }
          if (mode === 'window') {
            return {
              ...result,
              summary: `已拖动窗口 ${args.hwnd}：位移 ${JSON.stringify(result.windowMovedBy ?? { x: '?', y: '?' })}`
                + `（窗口实际${result.moved ? '已移动' : '未移动'}）。`
                + '⚠ 此操作**移动了用户的真实光标**（已尽量还原）——窗口拖动必须依赖真实鼠标。',
            };
          }
          return {
            ...result,
            summary: `已在窗口 ${args.hwnd} 拖动（${result.posted ?? result.messagesPosted ?? 0} 条消息，`
              + `${result.steps ?? '?'} 段轨迹）。真实光标未移动。`,
          };
        } catch (error) {
          return failure(error);
        } finally {
          gate.end();
        }
      },
    },

    // -----------------------------------------------------------------------
    {
      name: 'vcu_scroll_lines',
      description:
        '用滚动条消息**逐行/逐页**精确滚动（比 vcu_scroll 的滚轮更可控）。'
        + '\n\n为什么需要它：滚轮的粒度由目标控件决定（实测记事本里一格滚轮可能跳十几行甚至直接到底），'
        + '无法由调用方精细控制；而 `WM_VSCROLL` 每次恰好一行，实测可靠（连续 5 次精确移动 5 行）。'
        + '\n\n适用：需要"往下翻一点点"、"精确滚动 N 行"时用它；只是粗略滚动可用 vcu_scroll。',
      parameters: {
        type: 'object',
        properties: {
          hwnd: { type: 'integer', description: '目标窗口句柄。' },
          direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: '方向，默认 down。' },
          unit: { type: 'string', enum: ['line', 'page'], description: 'line=一行（默认）；page=一页。' },
          times: { type: 'integer', description: '重复次数，默认 1。' },
        },
        required: ['hwnd'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, summary: { type: 'string' }, messagesPosted: { type: 'integer' } },
          required: ['ok', 'summary'],
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute(args) {
        const gate = guard('scroll_lines');
        if (gate.blocked) return gate.result;
        try {
          const result = virtualInput.scrollLines(args.hwnd, {
            direction: args?.direction ?? 'down',
            unit: args?.unit === 'page' ? 'page' : 'line',
            times: Number.isInteger(args?.times) ? args.times : 1,
          });
          if (result.ok !== true) return { ok: false, reason: result.reason, summary: `滚动失败：${result.reason}` };
          const dirText = { up: '向上', down: '向下', left: '向左', right: '向右' }[result.direction] ?? result.direction;
          return {
            ...result,
            summary: `已在窗口 ${args.hwnd} ${dirText}滚动 ${result.times} ${result.unit === 'page' ? '页' : '行'}`
              + `（${result.posted ?? result.messagesPosted ?? 0} 条滚动条消息）。`,
          };
        } catch (error) {
          return failure(error);
        } finally {
          gate.end();
        }
      },
    },

    // -----------------------------------------------------------------------
    {
      name: 'vcu_window_info',
      description:
        '读取窗口的详细几何信息：窗口矩形、客户区尺寸、客户区原点在屏幕上的坐标。'
        + '在需要把屏幕坐标换算成客户区坐标（例如根据截图定位点击点）时使用。',
      parameters: {
        type: 'object',
        properties: { hwnd: { type: 'integer', description: '目标窗口句柄。' } },
        required: ['hwnd'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, summary: { type: 'string' }, clientOrigin: { type: 'object', additionalProperties: true }, clientSize: { type: 'object', additionalProperties: true }, windowRect: { type: 'object', additionalProperties: true } },
          required: ['ok', 'summary'],
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute(args) {
        try {
          const info = describeClientArea(args?.hwnd);
          if (info.ok !== true) return { ok: false, reason: info.reason, summary: `读取失败：${info.reason}` };
          return {
            ...info,
            summary: `窗口 ${args.hwnd}：客户区 ${info.clientSize.width}×${info.clientSize.height}，`
              + `客户区原点在屏幕 (${info.clientOrigin.x}, ${info.clientOrigin.y})。`,
          };
        } catch (error) {
          return failure(error);
        }
      },
    },

    // -----------------------------------------------------------------------
    {
      name: 'vcu_foreground_window',
      description:
        '读取当前前台（有焦点）窗口。可用于确认"操作期间用户是否在别的窗口工作"——'
        + '虚拟输入不抢焦点，因此正常情况下前台窗口不会被本插件改变。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, summary: { type: 'string' }, window: { type: 'object', additionalProperties: true } },
          required: ['ok', 'summary'],
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute() {
        try {
          const fg = foregroundWindow();
          if (fg.ok !== true) return { ok: false, reason: fg.reason, summary: `读取失败：${fg.reason}` };
          if (fg.window === null) return { ok: true, window: null, summary: '当前没有前台窗口（桌面在最前）。' };
          return {
            ok: true,
            window: fg.window,
            summary: `当前前台窗口 hwnd=${fg.window.hwnd}「${fg.window.title}」（pid ${fg.window.pid}）。`,
          };
        } catch (error) {
          return failure(error);
        }
      },
    },

    // -----------------------------------------------------------------------
    {
      name: 'vcu_reset_abort',
      description:
        '复位"被双击 ESC 中断"的状态，允许重新开始操作电脑。'
        + '只在用户明确表示"继续操作"后调用；不要自行调用它来绕过用户的中断。',
      parameters: {
        type: 'object',
        properties: { confirm: { type: 'boolean', description: '必须显式传 true，表示用户已同意继续。' } },
        required: ['confirm'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, summary: { type: 'string' } },
          required: ['ok', 'summary'],
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute(args) {
        if (args?.confirm !== true) {
          return { ok: false, summary: '未复位：需要确认用户已同意继续操作（confirm: true）。' };
        }
        try {
          await resetAbort();
          return { ok: true, summary: '已复位中断状态，可以重新开始操作电脑。' };
        } catch (error) {
          return { ok: false, summary: `复位失败：${error?.message ?? String(error)}` };
        }
      },
    },

    // =======================================================================
    // 画面识别（视觉）工具
    //
    // 这些都是**只读**操作：不改变电脑状态，因此不纳入 ESC 中断的 guard，
    // 让模型在中断后仍能看图向用户汇报。
    // =======================================================================

    // -----------------------------------------------------------------------
    {
      name: 'vcu_screenshot',
      description:
        '截取屏幕画面并返回图片，供你**直接观察**界面内容（理解布局、图标、报错弹窗等）。'
        + '可截取指定窗口（默认，能拍到被遮挡的窗口）或整个虚拟屏幕（含多显示器）。'
        + '这是理解"屏幕上现在是什么样"最直接的手段；拿到图片后可配合 vcu_ocr 精确定位文字坐标。'
        + '\n\n注意：截图**不会**移动用户鼠标、不会抢焦点，用户可同时在用电脑。',
      parameters: {
        type: 'object',
        properties: {
          hwnd: { type: 'integer', description: '要截取的窗口句柄。省略则截整个虚拟屏幕。' },
          region: {
            type: 'object',
            description: '只截屏幕的某个区域（屏幕坐标），便于放大看细节。',
            properties: {
              x: { type: 'integer' }, y: { type: 'integer' },
              width: { type: 'integer' }, height: { type: 'integer' },
            },
            required: ['x', 'y', 'width', 'height'],
            additionalProperties: false,
          },
          maxWidth: { type: 'integer', description: '图片最大宽度，超过会自动等比缩小（默认 1600，控制体积）。' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            summary: { type: 'string' },
            width: { type: 'integer' },
            height: { type: 'integer' },
            method: { type: 'string' },
            // 规范化后的截图附件引用（由 host 侧通过 attachments 服务落盘）。
            // 必须是这种形状：DSH 的 ImageBlock 只认 `attachment` 引用，
            // 不接受 `source: {type:'base64'}`（那是 provider 线格式，不是 Harness 块）。
            image: {
              type: 'object',
              properties: {
                attachmentId: { type: 'string' },
                mediaType: { type: 'string' },
                bytes: { type: 'integer' },
                width: { type: 'integer' },
                height: { type: 'integer' },
                name: { type: 'string' },
              },
              required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
              additionalProperties: false,
            },
          },
          required: ['ok', 'summary'],
          additionalProperties: true,
        },
        // 这里返回图片内容块，模型才能真的"看到"。
        // ⚠️ 块形状必须是 `{ type:'image', attachment: {…} }`：AttachmentStore 的
        // 持久引用。早期版本写成 `{ type:'image', source:{…base64…} }`，会让
        // 下一轮构造请求时读取 `block.attachment.attachmentId` 直接抛
        // "Cannot read properties of undefined (reading 'attachmentId')"，
        // 整轮报「运行失败」，且该坏块被写进会话日志后**后续每一轮都会复现**。
        render: (_args, value) => {
          const blocks = [{ type: 'text', text: value.summary ?? '' }];
          const image = value?.image;
          if (image !== undefined && image !== null) {
            blocks.push({
              type: 'image',
              attachment: {
                attachmentId: image.attachmentId,
                mediaType: image.mediaType,
                bytes: image.bytes,
                width: image.width,
                height: image.height,
                ...(image.name === undefined ? {} : { name: image.name }),
              },
            });
          }
          return blocks;
        },
      },
      async execute(args) {
        const capture = deps.capture;
        if (capture === undefined) {
          return { ok: false, summary: '截图模块不可用（capture.js 未加载）。' };
        }
        try {
          let result;
          if (args?.region !== undefined) {
            result = capture.captureRegion(args.region.x, args.region.y, args.region.width, args.region.height, {
              maxWidth: args?.maxWidth,
            });
          } else if (args?.hwnd !== undefined) {
            result = capture.captureWindow(args.hwnd, { maxWidth: args?.maxWidth });
          } else {
            result = capture.captureVirtualScreen({ maxWidth: args?.maxWidth });
          }
          if (result?.ok !== true) {
            return { ok: false, reason: result?.reason, summary: `截图失败：${result?.reason ?? '未知原因'}` };
          }
          const baseSummary = `已截取画面 ${result.width}×${result.height}（${result.method ?? 'unknown'}）`
            + `${args?.hwnd !== undefined ? `，目标窗口 ${args.hwnd}` : '，整个屏幕'}。`;

          // 把 PNG 落盘成持久附件引用，再把该引用交给 render 输出成 ImageBlock。
          // 拿不到 attachments 服务时降级为纯文字结果（模型看不到图但不报错）。
          const attachments = deps.attachments;
          if (attachments === undefined || !Buffer.isBuffer(result.png)) {
            return {
              ok: true,
              width: result.width,
              height: result.height,
              method: result.method,
              summary: `${baseSummary}（附件服务不可用，本轮未附带图片）`,
            };
          }

          let ref;
          try {
            ref = await attachments.saveImage({
              data: result.png,
              mediaType: 'image/png',
              name: `screenshot-${Date.now()}.png`,
            });
          } catch (error) {
            // 落盘失败（超限/编码异常等）同样降级为纯文字，不让整轮失败。
            return {
              ok: true,
              width: result.width,
              height: result.height,
              method: result.method,
              summary: `${baseSummary}（截图保存失败，未附带图片：${error?.message ?? String(error)}）`,
            };
          }

          return {
            ok: true,
            width: result.width,
            height: result.height,
            method: result.method,
            image: {
              attachmentId: String(ref.attachmentId),
              mediaType: ref.mediaType,
              bytes: ref.bytes,
              width: ref.width,
              height: ref.height,
              ...(ref.name === undefined ? {} : { name: ref.name }),
            },
            summary: baseSummary,
          };
        } catch (error) {
          return failure(error);
        }
      },
    },

    // -----------------------------------------------------------------------
    {
      name: 'vcu_ocr',
      description:
        '识别屏幕上的**文字**并返回文字及其坐标。用于：读取界面上的文字、找到某个按钮/菜单/链接的准确位置。'
        + '返回的每行/每词都带 bbox（边界框），配合 clientBbox 可直接得到 vcu_click 所需的客户区坐标。'
        + '\n\n适用场景：需要"精确定位某段文字"时用它，而不是靠肉眼估坐标。',
      parameters: {
        type: 'object',
        properties: {
          hwnd: { type: 'integer', description: '识别指定窗口（会截图再识别）。省略则识别整个屏幕。' },
          region: {
            type: 'object',
            description: '只识别屏幕某个区域（屏幕坐标）。',
            properties: {
              x: { type: 'integer' }, y: { type: 'integer' },
              width: { type: 'integer' }, height: { type: 'integer' },
            },
            required: ['x', 'y', 'width', 'height'],
            additionalProperties: false,
          },
          language: { type: 'string', description: '识别语言，如 "zh-Hans-CN"、"en-GB"，默认按系统。' },
          query: { type: 'string', description: '可选：只返回包含该子串的文本行，便于在大界面里直接找到目标。' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            summary: { type: 'string' },
            text: { type: 'string' },
            lines: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
          required: ['ok', 'summary'],
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: value.summary ?? '' }],
      },
      async execute(args) {
        const { capture, ocr } = deps;
        if (ocr === undefined || capture === undefined) {
          return { ok: false, summary: 'OCR 模块不可用（ocr.js / capture.js 未加载）。' };
        }
        try {
          let shot;
          if (args?.region !== undefined) {
            shot = capture.captureRegion(args.region.x, args.region.y, args.region.width, args.region.height, {});
          } else if (args?.hwnd !== undefined) {
            shot = capture.captureWindow(args.hwnd, {});
          } else {
            shot = capture.captureVirtualScreen({});
          }
          if (shot?.ok !== true) {
            return { ok: false, reason: shot?.reason, summary: `截图失败（OCR 前置步骤）：${shot?.reason ?? '未知原因'}` };
          }

          const recognized = await ocr.ocrImage(shot.png, { language: args?.language });
          if (recognized?.ok !== true) {
            return { ok: false, reason: recognized?.reason, summary: `OCR 失败：${recognized?.reason ?? '未知原因'}` };
          }

          // 把图片坐标换算成屏幕坐标与目标窗口客户区坐标，模型才能直接点。
          let lines = recognized.lines ?? [];
          if (Array.isArray(lines)) {
            lines = lines.map((line) => {
              const screenBbox = line.bbox === undefined ? undefined : {
                x: line.bbox.x + (shot.origin?.x ?? 0),
                y: line.bbox.y + (shot.origin?.y ?? 0),
                width: line.bbox.width,
                height: line.bbox.height,
              };
              let clientBbox;
              if (screenBbox !== undefined && args?.hwnd !== undefined) {
                const area = describeClientArea(args.hwnd);
                if (area.ok === true) {
                  clientBbox = {
                    x: screenBbox.x - area.clientOrigin.x,
                    y: screenBbox.y - area.clientOrigin.y,
                    width: screenBbox.width,
                    height: screenBbox.height,
                  };
                }
              }
              return {
                text: line.text,
                screenBbox,
                clientBbox,
                // 直接给出可点击的中心点，省掉模型自己算。
                clientCenter: clientBbox === undefined ? undefined : {
                  x: Math.round(clientBbox.x + clientBbox.width / 2),
                  y: Math.round(clientBbox.y + clientBbox.height / 2),
                },
              };
            });
          }

          if (typeof args?.query === 'string' && args.query !== '') {
            const q = args.query.toLowerCase();
            lines = lines.filter((l) => String(l.text ?? '').toLowerCase().includes(q));
          }

          const text = lines.map((l) => l.text).join('\n');
          return {
            ok: true,
            text,
            lines,
            lineCount: lines.length,
            language: recognized.language,
            summary: lines.length === 0
              ? `OCR 完成（语言 ${recognized.language ?? '未知'}），但没有识别到${args?.query ? `匹配「${args.query}」的` : ''}文字。`
              : `OCR 识别到 ${lines.length} 行文字${args?.query ? `（已按「${args.query}」过滤）` : ''}：\n${text.slice(0, 1500)}`,
          };
        } catch (error) {
          return failure(error);
        }
      },
    },

    // -----------------------------------------------------------------------
    {
      name: 'vcu_ui_tree',
      description:
        '读取窗口的 **UI 控件树**（按钮、输入框、菜单项等的名称、类型、位置、是否可用）。'
        + '用于精确了解一个程序界面上有哪些可交互控件，以及它们的准确位置。'
        + '\n\n优势：对原生 Win32 程序非常准确，能读到控件语义（例如"保存"按钮）。'
        + '局限：自绘界面、游戏、部分 UWP/Electron 程序可能读不到控件（会返回空树，这不是错误）。'
        + '注意这是较慢的操作，请按需使用，不要频繁轮询。',
      parameters: {
        type: 'object',
        properties: {
          hwnd: { type: 'integer', description: '目标窗口句柄。' },
          maxDepth: { type: 'integer', description: '最大遍历深度，默认 4。越大越慢。' },
          maxNodes: { type: 'integer', description: '最大节点数，默认 120。' },
          query: { type: 'string', description: '可选：只返回名称/类型包含该子串的控件。' },
        },
        required: ['hwnd'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            summary: { type: 'string' },
            nodes: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
          required: ['ok', 'summary'],
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: value.summary ?? '' }],
      },
      async execute(args) {
        const uia = deps.uia;
        if (uia === undefined) {
          return { ok: false, summary: 'UIA 模块不可用（uia.js 未加载）。' };
        }
        try {
          const tree = await uia.getTree(args.hwnd, {
            maxDepth: Number.isInteger(args?.maxDepth) ? args.maxDepth : 4,
            maxNodes: Number.isInteger(args?.maxNodes) ? args.maxNodes : 120,
          });
          if (tree?.ok !== true) {
            return { ok: false, reason: tree?.reason, summary: `读取控件树失败：${tree?.reason ?? '未知原因'}` };
          }
          let nodes = tree.nodes ?? [];
          if (typeof args?.query === 'string' && args.query !== '') {
            const q = args.query.toLowerCase();
            nodes = nodes.filter((n) => `${n.name ?? ''} ${n.controlType ?? ''} ${n.className ?? ''}`.toLowerCase().includes(q));
          }
          return {
            ok: true,
            nodes,
            nodeCount: nodes.length,
            summary: nodes.length === 0
              ? `窗口 ${args.hwnd} 没有可读的控件${args?.query ? `匹配「${args.query}」` : ''}（该程序可能是自绘界面，属正常现象）。`
              : `窗口 ${args.hwnd} 读到 ${nodes.length} 个控件${args?.query ? `（已过滤）` : ''}：\n`
                + nodes.slice(0, 40).map((n) => `- [${n.controlType ?? '?'}] ${n.name ?? '(无名)'}`
                  + `${n.bbox ? ` @(${n.bbox.x},${n.bbox.y} ${n.bbox.width}×${n.bbox.height})` : ''}`).join('\n'),
          };
        } catch (error) {
          return failure(error);
        }
      },
    },

    // -----------------------------------------------------------------------
    {
      name: 'vcu_find_image',
      description:
        '在屏幕上**按图找位置**（模板匹配）：给一张小图（图标/按钮截图），返回它在屏幕上的坐标。'
        + '用于反复出现的图标（例如某个工具栏按钮）——先截一次当模板，之后就能稳定定位。'
        + '\n\n提示：可用 vcu_save_template 从屏幕截取模板；再用本工具查找。'
        + '注意：模板与目标的缩放比例必须一致，DPI 或窗口缩放变化会导致找不到。',
      parameters: {
        type: 'object',
        properties: {
          templatePath: { type: 'string', description: '模板图片路径（PNG）。' },
          hwnd: { type: 'integer', description: '在该窗口内搜索（省略则搜整个屏幕）。' },
          threshold: { type: 'number', description: '相似度阈值 0~1，默认 0.9。越高越严格。' },
          maxResults: { type: 'integer', description: '最多返回几个匹配，默认 5。' },
        },
        required: ['templatePath'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            summary: { type: 'string' },
            matches: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
          required: ['ok', 'summary'],
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: value.summary ?? '' }],
      },
      async execute(args) {
        const matcher = deps.templateMatch;
        if (matcher === undefined) {
          return { ok: false, summary: '模板匹配模块不可用（template-match.js 未加载）。' };
        }
        try {
          const result = await matcher.findOnScreen(args.templatePath, {
            hwnd: args?.hwnd,
            threshold: typeof args?.threshold === 'number' ? args.threshold : 0.9,
            maxResults: Number.isInteger(args?.maxResults) ? args.maxResults : 5,
          });
          if (result?.ok !== true) {
            return { ok: false, reason: result?.reason, summary: `模板匹配失败：${result?.reason ?? '未知原因'}` };
          }
          const matches = result.matches ?? [];
          return {
            ok: true,
            matches,
            matchCount: matches.length,
            elapsedMs: result.elapsedMs,
            summary: matches.length === 0
              ? `没有找到匹配的图标（阈值 ${args?.threshold ?? 0.9}）。可以试试降低阈值，或确认模板与画面缩放一致。`
              : `找到 ${matches.length} 处匹配：\n`
                + matches.map((m) => `- 屏幕坐标 (${m.x}, ${m.y}) 相似度 ${(m.score ?? 0).toFixed(3)}`).join('\n'),
          };
        } catch (error) {
          return failure(error);
        }
      },
    },

    // -----------------------------------------------------------------------
    {
      name: 'vcu_save_template',
      description:
        '从屏幕截取一小块区域保存为模板图片，供 vcu_find_image 后续查找。'
        + '先用 vcu_screenshot 或 vcu_ocr 确定目标图标的屏幕坐标，再调用本工具截取它。',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'integer', description: '屏幕 X 坐标。' },
          y: { type: 'integer', description: '屏幕 Y 坐标。' },
          width: { type: 'integer', description: '宽度。' },
          height: { type: 'integer', description: '高度。' },
          path: { type: 'string', description: '保存路径（.png）。省略则自动生成到工作目录。' },
        },
        required: ['x', 'y', 'width', 'height'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, summary: { type: 'string' }, path: { type: 'string' } },
          required: ['ok', 'summary'],
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute(args) {
        const matcher = deps.templateMatch;
        if (matcher === undefined) {
          return { ok: false, summary: '模板匹配模块不可用（template-match.js 未加载）。' };
        }
        try {
          // saveTemplateFromRegion 要求显式路径（模板内部直接 writeFileSync），
          // 但工具描述里承诺"省略则自动生成"，所以这里补一个**绝对路径**默认值。
          // 用 tmpdir() 而不是相对路径：宿主的 CWD 不可预期，相对路径会写到意外位置。
          const path = typeof args?.path === 'string' && args.path !== ''
            ? args.path
            : join(tmpdir(), `vcu-template-${Date.now()}.png`);
          const result = await matcher.saveTemplateFromRegion(
            args.x, args.y, args.width, args.height, path,
          );
          if (result?.ok !== true) {
            return { ok: false, reason: result?.reason, summary: `保存模板失败：${result?.reason ?? '未知原因'}` };
          }
          return { ok: true, path: result.path, summary: `已保存模板到 ${result.path}（${args.width}×${args.height}）。可用 vcu_find_image 查找它。` };
        } catch (error) {
          return failure(error);
        }
      },
    },

    // -----------------------------------------------------------------------
    {
      name: 'vcu_video_capability',
      description:
        '自检"画面识别"各项能力的可用状态：截图、OCR、UI 控件树、模板匹配。'
        + '在你准备看图或识别界面之前，或某个视觉工具报错之后调用它，可以快速判断是环境缺失还是用法问题。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, summary: { type: 'string' } },
          required: ['ok', 'summary'],
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute() {
        const parts = [];
        const report = { ok: true };
        for (const [key, label] of [['capture', '截图'], ['ocr', 'OCR'], ['uia', 'UI 控件树'], ['templateMatch', '模板匹配']]) {
          const mod = deps[key];
          if (mod === undefined) {
            report[key] = { available: false, reason: '模块未加载' };
            parts.push(`${label}：不可用（模块未加载）`);
            continue;
          }
          let detail;
          try {
            const fn = mod.describeCapture ?? mod.describeOcr ?? mod.describeUia ?? mod.describeTemplateMatch ?? mod.describe;
            detail = typeof fn === 'function' ? await fn() : { available: true };
          } catch (error) {
            detail = { available: false, reason: error?.message ?? String(error) };
          }
          const available = detail?.available !== false && detail?.ok !== false && detail?.supported !== false;
          report[key] = detail;
          parts.push(`${label}：${available ? '可用' : `不可用（${detail?.reason ?? '未知'}）`}`);
        }
        return { ok: true, capabilities: report, summary: `画面识别能力自检：\n- ${parts.join('\n- ')}` };
      },
    },
  ];
}

/** 供诊断：FFI 层是否可用。 */
export function nativeAvailable() {
  return loadWin32().reason === undefined;
}
