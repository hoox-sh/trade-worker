/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained
 * SPDX-License-Identifier: Apache-2.0
 */

import { join } from "path";
import { execSync } from "child_process";

function initDatabase() {
  const environment = process.env.ENVIRONMENT || "local"; // Default to local
  const databaseId = process.env.D1_DATABASE_ID; // Get from environment if needed for remote

  if (environment === "remote" && !databaseId) {
    console.error(
      "Error: D1_DATABASE_ID environment variable is required for remote execution."
    );
    process.exit(1);
  }

  try {
    const sqlPath = join(__dirname, "init-db.sql");

    console.log(`Initializing database using ${sqlPath}...`);

    // Construct the wrangler d1 execute command
    let command = `npx wrangler d1 execute`;

    // Determine the database identifier for wrangler
    // For local, it's often the worker name if defined in wrangler.toml
    // For remote, it might be explicitly defined or inferred.
    // Let's assume wrangler can infer it from the d1_databases section in d1-worker/wrangler.toml
    // If you have multiple D1s, you might need to pass the specific DB name/ID.
    // We'll try using the worker's configured DB binding name (check d1-worker/wrangler.toml)
    // Assuming the binding name in d1-worker/wrangler.toml is 'DB'
    command += ` DB`; // Replace 'DB' if your binding name is different

    if (environment === "local") {
      command += ` --local`;
    } else {
      // Potentially add --remote flag if needed, though wrangler might default correctly
      // command += ` --remote`; // Uncomment if necessary
    }

    command += ` --file=${sqlPath}`;

    console.log(`Executing command: ${command}`);

    // Execute the command synchronously
    execSync(command, { stdio: "inherit" });

    console.log("Database initialization command executed successfully.");
  } catch (error) {
    console.error("Error initializing database:", error.message);
    if (error.stdout) console.error("stdout:", error.stdout.toString());
    if (error.stderr) console.error("stderr:", error.stderr.toString());
    process.exit(1);
  }
}

initDatabase();
