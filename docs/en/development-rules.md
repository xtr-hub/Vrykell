# Vrykell Development Rules

> Last updated: 2026-11-14
>
> Rule 43 clarification: tool cards retain their status and stored result without footer errors or automatic failure notifications. Explicit result review expands the reason and output inside the card, never in the notification region. Routine repository discovery and operation failures use timed bottom-right informational notifications with details and recovery. Persistent error notifications are reserved for failures that prevent continued use. Restoring history and approval outcomes never publish notifications. AI reply failures retain the shared inline ErrorBox.
>
> This file (`docs/en/development-rules.md`) is the English mirror of the rule book; the canonical
> Chinese version is `docs/zh/development-rules.md`. `AGENTS.md` is the always-on summary, and
> `.agents/skills/vrykell-conventions/SKILL.md` is the agent-facing conventions entry point
> (`.claude/skills/` holds the bridge for Claude Code). Keep these in sync when rules change.

## 1. Code style

1. **Comments and naming** — New or edited code comments are English (JSDoc, inline, CSS and Rust comments alike); comments and identifiers describe behavior in generic terms and avoid third-party product or brand names. Docs and commit messages follow the same rule; model and agent-harness names are excepted.
2. **Independent implementation** — Implement features your own way; never copy third-party source.
3. **User-visible copy goes through i18n** — Never hardcode user-visible Chinese in code: write the string in English and add its Chinese entry to `src/i18n`.
4. **TypeScript strict** — Zero TS errors; do not use `any` unless necessary and annotated with `// eslint-disable-next-line`.

## 2. Testing

5. **Every feature needs a unit test** — New features require vitest cases under `__tests__/`.
6. **Interactive features need e2e** — User-interaction features require Playwright cases under `e2e/`.
7. **Run the full suite after implementing** — Before every commit, `npx tsc --noEmit && npx vitest run && npx playwright test` must be green.

## 3. Implementation flow

8. **Write tests first** — Write the failing unit/e2e test first, then the implementation, and confirm the test passes.
9. **Small commits** — Commit each finished feature on its own; commit messages are in English, prefixed `feat:` / `fix:` / `test:` / `refactor:` / `docs:`.
10. **Update feature-spec** — New features must update the checklist in `docs/en/feature-spec.md`.
11. **Code review** — After every large feature, self-review code quality: dead code, unused imports, type safety, naming consistency.

## 4. Technical constraints

12. **No home-grown terminal emulator** — VT/ANSI parsing uses xterm.js; never implement your own parser.
13. **No regex lookbehind** — macOS 12 WKWebView does not support `(?<=...)` or `(?<!...)`.
14. **xterm.js is invisible** — xterm.js is only for PTY session management and VT parsing; it never appears in user-visible UI.
15. **Block architecture** — Completed command blocks are rendered as real DOM elements by TerminalBlockList; only the active command uses a hidden xterm.js.

## 5. Output quality standards

16. **No garbled output** — Block output must pass ANSI cleanup (stripNonSGR + truncateAfterPromptStart) and contain no raw OSC/CSI text.
17. **Auto-scroll** — New output scrolls to the bottom automatically (do not force scroll when the user is not at the bottom).
18. **No empty blocks** — A command block with no output shows "(no output)" and does not render as an empty block.
19. **Animations > 0.1s** — Collapse/expand and hover transitions are ≥ 100ms and never faster than 100ms.

## 6. Architecture principles

20. **Terminal is the primary surface** — The terminal block list is the main area, the input bar is at the bottom, and there is no separate Chat sidebar.
21. **Inline AI** — AI conversation results render in the InlineAI area above the terminal, triggered by the ⚡ mode in the input bar.
22. **Session keep-alive** — Multi-tab PTY sessions are kept alive through hidden xterm.js (display:none); switching tabs does not rebuild them.
23. **Color system** — All colors are defined as `theme.css` CSS variables; do not hardcode color values in components (ANSI-related colors excepted).
24. **One implementation + state selection** — The same UI must not carry two code paths for different run targets (local / SSH): file operations go through the `FileOps` interface (`fileOpsFor(target)` is the single implementation selection point), and state differences such as menus and drag-drop semantics are expressed as `filePanelConfig` options; the view layer must not branch on the target with `if (isSsh)`, bypass the interface to `invoke` file commands directly, or handle paths itself.
25. **Terminal area alignment** — The terminal pane root has zero left/right padding (full-width elements such as the auth input bar and the input bar align with the pane edges, with equal left and right margins); the 8px left margin is applied only to the terminal screen content, never on the right, so the native scrollbar hugs the pane's right edge. Terminal content is therefore "left margin, right flush" rather than centered — a deliberate trade-off; see "The real alignment of the terminal area" in `docs/en/architecture.md`.
26. **Path decisions belong to the platform layer** — Absolute/relative checks, joining, and taking parent directories and file names all go to the platform layer: local paths use `@platform/path` on the frontend and `std::path` in Rust; remote (POSIX) paths use `@platform/posixPath` on the frontend and `src-tauri/src/platform/path.rs` in Rust. Business modules must not decide path shape themselves (on a Windows host `Path::is_absolute("/home")` is false and `join` inserts a backslash).

