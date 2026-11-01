import { expect, test } from "bun:test";
import type { Backend } from "@/backend/backend";
import { createContextPresentation } from "./context-presentation";

test("single observer fences namespaces/backends and cleanup cannot remove newer owner", () => {
  const p = createContextPresentation();
  const backend = {} as Backend;
  const other = {} as Backend;
  const scope = { agentId: "a", conversationId: "c" };
  const exact = {
    backend: "api",
    account: "one",
    agent: "a",
    conversation: "c",
  };
  let n = 0;
  const old = p.subscribe(
    scope,
    backend,
    () => ({ after: { otid: "human" } }),
    () => n++,
  );
  expect(p.boundary(exact, backend)).toBeUndefined();
  p.authorize(exact, backend);
  expect(p.boundary(exact, backend)).toEqual({ after: { otid: "human" } });
  expect(p.boundary({ ...exact, account: "two" }, backend)).toBeUndefined();
  expect(p.boundary(exact, other)).toBeUndefined();
  const dispose = p.subscribe(
    scope,
    backend,
    () => ({ after: null }),
    () => {
      n += 2;
    },
  );
  old();
  p.invalidate(exact, backend);
  expect(n).toBe(2);
  dispose();
  p.invalidate(exact, backend);
  expect(n).toBe(2);
});
