# dsh-virtual-computer-use

**虚拟鼠标键盘的电脑操作插件**，为 DeepSeek Harness 提供不打断用户的桌面自动化能力。

面向 AI 助手的三件事：

1. **虚拟鼠标键盘** —— AI 操作屏幕时通过**窗口消息注入**驱动目标程序，**真实光标不动**，
   用户可以用自己的鼠标键盘同时操作同一台电脑，两者互不打架。
2. **「屏幕操作中」悬浮窗** —— AI 一开始操作，屏幕角落就出现一个置顶、半透明、
   点击穿透、**不抢焦点**的小窗，让用户始终知道电脑正在被 AI 控制。
3. **双击 ESC 中断** —— 全局监听键盘，连续按两下 ESC（默认 400ms 内）立即中断
   AI 正在跑的脚本操作。中断是**"粘住"的**：之后的操作调用都会被拒绝，直到显式复位，
   避免 AI 无视用户意图继续操作。

外加**画面识别**：截图（可抓被遮挡窗口）、Windows OCR、UI 控件树、模板匹配定位。

---

## 与 dsh-computer-use-win 的关系

本机同时装了另一个电脑操作插件 `dsh-computer-use-win`（MCP + UIA + PowerShell）。
两者**设计取向不同，可以并存**（工具名前缀不同：本插件是 `vcu_*`）：

| | `dsh-computer-use-win` | 本插件 `dsh-virtual-computer-use` |
|---|---|---|
| 输入方式 | `SendInput` / `SetCursorPos`（**真实**输入） | `PostMessage` 窗口消息（**虚拟**输入） |
| 用户能否同时操作 | **不能**，鼠标被抢占、光标乱飞 | **能**，真实光标不动 |
| 能力范围 | 更广（UIA 结构化调用、窗口管理等） | 较窄，但覆盖常见点击/输入/滚动/拖动/右键 |
| 适用场景 | 无人值守的批量操作 | **用户在场、需要并行使用电脑**时 |

---

## 安装

插件已以 `link:` 方式装进 desktop profile：

```
C:\Users\Administrator\.dsh\profiles\desktop\
  package.json       → dependencies 增加 "dsh-virtual-computer-use": "link:.../dsh-virtual-computer-use"
                       dsh.profile.bundles 增加 "dsh-virtual-computer-use"
  cordis.patch.yml   → 追加 - id: dsh-virtual-computer-use 配置块
```

改完执行 `pnpm install`（profile 目录内），然后**重启 DSH** 生效。

配置项（`cordis.patch.yml` 里可覆盖）：

| 键 | 默认 | 说明 |
|---|---|---|
| `overlay` | `true` | 是否显示「AI 正在操作电脑」悬浮窗 |
| `overlayText` | `AI 正在操作电脑` | 悬浮窗文案 |
| `overlayAbortedText` | `AI 操作已被中断` | 中断后的文案 |
| `overlayPosition` | `top-right` | 四角预设或 `{x,y}` |
| `lingerMs` | `1200` | 空闲后延迟隐藏（避免连续操作时闪烁） |
| `vision` | `true` | 是否加载画面识别能力 |
| `tools` | `true` | 是否把工具注册给模型 |
| `escAbort.enabled` | `true` | 是否启用双击 ESC 中断 |
| `escAbort.thresholdMs` | `400` | 两次 ESC 的最大间隔 |
| `escAbort.cooldownMs` | `400` | 命中后的冷却（保证三连击只触发一次） |

---

## 提供的工具（21 个，均以 `vcu_` 开头）

### 查询与定位

| 工具 | 作用 |
|---|---|
| `vcu_status` | 子系统状态：FFI 是否可用、是否正在操作、是否已被中断、配置阈值 |
| `vcu_list_windows` | 列出桌面顶层窗口（标题/类名/pid/位置尺寸） |
| `vcu_find_window` | 按标题子串/类名/pid 定位窗口，返回 `hwnd` |
| `vcu_window_info` | 窗口矩形、客户区尺寸、客户区原点屏幕坐标 |
| `vcu_foreground_window` | 当前前台窗口 |

### 虚拟鼠标

