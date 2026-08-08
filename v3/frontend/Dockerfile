FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

ARG VITE_SYNC_INTERVAL_MS=180000
COPY . .
RUN npm run build

FROM nginx:1.27-alpine

RUN addgroup -S appuser && adduser -S appuser -G appuser && \
    touch /var/run/nginx.pid && \
    chown -R appuser:appuser /var/cache/nginx /var/run/nginx.pid /usr/share/nginx/html

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

USER appuser
EXPOSE 3003
CMD ["nginx", "-g", "daemon off;"]
