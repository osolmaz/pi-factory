import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Environment variable that carries the status URL of one live session. */
export const statusUrlEnv = "PI_FACTORY_WEB_STATUS_URL";
/** Environment variable that carries the control URL, where the session picks up requests. */
export const controlUrlEnv = "PI_FACTORY_WEB_CONTROL_URL";

/**
 * Source of the Pi extension that reports a session's state to the web server.
 *
 * It reports public Pi events. It also long-polls a control URL and applies the page's requests
 * through public Pi APIs: a rename becomes pi.setSessionName, so Pi itself writes the session_info
 * entry. The URLs, with their key and token, come from the environment of the Pi process, so one
 * generated file serves every session. The extension uses a minimal local type, so it works across
 * Pi versions: an event that an older Pi does not emit simply never fires.
 */
export function statusExtensionSource(): string {
  return `type Handler = (event: Record<string, unknown>, ctx: StatusContext) => unknown;
type StatusContext = { readonly sessionManager: { getSessionFile(): string | undefined } };
type StatusApi = {
  on(event: string, handler: Handler): void;
  getSessionName(): string | undefined;
  setSessionName(name: string): void;
};

const url = process.env[${JSON.stringify(statusUrlEnv)}];
const controlUrl = process.env[${JSON.stringify(controlUrlEnv)}];

export default function piFactoryWebStatus(pi: StatusApi): void {
  if (url === undefined || url === "") {
    return;
  }
  let running = false;
  const post = (body: Record<string, unknown>): void => {
    void fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    }).catch(() => undefined);
  };

  let polling = false;
  let stopped = false;
  const poll = async (): Promise<void> => {
    while (!stopped && controlUrl !== undefined && controlUrl !== "") {
      try {
        const response = await fetch(controlUrl);
        if (response.status === 200) {
          const request = (await response.json()) as { rename?: unknown };
          if (typeof request.rename === "string") pi.setSessionName(request.rename);
        } else if (response.status !== 204) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  };

  pi.on("session_shutdown", () => {
    stopped = true;
  });
  pi.on("session_start", (_event, ctx) => {
    stopped = false;
    if (!polling) {
      polling = true;
      void poll().finally(() => {
        polling = false;
      });
    }
    running = false;
    post({
      status: "idle",
      sessionFile: ctx.sessionManager.getSessionFile(),
      name: pi.getSessionName()
    });
  });
  pi.on("agent_start", () => {
    running = true;
    post({ status: "responding" });
  });
  pi.on("ui_prompt_start", () => {
    post({ status: "waiting" });
  });
  pi.on("ui_prompt_end", () => {
    post({ status: running ? "responding" : "idle" });
  });
  pi.on("agent_settled", () => {
    running = false;
    post({ status: "idle" });
  });
  pi.on("session_info_changed", (event) => {
    post({ name: typeof event["name"] === "string" ? event["name"] : "" });
  });
}
`;
}

/** Write the status extension into the app's state directory and return its path. */
export async function writeStatusExtension(stateDir: string): Promise<string> {
  const dir = join(stateDir, "pi-factory-web");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "status.ts");
  await writeFile(path, statusExtensionSource(), "utf8");
  return path;
}
