import { expect, test } from "bun:test";
import Letta from "@letta-ai/letta-client";
import { APIBackend, type Backend } from "@/backend/backend";
import {
  type ApiContextRequestOptions,
  captureApiContextSession,
} from "./context-session";

type ClientOptions = NonNullable<ConstructorParameters<typeof Letta>[0]>;
function fixture(
  options: Pick<
    ClientOptions,
    "defaultHeaders" | "fetchOptions" | "defaultQuery"
  > = {},
) {
  let token = "secret-original";
  let organization: unknown = "org-one";
  let metadataStatus = 200;
  let duringMetadata: (() => void) | undefined;
  const calls: {
    url: string;
    authorization: string | null;
    method: string;
    headers: Headers;
    redirect?: NonNullable<ClientOptions["fetchOptions"]>["redirect"];
    credentials?: NonNullable<ClientOptions["fetchOptions"]>["credentials"];
  }[] = [];
  let sdkHeaders: ApiContextRequestOptions["headers"];
  class TestClient extends Letta {
    protected override validateHeaders(
      headers: NonNullable<ApiContextRequestOptions["headers"]>,
    ): void {
      sdkHeaders = headers;
    }
  }
  const client = new TestClient({
    baseURL: "https://first.example",
    apiKey: token,
    defaultHeaders: options.defaultHeaders ?? { "X-Remove": "default" },
    fetchOptions: options.fetchOptions,
    defaultQuery: options.defaultQuery,
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        headers: new Headers(init?.headers),
        redirect: init?.redirect,
        credentials: init?.credentials,
        authorization: new Headers(init?.headers).get("authorization"),
        method: init?.method ?? "GET",
      });
      if (url.endsWith("/v1/metadata/balance")) {
        duringMetadata?.();
        return Response.json(
          { organization_id: organization },
          { status: metadataStatus },
        );
      }
      if (
        init?.method === "POST" &&
        (url.endsWith("/messages") || url.endsWith("/stream"))
      ) {
        return new Response(
          'data: {"message_type":"stop_reason","stop_reason":"end_turn"}\n\ndata: [DONE]\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (url.includes("/runs/"))
        return Response.json({ id: "run-one", status: "completed" });
      return Response.json([]);
    },
  });
  Object.defineProperty(client, "apiKey", { get: () => token });
  let backend: Backend = new APIBackend({ getClient: async () => client });
  return {
    client,
    calls,
    sdkHeaders: () => sdkHeaders,
    options: { getBackend: () => backend, getClient: async () => client },
    token(value: string) {
      token = value;
    },
    organization(value: unknown) {
      organization = value;
    },
    metadataStatus(value: number) {
      metadataStatus = value;
    },
    duringMetadata(value: () => void) {
      duringMetadata = value;
    },
    backend(value: Backend) {
      backend = value;
    },
  };
}
const body = {
  messages: [{ role: "user" as const, content: "hello", otid: "human-otid" }],
};

test("metadata and message/history/run transport use the captured SDK session; public scope has no credentials", async () => {
  const f = fixture();
  const session = await captureApiContextSession(f.options);
  expect(session.scope).toEqual({
    backend: "https://first.example",
    account: "organization:org-one",
  });
  await session.transport.createConversationMessageStream("conv-one", body);
  await session.transport.listConversationMessages("conv-one");
  await session.transport.retrieveRun("run-one");
  await session.transport.retrieveMessage("message-one");
  await session.transport.streamConversationMessages("conv-one", {});
  await session.transport.streamRunMessages("run-one", {});
  await session.transport.cancelRun("agent-one", "run-one");
  expect(f.calls.map((call) => call.authorization)).toEqual(
    Array(8).fill("Bearer secret-original"),
  );
  expect(
    f.calls.every((call) => call.url.startsWith("https://first.example/")),
  ).toBe(true);
  expect(JSON.stringify(session)).not.toContain("secret-original");
  expect("forkConversation" in session.transport).toBe(false);
  expect("capabilities" in session.transport).toBe(false);
});

