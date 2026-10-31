import { useEffect, useMemo, useSyncExternalStore } from "react";
import { getBackend } from "@/backend";
import { getClient } from "@/backend/api/client";
import type { ModQuestionHandler } from "@/mods/question-api";
import type { ModSessionActivationHandler } from "@/mods/session-api";
import {
  createModAdapter,
  type ModAdapter,
  type ModAdapterSnapshot,
} from "./local-mod-loader";
import type { ModContext } from "./types";

export interface LocalModAdapter {
  context: ModContext;
  events: ModAdapter["events"];
  getBackend: ModAdapter["getBackend"];
  hadModPanels: boolean; // Used to prevent flicker on reload
  hasModSources: boolean;
  engine: ModAdapter["engine"];
  isLoading: boolean;
  registry: ModAdapterSnapshot["registry"];
  reload: (signal?: AbortSignal) => Promise<void>;
}

export function useLocalModAdapter(
  context: ModContext,
  options: {
    agentModsDirectory?: string | null;
    disabled?: boolean;
    onAsk?: ModQuestionHandler;
    onActivate?: ModSessionActivationHandler;
    onNotification?: (message: string) => void;
  } = {},
): LocalModAdapter {
  const agentModsDirectory = options.agentModsDirectory ?? undefined;
  const disabled = options.disabled;
  const adapter = useMemo(
    () =>
      createModAdapter({
        ...(agentModsDirectory ? { agentModsDirectory } : {}),
        disabled,
        getBackend,
        getClient,
        onAsk: options.onAsk,
        onActivate: options.onActivate,
        onNotification: options.onNotification,
      }),
    [
      agentModsDirectory,
      disabled,
      options.onNotification,
      options.onAsk,
      options.onActivate,
    ],
  );

  const snapshot = useSyncExternalStore(
    adapter.subscribe,
    adapter.getSnapshot,
    adapter.getSnapshot,
  );

  useEffect(() => {
    void adapter.reload();

    return () => {
      adapter.dispose();
    };
  }, [adapter]);

  return useMemo(
    () => ({
      context,
      events: adapter.events,
      getBackend: adapter.getBackend,
      hadModPanels: snapshot.hadModPanels,
      hasModSources: snapshot.hasModSources,
      engine: adapter.engine,
      isLoading: snapshot.isLoading,
      registry: snapshot.registry,
      reload: adapter.reload,
    }),
    [adapter, context, snapshot],
  );
}
