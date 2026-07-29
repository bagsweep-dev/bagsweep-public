FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
# tracker has zero runtime deps and ships no lockfile, so install (not ci)
RUN npm install --omit=dev

COPY server.js ./
COPY lib/ ./lib/
COPY public/ ./public/
COPY deployed-addresses.json ./

EXPOSE 3010

ENV NODE_ENV=production
ENV PORT=3010

CMD ["node", "server.js"]
