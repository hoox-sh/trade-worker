/**
 * Copyright (c) 2026 HOOX · HOOX · jango-blockchained (hoox-sh)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const workerRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("WEB3_WALLET_SERVICE binding", () => {
  it("wrangler.jsonc declares the wallet service binding", async () => {
    // wrangler.jsonc contains comments — do not JSON.parse it.
    const raw = await readFile(join(workerRoot, "wrangler.jsonc"), "utf8");
    expect(raw).toContain('"binding": "WEB3_WALLET_SERVICE"');
    expect(raw).toContain('"service": "web3-wallet-worker"');
  });

  it("worker-configuration.d.ts exposes the binding", async () => {
    const raw = await readFile(
      join(workerRoot, "worker-configuration.d.ts"),
      "utf8"
    );
    expect(raw).toContain("WEB3_WALLET_SERVICE");
  });
});