| 工具 | 作用 |
|---|---|
| `vcu_click` | 点击（左/中/右键、单击/双击），支持客户区或屏幕坐标 |
| `vcu_right_click` | 右键弹出上下文菜单（**会检测菜单是否真的弹出**） |
| `vcu_popup_menu` | 查看已弹出的菜单窗口信息 |
| `vcu_close_menu` | 关闭菜单（向菜单窗口投递 ESC） |
| `vcu_drag` | 左键拖动：`content` 拖内容（不碰光标）/ `window` 拖窗口（**占用真实鼠标**） |
| `vcu_scroll` | 滚轮滚动（粒度由目标控件决定） |
| `vcu_scroll_lines` | 逐行/逐页精确滚动（`WM_VSCROLL`，每消息恰好一行） |

### 虚拟键盘

| 工具 | 作用 |
|---|---|
| `vcu_type_text` | 输入文字（支持中文与 emoji 代理对） |
| `vcu_press_key` | 按键/组合键（`enter`、`ctrl+a`、`f5` …） |

### 画面识别

| 工具 | 作用 |
|---|---|
| `vcu_screenshot` | 截图返回给模型看（可指定窗口，**能抓被遮挡窗口**） |
| `vcu_ocr` | 屏幕文字识别（返回文字 + 坐标，可直接喂给 `vcu_click`） |
| `vcu_ui_tree` | 读取 UI 控件树（按钮/输入框名称与位置） |
| `vcu_find_image` | 模板匹配：按小图找屏幕位置 |
| `vcu_save_template` | 从屏幕截取一块存为模板 |
| `vcu_video_capability` | 画面识别能力自检 |

### 中断控制

| 工具 | 作用 |
|---|---|
| `vcu_reset_abort` | 复位中断状态（**必须传 `confirm:true`**，不要自行绕过用户中断） |

另有两个 HTTP 诊断路由：
- `GET /virtual-computer-use/status` —— 完整状态 JSON
- `POST /virtual-computer-use/control` —— 手动 `show-overlay` / `hide-overlay` / `abort` / `reset` / `focus-check`

---

## 典型工作流

**看图 → 定位 → 点击**（本插件最推荐的用法）：
```
vcu_screenshot(hwnd=123)                     # 1. 看界面
vcu_ocr(hwnd=123, query="保存")               # 2. 找到"保存"的文字与坐标
   → 返回 clientCenter: {x: 65, y: 11}        #    已换算成客户区坐标
vcu_click(hwnd=123, x=65, y=11)              # 3. 直接点它
```

**右键菜单**：
```
vcu_right_click(hwnd=123, x=40, y=20)        # 弹出菜单（会报告 menuAppeared）
vcu_screenshot(hwnd=<菜单hwnd>)               # 看菜单里有什么
vcu_click(hwnd=<菜单hwnd>, x=117, y=12)       # 点菜单项（坐标相对菜单窗口）
```

**需要用户中断时**：用户按下两下 ESC，之后任何操作类工具都会返回
`{ ok:false, aborted:true }` 并提示模型停止。用户确认继续后调用
`vcu_reset_abort(confirm=true)`。

---

## 已知局限（**实测得出，请务必了解**）

这一节是本插件最重要的部分 —— 这些限制不是猜测，而是控制变量实验的结论。
不了解它们会导致"工具报告成功但实际没生效"。

### 1. 非字符按键经纯消息注入**不可靠**（最重要）

`PostMessage` 把消息直接塞进目标窗口队列，**绕过了接收线程消息循环里的
`TranslateMessage`**。因此依赖消息翻译的非字符按键语义**不会被目标解释**。

真实记事本控制变量实测：

| 通道 | 纯 PostMessage 下 | 证据 |
|---|---|---|
| `WM_CHAR`（字符、中文、emoji） | **可靠** | 写入与回读完全一致 |
| `WM_MOUSE*`（鼠标点击/移动/滚轮） | **可靠** | 记事本选区正确形成 |
| `EM_*`（编辑控件消息） | **可靠** | `EM_SETSEL` 全选 0..11、`EM_REPLACESEL` 精确改写 |
| 裸 `WM_KEYDOWN` 的非字符语义 | **不可靠** | `Delete`/`Home`/方向键消息投递成功但**毫无效果** |

