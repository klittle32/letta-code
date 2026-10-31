import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type Letta from "@letta-ai/letta-client";
import * as ts from "typescript";
import { clearAvailableModelsCache } from "@/agent/available-models";
import type { Backend } from "@/backend";
import type { PiProviderRegistration } from "@/backend/dev/pi-provider-mod-registry";
import {
  registerPiProvider,
  unregisterPiProvider,
  unregisterPiProvidersForOwner,
} from "@/backend/dev/pi-provider-mod-registry";
import {
  cloneModCapabilities,
  resolveModCapabilities,
} from "@/mods/capabilities";
import {
  attachDeprecatedGetContextTrap,
  recordDeprecatedContextApiSourceDiagnostics,
} from "@/mods/deprecated-api";
import { isTypeScriptModFileExtension } from "@/mods/file-extensions";
import * as modInvocationContext from "@/mods/invocation-context";
import { createModChangeBatcher } from "@/mods/mod-change-batcher";
import { normalizeModCommand, validateModCommandId } from "@/mods/mod-commands";
import {
  appendModDiagnostic,
  recordModDiagnostic,
  recordStaleHandleUse,
} from "@/mods/mod-diagnostics";
import {
  getModPanelKey,
  upsertModPanel,
  validateModPanelId,
} from "@/mods/mod-panels";
import type {
  LocalModSource,
  ResolveLocalModSourcesOptions,
} from "@/mods/mod-sources";
import { resolveLocalModSources } from "@/mods/mod-sources";
import {
  getGlobalModsDirectory,
  getLegacyGlobalExtensionsDirectory,
  getModCacheDirectory,
} from "@/mods/paths";
import {
  getModPermissionDefinition,
  type ModPermissionDefinition,
  registerModPermission,
  unregisterModPermission,
  unregisterModPermissionsForOwner,
} from "@/mods/permission-registry";
import { createModAsk, type ModQuestionHandler } from "@/mods/question-api";
import { ensureRuntimeDependenciesForModCache } from "@/mods/runtime-dependencies";
import {
  getModToolDefinition,
  type ModToolDefinition,
  registerModTool,
  unregisterModTool,
  unregisterModToolsForOwner,
} from "@/mods/tool-registry";
import { bindModTurnContext, bindModTurnHandle } from "@/mods/turn-handle";
import {
  applyTurnStartCancel,
  createTurnStartCancelRecord,
  type ModTurnStartCancelRecord,
  normalizeTurnStartCancelReason,
} from "@/mods/turn-start-cancel";
import {
  cloneTurnStartInput,
  isTurnStartInput,
  preserveApprovalFirstOrdering,
} from "@/mods/turn-start-input";
import type {
  ModAskOptions,
  ModAskResult,
  ModCapabilities,
  ModCommand,
  ModCommandRegistration,
  ModContext,
  ModDiagnostic,
  ModDiagnosticReportOptions,
  ModEventContext,
  ModEventEmissionResult,
  ModEventHandler,
  ModEventMap,
  ModEventName,
  ModEventRegistration,
  ModEventResultMap,
  ModOwner,
  ModPanel,
  ModPanelHandle,
  ModPanelOptions,
  ModPermission,
  ModPermissionRegistration,
  ModSourceScope,
  ModTool,
  ModToolEndEvent,
  ModToolRegistration,
  ModToolStartEvent,
  ModTurnEndEvent,
  ModTurnStartCancelResult,
  ModTurnStartEvent,
} from "@/mods/types";
import { createNoopModPanelHandle } from "@/mods/ui-helpers";
import { normalizeReportedDiagnostic } from "./diagnostic-report";
import { createEventConversationContext } from "./event-conversation-context";
import { recordLegacyExtensionLoadedDiagnostic } from "./legacy-extension-diagnostic";
import { waitForModLoad } from "./mod-load-cancellation";
import {
  bindModSessionContext,
  type ModSessionActivationHandler,
} from "./session-api";

export type {
  LocalModSource,
  ResolveLocalModSourcesOptions,
} from "@/mods/mod-sources";
export { resolveLocalModSources } from "@/mods/mod-sources";

export const GLOBAL_MODS_DIRECTORY = getGlobalModsDirectory();
export const LEGACY_GLOBAL_EXTENSIONS_DIRECTORY =
  getLegacyGlobalExtensionsDirectory();
export const MOD_CACHE_DIRECTORY = getModCacheDirectory();

const requireFromRuntime = createRequire(import.meta.url);
let resolveRuntimePackageDirectory = getRuntimePackageDirectory;

export type LettaModDisposer = () => void;

export type ModCapabilityDiagnosticRecorder = (
  diagnostic: Pick<
    ModDiagnostic,
    "capability" | "error" | "phase" | "severity"
  >,
) => void;

export type LettaModFactory = (
  letta: LettaModApi,
) => undefined | LettaModDisposer | Promise<undefined | LettaModDisposer>;

export interface LettaModApi {
  capabilities: ModCapabilities;
  client: Letta;
  getClient: () => Promise<Letta>;
  signal: AbortSignal;
  registerProvider: (
    name: string,
    config: PiProviderRegistration,
  ) => LettaModDisposer;
  unregisterProvider: (name: string) => void;
  commands: {
    register: (command: ModCommandRegistration) => LettaModDisposer;
    unregister: (id: string) => void;
  };
  tools: {
    register: (tool: ModToolRegistration) => LettaModDisposer;
    unregister: (name: string) => void;
  };
  providers: {
    register: (
      name: string,
      config: PiProviderRegistration,
    ) => LettaModDisposer;
    unregister: (name: string) => void;
  };
  events: {
    off: <TName extends ModEventName>(
      name: TName,
      handler: ModEventHandler<TName>,
    ) => void;
    on: <TName extends ModEventName>(
      name: TName,
      handler: ModEventHandler<TName>,
    ) => LettaModDisposer;
  };
  permissions: {
    register: (permission: ModPermissionRegistration) => LettaModDisposer;
    unregister: (id: string) => void;
  };
  diagnostics: {
    report: (diagnostic: ModDiagnosticReportOptions) => void;
  };
  ui: {
    ask: (options: ModAskOptions) => Promise<ModAskResult>;
    closePanel: (id: string) => void;
    notify: (message: string) => void;
    openPanel: (panel: ModPanelOptions) => ModPanelHandle;
    /** @deprecated Removed. Use openPanel; calls emit a migration diagnostic. */
    setStatus: (key: string, value?: unknown) => void;
    /** @deprecated Removed. Use openPanel; calls emit a migration diagnostic. */
    clearStatus: (key: string) => void;
    /** @deprecated Removed. Use openPanel; calls emit a migration diagnostic. */
    setStatuslineRenderer: (renderer: unknown) => void;
  };
}

