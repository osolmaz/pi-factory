import { spawn } from "node:child_process";

/** Open a URL in the default browser. Failure only means the user opens the printed URL. */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const [command, args] = browserCommand(url, platform);
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // The URL is printed too, so a missing opener is not an error.
  }
}

export function browserCommand(
  url: string,
  platform: NodeJS.Platform
): readonly [string, readonly string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["cmd", ["/c", "start", "", url]];
  return ["xdg-open", [url]];
}
