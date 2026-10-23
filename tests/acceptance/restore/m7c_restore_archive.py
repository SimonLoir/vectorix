"""Pure archive normalization and fixed role-import checks; no resource operations on import."""
import re

from m7c_restore_common import require

MAX_ROLES = 1024 * 1024
MAX_SCHEMA = 8 * 1024 * 1024


# PostgreSQL 18 can flatten one BETWEEN-derived nested AND after dump/reparse.
# These are proof-only, reviewed literal equivalences from the approved chain;
# no other CHECK, expression, whitespace or function body is canonicalized.
_CHECK_GROUPS = {
    b'EmbeddingWorkAttempt': {
        'constraint': b'EmbeddingWorkAttempt_bounds_check', 'kind': b'TABLE',
        'fragment': b'((length(("operationKey")::text) >= 1) AND (length(("operationKey")::text) <= 128))',
    },
    b'OrganizationQuota': {
        'constraint': b'OrganizationQuota_semantic_limits_check', 'kind': b'TABLE',
        'fragment': b'(("semanticUnitsPerDocument" >= 1) AND ("semanticUnitsPerDocument" <= 8192))',
    },
    b'SemanticChunkPlan': {
        'constraint': b'SemanticChunkPlan_bounds_check', 'kind': b'CHECK CONSTRAINT',
        'fragment': b'((octet_length("lastUnitVector") >= 4) AND (octet_length("lastUnitVector") <= 64000))',
    },
}
_SCHEMA_HEADER = re.compile(rb'-- Name: ([^;\r\n]+); Type: ([A-Z ]+); Schema: ([^;\r\n]+); Owner: [^\r\n]*\r?\n?')
_DOLLAR_TAG = re.compile(rb'\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$')


def _clear_sql(state):
    return state['dollar'] is None and state['quote'] is None and state['comment'] == 0


def _scan_sql_line(line, state, observed_positions=()):
    """Track quoted bodies/comments only; never parse or rewrite arbitrary SQL."""
    code_positions, index = set(), 0
    while index < len(line):
        if state['dollar'] is not None:
            closing = line.find(state['dollar'], index)
            if closing < 0:
                break
            index = closing + len(state['dollar'])
            state['dollar'] = None
            continue
        if state['comment']:
            if line[index:index + 2] == b'/*':
                state['comment'] += 1
                index += 2
            elif line[index:index + 2] == b'*/':
                state['comment'] -= 1
                index += 2
            else:
                index += 1
            continue
        if state['quote'] is not None:
            if state['escape'] and line[index:index + 1] == b'\\':
                index += 2
                continue
            if line[index:index + 1] == state['quote']:
                if line[index + 1:index + 2] == state['quote']:
                    index += 2
                    continue
                state['quote'] = None
                state['escape'] = False
            index += 1
            continue
        if index in observed_positions:
            code_positions.add(index)
        if line[index:index + 2] == b'--':
            break
        if line[index:index + 2] == b'/*':
            state['comment'] = 1
            index += 2
            continue
        character = line[index:index + 1]
        if character in (b"'", b'"'):
            state['quote'] = character
            # pg_dump enables standard_conforming_strings. Explicit E strings
            # retain their backslash escapes; quoted identifiers use only "".
            state['escape'] = character == b"'" and index > 0 and line[index - 1:index] in (b'e', b'E') and (index < 2 or not chr(line[index - 2]).isalnum())
        elif character == b'$' and (index == 0 or not (chr(line[index - 1]).isalnum() or line[index - 1:index] in (b'_', b'$'))):
            match = _DOLLAR_TAG.match(line, index)
            if match:
                state['dollar'] = match[0]
                index = match.end()
                continue
        index += 1
    return code_positions


def _known_check_replacement(line, table):
    item = _CHECK_GROUPS[table]
    fragment = item['fragment']
    if item['kind'] == b'TABLE':
        prefix = b'    CONSTRAINT "' + item['constraint'] + b'" CHECK (('
        source = prefix + fragment + b' AND '
        canonical = prefix + fragment[1:-1] + b' AND '
        return (0, source, canonical) if line.startswith(source) else None
    prefix = b'    ADD CONSTRAINT "' + item['constraint'] + b'" CHECK ('
    source = b' AND (("lastUnitVector" IS NULL) OR (' + fragment + b' AND ((octet_length("lastUnitVector") % 4) = 0))) AND '
    canonical = b' AND (("lastUnitVector" IS NULL) OR (' + fragment[1:-1] + b' AND ((octet_length("lastUnitVector") % 4) = 0))) AND '
    position = line.find(source)
    return (position, source, canonical) if line.startswith(prefix) and position >= 0 else None


