import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContextInbox } from "./context-inbox";

let directory: string;
const scope = {
  backend: "https://api.example/v1",
  account: "account-a",
  agent: "agent-a",
  conversation: "default",
};
const open = (identity = scope) =>
  createContextInbox({ directory, scope: identity });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "context-inbox-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("host-local receipts survive reopening, retry identically, and reject conflicts", async () => {
  const inbox = open();
  const receipt = await inbox.record({
    id: "collaborator:1",
    text: "hello",
    visibility: "both",
  });
  expect(receipt).toMatchObject({
    storage: "host-local",
    id: "collaborator:1",
    sequence: 1,
  });
  expect(
    await open().record({
      id: "collaborator:1",
      text: "hello",
      visibility: "both",
    }),
  ).toEqual(receipt);
  await expect(
    inbox.record({ id: "collaborator:1", text: "changed", visibility: "both" }),
  ).rejects.toThrow("conflict");
  await expect(
    inbox.record({ id: "collaborator:1", text: "hello", visibility: "human" }),
  ).rejects.toThrow("conflict");
});

test("allocates ordered sequences under concurrent writers and filters visibility", async () => {
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      open().record({
        id: String(i),
        text: String(i),
        visibility: i % 3 === 0 ? "human" : i % 3 === 1 ? "model" : "both",
      }),
    ),
  );
  const all = await open().list();
  expect(all.map((r) => r.sequence)).toEqual(
    Array.from({ length: 12 }, (_, i) => i + 1),
  );
  expect(await open().list("human")).toHaveLength(8);
  expect(await open().list("model")).toHaveLength(8);
  const first = all[0];
  if (!first) throw new Error("Missing first record");
  first.text = "mutated";
  expect((await open().list())[0]?.text).not.toBe("mutated");
});

test("normalizes explicit identity and isolates every scope dimension", async () => {
  await open().record({ id: "same", text: "a", visibility: "both" });
  expect(await open({ ...scope, account: " account-a " }).list()).toHaveLength(
    1,
  );
  for (const key of ["backend", "account", "agent", "conversation"] as const) {
    expect(
      await open({ ...scope, [key]: `${scope[key]}-other` }).list(),
    ).toEqual([]);
    expect(() => open({ ...scope, [key]: " " })).toThrow();
  }
});

test("freezes only pending model context for an explicit submission", async () => {
  const inbox = open();
  await inbox.record({ id: "h", text: "human", visibility: "human" });
  await inbox.record({ id: "m", text: "model", visibility: "model" });
  const binding = await inbox.bindExplicitSubmission("submit-1");
  expect(binding.records.map((r) => r.id)).toEqual(["m"]);
  await inbox.record({ id: "later", text: "later", visibility: "both" });
  expect(await open().bindExplicitSubmission("submit-1")).toEqual(binding);
  expect(
    (await inbox.bindExplicitSubmission("submit-2")).records.map((r) => r.id),
  ).toEqual(["later"]);
  expect((await inbox.list("human")).map((r) => r.id)).toEqual(["h", "later"]);
});

test("dispatch is durably uncertain before network work; only explicit evidence settles it", async () => {
  const inbox = open();
  await inbox.record({ id: "m", text: "model", visibility: "model" });
  await inbox.bindExplicitSubmission("submit-1");
  expect((await inbox.markDispatch("submit-1")).outcome).toBe("uncertain");
  expect((await open().getSubmission("submit-1"))?.outcome).toBe("uncertain");
  expect((await open().bindExplicitSubmission("next")).records).toEqual([]);
  await inbox.settleSubmission("submit-1", "accepted");
  await expect(
    inbox.settleSubmission("submit-1", "rejected"),
  ).rejects.toThrow();
  expect((await open().bindExplicitSubmission("third")).records).toEqual([]);
});

