/**
 * OpenCode / KiloCode TypeScript plugin entry point for context-mode.
 *
 * Provides five hooks (v1.0.107 — Mickey OC-1..OC-4 follow-up):
 *   - tool.execute.before  — Routing enforcement (deny/modify/passthrough)
 *   - tool.execute.after   — Session event capture + first-fire AGENTS.md scan (OC-4)
 *   - experimental.session.compacting — Compaction snapshot + budget-capped auto-injection (OC-3)
 *   - experimental.chat.system.transform — ROUTING_BLOCK + resume snapshot injection (OC-1)
 *   - chat.message         — User-prompt capture w/ CCv2 inline filter (OC-2) + AGENTS.md scan (OC-4)
 *
 * KiloCode loads this via: import("context-mode") → expects default export
 * with shape { server: (input) => Promise<Hooks> } (PluginModule).
 *
 * OpenCode loads this via: import("context-mode/plugin") → also supports
 * the named export ContextModePlugin for backward compat.
 *
 * Constraints:
 *   - No SessionStart hook (OpenCode doesn't support it — #14808, #5409)
 *   - context injection now via chat.system.transform surrogate (OC-1)
 *   - No routing file auto-write (avoid dirtying project trees)
 *   - Session cleanup happens at plugin init (no SessionStart)
 *
 * OpenCode 2 note: V1 plugin implementations (the `server()` shape above) do
 * not run under OpenCode 2 — its plugin loader only recognizes a default
 * export produced by `Plugin.define({ id, setup })` from `@opencode/plugin`.
 * The bottom of this file exports BOTH shapes from one object, per OpenCode's
 * own documented "support V1 and V2 from one package" pattern
 * (opencode.ai/v2/docs/build/plugins#support-v1): OpenCode 1.x / KiloCode call
 * `server()` and use its returned hooks; OpenCode 2 reads `id`/`setup` off the
 * same object and ignores `server()`. See `setupContextModePluginV2` below.
 */
/** KiloCode/OpenCode plugin input — both platforms pass at least `directory`. */
type PluginClientAppLogBodyExtra = {
    sessionId?: string;
    source?: string;
};
type PluginClientAppLogBody = {
    service: string;
    level: "info" | "warn" | "error" | "debug";
    message: string;
    extra?: PluginClientAppLogBodyExtra;
};
type PluginClientAppLogOptions = {
    body: PluginClientAppLogBody;
};
type PluginClientApp = {
    log: (options: PluginClientAppLogOptions) => Promise<void>;
};
type PluginClient = {
    app: PluginClientApp;
};
type PluginContext = {
    client: PluginClient;
    directory: string;
};
type NativeToolContext = {
    sessionID: string;
    messageID: string;
    agent: string;
    directory: string;
    worktree?: string;
    abort?: AbortSignal;
    metadata?: (input: {
        title?: string;
        metadata?: Record<string, unknown>;
    }) => void;
};
type NativeToolDefinition = {
    description: string;
    args: Record<string, unknown>;
    execute: (args: Record<string, unknown>, ctx: NativeToolContext) => Promise<string | {
        title?: string;
        output: string;
        metadata?: Record<string, unknown>;
    }>;
};
/** OpenCode tool.execute.before — first parameter */
interface BeforeHookInput {
    tool: string;
    sessionID: string;
    callID: string;
}
/** OpenCode tool.execute.before — second parameter */
interface BeforeHookOutput {
    args: any;
}
/** OpenCode tool.execute.after — first parameter */
interface AfterHookInput {
    tool: string;
    sessionID: string;
    callID: string;
    args: any;
}
/** OpenCode tool.execute.after — second parameter */
interface AfterHookOutput {
    title: string;
    output: string;
    metadata: any;
}
/**
 * OpenCode generic bus `event` hook — single parameter.
 * The plugin SDK delivers every bus Event here (refs/platforms/opencode/
 * packages/plugin/src/index.ts:224). We narrow to `message.updated`, whose
 * `properties.info` is the full assistant Message carrying tokens/cost/modelID.
 */
interface EventHookInput {
    event?: {
        type?: string;
        properties?: {
            info?: {
                sessionID?: string;
            } & Record<string, unknown>;
        };
    };
}
/** OpenCode experimental.session.compacting — first parameter */
interface CompactingHookInput {
    sessionID: string;
}
/** OpenCode experimental.session.compacting — second parameter */
interface CompactingHookOutput {
    context: string[];
    prompt?: string;
}
/**
 * OpenCode experimental.chat.system.transform — first parameter.
 * Verified against sst/opencode/dev/packages/plugin/src/index.ts:
 *   input: { sessionID?: string; model: Model }
 * `sessionID` is optional in the SDK type but is in practice always set
 * (the transform runs *for* a session). We treat it as required and
 * skip injection when absent rather than fall back to a fabricated ID.
 *
 * NOTE: We deliberately do NOT use `experimental.chat.messages.transform`.
 * Its SDK input shape is `{}` (no sessionID) and its output is
 * `{ messages: { info: Message; parts: Part[] }[] }` — the prior code
 * (`output.messages.unshift({ role, content })`) wrote a value of the
 * wrong shape and was silently dropped (Mickey / PR #376 root cause).
 */
