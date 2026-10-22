DO $$ BEGIN
    IF NOT EXISTS(SELECT FROM organization WHERE id='observability-upgrade-org' AND name='Pre-observation organization')
        OR EXISTS(SELECT FROM "OrganizationRagTelemetry")
        OR EXISTS(SELECT FROM "RagOperationalHour")
        OR EXISTS(SELECT FROM "RagWorkerLaneObservation")
    THEN RAISE EXCEPTION 'Observability migration changed existing data or fabricated historical observations'; END IF;
END $$;
