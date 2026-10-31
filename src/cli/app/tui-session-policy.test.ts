import { expect, test } from "bun:test";
import { assertTuiActivationDirectoryAllowed } from "./tui-session-policy";

test("cwd activation cannot escape the existing workspace sandbox", () => {
  const scope = {
    agentId: "agent-self",
    workingDirectory: "/tmp/activation-sandbox/owned",
  };
  expect(() =>
    assertTuiActivationDirectoryAllowed("/tmp/outside", scope, {
      root: scope.workingDirectory,
      isolationRoot: "/tmp/activation-sandbox",
    }),
  ).toThrow("workspace sandbox");
  expect(() =>
    assertTuiActivationDirectoryAllowed(scope.workingDirectory, scope, {
      root: scope.workingDirectory,
      isolationRoot: "/tmp/activation-sandbox",
    }),
  ).not.toThrow();
});
test("cwd activation cannot enter another agent's memory even with trust", () => {
  const home = "/tmp/activation-policy-home";
  const scope = { agentId: "agent-self", workingDirectory: "/tmp" };
  expect(() =>
    assertTuiActivationDirectoryAllowed(
      `${home}/.letta/agents/agent-other/memory`,
      scope,
      undefined,
      { env: { HOME: home }, disableMemoryGuard: false },
    ),
  ).toThrow("cross-agent");
});
