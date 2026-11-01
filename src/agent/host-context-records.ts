import { join } from "node:path";
import {
  createPassiveContextHost,
  type PassiveContextHost,
} from "@/agent/passive-context-host";
import { getBackend } from "@/backend/backend";
import { resolveGlobalConfigDir } from "@/utils/settings-path";

let current: { directory: string; host: PassiveContextHost } | undefined;
/** One lazy host owner for scoped mod records, model delivery and UI projection. */
export function getHostContextRecords(): PassiveContextHost {
  const directory = join(resolveGlobalConfigDir(), "context-inbox");
  if (!current || current.directory !== directory)
    current = {
      directory,
      host: createPassiveContextHost({ directory, getBackend }),
    };
  return current.host;
}
