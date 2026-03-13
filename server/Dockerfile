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

# Install production dependencies only
RUN npm ci --omit=dev \
    && npm cache clean --force

# Copy application code
COPY . .

# Update yt-dlp to the latest nightly (npm package may bundle an older version)
RUN node -e "const p = require('path').join(__dirname,'node_modules','yt-dlp-exec','bin','yt-dlp'); const {execSync} = require('child_process'); console.log(execSync(p + ' -U --update-to nightly').toString().trim());"

# Verify yt-dlp and ffmpeg-static binaries work
RUN node -e "const p = require('ffmpeg-static'); const {execSync} = require('child_process'); console.log('ffmpeg:', execSync(p + ' -version').toString().split('\n')[0]);"
RUN node -e "const p = require('path').join(__dirname,'node_modules','yt-dlp-exec','bin','yt-dlp'); const {execSync} = require('child_process'); console.log('yt-dlp:', execSync(p + ' --version').toString().trim());"

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
    CMD curl -f http://localhost:8080/ || exit 1

# Use node directly instead of npm to handle signals properly (graceful shutdown)
CMD ["node", "index.js"]