特别注意一个坑：`Ctrl+A` 走按键路径时，选区**没有**全选，反而会**多插入一个
字面量 `"a"`**（修饰键没生效、`a` 被当普通字符插入）。实测文本
`"ABCDEFG"` → `"ABCDEFGaABCDE"`。

因此对**编辑控件**，本插件优先走 `EM_*`：
`selectAll()` / `replaceSelection()` / `clearSelection()` / `edit()`，
并且这些函数会**回读验证**（`verified:true`）而不只是报告"消息已投递"。

`pressKey` / `keyCombo` 的返回值带 `reliability` / `degraded` / `note` /
`recommendedAlternative` —— 非字符键会明确标注为不可靠，**不会用 `ok:true`
伪装成功**。请据此选择路径。

### 2. 对某些目标程序完全无效或不可靠

| 目标类型 | 情况 |
|---|---|
| UWP / 打包应用（设置、计算器等） | 输入走 CoreWindow/InputPane，`WM_*` 不进其输入泵 |
| **以管理员权限运行的程序** | UIPI 会丢弃低完整性进程的消息，`PostMessageW` 直接返回 `false` |
| Chromium / Electron 的部分控件 | 渲染进程自有输入转发，主窗口的 `WM_MOUSE*` 可能被忽略 |
| 终端（Windows Terminal / conhost） | 走 ConPTY 自有输入通道 |
| DirectInput / 全屏游戏 / 远程桌面 | 轮询 `*AsyncKeyState`，完全无视消息队列 |
| 挂死的窗口（`IsHungAppWindow`） | 消息永远不会被处理 |

`vcu_status` 与 `describeSensitivity()` 会按类名/映像名给出**启发式**提示
（是启发式，不是保证）。

### 3. 拖动窗口需要真实鼠标（本插件唯一的例外）

拖动**内容**（选中文字等）走纯消息，**不碰真实光标**（实测选中 16/58 字都正确）。

拖动**窗口标题栏**则完全不同。四组对照实验：

| 方案 | 结果 |
|---|---|
| A. `SetWindowPos(HWND_TOP)` + `PostMessage(WM_NCLBUTTONDOWN, HTCAPTION)` | 窗口**不动** |
| B. `SetForegroundWindow` + `BringWindowToTop` + 同上 | 窗口**不动** |
| C. A+B 组合 + 同上 | 窗口**不动** |
| D. `SetCursorPos` + **真实 `SendInput` 左键按住** + 移动光标 + 松开 | **位移精确等于请求值 (140,100)** |

原因：窗口拖动是**窗口管理器的模态循环**，它同时需要 (1) 真实光标位置、
(2) **真实鼠标按键状态**。只发消息不够 —— 模态循环读的是**系统真实按键状态**，
不看消息队列。

所以 `vcu_drag(mode:"window")` 是本插件里**唯一**会碰真实光标的路径：
- 返回值显式标注 `usesRealCursor:true` + `warning`
- 默认 `restoreCursor:true`，拖完把光标放回原处
- **前提**：目标标题栏必须在 Z 序最前且未被遮挡。被遮挡时会**如实返回
  `moved:false`**（不谎报），调用方应先抬顶：
  `SetWindowPos(hwnd, HWND_TOP, x, y, 0, 0, SWP_NOSIZE|SWP_SHOWWINDOW)` + `BringWindowToTop`。
  注意 `SetForegroundWindow` **不足够**（前台 ≠ Z 序最顶），且 flags 组合不含
  z-order 位时也不会真正抬顶。

**只在用户明确要求移动窗口时使用。**

### 4. 画面识别

- **PrintWindow 抓不到**：硬件加速表面（视频播放器、GPU 合成游戏、部分 Electron canvas）、
  部分 UWP/Store 应用（仍返回 `true` 但图全黑）、最小化窗口（无可渲染客户区）。
  → 判断依据是 `content.nonBlackRatio`，**不要只看返回值**。
