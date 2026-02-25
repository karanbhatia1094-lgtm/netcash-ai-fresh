FROM node:20-alpine
RUN apk add --no-cache openssl

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build:prod

EXPOSE 3000
CMD ["npm", "run", "start:prod"]
