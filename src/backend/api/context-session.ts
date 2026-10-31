import {
  APIBackend,
  type APIClient,
  type Backend,
  getBackend,
} from "@/backend/backend";
import { getClient } from "./client";

export type ApiContextSessionErrorCode =
  | "unsupported-backend"
  | "invalid-endpoint"
  | "organization-unavailable"
  | "organization-mismatch"
  | "session-changed"
  | "session-unavailable"
  | "cancelled"
  | "transport-override";

/** Deliberately excludes SDK errors/causes, which may contain credential-bearing data.
 * This error never certifies non-acceptance of an earlier message POST.
 */
export class ApiContextSessionError extends Error {
  constructor(readonly code: ApiContextSessionErrorCode) {
    super(`API context session ${code.replaceAll("-", " ")}`);
  }
}

/** Organization-level host namespace, not an authenticated human identity. */
export interface ApiContextSessionScope {
  readonly backend: string;
  readonly account: string;
}

/** SDK-compatible at the boundary; runtime accepts only signal, timeout,
 * headers, and maxRetries: 0. Routing/credential overrides remain forbidden.
 */
export type ApiContextRequestOptions = NonNullable<
  Parameters<Backend["createConversationMessageStream"]>[2]
>;

function snapshotHeaders(input: ApiContextRequestOptions["headers"]) {
  const values = new Headers();
  const nulls = new Set<string>();
  function add(name: string, value: string | null | undefined) {
    const normalized = name.toLowerCase();
    if (
      [
        "authorization",
        "proxy-authorization",
        "cookie",
        "host",
        "x-project",
        "x-project-id",
        "x-api-key",
      ].includes(normalized)
    )
      throw new ApiContextSessionError("transport-override");
    if (value === undefined) return;
    // Validate removals too; unlike Headers, the SDK supports explicit nulls.
    new Headers([[name, ""]]);
    if (value === null) {
      values.delete(name);
      nulls.add(normalized);
    } else {
      values.append(name, value);
      nulls.delete(normalized);
    }
  }
  try {
    if (input instanceof Headers) {
      for (const [name, value] of input) add(name, value);
    } else if (Array.isArray(input)) {
      for (const [name, value] of input) add(name, value);
    } else if (
      input &&
      "values" in input &&
      input.values instanceof Headers &&
      "nulls" in input &&
      input.nulls instanceof Set
    ) {
      // SDK NullableHeaders: copy both containers, never retain caller aliases.
      for (const [name, value] of input.values) add(name, value);
      for (const name of input.nulls) add(name, null);
    } else if (input) {
      for (const [name, value] of Object.entries(input)) {
        if (
          value === undefined ||
          (Array.isArray(value) && value.every((item) => item === undefined))
        )
          continue;
        // SDK record keys replace earlier case-insensitive keys; tuple rows append.
        values.delete(name);
        nulls.delete(name.toLowerCase());
        if (Array.isArray(value)) {
          for (const item of value) add(name, item);
        } else add(name, value);
      }
    }
  } catch {
    throw new ApiContextSessionError("transport-override");
  }
  return Object.freeze({
    ...Object.fromEntries(values),
    ...Object.fromEntries([...nulls].map((name) => [name, null])),
  });
}

function requestOptions(options: ApiContextRequestOptions = {}) {
  if (
    Object.keys(options).some(
      (key) => !["signal", "timeout", "headers", "maxRetries"].includes(key),
    )
  )
    throw new ApiContextSessionError("transport-override");
  const { signal, timeout, headers, maxRetries } = options;
  if (maxRetries !== undefined && maxRetries !== 0)
    throw new ApiContextSessionError("transport-override");
  // Build a fresh allowlisted object before any await. In particular, never
  // spread caller options again after validation or retain mutable header arrays.
  return Object.freeze({
    ...(signal === undefined ? {} : { signal }),
    ...(timeout === undefined ? {} : { timeout }),
    headers: snapshotHeaders(headers),
    maxRetries: 0,
  });
}

/** fetchOptions are spread after SDK headers/method/body. Keep only inert scalar
 * options, with redirects/cookie credentials disabled; arbitrary agents,
 * dispatchers, headers, and RequestInit overrides cannot be safely captured.
 */
