FROM node:22.23.1-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY mcp/package.json mcp/package-lock.json ./mcp/
RUN npm ci --ignore-scripts && npm --prefix mcp ci --ignore-scripts

FROM dependencies AS build
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
COPY scripts/rest ./scripts/rest
COPY docs/rest ./docs/rest
COPY mcp/tsconfig.json mcp/tsconfig.build.json ./mcp/
COPY mcp/src ./mcp/src
RUN npm run build

FROM node:22.23.1-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY mcp/package.json mcp/package-lock.json ./mcp/
RUN npm ci --omit=dev --ignore-scripts && npm --prefix mcp ci --omit=dev --ignore-scripts && npm cache clean --force

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