## 7. File organization

27. `src/features/terminal/` — terminal domain (components, hooks, stores, model, services/pipeline).
28. `src/features/*/stores/` — domain Zustand state; the view layer accesses it through each feature's public entry point.
29. `src/ui/` — generic UI components with no business semantics.
30. `src/features/chat/` — AI conversation rendering (AiBlock, ModelPill, ToolRunCard, Markdown, PanelChat).
31. `src/features/agent/` — AI agent logic (agentStream, tools, permissions, Skills, MCP, context, memory, scheduling, smart titles).
32. `src/features/settings/` — settings pages (behavior/model/MCP/Skills/shortcuts/terminal open mode/appearance: theme, block appearance, typography, theme files).
33. `src/platform/` and `src/utils/` — Tauri IPC, PTY, runtime adapters and pure helper functions. Business services belong to their feature.
34. `src/features/ssh/` `src/features/files/` `src/features/search/` `src/config/theme/` — SSH / local files / global search / design tokens.
35. `e2e/` — Playwright E2E tests; `tauri-mock.ts` provides the Tauri + Anthropic mock. The suite's dev-server port comes from `PW_PORT` (default 1421): parallel worktrees each pick their own port so one run never shuts down another run's server (which shows up as a wall of `ERR_CONNECTION_REFUSED`).

## 8. Observability and logging

36. **Add logs alongside feature changes** — For stateful flows, record structured events at the entry point, state transitions, external-call results and error/timeout branches so problems can be traced on a timeline.
37. **Log metadata first** — Record session/block IDs, state, duration, byte counts and error types; do not log raw commands, terminal output, prompts, credentials or unredacted user paths.
38. **Reuse the diagnostic interfaces** — The frontend uses `terminalDebug`, the Rust terminal layer uses `terminal::debug::write`; new event names should be stable and describe the operation stage, avoiding per-character or high-frequency output logging.
39. **Log according to the existing config** — The shared test machine currently has detailed diagnostic auto-save enabled; check existing records first and do not re-enable it on every test run. Other environments decide for themselves, and new environments default to auto-save off. For background tasks or new IPC flows, make sure the entry point and failure branches leave correlatable logs.
40. **Check existing logs first** — Check `%LOCALAPPDATA%\com.vrykell.app\logs\diagnostics-<YYYYMMDDTHH>.jsonl` first; the file name carries the UTC hour, so logs rotate hourly and older segments stay beside it (newest 24 / 256 MB kept). Configuration lives in `%APPDATA%\com.vrykell.app\diagnostics.json`, and its enabled state is a test-machine setting — do not infer new-user defaults from it.
41. **Logging must not block I/O** — High-frequency records are batched on the frontend and written by a buffered backend thread, keeping detailed events; flush pending records before exporting or changing auto-save config. Readings of the terminal data path (reads, output flushes, IPC intake, controller intake, routing destinations) aggregate into one `pty-io` / `terminal-io` record per second, and growing silence becomes `read-idle` at 1 s, 2 s, 4 s, …; new diagnostic logic must not reintroduce per-keystroke or per-chunk disk writes. Per-key input and cursor repaint events stay off by default and are written only while the settings page's Trace terminal input switch is on; with it off, only the per-second input counters and maximum write/paint latencies remain in `terminal-io`.

## 9. Window and title bar

42. **Drag handles only on non-interactive elements** — At runtime, dragging starts only when the element under the cursor carries `data-tauri-drag-region` and there is no clickable element without that attribute along the path. So title text and whitespace need that attribute, while buttons, inputs, links and other clickable elements must not have it, or a click would become a window drag; when adding title-bar elements, check the handle positions covered by `e2e/titlebar-drag.spec.ts`.

## 10. Shared components and docs

