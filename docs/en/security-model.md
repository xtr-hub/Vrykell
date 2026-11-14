# Security model

## Window shell actions

The main window gains native resize dragging and always-on-top capabilities for its shared titlebar menu. Actions target the current window only; close retains existing unsaved-work guards. No new application command, filesystem access, network source, rendered HTML or terminal input is introduced.

## External session folders and images

The read-only `acp_workspace_root` command returns the application-owned default workspace path and prepares that directory; it accepts no caller-supplied path. A session without an explicit project starts in its own new folder. This prevents accidental project inheritance, but does not sandbox the external process. Attachments reuse the existing picker/drop grants and application-owned storage. Image prompts require the capability advertised by the agent, bounded image blocks and a separately bounded outbound frame; inbound and replay limits stay unchanged. Closing or cancelling a session invalidates pending attachment reads, and failed reads retain the composer draft. No capability, CSP origin, arbitrary read or authorization grant is added.

Local ACP transcript retention adds four application-database commands for save, list, read and delete. The store is application-owned SQLite: at most 200 rows, 16 MiB per transcript, bounded metadata, recognizable secrets redacted, and the list path returns metadata only. It grants no file, process or network authority; native conversation records already cross the same renderer/database boundary. No capability, CSP origin or path scope is broadened. Database round-trip, redaction, pruning and reload tests cover the boundary.

## External execution context

External tool initialization and descriptions explain the distinction between the agent host and the explicitly selected application terminal. Successful terminal reads return bounded host, directory, shell and user-provided notes captured for that turn. Only host/user/port metadata is copied; authentication fields are excluded. Notes remain untrusted context and grant no permissions. Missing-target and remote/local file mismatches return distinct guidance without selecting a terminal, establishing another connection or changing tool permissions. Native authorization, captured-target ownership and diagnostic redaction remain unchanged; no IPC commands, capabilities or content sources are added.

## Conversation turn and transport limits

Local tools share per-turn serialized execution. A refusal or an unanswered question closes queued and later calls in that turn; each subsequent user message starts a new scope. Native policy, confirmations and execution leases still apply. External protocol frames and replay buffers have explicit size limits and bounded queues; replay is consumed while its response is pending. Turn completion follows already received content, and a failed history load cannot inject its partial transcript into a replacement session. Request identifiers retain their original types. These changes add no commands, capabilities, file grants or network sources; independently configured external tools remain outside this adapter's control.

## Signed stable updates

The main window alone receives check, download, install and restart capabilities. The platform adapter uses a fixed HTTPS release feed and fixed project links; user inputs cannot supply updater endpoints or public keys. The native updater verifies each downloaded artifact against the embedded public key before installation becomes available. Release notes render as bounded plain text. Prerelease versions are rejected even if the feed returns one. No check, download or installation runs automatically at startup.

Installation requires confirmation and the existing unsaved-document guard, then closes terminal sessions and flushes diagnostics before native installation. Retry after a restart failure never reinstalls. The private signing key stays outside the repository and renderer, protected locally and supplied only to release jobs through an encrypted repository secret. The manual release workflow validates aligned stable versions, keeps artifacts in a draft until all four signed platform entries are present, rejects replacing a published release and publishes only when requested. This adds no file grants or renderer content sources. Update and process permissions are privileged main-window capabilities; existing content isolation remains required.

Local memory uses scoped, expiring records and bounded retrieval; legacy files remain pending and never enter prompts wholesale. Shared privileged UI operations consume single-use leases at the dispatch boundary. Interface leases bind the native webview and exact payload; dedicated tool leases retain their authorization path. Tool-to-command mappings are validated, and complete tool results/leases are excluded from diagnostics. No new network service, model, capability or CSP origin is added. The main renderer remains trusted: an interface lease is not a physical user gesture or isolation within one webview. See §5 for lifecycle and remaining limits.

Conversation streams run concurrently under separate owner IDs, cancellation controllers, queues and approval scopes. Existing terminal busy guards still reject conflicting command execution. The model proxy marks only failures while establishing a request as potentially retryable; the client never replays a started response or a whole tool turn. Retries retain the same validated endpoint and credential path, use a bounded abortable delay, and add no IPC command or capability.

Empty starter panes use a validated boolean marker in layout metadata. Explicit history restoration recreates them through existing resource owners; it never restores commands or missing nonempty conversation content. Remote starters require an existing saved connection and retain the standard authentication path. No credential, capability or execution policy changes are introduced.

## Foreground-bound terminal paste

