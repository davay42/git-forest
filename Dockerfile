FROM node:22-alpine

# Install git, git-daemon (for http-backend), and curl (for the post-receive hook)
RUN apk add --no-cache git git-daemon curl

# 1. Store the seed files in a safe, non-mounted directory
WORKDIR /opt/git-forest-seed
COPY index.js .gitignore ./
COPY public ./public

# Templates ship inside the image for `docker cp` — they are NOT seeded
# into /app, since every top-level dir with index.js auto-mounts.
COPY templates /opt/git-forest-templates

# 2. Set the actual working directory (this will be the mounted volume)
WORKDIR /app
EXPOSE 3000

# 3. Meaningful Entrypoint: Seed the volume if empty, then hand over to Node
ENTRYPOINT ["sh", "-c", "\
    if [ ! -f 'index.js' ]; then \
        echo '[docker] 🌱 Empty volume detected. Seeding core files...'; \
        cp -r /opt/git-forest-seed/. . 2>/dev/null || true; \
    fi; \
    exec node index.js \
"]