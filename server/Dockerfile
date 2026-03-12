FROM node:22-alpine

# Install system dependencies (ffmpeg for audio conversion, python3 for yt-dlp, curl for healthcheck)
RUN apk add --no-cache ffmpeg curl python3 \
    && ffmpeg -version \
    && python3 --version \
    && echo "System dependencies installed successfully"

# Create a non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy package files first (leverages Docker layer caching)
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev \
    && npm cache clean --force

# Copy application code
COPY . .

# Ensure yt-dlp binary is accessible and working
RUN npx yt-dlp-exec --version || echo "Warning: yt-dlp version check failed"

# Remove unnecessary files from the image
RUN rm -f Dockerfile apprunner.yaml .dockerignore

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
