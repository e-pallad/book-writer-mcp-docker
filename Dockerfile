FROM node:20-alpine

WORKDIR /app

# Install dependencies first so they stay cached across source changes
COPY package.json package-lock.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Default location for the book project; mount a volume here to keep the data
ENV BOOK_PROJECT_DIR=/app/data
ENV PORT=3456
EXPOSE 3456

CMD ["node", "dist/http-server.js"]