function snapshotFetchOptions(input: unknown) {
  const result: {
    cache?: NonNullable<
      Parameters<APIClient["withOptions"]>[0]["fetchOptions"]
    >["cache"];
    redirect: "error" | "manual";
    credentials: "omit";
  } = { redirect: "error", credentials: "omit" };
  if (input == null) return Object.freeze(result);
  if (typeof input !== "object" || Array.isArray(input))
    throw new ApiContextSessionError("transport-override");
  for (const [key, value] of Object.entries(input)) {
    if (key === "cache") {
      switch (value) {
        case "default":
        case "no-store":
        case "reload":
        case "no-cache":
        case "force-cache":
        case "only-if-cached":
          result.cache = value;
          break;
        default:
          throw new ApiContextSessionError("transport-override");
      }
    } else if (
      key === "redirect" &&
      (value === "error" || value === "manual")
    ) {
      result.redirect = value;
    } else if (key !== "credentials" || value !== "omit") {
      throw new ApiContextSessionError("transport-override");
    }
  }
  return Object.freeze(result);
}

function isolateClient(source: APIClient): APIClient {
  // The pinned SDK exposes no public defaultHeaders reader. Its withOptions
  // shallow-copies defaultHeaders/defaultQuery and this.fetchOptions. Read only
  // this option bag, fail closed if its shape changes, and replace these aliases with
  // validated private snapshots. Never return/persist/log the original bag.
  const inherited: unknown = Reflect.get(source, "_options");
  if (
    !inherited ||
    typeof inherited !== "object" ||
    Array.isArray(inherited) ||
    !Reflect.has(source, "fetchOptions")
  )
    throw new ApiContextSessionError("session-unavailable");
  const headers: ApiContextRequestOptions["headers"] = Reflect.get(
    inherited,
    "defaultHeaders",
  );
  // Custom-client limitation: inherited query parameters are unsupported. Even
  // an empty bag must be replaced so later source mutations cannot alter reads.
  const query: unknown = Reflect.get(inherited, "defaultQuery");
  if (
    query != null &&
    (typeof query !== "object" ||
      Array.isArray(query) ||
      Reflect.ownKeys(query).length > 0)
  )
    throw new ApiContextSessionError("transport-override");
  return source.withOptions({
    defaultQuery: Object.freeze({}),
    maxRetries: 0,
    logLevel: "off",
    defaultHeaders: snapshotHeaders(headers),
    fetchOptions: snapshotFetchOptions(Reflect.get(source, "fetchOptions")),
  });
}

function endpoint(value: string): string {
  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.href.replace(/\/$/, "");
  } catch {
    throw new ApiContextSessionError("invalid-endpoint");
  }
}

function checkAbort(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw new ApiContextSessionError("cancelled");
}

/** Captures only message/history/exact-run transport. No whole-backend snapshot:
 * APIBackend fork and capabilities can consult ambient state and are not exposed.
 *
 * Dependencies must describe the SAME API backend/client owner. Defaults use the
 * production owners; injection supports custom APIBackend({ getClient }) instances.
 * Credentials stay only in closure/SDK memory, never in the returned namespace.
 * No inference is started here. Callers still own inbox dispatch/acceptance state.
 */
