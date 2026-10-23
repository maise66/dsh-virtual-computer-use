/**
 * dsh-virtual-computer-use —— UI 控件树识别层（Microsoft UI Automation）。
 *
 * ## 为什么走 PowerShell 子进程
 *
 * .NET 的 `UIAutomationClient` / `UIAutomationTypes` 只能在 .NET 运行时里用，
 * Node 通过 koffi 直接调 `UIAutomationCore.dll` 的 COM 接口需要手写 vtable
 * 偏移，脆弱且极易在 `IUIAutomationElement` 的缓存/跨进程序列化上踩坑。
 * 本机实测 `powershell.exe` + `Add-Type -AssemblyName UIAutomationClient,
 * UIAutomationTypes` 可以直接用，所以这条路径被固化为**唯一实现**。
 *
 * 关键坑（Lead 实测）：
 *   - `pwsh`（PowerShell 7）在本机**不存在**，必须用 `powershell.exe`
 *     （Windows PowerShell 5.1，`%SystemRoot%\System32\WindowsPowerShell\v1.0\`）。
 *   - Windows PowerShell 5.1 的 `-File` 读取 .ps1 时，**无 BOM 的 UTF-8 会被
 *     当成 ANSI（GBK）解码**，中文字面量会乱码。本模块写脚本时一律加 UTF-8 BOM。
 *   - stdout 若含非 ASCII，`Console.OutputEncoding` 默认是 GBK，Node 会读到乱码。
 *     脚本里显式 `[Console]::OutputEncoding = UTF8Encoding(false)`，并在写 JSON
 *     时用 `[Console]::OpenStandardOutput().Write(bytes, ...)` 直接写 UTF-8 字节，
 *     绕开控制台编码层。实测中文 + emoji 往返无损。
 *
 * ## 为什么必须有硬性资源上限
 *
 * 跨进程 UIA 遍历是**同步 COM 调用**，目标进程无响应时单个 `Current.*` 取值
 * 就会阻塞数秒。Chromium / Electron / UWP 的树可以有几万个节点。没有上限
 * 会直接把宿主（长期存活的 Electron 主进程）挂死。
 *
 * 因此这里是三重防护：
 *   1. 脚本内 `maxDepth` 深度上限（默认 5）
 *   2. 脚本内 `maxNodes` 节点数上限（默认 200）
 *   3. Node 侧子进程 `timeoutMs` 超时（默认 25s）—— 超时 `kill` 掉整个进程树
 *
 * 此外脚本内还对每个元素包了 try/catch：**单个元素取值失败不能让整棵树报废**
 * （例如元素在遍历过程中被销毁，会抛 `ElementNotAvailableException`）。
 *
 * ## 职责边界（重要）
 *
 * 本模块**只读**。结构化调用（InvokePattern / TogglePattern / ValuePattern.SetValue）
 * 刻意**不实现**：本插件的输入一律由 `lib/virtual-input.js` 走窗口消息注入，
 * 两条写入路径会互相打架（例如 UIA Invoke 会真的抢焦点）。理由与建议见 README/报告。
 *
 * ## 坐标语义
 *
 * UIA 的 `BoundingRectangle` 是**屏幕物理像素**坐标，与 `GetWindowRect` 同一个
 * 坐标系，因此 `toClient` 不需要任何 DPI 缩放。这一点很重要：插件里其余模块
 * （截图、窗口消息注入）也都在物理像素坐标系里工作，全链路一致。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// PowerShell 定位
// ---------------------------------------------------------------------------

/** Windows PowerShell 5.1 的绝对路径（`pwsh` 在本机不存在，不要用）。 */
function powershellPath() {
  const override = process.env.DSH_VCU_POWERSHELL;
  if (typeof override === 'string' && override !== '' && existsSync(override)) return override;
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  const full = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (existsSync(full)) return full;
  // System32 在 32 位宿主里会被重定向到 SysWOW64，显式再试一次真实的 System32。
  const native = join(root, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (existsSync(native)) return native;
  return 'powershell.exe';
}

/**
 * 把脚本编码成 `-EncodedCommand` 需要的 **UTF-16LE base64**。
 *
 * 这是本项目实测踩到的坑：`-EncodedCommand` 要求的是 UTF-16LE 字节的 base64，
 * 传 UTF-8 base64 会让 PowerShell 把整段脚本解成乱码，报
 * `CommandNotFoundException` / `ObjectNotFound`，且错误信息本身也是乱码。
 * 用 UTF-16LE 之后，中文与 emoji 都能原样送达。
 *
 * 用 `-EncodedCommand` 而不用 `-File` 的原因：`-File` 读取无 BOM 的 UTF-8
 * .ps1 时会按 ANSI（GBK）解码，中文字面量会乱码；`-Command` 则要处理引号
 * 转义地狱。`-EncodedCommand` 两者都避开，且不需要落盘临时文件（没有清理负担）。
 */
function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

// ---------------------------------------------------------------------------
// 脚本模板
// ---------------------------------------------------------------------------

/**
 * PowerShell 前置段里用到的 `IsWindow` 绑定。
 *
 * 为什么在这里再绑一次而不是复用 `lib/native.js`：本模块目前只需要这一个
 * 函数做"句柄还活着吗"的判定，为一个判定把整个 native 层拖进来会让
 * `lib/uia.js` 在 native.js 加载失败时连纯 UIA 的路径都不可用。
 * 这里用 Add-Type 内联 P/Invoke，零额外依赖，且只影响 UIA 子进程。
 */
const PS_ISWINDOW_TYPE = `
if (-not ('DshVcuUser32IsWindow' -as [type])) {
  Add-Type -Namespace '' -Name 'DshVcuUser32IsWindow' -MemberDefinition '
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  ' -ErrorAction SilentlyContinue
}
`;

/**
 * 共享的 PowerShell 前置段：加载 UIA、统一 UTF-8 输出、把结果 JSON 写成
 * `__DSHVCU_BEGIN__<json>__DSHVCU_END__` 的定界块。
 *
 * 为什么要定界块：PowerShell 可能往 stdout 混入 CLR/程序集加载警告，直接
 * `JSON.parse` 整段输出会失败。定界块让解析对噪声免疫。
 */
const PS_PRELUDE = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
} catch {
  Write-Output "__DSHVCU_BEGIN__{\\"ok\\":false,\\"reason\\":\\"UIA_NOT_AVAILABLE: $($_.Exception.Message)\\"}__DSHVCU_END__"
  exit 0
}
${PS_ISWINDOW_TYPE}
# 目标解析失败的原因（让调用方能区分"窗口没了"和"没有匹配"）。
$script:TopLevelFailReason = ''
function Emit($obj) {
  $json = $obj | ConvertTo-Json -Depth 8 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes("__DSHVCU_BEGIN__" + $json + "__DSHVCU_END__")
  [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
  [Console]::Out.Flush()
}
# 单元素取值包装：元素在遍历中被销毁会抛 ElementNotAvailableException，
# 绝不能让单个节点废掉整棵树。
function Safe([scriptblock]$block, $default) {
  try { $v = & $block; if ($null -eq $v) { return $default } return $v } catch { return $default }
}
function RectOf($el) {
  try {
    $r = $el.Current.BoundingRectangle
    if ($r.IsEmpty) { return $null }
    return @{ x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height }
  } catch { return $null }
}
function InfoOf($el, $depth, $counter) {
  $name = Safe { $el.Current.Name } ''
  $cls  = Safe { $el.Current.ClassName } ''
  $aid  = Safe { $el.Current.AutomationId } ''
  $ct   = Safe { $el.Current.ControlType.ProgrammaticName } ''
  if ($ct -like 'ControlType.*') { $ct = $ct.Substring(12) }
  $enabled = $false
  try { $enabled = [bool]$el.Current.IsEnabled } catch {}
  $offscreen = $false
  try { $offscreen = [bool]$el.Current.IsOffscreen } catch {}
  return [ordered]@{
    id           = $counter
    name         = [string]$name
    controlType  = [string]$ct
    className    = [string]$cls
    automationId = [string]$aid
    bbox         = (RectOf $el)
    enabled      = $enabled
    offscreen    = $offscreen
    depth        = $depth
  }
}
function WalkerFor($mode) {
  if ($mode -eq 'raw')     { return [System.Windows.Automation.TreeWalker]::RawViewWalker }
  if ($mode -eq 'content') { return [System.Windows.Automation.TreeWalker]::ContentViewWalker }
  return [System.Windows.Automation.TreeWalker]::ControlViewWalker
}
function AndAll($conditions) {
  $list = @($conditions | Where-Object { $null -ne $_ })
  if ($list.Count -eq 0) { return [System.Windows.Automation.Condition]::TrueCondition }
  if ($list.Count -eq 1) { return $list[0] }
  return (New-Object System.Windows.Automation.AndCondition($list))
}
function PidClassAnd($pid_, $class_) {
  $conds = @()
  if ($pid_ -gt 0) { $conds += (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $pid_)) }
  if ($class_ -ne '') { $conds += (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, $class_)) }
  return (AndAll $conds)
}
function TopLevelFor($hwnd_, $pid_, $class_, $title_) {
  # 首选：直接用 hwnd 换 UIA 元素——最精确，且对"同进程多窗口"无歧义。
  #
  # 关键：FromHandle 对**无效句柄**会抛异常（实测 hwnd=1000000000 / 1 报
  # "Unrecognized error."，hwnd=0 报 "hwnd cannot be IntPtr.Zero or null."），
  # 而**不是**安静地返回 null。
  # 早先版本用 try/catch 吞掉异常后继续走 pid/class 回退，回退路径在
  # "pid 也是 0" 时用 TrueCondition 匹配到**任意**顶层窗口，于是查一个
  # 不存在的 hwnd 竟然返回了 ok:true + 别的窗口的树。这是一个真实缺陷：
  # 调用方会以为拿到了目标窗口的控件树。
  #
  # 现在显式区分三种情况：
  #   a. 调用方给了 hwnd，但 IsWindow 判定它不是窗口 → 直接判定目标不存在，**不回退**。
  #   b. FromHandle 成功 → 用它。
  #   c. FromHandle 抛异常（窗口在调用瞬间被销毁）→ 记原因，允许 pid 回退。
  if ($hwnd_ -ne 0) {
    $alive = $false
    try { $alive = [bool][DshVcuUser32IsWindow]::Call([IntPtr]$hwnd_) } catch { $alive = $true }
    if (-not $alive) {
      $script:TopLevelFailReason = "hwnd $hwnd_ is not a valid window (the app may have closed, or the handle is stale)"
      return $null
    }
    try {
      $el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd_)
      if ($null -ne $el) { return $el }
      $script:TopLevelFailReason = "AutomationElement::FromHandle($hwnd_) returned null"
    } catch {
      $script:TopLevelFailReason = "AutomationElement::FromHandle($hwnd_) threw: $($_.Exception.Message)"
    }
  }
  # 回退：按 pid（+ 类名）在 RootElement 的子级里找。
  # 注意 pid=0 且 className='' 时 PidClassAnd 会返回 TrueCondition，
  # 那会匹配任意窗口 —— 明确禁止这种"无约束回退"。
  if ($pid_ -gt 0 -or $class_ -ne '') {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, (PidClassAnd $pid_ $class_))
    if ($null -ne $el) { return $el }
    # 再回退：只要 pid 命中就取第一个（类名可能读不到，例如 UWP 的 ApplicationFrameWindow）。
    if ($pid_ -gt 0) {
      $all = $root.FindAll([System.Windows.Automation.TreeScope]::Children, (PidClassAnd $pid_ ''))
      foreach ($cand in $all) {
        if ($title_ -ne '' -and (Safe { $cand.Current.Name } '') -eq $title_) { return $cand }
      }
      if ($all.Count -gt 0) { return $all[0] }
    }
  }
  if ($script:TopLevelFailReason -eq '') {
    $script:TopLevelFailReason = 'no AutomationElement matched the given hwnd/pid/className'
  }
  return $null
}
`;

/**
 * 各脚本里统一的"目标不存在"错误。把 PowerShell 侧记录的具体原因带出来，
 * 让调用方能区分：
 *   - `hwnd N is not a valid window ...` → 窗口已关闭/句柄过期（**真失败**）
 *   - `FromHandle threw: ...` → 竞争条件，窗口在查询瞬间被销毁
 *   - `no AutomationElement matched ...` → 过滤条件没命中
 */
const TARGET_NOT_FOUND_EMIT = `Emit @{ ok = $false; reason = ('UIA_TARGET_NOT_FOUND: ' + $script:TopLevelFailReason) }`;

/** 生成读整棵树的脚本。 */
function treeScript(options) {
  const { hwnd, pid, className, title, maxDepth, maxNodes, includeOffscreen, viewMode } = options;
  return `${PS_PRELUDE}