Clipboard text, native paste events and image-paste keys retain their original session, terminal surface, running block and input modes across clipboard reads and confirmation. Text encoding still uses the existing terminal parser. Pasted input carries a native epoch: command/prompt markers and alternate-screen transitions invalidate it before output batching, and the webview compares its last observed epoch with native state before sending. Each queued paste chunk checks its owner; the backend checks again after acquiring the writer lock and between bounded partial writes. Newline keys travel separately from preceding text. Foreground completion cancels queued input without replaying its tail into the command composer or next prompt. Diagnostics contain only cancellation metadata.

`pty_input_epoch` reads an existing session's counter and grants no execution, file or network authority. The optional epoch on `pty_write` only restricts an existing write. The ordinary keyboard path retains its existing authorization. Unit, native partial-writer and browser tests cover exits during a running block, manual fullscreen and an alternate-screen application, plus stale confirmations and delayed clipboard reads.

This is cancellation at observed input boundaries, not process isolation. Bytes already accepted by the system's terminal input buffer cannot be withdrawn. A program or shell that supplies no supported lifecycle marker cannot provide the same boundary evidence; bracketed paste alone is not an acknowledgement that an application consumed text. Tests must not claim that an already accepted byte can never reach a subsequent reader.

## Session-owned application tools

The internal tool adapter uses authenticated, ephemeral loopback framing and a standard-input/output helper. Tokens remain in the child environment. Each external connection owns its catalog allowlist, active-turn generation and pending result identifiers; initialization and replay cannot execute tools. Only the main window can answer `acp_app_tool_result`, and results are size-limited and correlated to a live request. Existing tool implementations retain backend policy, path grants, native confirmation and single-use leases. Terminal targets are explicit and fixed for a turn; remote targets cannot invoke local file tools. Cancellation clears pending approvals and questions, and late approvals cannot execute. No credentials, arbitrary IPC dispatch, public listener or new CSP origin is exposed. See `application-tools.md` for boundaries and tests.

> Readers: **read this page before adding any feature to Vrykell**, especially when integrating
> third-party code (MCP servers, skills, external harnesses) or adding a new IPC command.
> Companion documents: `application-tools.md` (session tool boundaries), `architecture.md` (layering).
> Last updated 2026-10-30.

## Reference-only compositions and tool recovery

Within a request, terminal command calls execute in submission order before authorization and PTY writes. A denied, cancelled or unconfirmed command prevents queued successors from writing. An unconfirmed command lifts its soft boundary for a newly submitted command only after the terminal is confirmed ready again; calls already queued at the boundary stay blocked. Completed nonzero diagnostics do not poison the queue. The existing busy guard still protects against human or independent callers; cancellation never kills the live process.

`save_workspace_history` accepts bounded, versioned layout references with whitelisted member fields; it rejects content-bearing payloads, invalid layouts and attempts to overwrite terminal rows. Writes are atomic historical metadata, not startup process records. The additive metadata migration retains existing rows. Source and split filtering use indexed flags maintained on writes. `get_conversation` validates its identifier and performs one parameter-bound metadata lookup without loading messages. Neither command expands file access, network origins, capabilities, CSP or execution privileges.

AI tool denials end tool access for the current turn, including further questions. Explain the result once and finish the reply; the next user message gets a fresh recovery scope. Native confirmation and authorization leases remain required; interpreter or encoding substitutions never grant permission. Window focus does not skip or reject native confirmation; unanswered prompts still time out and late approvals cannot execute. Remote tool contexts reject local filesystem access even at execution time. Tool failures and approval outcomes remain stored in the transcript without automatic notifications. Explicit result review expands the reason and stored output inside the card without tool footer errors. Only registered tools are callable; policy-disabled tools are named in the prompt, and a model call to an unavailable tool becomes an inline note instead of an error card. Terminal readiness reports distinguish busy, ready, interactive and unknown; a quiet screen is not completion evidence, while a retained late completion marker is. Diagnostics continue to omit commands, outputs and credentials.

`ask_user` is bounded in-memory interaction, not privileged execution or approval. At most one question is opened per turn; the answered question is removed from subsequent tool choices, and repeated or paraphrased requests cannot open another card. A skipped or cancelled question ends tool continuation. Requests bind to a conversation and call, support cancellation and expire after fifteen minutes. Answers never create grants; pending callbacks are not persisted. Hidden leaked control syntax is never executed. This adds no IPC, filesystem or network authority.

## 1. Threat model: who can influence what

