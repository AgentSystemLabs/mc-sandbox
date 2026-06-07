#!/usr/bin/env node
// Build + publish the Mission Control sandbox golden AMI.
//
// Bakes scripts/install.sh into a public AMI per region (Packer), assembles the
// app manifest (region -> ami-id, version, owner, ...), writes it to
// dist/golden-ami-manifest.json, and optionally uploads it to the academy
// publish endpoint so Mission Control clients pick it up on their next AWS deploy.
//
// Usage:
//   node scripts/build-ami.mjs --version 2026.06.06-1 --regions us-east-1 \
//     [--arch x86_64] [--instance-type t3.medium] [--agent-version 0.2.1] \
//     [--out dist/golden-ami-manifest.json] [--dry-run] \
//     [--upload-url https://agentsystem.dev/api/golden-ami/manifest]
//
// Upload auth: set ACADEMY_MANIFEST_TOKEN in the environment (sent as a Bearer
// token). Requires: packer + aws CLIs on PATH, AWS creds for the publishing account.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const PACKER_TEMPLATE = path.join(REPO_ROOT, "packer", "sandbox.pkr.hcl");
const INSTALL_SCRIPT = path.join(REPO_ROOT, "scripts", "install.sh");
const AGENT_PACKAGE = "@agentsystemlabs/mission-control-agent";
const SOURCE_AMI_NAMES = {
  x86_64: "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*",
  arm64: "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*",
};

function fail(message) {
  console.error(`[build-ami] ${message}`);
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
    if (!next || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return flags;
}

function runInherit(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", cwd: REPO_ROOT, env: process.env });
  if ((result.status ?? 1) !== 0) fail(`${command} ${args.join(" ")} exited ${result.status}`);
}

function runCapture(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", cwd: REPO_ROOT, env: process.env });
  if (result.error || (result.status ?? 1) !== 0) return null;
  return (result.stdout ?? "").trim();
}

function assertCli(command, hint) {
  const probe = spawnSync(command, ["--version"], { stdio: "ignore" });
  if (probe.error && probe.error.code === "ENOENT") fail(`${command} CLI is required. ${hint}`);
}

function resolveOwner() {
  const out = runCapture("aws", ["sts", "get-caller-identity", "--output", "json"]);
  if (!out) fail("Could not read AWS account id. Configure AWS creds for the publishing account.");
  try {
    const account = JSON.parse(out).Account;
    if (!/^\d{12}$/.test(account || "")) fail(`Unexpected AWS account id: ${account}`);
    return account;
  } catch {
    return fail("aws sts get-caller-identity returned invalid JSON.");
  }
}

function resolveAgentVersion(explicit) {
  if (explicit) return explicit;
  return runCapture("npm", ["view", `${AGENT_PACKAGE}@latest`, "version"]) || "unknown";
}

// Packer's manifest post-processor records artifact_id as "region:ami,region:ami".
function parsePackerManifest(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const builds = Array.isArray(data.builds) ? data.builds : [];
  const last = builds[builds.length - 1];
  if (!last || typeof last.artifact_id !== "string") fail(`Could not read artifact_id from ${file}`);
  const images = {};
  for (const pair of last.artifact_id.split(",")) {
    const [region, amiId] = pair.split(":");
    if (region && /^ami-[0-9a-f]+$/i.test(amiId || "")) images[region.trim()] = amiId.trim();
  }
  if (Object.keys(images).length === 0) fail(`No AMIs parsed from ${file}`);
  return images;
}

async function uploadManifest(uploadUrl, manifest) {
  const token = (process.env.ACADEMY_MANIFEST_TOKEN ?? "").trim();
  if (!token) fail("--upload-url given but ACADEMY_MANIFEST_TOKEN is not set.");
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: `${JSON.stringify(manifest, null, 2)}\n`,
  });
  const text = await res.text();
  if (!res.ok) fail(`Upload to ${uploadUrl} failed: HTTP ${res.status} ${text.slice(0, 500)}`);
  console.log(`[build-ami] uploaded manifest to ${uploadUrl} (HTTP ${res.status})`);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const version = typeof flags.version === "string" ? flags.version.trim() : "";
  if (!version) fail("--version is required (e.g. --version 2026.06.06-1).");

  const arch = (typeof flags.arch === "string" ? flags.arch : "x86_64").trim();
  if (!SOURCE_AMI_NAMES[arch]) fail(`--arch must be one of: ${Object.keys(SOURCE_AMI_NAMES).join(", ")}`);

  const regions = (typeof flags.regions === "string" ? flags.regions : "us-east-1")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  if (regions.length === 0) fail("--regions must list at least one region.");

  const instanceType =
    (typeof flags["instance-type"] === "string" ? flags["instance-type"] : "") ||
    (arch === "arm64" ? "t4g.medium" : "t3.medium");
  const dryRun = flags["dry-run"] === true;
  const uploadUrl = typeof flags["upload-url"] === "string" ? flags["upload-url"] : "";
  const outPath = path.resolve(
    REPO_ROOT,
    typeof flags.out === "string" ? flags.out : "dist/golden-ami-manifest.json",
  );

  if (!fs.existsSync(INSTALL_SCRIPT)) fail(`Missing install script at ${INSTALL_SCRIPT}`);
  const agentVersion = resolveAgentVersion(typeof flags["agent-version"] === "string" ? flags["agent-version"] : "");

  console.log(`[build-ami] version=${version} arch=${arch} agent=${agentVersion}`);
  console.log(`[build-ami] regions=${regions.join(",")} type=${instanceType}`);

  if (dryRun) {
    console.log("[build-ami] --dry-run: skipping packer build.");
    return;
  }

  assertCli("packer", "Install HashiCorp Packer: https://developer.hashicorp.com/packer/install");
  assertCli("aws", "Install the AWS CLI v2 and configure credentials for the publishing account.");
  const owner = resolveOwner();

  const manifestOut = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mc-sandbox-")), "packer-manifest.json");
  const varArgs = [
    "-var", `version=${version}`,
    "-var", `agent_version=${agentVersion}`,
    "-var", `arch=${arch}`,
    "-var", `instance_type=${instanceType}`,
    "-var", `region=${regions[0]}`,
    "-var", `ami_regions=[${regions.map((r) => `"${r}"`).join(",")}]`,
    "-var", `install_script=${INSTALL_SCRIPT}`,
    "-var", `source_ami_name=${SOURCE_AMI_NAMES[arch]}`,
    "-var", `manifest_output=${manifestOut}`,
  ];

  runInherit("packer", ["init", PACKER_TEMPLATE]);
  runInherit("packer", ["build", ...varArgs, PACKER_TEMPLATE]);

  const images = parsePackerManifest(manifestOut);
  const manifest = {
    schemaVersion: 1,
    version,
    agentVersion,
    arch,
    owner,
    builtAt: new Date().toISOString(),
    images,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\n[build-ami] wrote ${outPath}`);
  for (const [region, amiId] of Object.entries(images)) console.log(`  ${region}  ${amiId}`);

  if (uploadUrl) await uploadManifest(uploadUrl, manifest);
}

main();
