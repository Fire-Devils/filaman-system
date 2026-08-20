import type { SpoolmanApi } from "./spoolman-api";

export interface SpoolmanControllerDeps {
  api: SpoolmanApi;
  t: (key: string) => string;
  signal: () => AbortSignal;
  confirm: (
    message: string,
    options: { title: string; okLabel: string; isDanger: boolean },
  ) => Promise<boolean>;
  alert: (message: string) => Promise<void>;
}
