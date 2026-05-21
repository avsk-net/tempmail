FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN addgroup -S appgroup && adduser -S appuser -G appgroup && chown -R appuser:appgroup /app
USER appuser

# Port 25 requires root on most hosts; map 2525→25 externally if needed
EXPOSE 25

CMD ["node", "server.js"]
