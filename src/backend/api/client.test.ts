import { afterEach, describe, expect, test } from "bun:test";
import { getClientDefaultHeaders } from "./client";
import { getLettaCodeHeaders } from "./http-headers";

const RUNTIME_ENVIRONMENT_DEVICE_ID_ENV = "LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID";
const ACTING_USER_ID_ENV = "LETTA_ACTING_USER_ID";
const originalRuntimeEnvironmentDeviceId =
  process.env[RUNTIME_ENVIRONMENT_DEVICE_ID_ENV];
const originalActingUserId = process.env[ACTING_USER_ID_ENV];

afterEach(() => {
  if (originalRuntimeEnvironmentDeviceId === undefined) {
    delete process.env[RUNTIME_ENVIRONMENT_DEVICE_ID_ENV];
  } else {
    process.env[RUNTIME_ENVIRONMENT_DEVICE_ID_ENV] =
      originalRuntimeEnvironmentDeviceId;
  }
  if (originalActingUserId === undefined) {
    delete process.env[ACTING_USER_ID_ENV];
  } else {
    process.env[ACTING_USER_ID_ENV] = originalActingUserId;
  }
});

describe("getClientDefaultHeaders", () => {
  test("uses the managed runtime device identity for environment attribution", () => {
    process.env[RUNTIME_ENVIRONMENT_DEVICE_ID_ENV] = "  sandbox-agent-test  ";

    expect(getClientDefaultHeaders()["X-Letta-Environment-Device-Id"]).toBe(
      "sandbox-agent-test",
    );
  });
});

describe("getLettaCodeHeaders", () => {
  test("attributes direct API requests to the inherited acting user", () => {
    process.env[ACTING_USER_ID_ENV] = "  user-requester  ";

    expect(getLettaCodeHeaders("test-key")).toMatchObject({
      Authorization: "Bearer test-key",
      "X-Letta-Acting-User-Id": "user-requester",
    });
  });

  test("allows a request to suppress the inherited acting user", () => {
    process.env[ACTING_USER_ID_ENV] = "user-requester";

    expect(getLettaCodeHeaders("test-key", null)).not.toHaveProperty(
      "X-Letta-Acting-User-Id",
    );
  });
});

test("configuration identity is opaque, stable and detects memory-only credential changes without client work", async () => {
  const { getClientConfigurationIdentity, __testOverrideGetClient } =
    await import("./client");
  const saved = process.env.LETTA_API_KEY;
  let calls = 0;
  __testOverrideGetClient(async () => {
    calls++;
    throw new Error("must not read auth");
  });
  try {
    process.env.LETTA_API_KEY = "fixture-old";
    const first = getClientConfigurationIdentity();
    for (let i = 0; i < 20; i++)
      expect(getClientConfigurationIdentity()).toBe(first);
    process.env.LETTA_API_KEY = "fixture-new";
    expect(getClientConfigurationIdentity()).not.toBe(first);
    expect(Object.keys(getClientConfigurationIdentity())).toEqual([]);
    expect(calls).toBe(0);
  } finally {
    __testOverrideGetClient(null);
    if (saved === undefined) delete process.env.LETTA_API_KEY;
    else process.env.LETTA_API_KEY = saved;
  }
});
