type EmbeddingDefaultVariable =
    | 'VECTORIX_DEFAULT_OLLAMA_ENDPOINT'
    | 'VECTORIX_DEFAULT_COHERE_ENDPOINT'
    | 'VECTORIX_DEFAULT_VOYAGE_ENDPOINT'
    | 'VECTORIX_DEFAULT_OPENAI_ENDPOINT'
    | 'VECTORIX_DEFAULT_MISTRAL_ENDPOINT';

type EndpointAllowlistVariables =
    | {
          defaultVariable: 'VECTORIX_DEFAULT_S3_ENDPOINT';
          allowedVariable: 'VECTORIX_S3_ALLOWED_ENDPOINTS';
      }
    | {
          defaultVariable: EmbeddingDefaultVariable;
          allowedVariable:
              | 'VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS'
              | 'VECTORIX_RERANKING_ALLOWED_ENDPOINTS';
      };

export type EndpointAllowlistWarning = Readonly<{
    variable:
        | EndpointAllowlistVariables['defaultVariable']
        | EndpointAllowlistVariables['allowedVariable'];
    /** One-based original CSV segment index; the default variable always uses one. */
    index: number;
}>;

type EndpointAllowlistSnapshot = Readonly<{
    defaultEndpoint: string | undefined;
    allowedEndpoints: string | undefined;
}>;

function warnInvalidEntry(warning: EndpointAllowlistWarning) {
    console.warn('Ignoring invalid endpoint allowlist entry.', warning);
}

/**
 * Compile every operator entry independently before testing a destination. Each
 * instance retains only its latest raw configuration and normalized destinations;
 * callers must supply a freshly read environment snapshot on every admission.
 * The injected normalizer preserves the caller's existing URL policy. Warnings
 * contain only fixed variable names and original one-based indexes, never URLs or
 * caught errors, and a diagnostic failure cannot change the admission result.
 */
export function createEndpointAllowlist(
    options: EndpointAllowlistVariables & {
        normalize: (endpoint: string) => string;
        warn?: (warning: EndpointAllowlistWarning) => void;
    }
) {
    const { defaultVariable, allowedVariable, normalize } = options;
    let latest:
        | { snapshot: EndpointAllowlistSnapshot; endpoints: Set<string> }
        | undefined;
    const warn = options.warn ?? warnInvalidEntry;

    function compile(snapshot: EndpointAllowlistSnapshot) {
        const endpoints = new Set<string>();
        function add(
            value: string | undefined,
            variable: EndpointAllowlistWarning['variable'],
            index: number
        ) {
            const trimmed = value?.trim();
            if (!trimmed) return;
            try {
                endpoints.add(normalize(trimmed));
            } catch {
                try {
                    warn(Object.freeze({ variable, index }));
                } catch {
                    // Operator diagnostics are best effort and never expose errors.
                }
            }
        }
        add(snapshot.defaultEndpoint, defaultVariable, 1);
        const segments = (snapshot.allowedEndpoints ?? '').split(',');
        for (const [index, segment] of segments.entries()) {
            add(segment, allowedVariable, index + 1);
        }
        return endpoints;
    }

    return {
        allows(endpoint: string, snapshot: EndpointAllowlistSnapshot) {
            if (
                !latest ||
                latest.snapshot.defaultEndpoint !== snapshot.defaultEndpoint ||
                latest.snapshot.allowedEndpoints !== snapshot.allowedEndpoints
            ) {
                const endpoints = compile(snapshot);
                latest = {
                    snapshot: {
                        defaultEndpoint: snapshot.defaultEndpoint,
                        allowedEndpoints: snapshot.allowedEndpoints,
                    },
                    endpoints,
                };
            }
            try {
                return latest.endpoints.has(normalize(endpoint));
            } catch {
                // A malformed requested destination is not an operator warning.
                return false;
            }
        },
    };
}