$maxDepth = ${maxDepth}
$maxNodes = ${maxNodes}
$includeOffscreen = $${includeOffscreen ? 'true' : 'false'}

$top = TopLevelFor ${hwnd} ${pid} '${psQuote(className)}' '${psQuote(title)}'
if ($null -eq $top) {
  ${TARGET_NOT_FOUND_EMIT}
  exit 0
}

$walker = WalkerFor '${viewMode}'
$nodes = New-Object System.Collections.ArrayList
$counter = 0
$truncatedByDepth = $false
$rootRect = RectOf $top

function Walk($el, $depth) {
  if ($depth -gt $maxDepth) { $script:truncatedByDepth = $true; return }
  $child = $null
  try { $child = $walker.GetFirstChild($el) } catch { return }
  while ($null -ne $child) {
    if ($script:nodes.Count -ge $maxNodes) { return }
    $script:counter++
    $info = InfoOf $child $depth $script:counter
    if ($includeOffscreen -or (-not $info.offscreen)) { [void]$script:nodes.Add($info) }
    Walk $child ($depth + 1)
    $next = $null
    try { $next = $walker.GetNextSibling($child) } catch { break }
    $child = $next
  }
}
Walk $top 0

Emit @{
  ok = $true
  nodes = @($nodes)
  count = $nodes.Count
  depthLimited = $truncatedByDepth
  nodeLimited = ($nodes.Count -ge $maxNodes)
  maxDepth = $maxDepth
  maxNodes = $maxNodes
  viewMode = '${viewMode}'
  root = (InfoOf $top 0 0)
  rootRect = $rootRect
}
`;
}

/**
 * 生成读单个元素的脚本（含各 Pattern 的值与可用性探测）。
 *
 * `nodeId` 的三种形式在 **Node 侧**解析成 `targetHwnd` / `targetIndex` / `targetName`
 * 三个类型明确的量再注入脚本。
 *
 * 这是修掉的一个真实 bug：早先版本把 `"123456:7"` 整个字符串插进 PowerShell 的
 * `-eq` 比较里，`123456:7` 不是合法表达式，PowerShell 直接解析失败退出 1，
 * 调用方只能看到 `UIA_PROTOCOL_ERROR`。类型化注入从根上避免这类拼接错误。
 */
function elementScript(options) {
  const { hwnd, pid, className, title, nodeId, name, timeoutMs } = options;
  return `${PS_PRELUDE}
