# Use Debian (trixie) as the base image
FROM node:trixie

# Set the working directory
WORKDIR /home/bots/StreamBot

# Install minimal dependencies
RUN apt-get update && apt-get install -y curl ca-certificates unzip && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install bun and add to PATH (pinned, so a new bun release can't change how the build behaves)
ENV BUN_INSTALL="/usr/local/"
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.4"

# Install remaining dependencies and clean cache
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Copy package.json and the lockfile, so the build uses the exact tested dependency versions
COPY package.json bun.lock ./

# Install dependencies (frozen: newer, untested versions of the voice libraries can break joining voice)
RUN bun install --frozen-lockfile

# The install above already runs the setup scripts of everything in package.json's
# "trustedDependencies" (bun 1.4.4+ reads that list from package.json), so there is no
# separate "bun pm trust" step anymore: on bun 1.4.4 it fails with "0 scripts ran".
# Instead, check that the native modules the web login needs actually load.
RUN bun -e "require('bcrypt'); require('argon2'); console.log('native modules OK')"

# Copy the rest of the application code
COPY . .

# Verify the application builds
RUN bun run build

# Specify the port number the container should expose
EXPOSE 3000

# Create videos folder
RUN mkdir -p ./videos

# Command to run the application
CMD ["bun", "run", "start"]
