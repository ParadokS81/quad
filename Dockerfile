# ---- Build stage ----
FROM node:22-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/

RUN npx tsc

# ---- Runtime stage ----
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 python3-pip python3-venv libfontconfig1 \
    && rm -rf /var/lib/apt/lists/*

# Create venv for Python packages (Debian requires this)
RUN python3 -m venv /opt/whisper-venv
ENV PATH="/opt/whisper-venv/bin:$PATH"

RUN pip install --no-cache-dir faster-whisper

WORKDIR /app

# Copy compiled JS + node_modules from build stage
COPY --from=build /app/dist/ dist/
COPY --from=build /app/node_modules/ node_modules/
COPY package.json ./

# Copy knowledge YAMLs (not compiled by tsc, needed at runtime)
COPY src/modules/processing/knowledge/ dist/modules/processing/knowledge/

# Copy Inter font files for canvas rendering
COPY fonts/ fonts/

# Copy Python transcription script
COPY scripts/transcribe.py scripts/transcribe.py

# Pre-download Whisper model so it's baked into the image
ARG WHISPER_MODEL=small
RUN python3 -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL}', device='cpu', compute_type='default')"

# Recordings volume mount point
RUN mkdir -p /app/recordings
VOLUME /app/recordings

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/index.js"]
