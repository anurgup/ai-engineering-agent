# ─── Stage 1: Build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source and compile TypeScript
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# git is required by simple-git for branch/commit/push operations
RUN apk add --no-cache git

WORKDIR /app

# Copy compiled output and production dependencies only
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./

# Configure git identity (used when committing generated code)
RUN git config --global user.email "agent@automated-dev.ai" && \
    git config --global user.name "AI Engineering Agent"

# Default repo clone location inside the container
ENV LOCAL_REPO_PATH=/app/repo

EXPOSE 3000

CMD ["node", "dist/webhook.js"]
