import { Pool, PoolClient } from "pg";

let connectionString = process.env.DATABASE_URL;

// In test environments we want to be able to import the app without a real DB.
// The pool won't be used unless a route actually queries it.
if (!connectionString && process.env.NODE_ENV === "test") {
  connectionString = "postgresql://test:test@localhost:5432/test";
}

if (!connectionString) {
  throw new Error("DATABASE_URL is required");
}

export const pool = new Pool({
  connectionString
});

export async function withTransaction<T>(
  operation: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