def normalized_schema(raw):
    """Omit psql random keys and only three reviewed redundant AND groupings.

    All other bytes remain significant. Function bodies, quoted literals, block
    comments, unknown schemas/tables/CHECKs and unreviewed deparser differences
    remain unchanged and therefore fail a mismatching full-schema proof.
    """
    require(len(raw) <= MAX_SCHEMA, 'schema-output-bound')
    result, active_key, pairs = [], None, 0
    state = {'dollar': None, 'quote': None, 'escape': False, 'comment': 0}
    header_context, statement_table, seen_checks = None, None, set()
    for line in raw.splitlines(keepends=True):
        clear = _clear_sql(state)
        if clear and line.startswith((b'\\restrict ', b'\\unrestrict ')):
            require(re.fullmatch(rb'\\(?:un)?restrict [A-Za-z0-9]{1,128}\r?\n?', line) is not None, 'schema-restrict-key-format')
            if line.startswith(b'\\restrict '):
                require(active_key is None and pairs < 8, 'schema-restrict-key-pair')
                active_key = line.strip().split(b' ')[1]
            else:
                require(active_key is not None and active_key == line.strip().split(b' ')[1], 'schema-restrict-key-pair')
                active_key = None
                pairs += 1
            continue
        if clear:
            header = _SCHEMA_HEADER.fullmatch(line)
            if header:
                header_context, statement_table = None, None
                if header[3] == b'public':
                    for table, item in _CHECK_GROUPS.items():
                        expected = table if item['kind'] == b'TABLE' else table + b' ' + item['constraint']
                        if header[1] == expected and header[2] == item['kind']:
                            header_context = table
            if header_context is not None:
                item = _CHECK_GROUPS[header_context]
                expected = (b'CREATE TABLE public."' + header_context + b'" (' if item['kind'] == b'TABLE'
                            else b'ALTER TABLE public."' + header_context + b'"')
                if line.rstrip(b'\r\n') == expected:
                    statement_table = header_context
        replacement = None
        if clear and statement_table is not None:
            item = _CHECK_GROUPS[statement_table]
            prefix = (b'    CONSTRAINT "' if item['kind'] == b'TABLE' else b'    ADD CONSTRAINT "') + item['constraint'] + b'" CHECK ('
            if line.startswith(prefix):
                require(statement_table not in seen_checks, 'schema-known-check-duplicate')
                seen_checks.add(statement_table)
                replacement = _known_check_replacement(line, statement_table)
        positions = _scan_sql_line(line, state, [replacement[0]] if replacement else [])
        if replacement and replacement[0] in positions:
            position, source, canonical = replacement
            require(line.count(source) == 1, 'schema-known-check-fragment-count')
            line = line[:position] + canonical + line[position + len(source):]
        result.append(line)
        if clear and statement_table is not None:
            if line.rstrip(b'\r\n') == b');' or (_CHECK_GROUPS[statement_table]['kind'] == b'CHECK CONSTRAINT' and line.rstrip(b'\r\n').endswith(b';')):
                statement_table = None
    # PostgreSQL 18 --create closes restriction before reconnecting, then enables it again.
    require(active_key is None, 'schema-restrict-key-pair')
    return b''.join(result)


def reviewed_role_import(raw, expected_roles):
    """Preserve original ALTER/password hashes, removing only already-bootstrapped exact CREATEs."""
    require(0 < len(raw) <= MAX_ROLES, 'roles-output-bound')
    require(set(expected_roles) in [{'postgres'}, {'postgres', 'vectorix_indexer', 'vectorix_runtime'}], 'reviewed-role-set')
    lines, creates, alters, restrict_keys, unrestrict_keys = [], set(), set(), [], []
    role_alter = re.compile(r'''ALTER ROLE "([a-z_]+)" WITH (?:NO)?SUPERUSER (?:NO)?INHERIT (?:NO)?CREATEROLE (?:NO)?CREATEDB LOGIN (?:NO)?REPLICATION (?:NO)?BYPASSRLS(?: CONNECTION LIMIT -1)? PASSWORD '(SCRAM-SHA-256\$[1-9][0-9]{0,7}:[A-Za-z0-9+/]{1,128}={0,2}\$[A-Za-z0-9+/]{1,128}={0,2}:[A-Za-z0-9+/]{1,128}={0,2})';''')
    permitted_setup = {
        'SET default_transaction_read_only = off;', "SET client_encoding = 'UTF8';",
        'SET standard_conforming_strings = on;', "SELECT pg_catalog.set_config('search_path', '', false);",
        'SET statement_timeout = 0;', 'SET lock_timeout = 0;', 'SET idle_in_transaction_session_timeout = 0;',
        'SET transaction_timeout = 0;', 'SET check_function_bodies = false;', 'SET xmloption = content;',
        'SET client_min_messages = warning;', 'SET row_security = off;',
    }
    for line in raw.decode('utf8').splitlines(keepends=True):
        if line.startswith('CREATE ROLE '):
            match = re.fullmatch(r'CREATE ROLE "([a-z_]+)";\r?\n?', line)
            require(match is not None and match[1] in expected_roles and match[1] not in creates, 'reviewed-precreated-role')
            creates.add(match[1])
            continue
        if line.startswith('ALTER ROLE '):
            match = role_alter.fullmatch(line.rstrip('\r\n'))
            require(match is not None and match[1] in expected_roles and match[1] not in alters, 'reviewed-role-alteration')
            alters.add(match[1])
        elif line.startswith(('\\restrict ', '\\unrestrict ')):
            match = re.fullmatch(r'\\(un)?restrict ([A-Za-z0-9]{1,128})\r?\n?', line)
            require(match is not None, 'reviewed-roles-meta-command')
            (unrestrict_keys if match[1] else restrict_keys).append(match[2])
        else:
            require(not line.strip() or line.startswith('--') or line.rstrip('\r\n') in permitted_setup,
                    'unexpected-roles-dump-statement')
        lines.append(line)
    require(creates == set(expected_roles) and alters == set(expected_roles), 'complete-reviewed-role-dump')
    require(restrict_keys == unrestrict_keys and len(restrict_keys) <= 1, 'roles-restrict-key-pair')
    return ''.join(lines).encode('utf8')
