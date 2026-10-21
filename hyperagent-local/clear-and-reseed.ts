import { db } from "./src/db/connection.js";
import { memories } from "./src/db/schema.js";

async function main() {
  await db.delete(memories);
  console.log("Cleared all memories");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
