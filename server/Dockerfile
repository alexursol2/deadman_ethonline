# syntax=docker/dockerfile:1
FROM node:22-alpine

WORKDIR /app

# Dependencies first, so a code change does not reinstall the world.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src

# Config comes from the host's environment, never from a baked .env. The server
# reads a repo-root .env only when one exists, which it will not in the image.
ENV NODE_ENV=production
ENV PORT=4021
EXPOSE 4021

# tsx runs the TypeScript directly. No build step, so what runs is what is in
# the repo — which matters when a judge is reading the source.
CMD ["npx", "tsx", "src/index.ts"]
