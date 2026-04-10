FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production

COPY . .

# pymupdf for PDF rasterization (no torch needed)
RUN python3 -m venv .venv-pdf && .venv-pdf/bin/pip install --no-cache-dir pymupdf

ENV KB_MARKER_PYTHON=/app/.venv-pdf/bin/python
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]
