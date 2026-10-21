import { db } from "./src/db/connection.js";
import { memories } from "./src/db/schema.js";
const rows = await db.select().from(memories);
console.log("Memory count:", rows.length);
if (rows.length > 0)
  console.log("First memory:", JSON.stringify(rows[0]).substring(0, 200));
process.exit(0);
