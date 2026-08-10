FROM rust:slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev libsqlite3-dev git ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY Cargo.toml ./
RUN mkdir src && echo "fn main(){}" > src/main.rs
RUN cargo build --release --locked 2>/dev/null || true
RUN rm -rf src

COPY src ./src
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsqlite3-0 ca-certificates git && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd -r appuser && useradd -r -g appuser appuser && \
    mkdir -p /data/v4 && chown -R appuser:appuser /data/v4

WORKDIR /app
COPY --from=builder /app/target/release/productive-v4 ./productive-v4

USER appuser
ENV BIND=0.0.0.0:8000
EXPOSE 8000
CMD ["./productive-v4"]
