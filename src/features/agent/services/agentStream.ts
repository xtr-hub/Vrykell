/**
 * agentStream — the model SDK implementation of the chat store's StreamFn.
 *
 * Text deltas go through onChunk (batched by the chat store every 50ms); low-frequency tool
 * events are written straight to ctx.handlers.onToolEvent (upserting a ToolRun rendered as a
 * node card on the rail). With agentMode off, tools is undefined and behavior matches the
 * plain-text path. Networking goes through the backend proxy fetch injected by createChatModel,
 * so keys never leave the backend.
 */
import { describeError } from '@features/agent/model/agentErrors';
import { stepCountIs, streamText, type ModelMessage, type ToolSet, asSchema } from 'ai';
import { getFocusedTerminalId } from '@features/terminal';
import { useSshStore } from '@features/ssh';
import { invoke } from '@platform/diagnostics';
import { t } from '@i18n';
import type { StreamFn } from '@features/chat';
import { createChatModel, createNativeWebSearchTool, deepThinkProviderOptions, providerId, supportsThinkingPassback, type ProviderKind } from '@features/agent/services/provider';
import { useAgentSettings } from '@features/agent/stores/agentSettings';
import { estimateTokens, messageTokens, sizeModelMessages, planContext, IMAGE_TOKEN_ESTIMATE, type SizedMessage } from '@features/agent/model/context';
import { attachmentsForModel, supportsVision } from '@features/agent/model/attachments';
import { buildTools } from '@features/agent/tools';
import { buildTavilySearchTool } from '@features/agent/tools/webSearch';
import { buildWebSearchTool, buildWebFetchTool, buildWebCrawlTool } from '@features/agent/tools/webFetch';
import { buildSystemPrompt } from '@features/agent/model/systemPrompt';
import { terminalDebug } from '@features/terminal/services/terminalDebug';
import { listSkills, buildSkillsContext, availableSkillMetas } from '@features/agent/services/skills';
import { memoryScope, retrieveMemory } from './memory';
import { environmentForPane } from '@features/chat/services/conversationContext';
import { listMcpTools, buildMcpTool } from '@features/agent/services/mcp';
import { levelOf, TOOL_NAMES, type ToolContext } from '@features/agent/stores/permissions';
import { useUsageStore } from '@features/agent/stores/usage';
import { partsToDiscussionText, partsToModelMessages, type ToolRunState } from '@features/agent/model/messageParts';
import { executionPaneSpec } from './executionTarget';
import { prepareToolRecoveryStep, TOOL_RECOVERY_GUIDANCE, TOOL_TURN_CLOSED } from '../model/toolRecovery';
import { visibleAssistantText } from '@features/chat/model/providerMarkup';
import { ToolTurn } from './toolTurn';

interface AiConfigInfoRust {
  has_key: boolean;
  base_url: string;
  model: string;
  provider: ProviderKind;
  has_anthropic_key: boolean;
  has_gemini_key: boolean;
  has_tavily_key: boolean;
  /** Providers (endpoint ids) that hold their own API key. */
  provider_keys?: string[];
  models: {
    id: string; name: string; provider: ProviderKind; baseUrl: string; model: string;
    capabilities?: { vision: boolean; reasoning: boolean; tools: boolean; search: boolean };
  }[];
  active_model: string;
}

function hasKeyFor(info: AiConfigInfoRust): boolean {
  // Keys are stored per endpoint, so the endpoint identity decides - not the API family.
  if (info.provider_keys) return info.provider_keys.includes(providerId(info.provider, info.base_url));
  switch (info.provider) {
    case 'anthropic':
      return info.has_anthropic_key;
    case 'gemini':
      return info.has_gemini_key;
    default:
      return info.has_key;
  }
}

