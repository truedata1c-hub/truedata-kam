# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci
COPY web ./web
RUN cd web && npm run build

FROM node:22-bookworm-slim
LABEL org.opencontainers.image.source=https://github.com/truedata1c-hub/truedata-kam
LABEL org.opencontainers.image.description="PharmaCheck · Переговоры"
ARG APP_VERSION=dev
ENV NODE_ENV=production APP_VERSION=$APP_VERSION
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY migrations ./migrations
COPY deploy/compose.yaml ./deploy/compose.yaml
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/server.js"]