# 1) 按序号定位（与 getTree 相同的遍历顺序，保证 id 稳定可复现）。
function Locate($top, $wantIndex) {
  $walker = WalkerFor 'control'
  $script:found2 = $null
  $script:counter2 = 0
  function Walk2($el, $depth) {
    if ($depth -gt 20 -or $null -ne $script:found2) { return }
    $child = $null
    try { $child = $walker.GetFirstChild($el) } catch { return }
    while ($null -ne $child) {
      if ($null -ne $script:found2) { return }
      $script:counter2++
      if ($script:counter2 -eq $wantIndex) { $script:found2 = $child; return }
      Walk2 $child ($depth + 1)
      $next = $null
      try { $next = $walker.GetNextSibling($child) } catch { break }
      $child = $next
    }
  }
  Walk2 $top 0
  return $script:found2
}

$top = TopLevelFor ${hwnd} ${pid} '${psQuote(className)}' '${psQuote(title)}'
if ($null -eq $top) {
  ${TARGET_NOT_FOUND_EMIT}
  exit 0
}

$el = $null
$kind = 'none'

# a) 显式句柄形式 "hwnd:index"：直接用 FromHandle，最稳，不受树变动影响。
$targetHwnd = ${Number.isInteger(targetHwndOf(options)) ? targetHwndOf(options) : 0}
$targetIndex = ${Number.isInteger(targetIndexOf(options)) ? targetIndexOf(options) : 0}
$targetName = '${psQuote(name ?? '')}'

if ($targetHwnd -gt 0) {
  try {
    $h = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$targetHwnd)
    if ($null -ne $h) { $el = $h; $kind = 'hwnd' }
  } catch {}
}

# b) 纯数字：当作 getTree 的 node.id，按相同遍历顺序重放定位。
if ($null -eq $el -and $targetIndex -gt 0) {
  $el = Locate $top $targetIndex
  if ($null -ne $el) { $kind = 'index' }
}

# c) 按 name 查找（子串、大小写不敏感，与 findElements 语义一致）。
if ($null -eq $el -and $targetName -ne '') {
  $all = $top.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $want = $targetName.ToLower()
  foreach ($cand in $all) {
    $nm = Safe { $cand.Current.Name } ''
    if ($nm.ToLower().Contains($want)) { $el = $cand; $kind = 'name'; break }
  }
}

if ($null -eq $el) {
  Emit @{ ok = $false; reason = 'UIA_ELEMENT_NOT_FOUND: no element matched the given nodeId/name' }
  exit 0
}

$info = InfoOf $el 0 0
$info['resolveKind'] = $kind

$value = $null
$valueAvailable = $false
try {
  $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  if ($null -ne $vp) { $valueAvailable = $true; $value = [string]$vp.Current.Value }
} catch {}

$pats = New-Object System.Collections.ArrayList
foreach ($pair in @(
  @{ n = 'Invoke';  p = [System.Windows.Automation.InvokePattern]::Pattern },
  @{ n = 'Value';   p = [System.Windows.Automation.ValuePattern]::Pattern },
  @{ n = 'Toggle';  p = [System.Windows.Automation.TogglePattern]::Pattern },
  @{ n = 'SelectionItem'; p = [System.Windows.Automation.SelectionItemPattern]::Pattern },
  @{ n = 'ExpandCollapse'; p = [System.Windows.Automation.ExpandCollapsePattern]::Pattern },
  @{ n = 'ScrollItem'; p = [System.Windows.Automation.ScrollItemPattern]::Pattern },
  @{ n = 'Text'; p = [System.Windows.Automation.TextPattern]::Pattern }
)) {
  $ok = $false
  try { $ok = $el.TryGetCurrentPattern($pair.p, [ref]$null) } catch { $ok = $false }
  if ($ok) { [void]$pats.Add($pair.n) }
}