test("captured reconciliation reads retain frozen auth after rotation; dispatch fence refuses stale auth", async () => {
  const f = fixture();
  const session = await captureApiContextSession(f.options);
  f.token("secret-rotated");
  await session.transport.listConversationMessages("conv-one");
  expect(f.calls.at(-1)?.authorization).toBe("Bearer secret-original");
  await expect(session.assertCurrent()).rejects.toThrow("changed");
  await expect(
    session.transport.createConversationMessageStream("conv-one", body),
  ).rejects.toThrow("changed");
  expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  const rotated = await captureApiContextSession(f.options);
  expect(rotated.scope).toEqual(session.scope);
  await rotated.transport.createConversationMessageStream("conv-one", body);
  expect(f.calls.at(-1)?.authorization).toBe("Bearer secret-rotated");
});

test("endpoint, backend, and account switches cannot reuse a captured dispatch session", async () => {
  const f = fixture();
  const first = await captureApiContextSession(f.options);
  f.client.baseURL = "https://second.example";
  await expect(first.assertCurrent()).rejects.toThrow("changed");
  const second = await captureApiContextSession(f.options);
  expect(second.scope.backend).toBe("https://second.example");
  f.token("another-account-key");
  f.organization("org-two");
  await expect(second.assertCurrent()).rejects.toThrow("changed");
  const third = await captureApiContextSession(f.options);
  expect(third.scope.account).toBe("organization:org-two");
  f.backend(new APIBackend());
  await expect(third.assertCurrent()).rejects.toThrow("changed");
  await expect(
    captureApiContextSession({
      ...f.options,
      expectedOrganizationId: "org-one",
    }),
  ).rejects.toThrow("organization");
});

test.each([undefined, null, "", " ", "local", 42])(
  "missing/invalid organization fails closed: %s",
  async (organization) => {
    const f = fixture();
    f.organization(organization);
    await expect(captureApiContextSession(f.options)).rejects.toThrow(
      "organization",
    );
    expect(f.calls).toHaveLength(1);
  },
);

test("metadata error does not expose SDK error bodies or retry", async () => {
  const f = fixture();
  f.metadataStatus(500);
  await expect(captureApiContextSession(f.options)).rejects.toThrow(
    "unavailable",
  );
  expect(f.calls).toHaveLength(1);
});

test("cancellation and auth change during metadata resolution never publish a session", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    captureApiContextSession({ ...f.options, signal: controller.signal }),
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
  f.duringMetadata(() => f.token("changed-during-metadata"));
  await expect(captureApiContextSession(f.options)).rejects.toThrow("changed");
});

test("abort during metadata and missing expected organization never yield a usable session", async () => {
  const f = fixture();
  const controller = new AbortController();
  f.duringMetadata(() => controller.abort("private-abort-reason"));
  await expect(
    captureApiContextSession({ ...f.options, signal: controller.signal }),
  ).rejects.toThrow("cancelled");
  const clean = fixture();
  await expect(
    captureApiContextSession({
      ...clean.options,
      expectedOrganizationId: "org-other",
    }),
  ).rejects.toThrow("organization mismatch");
});

test("endpoint credentials and SDK request overrides cannot escape the captured session", async () => {
  const f = fixture();
  f.client.baseURL = "https://user:private-password@first.example";
  await expect(captureApiContextSession(f.options)).rejects.toThrow(
    "invalid endpoint",
  );
  expect(f.calls).toHaveLength(0);
  f.client.baseURL = "https://first.example";
  const session = await captureApiContextSession(f.options);
  await expect(
    session.transport.createConversationMessageStream("conv-one", body, {
      headers: { Authorization: "Bearer other-secret" },
    }),
  ).rejects.toThrow("transport override");
  const override = {
    defaultBaseURL: "https://elsewhere.example",
    signal: undefined,
  };
  await expect(
    session.transport.createConversationMessageStream(
      "conv-one",
      body,
      override,
    ),
  ).rejects.toThrow("transport override");
  expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(0);
});

