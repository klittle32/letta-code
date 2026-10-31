import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { render, Text } from "ink";
import { useLayoutEffect, useState } from "react";
import type { TurnInterruptRequestResult } from "@/agent/turn-interrupt";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import {
  createAssistantMessageStream,
  type HeadlessTurnExecutorInput,
} from "@/backend/dev/headless-turn-executor";
import {
  admitTuiApprovalPause,
  recoverTuiApprovalInput,
} from "@/cli/app/tui-approval-recovery";
import { useTuiApprovalRetirement } from "@/cli/app/tui-approval-retirement";
import { enterTuiLogicalTurn } from "@/cli/app/tui-turn-owner";
import { createBuffers } from "@/cli/helpers/accumulator";
import type { ApprovalRequest } from "@/cli/helpers/stream";

test.each([false, true])(
  "native retirement survives scope replacement before passive effects, skipped effect=%s",
  async (skipEffect) => {
    const inputs: HeadlessTurnExecutorInput[] = [];
    const backend = new FakeHeadlessBackend("agent-scope", {
      async execute(input) {
        inputs.push(input);
        if (inputs.length > 1) return createAssistantMessageStream();
        return {
          controller: new AbortController(),
          async *[Symbol.asyncIterator]() {
            for (const id of ["pending", "companion"])
              yield {
                message_type: "approval_request_message",
                tool_call: {
                  tool_call_id: id,
                  name: "Read",
                  arguments: '{"file_path":"fixture"}',
                },
              };
            yield {
              message_type: "stop_reason",
              stop_reason: "requires_approval",
            };
          },
        } as unknown as Stream<LettaStreamingResponse>;
      },
    });
    __testSetBackend(backend);
    const original = await backend.createConversation({
      agent_id: "agent-scope",
    });
    const replacement = await backend.createConversation({
      agent_id: "agent-scope",
    });
    const stream = await backend.createConversationMessageStream(original.id, {
      messages: [{ role: "user", content: "pause" }],
    });
    for await (const _chunk of stream) {
      /* Persist the real pending approval batch. */
    }
    const ref = { current: null as AbortController | null };
    const generation = { current: 0 };
    const conversation = { current: original.id };
    const turn = enterTuiLogicalTurn({
      ref,
      generationRef: generation,
      generation: 0,
      continuation: false,
      agentId: "agent-scope",
      conversationId: original.id,
    });
    const ended: { id: string; reason: string }[] = [];
    turn.setTerminalHandler(async (reason) => {
      ended.push({ id: turn.turn.id, reason });
      return undefined;
    });
    const pending: ApprovalRequest[] = [
      { toolCallId: "pending", toolName: "Read", toolArgs: "{}" },
    ];
    admitTuiApprovalPause(turn, ref, pending, [
      {
        toolCallId: "companion",
        result: { status: "success", toolReturn: "actual companion output" },
      },
    ]);
    await turn.leave(true);
    let receipt: TurnInterruptRequestResult | undefined;
    let uiWrites = 0;
    let next: ReturnType<typeof enterTuiLogicalTurn> | undefined;
    function Harness() {
      const [approvals, setApprovals] = useState(skipEffect ? [] : pending);
      useLayoutEffect(() => {
        receipt = turn.request(new AbortController().signal);
        generation.current++;
        conversation.current = replacement.id;
        next = enterTuiLogicalTurn({
          ref,
          generationRef: generation,
          generation: 1,
          continuation: false,
          agentId: "agent-scope",
          conversationId: replacement.id,
        });
        setApprovals(
          skipEffect
            ? []
            : [{ toolCallId: "replacement", toolName: "Read", toolArgs: "{}" }],
        );
      }, [skipEffect]);
      useTuiApprovalRetirement({
        abortControllerRef: ref,
        conversationGenerationRef: generation,
        conversationIdRef: conversation,
        agentId: "agent-scope",
        pendingApprovals: approvals,
        approvalResults: [],
        autoHandledResults: [],
        autoDeniedApprovals: [],
        queueApprovalResults: () => {
          uiWrites++;
        },
        buffersRef: { current: createBuffers() },
        refreshDerived: () => {
          uiWrites++;
        },
        clearApprovalToolContext: () => {
          uiWrites++;
        },
        setPendingApprovals: () => {
          uiWrites++;
        },
        setApprovalContexts: () => {},
        setApprovalResults: () => {},
        setAutoHandledResults: () => {},
        setAutoDeniedApprovals: () => {},
        setStreaming: () => {},
      });
      return (
        <Text>
          {approvals.map((approval) => approval.toolCallId).join(",") ||
            "no approval"}
        </Text>
      );
    }
    const stdin = new Readable({ read() {} }) as NodeJS.ReadStream;
    stdin.isTTY = true;
    stdin.setRawMode = () => stdin;
    stdin.ref = () => stdin;
    stdin.unref = () => stdin;
    let output = "";
    const stdout = new Writable({
      write(chunk, _encoding, done) {
        output += chunk.toString();
        done();
      },
    }) as NodeJS.WriteStream;
    stdout.columns = 100;
    stdout.rows = 30;
    const app = render(<Harness />, {
      stdin,
      stdout,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    });
    try {
      await Bun.sleep(30);
      if (receipt?.status !== "requested") throw new Error("missing receipt");
      expect((await receipt.wait(100)).status).toBe("settled");
      expect(turn.active).toBe(false);
      expect(ended).toEqual([{ id: turn.turn.id, reason: "cancelled" }]);
      expect(uiWrites).toBe(0);
      expect(next?.signal.aborted).toBe(false);
      expect(output).toContain(skipEffect ? "no approval" : "replacement");
      const replacementInput = await recoverTuiApprovalInput(
        ref,
        { ...turn.turn, conversationId: replacement.id },
        [],
        () => true,
      );
      expect(replacementInput).toEqual([]);
      const recovery = await recoverTuiApprovalInput(
        ref,
        turn.turn,
        [{ role: "user", content: "legitimate return" }],
        () => true,
      );
      expect(JSON.stringify(recovery)).toContain("actual companion output");
      expect(JSON.stringify(recovery)).toContain(
        "Turn interrupted before approval execution",
      );
      const resumed = await backend.createConversationMessageStream(
        original.id,
        {
          messages: recovery,
        },
      );
      for await (const _chunk of resumed) {
        /* Verify the actual resumed backend request. */
      }
      expect(inputs[1]?.conversationId).toBe(original.id);
      expect(JSON.stringify(inputs[1]?.body)).toContain(
        "actual companion output",
      );
    } finally {
      app.unmount();
      app.cleanup();
      await next?.leave(false);
      __testSetBackend(null);
    }
  },
  10000,
);
