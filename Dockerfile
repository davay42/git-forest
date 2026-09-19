FROM node:22-alpine

# Install git, git-daemon (for http-backend), and curl (for the post-receive hook)
RUN apk add --no-cache git git-daemon curl

# 1. Store the seed files in a safe, non-mounted directory
WORKDIR /opt/git-forest-seed
COPY index.js .
COPY .gitignore .

# 2. Set the actual working directory (this will be the mounted volume)
WORKDIR /app
EXPOSE 3000

# 3. Meaningful Entrypoint: Seed the volume if empty, then hand over to Node
ENTRYPOINT ["sh", "-c", "\
    if [ ! -f 'index.js' ]; then \
        echo '[docker] 🌱 Empty volume detected. Seeding core files...'; \
        cp /opt/git-forest-seed/* . 2>/dev/null || true; \
    fi; \
    exec node index.js \
"]