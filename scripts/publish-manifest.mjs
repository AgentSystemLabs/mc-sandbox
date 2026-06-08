#!/usr/bin/env node
// Publish a golden AMI manifest to academy WITHOUT rebuilding the image.
//
// Use this to (re)publish an already-built public AMI — e.g. when the bake
// succeeded but the upload step failed (academy wasn't deployed yet). It does NOT
// run Packer; it just assembles the manifest and POSTs it.
//
// Usage:
//   ACADEMY_MANIFEST_TOKEN=… node scripts/publish-manifest.mjs \
//     --version 2026.06.07-1 --ami ami-0123… [--region us-east-1] [--arch x86_64] \
//     [--agent-version 0.2.1] [--owner 493255580566] \
//     [--upload-url https://agentsystem.dev/api/golden-ami/manifest]
//
// Owner defaults to the current AWS account (aws sts get-caller-identity); pass
// --owner to skip the AWS CLI. Auth: ACADEMY_MANIFEST_TOKEN env (sent as Bearer).

import { spawnSync } from "node:child_process";

const DEFAULT_UPLOAD_URL = "https://agentsystem.dev/api/golden-ami/manifest";

function fail(message) {
  console.error(`[publish-manifest] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) flags[key] = true;
    else {
      flags[key] = next;
      i += 1;
    }
  }
  return flags;
}

function resolveOwner(explicit) {
  if (explicit) return explicit;
  const r = spawnSync("aws", ["sts", "get-caller-identity", "--query", "Account", "--output", "text"], {
    encoding: "utf8",
  });
  const account = (r.stdout ?? "").trim();
  if (!/^\d{12}$/.test(account)) {
    fail("Could not resolve AWS account for `owner`. Pass --owner <12-digit-account>.");
  }
  return account;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const str = (k) => (typeof flags[k] === "string" ? flags[k].trim() : "");

  const version = str("version");
  const ami = str("ami");
  const region = str("region") || "us-east-1";
  const arch = str("arch") || "x86_64";
  const agentVersion = str("agent-version") || "unknown";
  const uploadUrl = str("upload-url") || DEFAULT_UPLOAD_URL;

  if (!version) fail("--version is required.");
  if (!/^ami-[0-9a-f]+$/i.test(ami)) fail("--ami is required (e.g. --ami ami-0123abc).");

  const token = (process.env.ACADEMY_MANIFEST_TOKEN ?? "").trim();
  if (!token) fail("ACADEMY_MANIFEST_TOKEN is not set in the environment.");

  const manifest = {
    schemaVersion: 1,
    version,
    agentVersion,
    arch,
    owner: resolveOwner(str("owner")),
    builtAt: new Date().toISOString(),
    images: { [region]: ami },
  };

  console.log(`[publish-manifest] publishing ${ami} (${region}, ${arch}, v${version}) → ${uploadUrl}`);

  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: `${JSON.stringify(manifest, null, 2)}\n`,
  });
  const text = await res.text();
  if (!res.ok) fail(`upload failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  console.log(`[publish-manifest] published (HTTP ${res.status}) ${text.slice(0, 200)}`);
}

main();