$value2 = $null
try { $value2 = Safe { $el.Current.HelpText } '' } catch {}

Emit @{
  ok = $true
  element = $info
  value = $value
  valueAvailable = $valueAvailable
  patterns = @($pats)
  helpText = [string]$value2
  isKeyboardFocusable = (Safe { [bool]$el.Current.IsKeyboardFocusable } $false)
  isContentElement = (Safe { [bool]$el.Current.IsContentElement } $false)
  isControlElement = (Safe { [bool]$el.Current.IsControlElement } $false)
  acceleratorKey = (Safe { [string]$el.Current.AcceleratorKey } '')
  frameworkId = (Safe { [string]$el.Current.FrameworkId } '')
  processId = (Safe { [int]$el.Current.ProcessId } 0)
}
`;
}

/** 生成 findElements 的脚本（条件在 PowerShell 侧用 PropertyCondition 下推）。 */
function findScript(options) {
  const { hwnd, pid, className, title, query, maxResults, viewMode } = options;
  return `${PS_PRELUDE}
$top = TopLevelFor ${hwnd} ${pid} '${psQuote(className)}' '${psQuote(title)}'
if ($null -eq $top) {
  ${TARGET_NOT_FOUND_EMIT}
  exit 0
}

$condName = '${psQuote(query.name ?? '')}'
$condClass = '${psQuote(query.className ?? '')}'
$condAid = '${psQuote(query.automationId ?? '')}'
$condType = '${psQuote(query.controlType ?? '')}'
$exactName = $${query.exactName === true ? 'true' : 'false'}

# 把"精确"条件下推给 UIA 引擎（PropertyCondition 在跨进程 provider 侧执行，
# 比把全部节点拉回来再过滤快得多）。
$conds = @()
if ($condClass -ne '') { $conds += (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, $condClass)) }
if ($condAid -ne '')   { $conds += (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $condAid)) }
if ($condName -ne '' -and $exactName) { $conds += (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $condName)) }
$cond = AndAll $conds

$walker = WalkerFor '${viewMode}'
$hits = New-Object System.Collections.ArrayList
$counter = 0
$maxResults = ${maxResults}
$maxScan = 4000

function NameMatch($nm) {
  if ($condName -eq '') { return $true }
  if ($exactName) { return ($nm -ceq $condName) }
  return ($nm.ToLower().Contains($condName.ToLower()))
}
function TypeMatch($ct) {
  if ($condType -eq '') { return $true }
  $t = $condType
  if ($t -like 'ControlType.*') { $t = $t.Substring(12) }
  return ($ct -eq $t)
}

# 先用引擎侧条件把候选集拉回来（候选项仍然逐个做名称/类型过滤，
# 因为 Name 的子串匹配 UIA 没有原生算子）。
$cands = $top.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
if ($null -ne $cands) {
  foreach ($c in $cands) {
    if ($hits.Count -ge $maxResults) { break }
    $nm = Safe { [string]$c.Current.Name } ''
    $ct = Safe { [string]$c.Current.ControlType.ProgrammaticName } ''
    if ($ct -like 'ControlType.*') { $ct = $ct.Substring(12) }
    if (-not (NameMatch $nm)) { continue }
    if (-not (TypeMatch $ct)) { continue }
    # depth 用"从顶层往下的层数"近似：FindAll 不返回层级，这里统一按 1 记，
    # 精确层级请用 getTree（它按遍历顺序给出真实 depth）。
    $hits.Add((InfoOf $c 1 ($hits.Count + 1)))
  }
}

Emit @{
  ok = $true
  nodes = @($hits)
  count = $hits.Count
  scanned = $cands.Count
  truncated = ($hits.Count -ge $maxResults)
  query = @{ name = $condName; className = $condClass; automationId = $condAid; controlType = $condType }
}
`;
}

/** 生成"窗口根元素信息"脚本（用于坐标换算与自洽性校验）。 */
function windowScript(options) {
  const { hwnd, pid, className, title } = options;
  return `${PS_PRELUDE}
$top = TopLevelFor ${hwnd} ${pid} '${psQuote(className)}' '${psQuote(title)}'
if ($null -eq $top) {
  ${TARGET_NOT_FOUND_EMIT}
  exit 0
}
Emit @{
  ok = $true
  window = (InfoOf $top 0 0)
  nativeWindowHandle = (Safe { [int64]$top.Current.NativeWindowHandle } 0)
  frameworkId = (Safe { [string]$top.Current.FrameworkId } '')
  processId = (Safe { [int]$top.Current.ProcessId } 0)
}
`;
}

/** PowerShell 单引号字符串转义（把 `'` 变成 `''`）。 */
function psQuote(value) {
  return String(value ?? '').replace(/'/g, "''");
}

/**
 * \`lib/native.js\` 的 \`IsWindow\` 绑定，用于在 Node 侧快速判掉过期句柄。
 *
 * \`undefined\` = 还没预热；\`null\` = 不可用（降级为不做本地校验）。
 *
 * 用动态 \`import()\` 而不是顶层 import：本模块刻意**不**在加载期强依赖
 * native 层，这样即便 koffi 不可用，"纯 UIA"（走 PowerShell 子进程）的路径
 * 依然完整可用。
 */
let isWindowFn;

async function primeIsWindow() {
  try {
    const native = await import('./native.js');
    const loaded = native.loadWin32();
    isWindowFn = (loaded.reason === undefined && typeof loaded.IsWindow === 'function')
      ? (hwnd) => loaded.IsWindow(hwnd)
      : null;
  } catch {
    isWindowFn = null;
  }
}
// 模块加载时预热（不 await，不阻塞导入）。没预热完就由 PowerShell 侧兜底。
void primeIsWindow();

/**
 * Node 侧校验 hwnd 是不是一个**活着的**窗口。
 *
 * 为什么需要：\`AutomationElement::FromHandle\` 对无效句柄是**抛异常**
 * （实测 \`1000000000\` → "Unrecognized error."，\`0\` → "hwnd cannot be
 * IntPtr.Zero or null."），而**不是**安静地返回 null。没有这层校验，
 * 一个过期句柄会先白付一次子进程启动（300ms~4s）。
 *
 * @returns \`undefined\` 表示"没发现问题，继续"；返回对象表示"以该结果失败"。
 */
function checkHwndAlive(hwnd) {
  if (!Number.isInteger(hwnd) || hwnd === 0) return undefined;
  if (typeof isWindowFn !== 'function') return undefined; // 未预热/不可用 → 交给子进程判定
  try {
    if (isWindowFn(hwnd) === true) return undefined;
  } catch {
    return undefined;
  }
  return {
    ok: false,
    reason: `hwnd ${hwnd} is not a valid window (the app may have closed, or the handle is stale). `
      + 'Re-discover the window with lib/windows.js findWindow() before retrying.',
  };
}

/**
 * 解析 `nodeId`，得出定位所需的三个类型明确的量。
 *
 * 三种形式：
 *   - `"123456:7"` → `{ hwnd: 123456, index: 0 }`（直接用 FromHandle）
 *   - `"7"`        → `{ hwnd: 0, index: 7 }`（按 getTree 的遍历顺序重放）
 *   - 空/其它      → `{ hwnd: 0, index: 0 }`
 *
 * 非数字内容一律当成无效 id 而不是拼进脚本 —— 这是防止脚本注入与语法错误的关键。
 */
function parseNodeId(nodeId) {
  const raw = String(nodeId ?? '').trim();
  const withHwnd = /^(\d+):(\d+)$/.exec(raw);
  if (withHwnd !== null) {
    return { hwnd: Number(withHwnd[1]), index: Number(withHwnd[2]) };
  }
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n > 0 ? { hwnd: 0, index: n } : { hwnd: 0, index: 0 };
  }
  return { hwnd: 0, index: 0 };
}

