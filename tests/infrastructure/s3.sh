#!/bin/sh
set -eu
aws configure set default.s3.addressing_style path
key=checks/private-document.bin
printf 'Vectorix\000S3 round trip\n' > /tmp/expected.bin
case "${1:?Expected write, read, or delete}" in
  write)
    aws s3api put-object --bucket "$S3_BUCKET" --key "$key" --body /tmp/expected.bin >/dev/null
    ;;
  read)
    aws s3api head-object --bucket "$S3_BUCKET" --key "$key" >/dev/null
    aws s3api get-object --bucket "$S3_BUCKET" --key "$key" /tmp/actual.bin >/dev/null
    test "$(sha256sum /tmp/expected.bin | cut -d ' ' -f 1)" = "$(sha256sum /tmp/actual.bin | cut -d ' ' -f 1)"
    ;;
  delete)
    aws s3api delete-object --bucket "$S3_BUCKET" --key "$key" >/dev/null
    if aws s3api head-object --bucket "$S3_BUCKET" --key "$key" 2>/tmp/deleted.err; then
      echo 'Deleted object is still accessible' >&2; exit 1
    fi
    grep -q '404' /tmp/deleted.err
    ;;
  *) exit 2 ;;
esac
printf 'S3 %s check passed.\n' "$1"
