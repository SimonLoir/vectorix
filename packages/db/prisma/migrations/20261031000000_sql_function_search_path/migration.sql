-- Reviewed restore fix: pg_restore uses an empty caller search_path.
-- Keep existing invoker-mode guards bound to trusted public application objects
-- and put pg_temp last without rewriting bodies, data, ACLs or old migrations.
BEGIN;

ALTER FUNCTION public.vectorix_chunk_lexical()
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.vectorix_rag_organization_lock()
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.vectorix_rag_organization_delete()
    SET search_path = pg_catalog, public, pg_temp;

ALTER FUNCTION public.vectorix_semantic_ranges_valid(jsonb, integer, boolean)
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.vectorix_semantic_scores_valid(jsonb)
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.vectorix_semantic_plan_payload_valid(public."SemanticChunkPlan")
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.vectorix_semantic_plan_update()
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.vectorix_embedding_work_update()
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.vectorix_semantic_history_delete()
    SET search_path = pg_catalog, public, pg_temp;

ALTER FUNCTION public.vectorix_parent_generation_identity()
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.vectorix_parent_revision_identity()
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.vectorix_parent_offset_valid(jsonb)
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.vectorix_parent_spans_valid(jsonb, integer, integer)
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.vectorix_parent_chunk_row()
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.vectorix_parent_chunk_link()
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.vectorix_parent_chunk_touch()
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.vectorix_parent_chunk_insert_touch()
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.vectorix_parent_chunk_delete_touch()
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.vectorix_parent_candidate_layout(public."IndexedDocument")
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.vectorix_parent_candidate_state()
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.vectorix_parent_candidate_delete()
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.vectorix_parent_generation_delete()
    SET search_path = pg_catalog, public, pg_temp;

ALTER FUNCTION public.vectorix_telemetry_decimal(jsonb)
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.vectorix_telemetry_phases(jsonb, public."RagOperationalWorkload")
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.vectorix_telemetry_failures(jsonb)
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.vectorix_telemetry_merge_phases(jsonb, jsonb, public."RagOperationalWorkload")
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.vectorix_telemetry_merge_failures(jsonb, jsonb)
    SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.vectorix_telemetry_identity()
    SET search_path = pg_catalog, public, pg_temp;

COMMIT;
