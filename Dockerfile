# --- deps & build ---
FROM node:20-slim AS build
RUN apt-get update -y && apt-get install -y openssl
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm install
COPY . .
RUN npx prisma generate
RUN npm run build

# --- runtime ---
FROM node:20-slim AS runtime
RUN apt-get update -y && apt-get install -y openssl
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY prisma ./prisma
# `prisma` is a runtime dependency, not just a build tool: the deploy runs
# `prisma migrate deploy` inside this image. With it in devDependencies,
# --omit=dev left it absent and npx had to re-download the CLI on every
# deploy — a network dependency in the middle of a schema migration.
RUN npm install --omit=dev
RUN npx prisma generate
COPY --from=build /app/dist ./dist

EXPOSE 4000
CMD ["node", "dist/server.js"]
