# SmartCare web + API in one image:  docker compose --profile full up --build
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=development
WORKDIR /app
COPY server/package*.json ./server/
RUN npm --prefix server ci --omit=dev
COPY server ./server
COPY --from=build /app/dist ./dist
COPY public/legacy/kb.json ./public/legacy/kb.json
EXPOSE 5000
HEALTHCHECK --interval=15s --timeout=4s --retries=5 CMD node -e "fetch('http://localhost:5000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/src/index.js"]
