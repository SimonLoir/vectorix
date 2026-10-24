"""Disabled owned queue metadata; exactly two fixed read-only RESP commands."""
from __future__ import annotations

import hashlib
import re
import socket
import time

STATIC_DRAFT_ONLY = True
COMMANDS = ((b'LLEN', b'bull:documents:active'),
    (b'ZREVRANGE', b'bull:documents:completed', b'0', b'0', b'WITHSCORES'))


def response_line(handle, deadline, require, monotonic, maximum=32):
    """Read one bounded RESP line without returning server diagnostics."""
    data = bytearray()
    while not data.endswith(b'\r\n'):
        require(monotonic() < deadline and len(data) < maximum, 'm7c-redis-queue-response-bound')
        handle.settimeout(max(0.001, min(2, deadline - monotonic())))
        part = handle.recv(1)
        require(bool(part), 'm7c-redis-queue-response-ended')
        data.extend(part)
    require(monotonic() < deadline, 'm7c-redis-queue-deadline')
    return bytes(data[:-2])


def integer_reply(handle, deadline, require, monotonic=time.monotonic):
    """Only active count metadata; no Redis error text or job payload escapes."""
    data = response_line(handle, deadline, require, monotonic)
    require(data.startswith(b':') and data[1:].isdigit(), 'm7c-redis-queue-integer-required')
    value = int(data[1:])
    require(0 <= value <= 1000000000, 'm7c-redis-queue-count-bound')
    return value


def completed_reply(handle, deadline, require, monotonic=time.monotonic):
    """Top-one completed tuple, not capped ZCARD: hash identity before projection."""
    count = response_line(handle, deadline, require, monotonic)
    require(count in (b'*0', b'*2'), 'm7c-redis-queue-tuple-required')
    if count == b'*0':
        return None
    values = []
    for maximum in (160, 32):
        length = response_line(handle, deadline, require, monotonic)
        require(length.startswith(b'$') and length[1:].isdigit(), 'm7c-redis-queue-bulk-required')
        size = int(length[1:])
        require(0 < size <= maximum, 'm7c-redis-queue-bulk-bound')
        value = response_line(handle, deadline, require, monotonic, maximum + 2)
        require(len(value) == size, 'm7c-redis-queue-bulk-length')
        values.append(value)
    require(re.fullmatch(rb'[A-Za-z0-9_:\-]{1,160}', values[0]) is not None,
        'm7c-redis-queue-job-identity')
    require(values[1].isdigit() and int(values[1]) <= 9007199254740991,
        'm7c-redis-queue-score-bound')
    return {'jobSha256': hashlib.sha256(values[0]).hexdigest(),
        'completedAtMilliseconds': int(values[1])}


def read_queue(state, admit, require, connect=socket.create_connection, monotonic=time.monotonic):
    """Recheck ownership around one loopback connection; no AUTH/config/write/payload read."""
    require(not STATIC_DRAFT_ONLY, 'm7c-redis-queue-draft-review-required')
    require(state.get('scenario') == 'REDIS_V1' and callable(admit), 'm7c-redis-queue-scenario')
    admit()
    port = state.get('ports', {}).get('redis')
    require(type(port) is int and 1024 < port < 65536, 'm7c-redis-queue-loopback-port')
    deadline = monotonic() + 4
    values = []
    with connect(('127.0.0.1', port), timeout=2) as handle:
        handle.settimeout(2)
        for parts, read in zip(COMMANDS, (integer_reply, completed_reply), strict=True):
            require(monotonic() < deadline, 'm7c-redis-queue-deadline')
            request = b'*' + str(len(parts)).encode() + b'\r\n' + b''.join(
                b'$' + str(len(part)).encode() + b'\r\n' + part + b'\r\n' for part in parts)
            handle.settimeout(max(0.001, min(2, deadline - monotonic())))
            handle.sendall(request)
            values.append(read(handle, deadline, require, monotonic))
    admit()
    return {'activeDocumentScans': values[0], 'latestCompletedDocumentScan': values[1],
        'scope': 'TWO_FIXED_READ_ONLY_OWNED_QUEUE_METADATA_NOT_DOCUMENT_BILLING'}