interface SystemTransformHookInput {
    sessionID?: string;
    model: unknown;
}
/** OpenCode experimental.chat.system.transform — second parameter */
interface SystemTransformHookOutput {
    system: string[];
}
/**
 * OpenCode chat.message hook — verified against
 * refs/platforms/opencode/packages/plugin/src/index.ts:233.
 *   input:  { sessionID; agent?; model?; messageID?; variant? }
 *   output: { message: UserMessage; parts: Part[] }
 * We read text from `parts[*].text` (the orchestrator reference at
 * refs/plugin-examples/opencode/opencode-orchestrator/src/plugin-handlers/
 * chat-message-handler.ts:41-65 uses the same pattern).
 */
interface ChatMessageHookInput {
    sessionID: string;
    agent?: string;
    messageID?: string;
}
interface ChatMessagePart {
    type: string;
    text?: string;
}
interface ChatMessageHookOutput {
    message: unknown;
    parts: ChatMessagePart[];
}
declare const ROUTING_MARKERS: string[];
declare function systemHasRoutingInstructions(system: string[]): boolean;
/**
 * Plugin factory. Called once when KiloCode/OpenCode loads the plugin.
 * Returns an object mapping hook event names to async handler functions.
 *
 * KiloCode expects: export default { id: string, server: (input) => Promise<Hooks> }
 * OpenCode expects: export const ContextModePlugin = (ctx) => Promise<Hooks>
 */
declare function createContextModePlugin(ctx: PluginContext): Promise<{
    tool: Record<string, NativeToolDefinition>;
    "tool.execute.before": (input: BeforeHookInput, output: BeforeHookOutput) => Promise<void>;
    "tool.execute.after": (input: AfterHookInput, output: AfterHookOutput) => Promise<void>;
    event: (input: EventHookInput) => Promise<void>;
    "chat.message": (input: ChatMessageHookInput, output: ChatMessageHookOutput) => Promise<void>;
    "experimental.session.compacting": (input: CompactingHookInput, output: CompactingHookOutput) => Promise<string>;
    "experimental.chat.system.transform": (input: SystemTransformHookInput, output: SystemTransformHookOutput) => Promise<void>;
}>;
/**
 * Register context-mode's ctx_* tools through the V2 tool-transform API.
 *
 * Two V2-specific details, both observed on OpenCode 2.0.7:
 * - Tools added via `editor.add` default to `codemode: true`, which hides them
 *   from the model's direct tool list: they are only reachable by writing code
 *   against the `execute` tool's catalog. Routing enforcement tells the model
 *   to *call* these tools directly, so they are registered with
 *   `codemode: false`.
 * - Their model-visible names must equal `toolNamer(name)` — the names the
 *   routing block and the `execute.before` redirect messages use — so the
 *   guidance the model receives always names a tool that exists. OpenCode 2
 *   composes the visible name as `<namespace>_<name>`, so a namer of the form
 *   `<prefix>_<tool>` maps onto its native `namespace` option (see
 *   `v2ToolIdentity`); any other namer shape is used verbatim as the name.
 */
/**
 * Split a routed tool name into OpenCode 2's `{ name, namespace }` so the
 * host-composed `<namespace>_<name>` equals exactly what the router tells the
 * model to call. Exported for tests.
 */
export declare function v2ToolIdentity(bareTool: string, toolNamer: (bareTool: string) => string): {
    name: string;
    namespace?: string;
};
/**
 * Pin platform detection for in-plugin tool execution (jfayad, #1171).
 *
 * Inside an OpenCode/KiloCode plugin host process none of the `OPENCODE_*` /
 * `KILO_*` env markers are guaranteed to be set, so `detectPlatform()` falls
 * through to config-dir fallbacks (`~/.claude`, `~/.gemini`, …) and tools like
 * `ctx_doctor` misreport the platform. The plugin already knows its platform
 * (see `getPlatform()` / `createContextModeRuntime`), so pin it via the
 * `CONTEXT_MODE_PLATFORM` override that `detectPlatform()` honors — scoped to
 * the handler call only.
 *
 * An explicit user-set `CONTEXT_MODE_PLATFORM` wins and is left untouched.
 * Note: the pin is process-global env, so genuinely concurrent tool executions
 * share it — same trade-off as the existing `CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS`
 * scoping in `loadCtxToolRegistry()`. In practice the value pinned here is
 * always this host's own platform, so interleaving is harmless.
 */
export declare function withPinnedPlatform<T>(platform: string, fn: () => Promise<T>): Promise<T>;
/** V2 `Plugin.define({ id, setup })` body. `ctx` is the OpenCode 2 plugin context. */
declare function setupContextModePluginV2(ctx: any): Promise<() => void>;
declare const _default: {
    server: typeof createContextModePlugin;
    id: "context-mode";
    setup: typeof setupContextModePluginV2;
};
export default _default;
export { createContextModePlugin as ContextModePlugin };
export { systemHasRoutingInstructions, ROUTING_MARKERS };