- 抓取被遮挡甚至**移到屏幕外**的窗口是可行的（实测窗口移到 `(-4000,-4000)`
  仍抓到 `nonBlackRatio=0.98` 且 OCR 读出文本；同屏幕位置对照组相似度仅 0.20）。
- **OCR 识别率**：小字号（≤10px）、细体、低对比度会误读或漏字。
  中文引擎对**拉丁字母/数字常读成形近汉字**（实测 `Hello`→`He110`、`2026`→`2926`、
  `Windows`→`Wlndows`）。`scale > 1` 放大后再 OCR 通常明显改善。
  OCR 无置信度输出，每次要起一个 PowerShell 子进程（350~500ms）。
- **UIA 控件树**：Win11 记事本（XAML 应用）只有 2 个节点（Edit + 状态栏），
  **没有菜单项** —— 这是它 provider 本身暴露得少。游戏/自绘界面/远程桌面画面
  根本没有控件树（返回 `ok:true` + 空树 + 说明，与真失败区分）。
  遍历 Electron/Chromium/UWP 很慢，已设深度/节点上限与子进程超时。
- **Win32 弹出菜单（`#32768`）不暴露 UIA**（只有一个空 Pane、0 个子节点）。
  读菜单内容请用 `vcu_screenshot` 或 `vcu_ocr`（实测 OCR 能读出菜单项文字）。
- **模板匹配**：DPI/缩放/主题变化会失效（像素级比对）；零方差区域
  （如纯白空编辑区）**刻意返回不匹配**而不是满屏假命中。
  性能：全屏 `stride=1` 约 9s（太慢）；`stride=4` 约 0.9s；
  **限定 `searchRegion` 约 260ms**（推荐）。

### 5. 滚轮粒度与插入点

- 滚轮**方向**语义正确（`delta<0` 向下、`delta>0` 向上，已双向确定性验证）。
- 但**粒度由目标控件决定**：实测记事本里一格滚轮可能跳十几行甚至直接到底，
  无法由调用方精细控制。需要精确滚动请用 `vcu_scroll_lines`（实测每消息恰好一行）。
- `WM_MOUSEWHEEL` 与其它鼠标消息不同：**lParam 是屏幕坐标**（本插件已正确处理）。
- 编辑控件的**插入点会把视图"钉住"**：caret 在文档末尾时向上滚动会被立刻拉回底部。
  这是控件行为，自动化时需留意。

### 6. 其它

- **`PostMessage` 不修改真实键盘状态表**：目标内部 `GetKeyState(VK_CONTROL)`
  看到的仍是用户物理键盘的状态（已通过 `modifierStateNote` 暴露）。
- 跨进程 `WM_GETTEXT` 回读**不可用**（lParam 是调用方地址空间的指针，
  目标进程写不回我们的缓冲）。目前只有 `EM_GETLINE`（编辑控件）可靠。
  非编辑控件的通用回读需要 UIA。**阅读文本请优先用 `vcu_screenshot` + `vcu_ocr`。**
- 悬浮窗与 ESC 钩子都是**单例**：一个进程只能有一套 ESC 手势。

---

## 架构

```
host.js                    插件入口：读配置 → 接线 → 注册工具/路由 → 清理
├─ lib/native.js           Win32 FFI 绑定（koffi）+ 常量；逐函数隔离的绑定
├─ lib/windows.js          窗口发现/查找；弹出菜单检测与关闭；进程映像查询
├─ lib/tracker.js          活动追踪：悬浮窗显隐与中断状态的唯一裁决者
├─ lib/tools.js            21 个 vcu_* 工具定义
├─ lib/virtual-input.js    虚拟输入：鼠标/键盘/拖动/精确滚动 + 编辑控件可靠路径
├─ lib/overlay.js          「屏幕操作中」悬浮窗（纯 FFI 建窗 + GDI 绘制）
├─ lib/esc-abort.js        全局双击 ESC 中断（低级键盘钩子 + 沿触发语义）
├─ lib/capture.js          截图（PrintWindow / 全屏 / 区域 / 显示器枚举）
├─ lib/png.js              零依赖 PNG 编解码与缩放
├─ lib/ocr.js              Windows OCR 封装 + bbox → 屏幕/客户区坐标换算
├─ lib/uia.js              UI 控件树读取（只读）
└─ lib/template-match.js   NCC 模板匹配（零依赖，含最小 PNG 解码）
```

