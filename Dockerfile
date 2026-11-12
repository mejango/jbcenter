FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS base

FROM base AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY mcp/package.json mcp/package-lock.json ./mcp/
RUN npm ci --ignore-scripts --no-audit --no-fund && npm --prefix mcp ci --ignore-scripts --no-audit --no-fund

FROM dependencies AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts/rest ./scripts/rest
COPY docs/rest ./docs/rest
COPY mcp/tsconfig.json mcp/tsconfig.build.json ./mcp/
COPY mcp/src ./mcp/src
RUN npm run build

FROM base AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY mcp/package.json mcp/package-lock.json ./mcp/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm --prefix mcp ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM production-dependencies AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/mcp/dist ./mcp/dist
COPY mcp/data ./mcp/data
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["node", "dist/src/index.js"]
