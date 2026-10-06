FROM node:24-bookworm-slim AS node-runtime
WORKDIR /runtime
COPY package.json package-lock.json ./
RUN npm ci

FROM python:3.12-slim-bookworm
WORKDIR /app
ENV PYTHONPATH=/app/backend PYTHONUNBUFFERED=1 INTERFACE_ENV=railway INTERFACE_BROWSER_HEADLESS=true PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /runtime/node_modules /app/node_modules
COPY backend/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt && node node_modules/playwright/cli.js install --with-deps chromium
COPY backend /app/backend
COPY src /app/src
COPY contracts /app/contracts
COPY package.json tsconfig.json /app/
CMD ["sh", "-c", "exec uvicorn interface_api.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1"]