### 几个关键设计决定

**1. 复用宿主自带的 koffi，零依赖安装。**
DSH 桌面外壳已在 `@deepseek-ai/dsh-desktop-host` 里带了 koffi，插件通过三级回退解析：
宿主入口 → `.unpacked` 下的 `koffi.node` → 插件自身的 `node_modules`。
`DSH_VCU_KOFFI_ROOT` 环境变量可显式覆盖。

**2. 每个 Win32 绑定独立隔离。**
这**不是**预防性空想：开发中 `FillRect` 曾被误绑到 `gdi32`（实际在 `user32`），
而当时所有绑定写在一个大 `try` 里 → 一个名字绑错导致**整块绑定失败** →
`loadWin32()` 返回 `{reason}` → **所有能力全废**（连 `GetCursorPos` 都没了）。
现在每个函数独立 `try/catch`，失败只记入 `failures` 数组并暴露在
`describeNative()` 里，最坏情况只影响那一个函数。

**3. 悬浮窗与中断都由 `OperationTracker` 裁决，而不是每个动作各自开关。**
引用计数 + `lingerMs` 延迟隐藏：连续操作时悬浮窗稳定存在（不闪烁），
真正空闲后及时消失。中断一旦触发即"粘住"，后续操作调用被拒绝 ——
否则用户按的 ESC 只杀掉当前动作、模型下一步还会继续操作电脑。

**4. 惰性初始化。**
各模块在首次实际用到时才动态 import。插件加载本身永远轻量、永远成功；
某个子模块出问题只影响对应功能，不会拖垮 profile 启动。

**5. 源码完整性守卫（`test/encoding-guard.test.mjs`）。**
开发中发生过一次事故：用 PowerShell 的
`(Get-Content x.js -Raw) | Set-Content x.js` 就地把某个源文件改名，
而**这台机器上 PowerShell 会按 GBK 读取 UTF-8 文件再以 UTF-8 写回**，
导致 939 个中文字符变成 `?`（不可恢复）、换行丢失、文件语法失效。
这类损坏在 diff 里极不显眼（看着只是"注释变了"）。

守卫测试对所有 `lib/*.js` 检查：无 U+FFFD、无 GBK 乱码特征字符、
无可疑的中文-问号替代痕迹、`node --check` 可解析。
它是防止该类事故复发的自动化保障。

> **给维护者的提醒：在这台机器上不要用 PowerShell 的 `Get-Content`/`Set-Content`
> 做 UTF-8 文件的往返。** 请用编辑工具。

---

## 测试

全部套件均可独立运行，失败时以非零退出码结束：

```
node test/encoding-guard.test.mjs      # 源码编码与语法完整性
node test/native.test.mjs              # FFI 绑定与 FillRect 回归
node test/contract.test.mjs            # 跨模块契约（capture ↔ template-match 等）
node test/integration.test.mjs         # 跨模块接缝（overlay/esc-abort ↔ tracker）
node test/host-mount.test.mjs          # 宿主挂载冒烟（模拟 cordis Context 调 apply）
node test/virtual-input.test.mjs       # 虚拟输入（含 emoji 代理对、光标不动）
node test/rightclick-scroll.test.mjs   # 右键菜单 + 滚轮/逐行滚动
node test/drag.test.mjs                # 拖动（内容 / 窗口）
node test/esc-overlay.test.mjs         # 双击 ESC 中断 + 悬浮窗
node test/vision.test.mjs              # 截图 + OCR 端到端
node test/uia-template.test.mjs        # UIA 控件树 + 模板匹配
node test/e2e.test.mjs                 # 端到端验收（四大需求逐条）
```

当前状态：**全部套件零失败**（合计 300+ 项断言）。

### 测试设计上的两条经验（都踩过坑）

