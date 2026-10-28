# syntax=docker/dockerfile:1
# --- build stage ------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime stage ----------------------------------------------------------
# The executor only. The agent engine (claude CLI or a custom build) is NOT
# bundled: mount it or install it, then point AWCE_AGENT_BIN at it —
#   docker run ... -v "$HOME/.claude:/root/.claude" \
#     -e AWCE_AGENT_BIN=claude ...
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY docs ./docs
COPY LICENSE README.md ./
RUN mkdir -p /workspace && chown node:node /workspace
USER node
ENV AWCE_WORKSPACE_ROOT=/workspace
ENTRYPOINT ["node", "dist/main.js"]
