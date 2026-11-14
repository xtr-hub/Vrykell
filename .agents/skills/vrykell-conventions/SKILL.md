---
name: vrykell-conventions
description: MANDATORY reading before any change to Vrykell code, tests or docs - hard constraints, commands, shared components, testing, commit rules and definition of done. Always open this skill first; never write Vrykell code from memory of the project.
---

# Vrykell conventions

> **Mandatory: read this in full before writing, editing or reviewing anything.**
> This is a hard requirement, not a reference. A change that breaks a constraint below is not
> done, however green the tests are, and having skimmed the file does not count as having read
> it. Re-check this list against your own diff before reporting a task finished.

Vrykell is a Tauri 2 desktop app: React 19 + TypeScript frontend, Rust backend
(`src-tauri/`), terminal-first UI with AI chat (Anthropic BYOK). User-visible copy lives as
English strings in code with Chinese entries in `src/i18n`; all code comments are English.

## Commands

| Task | Command |
| --- | --- |
| Install dependencies | `npm install` |
| Frontend dev server (strict port 1420) | `npm run dev` |
| Full desktop app with hot reload | `npm run tauri dev` |
| Typecheck | `npx tsc --noEmit` |
| Unit tests (vitest, jsdom) | `npm run test` |
| E2E (playwright; dev server port from `PW_PORT`, default 1421) | `npm run test:e2e` |
| Architecture boundaries | `npm run check:architecture` |
| Rust tests | `cargo test` in `src-tauri/` |

Before committing, run at least `npx tsc --noEmit`, `npm run test` and
`npm run check:architecture`. Run `cargo test` / e2e when the change can touch them.

Release package builds are opt-in. Run `npm run tauri build` (or another installer/package
builder) only when the user explicitly asks to build packages. A request to fix, review, test,
or verify application behavior does not by itself authorize producing installers; use tests,
typechecking, architecture checks, or dev mode as appropriate.

## Hard constraints (never break)

1. Terminal parsing is xterm.js only. Never implement a VT/ANSI parser, and never show
   xterm in the UI (it exists for PTY handling and VT parsing, hidden).
2. No regex lookbehind (`(?<=...)`, `(?<!...)`) - macOS WKWebView rejects it. No lookahead
   tricks that rely on it either.
3. Never hardcode user-visible Chinese: write the string in English and add its Chinese entry
   to `src/i18n`. New or edited comments (JSDoc, inline, CSS, Rust) are English and use generic
   terms - no third-party product or brand names. Docs and commit messages follow the same ban;
   model and agent-harness names are exempt.
4. TypeScript strict: zero errors; avoid `any` unless unavoidable.
5. Colors come from `theme.css` variables - no hardcoded colors (ANSI palette excepted).
   Animations are 100 ms or slower.
6. Independent implementation: never copy third-party source code.
7. Interface icons use shared icon components, never text glyphs or native disclosure markers. Keyboard labels and mathematical operators remain text.

## Shared components (reuse, never fork)

- **Existing design first** — Before changing a surface, inspect its closest existing counterpart and reuse its component, spacing, input, menu, hover, and focus patterns. Extend or extract the existing implementation when needed. Do not invent a new visual treatment for an interaction the app already has. Review the result in the running UI at its actual narrow and wide sizes.

- **Sidebar rows** - `src/ui/layout/sidebarItem.tsx`. Session tab rows and SSH rows render through
  `SidebarItem`; a new list that looks like them must use it instead of hand-rolling markup.
- **List reordering** - `src/ui/layout/listReorder.tsx`. The mechanic matches the titlebar buttons:
  the dragged row leaves its slot, a borderless placeholder marks the drop slot, an icon preview
  follows the pointer, Escape cancels and the post-drag click is suppressed. Lists opt in with
  `data-reorder-list` on the container and `data-reorder-item` (+ `data-reorder-kind`) on rows;
  rows start drags through `useListReorderDrag`, and gaps are rendered with
  `ListReorderPlaceholder` / `ListReorderZonePlaceholder`. Do not add a second reorder look.
- **Error surfaces** - `ErrorBox` (tone, title, message, actions, collapsible details) and
  `ErrorDetails` (collapsible raw text with copy) from `src/ui/`. A failure of something the
  panel is displaying uses a persistent bottom-right notification through ErrorBox; a transient action result uses Toast in the same shared notification region. The global error page remains full-page. Keep retry, details, dismissal and modal keyboard access.
  Bare `role="alert"` blocks are not acceptable.
  AI reply failures stay in their transcript through `ErrorBox placement="inline"`. Tool cards keep their status and stored result without footer errors or automatic failure notifications; explicit result review expands the reason and output inside the card, never in the notification region. Routine repository discovery and operation failures use timed bottom-right informational notifications with details and recovery. Persistent error notifications are reserved for failures that prevent continued use. Loading history and approval outcomes never automatically publish notifications.
- **Settings option groups** use the `Select` dropdown from `src/ui/fields/Select.tsx`, not
  segmented pill controls.
- **Connection authentication** uses the shared `SegmentedControl` for its four explicit modes. Editable tag pills use `TagInput`; text fields use the shared field variant instead of local input styling.
- **Hover hints** go through `data-tip` and `src/ui/feedback/TooltipLayer.tsx` (one themed bubble).
  Components do not set `title` - the OS tooltip cannot be styled - and icon-only
  controls keep an `aria-label` as their accessible name.
