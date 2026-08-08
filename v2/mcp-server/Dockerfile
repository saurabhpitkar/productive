FROM python:3.12-slim

RUN useradd -m -u 1000 appuser

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY mcp_server/ ./mcp_server/
RUN chown -R appuser:appuser /app

USER appuser

EXPOSE 3002

ENV MCP_TRANSPORT=sse
ENV MCP_PORT=3002

CMD ["python", "-m", "mcp_server.main"]
