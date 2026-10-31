import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { render } from "ink";
import stripAnsi from "strip-ansi";
import { __testSetBackend } from "@/backend";
import {
  resolveBackendMode,
  setConfiguredBackendMode,
} from "@/backend/backend-mode";
import { LocalBackend } from "@/backend/local/local-backend";
import { App } from "@/cli/App";
import type { ModSessionActivationResult } from "@/mods/types";
import { permissionMode } from "@/permissions/mode";
import { settingsManager } from "@/settings-manager";
import {
  addToMessageQueue,
  clearPendingMessages,
  isQueueBridgeConnected,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";

async function until(
  predicate: () => boolean,
  label: string,
  timeoutMs = 7000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  if (!predicate()) throw new Error(`Timed out: ${label}`);
}
class Output extends Writable {
  columns = 100;
  rows = 36;
  isTTY = true;
  frames: string[] = [];
  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    done: () => void,
  ) {
    this.frames.push(stripAnsi(chunk.toString()));
    done();
  }
}
type State = {
  latePrompt: boolean;
  onReload?: () => void;
  target: string;
  destination: string;
  loads: number;
  disposed: number;
  closed: string[];
  result?: ModSessionActivationResult;
  opened: Array<{ id: string; cwd: string }>;
};
const globalState = globalThis as typeof globalThis & {
  __activationFixture?: State;
};
test.each([
  "allow",
  "escape",
  "chdir-failure",
  "source-failure",
  "destination-failure",
  "late-prompt",
  "reload-failure",
  "prepare-failure",
  "notification",
  "reload-hang",
])(
  "native exact fresh activation: %s, detached invocation and no inference",
  async (choice) => {
    const root = mkdtempSync(join(tmpdir(), "tui-activate-"));
    const cwd = process.cwd();
    const home = process.env.HOME;
    const userCwd = process.env.USER_CWD;
    const disabled = process.env.LETTA_DISABLE_MODS;
    const mode = resolveBackendMode();
    const localEnv = process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
    process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL = "1";
    const source = join(root, "source");
    const destination = join(root, "destination");
    const testHome = join(root, "home");
    for (const path of [source, destination, testHome])
      mkdirSync(path, { recursive: true });
    process.chdir(source);
    process.env.HOME = testHome;
    process.env.USER_CWD = source;
    delete process.env.LETTA_DISABLE_MODS;
    if (choice === "source-failure" || choice === "destination-failure") {
      const directory = choice === "source-failure" ? source : destination;
      mkdirSync(join(directory, ".letta"), { recursive: true });
      const event = choice === "source-failure" ? "SessionEnd" : "SessionStart";
      writeFileSync(
        join(directory, ".letta", "settings.json"),
        JSON.stringify({
          hooks: {
            [event]: [
              { matcher: "*", hooks: [{ type: "command", command: "exit 1" }] },
            ],
          },
        }),
      );
    }
    setConfiguredBackendMode("local");
    clearPendingMessages();
    await settingsManager.reset();
    await settingsManager.initialize();
    await settingsManager.loadProjectSettings(source);
    await settingsManager.loadLocalProjectSettings(source);
    const originalPermission = permissionMode.getMode();
    let inference = 0;
    const backend = new LocalBackend({
      storageDir: join(root, "store"),
      memfsEnabled: false,
      executor: {
        async execute() {
          inference++;
          throw new Error("activation must not infer");
        },
      },
    });
    __testSetBackend(backend);
    const agent = await backend.createAgent({
      name: "Activation fixture",
      model: "openai/test",
    });
    const active = await backend.createConversation({ agent_id: agent.id });
    const state: State = {
      latePrompt: choice === "late-prompt",
      onReload:
        choice === "notification"
          ? () =>
              addToMessageQueue({
                kind: "task_notification",
                text: "Original source notification",
                agentId: agent.id,
                conversationId: active.id,
              })
          : undefined,
      target: "",
      destination,
      loads: 0,
      disposed: 0,
      closed: [],
      opened: [],
    };
    globalState.__activationFixture = state;
    const mods = join(testHome, ".letta", "mods");
    mkdirSync(mods, { recursive: true });
    writeFileSync(
      join(mods, "activation.ts"),
      `export default function(letta){
 const state=globalThis.__activationFixture;state.loads++;if(state.loads>1)state.onReload?.();
 letta.commands.register({id:"prepare",description:"Create public target",async run(ctx){state.target=(await ctx.conversation.create({title:"Saved fresh target"})).id;return {type:"handled"};}});
 letta.events.on("conversation_close",event=>{state.closed.push(event.conversationId);});
 letta.commands.register({id:"activate",description:"Activation fixture",run(ctx){const activation=ctx.session.activate({conversationId:state.target,workingDirectory:state.destination});if(state.latePrompt)return activation.then(async result=>{state.result=result;await new Promise(resolve=>setTimeout(resolve,50));return {type:"prompt",content:"MUST NOT SEND TO DESTINATION"};});void activation.then(result=>{state.result=result;});return {type:"handled"};}});
 letta.events.on("conversation_open",(event,ctx)=>{state.opened.push({id:event.conversationId,cwd:ctx.cwd});});
 return ()=>{state.disposed++;};
 }`,
    );
    const originalChdir = process.chdir.bind(process);
    if (choice === "chdir-failure")
      process.chdir = (path) => {
        if (path === destination) throw new Error("injected chdir failure");
        originalChdir(path);
      };
    const loaded: string[] = [];
    const loadProject =
      settingsManager.loadProjectSettings.bind(settingsManager);
    settingsManager.loadProjectSettings = async (path) => {
      loaded.push(path ?? process.cwd());
      if (choice === "prepare-failure" && path === destination)
        throw new Error("injected preparation failure");
      return loadProject(path);
    };
    const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
    stdin.isTTY = true;
    stdin.setRawMode = () => stdin;
    stdin.ref = () => stdin;
    stdin.unref = () => stdin;
    const output = new Output();
    const app = render(
      <App
        agentId={agent.id}
        agentState={agent}
        conversationId={active.id}
        systemInfoReminderEnabled={false}
      />,
      {
        stdin,
        stdout: output as Output & NodeJS.WriteStream,
        patchConsole: false,
        debug: true,
        exitOnCtrlC: false,
      },
    );
    try {
      await until(() => isQueueBridgeConnected() && state.loads > 0, "ready");
      await Bun.sleep(120);
      stdin.push("/prepare");
      await Bun.sleep(30);
      stdin.push("\r");
      await until(() => !!state.target, "public fresh creation");
      await Bun.sleep(120);
      stdin.push("/activate");
      await Bun.sleep(30);
      stdin.push("\r");
      await until(
        () =>
          !!state.result ||
          output.frames.some((frame) =>
            /trusts destination\s+project settings/.test(frame),
          ),
        "native trust question",
      );
      expect(state.result).toBeUndefined();
      expect(process.cwd()).toBe(source);
      expect(loaded).not.toContain(destination);
      expect(inference).toBe(0);
      if (choice === "reload-hang")
        writeFileSync(
          join(mods, "activation.ts"),
          "export default async function(){await new Promise(()=>{});}",
        );
      if (choice === "reload-failure")
        writeFileSync(
          join(mods, "activation.ts"),
          "export default function( {",
        );
      await Bun.sleep(100);
      stdin.push(choice === "escape" ? "\u001b" : "\r");
      await until(() => !!state.result, "activation result");
      if (
        choice === "allow" ||
        choice === "destination-failure" ||
        choice === "late-prompt" ||
        choice === "reload-failure" ||
        choice === "notification" ||
        choice === "reload-hang"
      ) {
        expect(state.result).toEqual({
          status: "activated",
          initialization: "pending",
          conversationId: state.target,
          workingDirectory: destination,
        });
        if (choice !== "reload-failure" && choice !== "reload-hang") {
          await until(
            () => state.opened.some((event) => event.id === state.target),
            "destination lifecycle",
          );
          expect(state.disposed).toBeGreaterThan(0);
          expect(state.loads).toBeGreaterThan(1);
          expect(
            state.opened.find((event) => event.id === state.target)?.cwd,
          ).toBe(destination);
        }
        expect(process.cwd()).toBe(destination);
        expect(loaded).toContain(destination);
        expect(
          settingsManager.getLocalLastSession(destination)?.conversationId,
        ).toBe(state.target);
        if (
          choice === "destination-failure" ||
          choice === "reload-failure" ||
          choice === "reload-hang"
        )
          await until(
            () =>
              output.frames.some((frame) =>
                frame.includes("Session activation initialization failed"),
              ),
            "surfaced startup error",
            15000,
          );
      } else {
        expect(state.result?.status).toBe("refused");
        if (choice === "prepare-failure") expect(state.closed).toEqual([]);
        expect(process.cwd()).toBe(source);
        if (choice !== "escape") {
          expect(loaded).toContain(destination);
          expect(loaded.at(-1)).toBe(source);
        } else expect(loaded).not.toContain(destination);
      }
      if (choice === "late-prompt" || choice === "notification")
        await Bun.sleep(150);
      if (choice === "notification")
        expect(
          output.frames.some(
            (frame) =>
              frame.includes("Parked notification") &&
              frame.includes(active.id),
          ),
        ).toBe(true);
      if (choice === "reload-hang") {
        await Bun.sleep(100);
        stdin.push("/help");
        await Bun.sleep(30);
        stdin.push("\r");
        await until(
          () => output.frames.some((frame) => frame.includes("Commands (")),
          "input unlocked after incomplete initialization",
        );
        expect(state.opened.some((event) => event.id === state.target)).toBe(
          false,
        );
      }
      expect(permissionMode.getMode()).toBe(originalPermission);
      expect(inference).toBe(0);
    } catch (error) {
      writeFileSync(
        `/tmp/activation-native-${choice}.txt`,
        output.frames.join("\n"),
      );
      throw error;
    } finally {
      app.unmount();
      app.cleanup();
      settingsManager.loadProjectSettings = loadProject;
      setMessageQueueAdder(null);
      clearPendingMessages();
      __testSetBackend(null);
      await settingsManager.reset();
      process.chdir = originalChdir;
      process.chdir(cwd);
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
      if (userCwd === undefined) delete process.env.USER_CWD;
      else process.env.USER_CWD = userCwd;
      if (disabled === undefined) delete process.env.LETTA_DISABLE_MODS;
      else process.env.LETTA_DISABLE_MODS = disabled;
      if (localEnv === undefined)
        delete process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
      else process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL = localEnv;
      setConfiguredBackendMode(mode);
      delete globalState.__activationFixture;
      rmSync(root, { recursive: true, force: true });
    }
  },
  20000,
);
