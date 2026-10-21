# syntax=docker/dockerfile:1.7
# Upstream release archives are checksum-verified; build tools stay in this stage.
FROM postgres:18.6-bookworm@sha256:bbf83594798e144bff365a9c191c5d779f181fb3135902064ab8ff11918020fc AS extensions
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl unzip build-essential postgresql-server-dev-18 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN curl -fsSL https://github.com/pgvector/pgvector/archive/refs/tags/v0.8.7.tar.gz -o vector.tar.gz \
    && echo 'cac0b10c360f05b2d521200105ba3697e773d4cd3731f5a915a7e37ebe0bea85  vector.tar.gz' | sha256sum -c - \
    && tar xzf vector.tar.gz \
    && cd pgvector-0.8.7 \
    && make -j2 OPTFLAGS="" \
    && make install DESTDIR=/extensions
RUN case "$TARGETARCH" in \
      amd64) checksum=63f244a4a4ff356d972137a3c501f9359420d1bc5fdc7e0e2bafd138feaac245 ;; \
      arm64) checksum=6b15969f137f59787f9e84892f3cf0782fbc32b932217dd8ed07db3f985b0f96 ;; \
      *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/timescale/pgvectorscale/releases/download/0.9.1/pgvectorscale-0.9.1-pg18-${TARGETARCH}.zip" -o vectorscale.zip \
    && printf '%s  vectorscale.zip\n' "$checksum" | sha256sum -c - \
    && unzip -q vectorscale.zip \
    && dpkg-deb -x "pgvectorscale-postgresql-18_0.9.1-Linux_${TARGETARCH}.deb" /extensions

FROM postgres:18.6-bookworm@sha256:bbf83594798e144bff365a9c191c5d779f181fb3135902064ab8ff11918020fc
COPY --from=extensions /extensions/usr/lib/postgresql/18/ /usr/lib/postgresql/18/
COPY --from=extensions /extensions/usr/share/postgresql/18/ /usr/share/postgresql/18/
COPY infra/postgres-vector/10-vector-store.sql /docker-entrypoint-initdb.d/10-vector-store.sql
COPY --chmod=755 infra/postgres-vector/entrypoint.sh /usr/local/bin/vector-entrypoint.sh
LABEL org.opencontainers.image.title="Vectorix PostgreSQL vector store" \
    org.opencontainers.image.description="PostgreSQL 18.6, pgvector 0.8.7, pgvectorscale 0.9.1"
# Keep the upstream entrypoint: it initializes volume ownership, then drops to postgres.
ENTRYPOINT ["/usr/local/bin/vector-entrypoint.sh"]
CMD ["postgres"]
