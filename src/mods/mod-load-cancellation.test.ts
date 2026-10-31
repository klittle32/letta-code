import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModEngine } from "./mod-engine";

test("cancelled hanging reload fences late registration and permits another reload", async () => {
  const root = mkdtempSync(join(tmpdir(), "mod-load-cancel-"));
  const state = { release: undefined as (() => void) | undefined, disposed: 0 };
  const globals = globalThis as typeof globalThis & {
    __modCancel?: typeof state;
  };
  globals.__modCancel = state;
  writeFileSync(
    join(root, "hang.ts"),
    `export default async function(letta){const s=globalThis.__modCancel;await new Promise(r=>s.release=r);letta.commands.register({id:"late",description:"late",run(){return {type:"handled"}}});return ()=>{s.disposed++};}`,
  );
  const engine = createModEngine({
    globalModsDirectory: root,
    cacheDirectory: join(root, "cache"),
    registerCapabilitiesGlobally: false,
    getClient: async () => {
      throw new Error("unused");
    },
  });
  try {
    const cancel = new AbortController();
    const loading = engine.reload(cancel.signal);
    while (!state.release) await Bun.sleep(1);
    cancel.abort();
    await expect(loading).rejects.toThrow("cancelled");
    state.release();
    await Bun.sleep(10);
    expect(engine.getSnapshot().commands.late).toBeUndefined();
    expect(state.disposed).toBe(1);
    rmSync(join(root, "hang.ts"));
    await engine.reload();
    expect(engine.getSnapshot().loadedPaths).toEqual([]);
  } finally {
    engine.dispose();
    delete globals.__modCancel;
    rmSync(root, { recursive: true, force: true });
  }
});
