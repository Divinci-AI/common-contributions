// Prints the src/ tree hash of this checkout (add it to reviewed-harness-trees.json when you release).
import { fileURLToPath } from "node:url";
import { harnessIdentity } from "../src/record.mjs";
const id = harnessIdentity(fileURLToPath(new URL("..", import.meta.url)));
console.log(JSON.stringify(id, null, 2));
if (id.dirty !== false) console.error("warning: src/ has uncommitted changes; release only from a clean commit");
