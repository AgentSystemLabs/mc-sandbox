# Mission Control sandbox golden image.
#
# Bakes the heavy, secret-free install steps (scripts/install.sh — vendored from
# mission-control's renderInstallScript()) into a public AMI so customer deploys
# launch in ~seconds instead of running apt/npm on every boot. Per-instance secrets
# (the agent API key) and the self-signed TLS cert are NEVER baked — mission-control
# writes them at boot via cloud-init, so this image is safe to publish publicly.
#
# Build + publish via `node scripts/build-ami.mjs` (or the publish.yml workflow).

packer {
  required_plugins {
    amazon = {
      version = ">= 1.3.0"
      source  = "github.com/hashicorp/amazon"
    }
  }
}

variable "region" {
  type        = string
  default     = "us-east-1"
  description = "Build region. The AMI is created here, then copied to ami_regions."
}

variable "ami_regions" {
  type        = list(string)
  default     = ["us-east-1"]
  description = "Regions the finished AMI is copied to and made public."
}

variable "instance_type" {
  type        = string
  default     = "t3.medium"
  description = "Builder instance type. Must match var.arch."
}

variable "arch" {
  type        = string
  default     = "x86_64"
  description = "Target CPU architecture: x86_64 or arm64."
}

variable "version" {
  type        = string
  description = "Image version stamped into the AMI name + tags + manifest."
}

variable "agent_version" {
  type        = string
  default     = "unknown"
  description = "Baked @agentsystemlabs/mission-control-agent version, for staleness checks."
}

variable "install_script" {
  type        = string
  default     = "scripts/install.sh"
  description = "Path to the install script baked into the image."
}

variable "source_ami_name" {
  type        = string
  default     = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"
  description = "Canonical Ubuntu 24.04 name filter. Use the arm64 variant for arm64 builds."
}

variable "manifest_output" {
  type        = string
  default     = "packer-manifest.json"
  description = "Where Packer writes its build manifest (read by build-ami.mjs)."
}

locals {
  ami_name = "mission-control-sandbox-${var.arch}-${var.version}"
}

source "amazon-ebs" "sandbox" {
  region          = var.region
  instance_type   = var.instance_type
  ssh_username    = "ubuntu"
  ami_name        = local.ami_name
  ami_description = "Mission Control sandbox golden image (${var.arch}, ${var.version})"
  ami_regions     = var.ami_regions
  # Public: any AWS account can launch it. Safe because no secrets are baked.
  ami_groups = ["all"]
  # Re-running the same version replaces the existing AMI instead of failing on a
  # duplicate name (AMI names are unique per region/account).
  force_deregister      = true
  force_delete_snapshot = true
  # Drop the temporary Packer SSH key from the captured image.
  ssh_clear_authorized_keys = true

  source_ami_filter {
    filters = {
      name                = var.source_ami_name
      virtualization-type = "hvm"
      root-device-type    = "ebs"
      architecture        = var.arch
    }
    owners      = ["099720109477"] # Canonical
    most_recent = true
  }

  tags = {
    "Name"            = local.ami_name
    "MissionControl"  = "golden-image"
    "mc:version"      = var.version
    "mc:agentVersion" = var.agent_version
    "mc:arch"         = var.arch
  }
}

build {
  sources = ["source.amazon-ebs.sandbox"]

  # Let the base image's own cloud-init settle so apt locks are free.
  provisioner "shell" {
    execute_command = "sudo -E bash '{{ .Path }}'"
    inline          = ["cloud-init status --wait || true"]
  }

  # The exact install fragment customers would otherwise run on every boot.
  provisioner "shell" {
    script          = var.install_script
    execute_command = "sudo -E bash '{{ .Path }}'"
  }

  # Scrub everything instance-specific before the image is captured. A public AMI
  # is inspectable by anyone, so this must leave zero secrets / per-host identity.
  provisioner "shell" {
    execute_command = "sudo -E bash '{{ .Path }}'"
    inline = [
      "set -eux",
      # Per-instance agent secret never belongs in the image (written at boot).
      "rm -f /etc/mission-control-agent.env",
      # SSH host keys regenerate on first boot; don't share identity across instances.
      "rm -f /etc/ssh/ssh_host_*",
      # Force a fresh machine-id per launched instance.
      "truncate -s 0 /etc/machine-id || true",
      "rm -f /var/lib/dbus/machine-id || true",
      # Reset cloud-init so user-data runs fresh on the customer's first boot.
      "cloud-init clean --logs --seed || true",
      "rm -rf /var/lib/cloud/instances/* || true",
      # Provisioning + shell history.
      "rm -f /var/log/mission-control-agent-install.log /var/log/mission-control-agent-bootstrap.log || true",
      "rm -f /root/.bash_history /home/ubuntu/.bash_history /home/workspace/.bash_history || true",
      "rm -f /home/ubuntu/.ssh/authorized_keys || true",
      # Trim logs + apt caches.
      "find /var/log -type f -exec truncate -s 0 {} + || true",
      "apt-get clean || true",
      "rm -rf /var/lib/apt/lists/* || true",
    ]
  }

  post-processor "manifest" {
    output     = var.manifest_output
    strip_path = true
  }
}
