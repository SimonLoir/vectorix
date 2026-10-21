#!/bin/sh
set -eu
# Fail before initializing the volume: pgvectorscale's x86 SIMD requirement is
# mandatory, including source builds. Do not silently omit the extension.
case "${1:-}" in
  postgres|-*)
    case "$(uname -m)" in
      x86_64|i686)
        for feature in avx2 fma; do
          if ! grep -Eq "^flags[[:space:]]*:.*[[:space:]]${feature}([[:space:]]|$)" /proc/cpuinfo; then
            echo 'pgvectorscale requires AVX2 and FMA on x86. Enable host CPU passthrough in the VM or use a compatible host.' >&2
            exit 78
          fi
        done
        ;;
    esac
    ;;
esac
exec /usr/local/bin/docker-entrypoint.sh "$@"