- **Multi-select menus** use `src/ui/menus/CheckboxMenu.tsx`: toggling keeps the menu open and
  it closes only when it loses focus (outside press or Escape).
- **Menu hierarchy and colors** - color palettes in action menus always appear directly below the actions
  in the shared footer, never in a submenu. Use a meaningful submenu for multiple related
  choices; keep single destinations and switches directly accessible, without a generic Settings parent.
- **One implementation per surface** - local and SSH file panels share the `FileOps`
  interface plus `filePanelConfig`; view code must not branch on the target or bypass the
  interface (rule 24 in `docs/zh/development-rules.md`).

## Architecture in one screen

```
PTY output -> Rust StreamScanner (src-tauri/src/terminal/scan.rs, synchronous)
           -> SessionController (src/features/terminal/services/pipeline/sessionController.ts,
              3-scene state machine, one per tab/pane)
           -> offscreen xterm per block, rendered as real DOM by TerminalBlockList
```

- `src/core/terminal/events.ts` mirrors the Rust `ScanEvent` as `DispatchEvent`.
- Domains: `src/features/agent` (stream, tools, permissions, MCP, context, memory),
  `src/features/chat` (AiBlock, ToolRunCard, Markdown, PanelChat),
  `src/features/settings`, `src/features/ssh`, `src/features/files`, `src/features/search`,
  `src/features/terminal`, `src/features/workspace`.
- Infrastructure: `src/platform/` (Tauri IPC, PTY, fs, shells), `src/ui/` (business-agnostic
  components), `src/config/`, `src/utils/`, `src/i18n/`, `src/test-utils/`.
- `src-tauri/src/shell_integration.rs` owns the OSC 133/7 shell hooks.

## Testing

- Every feature gets vitest unit tests in the owning `__tests__/` directory.
- Every interactive feature gets Playwright e2e in `e2e/` (Tauri + Anthropic mocks live in
  `e2e/tauri-mock.ts`; the suite runs with a single worker). Its dev server takes `PW_PORT`
  (default 1421) so parallel worktrees never shut down each other's server.
- Assert user-visible behavior (labels, test ids, persisted settings), not implementation
  details. Coverage gates: 80% statements/functions/lines, 75% branches.
- When a refactor moves markup, either keep the existing hooks (`data-testid`,
  `data-tab-row-id`, `data-tab-group`, ARIA labels) or update every spec in the same commit.

## Diagnosing runtime problems

The app records structured diagnostics. **Read what is already recorded before asking for a
reproduction, a hand-run probe or a log by hand.**

- `%LOCALAPPDATA%\com.vrykell.app\logs\diagnostics-<YYYYMMDDTHH>.jsonl` - IPC calls, PTY writes,
  scan events, terminal input, scene changes and block transitions, each with a timestamp and a
  `sequence` number. The name carries the UTC hour, so a new segment starts every hour; the newest
  24 segments (and at most 256 MB) are kept, older ones are pruned.
- `%APPDATA%\com.vrykell.app\diagnostics.json` holds the `autoSave` flag. Its state belongs to
  the machine: check the records that already exist instead of turning auto-save on again for
  every run.
- Only metadata is recorded (rule 37): command text, terminal output and key payloads are
  redacted. When a question needs something the log cannot give, add a stable
  `terminalDebug(...)` marker in the same commit as the fix, then read the log again.

## Workflow

1. Read the owning feature and the shared component before adding code. Read
   `docs/zh/security-model.md` as well when the change touches IPC, rendering or third-party
   integration.
2. When something fails at runtime, read the app's own diagnostics first (above); ask for a
   reproduction only when the log cannot answer the question.
3. Small focused commits; English subject with the `feat:` / `fix:` / `test:` / `refactor:` /
   `docs:` prefix, details as body bullets.
4. New features update the test checklist in `docs/zh/feature-spec.md` (mirror `docs/en/feature-spec.md`).
5. Definition of done: typecheck, unit tests and the architecture guard are green; e2e covers
   touched interactions; no dead code, unused imports or commented-out blocks remain; every comment
   you wrote or edited is English and brand-free, and so are your doc changes and commit messages
   (constraint 3), while user-visible copy stays Chinese.
6. Edit source files with the edit tool; never rewrite file text through shell redirection,
   `Set-Content` or whole-file regex scripts (rule 53) - PowerShell's default encoding has
   broken files twice. The shell is for reading, searching and git.

## Deep references

- `AGENTS.md` - the always-on summary of these rules (Codex and other agents read it first).
- `docs/zh/development-rules.md` (mirror `docs/en/development-rules.md`) - the numbered rule book;
  this skill and that file must agree.
- `docs/zh/security-model.md` (mirror `docs/en/security-model.md`) - the seven defences, the two
  things that cannot be done, and the checklist every new IPC command, rendering path or
  third-party integration must answer (read it before ACP work).
- `docs/zh/architecture.md` - pipeline and module detail.
- `docs/zh/feature-spec.md` - feature specifications and test checklist.
- Docs are bilingual: Chinese in `docs/zh/`, English in `docs/en/`; keep both in sync when editing.
