# Vrykell 开发规则

> 最后更新: 2026-11-14
>
> 规则 43 补充：工具卡保留状态和已存结果，不显示底部错误，也不自动发布失败通知。主动查看结果时在卡片内展开原因和输出，不使用右下角通知。常见的仓库探测及操作失败使用右下角定时收起的信息通知，保留详情和恢复入口。持久错误通知用于阻止继续使用的异常。恢复历史和审批结果不自动发布通知。AI 回复错误保留公共 ErrorBox 内联模式。
>
> 本文件（`docs/zh/development-rules.md`）是规则正本，英文镜像为 `docs/en/development-rules.md`。
> `AGENTS.md` 是常驻摘要，`.agents/skills/vrykell-conventions/SKILL.md` 是面向 agent 的规范入口
> （`.claude/skills/` 下是给 Claude Code 的桥接）。规则变化时同步这几处。

## 一、代码规范

1. **注释与命名** — 新增或修改的代码注释统一使用英文（包括 JSDoc、行内注释、CSS 和 Rust 注释）；注释与变量名使用通用术语描述功能，避免第三方产品或品牌名。文档与提交信息同样适用，模型与 agent harness 名称除外。
2. **独立实现** — 用自己的方式实现功能，不照抄任何第三方源码。
3. **用户可见文案走 i18n** — 不在代码中硬编码用户可见中文：代码里写英文，并在 `src/i18n` 补上对应中文条目。
4. **TypeScript 严格** — 零 TS 错误，不使用 `any` 除非必要且标注 `// eslint-disable-next-line`。

## 二、测试要求

5. **每个功能必须有单测** — 新增功能需在 `__tests__/` 目录下编写 vitest 用例。
6. **交互功能必须有 e2e** — 涉及用户交互的功能需在 `e2e/` 目录下编写 Playwright 用例。
7. **实现后跑全量** — 每次提交前必须 `npx tsc --noEmit && npx vitest run && npx playwright test` 全绿。

## 三、实现流程

8. **先写测试** — 先写失败的单测/ e2e，再写实现代码，确认测试通过。
9. **小步提交** — 每完成一个功能独立提交，commit message 使用英文，格式: `feat:` / `fix:` / `test:` / `refactor:` / `docs:`。
10. **更新 feature-spec** — 新增功能必须同步更新 `docs/zh/feature-spec.md` 的测试清单。
11. **代码评审** — 每完成一个大功能，自查代码质量：死代码、未使用导入、类型安全、命名一致性。

## 四、技术约束

12. **禁止自研终端模拟器** — 终端 VT/ANSI 解析使用 xterm.js，不自行实现 parser。
13. **禁止正则后瞻** — macOS 12 WKWebView 不支持 `(?<=...)` 和 `(?<!...)`。
14. **xterm.js 不可见** — xterm.js 仅用于 PTY 会话管理和 VT 解析，不直接出现在用户可见的 UI 中。
15. **Block 架构** — 已完成命令块由 TerminalBlockList 渲染为真实 DOM 元素，仅活跃命令使用隐藏 xterm.js 处理。

## 五、输出质量标准

16. **无乱码** — 块输出必须经过 ANSI 清理（stripNonSGR + truncateAfterPromptStart），不含 OSC/CSI 裸露文字。
17. **自动滚动** — 新输出到达时自动滚到底部（用户不在底部时不强制滚动）。
18. **无空白块** — 无输出的命令块显示 "(无输出)"，不渲染空块。
19. **动画 > 0.1s** — 折叠/展开、hover 过渡时间 ≥ 100ms，不得快于 100ms。

## 六、架构原则

20. **终端为主表面** — 终端 Block 列表是主区域，输入栏在底部，无独立 Chat 侧栏。
21. **AI 内联** — AI 对话结果显示在终端上方 InlineAI 区域，通过输入栏 ⚡ 模式触发。
22. **Session 保活** — 多标签 PTY 会话通过隐藏 xterm.js (display:none) 保活，切换标签不重建。
23. **颜色系统** — 所有颜色通过 `theme.css` CSS 变量定义，不在组件中硬编码色值（除 ANSI 颜色相关）。
24. **一套实现 + 状态选择** — 同一份界面在不同运行目标（本地 / SSH）下不写两套逻辑：文件操作统一走 `FileOps` 接口（`fileOpsFor(target)` 是唯一的实现选择点），菜单、拖放语义等状态差异写成 `filePanelConfig` 配置项；视图层不得按目标写 `if (isSsh)`，也不得绕过接口直接 `invoke` 文件命令或自行处理路径。
25. **终端区域对齐** — 终端 pane 根层左/右内边距为 0（整宽元素如认证输入条、输入栏与 pane 边界对齐，左右留白相等）；8px 左边距只加在终端屏幕内容上，右侧一律不留，保证原生滚动条贴住 pane 右边缘。终端内容因此是「左留白、右贴边」而不是居中，这是有意取舍；详见 `docs/zh/architecture.md`「终端区域的真实对齐」。
26. **路径判断归平台层** — 绝对/相对判断、拼接、取父目录与文件名一律交给平台层：本地路径前端用 `@platform/path`、Rust 用 `std::path`；远端（POSIX）路径前端用 `@platform/posixPath`、Rust 用 `src-tauri/src/platform/path.rs`。业务模块不得自行判断路径形态（Windows 宿主上 `Path::is_absolute("/home")` 为 false、`join` 会插反斜杠）。

