# One Dockerfile for both apps:
#   docker build --build-arg APP=api -t saas-rsa-api .
#   docker build --build-arg APP=worker -t saas-rsa-worker .

FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/domain/package.json packages/domain/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile
COPY . .
ARG APP=api
RUN pnpm --filter @saas-rsa/${APP} build \
 && pnpm --filter @saas-rsa/${APP} deploy --prod --legacy /out

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
USER node
# Both apps bundle to dist/index.js.
CMD ["node", "dist/index.js"]