test("backend switch while resolving credentials is refused before metadata", async () => {
  const f = fixture();
  await expect(
    captureApiContextSession({
      ...f.options,
      getClient: async () => {
        f.backend(new APIBackend());
        return f.client;
      },
    }),
  ).rejects.toThrow("changed");
  expect(f.calls).toHaveLength(0);
});

test("credential lookup failures are sanitized and a refused fence never changes previous dispatch evidence", async () => {
  const f = fixture();
  await expect(
    captureApiContextSession({
      ...f.options,
      getClient: async () => {
        throw new Error("private-secret");
      },
    }),
  ).rejects.toThrow("session unavailable");
  const session = await captureApiContextSession(f.options);
  await session.transport.createConversationMessageStream("conv-one", body);
  f.token("new-key");
  await expect(
    session.transport.createConversationMessageStream("conv-one", body),
  ).rejects.toThrow("changed");
  expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
});

test("endpoint namespaces preserve meaningful repeated path separators", async () => {
  const f = fixture();
  f.client.baseURL = "https://first.example/prefix//";
  const repeated = await captureApiContextSession(f.options);
  f.client.baseURL = "https://first.example/prefix/";
  const single = await captureApiContextSession(f.options);
  expect(single.scope.backend).not.toBe(repeated.scope.backend);
});

test("accepts exact normal host SDK options through the narrow Backend contract", async () => {
  const f = fixture();
  const session = await captureApiContextSession(f.options);
  const transport: Pick<Backend, "createConversationMessageStream"> =
    session.transport;
  const controller = new AbortController();
  await transport.createConversationMessageStream("conv-one", body, {
    maxRetries: 0,
    signal: controller.signal,
    headers: {
      "X-Letta-Acting-User-Id": "user-one",
      "X-Letta-Response-State": "state-one",
    },
  });
  expect(f.calls.at(-1)?.headers.get("X-Letta-Acting-User-Id")).toBe(
    "user-one",
  );
});

test("supports SDK header forms and rejects credential overrides including null removals", async () => {
  const f = fixture();
  const session = await captureApiContextSession(f.options);
  const branded = f.sdkHeaders();
  if (
    !branded ||
    !("values" in branded) ||
    !(branded.values instanceof Headers) ||
    !("nulls" in branded) ||
    !(branded.nulls instanceof Set)
  )
    throw new Error("Missing SDK NullableHeaders");
  for (const name of ["authorization", "x-project", "x-project-id"]) {
    branded.values.delete(name);
    branded.nulls.delete(name);
  }
  branded.values.set("X-Letta-Test", "value");
  branded.nulls.add("x-remove");
  const representations = [
    branded,
    new Headers({ "X-Letta-Test": "value" }),
    [["X-Letta-Test", "value"]],
    { "X-Letta-Test": ["value"], "X-Remove": null, "X-Ignore": undefined },
  ];
  for (const headers of representations) {
    await session.transport.createConversationMessageStream("conv-one", body, {
      maxRetries: 0,
      headers,
    });
    expect(f.calls.at(-1)?.headers.get("X-Letta-Test")).toBe("value");
  }
  for (const headers of [
    new Headers({ Authorization: "secret" }),
    [["AUTHORIZATION", null]],
  ]) {
    await expect(
      session.transport.createConversationMessageStream("conv-one", body, {
        headers,
      }),
    ).rejects.toThrow("transport override");
  }
  branded.nulls.add("authorization");
  await expect(
    session.transport.createConversationMessageStream("conv-one", body, {
      headers: branded,
    }),
  ).rejects.toThrow("transport override");
  for (const maxRetries of [1, -1, 2]) {
    await expect(
      session.transport.createConversationMessageStream("conv-one", body, {
        maxRetries,
      }),
    ).rejects.toThrow("transport override");
  }
});

