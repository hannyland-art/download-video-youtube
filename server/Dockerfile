FROM node:22-slim

# Install system dependencies (python3 for yt-dlp-exec install, curl for healthcheck)
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates python3 \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

# Create a non-root user for security (with home directory for yt-dlp cache)
RUN groupadd -r appgroup && useradd -r -g appgroup -m -d /home/appuser appuser

WORKDIR /app

# Copy package files first (leverages Docker layer caching)
COPY package*.json ./

# Skip yt-dlp-exec postinstall (async download is unreliable in Docker)
ENV YOUTUBE_DL_SKIP_DOWNLOAD=1

# Install production dependencies only
RUN npm ci --omit=dev \
    && npm cache clean --force

# Download yt-dlp explicitly (yt-dlp-exec postinstall often fails silently in CI/CloudShell)
RUN mkdir -p node_modules/yt-dlp-exec/bin \
    && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
        -o node_modules/yt-dlp-exec/bin/yt-dlp \
    && chmod +x node_modules/yt-dlp-exec/bin/yt-dlp \
    && node_modules/yt-dlp-exec/bin/yt-dlp -U --update-to nightly \
    && echo "yt-dlp: $(node_modules/yt-dlp-exec/bin/yt-dlp --version)" \
    && node -e "const p=require('ffmpeg-static'); require('child_process').execSync(p+' -version',{stdio:'inherit'})"

# Copy application code
COPY . .

# Remove unnecessary files from the image
RUN rm -f Dockerfile apprunner.yaml .dockerignore

# Create writable cache and tmp directories for appuser
RUN mkdir -p /home/appuser/.cache/yt-dlp /tmp/yt-mp3 \
    && chown -R appuser:appgroup /home/appuser /tmp/yt-mp3

# Switch to non-root user
USER appuser

# Set environment variables
ENV NODE_ENV=production
ENV PORT=8080

# Expose port
EXPOSE 8080

# Healthcheck — restart container if the server stops responding
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Use node directly instead of npm to handle signals properly (graceful shutdown)
CMD ["node", "index.js"]
