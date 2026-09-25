// Copy the static UI files next to the compiled app.js.
import { copyFile, mkdir } from "node:fs/promises";

const from = new URL("../ui/", import.meta.url);
const to = new URL("../dist/ui/", import.meta.url);
await mkdir(to, { recursive: true });
for (const name of ["index.html", "style.css"]) {
  await copyFile(new URL(name, from), new URL(name, to));
}