test("definite rejection or pre-dispatch cancellation releases records without changing old bindings", async () => {
  const inbox = open();
  await inbox.record({ id: "m", text: "model", visibility: "both" });
  await inbox.bindExplicitSubmission("cancelled");
  await inbox.settleSubmission("cancelled", "rejected");
  const retry = await inbox.bindExplicitSubmission("retry");
  expect(retry.records.map((r) => r.id)).toEqual(["m"]);
  await expect(inbox.markDispatch("cancelled")).rejects.toThrow();
  await inbox.markDispatch("retry");
  await inbox.settleSubmission("retry", "uncertain");
  await inbox.settleSubmission("retry", "rejected");
  expect((await inbox.bindExplicitSubmission("final")).records).toHaveLength(1);
});

test("corruption fails closed instead of silently losing records", async () => {
  const inbox = open();
  await inbox.record({ id: "a", text: "a", visibility: "both" });
  const { readdir } = await import("node:fs/promises");
  const file = (await readdir(directory)).find((name) =>
    name.endsWith(".json"),
  );
  if (!file) throw new Error("Missing inbox snapshot");
  await writeFile(join(directory, file), '{"records":[]}');
  await expect(inbox.list()).rejects.toThrow();
});

test("recovers an uncertain submission and dead writer lock after SIGKILL, including under bundled Node", async () => {
  const moduleUrl = new URL("./context-inbox.ts", import.meta.url).href;
  const lockUrl = new URL("../utils/file-lock.ts", import.meta.url).href;
  const script = `
    import { createContextInbox } from ${JSON.stringify(moduleUrl)};
    import { withFileLock } from ${JSON.stringify(lockUrl)};
    import { readdir } from 'node:fs/promises';
    import { join } from 'node:path';
    const directory = ${JSON.stringify(directory)};
    const inbox = createContextInbox({ directory, scope: ${JSON.stringify(scope)} });
    await inbox.record({ id: 'crashed', text: 'committed', visibility: 'both' });
    await inbox.bindExplicitSubmission('crashed-submit');
    await inbox.markDispatch('crashed-submit');
    const file = (await readdir(directory)).find(name => name.endsWith('.json'));
    await withFileLock(join(directory, file + '.lock'), async () => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(directory, file + '.crashed.tmp'), '{partial');
      console.log('locked');
      await new Promise(() => setInterval(() => {}, 1000));
    }, { reapOnlyDeadOwner: true });
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("locked");
    reader.releaseLock();
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
  const bundled = join(directory, "inbox.mjs");
  const built = await Bun.build({
    entrypoints: [new URL("./context-inbox.ts", import.meta.url).pathname],
    target: "node",
  });
  expect(built.success).toBe(true);
  const output = built.outputs[0];
  if (!output) throw new Error("Missing Node bundle");
  await writeFile(bundled, await output.text());
  const nodeScript = `
    import assert from 'node:assert/strict';
    import { createContextInbox } from ${JSON.stringify(new URL(`file://${bundled}`).href)};
    const inbox = createContextInbox({ directory: ${JSON.stringify(directory)}, scope: ${JSON.stringify(scope)} });
    assert.equal((await inbox.listSubmissions())[0].outcome, 'uncertain');
    assert.equal((await inbox.bindExplicitSubmission('new-submit')).records.length, 0);
    assert.equal((await inbox.record({ id: 'crashed', text: 'committed', visibility: 'both' })).sequence, 1);
    await inbox.settleSubmission('crashed-submit', 'accepted');
    assert.equal((await inbox.getSubmission('crashed-submit')).outcome, 'accepted');
    console.log('node recovery passed');
  `;
  const node = Bun.spawn(["node", "--input-type=module", "-e", nodeScript], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    node.exited,
    new Response(node.stdout).text(),
    new Response(node.stderr).text(),
  ]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(stdout).toContain("node recovery passed");
  expect((await open().getSubmission("crashed-submit"))?.outcome).toBe(
    "accepted",
  );
}, 15000);

test("concurrent submissions reserve disjoint records and settlement guards fail closed", async () => {
  const inbox = open();
  await inbox.record({ id: "context", text: "unchanged", visibility: "model" });
  const bindings = await Promise.all([
    inbox.bindExplicitSubmission("one"),
    open().bindExplicitSubmission("two"),
  ]);
  expect(
    bindings.flatMap((binding) => binding.records.map((record) => record.id)),
  ).toEqual(["context"]);
  const owner = bindings.find((binding) => binding.records.length > 0);
  if (!owner) throw new Error("Missing owner");
  await expect(inbox.settleSubmission(owner.id, "accepted")).rejects.toThrow(
    "Mark dispatch",
  );
  await expect(inbox.markDispatch("unknown")).rejects.toThrow("Unknown");
  owner.records.length = 0;
  expect((await inbox.getSubmission(owner.id))?.records).toHaveLength(1);
  await inbox.markDispatch(owner.id);
  await inbox.markDispatch(owner.id);
  await inbox.settleSubmission(owner.id, "accepted");
  await inbox.settleSubmission(owner.id, "accepted");
  expect(
    (await inbox.listSubmissions()).find((item) => item.id === owner.id)
      ?.outcome,
  ).toBe("accepted");
});

test("binding persists a unique UUID and exact request fingerprint, failing closed on corrupt identities", async () => {
  const inbox = open();
  const fingerprint = "a".repeat(64);
  const first = await inbox.bindExplicitSubmission("one", fingerprint);
  expect(await open().bindExplicitSubmission("one", fingerprint)).toEqual(
    first,
  );
  expect(first.requestFingerprint).toBe(fingerprint);
  const second = await inbox.bindExplicitSubmission("two");
  expect(second.contextMessageOtid).not.toBe(first.contextMessageOtid);
  await expect(
    inbox.bindExplicitSubmission("one", "b".repeat(64)),
  ).rejects.toMatchObject({ code: "submission-identity-conflict" });
  await expect(
    inbox.bindExplicitSubmission("two", fingerprint),
  ).rejects.toMatchObject({ code: "submission-identity-conflict" });
  const { readdir, readFile } = await import("node:fs/promises");
  const file = (await readdir(directory)).find((name) =>
    name.endsWith(".json"),
  );
  if (!file) throw new Error("Missing snapshot");
  const path = join(directory, file);
  const original = await readFile(path, "utf8");
  for (const corrupt of [
    (state: Record<string, unknown>[]) => {
      delete state[0]?.contextMessageOtid;
    },
    (state: Record<string, unknown>[]) => {
      if (state[0]) state[0].contextMessageOtid = "not-a-uuid";
    },
    (state: Record<string, unknown>[]) => {
      if (state[0]) state[0].requestFingerprint = "invalid";
    },
    (state: Record<string, unknown>[]) => {
      if (state[1]) state[1].contextMessageOtid = first.contextMessageOtid;
    },
  ]) {
    const state = JSON.parse(original);
    corrupt(state.submissions);
    await writeFile(path, JSON.stringify(state));
    await expect(open().listSubmissions()).rejects.toThrow(
      "Corrupt context inbox",
    );
    expect(await readFile(path, "utf8")).toBe(JSON.stringify(state));
  }
});

test("human placement commits with record and stays immutable across retry/restart", async () => {
  const input = {
    id: "human-context",
    text: "visible",
    visibility: "both" as const,
  };
  await open().record(input, {
    after: { otid: "human-1", messageId: "message-1" },
  });
  await open().record(input, { after: { otid: "later" } });
  expect(await open().humanEntries()).toEqual([
    {
      record: expect.objectContaining(input),
      placement: { after: { otid: "human-1", messageId: "message-1" } },
    },
  ]);
  await expect(
    open().record({ ...input, text: "changed" }, { after: null }),
  ).rejects.toThrow("conflict");
  expect(await open().humanEntries()).toHaveLength(1);
  expect(
    (await open().bindExplicitSubmission("human-2")).records.map((r) => r.id),
  ).toEqual([input.id]);
  await open().record(
    { id: "only-human", text: "never model", visibility: "human" },
    { after: null },
  );
  expect((await open().bindExplicitSubmission("human-3")).records).toEqual([]);
});
