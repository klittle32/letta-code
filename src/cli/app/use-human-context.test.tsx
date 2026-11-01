import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { render, Text } from "ink";
import type { HumanPresentationEntry } from "@/agent/context-presentation";
import { getHostContextRecords } from "@/agent/host-context-records";
import { __testSetBackend, APIBackend } from "@/backend/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import { createBuffers } from "@/cli/helpers/accumulator";
import { useHumanContext } from "./use-human-context";

class Output extends Writable {
  frames: string[] = [];
  columns = 100;
  rows = 30;
  isTTY = true;
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void) {
    this.frames.push(String(chunk));
    done();
  }
}
const entry = (text: string): HumanPresentationEntry => ({
  id: `context:namespace:${text}`,
  record: {
    id: text,
    text,
    visibility: "human",
    storage: "host-local",
    sequence: 1,
  },
  placement: { after: null },
});
async function tick() {
  await Bun.sleep(30);
}
test("subscription precedes snapshot; activation/backend/workspace races and disposal cannot paint stale human content", async () => {
  const root = await mkdtemp(join(tmpdir(), "human-hook-"));
  const saved = process.env.LETTA_CONFIG_DIR;
  const savedToken = process.env.LETTA_API_KEY;
  process.env.LETTA_CONFIG_DIR = join(root, "config");
  const backend = new LocalBackend({
    storageDir: join(root, "store"),
    memfsEnabled: false,
    executionMode: "deterministic",
  });
  __testSetBackend(backend);
  const host = getHostContextRecords();
  const originalSnapshot = host.humanSnapshot,
    originalSubscribe = host.subscribeHuman,
    originalAssert = host.assertHumanCurrent;
  const pending: ((value: HumanPresentationEntry[]) => void)[] = [];
  let active = 0;
  const order: string[] = [];
  let invalidate: (() => void) | undefined;
  host.subscribeHuman = (...args) => {
    order.push("subscribe");
    active++;
    invalidate = args[2];
    const dispose = originalSubscribe(...args);
    return () => {
      active--;
      dispose();
    };
  };
  host.humanSnapshot = async () => {
    order.push("snapshot");
    return new Promise((resolve) => pending.push(resolve));
  };
  let assertions = 0;
  let epoch = 0;
  host.assertHumanCurrent = async () => {
    assertions++;
  };
  const buffers = { current: createBuffers() };
  function Harness({
    conversation = "c",
    workspace = "one",
  }: {
    conversation?: string;
    workspace?: string;
  }) {
    const projection = useHumanContext({
      agentId: "a",
      conversationId: conversation,
      resumeKey: 0,
      projectDirectory: workspace,
      staticItems: [
        {
          kind: "user",
          id: "normal-human",
          text: "Normal human",
          otid: "normal-human",
        },
      ],
      liveItems: [],
      buffersRef: buffers,
    });
    epoch = projection.epoch;
    return (
      <Text>
        {JSON.stringify([...projection.staticItems, ...projection.liveItems])}
      </Text>
    );
  }
  const stdout = new Output();
  const frame = () => stdout.frames.at(-1)?.replace(/\s+/g, " ");
  const app = render(<Harness />, {
    stdout: stdout as Output & NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  try {
    await tick();
    expect(order.slice(0, 2)).toEqual(["subscribe", "snapshot"]);
    expect(active).toBe(1);
    app.rerender(<Harness conversation="other" />);
    await tick();
    pending[0]?.([entry("OLD")]);
    pending[1]?.([entry("CURRENT")]);
    await tick();
    expect(frame()).toContain("CURRENT");
    expect(frame()).not.toContain("OLD");
    expect(active).toBe(1);
    app.rerender(<Harness conversation="other" workspace="two" />);
    await tick();
    expect(frame()).not.toContain("CURRENT");
    pending[2]?.([entry("CURRENT")]);
    await tick();
    expect(frame()).toContain("CURRENT");
    const assertionsBefore = assertions;
    for (let i = 0; i < 20; i++) {
      app.rerender(<Harness conversation="other" workspace="two" />);
      await tick();
    }
    expect(assertions).toBe(assertionsBefore);
    const epochBefore = epoch;
    invalidate?.();
    await tick();
    expect(frame()).toContain("CURRENT");
    expect(epoch).toBe(epochBefore);
    pending[3]?.([entry("CURRENT")]);
    await tick();
    expect(epoch).toBe(epochBefore);
    invalidate?.();
    await tick();
    pending[4]?.([entry("COMMITTED")]);
    await tick();
    expect(frame()).toContain("COMMITTED");
    const snapshotLoader = host.humanSnapshot;
    host.humanSnapshot = async () => {
      throw new Error("principal changed");
    };
    invalidate?.();
    await tick();
    expect(frame()).not.toContain("COMMITTED");
    expect(frame()).toContain("Host-local context unavailable");
    expect(frame()).toContain("Normal human");
    host.humanSnapshot = snapshotLoader;
    const next = new LocalBackend({
      storageDir: join(root, "next"),
      memfsEnabled: false,
      executionMode: "deterministic",
    });
    __testSetBackend(next);
    app.rerender(<Harness conversation="other" workspace="two" />);
    await tick();
    expect(frame()).not.toContain("COMMITTED");
    pending[5]?.([]);
    await tick();
    expect(active).toBe(1);
    host.humanSnapshot = async () => {
      throw new Error("metadata unavailable");
    };
    invalidate?.();
    await tick();
    expect(frame()).toContain("Host-local context unavailable");
    expect(frame()).not.toContain("COMMITTED");
    // Credentials can change without replacing the APIBackend object.
    host.humanSnapshot = snapshotLoader;
    process.env.LETTA_API_KEY = "fixture-one";
    __testSetBackend(new APIBackend());
    app.rerender(<Harness conversation="other" workspace="two" />);
    await tick();
    pending.at(-1)?.([entry("API_ORIGINAL")]);
    await tick();
    expect(frame()).toContain("API_ORIGINAL");
    process.env.LETTA_API_KEY = "fixture-two";
    app.rerender(<Harness conversation="other" workspace="two" />);
    await tick();
    expect(frame()).not.toContain("API_ORIGINAL");
    pending.at(-1)?.([entry("API_CURRENT")]);
    await tick();
    expect(frame()).toContain("API_CURRENT");
    const ownerEpoch = epoch;
    const beforeAsserts = assertions;
    for (let i = 0; i < 20; i++) {
      app.rerender(<Harness conversation="other" workspace="two" />);
      await tick();
    }
    expect(assertions).toBe(beforeAsserts);
    expect(epoch).toBe(ownerEpoch);
    invalidate?.();
    await tick();
    expect(frame()).toContain("API_CURRENT");
    const stale = pending.at(-1);
    process.env.LETTA_API_KEY = "fixture-three";
    // No parent rerender: completion itself must detect the changed owner.
    stale?.([entry("API_STALE")]);
    await tick();
    expect(frame()).not.toContain("API_STALE");
    expect(frame()).not.toContain("API_CURRENT");
    pending.at(-1)?.([entry("API_NEW")]);
    await tick();
    expect(frame()).toContain("API_NEW");
    process.env.LETTA_API_KEY = "fixture-four";
    invalidate?.();
    await tick();
    expect(frame()).not.toContain("API_NEW");
    pending.at(-1)?.([]);
    await tick();
    app.unmount();
    await tick();
    expect(active).toBe(0);
    invalidate?.();
    await tick();
    expect(active).toBe(0);
  } finally {
    app.unmount();
    app.cleanup();
    host.humanSnapshot = originalSnapshot;
    host.subscribeHuman = originalSubscribe;
    host.assertHumanCurrent = originalAssert;
    __testSetBackend(null);
    if (savedToken === undefined) delete process.env.LETTA_API_KEY;
    else process.env.LETTA_API_KEY = savedToken;
    if (saved === undefined) delete process.env.LETTA_CONFIG_DIR;
    else process.env.LETTA_CONFIG_DIR = saved;
    await rm(root, { recursive: true, force: true });
  }
});
