// A stand-in for Pi. It prints its arguments, echoes typed lines, reports status the way the
// status extension does, and prints its size after a resize.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const url = process.env.PI_FACTORY_WEB_STATUS_URL;
const sessionIndex = args.indexOf("--session");
const sessionFile =
  sessionIndex >= 0
    ? args[sessionIndex + 1]
    : `${process.env.PI_CODING_AGENT_SESSION_DIR}/fake-${process.pid}.jsonl`;

const post = (body) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

process.stdin.setRawMode?.(true);
process.stdout.write(`FAKE_PI ${JSON.stringify(args)}\r\n`);
await post({ status: "idle", sessionFile });

// Pick up requests from the page, like the status extension does.
const controlUrl = process.env.PI_FACTORY_WEB_CONTROL_URL;
void (async () => {
  for (;;) {
    const response = await fetch(controlUrl).catch(() => undefined);
    if (response?.status === 200) {
      const request = await response.json();
      if (request.theme !== undefined) {
        process.stdout.write(`THEME:${request.theme}\r\n`);
      } else {
        process.stdout.write(`RENAMED:${request.rename}\r\n`);
        await post({ name: request.rename });
      }
    }
  }
})();

async function handle(text) {
  if (text === "work") {
    await post({ status: "responding" });
    process.stdout.write("working\r\n");
    await post({ status: "waiting" });
    await post({ status: "idle", name: "Worked" });
    return;
  }
  if (text === "save") {
    appendFileSync(sessionFile, "");
  }
  process.stdout.write(`echo:${text}\r\n`);
}

let line = "";
process.stdin.on("data", (chunk) => {
  for (const character of chunk.toString()) {
    if (character === "\r") {
      void handle(line);
      line = "";
    } else {
      line += character;
    }
  }
});
process.on("SIGWINCH", () => {
  process.stdout.write(`RESIZE ${process.stdout.columns}x${process.stdout.rows}\r\n`);
});
