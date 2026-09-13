# syntax=docker/dockerfile:1

# Fee Optimizer MCP — stateless Streamable HTTP server image (v0.32).
# Build:  docker build -t fee-optimizer-mcp .
# Run:    docker run --rm -p 3333:3333 \
#           -e FEE_MCP_BEARER_TOKEN=change-me \
#           -e FEE_MCP_RATE_LIMIT_PER_MIN=120 \
#           -e FEE_MCP_ACCESS_LOG=1 \
#           fee-optimizer-mcp
# Probe:  curl http://localhost:3333/health

# ---- builder: full deps + tsc ----
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime: production deps only, non-root ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY data ./data
COPY server.json ./server.json
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3333/health >/dev/null 2>&1 || exit 1
ENTRYPOINT ["node", "dist/index.js", "--transport", "http", "--host", "0.0.0.0", "--port", "3333"]