export interface LocalModDisposer {
  abortController?: AbortController;
  dispose: LettaModDisposer;
  owner: ModOwner;
}

export interface LocalModUiRegistry {
  panels: Record<string, ModPanel>;
}

type LocalModEventsRegistry = Partial<
  Record<ModEventName, ModEventRegistration[]>
>;

export interface LocalModRegistry {
  onActivate?: ModSessionActivationHandler;
  capabilities: ModCapabilities;
  commands: Record<string, ModCommand>;
  diagnostics: ModDiagnostic[];
  disposers: LocalModDisposer[];
  events: LocalModEventsRegistry;
  generation: number;
  loadedPaths: string[];
  ownerAbortControllers: Record<string, AbortController>;
  owners: Record<string, ModOwner>;
  permissions: Record<string, ModPermissionDefinition>;
  registerCapabilitiesGlobally: boolean;
  sources: LocalModSource[];
  tools: Record<string, ModToolDefinition>;
  ui: LocalModUiRegistry;
}

interface LocalModModule {
  activate?: unknown;
  default?: unknown;
}

export interface LoadLocalModsOptions extends ResolveLocalModSourcesOptions {
  signal?: AbortSignal;
  getClient: () => Promise<Letta>;
  capabilities?: ModCapabilities;
  builtinCommandIds?: Iterable<string>;
  generation?: number;
  onChange?: () => void;
  onDiagnostic?: (diagnostic: ModDiagnostic) => void;
  onAsk?: ModQuestionHandler;
  onActivate?: ModSessionActivationHandler;
  onNotification?: modInvocationContext.ModNotificationHandler;
  onRegistryCreated?: (registry: LocalModRegistry) => void;
  registerCapabilitiesGlobally?: boolean;
  reservedToolNames?: Iterable<string>;
}

export interface ModEngine {
  dispose: () => void;
  emitEvent: <TName extends ModEventName>(
    name: TName,
    event: ModEventMap[TName],
    context: ModContext,
  ) => Promise<ModEventEmissionResult<TName>>;
  getSnapshot: () => LocalModRegistry;
  reload: (signal?: AbortSignal) => Promise<void>;
  subscribe: (listener: () => void) => () => void;
}

export interface CreateModEngineOptions extends LoadLocalModsOptions {
  getBackend?: () => Backend | undefined;
}

function getModSourcePriority(scope: ModSourceScope): number {
  switch (scope) {
    case "legacy_global":
      return 0;
    case "bundled":
      return 1;
    case "global":
      return 2;
    case "agent":
      return 3;
    case "project":
      return 4;
  }
}

function canShadowOwner(owner: ModOwner, existingOwner?: ModOwner): boolean {
  return (
    existingOwner !== undefined &&
    getModSourcePriority(owner.scope) >
      getModSourcePriority(existingOwner.scope)
  );
}

function isShadowedByOwner(owner: ModOwner, existingOwner?: ModOwner): boolean {
  return (
    existingOwner !== undefined &&
    getModSourcePriority(owner.scope) <
      getModSourcePriority(existingOwner.scope)
  );
}

function createEmptyModRegistry(
  sources: LocalModSource[],
  generation: number,
  capabilities: ModCapabilities,
  registerCapabilitiesGlobally: boolean,
): LocalModRegistry {
  return {
    capabilities: cloneModCapabilities(capabilities),
    commands: {},
    diagnostics: [],
    disposers: [],
    events: {},
    generation,
    loadedPaths: [],
    ownerAbortControllers: {},
    owners: {},
    permissions: {},
    registerCapabilitiesGlobally,
    sources,
    tools: {},
    ui: {
      panels: {},
    },
  };
}

function createModOwner(
  modPath: string,
  source: LocalModSource,
  generation: number,
): ModOwner {
  return {
    id: `${source.scope}:${modPath}`,
    path: modPath,
    scope: source.scope,
    generation,
  };
}

function isOwnerLive(registry: LocalModRegistry, owner: ModOwner): boolean {
  return registry.owners[owner.id]?.generation === owner.generation;
}

function snapshotRegistryForReaders(
  registry: LocalModRegistry,
): LocalModRegistry {
  return {
    ...registry,
    commands: { ...registry.commands },
    capabilities: cloneModCapabilities(registry.capabilities),
    diagnostics: [...registry.diagnostics],
    disposers: [...registry.disposers],
    events: Object.fromEntries(
      Object.entries(registry.events).map(([name, handlers]) => [
        name,
        handlers ? [...handlers] : [],
      ]),
    ) as LocalModEventsRegistry,
    loadedPaths: [...registry.loadedPaths],
    ownerAbortControllers: { ...registry.ownerAbortControllers },
    owners: { ...registry.owners },
    permissions: { ...registry.permissions },
    sources: registry.sources.map((source) => ({
      ...source,
      ...(source.diagnostics ? { diagnostics: [...source.diagnostics] } : {}),
      files: [...source.files],
      ...(source.managedPackageRoots
        ? { managedPackageRoots: [...source.managedPackageRoots] }
        : {}),
    })),
    tools: { ...registry.tools },
    ui: {
      ...registry.ui,
      panels: { ...registry.ui.panels },
    },
  };
}

function removeOwnerCapabilities(
  registry: LocalModRegistry,
  owner: ModOwner,
): void {
  if (registry.registerCapabilitiesGlobally) {
    unregisterPiProvidersForOwner(owner.id);
    clearAvailableModelsCache();
  }

  for (const [id, command] of Object.entries(registry.commands)) {
    if (command.owner?.id === owner.id) {
      delete registry.commands[id];
    }
  }

  for (const [name, registrations] of Object.entries(registry.events)) {
    const nextRegistrations = registrations?.filter(
      (registration) => registration.owner?.id !== owner.id,
    );
    if (nextRegistrations && nextRegistrations.length > 0) {
      registry.events[name as ModEventName] = nextRegistrations;
    } else {
      delete registry.events[name as ModEventName];
    }
  }

  for (const [id, panel] of Object.entries(registry.ui.panels)) {
    if (panel.owner?.id === owner.id) {
      delete registry.ui.panels[id];
    }
  }

  for (const [id, permission] of Object.entries(registry.permissions)) {
    if (permission.owner?.id === owner.id) {
      delete registry.permissions[id];
    }
  }

  for (const [name, tool] of Object.entries(registry.tools)) {
    if (tool.owner?.id === owner.id) {
      delete registry.tools[name];
    }
  }

  if (registry.registerCapabilitiesGlobally) {
    unregisterModPermissionsForOwner(owner);
    unregisterModToolsForOwner(owner);
  }

  delete registry.owners[owner.id];
}

