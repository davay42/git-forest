FROM node:22-alpine

# Install git and git-daemon (contains git-http-backend)
RUN apk add --no-cache git git-daemon

# 1. Store seed files and the hook in a backup location inside the image
WORKDIR /opt/git-forest-seed
COPY index.js .
COPY examples ./examples/
COPY post-receive.txt .

# 2. Set working directory to /app (where the persistent volume will mount)
WORKDIR /app

EXPOSE 3000

# 3. Inline the entrypoint logic directly into the Dockerfile
# This script runs every time the container starts
ENTRYPOINT ["sh", "-c", "\
    if [ ! -f 'index.js' ]; then \
        echo '[init] 🌱 Empty volume detected. Seeding git-forest...'; \
        cp /opt/git-forest-seed/index.js .; \
        if [ -d '/opt/git-forest-seed/examples' ]; then \
            cp -r /opt/git-forest-seed/examples/* . 2>/dev/null || true; \
        fi; \
        git init -b main; \
        git config user.email 'forest@local'; \
        git config user.name 'Forest Server'; \
        git config receive.denyCurrentBranch updateInstead; \
        mkdir -p .git/hooks; \
        cp /opt/git-forest-seed/post-receive.txt .git/hooks/post-receive; \
        chmod +x .git/hooks/post-receive; \
        git add .; \
        git commit -m 'chore: initial seed'; \
        echo '[init] ✅ Seed complete. Ready for git push.'; \
    fi; \
    exec node index.js \
"]