FROM python:3.12-slim AS base

RUN useradd -m -u 1000 appuser && \
    mkdir -p /data/users /attachments && \
    chown -R appuser:appuser /data /attachments

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/
RUN chown -R appuser:appuser /app

USER appuser

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

# ── Test stage (not included in production image) ─────────────────────────────
FROM base AS test

USER root
COPY requirements-dev.txt .
RUN pip install --no-cache-dir -r requirements-dev.txt
COPY tests/ ./tests/
RUN chown -R appuser:appuser /app

USER appuser
CMD ["python", "-m", "pytest", "tests/", "-v", "--tb=short"]