**1. "没动"类断言不能用单点前后比较。**
`光标没动`、`前台没变`这类判据若比较"操作前 vs 操作后"两个点，会被
**用户实时移动鼠标/切换窗口**污染 —— 实测出现过 `844,85 → 909,238`（用户手抖）
和 `68232 → 983358`（用户切窗口）这类假阳性。正确做法是：
- **代码级硬保证**：断言目标源码函数体里不存在 `SetCursorPos`/`SendInput`
  （"代码层面不可能"比任何运行时统计都硬，且完全不受用户活动影响）
- 运行时对照只作观察性信息，或使用能免疫突发噪声的判据

**2. 视口/滚动类断言必须先把状态锚定到"有双向余量"的位置。**
- 插入点（caret）会"钉住"视图，anchor 在末尾时向上滚会被拉回底部
- 锚点不能贴两端：贴顶时"向上滚"无处可去、贴底时"向下滚"无处可去
- 写入多行文本后视图需要时间稳定（实测前两轮读到 28/360，第三轮才稳定为 0）
- 夹具行数要足够多且**不要折行**（折行会打乱"行号"语义）

---

## 未解决 / 未定位的问题（如实记录）

1. **一次未复现的偶发**：`virtual-input.test.mjs` 曾出现 `injections=0`
   （注入组一条消息都没投递、`maxDisplacement` 异常）。在"干净单进程"与
   "并发抢 notepad"两种条件下各跑 3 次**均未复现**，根因**未定位**。
   同一测试的脆弱光标断言已修（见上文测试经验 1），但这与 `injections=0`
   可能不是同一问题。若再次出现，建议打印当时的 `hwnd` / `probeWindow` / `pid`
   以确认目标是否指向了非预期对象。
2. **另一次未复现的偶发（`vision.test.mjs`）**：在一次全量连跑（12 个套件连续执行）中，
   `vision.test.mjs` 出现 82/83（1 项失败），但紧接着**连续 5 次单独复跑、以及一次
   并发负载下复跑，都是 83/83**，失败的具体断言未能捕获（该项在复跑时不再出现）。
   怀疑与第 1 条同源（运行时扰动落在采样窗口内），但**同样未定位**。
   该测试已按"系统性 vs 突发性"双层判据设计（见上文测试经验 1），
   理论上应对用户活动免疫，因此这次偶发值得后续留意。
3. **`pressKey` 的可靠性分级**：只有功能键/ESC 标为 `medium`（"窗口过程通常直接处理"
   的推断），**未做逐键实测**。刻意保持保守，不宣称任何键为 `high`。
4. **`stride=1` 的全屏模板匹配约 9s**，未达"10s 以内"目标。可用路径是
   `searchRegion`（约 260ms）或 `stride=4`（约 0.9s）。未实现多尺度金字塔
   （收益/复杂度不划算）。
5. **人手真实双击 ESC 未做端到端测试**（会干扰用户），只做了合成按键测试。
6. **UIA 每次调用启一个 PowerShell 子进程**（固定开销 300~700ms）。
   高频调用值得做常驻 worker，但会引入生命周期/僵尸进程风险，
   按"可预测优先"保持一次一进程。
7. **`stride>1` 在逐像素噪声图上会原理性漏检**（位移 1px 就让 NCC 从 1.00 掉到 0.05），
   已在返回值 `warnings` 里显式提示，不做静默失败。
8. **`Window` 级别的并发约定**：`virtual-input.test.mjs`、`vision.test.mjs`、
   `drag.test.mjs`、`rightclick-scroll.test.mjs`、`e2e.test.mjs` 都会 spawn notepad
   并可能争抢前台。建议**不要并发运行这些套件**，按顺序执行（本 README 的
   测试清单即为推荐顺序，已验证全量顺序执行零失败）。

---

## 事故记录

**2026-10-16：源文件被 PowerShell 编码往返损坏。**
在 `lib/virtual-input.js` 里做就地文本替换时用了
`(Get-Content -Raw) -replace ... | Set-Content`，导致 939 个中文字符变为 `?`、
换行丢失、语法失效。损坏版本保留在 `docs/virtual-input.js.corrupt-bak`
作为证据。文件已由原作者依规格完整重建，并由此新增了
`test/encoding-guard.test.mjs` 守卫。**教训：本机不要用 PowerShell 文本管道改 UTF-8 源文件。**

---

## 许可

MIT
