import { Type } from 'typebox';
import {
  createInitialSystemMessage,
  normalizeContext,
  type Api,
  type AssistantMessage,
  type Model,
  type ModelThinkingLevel,
  type SimpleStreamOptions,
  type TextContent,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { environmentCredential, type CredentialReader } from './credentials.js';
import { mergeConsecutiveUserMessages } from './context.js';
import {
  addsToolsInPlace,
  createModelBackend,
  filterCompatForApi,
  resolveModelWithInfo,
  type ModelConfig,
} from './model.js';

/** Valid 2x2 solid red PNG (96 bytes) for verifying base64 vision input. */
const RED_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWO4Iyd3R06OAUIBACGmBGH6Pla+AAAAAElFTkSuQmCC';

export interface ProbeCheckResult {
  status: 'pass' | 'fail' | 'skip';
  ms: number;
  detail?: string;
  error?: string;
}

export interface ProbeReport {
  ok: boolean;
  provider: string;
  id: string;
  api: string;
  inheritedFrom?: string;
  supportedThinkingLevels: ModelThinkingLevel[];
  effectiveThinkingLevel: ModelThinkingLevel;
  checks: {
    basic: ProbeCheckResult;
    compactionOff: ProbeCheckResult;
    consecutiveUsers: ProbeCheckResult;
    vision: ProbeCheckResult;
    tools: ProbeCheckResult;
    strictTools: ProbeCheckResult;
    midConvoTools: ProbeCheckResult;
  };
  suggestedCompat: Record<string, unknown>;
  suggestedOptions: Partial<Pick<ModelConfig, 'mergeConsecutiveUsers' | 'deferredTools'>>;
  notes: string[];
}

export interface ProbeOptions {
  credential?: CredentialReader;
  requireVision?: boolean;
  timeoutMs?: number;
  checkMidConvoTools?: boolean;
  fetch?: typeof globalThis.fetch;
}

function replyText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim();
}

function diagnoseOpenAICompat(errorMessage: string): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (/developer|invalid[_ ]role|role.*must be|not one of.*system/i.test(errorMessage)) {
    patch.supportsDeveloperRole = false;
  }
  if (/max_completion_tokens/i.test(errorMessage)) {
    patch.maxTokensField = 'max_tokens';
  }
  if (/\bstore\b/i.test(errorMessage) && /unknown|unsupported|unexpected|unrecognized|extra|invalid/i.test(errorMessage)) {
    patch.supportsStore = false;
  }
  if (/stream_options|include_usage/i.test(errorMessage)) {
    patch.supportsUsageInStreaming = false;
  }
  if (/reasoning_effort/i.test(errorMessage)) {
    patch.supportsReasoningEffort = false;
  }
  if (/reasoning_content/i.test(errorMessage)) {
    patch.requiresReasoningContentOnAssistantMessages = true;
  }
  if (/\bname\b.*tool|tool.*missing.*name/i.test(errorMessage)) {
    patch.requiresToolResultName = true;
  }
  if (/assistant.*after.*tool|tool.*must.*assistant|alternat/i.test(errorMessage)) {
    patch.requiresAssistantAfterToolResult = true;
  }
  return patch;
}

function midConvoFlagsForApi(api: string): Record<string, boolean> | undefined {
  if (api === 'anthropic-messages') return { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true };
  if (api === 'openai-responses') return { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true };
  if (api === 'openai-completions') return { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true };
  return undefined;
}

/**
 * Probe a model/gateway configuration against real capabilities (connectivity, reasoning-off compaction,
 * consecutive user turns, vision, multi-turn tool replay, strict JSON schema tools, and optional
 * mid-conversation tool additions) and report actionable `compat` suggestions.
 */
