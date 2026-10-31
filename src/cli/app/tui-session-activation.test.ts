import { expect, test } from "bun:test";
import {
  createTuiSessionActivation,
  type TuiSessionActivationDependencies,
} from "./tui-session-activation";

function fixture() {
  let generation = 0;
  let busy: string | undefined;
  let locked = false;
  let committed = false;
  let asked = 0;
  const phases: string[] = [];
  const signal = new AbortController();
  const scope = {
    agentId: "agent",
    conversationId: "source",
    workingDirectory: "/source",
    generation: 0,
  };
  const deps: TuiSessionActivationDependencies = {
    scope: () => ({ ...scope, generation }),
    blocked: () => busy,
    setLocked: (value: boolean) => {
      locked = value;
    },
    resolve: async () => "/destination",
    validateTarget: async () => {},
    guard: () => {},
    ask: async () => {
      asked++;
      return true;
    },
    endSource: async () => {
      phases.push("end");
    },
    prepare: async () => {
      phases.push("prepare");
    },
    restore: async () => {
      phases.push("restore");
    },
    commit: () => {
      committed = true;
      phases.push("commit");
    },
    initialize: async () => {
      phases.push("initialize");
    },
    report: (_error: unknown) => {},
  };
  const activate = createTuiSessionActivation(deps);
  const request = {
    agentId: "agent",
    sourceConversationId: "source",
    sourceWorkingDirectory: "/source",
    conversationId: "fresh",
    workingDirectory: "/destination",
    signal: signal.signal,
    owner: {
      id: "mod",
      generation: 0,
      path: "fixture.ts",
      scope: "global" as const,
    },
  };
  return {
    deps,
    activate,
    request,
    signal,
    phases,
    change: () => {
      generation++;
    },
    busy: (value: string) => {
      busy = value;
    },
    get locked() {
      return locked;
    },
    get committed() {
      return committed;
    },
    get asked() {
      return asked;
    },
  };
}
test("fresh activation commits exact destination only after trust; initialization is detached", async () => {
  const f = fixture();
  let release!: () => void;
  f.deps.initialize = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  expect(await f.activate(f.request)).toEqual({
    status: "activated",
    initialization: "pending",
    conversationId: "fresh",
    workingDirectory: "/destination",
  });
  expect(f.phases).toEqual(["prepare", "end", "commit"]);
  expect(f.locked).toBe(true);
  release();
  await Bun.sleep(1);
  expect(f.locked).toBe(false);
});
test.each(["scope", "cancel", "busy", "destination"])(
  "rechecks %s after native approval",
  async (kind) => {
    const f = fixture();
    f.deps.ask = async () => {
      if (kind === "scope") f.change();
      if (kind === "cancel") f.signal.abort();
      if (kind === "busy") f.busy("queued input");
      if (kind === "destination") f.deps.resolve = async () => "/changed";
      return true;
    };
    expect((await f.activate(f.request)).status).toBe("refused");
    expect(f.committed).toBe(false);
    expect(f.phases).toEqual([]);
    expect(f.locked).toBe(false);
  },
);
test("denial never loads destination settings or hooks", async () => {
  const f = fixture();
  f.deps.ask = async () => false;
  expect((await f.activate(f.request)).status).toBe("refused");
  expect(f.phases).toEqual([]);
});
test("precommit failure restores source; postcommit failure reports without rollback", async () => {
  const f = fixture();
  f.deps.prepare = async () => {
    throw new Error("chdir");
  };
  expect((await f.activate(f.request)).status).toBe("refused");
  expect(f.phases).toEqual(["restore"]);
  expect(f.committed).toBe(false);
  const g = fixture();
  let reported = false;
  g.deps.initialize = async () => {
    throw new Error("startup");
  };
  g.deps.report = () => {
    reported = true;
  };
  expect((await g.activate(g.request)).status).toBe("activated");
  await Bun.sleep(1);
  expect(reported).toBe(true);
  expect(g.phases).not.toContain("restore");
});
test("activation's own lock survives command return and rejects a second admission", async () => {
  const f = fixture();
  let answer!: (value: boolean) => void;
  f.deps.ask = () =>
    new Promise((resolve) => {
      answer = resolve;
    });
  const first = f.activate(f.request);
  await Bun.sleep(1);
  expect(f.locked).toBe(true);
  expect((await f.activate(f.request)).status).toBe("refused");
  expect(f.locked).toBe(true);
  answer(false);
  await first;
  expect(f.locked).toBe(false);
});

test("a replacement scope during settings preparation is restored as itself, not overwritten by the old source", async () => {
  const f = fixture();
  let restored = -1;
  f.deps.prepare = async () => {
    f.change();
  };
  f.deps.restore = async (scope) => {
    restored = scope.generation;
  };
  expect((await f.activate(f.request)).status).toBe("refused");
  expect(restored).toBe(1);
});
test("caller mutation cannot retarget the accepted destination", async () => {
  const f = fixture();
  let committed = "";
  f.deps.ask = async () => {
    f.request.conversationId = "replacement";
    return true;
  };
  f.deps.commit = (request) => {
    committed = request.conversationId;
  };
  expect((await f.activate(f.request)).status).toBe("activated");
  expect(committed).toBe("fresh");
});
test("policy refusal precedes native trust and source hooks", async () => {
  const f = fixture();
  f.deps.guard = () => {
    throw new Error("sandbox");
  };
  expect((await f.activate(f.request)).status).toBe("refused");
  expect(f.asked).toBe(0);
  expect(f.phases).toEqual([]);
});
test("source hook failure restores prepared settings without committing", async () => {
  const f = fixture();
  f.deps.endSource = async () => {
    throw new Error("source hook");
  };
  expect((await f.activate(f.request)).status).toBe("refused");
  expect(f.phases).toEqual(["prepare", "restore"]);
  expect(f.committed).toBe(false);
});

test("hung initialization releases admission after its deadline and reports incomplete initialization", async () => {
  const f = fixture();
  f.deps.initializationTimeoutMs = 10;
  let initializationSignal: AbortSignal | undefined;
  let failure: unknown;
  f.deps.initialize = async (_request, _path, _source, signal) => {
    initializationSignal = signal;
    await new Promise<void>(() => {});
  };
  f.deps.report = (error) => {
    failure = error;
  };
  expect((await f.activate(f.request)).status).toBe("activated");
  await Bun.sleep(30);
  expect(initializationSignal?.aborted).toBe(true);
  expect(f.locked).toBe(false);
  expect(String(failure)).toContain("initialization");
});
