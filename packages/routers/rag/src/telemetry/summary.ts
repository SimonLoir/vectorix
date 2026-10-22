import { ragV1 } from '../v1-implementer';
import { getTelemetryOverview } from '../services/telemetry-read';

export const telemetrySummaryHandler = ragV1.telemetry.summary.handler(
    ({ context, input }) => getTelemetryOverview(context, input)
);
