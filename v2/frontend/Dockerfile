FROM node:20-alpine AS builder

ARG VITE_SYNC_INTERVAL_MS=180000
ENV VITE_SYNC_INTERVAL_MS=$VITE_SYNC_INTERVAL_MS

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build


FROM nginxinc/nginx-unprivileged:1.27-alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf.template

EXPOSE 3001

# No internal key in v2 — auth is via httpOnly JWT cookie
CMD ["/bin/sh", "-c", \
  "cp /etc/nginx/conf.d/default.conf.template /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'"]