export async function probeModel(config: ModelConfig, options: ProbeOptions = {}): Promise<ProbeReport> {
  const credential = options.credential ?? environmentCredential;
  const requireVision = options.requireVision ?? true;
  const timeoutMs = options.timeoutMs ?? 45_000;
  const resolvedInfo = resolveModelWithInfo(config, { requireVision });
  const suggestedCompat: Record<string, unknown> = {};
  const suggestedOptions: ProbeReport['suggestedOptions'] = {};
  const notes: string[] = [];

  const withCompat = (extra?: Record<string, unknown>): ModelConfig => {
    const merged = filterCompatForApi(resolvedInfo.model.api, {
      ...(config.compat as Record<string, unknown> | undefined),
      ...suggestedCompat,
      ...(extra ?? {}),
    });
    return {
      ...config,
      ...(merged ? { compat: merged as ModelConfig['compat'] } : {}),
    };
  };

  const callOnce = async (
    effectiveConfig: ModelConfig,
    context: TranscriptContext,
    callOpts: Partial<SimpleStreamOptions> = {},
  ): Promise<{ reply: AssistantMessage; model: Model<Api>; ms: number }> => {
    const { model, stream } = createModelBackend(effectiveConfig, credential, { requireVision });
    const started = Date.now();
    const reply = await stream(model, context, {
      maxRetries: 0,
      cacheRetention: 'none',
      fetch: options.fetch,
      signal: AbortSignal.timeout(timeoutMs),
      ...callOpts,
    }).result();
    return { reply, model, ms: Date.now() - started };
  };

  const skipped = (detail: string): ProbeCheckResult => ({ status: 'skip', ms: 0, detail });
  const checks: ProbeReport['checks'] = {
    basic: skipped('Not run'),
    compactionOff: skipped('Non-reasoning model'),
    consecutiveUsers: skipped('Skipped after basic failure'),
    vision: skipped('Text-only model'),
    tools: skipped('Skipped after basic failure'),
    strictTools: skipped('Not applicable for this API'),
    midConvoTools: skipped('Skipped'),
  };

  const configuredReasoning = config.thinkingLevel && config.thinkingLevel !== 'off' ? config.thinkingLevel : undefined;
  const basicMaxTokens = Math.min(configuredReasoning || resolvedInfo.effectiveThinkingLevel !== 'off' ? 2048 : 256, resolvedInfo.model.maxTokens);

  // 1. Basic connectivity + automatic OpenAI-completions compat diagnostics.
  const basicContext = normalizeContext({
    systemPrompt: 'This is a capability probe. Reply concisely with OK.',
    messages: [{ role: 'user', content: 'ping', timestamp: Date.now() }],
  });
  let basicOk = false;
  try {
    let { reply, ms } = await callOnce(withCompat(), basicContext, { maxTokens: basicMaxTokens, reasoning: configuredReasoning });
    if ((reply.stopReason === 'error' || reply.stopReason === 'aborted') && resolvedInfo.model.api === 'openai-completions' && reply.errorMessage) {
      const accumulated: Record<string, unknown> = {};
      for (let attempt = 0; attempt < 3 && (reply.stopReason === 'error' || reply.stopReason === 'aborted') && reply.errorMessage; attempt++) {
        const patch = diagnoseOpenAICompat(reply.errorMessage);
        const novel = Object.entries(patch).filter(([key, value]) => accumulated[key] !== value);
        if (!novel.length) break;
        Object.assign(accumulated, Object.fromEntries(novel));
        const retry = await callOnce(withCompat(accumulated), basicContext, { maxTokens: basicMaxTokens, reasoning: configuredReasoning });
        reply = retry.reply;
        ms = retry.ms;
      }
      if (reply.stopReason !== 'error' && reply.stopReason !== 'aborted' && Object.keys(accumulated).length) {
        Object.assign(suggestedCompat, accumulated);
        notes.push(`Initial request failed; verified working with compat ${JSON.stringify(accumulated)}.`);
      }
    }
    if (reply.stopReason === 'error' || reply.stopReason === 'aborted') {
      checks.basic = { status: 'fail', ms, error: reply.errorMessage ?? `Stopped with ${reply.stopReason}` };
    } else {
      basicOk = true;
      const text = replyText(reply);
      checks.basic = { status: 'pass', ms, detail: text ? `Replied: ${text.slice(0, 80)}` : `stopReason=${reply.stopReason}` };
      if (reply.usage.input === 0 && reply.usage.output === 0) {
        notes.push('Gateway did not report token usage on streaming responses; context budgeting will rely on local estimates.');
      }
    }
  } catch (error) {
    checks.basic = { status: 'fail', ms: 0, error: error instanceof Error ? error.message : String(error) };
  }

  if (!basicOk) {
    return {
      ok: false,
      provider: resolvedInfo.model.provider,
      id: resolvedInfo.model.id,
      api: resolvedInfo.model.api,
      ...(resolvedInfo.inheritedFrom ? { inheritedFrom: resolvedInfo.inheritedFrom } : {}),
      supportedThinkingLevels: resolvedInfo.supportedThinkingLevels,
      effectiveThinkingLevel: resolvedInfo.effectiveThinkingLevel,
      checks,
      suggestedCompat,
      suggestedOptions,
      notes,
    };
  }

  // 2. Compaction with reasoning off (tests thinkingLevelMap / thinkingBudget clamping).
  if (resolvedInfo.model.reasoning) {
    try {
      const compactionMax = Math.min(resolvedInfo.model.thinkingLevelMap?.off === null ? 2048 : 512, resolvedInfo.model.maxTokens);
      const { reply, ms } = await callOnce(withCompat(), basicContext, { maxTokens: compactionMax, reasoning: undefined });
      if (reply.stopReason === 'error' || reply.stopReason === 'aborted') {
        checks.compactionOff = { status: 'fail', ms, error: reply.errorMessage ?? `Stopped with ${reply.stopReason}` };
        notes.push('Compaction with thinkingLevel="off" failed; consider configuring model.thinkingLevelMap or an independent compaction.model.');
      } else {
        checks.compactionOff = { status: 'pass', ms, detail: `stopReason=${reply.stopReason}` };
      }
    } catch (error) {
      checks.compactionOff = { status: 'fail', ms: 0, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // 3. Consecutive user messages (verifies whether strict role alternation requires mergeConsecutiveUsers).
  {
    const now = Date.now();
    const unmerged = normalizeContext({
      systemPrompt: 'Reply with only the number.',
      messages: [
        { role: 'user', content: 'Remember code 42.', timestamp: now },
        { role: 'user', content: 'What is the code? Reply with just 42.', timestamp: now + 1 },
      ],
    });
    try {
      const { reply, ms } = await callOnce(withCompat(), unmerged, { maxTokens: basicMaxTokens, reasoning: configuredReasoning });
      if (reply.stopReason !== 'error' && reply.stopReason !== 'aborted') {
        checks.consecutiveUsers = { status: 'pass', ms, detail: 'Accepts consecutive user turns directly' };
      } else {
        const merged = normalizeContext({ messages: mergeConsecutiveUserMessages(unmerged.messages) });
        const retry = await callOnce(withCompat(), merged, { maxTokens: basicMaxTokens, reasoning: configuredReasoning });
        if (retry.reply.stopReason !== 'error' && retry.reply.stopReason !== 'aborted') {
          suggestedOptions.mergeConsecutiveUsers = true;
          checks.consecutiveUsers = {
            status: 'fail',
            ms: retry.ms,
            error: reply.errorMessage ?? `Stopped with ${reply.stopReason}`,
            detail: 'Verified fixed when mergeConsecutiveUsers is enabled',
          };
          notes.push('Endpoint rejected consecutive user messages; set model.mergeConsecutiveUsers: true.');
        } else {
          checks.consecutiveUsers = { status: 'fail', ms, error: reply.errorMessage ?? `Stopped with ${reply.stopReason}` };
        }
      }
    } catch (error) {
      checks.consecutiveUsers = { status: 'fail', ms: 0, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // 4. Vision input (tiny valid PNG).
  if (resolvedInfo.model.input.includes('image')) {
    const visionContext = normalizeContext({
      systemPrompt: 'Describe the solid color of the image in one word.',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What color is this image?' },
          { type: 'image', data: RED_PNG_BASE64, mimeType: 'image/png' },
        ],
        timestamp: Date.now(),
      }],
    });
    try {
      const { reply, ms } = await callOnce(withCompat(), visionContext, { maxTokens: basicMaxTokens, reasoning: configuredReasoning });
      if (reply.stopReason === 'error' || reply.stopReason === 'aborted') {
        checks.vision = { status: 'fail', ms, error: reply.errorMessage ?? `Stopped with ${reply.stopReason}` };
      } else {
        checks.vision = { status: 'pass', ms, detail: replyText(reply).slice(0, 80) || `stopReason=${reply.stopReason}` };
      }
    } catch (error) {
      checks.vision = { status: 'fail', ms: 0, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // 5. Multi-turn tool call + toolResult replay.
  {
    const echoTool: Tool = {
      name: 'probe_echo',
      description: 'Echoes a short word back to the caller.',
      parameters: Type.Object({ word: Type.String({ description: 'Word to echo' }) }),
    };
    const turn1Context = normalizeContext({
      systemPrompt: 'You must call probe_echo when asked.',
      tools: [echoTool],
      messages: [{ role: 'user', content: 'Call probe_echo with word="ok". Do not answer without calling the tool.', timestamp: Date.now() }],
    });
    try {
      const first = await callOnce(withCompat(), turn1Context, { maxTokens: basicMaxTokens, reasoning: configuredReasoning });
      if (first.reply.stopReason === 'error' || first.reply.stopReason === 'aborted') {
        checks.tools = { status: 'fail', ms: first.ms, error: first.reply.errorMessage ?? `Stopped with ${first.reply.stopReason}` };
      } else {
        const calls = first.reply.content.filter((block): block is ToolCall => block.type === 'toolCall');
        if (!calls.length) {
          checks.tools = { status: 'fail', ms: first.ms, error: `Model replied without calling probe_echo: "${replyText(first.reply).slice(0, 80)}"` };
        } else {
          const results: ToolResultMessage[] = calls.map(toolCall => ({
            role: 'toolResult',
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: [{ type: 'text', text: JSON.stringify({ echoed: toolCall.arguments?.word ?? 'ok' }) }],
            isError: false,
            timestamp: Date.now(),
          }));
          const turn2Context = normalizeContext({
            messages: [...turn1Context.messages, first.reply, ...results, { role: 'user', content: 'Now reply with DONE.', timestamp: Date.now() }],
          });
          let second = await callOnce(withCompat(), turn2Context, { maxTokens: basicMaxTokens, reasoning: configuredReasoning });
          if ((second.reply.stopReason === 'error' || second.reply.stopReason === 'aborted') && resolvedInfo.model.api === 'openai-completions' && second.reply.errorMessage) {
            const patch = diagnoseOpenAICompat(second.reply.errorMessage);
            if (Object.keys(patch).length) {
              const retry = await callOnce(withCompat(patch), turn2Context, { maxTokens: basicMaxTokens, reasoning: configuredReasoning });
              if (retry.reply.stopReason !== 'error' && retry.reply.stopReason !== 'aborted') {
                Object.assign(suggestedCompat, patch);
                second = retry;
                notes.push(`Tool replay needed compat ${JSON.stringify(patch)} (verified).`);
              }
            }
          }
          if (second.reply.stopReason === 'error' || second.reply.stopReason === 'aborted') {
            checks.tools = { status: 'fail', ms: first.ms + second.ms, error: `Tool result replay failed: ${second.reply.errorMessage ?? second.reply.stopReason}` };
          } else {
            checks.tools = { status: 'pass', ms: first.ms + second.ms, detail: `Called ${calls[0]!.name} and completed replay (${replyText(second.reply).slice(0, 60) || second.reply.stopReason})` };
          }
        }
      }
    } catch (error) {
      checks.tools = { status: 'fail', ms: 0, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // 6. Constrained / strict tool schema support (mirrors `remember` with strict: 'prefer').
  if (['openai-completions', 'openai-responses', 'anthropic-messages'].includes(resolvedInfo.model.api)) {
    const strictTool: Tool = {
      name: 'probe_strict',
      description: 'Store a short note.',
      parameters: Type.Object({
        kind: Type.Union([Type.Literal('note'), Type.Literal('fact')]),
        content: Type.String({ minLength: 1 }),
        tags: Type.Optional(Type.Array(Type.String())),
      }),
      constrainedSampling: { type: 'json_schema', strict: 'prefer' },
    };
    const strictContext = normalizeContext({
      systemPrompt: 'Reply with OK without calling any tool.',
      tools: [strictTool],
      messages: [{ role: 'user', content: 'Say OK.', timestamp: Date.now() }],
    });
    const flag = resolvedInfo.model.api === 'anthropic-messages' ? 'supportsStrictTools' : 'supportsStrictMode';
    const currentCompat = (resolvedInfo.model.compat ?? {}) as Record<string, unknown>;
    const strictCurrentlyEnabled =
      resolvedInfo.model.api === 'openai-responses'
        ? currentCompat[flag] !== false
        : currentCompat[flag] === true;
    try {
      const { reply, ms } = await callOnce(withCompat({ [flag]: true }), strictContext, { maxTokens: basicMaxTokens, reasoning: configuredReasoning });
      if (reply.stopReason !== 'error' && reply.stopReason !== 'aborted') {
        checks.strictTools = { status: 'pass', ms, detail: 'Accepts strict JSON schema tool declarations' };
      } else if (strictCurrentlyEnabled) {
        const retry = await callOnce(withCompat({ [flag]: false }), strictContext, { maxTokens: basicMaxTokens, reasoning: configuredReasoning });
        if (retry.reply.stopReason !== 'error' && retry.reply.stopReason !== 'aborted') {
          suggestedCompat[flag] = false;
          checks.strictTools = {
            status: 'fail',
            ms: retry.ms,
            error: reply.errorMessage ?? `Stopped with ${reply.stopReason}`,
            detail: `Verified fixed with compat.${flag} = false`,
          };
          notes.push(`Gateway rejected strict tool schemas; set model.compat.${flag}: false.`);
        } else {
          checks.strictTools = { status: 'fail', ms, error: reply.errorMessage ?? `Stopped with ${reply.stopReason}` };
        }
      } else {
        checks.strictTools = {
          status: 'fail',
          ms,
          error: reply.errorMessage ?? `Stopped with ${reply.stopReason}`,
          detail: `Strict tool schemas unsupported (safe: compat.${flag} is off by default for this API)`,
        };
      }
    } catch (error) {
      checks.strictTools = { status: 'fail', ms: 0, error: error instanceof Error ? error.message : String(error) };
    }
  }

  // 7. Mid-conversation tool additions (detects gateways that accept vs silently strip mid-convo tools).
  const midFlags = midConvoFlagsForApi(resolvedInfo.model.api);
  if (midFlags && options.checkMidConvoTools !== false) {
    const baseTool: Tool = { name: 'probe_base', description: 'Initial tool.', parameters: Type.Object({}) };
    const secretTool: Tool = { name: 'probe_secret_tool_xyz', description: 'Dynamically added tool.', parameters: Type.Object({ value: Type.String() }) };
    const now = Date.now();
    const midContext = normalizeContext({
      messages: [
        createInitialSystemMessage('When asked which new tool became available, reply with its exact tool name only.', [baseTool])!,
        { role: 'user', content: 'Wait for a new tool.', timestamp: now },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Ready.' }],
          api: resolvedInfo.model.api,
          provider: resolvedInfo.model.provider,
          model: resolvedInfo.model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop',
          timestamp: now + 1,
        },
        { role: 'system', content: '', toolsAdded: [secretTool], timestamp: now + 2 },
        { role: 'user', content: 'What is the exact name of the newly added tool? Reply with its name.', timestamp: now + 3 },
      ],
    });
    try {
      const { reply, ms } = await callOnce(withCompat(midFlags), midContext, { maxTokens: basicMaxTokens, reasoning: configuredReasoning });
      const text = replyText(reply);
      const calledSecret = reply.content.some(block => block.type === 'toolCall' && block.name === 'probe_secret_tool_xyz');
      const sawSecret = reply.stopReason !== 'error' && reply.stopReason !== 'aborted' && (text.includes('probe_secret_tool_xyz') || calledSecret);
      if (sawSecret) {
        checks.midConvoTools = { status: 'pass', ms, detail: 'Gateway preserves mid-conversation tool additions' };
        if (!addsToolsInPlace(resolvedInfo.model)) {
          Object.assign(suggestedCompat, midFlags);
          notes.push('Gateway supports in-place mid-conversation tool additions; enabling these compat flags preserves prompt cache when find_tools loads a deferred tool.');
        }
      } else {
        const reason = reply.stopReason === 'error' || reply.stopReason === 'aborted'
          ? (reply.errorMessage ?? `Stopped with ${reply.stopReason}`)
          : `Model did not see dynamically added tool (replied: "${text.slice(0, 80)}")`;
        checks.midConvoTools = { status: 'fail', ms, error: reason, detail: 'Top-level deferred tool loading still works safely' };
        if (addsToolsInPlace(resolvedInfo.model)) {
          for (const key of Object.keys(midFlags)) suggestedCompat[key] = false;
          notes.push('Gateway rejected or stripped mid-conversation tool additions; disable mid-conversation tool flags in compat so deferred tools update top-level declarations.');
        }
      }
    } catch (error) {
      checks.midConvoTools = { status: 'fail', ms: 0, error: error instanceof Error ? error.message : String(error) };
    }
  } else if (!midFlags) {
    checks.midConvoTools = skipped('Protocol uses top-level tool declarations (or Interactions API)');
  }

  const ok =
    checks.basic.status === 'pass' &&
    checks.tools.status === 'pass' &&
    checks.vision.status !== 'fail' &&
    checks.compactionOff.status !== 'fail';

  return {
    ok,
    provider: resolvedInfo.model.provider,
    id: resolvedInfo.model.id,
    api: resolvedInfo.model.api,
    ...(resolvedInfo.inheritedFrom ? { inheritedFrom: resolvedInfo.inheritedFrom } : {}),
    supportedThinkingLevels: resolvedInfo.supportedThinkingLevels,
    effectiveThinkingLevel: resolvedInfo.effectiveThinkingLevel,
    checks,
    suggestedCompat,
    suggestedOptions,
    notes,
  };
}
