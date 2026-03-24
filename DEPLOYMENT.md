# Deployment Guide

## Server

| | |
|---|---|
| **Host** | `83.172.66.214` |
| **Port** | `5555` |
| **User** | `dave` |
| **SSH alias** | `pinnaclepowerhouse` (configured in `~/.ssh/config`) |
| **SSH key** | `~/.ssh/id_ed25519` |
| **GPU** | NVIDIA RTX 4090 (24GB VRAM) |
| **Quad repo** | `/srv/qwvoice/quad/` |
| **Recordings** | `/srv/qwvoice/quad/recordings/` (volume-mounted, survives rebuilds) |
| **Admin** | Xerial (manages OS-level config, firewall, NVIDIA drivers) |

### SSH Access

```bash
ssh pinnaclepowerhouse
# Or explicitly:
ssh -i ~/.ssh/id_ed25519 -p 5555 dave@83.172.66.214
```

From Windows/WSL environment, use `wsl bash -c` (NOT `-ic`) for SSH commands:
```bash
wsl bash -c "ssh pinnaclepowerhouse 'command here'"
```

### Container Management — qwvoice-ctl

All Docker operations go through the `qwvoice-ctl` wrapper. No direct `docker` or `docker compose` access.

**Syntax:** `sudo qwvoice-ctl <project-dir> <command> [args...]`

| Command | What it does |
|---------|-------------|
| `up` | Start services (`docker compose up -d`) |
| `down` | Stop services (`docker compose down`) |
| `restart` | Restart services |
| `rebuild` | Rebuild images and start (`docker compose up -d --build`) |
| `logs` | View logs (supports `-f` for follow, `--tail N`) |
| `ps` | Show running services |
| `pull` | Pull latest images |
| `prune` | Remove dangling (unused) images |

**Security validation:** `qwvoice-ctl` validates `docker-compose.yml` before executing `up`, `restart`, or `rebuild`. It blocks:
- Volume mounts outside `/srv/qwvoice/`
- `privileged: true`
- `network_mode: "host"`
- Dangerous capabilities (`SYS_ADMIN`, `SYS_PTRACE`, `ALL`, `NET_ADMIN`, `NET_RAW`, `DAC_OVERRIDE`)
- `devices:` entries

GPU passthrough via `deploy.resources.reservations.devices` is allowed (our compose file uses this).

### Other Services on the Same Server

| Container | Purpose |
|---|---|
| `qwvoice-whisper` | Standalone faster-whisper (legacy, at `/srv/qwvoice/docker/`) |
| `ollama` | LLM inference server (port 11434) |

Managed via: `sudo qwvoice-ctl /srv/qwvoice/docker <command>`

## Deploy Workflow

### Standard Update (code changes)

```bash
ssh pinnaclepowerhouse
cd /srv/qwvoice/quad
git pull
sudo qwvoice-ctl /srv/qwvoice/quad rebuild
```

Docker layer caching makes rebuilds fast (~30-60s) when only source code changed. The `npm ci` layer is cached unless `package.json` or `package-lock.json` changed.

### One-liner from local machine

```bash
wsl bash -c "ssh pinnaclepowerhouse 'cd /srv/qwvoice/quad && git pull && sudo qwvoice-ctl /srv/qwvoice/quad rebuild'"
```

### When to use what

| Scenario | Command |
|---|---|
| **Code changes** (most common) | `git pull && sudo qwvoice-ctl /srv/qwvoice/quad rebuild` |
| **Only .env changed** | `sudo qwvoice-ctl /srv/qwvoice/quad restart` |
| **View logs** | `sudo qwvoice-ctl /srv/qwvoice/quad logs -f` |
| **View recent logs** | `sudo qwvoice-ctl /srv/qwvoice/quad logs --tail=100` |
| **Stop the bot** | `sudo qwvoice-ctl /srv/qwvoice/quad down` |
| **Check status** | `sudo qwvoice-ctl /srv/qwvoice/quad ps` |
| **Clean old images** | `sudo qwvoice-ctl /srv/qwvoice/quad prune` |

## Docker Architecture

### Multi-stage build

```
Build stage (node:22-slim):
  npm ci → tsc → produces dist/ + node_modules/

Runtime stage (node:22-slim):
  ffmpeg + Python venv + faster-whisper
  dist/ + node_modules/ from build stage
  knowledge YAMLs + transcribe.py script
  Whisper model pre-downloaded (baked into image)
```

### What's in the container

- **Node.js 22** — bot runtime
- **ffmpeg** — audio splitting for processing module
- **Python 3 + faster-whisper** — transcription (GPU-accelerated)
- **Whisper model** (`small` by default) — pre-downloaded at build time

### Volumes

| Mount | Purpose |
|---|---|
| `./recordings:/app/recordings` | Recording output. Persists across container rebuilds. |

### Environment

Configured via `.env` file (not checked into git). See `.env.example` for all options.

Key vars for deployment:
- `DISCORD_TOKEN` — bot token (required)
- `RECORDING_DIR` — defaults to `./recordings`
- `WHISPER_MODEL` — model baked into image at build time (default: `small`)
- `FIREBASE_SERVICE_ACCOUNT` — path to service account JSON for standin module

### GPU

The `docker-compose.yml` reserves 1 NVIDIA GPU. This is required for GPU-accelerated whisper transcription. The container will fail to start on machines without an NVIDIA GPU.

For local development without GPU, create a `docker-compose.override.yml`:

```yaml
services:
  quad:
    deploy:
      resources:
        reservations:
          devices: []
```

This file is gitignored.

## Local Development

Local development does NOT use Docker. Use the built-in skills:

- **`/build`** — Compile TypeScript (`npx tsc --noEmit`)
- **`/dev`** — Start the bot with ts-node ESM loader

The bot runs directly on Node.js in WSL, loading `.env` from the project root.

## File Ownership on Server

| Path | Owner | Notes |
|---|---|---|
| `/srv/qwvoice/quad/` | `qwvoice` group | Git repo, source code. `dave` has group write access. |
| `/srv/qwvoice/quad/.env` | varies | Secrets file |
| `/srv/qwvoice/quad/recordings/` | `root` | Created by Docker (runs as root inside container) |
| `/srv/qwvoice/docker/` | `qwvoice` group | Legacy whisper + ollama compose |

The `dave` user is in the `qwvoice` group (gid 1002). New files inherit the group via setgid. If containers create files as root, ask Xerial to fix permissions.

## Troubleshooting

### Container won't start
```bash
sudo qwvoice-ctl /srv/qwvoice/quad logs      # Check for error messages
```

### "SECURITY: Compose file blocked due to violations"
The `docker-compose.yml` contains something `qwvoice-ctl` doesn't allow. Read the error — it says exactly what's blocked.

### Bot is online but not responding to commands
Discord slash commands are registered globally and can take up to 1 hour to propagate. Check logs for "Registered N global command(s)".

### GPU not detected
Check NVIDIA driver on host: `nvidia-smi`

### Recordings not appearing
Check volume mount via logs or SSH into the server and inspect `/srv/qwvoice/quad/recordings/`.

### Disk space
```bash
df -h /srv/qwvoice/
sudo qwvoice-ctl /srv/qwvoice/quad prune     # Remove dangling images
```
