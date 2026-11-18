FROM mcr.microsoft.com/playwright/python:v1.56.0-noble
RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-writer poppler-utils tesseract-ocr && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app app
RUN useradd -m hiremate && chown hiremate /srv
USER hiremate
CMD ["uvicorn","app.main:app","--host","0.0.0.0","--port","8080"]