Structured external questions advertise form elicitation only when the native handler is present. Forms bind to the receiving connection and its live agent session; unsupported setup scopes and URL requests are declined. Flat schemas, fields, choices, pending requests and answer sizes are bounded. Native validation retains typed values, checks required fields and constraints, rejects unknown answers and credential fields, and compiles patterns with a bounded linear-time engine. Answers are one-shot; timeout, stop, close and transport loss release pending state. Questions never create execution grants. Diagnostics record lifecycle identities and status only, without schemas, questions or answers.

External child processes inherit explicit harness proxy settings first, then process proxy settings, then the enabled manual desktop proxy on Windows. Local bridge hosts always bypass configured proxies. Environment changes apply only to the child; credentials and proxy URLs are not logged. Automatic proxy scripts are not evaluated by this fallback.

| Input source | Trust level | What it can reach |
| --- | --- | --- |
| The user (keyboard, panels, settings) | Authority | Everything (the terminal is arbitrary code execution — that is the product) |
| **Model output** (this app's agent) | **Untrusted content** | The rendering path (Markdown) and tool arguments (constrained by approvals and leases) |
| **Fetched pages, search snippets, skill text, MCP tool results** | **Untrusted content** | The same, and they are the **prompt-injection** entry point (content may say "send X to Y") |
| **Remote SSH hosts** | **Untrusted content** | Terminal output, remote file names; sessions are persisted and rendered again |
| **Third-party harnesses (ACP, integrated)** | **A program the user adds** | Its own process rights (cannot be stopped); operations that come through the capabilities we advertised (can be stopped) |
| **A fully compromised renderer** | Worst case | Everything the UI can do — **including typing into the PTY** (§3) |

In one line: we protect "**untrusted content must not become a rendering-layer or execution-layer
instruction**", and "**dangerous operations require a confirmation the page cannot forge**". We do
not pretend to protect "the renderer itself" or "the programs the user installs".

## 2. The security lines of defence (state, evidence, verification)

| Line | State | Evidence | How it is verified |
| --- | --- | --- | --- |
| No Node in the renderer | ✅ Tauri by construction; the renderer has no direct filesystem access, everything goes through IPC | `src-tauri/tauri.conf.json` | Structural |
| Explicit IPC with a capability list | ✅ Only `core:default` + dialog/drag/clipboard/opener + window controls; application-owned commands | `src-tauri/capabilities/default.json` | Changing the list means updating the docs |
| Per-command authorization (leases) | ✅ The four gated commands (`read_file_text`/`write_file_text`/`edit_file_text`/`fs_search`) must present a **single-use lease bound to the command plus an argument digest** or fail closed | `src-tauri/src/agent/permissions.rs` | The lease cases in `cargo test --lib` |
| Unforgeable confirmation for dangerous work | ✅ A hit on a dangerous command, a credential path or a durable write raises a **native system dialog**; window focus does not bypass the dialog or cause an automatic refusal; approval cards have a deadline | the same file | cargo tests + e2e `approval-timeout` |
| Authorization granularity | ✅ Level table (allow/ask/deny) + **per-shape session approval** (`npm run` opens that kind only) + danger rules decided before any grant | the same file | cargo shape-derivation cases + e2e `approval-shape` |
| Path grants (arbitrary reads closed) | ✅ Commands that hand file *contents* to the page (attachment import) only accept a path an **operating-system gesture** produced: a grant registry in Rust (`files/grants.rs`, persisted to `~/.vrykell/approved-paths.json`); pickers run through our `pick_path` (only Rust opening the dialog knows the choice came from the user) and drops are recorded from `WindowEvent::DragDrop`; the app's own directories (attachments, skills) need no gesture; the unused `read_image_data_url` command is gone | `files/grants.rs`, `lib.rs` | cargo tests (granted file, granted directory, app-owned directory, everything else refused) |
| Rendering hygiene | ✅ Markdown enables no raw HTML, bare URLs are not linkified, remote images degrade to text, links never navigate the app window (they go to the system browser); terminal, command-block and SSH screen snapshots all pass through `sanitizeOutputHtml` (only `<span>` with safe styles plus `<br>`, under a threat model that includes "the local DB was tampered with") | `Markdown.tsx`, `sanitizeHtml.ts`, `TerminalPanel.tsx` | vitest (links, snapshot sanitizing) + e2e `chat-links` |
| CSP and resource scope | ✅ Production CSP: `default-src 'self'`, `script-src 'self'` (Tauri's own injected scripts are hash-allowed), `style-src 'self' 'unsafe-inline'` (React inline styles need it), `object-src 'none'`, `form-action 'none'`, `frame-ancestors 'none'`, images only self/data/asset, connect only ipc; the development exceptions (HMR websocket, inline scripts) live in `devCsp` only | `src-tauri/tauri.conf.json` | After `npm run build`, `dist/index.html` has no inline script; CSP changes need an app restart |
| Secrets and credentials | Platform-dependent storage: the system credential store on macOS, per-user encryption on Windows, and **plaintext** `~/.vrykell/secrets.json` on Linux and other platforms, with directory mode `0700` and file mode `0600`. File permissions are not encryption. **Model requests are proxied in Rust so stored keys are not returned to the renderer**; attachment reads are confined to the attachments directory. Do not sync or share the plaintext credential file. | `secret.rs`, `files/fs.rs` | Native credential tests; inspect storage permissions and confirm `config.json` holds no key |

## 3. Two things that cannot be done, stated plainly

1. **Real isolation is out of reach**: the UI must drive the PTY (the terminal is the product), so a
   compromised renderer already means arbitrary command execution as the user. No IPC split and no
   "move the agent out of the webview" changes that. Our goal is therefore to **shrink what a
   compromise is worth**, not to prevent the compromise.
2. **"Caller identity" is currently empty**: the agent and the UI are both JavaScript in the same
   webview, so the backend cannot tell them apart. It is technically possible — Tauri injects the
   calling webview into a command signature and the page cannot forge it — but with a single webview
   it would buy nothing. When a second webview appears (an ACP harness session UI, for instance), do
   all three together: command namespaces, per-caller authorization, and leases bound to a
   `webview_label`.

## 4. Checklist for every new feature (each PR should answer these)

1. **New IPC command**: is it gated by a lease or policy? Is it in the gated-command list? Could it
   become a new "read/write/execute any path" entry point?
2. **New rendering path**: is something else being pushed into the DOM as `innerHTML`? Can it go
   through Markdown or text instead? If it must be HTML, does it pass `sanitizeOutputHtml`?
3. **New content source** (third-party text, files, endpoints): is it untrusted content? Is it
   sanitized before rendering? Could it invite an external-link click? (Links always go through
   `Link`, which hands web links to the system browser.)
4. **New capability or resource**: does the CSP need relaxing? Does the `assetProtocol` scope need to
   grow? Does the capability list need an entry? All three answers belong in the PR description.
5. **New third-party code** (process, script, plugin): is it added explicitly by the user? Does the
   settings copy say that adding it is the authorization?
6. **New authorization**: does it reuse the existing chain (level table, shape grants, deadlines,
   danger rules), or invent a second one? An invented one needs review.
7. **Logging**: does new logging leak command text, output or secrets? (Diagnostics record metadata
   only.)
8. **Tests**: does this line of defence have a unit or e2e test? (See the last column of §2.)

## 5. Known gaps and their cost

| Gap | Cost |
| --- | --- |
| `opener`'s `open_path` scope is `**` (the file panel must be able to open any user file; by design, and no worse than the PTY) | — |
| Starting an external harness (`acp_handshake`) | A **documented class**, not a gap: it only starts a program the user **enabled** in `~/.vrykell/harnesses.json`, a probe **runs no tools** (every permission request is refused), and it does not widen the surface — the same webview can already run anything through the PTY. The ACP settings section states that adding a harness is the authorization |
| Capability-based file access for the whole panel (paths must come from a user gesture or the shell's cwd) | 3–6 weeks, changes product semantics, still does not stop the PTY → not doing it |
| Moving the agent out of the webview | 2–4 months (Rust) / 2–4 weeks (sidecar), still does not stop the PTY → not doing it |

## Native dependency warnings (2026-10-30)

The lockfile advisory audit retains warnings instead of suppressing them. A successful audit means no entries classified as vulnerabilities by that database; it does not mean that all native dependencies are maintained or free of memory-safety problems.

- `glib 0.18.5` has the unresolved iterator-soundness warning [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html). The Linux toolkit dependency graph requires the `0.18` family; the fix starts at `0.20`. Adding a second version does not fix the existing toolkit. Follow the upstream runtime migration and validate the affected platform before claiming this issue resolved.
- Transitive `serial`, `proc-macro-error`, the `unic-*` family, `zbus_names`, `zvariant` and `zvariant_derive` have maintenance warnings. They come through terminal, native toolkit, rendering or system-integration dependencies. Review replacements when their owning dependency updates; these warnings remain visible in CI.
- The central advisory entry [GHSA-qwgh-2vcv-g2f7](https://github.com/advisories/GHSA-qwgh-2vcv-g2f7) matches `block-buffer 0.10.4`, while the [upstream advisory](https://github.com/RustCrypto/utils/security/advisories/GHSA-qwgh-2vcv-g2f7) specifies `>=0.11.0,<0.12.1`. Treat this as conflicting version metadata and recheck the affected range before changing the older dependency family. Do not describe a database match as a reproduced exploit.

Repeat the audit before each release. Dependency warnings, platform tests and the exact source revision belong in release validation; source changes do not repair previously published installers.

## Saved connection extensions

Workspace foundation: pane transfer and deletion accept bounded, distinct identifiers and at most four pane references. Transfers require existing terminal-session owners and run in a database transaction; values use bound SQL parameters. Deletion targets only selected pane content, including mapped legacy primary-pane rows. Snapshots validate scope, groups, tree shape/count, ratios and unique references before restoration; parsing alone starts no process or file operation. Resource adapters reuse existing close guards and process cleanup. No file grant, capability, network origin, HTML interpretation or approval path is added. Transaction, malformed-input, sibling-preservation and live-host tests cover the boundary.

Independent forwarding adds three explicit lifecycle commands: start accepts only a saved connection identifier and a saved rule identifier, stop addresses that pair, and status returns only runtime metadata. The backend reloads and validates the saved endpoints and reuses existing authentication, proxy and strict host-key checks; the renderer cannot supply shell text or credential arguments. Loopback is the default bind address. A user-selected public listener exposes the configured network endpoint, so automatic start remains an explicit per-rule preference. Session and client counts, protocol handshakes and buffers are bounded. Stop, endpoint changes, profile deletion and application exit close the managed listeners. No CSP, capability or path scope is broadened; no new HTML rendering or diagnostic payload is introduced.

The proxy configuration commands validate profile identifiers, endpoint syntax, port ranges and credential sizes. Non-secret profiles are written atomically; passwords stay in the existing platform credential store and are omitted from returned objects. The terminal helper uses a validated profile ID rather than credentials in command arguments. HTTP CONNECT and SOCKS5 headers, addresses and handshake duration are bounded, and destination host-key verification is unchanged. The initial proxy-authentication exchange is not encrypted by these protocols; use trusted proxies on protected networks.

Remote environment values are sent as session options, never installed into the local process environment. Names, sizes, counts and control characters are validated independently in the UI and backend. Notes are byte-bounded user context, not policy or authorization. Diagnostics redact environment contents and both note fields. No capabilities or CSP origins are broadened. Protocol, argument, serialization and database round-trip tests accompany the full-page editor tests. See `ssh-profiles.md` for supported combinations and limitations.

## Endpoint migration and text operations

The existing credential-write command can copy a configured endpoint's key to a validated HTTP(S) endpoint of the same API family. It prefers an already configured destination key and never reveals plaintext to the renderer. The UI asks for explicit consent before reusing a key at a different origin; cancellation leaves the original endpoint and key unchanged. Original credentials remain available for other configured models. Custom provider metadata contains no key material.

Fenced-code highlighting renders token slices as escaped text elements, never injected HTML; unknown languages and oversized input remain plain text. Modal editor commands reuse existing save, picker, revision checks and close guards; explicit force-close does not save a draft. Copy operators write only the text selected by the user to the existing system clipboard channel. No new native command, file grant, network origin or capability is added.

New local terminal processes read registered system/user executable search paths and merge them into the child environment. They never mutate the parent process environment or run a script to obtain paths. Inherited custom entries retain priority; this does not grant access to additional files or change remote environments.

## Completion and marketplace requests

The new `shell_complete` command accepts only known shell identifiers, an absolute working directory, bounded plain completion text and a valid cursor offset. Constant internal child scripts receive input through environment data; execution syntax is rejected before a process starts. Queries never enter the live terminal, child duration and output are capped, standard input is closed, windows stay hidden, and dropped requests terminate the child. Remote panes never query the local shell. This read-only discovery path adds no file-write grant, capability or CSP exception; completion text remains redacted in diagnostics.

The existing marketplace commands now honor operating-system proxies while preserving endpoint allowlisting, redirect restrictions and TLS verification. Index and descriptor bodies are capped; description requests use bounded concurrency and a total deadline. A listing pins descriptor requests to its index revision, and switching the selected repository invalidates stale UI responses. Installed external skills remain untrusted. The shared resource switcher references existing domain identities and guarded-close paths; it neither recreates live resources nor changes authorization.

The read-only `history_page` command accepts bounded sizes, whitelisted source/sort values and length-bounded keyset cursors. SQL fragments come only from internal whitelists; cursor values remain bound parameters. It returns metadata only and exposes no path, script or remote request. Diagnostics contain counts, cursor presence, success and separate lock/query timings, never cursor values or content. Mixed placement moves existing hosts within the same webview, adding no HTML interpretation, file grant, capability, process owner or approval path. Validated layout references cannot reopen files or start processes by themselves.

File metadata and mutations reuse authenticated file channels independently of terminal sessions and transfers. Retention is bounded to 32 idle channels and two per profile; channels idle for 60 seconds are not reused. Binding includes the saved endpoint/options, a password digest and temporary-authentication revision. Profile edits/deletion, proxy changes and authentication clearing invalidate retention and prevent late returns from restoring old channels. Network operations and cleanup never hold the pool lock. Reused-channel read failures may reconnect once; mutations are never replayed automatically. Host trust and authentication still run when a channel opens. No new IPC, file grant, capability or network origin is added. Diagnostics record reuse, success and timing only, without paths, contents or credentials.

Saved jump references are resolved by the backend from the existing connection database, with cycle detection and an eight-hop limit. Resolved credentials never serialize to the renderer. Each hop verifies its own host key before authentication; the destination handshake remains encrypted inside forwarding channels. Internal loopback socket pairs accept only their preconnected peer and close their listener before relaying; each direction uses bounded buffers. Destination ownership cancels the relay chain, and profile/authentication changes invalidate retained channels and dependent forwards. The system client receives a temporary non-secret configuration that is removed when the terminal reader exits. Route resolution adds no capabilities, file grants, content sources or relaxed host trust. Input recovery writes fixed mode resets only to the existing terminal parser, never to the remote shell; diagnostics contain mode flags without key payloads.

Before every backend handshake, supported host-key algorithms matching the endpoint's existing trust records are preferred in their original relative order. The trust library matches names, hashed names and explicit ports. RSA signature variants share the recorded RSA key identity. Remaining supported algorithms retain their order, and the negotiated key still passes the existing strict comparison before authentication. An alternative key type never bypasses an existing mismatch or writes a new trust record. Diagnostics record the negotiated algorithm and whether a known key type was preferred, without key material or credentials. Unit and isolated multi-key protocol tests cover endpoint matching, unknown hosts, unchanged trusted keys and real key changes.

Interactive service authentication extends the existing authentication command with a challenge channel and adds response/cancel commands scoped to the calling window and attempt identifier. The backend reloads the saved endpoint and route, binds the completion to its authentication revision and rechecks the route before retaining a session. At most 16 attempts run, each with a five-minute lifetime, 90 seconds per answer, 32 rounds and 16 fields per round. Instructions, field labels and answers have byte limits. Unknown host keys require explicit confirmation of the exact fingerprint on the live session; mismatches never reach authentication. Remote prompts render as plain text. All response fields are redacted in frontend and backend diagnostics; answers are not cached, serialized into profiles or replayed on reconnect. The authentication library owns transient answer buffers during the protocol call.

At most 64 temporary authentication entries are retained. Interactive entries own the authenticated transport; files and monitoring share a bounded ten-second operation gate and five-second network timeout. Forwarding and transfer sessions cannot clone it or change its blocking mode. Profile edits, clearing authentication, proxy changes and dependent-terminal closure invalidate the retained transport; closing runs outside the cache lock. Cancellation wakes pending challenges and prevents retaining a cancelled result. No network operation holds the authentication registry or cache lock. No CSP sources, file grants or terminal input paths are added. Unit, browser and isolated protocol checks cover owner/round validation, bounds, cancellation, trust, concurrent reuse and response redaction.

Endpoint credentials use an endpoint binding; retained transports and in-flight completion checks use the full route binding. Flattening a hop does not invalidate its credential or revoke its own service transport. A bounded set of the latest 64 completion records retains only attempt/window identifiers, connection identifiers and revisions, allowing late cancellation to revoke exactly the published revision. Registry removal and completion publication are atomic. Cancellation is checked before authentication calls and between key candidates. Failed subsystems may be reopened or an empty channel opened to check transport health, without replaying a file operation or remote command; actual transport loss still requires fresh authentication.
