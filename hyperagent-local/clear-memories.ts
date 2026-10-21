import { db } from "./src/db/connection.js";
import { memories } from "./src/db/schema.js";

(async () => {
  await db.delete(memories);
  console.log("Cleared all memories");
})();
