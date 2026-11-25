# syntax=docker/dockerfile:1.18@sha256:dabfc0969b935b2080555ace70ee69a5261af8a8f1b4df97b9e7fbcf6722eddf

ARG NODE_IMAGE=node:24.22.2-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d
# The runtime takes only the node binary from NODE_IMAGE, on the same Debian release. The
# npm, corepack and yarn that NODE_IMAGE bundles never run in the server, and their own
# dependencies lag behind security fixes.
ARG DEBIAN_IMAGE=debian:trixie-20261104-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build

ENV PNPM_HOME=/opt/pnpm
ENV PATH=${PNPM_HOME}:${PATH} \
    CI=true
WORKDIR /build

RUN corepack enable \
    && corepack prepare pnpm@10.34.3 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json
COPY patches ./patches
RUN --mount=type=cache,id=artifact-server-pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.json tsconfig.build.json ./
COPY apps/web ./apps/web
COPY src ./src
COPY scripts/local-package-metadata.mjs ./scripts/local-package-metadata.mjs

RUN pnpm build \
    && find dist \( -name '*.d.ts' -o -name '*.d.ts.map' \) -delete \
    && node scripts/local-package-metadata.mjs prepare package.json package.release.json

# The server's production dependencies, installed on their own: `pnpm prune --prod` after the
# build leaves every package of the workspace's install, dev tools included, in
# node_modules/.pnpm. Like the build, it runs on the build platform, so a production dependency
# must not install a platform-specific binary.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS production-dependencies

ENV PNPM_HOME=/opt/pnpm
ENV PATH=${PNPM_HOME}:${PATH} \
    CI=true
WORKDIR /build

RUN corepack enable \
    && corepack prepare pnpm@10.34.3 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN --mount=type=cache,id=artifact-server-pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts

FROM ${NODE_IMAGE} AS node

FROM ${DEBIAN_IMAGE} AS runtime

ARG IMAGE_CREATED=""
ARG IMAGE_REVISION="unknown"
ARG IMAGE_SOURCE=""
ARG IMAGE_SOURCE_TREE_CLEAN="false"
ARG IMAGE_VERSION="0.0.0"

LABEL org.opencontainers.image.created=${IMAGE_CREATED} \
      org.opencontainers.image.description="Self-hosted server for publishing and versioning finished client-side artifacts" \
      org.opencontainers.image.revision=${IMAGE_REVISION} \
      org.opencontainers.image.source=${IMAGE_SOURCE} \
      org.opencontainers.image.title="Artifact Server" \
      org.opencontainers.image.version=${IMAGE_VERSION} \
      org.artifactserver.image.source-tree-clean=${IMAGE_SOURCE_TREE_CLEAN}

ENV ARTIFACT_SERVER_IMAGE_REVISION=${IMAGE_REVISION} \
    HOME=/tmp \
    NODE_ENV=production \
    TMPDIR=/tmp

WORKDIR /opt/artifact-server

COPY --from=node /usr/local/bin/node /usr/local/bin/node

# The same user as NODE_IMAGE's.
RUN groupadd --gid 1000 node \
    && useradd --uid 1000 --gid node --shell /bin/bash --create-home node \
    && install -d -m 0755 /usr/local/share/ca-certificates

ADD --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b \
    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    /usr/local/share/ca-certificates/aws-rds-global-bundle.pem

RUN chmod 0444 /usr/local/share/ca-certificates/aws-rds-global-bundle.pem \
    && mkdir -p /var/lib/artifact-server \
    && chown node:node /var/lib/artifact-server

COPY --from=build --chown=node:node /build/dist ./dist
COPY --from=production-dependencies --chown=node:node /build/node_modules ./node_modules
COPY --from=build --chown=node:node /build/package.release.json ./package.json

USER node:node

EXPOSE 8787

ENTRYPOINT ["node", "dist/cli/main.js"]
CMD ["--help"]
