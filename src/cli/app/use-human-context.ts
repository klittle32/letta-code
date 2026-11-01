import { useApp } from "ink";
import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { HumanPresentationEntry } from "@/agent/context-presentation";
import { getHostContextRecords } from "@/agent/host-context-records";
import { getClientConfigurationIdentity } from "@/backend/api/client";
import { APIBackend, type Backend, getBackend } from "@/backend/backend";
import { type Buffers, type Line, toLines } from "@/cli/helpers/accumulator";
import {
  type ContextDisplayLine,
  mergeContextTranscript,
  transcriptBoundary,
} from "@/cli/helpers/context-transcript";
import type { StaticItem } from "./types";

function presentationOwner(backend: Backend): object {
  return backend instanceof APIBackend
    ? getClientConfigurationIdentity()
    : backend;
}
/** Presentation only: no rows are added to inference/reflection buffers. */
export function useHumanContext(options: {
  agentId: string;
  conversationId: string;
  resumeKey: number;
  projectDirectory: string;
  staticItems: StaticItem[];
  liveItems: Line[];
  buffersRef: RefObject<Buffers>;
}) {
  const backend = getBackend();
  const host = getHostContextRecords();
  const owner = presentationOwner(backend);
  const key = JSON.stringify([
    options.agentId,
    options.conversationId,
    options.resumeKey,
    options.projectDirectory,
    process.cwd(),
    backend.localConversationStorageDir,
  ]);
  const latest = useRef(options);
  latest.current = options;
  const [snapshot, setSnapshot] = useState<{
    key: string;
    backend: object;
    host: object;
    owner: object;
    entries: HumanPresentationEntry[];
    unavailable: boolean;
  }>();
  useEffect(() => {
    const abort = new AbortController();
    let revision = 0;
    const scope = {
      agentId: options.agentId,
      conversationId: options.conversationId,
    };
    async function refresh() {
      const ticket = ++revision;
      try {
        const entries = await host.humanSnapshot(scope, abort.signal);
        if (
          !abort.signal.aborted &&
          ticket === revision &&
          getBackend() === backend
        ) {
          const observedOwner = presentationOwner(backend);
          // A refresh can itself rotate credentials. Never install its text
          // under an older render owner; schedule that owner's fresh snapshot.
          setSnapshot({
            key,
            backend,
            host,
            owner: observedOwner,
            entries: observedOwner === owner ? entries : [],
            unavailable: false,
          });
        }
      } catch {
        if (
          !abort.signal.aborted &&
          ticket === revision &&
          getBackend() === backend
        )
          setSnapshot({
            key,
            backend,
            host,
            owner: presentationOwner(backend),
            entries: [],
            unavailable: true,
          });
      }
    }
    // Subscribe before snapshot: a concurrent durable commit cannot be missed.
    const unsubscribe = host.subscribeHuman(
      scope,
      () =>
        transcriptBoundary(
          toLines(latest.current.buffersRef.current),
          latest.current.buffersRef.current,
        ),
      () => {
        if (presentationOwner(backend) !== owner) setSnapshot(undefined);
        void refresh();
      },
    );
    void refresh();
    return () => {
      abort.abort();
      unsubscribe();
    };
  }, [host, backend, key, options.agentId, options.conversationId, owner]);
  const current =
    snapshot?.key === key &&
    snapshot.backend === backend &&
    snapshot.host === host &&
    snapshot.owner === owner
      ? snapshot
      : undefined;
  const all = mergeContextTranscript<StaticItem | Line>(
    [...options.staticItems, ...options.liveItems],
    current?.entries ?? [],
  );
  const firstLive = options.liveItems[0]?.id;
  const split = firstLive
    ? all.findIndex((row) => row.id === firstLive)
    : all.length;
  const staticItems = all.slice(
    0,
    split < 0 ? all.length : split,
  ) as StaticItem[];
  const liveItems = all.slice(
    split < 0 ? all.length : split,
  ) as ContextDisplayLine[];
  if (current?.unavailable)
    liveItems.push({
      kind: "context",
      id: "context-unavailable",
      text: "Host-local context unavailable; ordinary history is preserved.",
      unavailableAnchor: true,
    });
  const [epoch, setEpoch] = useState(0);
  const previous = useRef<string[]>([]);
  const app = useApp() as ReturnType<typeof useApp> & {
    resetStaticOutput?: () => void;
  };
  const signature = staticItems.map((row) => row.id).join("\0");
  useLayoutEffect(() => {
    const next = signature.split("\0");
    const old = previous.current;
    previous.current = next;
    if (old.length && old.some((id, index) => next[index] !== id)) {
      app.resetStaticOutput?.();
      setEpoch((value) => value + 1);
    }
  }, [signature, app]);
  return { staticItems, liveItems, epoch };
}