export const agentStream: StreamFn = async (messages, onChunk, ctx) => {
  // Resolve once before any asynchronous work; focus changes never redirect a running request.
  const executionPane = ctx?.paneId === undefined ? getFocusedTerminalId() : ctx.paneId;
  const capturedEnvironment = ctx?.environment ?? (executionPane ? environmentForPane(executionPane) : null);
  const remote = ctx?.environment?.kind === 'ssh' || executionPaneSpec(executionPane)?.kind === 'ssh';
  const remoteSpec = executionPaneSpec(executionPane)?.ssh;
  const hostNotes = remote ? useSshStore.getState().connections.find(connection => connection.id === remoteSpec?.connectionId)?.aiNotes ?? ctx?.environment?.aiNotes ?? remoteSpec?.aiNotes : undefined;
  const info = await invoke<AiConfigInfoRust>('get_ai_config');
  if (!hasKeyFor(info)) {
    terminalDebug('chat-provider-key-check', { provider: info.provider, activeModel: info.active_model, configured: false, configuredEndpoints: info.provider_keys?.length ?? 0 });
    throw new Error(t('No API key is configured. Select a configured provider in model settings.'));
  }
  const model = createChatModel({
    provider: info.provider,
    baseUrl: info.base_url,
    model: info.model,
    // The conversation (tab) is the session scope endpoints may route by.
    sessionId: ctx?.tabId,
  });
  const settings = useAgentSettings.getState().resolve(info.active_model);
  const countTokens = estimateTokens;
  const agentMode = settings.agentMode;
  const emitTool = ctx?.handlers?.onToolEvent;
  const emitReasoning = ctx?.handlers?.onReasoning;

  // Attachments: a user message with attachments expands into a multimodal ModelMessage (text
  // segments + image parts); for non-vision models, attachmentsForModel downgrades images to a
  // placeholder text prompt. Vision capability prefers the probed result (detected on creation),
  // falling back to a name heuristic for older data.
  const vision =
    (info.models ?? []).find((m) => m.id === info.active_model)?.capabilities?.vision ??
    supportsVision(info.provider, info.model);
  const latestQuestion = [...messages].reverse().find(message => message.role === 'user');
  if (!vision && latestQuestion?.attachments?.some(attachment => attachment.mime.startsWith('image/'))) {
    throw new Error(t('The selected model does not support image input. Choose a model with image input enabled.'));
  }
  const sized: SizedMessage[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' && m.parts?.some(part => part.kind === 'tool')) {
      if (agentMode) {
        for (const msg of partsToModelMessages(m.content, m.parts)) {
          const safe = msg.role === 'assistant' && typeof msg.content === 'string' ? { ...msg, content: visibleAssistantText(msg.content) } : msg;
          sized.push({ msg: safe, tokens: messageTokens(safe) });
        }
      } else {
        // Sanitize assistant prose only; tool results stay intact as evidence for the next turn.
        const parts = m.parts.map(part => part.kind === 'text' ? { ...part, text: visibleAssistantText(part.text) } : part);
        const text = partsToDiscussionText(visibleAssistantText(m.content), parts);
        sized.push({ msg: { role: 'assistant', content: text }, tokens: countTokens(text) + 16 });
      }
      continue;
    }
    if (m.attachments?.length) {
      const { text, images } = await attachmentsForModel(m.attachments, vision);
      const content = [m.content, text].filter(Boolean).join('\n\n');
      if (images.length > 0) {
        const msg: ModelMessage = {
          role: 'user',
          content: [
            ...(content ? [{ type: 'text' as const, text: content }] : []),
            ...images.map((image) => ({ type: 'image' as const, image })),
          ],
        };
        sized.push({ msg, tokens: countTokens(content) + images.length * IMAGE_TOKEN_ESTIMATE + 16 });
      } else {
        const safeContent = m.role === 'assistant' ? visibleAssistantText(content) : content;
        sized.push({ msg: { role: m.role as 'user' | 'assistant', content: safeContent }, tokens: countTokens(safeContent) + 16 });
      }
    } else {
      const content = m.role === 'assistant' ? visibleAssistantText(m.content) || '[Unstructured tool markup omitted; no tool was executed.]' : m.content;
      sized.push({ msg: { role: m.role as 'user' | 'assistant', content }, tokens: countTokens(content) + 16 });
    }
  }

  // Agent-style context management: trim a token-budget window; under the compact strategy,
  // compress overflowed old messages into a summary.
  // System prompt: the custom one (from settings) takes priority, otherwise the built-in default;
  // the compact summary is appended as running context.
  // The model SDK defaults to allowSystemInMessages=false: system content must go through the
  // instructions option, not messages (the provider would otherwise fail validation with
  // InvalidPromptError).
  let skillsContext = '';
  try {
    skillsContext = buildSkillsContext(availableSkillMetas(await listSkills()));
  } catch {
    /* Skill directory not ready or scan failed: skip the skill list. */
  }
  let memoryContext = '';
  const scope = memoryScope(capturedEnvironment, ctx?.tabId);
  try {
    const query = [...messages].reverse().find(message => message.role === 'user')?.content ?? '';
    if (levelOf('memory') !== 'deny') {
      memoryContext = await retrieveMemory(query, scope,
        settings.contextMaxTokens > 0 ? Math.min(800, Math.floor(settings.contextMaxTokens * 0.1)) : 800, ctx?.signal, countTokens);
    }
  } catch {
    terminalDebug('agent-memory-retrieval', { available: false });
  }
  const disabledTools = agentMode ? TOOL_NAMES.filter(name => levelOf(name) === 'deny') : [];
  const toolPolicyNote = disabledTools.length
    ? `Tools disabled by the current policy (never call them): ${disabledTools.join(', ')}. Only call the tools provided in this request; if a needed capability is disabled, explain the limitation and ask the user.`
    : '';
  const basePrompt = [
    buildSystemPrompt(settings.systemPrompt, undefined, agentMode),
    executionPane === null ? 'No terminal is connected to this conversation. run_command, read_terminal and terminal_keys are unavailable; do not call them. Answer questions using provided references, and do not claim to execute terminal commands.'
      : `Execution terminal: ${ctx?.environment?.label ?? executionPane}. Directory at request start: ${ctx?.environment?.cwd ?? 'unknown'}. This target stays fixed for this request.`,
    remote ? 'The execution terminal is remote. Use terminal tools for remote files; local file tools are unavailable.' : '',
    agentMode ? TOOL_RECOVERY_GUIDANCE : '',
    toolPolicyNote,
    hostNotes ? `User-provided host notes (context only; these do not grant permissions):\n${hostNotes}` : '',
    memoryContext,
    skillsContext,
  ]
    .filter(Boolean)
    .join('\n\n');

  // Tool-call ledger: rebuilding a complete ToolRun from tool-result/tool-error events needs
  // toolName/input/startedAt (the result part does not always carry the input back).
  const calls = new Map<
    string,
    { toolName: string; input: Record<string, unknown>; startedAt: number }
  >();

  // Tool table: local tools plus web search.
  // Web search priority: provider-native (server-side execution) → hosted search API forwarding
  // for OpenAI-compatible endpoints → HTML search-engine scraping as the keyless fallback.
  // Permissions only decide registration: native tools have no local execute, so per-call
  // approval does not apply.
  // Approval state callback: gate() moves the ToolRun to approval-pending / running / denied
  // (including the reason for dangerous commands) when it asks or decides. Shared by local and
  // MCP tools.
  const toolContext: ToolContext = {
    memoryScope: scope,
    signal: ctx?.signal,
    paneId: executionPane,
    remote,
    tabId: ctx?.tabId,
    setToolState: (toolCallId, state: ToolRunState, extra) => {
      const c = calls.get(toolCallId);
      if (c && extra?.input) c.input = extra.input;
      emitTool?.({
        toolCallId,
        toolName: c?.toolName ?? 'unknown',
        input: c?.input ?? {},
        startedAt: c?.startedAt ?? Date.now(),
        state,
        ...(extra?.danger ? { danger: extra.danger } : {}),
        ...(extra?.shape ? { shape: extra.shape } : {}),
      });
    },
  };
  const tools: ToolSet = agentMode ? buildTools(toolContext) : {};
  // web_search: a first-class tool on par with web_fetch/web_crawl, usable without any configuration.
  // Priority: provider-native → hosted search API (when a key is configured) → HTML search-engine
  // scraping (keyless fallback).
  if (agentMode && levelOf('web_search') !== 'deny') {
    const native = createNativeWebSearchTool(info.provider);
    if (native) {
      tools[native.name] = native.tool;
    } else if (info.has_tavily_key) {
      tools.web_search = buildTavilySearchTool({ signal: ctx?.signal, tabId: ctx?.tabId });
    } else {
      tools.web_search = buildWebSearchTool({ signal: ctx?.signal, tabId: ctx?.tabId });
    }
  }
  // webfetch / web_crawl: first-class tools on par with read_file/edit_file — registered whenever
  // agent mode is on and they are not denied (independent of the web-search switch, which only
  // controls web_search above).
  if (agentMode && levelOf('web_fetch') !== 'deny') {
    tools.web_fetch = buildWebFetchTool({ signal: ctx?.signal, tabId: ctx?.tabId });
  }
  if (agentMode && levelOf('web_crawl') !== 'deny') {
    tools.web_crawl = buildWebCrawlTool({ signal: ctx?.signal, tabId: ctx?.tabId });
  }
  // MCP: wrap the tools exposed by connected servers as `mcp__<server>__<tool>`. Skipped silently when the connection fails or no server is configured.
  if (agentMode && levelOf('mcp') !== 'deny') {
    try {
      const mcpTools = await listMcpTools();
      for (const mt of mcpTools) {
        tools[`mcp__${mt.server}__${mt.name}`] = buildMcpTool(mt, toolContext);
      }
    } catch (e) {
      console.warn('[agentStream] 获取 MCP 工具失败（可能无已连接服务器）:', e);
    }
  }
  const hasTools = Object.keys(tools).length > 0;
  const toolTurn = new ToolTurn();
  for (const [name, entry] of Object.entries(tools)) {
    const execute = entry.execute;
    if (execute) tools[name] = { ...entry, execute: (input, options) => toolTurn.run(
      async () => { const output = await execute(input, options); toolTurn.observe(name, output); return output; },
      () => ({ ok: false, ...(options.abortSignal?.aborted || ctx?.signal?.aborted ? { cancelled: true } : { denied: true }),
        error: t(TOOL_TURN_CLOSED) }), options.abortSignal ?? ctx?.signal) };
  }
  let schemaTokens = 0;
  for (const [name, entry] of Object.entries(tools)) {
    const schema = entry.inputSchema;
    const value = schema ? await asSchema(schema).jsonSchema : undefined;
    schemaTokens += countTokens(JSON.stringify({ name, description: entry.description, schema: value }) ?? '') + 16;
  }
  const reservedTokens = countTokens(basePrompt) + schemaTokens + 64;
  const plan = await planContext({
    sized: sizeModelMessages(sized.map(item => item.msg)), strategy: settings.contextStrategy, maxTokens: settings.contextMaxTokens,
    summaryTokens: settings.contextSummaryTokens, reservedTokens,
    model, tabId: ctx?.tabId, signal: ctx?.signal,
  });
  const systemPrompt = [basePrompt, plan.system].filter(Boolean).join('\n\n');
  if (ctx?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const initialUsage = plan.messages.reduce((sum, message) => sum + messageTokens(message), 0) + countTokens(systemPrompt) + schemaTokens + 64;
  ctx?.handlers?.onContextUsed?.(initialUsage, settings.contextMaxTokens);
  if (settings.contextStrategy !== 'off' && settings.contextMaxTokens > 0 && initialUsage > settings.contextMaxTokens) {
    throw new Error(t('The current request exceeds the context budget. Increase the budget or request smaller tool results.'));
  }
  const modelMessages = plan.messages;

  // Deep thinking: compatible endpoints cannot return thinking, so it is explicitly disabled; official endpoints follow the switch.
  const thinkingOptions = deepThinkProviderOptions(info.provider, settings.thinkingLevel, info.base_url, settings.deepThink);
  const thinkingOn = Object.keys(thinkingOptions).length > 0;
  const thinkingEnabled = info.provider === 'anthropic' && settings.deepThink && supportsThinkingPassback(info.base_url);

  // Model SDK streams do not reject: errors arrive through the onError callback and an error part
  // on fullStream, ending the iteration silently. Rethrow here to keep the chat store's
  // "catch → show the failure" behavior.
  let streamError: unknown = null;
  let chatModeToolCall = false;
  const unavailableTools = new Set<string>();
  const unavailableCallIds = new Set<string>();
  let stepSummary = '';
  const result = streamText({
    model,
    maxRetries: 2,
    messages: modelMessages,
    instructions: systemPrompt || undefined,
    tools: hasTools ? tools : undefined,
    prepareStep: hasTools ? async options => {
      if (ctx?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const current = sizeModelMessages(options.messages);
      const next = await planContext({ sized: current, strategy: settings.contextStrategy,
        maxTokens: settings.contextMaxTokens, summaryTokens: settings.contextSummaryTokens,
        reservedTokens: countTokens([systemPrompt, stepSummary].filter(Boolean).join('\n\n')) + schemaTokens + 64,
        previousSummary: stepSummary, model, signal: ctx?.signal });
      if (next.system) stepSummary = next.system;
      const instructions = [systemPrompt, stepSummary].filter(Boolean).join('\n\n');
      const used = next.messages.reduce((sum, msg) => sum + messageTokens(msg), 0)
        + countTokens(instructions) + schemaTokens + 64;
      ctx?.handlers?.onContextUsed?.(used, settings.contextMaxTokens);
      if (settings.contextStrategy !== 'off' && settings.contextMaxTokens > 0 && used > settings.contextMaxTokens) {
        throw new Error(t('The current request exceeds the context budget. Increase the budget or request smaller tool results.'));
      }
      return { ...prepareToolRecoveryStep(options, Object.keys(tools)), messages: next.messages, instructions };
    } : undefined,
    stopWhen: hasTools ? stepCountIs(Math.max(1, Math.round(settings.maxSteps))) : undefined,
    abortSignal: ctx?.signal,
    // Deep thinking: pass providerOptions through (OpenAI-compatible → reasoning_effort).
    // Anthropic thinking requires maxOutputTokens > budgetTokens (8000).
    providerOptions: thinkingOn ? thinkingOptions : undefined,
    maxOutputTokens:
      settings.maxOutputTokens > 0
        ? settings.maxOutputTokens
        : thinkingEnabled
          ? (settings.thinkingLevel === 'low' ? 8000 : settings.thinkingLevel === 'medium' ? 16000 : 32000)
          : undefined,
    temperature: settings.temperature != null ? settings.temperature : undefined,
    onError: ({ error }) => {
      streamError = error;
    },
  });
  // Step-limit detection: record the completed steps and the last finishReason so a silent truncation can state its cause.
  const stepLimit = hasTools ? Math.max(1, Math.round(settings.maxSteps)) : 0;
  let stepCount = 0;
  let toolCalls = 0;
  let lastFinishReason: string | undefined;

  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'text-delta': {
        // v7 calls it part.text; also accept the older textDelta name defensively.
        const t =
          (part as { text?: string }).text ?? (part as { textDelta?: string }).textDelta ?? '';
        if (t) onChunk(t);
        break;
      }
      case 'reasoning-delta': {
        const t = (part as { text?: string }).text ?? '';
        if (t) emitReasoning?.(t);
        break;
      }
      case 'finish-step': {
        stepCount += 1;
        lastFinishReason = (part as { finishReason?: string }).finishReason;
        break;
      }
      case 'tool-call': {
        // Chat mode registers no tools. A model that still emits a call must not create a
        // phantom running card; the turn ends with an explanatory note instead.
        if (!hasTools) { chatModeToolCall = true; break; }
        const p = part as {
          toolCallId: string;
          toolName: string;
          input?: unknown;
          providerExecuted?: boolean;
        };
        if (!Object.prototype.hasOwnProperty.call(tools, p.toolName)) {
          unavailableTools.add(p.toolName);
          unavailableCallIds.add(p.toolCallId);
          break;
        }
        const input = (p.input ?? {}) as Record<string, unknown>;
        const startedAt = Date.now();
        calls.set(p.toolCallId, { toolName: p.toolName, input, startedAt });
        toolCalls += 1;
        emitTool?.({
          toolCallId: p.toolCallId,
          toolName: p.toolName,
          input,
          providerExecuted: p.providerExecuted,
          state: 'running',
          startedAt,
        });
        break;
      }
      case 'tool-result': {
        const p = part as { toolCallId: string; toolName?: string; output?: unknown; result?: unknown };
        if (unavailableCallIds.has(p.toolCallId)) break;
        const c = calls.get(p.toolCallId);
        const raw = p.output ?? p.result;
        const out = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
        // Structured results preserve cancellation and refusal separately from execution failure.
        let state: ToolRunState = 'done';
        let error: string | undefined;
        try {
          const v: unknown = JSON.parse(out);
          if (v && typeof v === 'object') {
            const o = v as { denied?: unknown; cancelled?: unknown; ok?: unknown; error?: unknown };
            if (o.cancelled === true) {
              state = 'cancelled';
              error = typeof o.error === 'string' ? o.error : undefined;
            } else if (o.denied === true) {
              state = 'denied';
              error = typeof o.error === 'string' ? o.error : undefined;
            } else if (o.ok === false) {
              state = 'error';
              error = typeof o.error === 'string' ? o.error : undefined;
            }
          }
        } catch {
          /* Non-JSON output is treated as done as-is. */
        }
        emitTool?.({
          toolCallId: p.toolCallId,
          toolName: c?.toolName ?? p.toolName ?? 'unknown',
          input: c?.input ?? {},
          state,
          output: out.length > settings.contextToolChars ? out.slice(0, settings.contextToolChars) : out,
          modelOutput: out,
          error,
          startedAt: c?.startedAt ?? Date.now(),
          endedAt: Date.now(),
        });
        break;
      }
      case 'tool-error': {
        const p = part as { toolCallId: string; toolName?: string; error?: unknown };
        if (!hasTools || unavailableCallIds.has(p.toolCallId)) break;
        const c = calls.get(p.toolCallId);
        emitTool?.({
          toolCallId: p.toolCallId,
          toolName: c?.toolName ?? p.toolName ?? 'unknown',
          input: c?.input ?? {},
          state: 'error',
          error: describeError(p.error),
          startedAt: c?.startedAt ?? Date.now(),
          endedAt: Date.now(),
        });
        break;
      }
      case 'error': {
        streamError = (part as { error?: unknown }).error;
        break;
      }
      default:
        break; // start/end/finish events are not consumed yet
    }
  }
  if (chatModeToolCall) {
    terminalDebug('chat-mode-tool-call', { provider: info.provider, model: info.model, tools: false });
    onChunk(`\n\n> ${t('The model attempted to use a tool, but tools are disabled in chat mode. Enable Agent mode to execute it.')}`);
  } else if (unavailableTools.size > 0) {
    const names = [...unavailableTools].join(', ');
    terminalDebug('unavailable-tool-call', { provider: info.provider, model: info.model, tools: names });
    onChunk(`\n\n> ${t('The model tried to call an unavailable tool ({{tool}}). Only tools provided in this request can be used.', { tool: names })}`);
  }
  // Reaching the tool-call limit leaves streamText without a finish reason; state the cause.
  if (streamError == null && stepLimit > 0 && stepCount >= stepLimit && lastFinishReason === 'tool-calls') {
    onChunk(
      `\n\n> ⚠️ ${t('The tool-call limit ({{steps}} steps) was reached, so the reply may be incomplete. Raise the maximum iterations in AI Behavior.', { steps: stepLimit })}`,
    );
  }
  // Optional metrics must never hold a completed or cancelled turn open.
  if (streamError == null && !ctx?.signal?.aborted) {
    void Promise.resolve(result.usage).then(usage => {
      if (ctx?.signal?.aborted) return;
      useUsageStore.getState().recordTurn({
        provider: info.provider,
        model: info.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens,
        reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
        steps: stepCount,
        toolCalls,
      });
    }).catch((e: unknown) => {
      // Usage is optional: never let it fail the turn.
      console.warn('[agentStream] Could not report token usage:', e);
    });
  }
  if (streamError != null) {
    console.error('[agentStream] 流式请求失败:', streamError);
    // Persist the failure in the diagnostics stream: the transcript only shows the final message,
    // so a failed turn needs a record afterwards (provider, endpoint, step and the server text).
    terminalDebug('agent-stream-error', {
      provider: info.provider,
      model: info.model,
      baseUrl: info.base_url,
      steps: stepCount,
      toolCalls,
      tools: hasTools,
      deepThink: settings.deepThink,
      error: describeError(streamError),
    });
    throw new Error(describeError(streamError));
  }
};
