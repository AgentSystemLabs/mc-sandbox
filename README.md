# mc-sandbox

Builds and publishes the **Mission Control sandbox golden AMI** — a pre-baked
**public** AMI (owned by the AgentSystemLabs AWS account) with every sandbox tool
preinstalled: Node 24, pnpm, the Mission Control agent, and the Claude Code / Codex /
OpenCode / cursor-agent CLIs.

Mission Control launches customer sandboxes from this AMI so an AWS sandbox boots in
~30–60s instead of running apt/npm on every boot (~3–6 min). When no AMI exists for a
region/arch, Mission Control falls back to running the install script at boot.

## How it fits together

```
mc-sandbox (this repo, your AWS account)        Mission Control (customer's account)
────────────────────────────────────────       ────────────────────────────────────
scripts/install.sh  ──┐                          fetch manifest from academy
packer build          │  bake → copy regions       (bundled fallback if offline)
  → make AMI public   │  → make public            resolve AMI for region/arch
build-ami.mjs         │                           verify AMI owner == manifest.owner
  → manifest.json  ───┴── POST ─▶ academy        launch FROM ami + slim boot user-data
                          /api/golden-ami/manifest (else: Ubuntu base + install.sh)
```

The image bakes only the **secret-free** `scripts/install.sh`. Per-instance secrets —
the agent API key and the self-signed TLS cert — are written at **boot** by Mission
Control's cloud-init, never baked, which is why the AMI is safe to publish publicly.

> `scripts/install.sh` is **vendored from** Mission Control's `renderInstallScript()`
> (`scripts/remote-vm.mjs`) so a golden boot and the full-install fallback converge.
> If the install steps change there, regenerate this file and re-bake.

## Publish via CI (recommended)

Push a **release tag** (`v*`, e.g. `v2026.06.07-1`) — the **Build & publish golden AMI**
workflow runs only on tags, never on branch pushes or PRs, so a billable bake is always
a deliberate release. The image version is taken from the tag (`v1.2.3` → `1.2.3`). It
bakes the AMI for us-east-1/x86_64, makes it public, and uploads the manifest to academy.

```bash
git tag v2026.06.07-1 && git push origin v2026.06.07-1
```

Required repo secrets:

| Secret | Purpose |
|---|---|
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Creds for the publishing AWS account (`493255580566`). Needs ec2 run/stop/terminate, create-image, modify-image-attribute, describe-*, keypair + security-group. |
| `ACADEMY_MANIFEST_TOKEN` | Bearer token matching academy's `GOLDEN_AMI_MANIFEST_PUBLISH_TOKEN`. |

Account-level prerequisite: **Block Public Access for AMIs** must be disabled in each
target region (`aws ec2 disable-image-block-public-access --region <r>`), otherwise the
make-public step fails.

## Publish locally

```bash
# Requires packer + aws CLIs and AWS creds for the publishing account.
node scripts/build-ami.mjs --version 2026.06.06-1 --regions us-east-1

# build + upload to academy in one step:
ACADEMY_MANIFEST_TOKEN=… node scripts/build-ami.mjs --version 2026.06.06-1 \
  --regions us-east-1 --upload-url https://agentsystem.dev/api/golden-ami/manifest
```

Flags: `--version` (required), `--regions` (csv, default `us-east-1`), `--arch`
(`x86_64`|`arm64`), `--instance-type`, `--agent-version` (defaults to the latest
published agent), `--out` (default `dist/golden-ami-manifest.json`), `--upload-url`,
`--dry-run`.

## Cadence

Re-bake weekly and on each agent release; bump `--version`. Mission Control treats a
newer manifest version as authoritative. Deregister superseded AMIs after a grace
window (clients pin the exact AMI id from the manifest).