test("snapshots SDK headers and scalar options before the asynchronous auth fence", async () => {
  const f = fixture();
  let pause = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const session = await captureApiContextSession({
    ...f.options,
    getClient: async () => {
      if (pause) await gate;
      return f.client;
    },
  });
  pause = true;
  const headers = [["X-Letta-Test", "original"]];
  const request: NonNullable<
    Parameters<Backend["createConversationMessageStream"]>[2]
  > = { maxRetries: 0, signal: null, headers };
  const pending = session.transport.createConversationMessageStream(
    "conv-one",
    body,
    request,
  );
  headers[0]?.splice(1, 1, "mutated");
  headers.push(["Authorization", "Bearer injected"]);
  request.maxRetries = 5;
  request.defaultBaseURL = "https://elsewhere.example";
  request.signal = AbortSignal.abort();
  release();
  await pending;
  expect(f.calls.at(-1)?.headers.get("X-Letta-Test")).toBe("original");
  expect(f.calls.at(-1)?.authorization).toBe("Bearer secret-original");
  expect(f.calls.at(-1)?.url).toContain("https://first.example/");
});

test("header snapshots preserve SDK null removals and record-array case semantics", async () => {
  const f = fixture();
  const session = await captureApiContextSession(f.options);
  await session.transport.createConversationMessageStream("conv-one", body, {
    headers: {
      "X-Letta-Test": "first",
      "x-letta-test": [],
      "X-Remove": null,
    },
  });
  expect(f.calls.at(-1)?.headers.get("X-Letta-Test")).toBe("first");
  expect(f.calls.at(-1)?.headers.has("X-Remove")).toBe(false);
});

test("inherited defaultHeaders cannot reauthenticate captured reads or dispatch", async () => {
  const defaults: Record<string, string> = { "X-Captured": "original" };
  const f = fixture({ defaultHeaders: defaults });
  const session = await captureApiContextSession(f.options);
  defaults.Authorization = "Bearer changed-secret";
  defaults["X-Captured"] = "changed";
  await session.transport.listConversationMessages("conv-one");
  expect(f.calls.at(-1)?.authorization).toBe("Bearer secret-original");
  expect(f.calls.at(-1)?.headers.get("X-Captured")).toBe("original");
  await expect(
    session.transport.createConversationMessageStream("conv-one", body),
  ).rejects.toThrow();
  expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(0);
});

test.each(["Authorization", "X-Project", "X-Project-Id"])(
  "rejects inherited principal override before metadata: %s",
  async (name) => {
    const f = fixture({ defaultHeaders: new Headers({ [name]: "override" }) });
    await expect(captureApiContextSession(f.options)).rejects.toThrow(
      "transport override",
    );
    expect(f.calls).toHaveLength(0);
  },
);

test("defaultHeaders mutation during metadata cannot publish a mismatched session", async () => {
  const defaults: Record<string, string> = {};
  const f = fixture({ defaultHeaders: defaults });
  f.duringMetadata(() => {
    defaults.Authorization = "Bearer changed-secret";
  });
  await expect(captureApiContextSession(f.options)).rejects.toThrow();
  expect(f.calls[0]?.authorization).toBe("Bearer secret-original");
});

test("isolates inherited fetchOptions from mutation for original dispatch and reads", async () => {
  const fetchOptions: NonNullable<ClientOptions["fetchOptions"]> = {
    cache: "no-store",
    redirect: "error",
  };
  const f = fixture({ fetchOptions });
  const session = await captureApiContextSession(f.options);
  fetchOptions.redirect = "follow";
  Reflect.set(fetchOptions, "headers", {
    Authorization: "Bearer changed-secret",
  });
  await session.transport.listConversationMessages("conv-one");
  expect(f.calls.at(-1)?.authorization).toBe("Bearer secret-original");
  expect(f.calls.at(-1)?.redirect).toBe("error");
  await expect(
    session.transport.createConversationMessageStream("conv-one", body),
  ).rejects.toThrow();
  expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(0);
});

