# ---- Build stage (TypeScript → JS) ----
FROM node:22-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY patches/ patches/
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/

RUN npx tsc

# ---- Python deps stage (compile zeroc-ice + install faster-whisper) ----
# Needs g++ and python3-dev to compile zeroc-ice from source (no pre-built wheel available).
# Build here then copy the finished venv to the runtime stage — keeps g++ out of the final image.
FROM node:22-slim AS python-deps

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv python3-dev g++ \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/whisper-venv
ENV PATH="/opt/whisper-venv/bin:$PATH"

RUN pip install --no-cache-dir faster-whisper nvidia-cublas-cu12 nvidia-cudnn-cu12 zeroc-ice

# ---- Runtime stage ----
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg python3 libfontconfig1 \
    && rm -rf /var/lib/apt/lists/*

# Copy pre-built Python venv (includes zeroc-ice + faster-whisper compiled in python-deps stage)
COPY --from=python-deps /opt/whisper-venv /opt/whisper-venv
ENV PATH="/opt/whisper-venv/bin:$PATH"

# CUDA runtime libs installed by pip need to be on LD_LIBRARY_PATH for CTranslate2
ENV LD_LIBRARY_PATH="/opt/whisper-venv/lib/python3.11/site-packages/nvidia/cublas/lib:/opt/whisper-venv/lib/python3.11/site-packages/nvidia/cudnn/lib:${LD_LIBRARY_PATH}"

WORKDIR /app

# Copy compiled JS + node_modules from build stage
COPY --from=build /app/dist/ dist/
COPY --from=build /app/node_modules/ node_modules/
COPY package.json ./

# Copy knowledge YAMLs (not compiled by tsc, needed at runtime)
COPY src/modules/processing/knowledge/ dist/modules/processing/knowledge/

# Copy Inter font files for canvas rendering
COPY fonts/ fonts/

# Copy Python scripts (transcription + Murmur ICE sidecar)
COPY scripts/transcribe.py scripts/transcribe.py
COPY scripts/mumble-ice.py scripts/mumble-ice.py
COPY scripts/MumbleServer.ice scripts/MumbleServer.ice

# Pre-download Whisper model so it's baked into the image
ARG WHISPER_MODEL=small
RUN python3 -c "from faster_whisper import WhisperModel; WhisperModel('${WHISPER_MODEL}', device='cpu', compute_type='default')"

# Recordings volume mount point
RUN mkdir -p /app/recordings
VOLUME /app/recordings

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/index.js"]