export async function captureApiContextSession(
  options: {
    getBackend?: () => Backend;
    getClient?: () => Promise<APIClient>;
    expectedOrganizationId?: string;
    signal?: AbortSignal;
  } = {},
) {
  const currentBackend = options.getBackend ?? getBackend;
  const currentClient = options.getClient ?? getClient;
  checkAbort(options.signal);
  // Capture before the credential lookup can await or refresh.
  const sourceBackend = currentBackend();
  if (!(sourceBackend instanceof APIBackend))
    throw new ApiContextSessionError("unsupported-backend");
  let captured: APIClient;
  try {
    const source = await currentClient();
    checkAbort(options.signal);
    if (currentBackend() !== sourceBackend)
      throw new ApiContextSessionError("session-changed");
    // withOptions samples dynamic organization/Desktop apiKey getters into a
    // new ordinary SDK instance. Disable SDK retries and credential-bearing logs.
    captured = isolateClient(source);
  } catch (error) {
    if (error instanceof ApiContextSessionError) throw error;
    throw new ApiContextSessionError("session-unavailable");
  }
  const backendIdentity = endpoint(captured.baseURL);

  async function assertCurrent(
    request: { signal?: AbortSignal | null } = {},
  ): Promise<void> {
    checkAbort(request.signal);
    if (currentBackend() !== sourceBackend)
      throw new ApiContextSessionError("session-changed");
    let live: APIClient;
    try {
      live = isolateClient(await currentClient());
    } catch {
      checkAbort(request.signal);
      throw new ApiContextSessionError("session-unavailable");
    }
    checkAbort(request.signal);
    if (
      currentBackend() !== sourceBackend ||
      endpoint(live.baseURL) !== backendIdentity ||
      live.apiKey !== captured.apiKey ||
      live.projectID !== captured.projectID ||
      live.project !== captured.project
    )
      throw new ApiContextSessionError("session-changed");
  }

  let metadata: unknown;
  try {
    metadata = await captured.get<unknown>("/v1/metadata/balance", {
      signal: options.signal,
      maxRetries: 0,
    });
  } catch {
    checkAbort(options.signal);
    throw new ApiContextSessionError("organization-unavailable");
  }
  checkAbort(options.signal);
  const organization =
    metadata && typeof metadata === "object" && "organization_id" in metadata
      ? metadata.organization_id
      : undefined;
  if (
    typeof organization !== "string" ||
    !organization.trim() ||
    organization !== organization.trim() ||
    organization === "local"
  )
    throw new ApiContextSessionError("organization-unavailable");
  if (
    options.expectedOrganizationId !== undefined &&
    options.expectedOrganizationId !== organization
  )
    throw new ApiContextSessionError("organization-mismatch");
  await assertCurrent({ signal: options.signal });

  const backend = new APIBackend({ getClient: async () => captured });
  const transport = Object.freeze({
    async createConversationMessageStream(
      conversationId: Parameters<Backend["createConversationMessageStream"]>[0],
      body: Parameters<Backend["createConversationMessageStream"]>[1],
      request?: ApiContextRequestOptions,
    ) {
      const prepared = requestOptions(request);
      await assertCurrent({ signal: prepared.signal });
      // Changes after this check cannot redirect the request: backend is pinned.
      return backend.createConversationMessageStream(
        conversationId,
        body,
        prepared,
      );
    },
    // Reconciliation reads/resume deliberately retain the original captured
    // principal even after ambient auth changes. Failure is not non-acceptance.
    listConversationMessages(
      conversationId: Parameters<Backend["listConversationMessages"]>[0],
      body?: Parameters<Backend["listConversationMessages"]>[1],
      request?: ApiContextRequestOptions,
    ) {
      return backend.listConversationMessages(
        conversationId,
        body,
        requestOptions(request),
      );
    },
    retrieveMessage(messageId: string, request?: ApiContextRequestOptions) {
      return backend.retrieveMessage(messageId, requestOptions(request));
    },
    retrieveRun(runId: string, request?: ApiContextRequestOptions) {
      return backend.retrieveRun(runId, requestOptions(request));
    },
    streamConversationMessages(
      conversationId: string,
      body: Parameters<Backend["streamConversationMessages"]>[1],
      request?: ApiContextRequestOptions,
    ) {
      return backend.streamConversationMessages(
        conversationId,
        body,
        requestOptions(request),
      );
    },
    streamRunMessages(
      runId: string,
      body: Parameters<Backend["streamRunMessages"]>[1],
      request?: ApiContextRequestOptions,
    ) {
      return backend.streamRunMessages(runId, body, requestOptions(request));
    },
    async cancelRun(agentId: string, runId: string) {
      await assertCurrent();
      return backend.cancelRun(agentId, runId);
    },
  });
  return Object.freeze({
    scope: Object.freeze({
      backend: backendIdentity,
      account: `organization:${organization}`,
    } satisfies ApiContextSessionScope),
    assertCurrent,
    transport,
  });
}

/** Public handle deliberately exposes no SDK client or credentials. */
export type ApiContextSession = Awaited<
  ReturnType<typeof captureApiContextSession>
>;
