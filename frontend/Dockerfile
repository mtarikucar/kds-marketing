# Modeled on the monorepo frontend Dockerfile, pruned (no Tauri/Sentry).
FROM node:20 AS development

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 5173

CMD ["npm", "run", "dev", "--", "--host"]

# Production build stage
FROM node:20-alpine AS build

WORKDIR /app

# API URL is baked in at build time (Vite).
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL

# Release version (the deploy tag, e.g. v2.10.0) — surfaced in the sidebar
# footer so the live version is verifiable in-app. Passed from deploy.yml.
ARG VITE_APP_VERSION
ENV VITE_APP_VERSION=$VITE_APP_VERSION

COPY package*.json ./
RUN npm ci

COPY . .
ENV NODE_ENV=production
RUN npm run build

# Production stage with Nginx
FROM nginx:alpine AS production

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
