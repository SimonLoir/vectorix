#!/bin/sh
set -eu
# Use private, path-style S3 storage. No public policy or ACL is ever installed.
: "${S3_BUCKET:?S3_BUCKET is required}"
aws configure set default.s3.addressing_style path
# Listing first distinguishes a missing bucket from invalid credentials or an outage.
existing=$(aws s3api list-buckets --query 'Buckets[].Name' --output text)
for bucket in $existing; do
    if [ "$bucket" = "$S3_BUCKET" ]; then
        printf 'Document bucket already exists.\n'
        exit 0
    fi
done
if [ "$AWS_DEFAULT_REGION" = us-east-1 ]; then
    aws s3api create-bucket --bucket "$S3_BUCKET" >/dev/null
else
    aws s3api create-bucket --bucket "$S3_BUCKET" \
        --create-bucket-configuration "LocationConstraint=$AWS_DEFAULT_REGION" >/dev/null
fi
printf 'Private document bucket created.\n'
