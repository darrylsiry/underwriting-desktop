FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir uv==0.11.32
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY . .
ENV PATH="/app/.venv/bin:$PATH"
# Run as an unprivileged user; the app only reads its files.
RUN useradd --system --no-create-home app
USER app
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
