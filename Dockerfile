FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml tsconfig.json vitest.config.ts ./
RUN pnpm install --frozen-lockfile
RUN pnpm approve-builds --all

COPY src ./src
COPY tests ./tests
RUN pnpm build
RUN pnpm prune --prod

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV BOT_PATH=/bot

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY docker/entrypoint.sh ./docker/entrypoint.sh

RUN chmod +x ./docker/entrypoint.sh

ENTRYPOINT ["./docker/entrypoint.sh"]
