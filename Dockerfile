FROM mcr.microsoft.com/playwright/python:v1.56.0-noble AS builder
WORKDIR /build
COPY requirements.txt .
RUN python -m pip install --no-cache-dir --target=/opt/python -r requirements.txt
# The collector launches Chromium with Playwright's default headless settings.
RUN mkdir -p /opt/browsers && cp -a /ms-playwright/chromium_headless_shell-* /ms-playwright/ffmpeg-* /opt/browsers/

FROM ubuntu:24.04 AS runtime
ENV PYTHONPATH=/opt/python PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
COPY --from=builder /opt/python /opt/python
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates libreoffice-writer poppler-utils tesseract-ocr && python3 -m playwright install-deps chromium && rm -rf /var/lib/apt/lists/*
COPY --from=builder /opt/browsers /opt/browsers
WORKDIR /srv
COPY app app
RUN useradd -m hiremate && chown hiremate /srv
USER hiremate
CMD ["python3","-m","uvicorn","app.main:app","--host","0.0.0.0","--port","8080"]
