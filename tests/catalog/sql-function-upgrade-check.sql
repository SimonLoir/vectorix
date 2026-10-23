-- Run once on the previous approved chain, before resolving the forward
-- migration. No data changes; the migration itself owns BEGIN/COMMIT. TEMP rows
-- use PostgreSQL's default ON COMMIT PRESERVE ROWS across that boundary.
DO $$ BEGIN
    IF current_database() NOT IN ('vectorix_upgrade_test','vectorix_sql_function_upgrade_test') THEN
        RAISE EXCEPTION 'Function-path upgrade proof requires an owned disposable _test database';
    END IF;
END $$;
CREATE TEMP TABLE sql_function_before AS
SELECT p.oid AS function_oid,pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,
    p.proname,p.proconfig,to_jsonb(p)-'proconfig' AS unchanged_metadata
FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname LIKE 'vectorix\_%' ESCAPE '\';
DO $$ BEGIN
    IF (SELECT count(*) FROM pg_temp.sql_function_before)<>28
        OR EXISTS(SELECT FROM pg_temp.sql_function_before WHERE proconfig IS NOT NULL)
    THEN RAISE EXCEPTION 'Unexpected pre-migration function inventory or configuration'; END IF;
END $$;

-- Controlled old-chain negatives exercise nested name resolution with valid,
-- populated values only. They do not create/change a source domain row. Catch
-- exactly the expected inner helper lookup; a different 42883 must fail.
SELECT pg_catalog.set_config('search_path','',false);
DO $$
DECLARE actual_message text; observed boolean := false; plan public."SemanticChunkPlan";
BEGIN
    BEGIN
        PERFORM public.vectorix_telemetry_phases(
            '{"PLAN":{"samples":"1","sumMicros":"1001","maxMicros":"1001","buckets":["0","1","0","0","0","0","0","0","0","0","0","0","0","0","0","0"]}}',
            'INDEX_SEMANTIC'::public."RagOperationalWorkload");
    EXCEPTION WHEN SQLSTATE '42883' THEN
        GET STACKED DIAGNOSTICS actual_message=MESSAGE_TEXT;
        IF actual_message IS DISTINCT FROM 'function vectorix_telemetry_decimal(jsonb) does not exist' THEN
            RAISE EXCEPTION 'Old-chain telemetry failed on a different undefined function';
        END IF;
        observed:=true;
    END;
    IF NOT observed THEN RAISE EXCEPTION 'Old-chain telemetry did not reproduce its nested lookup defect'; END IF;

    -- Non-CLEANED and nonempty: neither fast path can skip range validation.
    plan:=jsonb_populate_record(NULL::public."SemanticChunkPlan",'{
        "state":"PLANNING","unitCount":2,"completedUnits":0,
        "unitRanges":[{"ordinal":0,"start":0,"end":6},{"ordinal":1,"start":7,"end":12}],
        "boundaryScores":[],"lastUnitVector":null,"finalRanges":null,
        "storedBytes":1000,"reservedBytes":0,"cleanedAt":null,
        "thresholdDistance":null,"planHash":null,"sealedAt":null
    }');
    observed:=false;
    BEGIN
        PERFORM public.vectorix_semantic_plan_payload_valid(plan);
    EXCEPTION WHEN SQLSTATE '42883' THEN
        GET STACKED DIAGNOSTICS actual_message=MESSAGE_TEXT;
        IF actual_message IS DISTINCT FROM 'function vectorix_semantic_ranges_valid(jsonb, integer, boolean) does not exist' THEN
            RAISE EXCEPTION 'Old-chain semantic validation failed on a different undefined function';
        END IF;
        observed:=true;
    END;
    IF NOT observed THEN RAISE EXCEPTION 'Old-chain semantic validation did not reproduce its nested lookup defect'; END IF;
    RAISE NOTICE 'Two controlled old-chain nested-helper 42883 failures reproduced without domain mutations';
END $$;

\ir sql-function-migration.sql

DO $$ BEGIN
    IF (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname LIKE 'vectorix\_%' ESCAPE '\')<>28
        OR EXISTS (
            SELECT FROM pg_temp.sql_function_before prior
            LEFT JOIN pg_catalog.pg_proc current_function ON current_function.oid=prior.function_oid
            WHERE current_function.oid IS NULL
                OR to_jsonb(current_function)-'proconfig' IS DISTINCT FROM prior.unchanged_metadata
                OR current_function.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
        )
    THEN RAISE EXCEPTION 'Function-path migration changed identity, body, ownership, grants or execution attributes'; END IF;
    RAISE NOTICE 'All 28 prior function identities/bodies/owners/ACLs/attributes preserved; only the reviewed local path changed';
END $$;
DROP TABLE pg_temp.sql_function_before;
