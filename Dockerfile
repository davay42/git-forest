FROM node:22-alpine

RUN apk add --no-cache git git-daemon

WORKDIR /opt/git-forest-seed
COPY index.js .
COPY post-receive.txt .
COPY .gitignore .
# COPY examples ./examples/ 

WORKDIR /app
EXPOSE 3000

# The Self-Healing, Auto-Restoring Entrypoint
ENTRYPOINT ["sh", "-c", "\
    if [ ! -f 'index.js' ]; then \
        echo '[init] 🌱 Empty volume detected.'; \
        if [ -n \"$GITHUB_BACKUP_URL\" ]; then \
            echo '[init] 🔄 Restoring from GitHub backup...'; \
            git clone \"$GITHUB_BACKUP_URL\" . || { echo '[init] ❌ Clone failed. Falling back to fresh seed.'; git init -b main; cp /opt/git-forest-seed/index.js .; }; \
        else \
            git init -b main; \
            cp /opt/git-forest-seed/index.js .; \
        fi; \
        if [ -d '/opt/git-forest-seed/examples' ]; then cp -r /opt/git-forest-seed/examples/* . 2>/dev/null || true; fi; \
        git config user.email 'forest@local'; \
        git config user.name 'Forest Server'; \
        git config receive.denyCurrentBranch updateInstead; \
        mkdir -p .git/hooks; \
        cp /opt/git-forest-seed/post-receive.txt .git/hooks/post-receive; \
        chmod +x .git/hooks/post-receive; \
        git add .; \
        git diff --staged --quiet || git commit -m 'chore: initial seed / restore'; \
        echo '[init] ✅ Ready.'; \
    fi; \
    exec node index.js \
"]