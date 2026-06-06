FROM node:20-alpine

LABEL maintainer="AI Architecture Scanner"
LABEL description="Scans codebases for AI API usage, cost estimates, and architecture issues"

RUN apk add --no-cache curl

WORKDIR /app

COPY scanner.js     ./scanner.js
COPY diff.js        ./diff.js
COPY cache.js       ./cache.js
COPY entrypoint.sh  ./entrypoint.sh
COPY languages/     ./languages/

RUN chmod +x ./entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]