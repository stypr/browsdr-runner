# syntax=docker/dockerfile:1

ARG BROWSDR_REF=255ceef490d90733a26baa6c0fde9c2b7d3fb0ef
ARG VITE_BASE_PATH=/
ARG VITE_BACKEND_URL=
ARG VITE_DATABASES_URL=/

FROM node:24-bookworm-slim AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

ARG BROWSDR_REF
ARG VITE_BASE_PATH
ARG VITE_BACKEND_URL
ARG VITE_DATABASES_URL
WORKDIR /source
RUN git init --quiet \
    && git remote add origin https://github.com/jLynx/BrowSDR.git \
    && git fetch --depth 1 origin "$BROWSDR_REF" \
    && git checkout --detach FETCH_HEAD
RUN npm ci --no-audit --no-fund
COPY patch.mjs /tmp/patch.mjs
RUN node /tmp/patch.mjs
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ARG VITE_BASE_PATH
ARG VITE_BACKEND_URL
ENV NODE_ENV=production \
    BROWSDR_BASE_PATH=${VITE_BASE_PATH} \
    BROWSDR_BACKEND_BASE=${VITE_BACKEND_URL}
WORKDIR /app
RUN npm install --no-audit --no-fund --no-package-lock --save-exact express@4.22.3 peer@1.0.2 \
    && npm cache clean --force
COPY --from=build /source/dist ./dist
COPY server.mjs ./server.mjs
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