43. **Prefer shared components** — Sidebar list rows all go through `src/ui/layout/sidebarItem.tsx` (session tab rows and SSH connection rows share one look and interaction); list drag-reordering all goes through the "vacated slot" interaction in `src/ui/layout/listReorder.tsx` (the dragged row vacates its slot, a borderless placeholder marks the drop position, an icon preview follows the pointer, Escape cancels, and the post-drag click is suppressed); new lists opt in via `data-reorder-list` / `data-reorder-item` / `data-reorder-kind` and must not invent a second look. Errors render through `src/ui/feedback/ErrorBox.tsx` and `src/ui/feedback/ErrorDetails.tsx` (data-load failures use persistent bottom-right ErrorBox notifications, preserving retry, technical details, dismissal and modal keyboard access; transient action results use Toast in the same shared notification region; the global error page stays full-page). Settings option selectors all use the `src/ui/fields/Select.tsx` dropdown; hover hints go through `data-tip` plus `src/ui/feedback/TooltipLayer.tsx` (components do not set `title`: the OS tooltip cannot be styled, and icon-only controls keep an `aria-label` as their accessible name); multi-select lists use `src/ui/menus/CheckboxMenu.tsx` (toggling keeps the menu open, it closes on losing focus or Escape). When adding a similar surface, extract the shared component first, then wire it up.
44. **Stable test hooks** — When a refactor moves markup, keep the existing test hooks (`data-testid`, `data-tab-row-id`, `data-tab-group`, ARIA names, etc.) or update every unit/e2e test that references them in the same commit.
45. **Documentation layers** — The rule book is `docs/zh/development-rules.md` (with the English mirror `docs/en/development-rules.md`, kept in sync); the always-on summary is `AGENTS.md` (read first by Codex and other agents); the agent-facing conventions entry point is `.agents/skills/vrykell-conventions/SKILL.md` (read directly by Command Code and Codex; `.claude/skills/vrykell-conventions/SKILL.md` is the Claude Code bridge). Keep these in sync when rules change, and do not add another copy.
46. **Bilingual docs** — Documents under `docs/` stay bilingual: Chinese in `docs/zh/`, English in `docs/en/`, with file names matching one-to-one across the two. New documents must ship in both languages; editing either language version requires updating the other. Raw evidence screenshots are not translated and stay with the document they belong to.
47. **Build packages on request** — Run `npm run tauri build` or another installer/package builder only when the user explicitly asks for a package build. Requests to fix, review, test, or verify application behavior do not by themselves authorize installer builds; use tests, typechecking, architecture checks, or dev mode as appropriate.
48. **Use existing design first** — Before changing a surface, inspect its closest existing page and interaction. Reuse its components, spacing, inputs, menus, hover, and focus patterns. Extend or extract the existing implementation when needed; do not invent a separate visual treatment for an existing interaction. Review the result in the running UI at narrow and wide sizes.
## 11. Security floor

49. **New IPC commands must be gated** -- A new Tauri command either goes through a lease or policy check (and is registered in the gated-command list) or does something privileged-free; a new bare "read / write / execute any path" command is not allowed. The gated list and its checks live in `src-tauri/src/agent/permissions.rs`; changes update the defences table in `docs/zh/security-model.md`.
50. **HTML in the renderer is sanitized at one point** -- Only HTML that passed `sanitizeOutputHtml` (or an equivalent single construction point) reaches `dangerouslySetInnerHTML`. Untrusted content (model output, fetched pages, skill text, MCP results, terminal output, remote file names) takes the text / Markdown path; links in replies go through `Link` in `Markdown.tsx` (web links open in the system browser) and never navigate the app window.
51. **Third-party integration answers the security model** -- Before adding an MCP server, a skill source or an external harness (ACP), answer the checklist in `docs/zh/security-model.md` section 4 item by item and put the conclusions in the commit message. A third-party process is always "a program the user explicitly adds", and the settings copy must say that adding it is the authorization.
52. **Tightening beats loosening** -- Relaxing the CSP, widening the `assetProtocol` scope or adding a capability permission needs its reason in the commit message. Production CSP and development exceptions stay separate (`csp` / `devCsp`); development exceptions never reach a production build.

## 12. Tooling

53. **Edit source files with the edit tool only** -- Never rewrite source text through shell redirection / `Set-Content` / whole-file regex scripts: PowerShell's default encoding mangles non-ASCII, and that broke files twice (2026-10-14 and 10-15). Use the edit tool for every change; keep the shell for reading, searching and git operations.

## 13. Menus and palettes

54. **Menu hierarchy and color palettes** — All menu color palettes appear directly below shared actions in the footer, never in a submenu. Use a meaningful submenu only for multiple related choices; keep single settings destinations and switches directly accessible without a generic Settings parent or one-option submenu.

55. **Component icons only** — Interface icons use shared icon components, never text glyphs or native disclosure markers. Keyboard labels and mathematical operators remain text. Connection authentication uses the shared four-mode segmented control; settings option groups retain the shared dropdown. Tag pills and text fields reuse shared controls rather than local input styling.
