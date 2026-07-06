FROM node:22-alpine

WORKDIR /app

# Copy dependency files
COPY package.json ./
COPY server/package*.json ./server/

# Install server dependencies
WORKDIR /app/server
RUN npm ci --only=production

# Copy application files
WORKDIR /app
COPY server ./server
COPY public ./public

# Ensure necessary directories exist
RUN mkdir -p /app/server/data \
    /app/server/uploads/materials \
    /app/server/uploads/videos \
    /app/server/uploads/exercises

EXPOSE 3000

ENV PORT=3000
ENV NODE_ENV=production

# Start the application
CMD ["npm", "--prefix", "server", "start"]