## 七、文件组织

27. `src/features/terminal/` — 终端领域（components、hooks、stores、model、services/pipeline）。
28. `src/features/*/stores/` — 领域 Zustand 状态；视图层通过 Feature 公共入口访问。
29. `src/ui/` — 无业务语义的通用 UI 组件。
30. `src/features/chat/` — AI 对话渲染（AiBlock、ModelPill、ToolRunCard、Markdown、PanelChat）。
31. `src/features/agent/` — AI 代理逻辑（agentStream、工具、权限、Skills、MCP、上下文、记忆、调度、智能标题）。
32. `src/features/settings/` — 设置页（行为/模型/MCP/Skills/快捷键/终端打开模式/外观：主题、块外观、字体与显示、主题文件）。
33. `src/platform/` 与 `src/utils/` — Tauri IPC、PTY、运行时适配与纯工具函数。业务服务归属对应 Feature。
34. `src/features/ssh/` `src/features/files/` `src/features/search/` `src/config/theme/` — SSH / 本地文件 / 全局搜索 / 设计 token。
35. `e2e/` — Playwright E2E 测试，`tauri-mock.ts` 提供 Tauri + Anthropic mock。测试用 dev server 的端口由 `PW_PORT` 决定（缺省 1421）：多个 worktree 并行跑测试时各自指定不同端口，避免一个 run 关掉另一个 run 的 dev server（表现为整片 `ERR_CONNECTION_REFUSED`）。

## 八、可观测性与日志

36. **修改功能时同步补充日志** — 对有状态流程，在入口、状态转换、外部调用结果和错误/超时分支记录结构化事件，确保问题可以按时间线排查。
37. **优先记录元数据** — 记录会话/块 ID、状态、耗时、字节数和错误类型；不要记录原始命令、终端输出、提示词、凭据或未经脱敏的用户路径。
38. **复用诊断接口** — 前端使用 `terminalDebug`，Rust 终端层使用 `terminal::debug::write`；新增事件名应稳定且能说明操作阶段，避免逐字符或高频输出日志。
39. **按现有配置记录日志** — 当前共享测试机已开启详细诊断日志自动保存，排查时先检查已有记录，不要每轮测试重新开启；其他环境按自身设置决定，应用新环境默认关闭自动保存。涉及后台任务或新 IPC 流程时，应确认入口和失败分支都能留下可关联的日志。
40. **先检查已有日志** — 先检查 `%LOCALAPPDATA%\com.vrykell.app\logs\diagnostics-<YYYYMMDDTHH>.jsonl`；文件名带有 UTC 小时，日志按小时轮转，较早分段留在同目录中（最多保留 24 个、256 MB）。配置保存在 `%APPDATA%\com.vrykell.app\diagnostics.json`，其开启状态属于测试机配置，不要据此推断新用户的默认值。
41. **日志不阻塞输入输出** — 高频记录经前端批量传送与后端缓冲线程写入，保留详细事件；导出和修改自动保存配置前冲刷待写记录。终端数据通路的读数（读取、输出冲刷、收包、控制器入口、路由去向）按秒窗口聚合成 `pty-io` / `terminal-io` 单条记录，静默按 1 s、2 s、4 s… 记 `read-idle`；新增诊断逻辑不得恢复逐按键或逐块写盘。逐按键的输入与光标重绘事件默认不记录，仅在设置页开启“跟踪终端输入”后写入；关闭时只保留 `terminal-io` 里的输入计数与最大写入/重绘耗时。

## 九、窗口与标题栏

42. **拖动把手只落在非交互元素上** — 运行时只在光标下的元素带 `data-tauri-drag-region` 且路径上没有「不带该属性的可点击元素」时才开始拖动。因此标题文字、留白等需要补上该属性，而按钮、输入框、链接等可点击元素不要添加，否则点击会变成拖窗口；新增标题栏元素时同步检查 `e2e/titlebar-drag.spec.ts` 覆盖的把手位置。

## 十、公共组件与文档

