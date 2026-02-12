# Deployment Guide

## Server

| | |
|---|---|
| **Host** | `83.172.66.214` |
| **Port** | `5555` |
| **User** | `qwvoice` |
| **SSH key** | `~/.ssh/qwvoice_key` |
| **GPU** | NVIDIA RTX 4090 (24GB VRAM) |
| **Quad repo** | `/srv/qwvoice/quad/` |
| **Recordings** | `/srv/qwvoice/quad/recordings/` (volume-mounted, survives rebuilds) |
| **Admin** | Xerial (manages OS-level config, sudoers, firewall) |

### SSH Access

```bash
ssh -i ~/.ssh/qwvoice_key -p 5555 qwvoice@83.172.66.214
```

### Available Commands (sudo NOPASSWD)

```bash
sudo docker compose *              # Full compose control (up, down, logs, ps, exec, build)
sudo docker images                 # List images
sudo docker image prune -f         # Clean up dangling images
```

Note: Raw `docker` commands (without `compose`) require sudo. The `qwvoice` user is not in the `docker` group.

### Other Services on the Same Server

| Container | Purpose |
|---|---|
| `qwvoice-whisper` | Standalone faster-whisper (legacy, at `/srv/qwvoice/docker/`) |
| `ollama` | LLM inference server (port 11434) |

These run from a separate compose file at `/srv/qwvoice/docker/docker-compose.yml` and are independent of Quad.

## Deploy Workflow

### Standard Update (code changes)

```bash
# On the server:
cd /srv/qwvoice/quad
git pull
sudo docker compose up -d --build
```

This rebuilds the Docker image and restarts the container. Docker layer caching makes it fast (~30-60s) when only source code changed. The `npm ci` layer is cached unless `package.json` or `package-lock.json` changed.

### One-liner from local machine

```bash
ssh -i ~/.ssh/qwvoice_key -p 5555 qwvoice@83.172.66.214 \
  "cd /srv/qwvoice/quad && git pull && sudo docker compose up -d --build"
```

### When to use what

| Scenario | Command |
|---|---|
| **Code changes** (most common) | `git pull && sudo docker compose up -d --build` |
| **Only .env changed** | `sudo docker compose restart` |
| **Full rebuild** (dependency changes, Dockerfile changes) | `sudo docker compose up -d --build --no-cache` |
| **View logs** | `sudo docker compose logs -f quad` |
| **View recent logs** | `sudo docker compose logs --tail=100 quad` |
| **Stop the bot** | `sudo docker compose down` |
| **Check status** | `sudo docker compose ps` |
| **Clean old images** | `sudo docker image prune -f` |

All compose commands must be run from `/srv/qwvoice/quad/` or with `-f /srv/qwvoice/quad/docker-compose.yml`.

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
| `/srv/qwvoice/quad/` | `xerial` | Git repo, source code |
| `/srv/qwvoice/quad/.env` | `xerial` (mode 600) | Secrets — not readable by qwvoice |
| `/srv/qwvoice/quad/recordings/` | `root` | Created by Docker (runs as root inside container) |
| `/srv/qwvoice/docker/` | `qwvoice` | Legacy whisper + ollama compose |

The `qwvoice` user can `git pull` (repo readable) and run `sudo docker compose` commands, but cannot read `.env` directly. This is fine — Docker reads it as root.

## Troubleshooting

### Container won't start
```bash
sudo docker compose logs quad           # Check for error messages
sudo docker compose up quad             # Run in foreground (no -d) to see output
```

### Bot is online but not responding to commands
Discord slash commands are registered globally and can take up to 1 hour to propagate. Check logs for "Registered N global command(s)".

### GPU not detected
```bash
sudo docker compose exec quad python3 -c "import torch; print(torch.cuda.is_available())"
```
If `False`, check NVIDIA driver and container runtime: `nvidia-smi` (on host).

### Recordings not appearing
Check volume mount: `sudo docker compose exec quad ls -la /app/recordings/`

### Disk space
```bash
df -h /srv/qwvoice/
sudo docker images                      # Check image sizes
sudo docker image prune -f              # Remove dangling images
```
