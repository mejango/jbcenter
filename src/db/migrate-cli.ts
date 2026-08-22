import { createPool } from "./postgres.js";
import { migrate } from "./migrate.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const pool = createPool(connectionString);
try {
  await migrate(pool);
} finally {
  await pool.end();
}
