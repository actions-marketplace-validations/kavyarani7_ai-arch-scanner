FROM node:20-alpine

LABEL maintainer="AI Architecture Scanner"
LABEL description="Scans codebases for AI API usage, cost estimates, and architecture issues"

WORKDIR /app

# Copy scanner files
COPY scanner.js     ./scanner.js
COPY languages/     ./languages/
COPY entrypoint.sh  ./entrypoint.sh

RUN chmod +x ./entrypoint.sh

# No npm install needed — scanner uses only Node built-ins
ENTRYPOINT ["/app/entrypoint.sh"]