function getRuntimePackageDirectory(packageName: string): string {
  return path.dirname(
    requireFromRuntime.resolve(path.join(packageName, "package.json")),
  );
}

export function __testOverrideRuntimePackageDirectoryResolver(
  resolver: ((packageName: string) => string) | null,
): void {
  resolveRuntimePackageDirectory = resolver ?? getRuntimePackageDirectory;
}

function isPathInsideOrEqual(childPath: string, parentPath: string): boolean {
  const child = path.resolve(childPath);
  const parent = path.resolve(parentPath);
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function getManagedPackageImportCacheDirectory(
  modPath: string,
  source: LocalModSource,
): string | null {
  const matchingRoot = source.managedPackageRoots?.find((packageRoot) =>
    isPathInsideOrEqual(modPath, packageRoot),
  );
  if (!matchingRoot) return null;
  return path.dirname(modPath);
}

function formatTranspileDiagnostic(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (!diagnostic.file || diagnostic.start == null) {
    return message;
  }

  const position = diagnostic.file.getLineAndCharacterOfPosition(
    diagnostic.start,
  );
  return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1} ${message}`;
}

function transpileTypeScriptMod(modPath: string, source: string): string {
  const result = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: modPath,
    reportDiagnostics: true,
  });

  const errors = result.diagnostics?.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors?.length) {
    throw new Error(errors.map(formatTranspileDiagnostic).join("\n"));
  }

  return result.outputText;
}

function prepareModForImport(modPath: string, source: string): string {
  const fileExtension = path.extname(modPath);
  if (isTypeScriptModFileExtension(fileExtension)) {
    return transpileTypeScriptMod(modPath, source);
  }

  return source;
}

function createImportableModPath(
  modPath: string,
  cacheDirectory: string,
  source: LocalModSource,
): string {
  const importCacheDirectory =
    getManagedPackageImportCacheDirectory(modPath, source) ?? cacheDirectory;
  const sourceText = readFileSync(modPath, "utf8");
  const hash = createHash("sha256")
    .update(sourceText)
    .digest("hex")
    .slice(0, 16);
  const fileExtension = path.extname(modPath);
  const importableSource = prepareModForImport(modPath, sourceText);

  if (importCacheDirectory === cacheDirectory) {
    ensureRuntimeDependenciesForModCache(
      importCacheDirectory,
      importableSource,
      resolveRuntimePackageDirectory,
    );
  } else {
    mkdirSync(importCacheDirectory, { recursive: true });
  }
  const baseName = path
    .basename(modPath, fileExtension)
    .replace(/[^a-zA-Z0-9_-]/g, "-");
  const importPath = path.join(
    importCacheDirectory,
    `.letta-mod-${baseName}-${hash}.mjs`,
  );

  if (!existsSync(importPath)) {
    writeFileSync(importPath, importableSource, "utf8");
  }

  try {
    for (const entry of readdirSync(importCacheDirectory)) {
      if (
        entry.startsWith(`.letta-mod-${baseName}-`) &&
        entry !== path.basename(importPath)
      ) {
        unlinkSync(path.join(importCacheDirectory, entry));
      }
    }
  } catch {}

  return importPath;
}

function createLazyClient(getClient: () => Promise<Letta>): Letta {
  const createProxy = (path: PropertyKey[] = []): unknown =>
    new Proxy(function lazyLettaClientProxy() {}, {
      apply(_target, _thisArg, args) {
        return getClient().then((client) => {
          let owner: unknown = client;
          let value: unknown = client;
          for (const property of path) {
            owner = value;
            value = (value as Record<PropertyKey, unknown>)[property];
          }
          if (typeof value !== "function") {
            throw new TypeError(
              `letta.client.${path.map(String).join(".")} is not callable`,
            );
          }
          return value.apply(owner, args);
        });
      },
      get(_target, property) {
        if (property === "then") return undefined;
        return createProxy([...path, property]);
      },
    });

  return createProxy() as Letta;
}

const SUPPORTED_MOD_EVENT_NAMES = new Set<ModEventName>([
  "conversation_open",
  "conversation_close",
  "tool_start",
  "tool_end",
  "turn_start",
  "turn_end",
  "compact_start",
  "compact_end",
  "llm_start",
  "llm_end",
]);

function validateModEventName(name: string): asserts name is ModEventName {
  if (!SUPPORTED_MOD_EVENT_NAMES.has(name as ModEventName)) {
    throw new Error(`Unsupported mod event '${name}'`);
  }
}

function isModEventCapabilityEnabled(
  capabilities: ModCapabilities,
  name: ModEventName,
): boolean {
  switch (name) {
    case "conversation_open":
    case "conversation_close":
      return capabilities.events.lifecycle;
    case "tool_start":
    case "tool_end":
      return capabilities.events.tools;
    case "turn_start":
    case "turn_end":
      return capabilities.events.turns;
    case "compact_start":
    case "compact_end":
      return capabilities.events.compact;
    case "llm_start":
    case "llm_end":
      return capabilities.events.llm;
  }
}

function isTurnStartResultWithInput(
  name: ModEventName,
  result: unknown,
): result is { input: ModTurnStartEvent["input"] } {
  return (
    name === "turn_start" &&
    typeof result === "object" &&
    result !== null &&
    isTurnStartInput((result as { input?: unknown }).input)
  );
}

function isTurnStartResultWithCancel(
  name: ModEventName,
  result: unknown,
): result is { cancel: ModTurnStartCancelResult } {
  if (name !== "turn_start" || typeof result !== "object" || !result) {
    return false;
  }
  const cancel = (result as { cancel?: unknown }).cancel;
  return (
    typeof cancel === "object" &&
    cancel !== null &&
    normalizeTurnStartCancelReason((cancel as { reason?: unknown }).reason) !==
      null
  );
}

function isToolStartResultWithArgs(
  name: ModEventName,
  result: unknown,
): result is { args: ModToolStartEvent["args"] } {
  return (
    name === "tool_start" &&
    typeof result === "object" &&
    result !== null &&
    isToolStartArgs((result as { args?: unknown }).args)
  );
}

function isToolStartArgs(value: unknown): value is ModToolStartEvent["args"] {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolStartResult(
  value: unknown,
): value is { status: "success" | "error"; output: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    ((value as { status?: unknown }).status === "success" ||
      (value as { status?: unknown }).status === "error") &&
    typeof (value as { output?: unknown }).output === "string"
  );
}

function isToolStartResultWithResult(
  name: ModEventName,
  result: unknown,
): result is { result: { status: "success" | "error"; output: string } } {
  return (
    name === "tool_start" &&
    typeof result === "object" &&
    result !== null &&
    isToolStartResult((result as { result?: unknown }).result)
  );
}

function isToolEndResultWithResult(
  name: ModEventName,
  result: unknown,
): result is { result: { status: "success" | "error"; output: string } } {
  return (
    name === "tool_end" &&
    typeof result === "object" &&
    result !== null &&
    isToolStartResult((result as { result?: unknown }).result)
  );
}

function isTurnEndResultWithContinue(
  name: ModEventName,
  result: unknown,
): result is { continue: string } {
  return (
    name === "turn_end" &&
    typeof result === "object" &&
    result !== null &&
    typeof (result as { continue?: unknown }).continue === "string" &&
    (result as { continue: string }).continue.length > 0
  );
}

function cloneToolStartArgs(
  args: ModToolStartEvent["args"],
): ModToolStartEvent["args"] {
  try {
    return structuredClone(args);
  } catch {
    return { ...args };
  }
}

function validateModPermissionId(id: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(
      "Mod permission id must be a lowercase slug using letters, numbers, and hyphens",
    );
  }
}

function normalizeModPermission(
  permission: ModPermissionRegistration,
  owner: ModOwner,
): ModPermission {
  validateModPermissionId(permission.id);
  if (typeof permission.check !== "function") {
    throw new Error(`Mod permission '${permission.id}' must include check()`);
  }

  return {
    id: permission.id,
    ...(permission.description ? { description: permission.description } : {}),
    owner,
    path: owner.path,
    ...(permission.isEnabled ? { isEnabled: permission.isEnabled } : {}),
    check: permission.check,
  };
}

function validateModToolName(name: string): void {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    throw new Error(
      "Mod tool name must be 1-64 characters using letters, numbers, underscores, or hyphens",
    );
  }
}

function normalizeModToolParameters(
  parameters: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!parameters) {
    return {
      type: "object",
      properties: {},
      additionalProperties: false,
    };
  }
  if (
    typeof parameters !== "object" ||
    parameters === null ||
    Array.isArray(parameters)
  ) {
    throw new Error("Mod tool parameters must be a JSON Schema object");
  }
  if (parameters.type !== undefined && parameters.type !== "object") {
    throw new Error("Mod tool parameters schema must be an object schema");
  }
  return parameters;
}

function normalizeModToolApprovalPolicy(
  tool: ModToolRegistration,
): ModTool["approvalPolicy"] {
  if (tool.approvalPolicy !== undefined) {
    if (
      tool.approvalPolicy === "auto" ||
      tool.approvalPolicy === "ask" ||
      tool.approvalPolicy === "alwaysAsk"
    ) {
      return tool.approvalPolicy;
    }
    throw new Error(
      `Mod tool '${tool.name}' approvalPolicy must be "auto", "ask", or "alwaysAsk"`,
    );
  }
  return tool.requiresApproval === false ? "auto" : "ask";
}

function normalizeModTool(tool: ModToolRegistration, owner: ModOwner): ModTool {
  validateModToolName(tool.name);
  if (!tool.description.trim()) {
    throw new Error(`Mod tool '${tool.name}' must include a description`);
  }
  if (typeof tool.run !== "function") {
    throw new Error(`Mod tool '${tool.name}' must include run()`);
  }

  const approvalPolicy = normalizeModToolApprovalPolicy(tool);

  return {
    name: tool.name,
    description: tool.description,
    parameters: normalizeModToolParameters(tool.parameters),
    owner,
    path: owner.path,
    requiresApproval: approvalPolicy !== "auto",
    approvalPolicy,
    parallelSafe: tool.parallelSafe === true,
    ...(tool.isEnabled ? { isEnabled: tool.isEnabled } : {}),
    run: tool.run,
  };
}

function createLettaModApi(
  registry: LocalModRegistry,
  owner: ModOwner,
  capabilities: ModCapabilities,
  getClient: () => Promise<Letta>,
  onChange: () => void,
  onDiagnostic: ((diagnostic: ModDiagnostic) => void) | undefined,
  onNotification: modInvocationContext.ModNotificationHandler | undefined,
  builtinCommandIds: Set<string>,
  reservedToolNames: Set<string>,
  signal: AbortSignal,
  onAsk: ModQuestionHandler | undefined,
  onActivate: ModSessionActivationHandler | undefined,
): LettaModApi {
  const bindSession = <T extends import("./types").ModInvocationContext>(
    context: T,
  ) =>
    bindModSessionContext(
      context,
      owner,
      signal,
      capabilities.session?.activate ? onActivate : undefined,
    );
  const isLive = () => isOwnerLive(registry, owner);
  const guardLive = (capability: ModDiagnostic["capability"]): boolean => {
    if (isLive()) return true;
    recordStaleHandleUse(registry, owner, capability, onDiagnostic);
    return false;
  };
  const recordCapabilityDiagnostic = (
    diagnostic: Pick<
      ModDiagnostic,
      "capability" | "error" | "phase" | "severity"
    >,
  ): void => {
    if (!isLive()) return;
    recordModDiagnostic(
      registry,
      {
        ...diagnostic,
        owner,
      },
      onDiagnostic,
    );
    onChange();
  };

  const unregisterEvent = <TName extends ModEventName>(
    name: TName,
    handler: ModEventHandler<TName>,
  ) => {
    validateModEventName(name);
    if (!isModEventCapabilityEnabled(capabilities, name)) return;
    if (!guardLive({ id: name, kind: "event" })) return;
    const registrations = registry.events[name];
    if (!registrations) return;
    const nextRegistrations = registrations.filter(
      (registration) =>
        registration.owner?.id !== owner.id ||
        registration.handler !== (handler as unknown as ModEventHandler),
    );
    if (nextRegistrations.length > 0) {
      registry.events[name] = nextRegistrations;
    } else {
      delete registry.events[name];
    }
    onChange();
  };

  const unregisterCommand = (id: string) => {
    if (!capabilities.commands) return;
    validateModCommandId(id);
    if (!guardLive({ id, kind: "command" })) return;
    const existing = registry.commands[id];
    if (existing?.owner?.id === owner.id) {
      delete registry.commands[id];
      onChange();
    }
  };

  const unregisterPermission = (id: string) => {
    if (!capabilities.permissions) return;
    validateModPermissionId(id);
    if (!guardLive({ id, kind: "permission" })) return;
    const existing = registry.permissions[id];
    if (existing?.owner?.id === owner.id) {
      delete registry.permissions[id];
      if (registry.registerCapabilitiesGlobally) {
        unregisterModPermission(id, owner);
      }
      onChange();
    }
  };

  const closePanel = (id: string) => {
    if (!capabilities.ui.panels) return;
    validateModPanelId(id);
    if (!guardLive({ id, kind: "panel" })) return;
    const panelKey = getModPanelKey(owner.id, id);
    const existing = registry.ui.panels[panelKey];
    if (existing?.owner?.id === owner.id) {
      delete registry.ui.panels[panelKey];
      onChange();
    }
  };

  const recordStatuslineDeprecation = (apiId: string) => {
    recordCapabilityDiagnostic({
      capability: { id: apiId, kind: "statusline" },
      error: new Error(
        `${apiId} is no longer available. Use letta.ui.openPanel({ id, order, render }) instead — order 0 is the primary line (replaces agent · model), order 1 replaces the default product-status row, orders > 1 render additive panels above input, and negative orders stack below it.`,
      ),
      phase: "deprecated_api",
      severity: "warning",
    });
  };

  const unregisterTool = (name: string) => {
    if (!capabilities.tools) return;
    validateModToolName(name);
    if (!guardLive({ id: name, kind: "tool" })) return;
    const existing = registry.tools[name];
    if (existing?.owner?.id === owner.id) {
      delete registry.tools[name];
      if (registry.registerCapabilitiesGlobally) {
        unregisterModTool(name, owner);
      }
      onChange();
    }
  };

  const unregisterProvider = (name: string) => {
    if (!capabilities.providers) return;
    if (!guardLive({ id: name, kind: "provider" })) return;
    unregisterPiProvider(name, owner.id);
    clearAvailableModelsCache();
    onChange();
  };

  const registerProviderForOwner = (
    name: string,
    config: PiProviderRegistration,
  ): LettaModDisposer => {
    if (!capabilities.providers) {
      return () => undefined;
    }
    if (!guardLive({ id: name, kind: "provider" })) {
      return () => undefined;
    }
    registerPiProvider(name, config, {
      id: owner.id,
      path: owner.path,
    });
    clearAvailableModelsCache();
    onChange();
    return () => unregisterProvider(name);
  };

  const reportDiagnostic = (diagnostic: ModDiagnosticReportOptions) => {
    if (!guardLive(undefined)) return;
    const normalized = normalizeReportedDiagnostic(diagnostic);
    const error = new Error(normalized.message);
    error.name = "ModDiagnosticReport";
    error.stack = undefined;
    recordModDiagnostic(
      registry,
      {
        error,
        owner,
        phase: "report",
        severity: normalized.severity,
      },
      onDiagnostic,
    );
  };

  const onEvent = <TName extends ModEventName>(
    name: TName,
    handler: ModEventHandler<TName>,
  ): LettaModDisposer => {
    validateModEventName(name);
    if (!isModEventCapabilityEnabled(capabilities, name)) {
      return () => undefined;
    }
    if (typeof handler !== "function") {
      throw new Error("Mod event registration must include a handler");
    }
    if (!guardLive({ id: name, kind: "event" })) {
      return () => undefined;
    }

    registry.events[name] = [
      ...(registry.events[name] ?? []),
      {
        handler: handler as unknown as ModEventHandler,
        name,
        owner,
      },
    ];
    onChange();

    return () => unregisterEvent(name, handler);
  };

  const api: LettaModApi = {
    capabilities: cloneModCapabilities(capabilities),
    client: createLazyClient(getClient),
    getClient,
    signal,
    registerProvider: registerProviderForOwner,
    unregisterProvider,
    commands: {
      register(command) {
        if (!capabilities.commands) {
          return () => undefined;
        }
        if (!guardLive({ id: command.id, kind: "command" })) {
          return () => undefined;
        }

        const normalized = normalizeModCommand(command, owner);
        if (builtinCommandIds.has(normalized.id)) {
          recordModDiagnostic(
            registry,
            {
              capability: { id: normalized.id, kind: "command" },
              error: new Error(
                `Mod command '${normalized.id}' overrides a built-in command`,
              ),
              owner,
              phase: "command_override",
            },
            onDiagnostic,
          );
        }

        const existing = registry.commands[normalized.id];
        if (existing && isShadowedByOwner(owner, existing.owner)) {
          throw new Error(
            `Mod command '${normalized.id}' is already registered by higher-priority mod ${existing.path}`,
          );
        }
        if (
          existing &&
          !command.override &&
          !canShadowOwner(owner, existing.owner)
        ) {
          throw new Error(
            `Mod command '${normalized.id}' is already registered by ${existing.path}`,
          );
        }

        registry.commands[normalized.id] = {
          ...normalized,
          run: (context) =>
            normalized.run(
              bindSession(
                bindModTurnContext(
                  context,
                  capabilities.turn?.interrupt ? signal : undefined,
                ),
              ),
            ),
          recordDiagnostic: recordCapabilityDiagnostic,
        };
        onChange();

        return () => unregisterCommand(normalized.id);
      },
      unregister: unregisterCommand,
    },
    tools: {
      register(tool) {
        if (!capabilities.tools) {
          return () => undefined;
        }
        if (!guardLive({ id: tool.name, kind: "tool" })) {
          return () => undefined;
        }

        const normalized = normalizeModTool(tool, owner);
        if (reservedToolNames.has(normalized.name)) {
          throw new Error(
            `Mod tool '${normalized.name}' conflicts with a built-in tool`,
          );
        }

        const existing = registry.tools[normalized.name];
        const existingGlobal = getModToolDefinition(normalized.name);
        const existingOwner = existing?.owner ?? existingGlobal?.owner;
        if (
          (existing || existingGlobal) &&
          isShadowedByOwner(owner, existingOwner)
        ) {
          throw new Error(
            `Mod tool '${normalized.name}' is already registered by higher-priority mod ${existing?.path ?? existingGlobal?.path}`,
          );
        }
        if (
          (existing || existingGlobal) &&
          !tool.override &&
          !canShadowOwner(owner, existingOwner)
        ) {
          throw new Error(
            `Mod tool '${normalized.name}' is already registered by ${existing?.path ?? existingGlobal?.path}`,
          );
        }

        const definition: ModToolDefinition = {
          ...normalized,
          activationSignal: signal,
          run: (context) => normalized.run(bindSession(context)),
          recordDiagnostic: recordCapabilityDiagnostic,
        };
        registry.tools[normalized.name] = definition;
        if (registry.registerCapabilitiesGlobally) {
          registerModTool(definition);
        }
        onChange();

        return () => unregisterTool(normalized.name);
      },
      unregister: unregisterTool,
    },
    providers: {
      register(name, config) {
        return registerProviderForOwner(name, config);
      },
      unregister: unregisterProvider,
    },
    events: {
      off: unregisterEvent,
      on: onEvent,
    },
    permissions: {
      register(permission) {
        if (!capabilities.permissions) {
          return () => undefined;
        }
        if (!guardLive({ id: permission.id, kind: "permission" })) {
          return () => undefined;
        }

        const normalized = normalizeModPermission(permission, owner);
        const existing = registry.permissions[normalized.id];
        const existingGlobal = getModPermissionDefinition(normalized.id);
        const existingOwner = existing?.owner ?? existingGlobal?.owner;
        if (
          (existing || existingGlobal) &&
          isShadowedByOwner(owner, existingOwner)
        ) {
          throw new Error(
            `Mod permission '${normalized.id}' is already registered by higher-priority mod ${existing?.path ?? existingGlobal?.path}`,
          );
        }
        if (
          (existing || existingGlobal) &&
          !canShadowOwner(owner, existingOwner)
        ) {
          throw new Error(
            `Mod permission '${normalized.id}' is already registered by ${existing?.path ?? existingGlobal?.path}`,
          );
        }

        const definition: ModPermissionDefinition = {
          ...normalized,
          activationSignal: signal,
          recordDiagnostic: recordCapabilityDiagnostic,
        };
        registry.permissions[normalized.id] = definition;
        if (registry.registerCapabilitiesGlobally) {
          registerModPermission(definition);
        }
        onChange();

        return () => unregisterPermission(normalized.id);
      },
      unregister: unregisterPermission,
    },
    diagnostics: { report: reportDiagnostic },
    ui: {
      ask: createModAsk(
        owner,
        signal,
        capabilities.ui.dialogs ? onAsk : undefined,
      ),
      closePanel,
      notify(message) {
        if (!onNotification || !message.trim()) return;
        if (!guardLive({ id: "notify", kind: "panel" })) return;
        modInvocationContext.notifyMod(onNotification, message);
      },
      openPanel(panel) {
        if (!capabilities.ui.panels) {
          return createNoopModPanelHandle();
        }
        if (!guardLive({ id: panel.id, kind: "panel" })) {
          return createNoopModPanelHandle();
        }
        if (typeof panel.render !== "function") {
          const usedLegacyContent = Object.hasOwn(panel as object, "content");
          recordCapabilityDiagnostic({
            capability: { id: panel.id, kind: "panel" },
            error: new Error(
              usedLegacyContent
                ? "letta.ui.openPanel now requires render(ctx), not content. Use letta.ui.openPanel({ id, order, render: () => content }) instead."
                : "letta.ui.openPanel requires a render(ctx) function.",
            ),
            phase: "activate",
            severity: "warning",
          });
          return createNoopModPanelHandle();
        }

        upsertModPanel(registry, owner, panel.id, {
          render: panel.render,
          order: panel.order,
        });
        onChange();
        return {
          close() {
            closePanel(panel.id);
          },
          update(options) {
            if (!guardLive({ id: panel.id, kind: "panel" })) return;
            upsertModPanel(registry, owner, panel.id, {
              order: options?.order,
            });
            onChange();
          },
        };
      },
      setStatus() {
        recordStatuslineDeprecation("letta.ui.setStatus");
      },
      clearStatus() {
        recordStatuslineDeprecation("letta.ui.clearStatus");
      },
      setStatuslineRenderer() {
        recordStatuslineDeprecation("letta.ui.setStatuslineRenderer");
      },
    },
  };

  return attachDeprecatedGetContextTrap(
    api,
    recordCapabilityDiagnostic,
    "letta.getContext",
  );
}

function getModFactory(module: LocalModModule): unknown {
  return typeof module.default === "function"
    ? module.default
    : module.activate;
}

export async function loadLocalMods(
  options: LoadLocalModsOptions,
): Promise<LocalModRegistry> {
  const cacheDirectory = options.cacheDirectory ?? MOD_CACHE_DIRECTORY;
  let clientPromise: Promise<Letta> | null = null;
  const getConfiguredClient = () => {
    clientPromise ??= options.getClient();
    return clientPromise;
  };
  const onChange = options.onChange ?? (() => {});
  const sources = resolveLocalModSources(options);
  const capabilities = resolveModCapabilities(options.capabilities);
  capabilities.ui.dialogs = capabilities.ui.dialogs === true && !!options.onAsk;
  capabilities.session = {
    activate: capabilities.session?.activate === true && !!options.onActivate,
  };
  const generation = options.generation ?? 1;
  const builtinCommandIds = new Set([...(options.builtinCommandIds ?? [])]);
  const reservedToolNames = new Set([...(options.reservedToolNames ?? [])]);
  const registry = createEmptyModRegistry(
    sources,
    generation,
    capabilities,
    options.registerCapabilitiesGlobally !== false,
  );
  registry.onActivate = capabilities.session.activate
    ? options.onActivate
    : undefined;
  options.onRegistryCreated?.(registry);

  for (const source of sources) {
    for (const diagnostic of source.diagnostics ?? []) {
      const owner = createModOwner(diagnostic.path, source, generation);
      recordModDiagnostic(
        registry,
        {
          error: diagnostic.error,
          owner,
          phase: "package_manifest",
        },
        options.onDiagnostic,
      );
    }

    for (const modPath of source.files) {
      if (options.signal?.aborted) return registry;
      const owner = createModOwner(modPath, source, generation);
      const abortController = new AbortController();
      let failurePhase: ModDiagnostic["phase"] = "import";
      registry.ownerAbortControllers[owner.id] = abortController;
      registry.owners[owner.id] = owner;

      if (source.scope === "legacy_global") {
        recordLegacyExtensionLoadedDiagnostic(
          registry,
          owner,
          source,
          options.onDiagnostic,
        );
      }

      try {
        const mtimeMs = statSync(modPath).mtimeMs;
        const sourceText = readFileSync(modPath, "utf8");
        recordDeprecatedContextApiSourceDiagnostics(
          sourceText,
          (diagnostic) => {
            recordModDiagnostic(
              registry,
              {
                ...diagnostic,
                owner,
              },
              options.onDiagnostic,
            );
          },
        );
        failurePhase = isTypeScriptModFileExtension(path.extname(modPath))
          ? "transpile"
          : "import";
        const importPath = createImportableModPath(
          modPath,
          cacheDirectory,
          source,
        );
        failurePhase = "import";
        const module = (await waitForModLoad(
          import(`${pathToFileURL(importPath).href}?mod=${mtimeMs}`),
          options.signal,
        )) as LocalModModule;
        const factory = getModFactory(module);
        failurePhase = "activate";
        if (typeof factory !== "function") {
          throw new Error(
            "Mod must export a default function or activate() function",
          );
        }
        const changes = createModChangeBatcher(onChange);
        const api = createLettaModApi(
          registry,
          owner,
          capabilities,
          getConfiguredClient,
          changes.notify,
          options.onDiagnostic,
          options.onNotification,
          builtinCommandIds,
          reservedToolNames,
          abortController.signal,
          options.onAsk,
          options.onActivate,
        );
        const activate = factory as LettaModFactory;
        const dispose = await waitForModLoad(
          changes.run(() => activate(api)),
          options.signal,
          (late) => {
            if (typeof late === "function") late();
          },
        );
        if (typeof dispose === "function") {
          registry.disposers.push({
            abortController,
            dispose: () => changes.runSync(dispose),
            owner,
          });
        }
        registry.loadedPaths.push(modPath);
      } catch (error) {
        removeOwnerCapabilities(registry, owner);
        abortController.abort("mod activation failed");
        delete registry.ownerAbortControllers[owner.id];
        recordModDiagnostic(
          registry,
          {
            error: error instanceof Error ? error : new Error(String(error)),
            owner,
            phase: failurePhase,
          },
          options.onDiagnostic,
        );
      }
    }
  }

  return registry;
}

export async function emitLocalModEvent<TName extends ModEventName>(
  registry: LocalModRegistry | null,
  name: TName,
  event: ModEventMap[TName],
  context: ModContext,
  backend?: Backend,
  onDiagnostic?: (diagnostic: ModDiagnostic) => void,
): Promise<ModEventEmissionResult<TName>> {
  if (!registry) {
    return { diagnostics: [], handlerCount: 0, name, results: [] };
  }

  validateModEventName(name);
  const registrations = [...(registry.events[name] ?? [])];
  const diagnostics: ModDiagnostic[] = [];
  const results: Array<NonNullable<ModEventResultMap[TName]>> = [];
  let turnStartCancel: ModTurnStartCancelRecord | undefined;
  const turnStartHadApproval =
    name === "turn_start" &&
    (event as ModTurnStartEvent).input.some((item) => item.type === "approval");
  for (const registration of registrations) {
    const signal = registration.owner
      ? registry.ownerAbortControllers[registration.owner.id]?.signal
      : undefined;
    if (signal?.aborted) continue;
    const turnStartEvent =
      name === "turn_start" ? (event as ModTurnStartEvent) : null;
    const turnStartInputBeforeHandler =
      turnStartEvent && isTurnStartInput(turnStartEvent.input)
        ? cloneTurnStartInput(turnStartEvent.input)
        : null;
    const toolStartEvent =
      name === "tool_start" ? (event as ModToolStartEvent) : null;
    const toolStartArgsBeforeHandler =
      toolStartEvent && isToolStartArgs(toolStartEvent.args)
        ? cloneToolStartArgs(toolStartEvent.args)
        : null;

    try {
      const recordEventDiagnostic = (
        diagnostic: Pick<
          ModDiagnostic,
          "capability" | "error" | "phase" | "severity"
        >,
      ): void => {
        recordModDiagnostic(
          registry,
          {
            ...diagnostic,
            owner: registration.owner,
          },
          onDiagnostic,
        );
      };
      const eventContext: ModEventContext = attachDeprecatedGetContextTrap(
        {
          ...context,
          turn: registry.capabilities.turn?.interrupt
            ? bindModTurnHandle(context.turn, signal)
            : undefined,
          ...createEventConversationContext(context, event, backend),
          signal: signal ?? new AbortController().signal,
        },
        recordEventDiagnostic,
        "ctx.getContext",
      );
      const result = await modInvocationContext.invoke(
        registration.owner && signal
          ? bindModSessionContext(
              eventContext,
              registration.owner,
              signal,
              registry.onActivate,
            )
          : eventContext,
        registration,
        event,
      );
      if (isTurnStartResultWithInput(name, result)) {
        (event as ModTurnStartEvent).input = result.input;
      }
      if (!turnStartCancel && isTurnStartResultWithCancel(name, result)) {
        turnStartCancel = createTurnStartCancelRecord(result, registration);
      }
      if (isToolStartResultWithArgs(name, result)) {
        (event as ModToolStartEvent).args = result.args;
      }
      if (
        isToolStartResultWithResult(name, result) &&
        !(event as ModToolStartEvent & { result?: unknown }).result
      ) {
        (
          event as ModToolStartEvent & {
            result?: { status: "success" | "error"; output: string };
          }
        ).result = result.result;
      }
      if (
        isToolEndResultWithResult(name, result) &&
        !(event as ModToolEndEvent & { result?: unknown }).result
      ) {
        (
          event as ModToolEndEvent & {
            result?: { status: "success" | "error"; output: string };
          }
        ).result = result.result;
      }
      if (
        isTurnEndResultWithContinue(name, result) &&
        !(event as ModTurnEndEvent & { continue?: unknown }).continue
      ) {
        (event as ModTurnEndEvent & { continue?: string }).continue =
          result.continue;
      }
      if (result != null) {
        results.push(result as NonNullable<ModEventResultMap[TName]>);
      }
      if (
        turnStartEvent &&
        turnStartInputBeforeHandler &&
        !isTurnStartInput(turnStartEvent.input)
      ) {
        turnStartEvent.input = turnStartInputBeforeHandler;
      }
      if (
        toolStartEvent &&
        toolStartArgsBeforeHandler &&
        !isToolStartArgs(toolStartEvent.args)
      ) {
        toolStartEvent.args = toolStartArgsBeforeHandler;
      }
    } catch (error) {
      if (turnStartEvent && turnStartInputBeforeHandler) {
        turnStartEvent.input = turnStartInputBeforeHandler;
      }
      if (toolStartEvent && toolStartArgsBeforeHandler) {
        toolStartEvent.args = toolStartArgsBeforeHandler;
      }
      const diagnostic = recordModDiagnostic(
        registry,
        {
          capability: { id: name, kind: "event" },
          error: error instanceof Error ? error : new Error(String(error)),
          owner: registration.owner,
          phase: "event",
        },
        onDiagnostic,
      );
      diagnostics.push(diagnostic);
    }
  }

  if (name === "turn_start") {
    const turnStartEvent = event as ModTurnStartEvent;
    turnStartEvent.input = preserveApprovalFirstOrdering(
      turnStartHadApproval,
      turnStartEvent.input,
    );
    applyTurnStartCancel(turnStartEvent, turnStartCancel);
  }

  return { diagnostics, handlerCount: registrations.length, name, results };
}

export function disposeLocalMods(registry: LocalModRegistry): void {
  for (const abortController of Object.values(registry.ownerAbortControllers)) {
    abortController.abort("mod disposed");
  }

  const disposers = [...registry.disposers].reverse();
  registry.disposers = [];

  for (const { dispose, owner } of disposers) {
    try {
      dispose();
    } catch (error) {
      recordModDiagnostic(registry, {
        error: error instanceof Error ? error : new Error(String(error)),
        owner,
        phase: "dispose",
      });
    }
  }

  if (registry.registerCapabilitiesGlobally) {
    for (const owner of Object.values(registry.owners)) {
      unregisterPiProvidersForOwner(owner.id);
      unregisterModPermissionsForOwner(owner);
      unregisterModToolsForOwner(owner);
    }
    clearAvailableModelsCache();
  }

  registry.commands = {};
  registry.events = {};
  registry.ownerAbortControllers = {};
  registry.owners = {};
  registry.permissions = {};
  registry.tools = {};
  registry.ui.panels = {};
}

export function createModEngine(options: CreateModEngineOptions): ModEngine {
  const { getBackend, onDiagnostic, ...modOptions } = options;
  let generation = 0;
  let disposed = false;
  const capabilities = resolveModCapabilities(modOptions.capabilities);
  capabilities.ui.dialogs =
    capabilities.ui.dialogs === true && !!modOptions.onAsk;
  capabilities.session = {
    activate:
      capabilities.session?.activate === true && !!modOptions.onActivate,
  };
  const registerCapabilitiesGlobally =
    modOptions.registerCapabilitiesGlobally !== false;
  let activeRegistry = createEmptyModRegistry(
    resolveLocalModSources(modOptions),
    generation,
    capabilities,
    registerCapabilitiesGlobally,
  );
  let snapshot = snapshotRegistryForReaders(activeRegistry);
  const listeners = new Set<() => void>();

  const publish = () => {
    snapshot = snapshotRegistryForReaders(activeRegistry);
    for (const listener of listeners) {
      listener();
    }
  };

  const reload = async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    if (disposed) return;

    disposeLocalMods(activeRegistry);
    generation += 1;
    const loadGeneration = generation;
    activeRegistry = createEmptyModRegistry(
      resolveLocalModSources(modOptions),
      loadGeneration,
      capabilities,
      registerCapabilitiesGlobally,
    );
    publish();

    let loadingRegistry: LocalModRegistry | null = null;
    const nextRegistry = await loadLocalMods({
      ...modOptions,
      generation: loadGeneration,
      signal,
      onRegistryCreated: (registry) => {
        loadingRegistry = registry;
        if (!disposed && loadGeneration === generation) {
          activeRegistry = registry;
          publish();
        }
      },
      onChange: () => {
        if (!disposed && loadingRegistry && loadGeneration === generation) {
          activeRegistry = loadingRegistry;
          publish();
        }
      },
      onDiagnostic: (diagnostic) => {
        if (disposed) return;

        if (loadingRegistry && loadGeneration === generation) {
          activeRegistry = loadingRegistry;
          publish();
          onDiagnostic?.(diagnostic);
          return;
        }
        appendModDiagnostic(activeRegistry, diagnostic);
        publish();
        onDiagnostic?.(diagnostic);
      },
    });
    loadingRegistry = nextRegistry;
    if (signal?.aborted && loadGeneration === generation) {
      disposeLocalMods(nextRegistry);
      activeRegistry = createEmptyModRegistry(
        resolveLocalModSources(modOptions),
        ++generation,
        capabilities,
        registerCapabilitiesGlobally,
      );
      publish();
      throw new Error("Mod loading cancelled", { cause: signal.reason });
    }
    if (disposed || loadGeneration !== generation) {
      disposeLocalMods(nextRegistry);
      return;
    }

    activeRegistry = nextRegistry;
    publish();
  };

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      disposeLocalMods(activeRegistry);
      activeRegistry = createEmptyModRegistry(
        resolveLocalModSources(modOptions),
        generation,
        capabilities,
        registerCapabilitiesGlobally,
      );
      publish();
      listeners.clear();
    },
    async emitEvent(name, payload, context) {
      if (disposed) {
        return { diagnostics: [], handlerCount: 0, name, results: [] };
      }
      const invocationBackend = getBackend?.();
      const result = await emitLocalModEvent(
        activeRegistry,
        name,
        payload,
        context,
        invocationBackend,
        onDiagnostic,
      );
      if (result.diagnostics.length > 0) {
        publish();
      }
      return result;
    },
    getSnapshot() {
      return snapshot;
    },
    reload,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
