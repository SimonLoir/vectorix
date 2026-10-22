-- Before M7b.2, preserve a real legacy organization without inventing a
-- historical tracking marker or deriving observations from existing rows.
INSERT INTO organization (id,name,slug,"createdAt")
VALUES ('observability-upgrade-org','Pre-observation organization','observability-upgrade-org',now());