test.each(["headers", "method", "body", "signal", "dispatcher"])(
  "rejects inherited fetchOptions routing/auth escape: %s",
  async (key) => {
    const fetchOptions: NonNullable<ClientOptions["fetchOptions"]> = {};
    Reflect.set(
      fetchOptions,
      key,
      key === "headers"
        ? new Headers({ Authorization: "Bearer override" })
        : "override",
    );
    const f = fixture({ fetchOptions });
    await expect(captureApiContextSession(f.options)).rejects.toThrow(
      "transport override",
    );
    expect(f.calls).toHaveLength(0);
  },
);

test("source mutation after the fence cannot alter frozen POST fetch options", async () => {
  const defaults: Record<string, string> = { "X-Captured": "original" };
  const fetchOptions: NonNullable<ClientOptions["fetchOptions"]> = {
    redirect: "error",
  };
  const f = fixture({ defaultHeaders: defaults, fetchOptions });
  const session = await captureApiContextSession(f.options);
  // The SDK builds headers asynchronously after the dispatch fence returns.
  const pending = session.transport.createConversationMessageStream(
    "conv-one",
    body,
  );
  queueMicrotask(() =>
    queueMicrotask(() => {
      defaults.Authorization = "Bearer changed-secret";
      fetchOptions.redirect = "follow";
      Reflect.set(fetchOptions, "headers", {
        Authorization: "Bearer fetch-override",
      });
    }),
  );
  await pending;
  expect(f.calls.at(-1)?.authorization).toBe("Bearer secret-original");
  expect(f.calls.at(-1)?.redirect).toBe("error");
});

test.each(["record", "tuples", "Headers"])(
  "rejects inherited fetchOptions.headers representation: %s",
  async (representation) => {
    const fetchOptions: NonNullable<ClientOptions["fetchOptions"]> = {};
    const headers =
      representation === "record"
        ? { Authorization: "Bearer override" }
        : representation === "tuples"
          ? [["Authorization", "Bearer override"]]
          : new Headers({ Authorization: "Bearer override" });
    Reflect.set(fetchOptions, "headers", headers);
    const f = fixture({ fetchOptions });
    await expect(captureApiContextSession(f.options)).rejects.toThrow(
      "transport override",
    );
    expect(f.calls).toHaveLength(0);
  },
);

test.each(["follow", "include", "same-origin"])(
  "rejects inherited redirect/cookie credential mode: %s",
  async (value) => {
    const fetchOptions: NonNullable<ClientOptions["fetchOptions"]> = {};
    Reflect.set(
      fetchOptions,
      value === "follow" ? "redirect" : "credentials",
      value,
    );
    const f = fixture({ fetchOptions });
    await expect(captureApiContextSession(f.options)).rejects.toThrow(
      "transport override",
    );
    expect(f.calls).toHaveLength(0);
  },
);

test("custom clients with nonempty defaultQuery fail before metadata", async () => {
  const f = fixture({ defaultQuery: { limit: "1" } });
  await expect(captureApiContextSession(f.options)).rejects.toThrow(
    "transport override",
  );
  expect(f.calls).toHaveLength(0);
});

test("mutating an initially empty defaultQuery cannot change captured history", async () => {
  const query: NonNullable<ClientOptions["defaultQuery"]> = {};
  const f = fixture({ defaultQuery: query });
  const session = await captureApiContextSession(f.options);
  query.limit = "999";
  await session.transport.listConversationMessages("conv-one");
  expect(new URL(f.calls.at(-1)?.url ?? "").search).toBe("");
  await session.transport.listConversationMessages("conv-one", { limit: 7 });
  expect(new URL(f.calls.at(-1)?.url ?? "").searchParams.get("limit")).toBe(
    "7",
  );
  await expect(session.assertCurrent()).rejects.toThrow();
});