/** `elementScript` 模板里用到的 hwnd 分量。 */
function targetHwndOf(options) {
  return parseNodeId(options.nodeId).hwnd;
}

/** `elementScript` 模板里用到的序号分量。 */
function targetIndexOf(options) {
  return parseNodeId(options.nodeId).index;
}

// ---------------------------------------------------------------------------
// 子进程执行
// ---------------------------------------------------------------------------

const BEGIN = '__DSHVCU_BEGIN__';
const END = '__DSHVCU_END__';

/** 记录最近一次子进程诊断信息，供 describeUia() 使用。 */
const lastRun = { at: 0, ms: 0, timedOut: false, code: null, stderr: '' };

/**
 * 运行一段 PowerShell 脚本并解析定界 JSON。
 *
 * **这是本模块唯一允许调用子进程的地方**，超时/杀进程/编码解析都在这里统一处理。
 *
 * @returns `{ ok, value }` 或 `{ ok:false, reason, stderr }`。
 */
function runPowerShell(script, timeoutMs) {
  return new Promise((resolve) => {
    const exe = powershellPath();
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', encodeCommand(script),
    ];

    let child;
    try {
      child = spawn(exe, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ ok: false, reason: `failed to spawn powershell: ${error?.message ?? String(error)}` });
      return;
    }

    const started = Date.now();
    const chunks = [];
    const errChunks = [];
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // 必须杀整棵进程树：PowerShell 可能已经派生了 .NET 相关的子进程，
      // 只杀父进程会留下孤儿，宿主退出不了。
      killTree(child.pid);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => errChunks.push(chunk));
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: `powershell process error: ${error?.message ?? String(error)}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const stderr = Buffer.concat(errChunks).toString('utf8').trim();
      const stdout = Buffer.concat(chunks).toString('utf8');
      lastRun.at = Date.now();
      lastRun.ms = lastRun.at - started;
      lastRun.timedOut = timedOut;
      lastRun.code = code;
      lastRun.stderr = stderr.slice(0, 2000);

      if (timedOut) {
        resolve({
          ok: false,
          reason: `UIA_TIMEOUT: the UI Automation query did not finish within ${timeoutMs}ms and was killed. `
            + 'The target app may be unresponsive, or its control tree is too large; '
            + 'retry with a smaller maxDepth/maxNodes.',
          timeout: true,
          stdoutLength: stdout.length,
          stderr,
        });
        return;
      }

      const begin = stdout.indexOf(BEGIN);
      const end = stdout.indexOf(END, begin + BEGIN.length);
      if (begin < 0 || end < 0) {
        resolve({
          ok: false,
          reason: `UIA_PROTOCOL_ERROR: no result block in powershell output (exit ${code}). `
            + `stdout=${JSON.stringify(stdout.slice(0, 500))} stderr=${JSON.stringify(stderr.slice(0, 500))}`,
          stdout: stdout.slice(0, 2000),
          stderr,
        });
        return;
      }

      const payload = stdout.slice(begin + BEGIN.length, end);
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch (error) {
        resolve({
          ok: false,
          reason: `UIA_PROTOCOL_ERROR: result block is not valid JSON: ${error?.message ?? String(error)}`,
          stdout: payload.slice(0, 2000),
        });
        return;
      }
      resolve({ ok: true, value: parsed, stderr, ms: lastRun.ms, code });
    });
  });
}

/**
 * 同步杀掉进程树。
 *
 * 用 `taskkill /T /F` 而不是 `child.kill()`：`child.kill()` 只结束
 * powershell.exe 本身，它已经加载 CLR 并可能持有 UIA 的跨进程句柄，
 * 在目标无响应时 `TerminateProcess` 之后仍可能留下 wait 状态；`/T` 连子进程
 * 一起清掉，`/F` 保证不等它自己退。
 */
function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('error', () => {});
    // 兜底：taskkill 本身也可能失败（进程刚退出），再补一次
    // 不带 /T 的终止是没必要的——这里不额外做，避免误杀复用的 pid。
    killer.unref();
  } catch {
    // 忽略：超时路径已经返回失败，杀不掉进程不改变结论。
  }
}

// ---------------------------------------------------------------------------
// 公共 API
// ---------------------------------------------------------------------------

/** 默认值集中在一处，便于测试与文档对齐。 */
export const UIA_DEFAULTS = {
  maxDepth: 5,
  maxNodes: 200,
  includeOffscreen: false,
  viewMode: 'control',
  timeoutMs: 25000,
};

/** 解析并夹紧选项，任何非法值都退回默认值而不是抛异常。 */
function normalizeOptions(options = {}) {
  const clamp = (value, lo, hi, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, Math.trunc(n)));
  };
  const viewMode = ['control', 'content', 'raw'].includes(options.viewMode)
    ? options.viewMode
    : UIA_DEFAULTS.viewMode;
  return {
    maxDepth: clamp(options.maxDepth, 1, 20, UIA_DEFAULTS.maxDepth),
    maxNodes: clamp(options.maxNodes, 1, 5000, UIA_DEFAULTS.maxNodes),
    includeOffscreen: options.includeOffscreen === true,
    viewMode,
    timeoutMs: clamp(options.timeoutMs, 1000, 180000, UIA_DEFAULTS.timeoutMs),
  };
}

/**
 * 解析目标选择器。
 *
 * 支持两种形式：
 *   - `{ hwnd }`：推荐。直接 `AutomationElement.FromHandle`，无歧义，最快。
 *   - `{ pid, className?, title? }`：hwnd 拿不到时（例如只知道进程）的发现路径。
 */
function normalizeTarget(hwndOrTarget) {
  if (hwndOrTarget !== null && typeof hwndOrTarget === 'object') {
    const raw = hwndOrTarget.hwnd ?? hwndOrTarget.pid;
    void raw;
    return {
      hwnd: Number.isFinite(Number(hwndOrTarget.hwnd)) ? Math.trunc(Number(hwndOrTarget.hwnd)) : 0,
      pid: Number.isFinite(Number(hwndOrTarget.pid)) ? Math.trunc(Number(hwndOrTarget.pid)) : 0,
      className: typeof hwndOrTarget.className === 'string' ? hwndOrTarget.className : '',
      title: typeof hwndOrTarget.title === 'string' ? hwndOrTarget.title : '',
    };
  }
  const n = Number(hwndOrTarget);
  return {
    hwnd: Number.isFinite(n) ? Math.trunc(n) : 0,
    pid: 0,
    className: '',
    title: '',
  };
}

/**
 * 读取指定窗口的 UI Automation 控件树。
 *
 * @param hwndOrTarget - 窗口句柄，或 `{ hwnd }` / `{ pid, className?, title? }`。
 * @param options.maxDepth - 向下遍历的最大层数（默认 5）。
 * @param options.maxNodes - 返回节点数上限（默认 200）。命中上限时 `nodeLimited=true`。
 * @param options.includeOffscreen - 是否包含不可见（offscreen）元素，默认 false。
 * @param options.viewMode - `'control'`（默认）/ `'content'` / `'raw'`。
 * @param options.timeoutMs - 子进程超时，默认 25000ms，超时即杀。
 *
 * @returns `{ ok:true, nodes, count, root, depthLimited, nodeLimited, elapsedMs }`
 *          或 `{ ok:false, reason }`。
 *
 * **注意 `ok:true` 且 `nodes` 为空不是错误**：有些程序（游戏、自绘界面、
 * 部分 UWP/Chromium 窗口）本来就没有可访问的控件树。只有子进程失败、
 * 超时、目标窗口不存在才返回 `ok:false`。
 */
export async function getTree(hwndOrTarget, options = {}) {
  const opts = normalizeOptions(options);
  const target = normalizeTarget(hwndOrTarget);
  if (target.hwnd === 0 && target.pid === 0) {
    return { ok: false, reason: 'no target given: supply hwnd, or pid (with optional className/title)' };
  }
  if (process.platform !== 'win32') {
    return { ok: false, reason: `platform ${process.platform} is not supported (UI Automation is Windows only)` };
  }

  // Node 侧的快速存活校验：过期/伪造句柄直接失败，省掉一次 300~4000ms 的子进程。
  // 这里只是**提前失败优化**，PowerShell 侧还有一层同样的校验（那层是权威判定，
  // 因为它还负责区分 FromHandle 抛异常等竞争情况）。
  const stale = checkHwndAlive(target.hwnd);
  if (stale !== undefined) return stale;

  const script = treeScript({
    ...target,
    ...opts,
    includeOffscreen: opts.includeOffscreen,
  });
  const run = await runPowerShell(script, opts.timeoutMs);
  if (run.ok !== true) return { ok: false, reason: run.reason, stderr: run.stderr, timeout: run.timeout === true };

  const value = run.value;
  if (value.ok !== true) return { ok: false, reason: value.reason ?? 'UIA query failed' };

  return {
    ok: true,
    nodes: Array.isArray(value.nodes) ? value.nodes : [],
    count: value.count ?? 0,
    root: value.root ?? null,
    depthLimited: value.depthLimited === true,
    nodeLimited: value.nodeLimited === true,
    viewMode: opts.viewMode,
    maxDepth: opts.maxDepth,
    maxNodes: opts.maxNodes,
    // 空树是**正常的**，显式告诉调用方这不是失败，避免模型把它当错误重试。
    note: (value.count ?? 0) === 0
      ? 'the target exposes no UIA child elements (empty tree is not an error for games / custom-drawn / some UWP surfaces)'
      : undefined,
    elapsedMs: run.ms,
  };
}

/**
 * 按条件查找元素。
 *
 * @param query.name - 名称**子串**匹配（大小写不敏感）。给 `exactName: true` 变精确匹配。
 * @param query.controlType - `'Button'` / `'MenuItem'` / `'Edit'` …（接受带 `ControlType.` 前缀）。
 * @param query.automationId - 精确匹配。
 * @param query.className - 精确匹配。
 * @param options.maxResults - 默认 20。
 */
export async function findElements(hwndOrTarget, query = {}, options = {}) {
  const opts = normalizeOptions(options);
  const target = normalizeTarget(hwndOrTarget);
  if (target.hwnd === 0 && target.pid === 0) {
    return { ok: false, reason: 'no target given: supply hwnd, or pid (with optional className/title)' };
  }
  const hasQuery = ['name', 'className', 'automationId', 'controlType']
    .some((key) => typeof query[key] === 'string' && query[key] !== '');
  if (!hasQuery) {
    return { ok: false, reason: 'no query given: supply at least one of name, controlType, automationId, className' };
  }
  if (process.platform !== 'win32') {
    return { ok: false, reason: `platform ${process.platform} is not supported` };
  }

  const maxResults = Number.isFinite(Number(options.maxResults))
    ? Math.min(500, Math.max(1, Math.trunc(Number(options.maxResults))))
    : 20;

  const script = findScript({
    ...target,
    query: {
      name: query.name ?? '',
      className: query.className ?? '',
      automationId: query.automationId ?? '',
      controlType: query.controlType ?? '',
      exactName: query.exactName === true,
    },
    maxResults,
    viewMode: opts.viewMode,
  });
  const run = await runPowerShell(script, opts.timeoutMs);
  if (run.ok !== true) return { ok: false, reason: run.reason, stderr: run.stderr, timeout: run.timeout === true };

  const value = run.value;
  if (value.ok !== true) return { ok: false, reason: value.reason ?? 'UIA query failed' };

  return {
    ok: true,
    nodes: Array.isArray(value.nodes) ? value.nodes : [],
    count: value.count ?? 0,
    scanned: value.scanned ?? 0,
    truncated: value.truncated === true,
    query: value.query,
    elapsedMs: run.ms,
    note: (value.count ?? 0) === 0
      ? 'no element matched the query (this is a valid "not found" result, not an error)'
      : undefined,
  };
}

/**
 * 读单个元素的完整信息。
 *
 * @param nodeIdOrSelector - 三种形式：
 *   - `"12345"`（纯数字）→ 当作 `getTree` 返回的 `node.id`（按相同遍历顺序重放定位）。
 *     注意：**id 只在下一次树变动之前有效**，UI 变化后必须重新 `getTree`。
 *   - `"12345:7"` → `hwnd:序号`，直接用 `FromHandle` 定位，最稳。
 *   - `{ hwnd, name }` / `{ hwnd, nodeId }` → 显式指定窗口与目标。
 *
 * 返回值额外包含：`value`（ValuePattern 当前值）、`patterns`（可用 Pattern 列表）、
 * `isKeyboardFocusable` / `isContentElement` / `isControlElement` / `acceleratorKey` /
 * `frameworkId`。`patterns` 里的 `Invoke` 说明该控件**可以被结构化点击**——
 * 但本插件仍应通过 `vcu_click` 注入窗口消息（见模块头注释的职责边界）。
 */
export async function elementInfo(nodeIdOrSelector, options = {}) {
  const opts = normalizeOptions(options);

  let target = { hwnd: 0, pid: 0, className: '', title: '' };
  let nodeId = '';
  let name = '';

  if (nodeIdOrSelector !== null && typeof nodeIdOrSelector === 'object') {
    target = normalizeTarget(nodeIdOrSelector);
    nodeId = nodeIdOrSelector.nodeId !== undefined ? String(nodeIdOrSelector.nodeId) : '';
    name = typeof nodeIdOrSelector.name === 'string' ? nodeIdOrSelector.name : '';
  } else {
    nodeId = String(nodeIdOrSelector ?? '');
    // 裸 `"hwnd:index"` 自带窗口信息，直接从中取 hwnd —— 省得调用方再拼一次。
    const parsed = parseNodeId(nodeId);
    if (parsed.hwnd > 0) {
      target = { hwnd: parsed.hwnd, pid: 0, className: '', title: '' };
    } else {
      // 纯序号没有窗口信息，无法定位 —— 明确报错而不是猜一个窗口。
      return {
        ok: false,
        reason: 'elementInfo needs the owning window: pass { hwnd, nodeId } or use the "hwnd:index" id form',
      };
    }
  }

  if (target.hwnd === 0 && target.pid === 0) {
    return { ok: false, reason: 'no target given: elementInfo needs { hwnd, nodeId } or an "hwnd:index" id' };
  }
  if (process.platform !== 'win32') return { ok: false, reason: `platform ${process.platform} is not supported` };

  const script = elementScript({ ...target, nodeId, name: name === '' ? (opts.name ?? '') : name });
  const run = await runPowerShell(script, opts.timeoutMs);
  if (run.ok !== true) return { ok: false, reason: run.reason, stderr: run.stderr, timeout: run.timeout === true };

  const value = run.value;
  if (value.ok !== true) return { ok: false, reason: value.reason ?? 'UIA query failed' };

  return {
    ok: true,
    element: value.element,
    // 回填可直接复用的稳定 id：`hwnd:序号` 形式（见 resolveKind）。
    id: value.element?.resolveKind === 'hwnd' ? String(nodeId) : undefined,
    value: value.value ?? null,
    valueAvailable: value.valueAvailable === true,
    patterns: Array.isArray(value.patterns) ? value.patterns : [],
    helpText: value.helpText ?? '',
    acceleratorKey: value.acceleratorKey ?? '',
    frameworkId: value.frameworkId ?? '',
    processId: value.processId ?? 0,
    isKeyboardFocusable: value.isKeyboardFocusable === true,
    isContentElement: value.isContentElement === true,
    isControlElement: value.isControlElement === true,
    elapsedMs: run.ms,
  };
}

/**
 * 读窗口根元素的 UIA 信息（含 `nativeWindowHandle`、`frameworkId`）。
 *
 * 用途：`vcu_uia_tree` 之外的自洽性校验，以及判断程序框架（Win32 / WPF /
 * WinForms / UIA3 等），从而预判控件树质量。
 */
export async function windowInfo(hwndOrTarget, options = {}) {
  const opts = normalizeOptions(options);
  const target = normalizeTarget(hwndOrTarget);
  if (target.hwnd === 0 && target.pid === 0) return { ok: false, reason: 'no target given' };
  if (process.platform !== 'win32') return { ok: false, reason: `platform ${process.platform} is not supported` };

  const run = await runPowerShell(windowScript(target), opts.timeoutMs);
  if (run.ok !== true) return { ok: false, reason: run.reason, timeout: run.timeout === true };
  const value = run.value;
  if (value.ok !== true) return { ok: false, reason: value.reason ?? 'UIA query failed' };

  return {
    ok: true,
    window: value.window,
    nativeWindowHandle: value.nativeWindowHandle ?? 0,
    frameworkId: value.frameworkId ?? '',
    processId: value.processId ?? 0,
    elapsedMs: run.ms,
  };
}

// ---------------------------------------------------------------------------
// 坐标换算
// ---------------------------------------------------------------------------

/**
 * 把屏幕物理像素坐标换算成目标窗口的**客户区坐标**。
 *
 * 为什么不在这里做 DPI 缩放：UIA 的 `BoundingRectangle` 与 `GetWindowRect`
 * 都在**物理像素**坐标系里（本机 DPI 感知一致）。插件其余模块（截图、
 * `lib/virtual-input.js` 的坐标注入）也都按物理像素工作，所以全链路无需换算；
 * 一旦这里插入 DPI 缩放，反而会在 125%/150% 缩放下把点击位置算偏。
 *
 * @param point - `{ x, y }`，屏幕物理像素（通常是控件 bbox 的中心）。
 * @param clientOrigin - 客户区左上角的屏幕坐标，来自 `describeClientArea(hwnd)`。
 * @returns `{ ok, x, y }`（客户区坐标）或 `{ ok:false, reason }`。
 */
export function toClientCoords(point, clientOrigin) {
  const px = Number(point?.x);
  const py = Number(point?.y);
  const ox = Number(clientOrigin?.x);
  const oy = Number(clientOrigin?.y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) {
    return { ok: false, reason: `invalid point: ${JSON.stringify(point)}` };
  }
  if (!Number.isFinite(ox) || !Number.isFinite(oy)) {
    return {
      ok: false,
      reason: 'invalid clientOrigin: call describeClientArea(hwnd) from lib/windows.js and pass its clientOrigin',
    };
  }
  return { ok: true, x: Math.round(px - ox), y: Math.round(py - oy), screen: { x: Math.round(px), y: Math.round(py) } };
}

/**
 * 从 UIA 节点算出"可点击点"。
 *
 * 返回**同时**包含屏幕坐标与客户区坐标，因为两个下游消费者需要不同的形式：
 *   - `vcu_click` 需要客户区坐标（它自己再做坐标注入）
 *   - 截图/OCR 相关工具需要屏幕坐标
 *
 * @param node - `getTree` / `findElements` 返回的节点（需有 `bbox`）。
 * @param clientOrigin - `{ x, y }`，可选。给了才会算 `client` 字段。
 */
export function nodeClickPoint(node, clientOrigin) {
  const bbox = node?.bbox;
  if (bbox === null || typeof bbox !== 'object') {
    return { ok: false, reason: 'node has no bbox (element may be offscreen or the provider gave no rectangle)' };
  }
  const w = Number(bbox.width);
  const h = Number(bbox.height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { ok: false, reason: `node bbox has no area: ${JSON.stringify(bbox)}` };
  }
  const cx = Math.round(Number(bbox.x) + w / 2);
  const cy = Math.round(Number(bbox.y) + h / 2);
  const result = { ok: true, screen: { x: cx, y: cy }, bbox: { x: bbox.x, y: bbox.y, width: w, height: h } };
  if (clientOrigin !== undefined) {
    const converted = toClientCoords({ x: cx, y: cy }, clientOrigin);
    if (converted.ok === true) {
      result.client = { x: converted.x, y: converted.y };
    } else {
      result.client = null;
      result.clientReason = converted.reason;
    }
  }
  return result;
}

/**
 * 把 UIA 节点的 bbox 与窗口矩形做自洽性校验。
 *
 * 用途：UIA 的坐标偶尔会给出明显越界的值（provider 实现有 bug、窗口被裁剪、
 * 元素在虚拟桌面上）。这个函数让上层可以过滤掉这些脏数据，而不是把
 * 一个越界的点喂给点击。
 *
 * @returns `{ ok, inside, intersectionRatio, reason? }`
 */
export function bboxInsideWindow(node, windowRect_) {
  const bbox = node?.bbox;
  if (bbox === null || typeof bbox !== 'object') return { ok: false, reason: 'node has no bbox' };
  const wr = windowRect_;
  if (wr === null || typeof wr !== 'object') return { ok: false, reason: 'no window rect given' };

  const wl = Number(wr.left ?? wr.x ?? 0);
  const wt = Number(wr.top ?? wr.y ?? 0);
  const ww = Number(wr.width ?? 0);
  const wh = Number(wr.height ?? 0);
  if (!Number.isFinite(wl) || !Number.isFinite(wt) || ww <= 0 || wh <= 0) {
    return { ok: false, reason: `invalid window rect: ${JSON.stringify(wr)}` };
  }

  const bl = Number(bbox.x);
  const bt = Number(bbox.y);
  const bw = Number(bbox.width);
  const bh = Number(bbox.height);
  const overlapW = Math.max(0, Math.min(bl + bw, wl + ww) - Math.max(bl, wl));
  const overlapH = Math.max(0, Math.min(bt + bh, wt + wh) - Math.max(bt, wt));
  const area = bw * bh;
  const ratio = area > 0 ? (overlapW * overlapH) / area : 0;

  // 容差 2px：UIA 的 bbox 与 GetWindowRect 之间存在 1~2px 的边框取整差异，
  // 这不是错误，"完全在内" 不该因为这个被判失败。
  const inside = bl >= wl - 2 && bt >= wt - 2 && bl + bw <= wl + ww + 2 && bt + bh <= wt + wh + 2;
  return { ok: true, inside, intersectionRatio: Number(ratio.toFixed(4)) };
}

// ---------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------

/** UIA 可用性自检：PowerShell 是否存在、UIA 程序集能否加载、RootElement 能否访问。 */
export async function describeUia(options = {}) {
  const timeoutMs = normalizeOptions(options).timeoutMs;
  const exe = powershellPath();
  const present = existsSync(exe);
  const base = {
    powershell: exe,
    powershellExists: present,
    platform: process.platform,
  };
  if (!present && exe === 'powershell.exe') {
    // PATH 兜底：无法确认存在，直接跑一次看结果。
  }
  if (process.platform !== 'win32') {
    return { ...base, supported: false, reason: `platform ${process.platform} is not supported` };
  }

  const script = `${PS_PRELUDE}
$root = [System.Windows.Automation.AutomationElement]::RootElement
$desktop = Safe { [string]$root.Current.ClassName } ''
Emit @{
  ok = $true
  desktopClass = $desktop
  clrVersion = [System.Environment]::Version.ToString()
  psVersion = $PSVersionTable.PSVersion.ToString()
  is64Bit = [System.Environment]::Is64BitProcess
  capabilities = @(Get-WindowsCapability -Online -Name 'Language.OCR*' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
}
`;
  const run = await runPowerShell(script, Math.min(timeoutMs, 30000));
  if (run.ok !== true) {
    return { ...base, supported: false, reason: run.reason, stderr: run.stderr };
  }
  return {
    ...base,
    supported: true,
    desktopClass: run.value.desktopClass ?? '',
    clrVersion: run.value.clrVersion,
    psVersion: run.value.psVersion,
    is64Bit: run.value.is64Bit,
    elapsedMs: run.ms,
  };
}

/** 最近一次子进程调用的诊断信息（耗时、退出码、是否超时、stderr 片段）。 */
export function lastRunInfo() {
  return { ...lastRun };
}
