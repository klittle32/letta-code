import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backend } from "@/backend/backend";
import { LocalBackend } from "./local-backend";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "local-context-storage-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("local conversation storage identity", () => {
  test("identifies the ordinary shared provider and transcript store", () => {
    const storageDir = temporaryDirectory();
    const backend: Backend = new LocalBackend({
      storageDir,
      memfsEnabled: false,
    });

    expect(backend.localConversationStorageDir).toBe(storageDir);
    expect(backend.getLocalStorageDir?.()).toBe(storageDir);
  });

  test("identifies the persisted transcript store, not provider storage", async () => {
    const storageDir = temporaryDirectory();
    const stateStorageDir = temporaryDirectory();
    const backend = new LocalBackend({
      storageDir,
      stateStorageDir,
      memfsEnabled: false,
    });
    const agent = await backend.createAgent({ name: "Storage identity test" });
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    });

    expect(backend.getLocalStorageDir()).toBe(storageDir);
    expect(backend.localConversationStorageDir).toBe(stateStorageDir);
    const restored = new LocalBackend({
      storageDir: backend.localConversationStorageDir,
      memfsEnabled: false,
    });
    expect(
      (await restored.retrieveConversation(conversation.id)).agent_id,
    ).toBe(agent.id);
    expect(await backend.latestConversationRun(conversation.id)).toBeNull();
  });

  test("distinguishes transcripts sharing one provider configuration", () => {
    const storageDir = temporaryDirectory();
    const first = new LocalBackend({
      storageDir,
      stateStorageDir: temporaryDirectory(),
      memfsEnabled: false,
    });
    const second = new LocalBackend({
      storageDir,
      stateStorageDir: temporaryDirectory(),
      memfsEnabled: false,
    });

    expect(first.getLocalStorageDir()).toBe(second.getLocalStorageDir());
    expect(first.localConversationStorageDir).not.toBe(
      second.localConversationStorageDir,
    );
  });

  test("captures the configured store rather than rereading mutated options", () => {
    const stateStorageDir = temporaryDirectory();
    const options = {
      storageDir: temporaryDirectory(),
      stateStorageDir,
      memfsEnabled: false,
    };
    const backend = new LocalBackend(options);
    options.stateStorageDir = temporaryDirectory();

    expect(backend.localConversationStorageDir).toBe(stateStorageDir);
  });
});