43. **公共组件优先** — 侧栏列表项统一走 `src/ui/layout/sidebarItem.tsx`（会话标签行与 SSH 连接行共用同一外观与交互）；列表拖拽排序统一走 `src/ui/layout/listReorder.tsx` 的「占位空位」交互（拖起的行让出槽位、落点用无边框底色占位、跟随指针的图标预览、Esc 取消、抑制拖拽后的点击），新列表通过 `data-reorder-list` / `data-reorder-item` / `data-reorder-kind` 接入，不得另造一套观感；错误展示统一走 `src/ui/feedback/ErrorBox.tsx` 与 `ErrorDetails.tsx`（数据加载失败通过 ErrorBox 显示右下角持久通知，保留重试、技术详情、关闭及弹窗键盘访问；临时动作结果使用同一通知区域中的 Toast；全局错误页仍为整页）；设置项选择器统一用 `src/ui/fields/Select.tsx` 下拉框；悬停提示统一走 `data-tip` + `src/ui/feedback/TooltipLayer.tsx`（组件里不写 `title`：系统原生提示无法改样式；纯图标控件同时保留 `aria-label` 作为无障碍名称）；多选列表统一走 `src/ui/menus/CheckboxMenu.tsx`（逐项切换后保持展开，失焦或 Esc 才关闭）。新增同类界面时先抽公共组件再接入。
44. **测试钩子稳定** — 重构移动标记时保留既有测试钩子（`data-testid`、`data-tab-row-id`、`data-tab-group`、ARIA 名称等），或在同一提交内更新全部引用它的单测 / e2e。
45. **文档分层** — 规则正本 = `docs/zh/development-rules.md`（英文镜像 `docs/en/development-rules.md`，两者保持同步）；常驻摘要 = `AGENTS.md`（Codex 等 agent 先读它）；agent 规范入口 = `.agents/skills/vrykell-conventions/SKILL.md`（Command Code 与 Codex 直接读取，`.claude/skills/vrykell-conventions/SKILL.md` 是 Claude Code 的桥接）。规则变化时同步这几处，不再新增副本。
46. **双语文档** — `docs/` 下的文档保持中英双语：中文放 `docs/zh/`、英文放 `docs/en/`，两侧文件名一一对应。新增文档必须同时提供两种语言；修改任一语言版本时同步更新另一种。原始证据截图不翻译，按所属文档存放。
47. **安装包按需构建** — 只有用户明确要求构建安装包时，才运行 `npm run tauri build` 或其他安装包构建命令。修复、审查、测试或验证应用行为本身不代表授权构建安装包；这类任务使用测试、类型检查、架构检查或开发模式验证。
48. **优先沿用现有设计** — 修改界面前先查看最接近的现有页面和交互，沿用其组件、间距、输入框、菜单、悬停与焦点样式。确有缺口时扩展或抽取现有实现，不为已有交互另造视觉样式；在实际运行界面的窄、宽尺寸检查结果。

## 十一、安全底线

49. **新 IPC 命令必须受门控** —— 新增的 Tauri 命令要么走租约/策略校验（并登记进受门控命令清单），要么只做无特权的事；禁止新增"任意路径读 / 写 / 执行"的裸命令。门控清单与校验点在 `src-tauri/src/agent/permissions.rs`，改动要同步 `docs/zh/security-model.md` 的防线表。
50. **渲染层的 HTML 必须单点消毒** —— 只有经过 `sanitizeOutputHtml`（或等价的单点构造）的 HTML 才能进 `dangerouslySetInnerHTML`。不可信内容（模型输出、抓取网页、技能文本、MCP 结果、终端输出、远端文件名）优先走文本 / Markdown 路径；回复里的链接一律走 `Markdown.tsx` 的 `Link`（web 链接交系统浏览器），不得让应用窗口导航。
51. **第三方接入按安全模型自查** —— 新增 MCP 服务器、技能来源、外部 harness（ACP）等第三方代码或内容前，先按 `docs/zh/security-model.md` 第 4 节清单逐条作答，并把结论写进提交说明。第三方进程一律是"用户显式添加的可执行程序"，设置页文案必须写明添加即授权。
52. **收紧优先于放宽** —— 放宽 CSP、扩大 `assetProtocol` scope、增加 capability 权限，都要在提交说明里给出理由。生产 CSP 与开发例外分开（`csp` / `devCsp`），不把开发例外带进生产构建。

## 十二、工具用法

53. **源码一律用编辑工具修改** —— 禁止用 shell 重定向 / `Set-Content` / 整文件正则脚本重写源码文本：PowerShell 默认编码会把非 ASCII 写成乱码，2026-10-14 与 10-15 已两次因此弄坏文件。批量调整用编辑工具逐处修改；shell 只用于读取、检索与 git 操作。

## 十三、菜单与色板

54. **菜单层级与色板** — 所有操作菜单的色板直接放在共享菜单底部，不收进二级菜单。只有多个相关选项才使用含义明确的子菜单；单个设置入口和开关直接显示，不添加通用“设置”父菜单或只有一个选项的子菜单。

55. **图标必须使用组件** — 界面图标统一使用公共图标组件，不得以字符图案或原生展开标记代替。快捷键名称和数学运算符仍属于文字内容。连接认证采用公共四项横向选栏，设置项仍采用公共下拉框；标签胶囊与文字输入复用公共控件，不另写局部输入框样式。
