# Use official Bun runtime
FROM oven/bun:latest

# Set working directory
WORKDIR /app

# Copy dependency files first for better Docker layer caching
COPY package.json bun.lock* ./

# Install dependencies
RUN bun install --frozen-lockfile --production

# Copy the application code
COPY . .

# Create necessary directories for persistent storage
RUN mkdir -p /app/config/providers /app/config/models /app/config/templates

# Expose the default port
EXPOSE 9876

# Specify the command to run on container startup
CMD ["bun", "run", "start"]
