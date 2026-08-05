FROM node:18-bookworm-slim

ENV NODE_ENV=production \
    PORT=8080 \
    TRANSCRIPTION_HOST=127.0.0.1 \
    TRANSCRIPTION_PORT=5000 \
    TRANSCRIPTION_SERVICE_URL=http://127.0.0.1:5000 \
    WHISPER_DEVICE=cpu \
    WHISPER_COMPUTE_TYPE=int8 \
    WHISPER_CACHE_DIR=/opt/whisper_cache \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        ffmpeg \
        python3 \
        python3-pip \
        python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

COPY transcription_service/requirements.txt ./transcription_service/requirements.txt
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir -r transcription_service/requirements.txt

ENV PATH=/opt/venv/bin:$PATH

COPY . .

RUN groupadd --system app \
    && useradd --system --gid app --home-dir /app --shell /usr/sbin/nologin app \
    && mkdir -p /opt/whisper_cache \
    && chmod 755 /app/docker/start.sh \
    && chown -R app:app /app /opt/whisper_cache

USER app

EXPOSE 8080 5000

CMD ["/app/docker/start.sh"]
