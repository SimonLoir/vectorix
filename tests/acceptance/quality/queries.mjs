/** Labels are independent of provider rankings and generated child/parent IDs. */
const PAIRS = [
    ['EXACT', 'F01', '"ORION-30" return', '"ORION-30" retour'],
    ['EXACT', 'F03', '"P1-ACK-15" tickets', '"P1-ACK-15" ticket'],
    ['EXACT', 'F04', '"BK-14" backup', '"BK-14" sauvegarde'],
    ['EXACT', 'F05', '"FRT-75" delivery', '"FRT-75" livraison'],
    ['EXACT', 'F08', '"COLD-26" food', '"COLD-26" aliments'],
    [
        'PARAPHRASE',
        'F02',
        'When must I confirm the renewal to keep my existing price?',
        'Quand faut-il confirmer le renouvellement pour garder son tarif ?',
    ],
    [
        'PARAPHRASE',
        'F01',
        'Can an unpacked device still be sent back a few weeks after purchase?',
        "Peut-on encore renvoyer un appareil déballé quelques semaines après l'achat ?",
    ],
    [
        'PARAPHRASE',
        'F03',
        'How quickly will somebody acknowledge a critical outage ticket?',
        'Sous quel délai reçoit-on un accusé de réception pour une panne critique ?',
    ],
    [
        'PARAPHRASE',
        'F05',
        'How much should a normal Belgian basket cost before delivery is free?',
        'Quel montant doit atteindre un panier belge standard pour éviter les frais de livraison ?',
    ],
    [
        'PARAPHRASE',
        'F08',
        'What climate must chilled food stock be kept in?',
        'Dans quelles conditions thermiques doit-on garder les aliments réfrigérés ?',
    ],
    [
        'FILTER',
        'F01',
        'What is the current device return period?',
        'Quel est le délai de retour actuel des appareils ?',
    ],
    [
        'FILTER',
        'F03',
        'How soon is a support ticket acknowledged?',
        'Sous quel délai un ticket de support est-il pris en compte ?',
    ],
    [
        'FILTER',
        'F05',
        'When is shipping free?',
        'À partir de quel montant la livraison est-elle gratuite ?',
    ],
    [
        'FILTER',
        'F04',
        'How long are backups retained?',
        'Combien de temps les sauvegardes sont-elles conservées ?',
    ],
    [
        'FILTER',
        'F07',
        'What is the deadline for this travel claim?',
        'Quel est le délai pour cette demande de remboursement de voyage ?',
    ],
    [
        'PARENT',
        'F06',
        'Where do I take damaged equipment, and which form is needed?',
        'Où déposer le matériel endommagé et quel formulaire faut-il joindre ?',
    ],
    [
        'PARENT',
        'F07',
        'How quickly do I submit travel expenses, and what is the trip limit?',
        'Sous quel délai remettre ses frais de voyage et quel est le plafond par déplacement ?',
    ],
    [
        'PARENT',
        'F04',
        'When does the backup run, and how long is it kept?',
        'À quelle heure la sauvegarde est-elle faite et combien de temps reste-t-elle disponible ?',
    ],
    [
        'PARENT',
        'F08',
        'What temperature is required for food, and how often is its sensor calibrated?',
        'Quelle température faut-il pour les aliments et à quelle fréquence étalonne-t-on le capteur ?',
    ],
    [
        'PARENT',
        'F01',
        'How long can I return an opened device, and what proof do I need?',
        'Combien de temps peut-on retourner un appareil ouvert et quel justificatif faut-il ?',
    ],
];

export function buildQueries(documents) {
    return PAIRS.flatMap(([category, factFamily, english, french], offset) =>
        ['EN', 'FR'].map((language) => {
            const pair = offset + 1;
            const filters = {};
            const crossLanguage = pair === 8 || pair === 9;
            if ([6, 7, 10].includes(pair)) filters.languages = [language];
            if (crossLanguage)
                filters.languages = [language === 'EN' ? 'FR' : 'EN'];
            if (pair === 11)
                filters.metadata = [
                    { field: 'policy_year', operator: 'EQ', value: 2026 },
                    { field: 'active', operator: 'EQ', value: true },
                ];
            if (pair === 12)
                filters.metadata = [
                    { field: 'tier', operator: 'EQ', value: 'critical' },
                ];
            if (pair === 13)
                filters.metadata = [
                    { field: 'region', operator: 'EQ', value: 'BE' },
                    { field: 'tier', operator: 'EQ', value: 'standard' },
                ];
            if (pair === 14)
                filters.metadata = [
                    { field: 'active', operator: 'EQ', value: true },
                    {
                        field: 'effective_at',
                        operator: 'GTE',
                        value: '2026-01-01T00:00:00.000Z',
                    },
                ];
            if (pair === 15) {
                const document = documents.find(
                    (doc) =>
                        doc.factFamily === factFamily &&
                        doc.language === language
                );
                // The later authenticated collector must bind fixture IDs to real document IDs.
                filters.documentFixtureIds = [document.fixtureId];
                filters.mediaTypes = [document.mediaType];
            }
            return {
                id: `Q${String(pair).padStart(2, '0')}-${language}`,
                pair,
                language,
                category,
                crossLanguage,
                text: language === 'EN' ? english : french,
                factFamily,
                filters,
                topK: 10,
                requiresJointParent: category === 'PARENT',
            };
        })
    );
}

export function matchesFilters(document, filters = {}) {
    if (
        filters.languages?.length &&
        !filters.languages.includes(document.language)
    )
        return false;
    if (
        filters.mediaTypes?.length &&
        !filters.mediaTypes.includes(document.mediaType)
    )
        return false;
    if (
        filters.documentFixtureIds?.length &&
        !filters.documentFixtureIds.includes(document.fixtureId)
    )
        return false;
    return (filters.metadata ?? []).every((filter) => {
        const value = document.metadata[filter.field];
        if (filter.operator === 'EQ') return value === filter.value;
        if (filter.operator === 'GTE')
            return (
                typeof value === 'string' &&
                typeof filter.value === 'string' &&
                Date.parse(value) >= Date.parse(filter.value)
            );
        throw new Error('UNSUPPORTED_FILTER');
    });
}

export function buildQrels(documents, queries) {
    return queries.map((query) => ({
        queryId: query.id,
        factDenominator: query.requiresJointParent ? 2 : 1,
        requiredFacts: query.requiresJointParent
            ? ['primary', 'secondary']
            : ['primary'],
        editions: documents
            .filter(
                (doc) =>
                    doc.kind === 'CORE' &&
                    doc.factFamily === query.factFamily &&
                    matchesFilters(doc, query.filters)
            )
            .map((doc) => ({
                fixtureId: doc.fixtureId,
                version: doc.version,
                canonicalSha256: doc.canonicalSha256,
                spans: doc.goldSpans.filter(
                    (span) =>
                        query.requiresJointParent || span.anchorId === 'primary'
                ),
            })),
    }));
}

export const DEVELOPMENT_QUERIES = [
    ['DEV01-EN', 'How can I start a support case?'],
    ['DEV02-FR', 'Comment ouvrir une demande de support ?'],
    ['DEV03-EN', 'Which desk handles equipment?'],
    ['DEV04-FR', 'Quel bureau reçoit le matériel ?'],
    ['DEV05-EN', 'When should I confirm my renewal?'],
    ['DEV06-FR', 'Quand confirmer mon renouvellement ?'],
    ['DEV07-EN', 'Which procedure concerns cold stock?'],
    ['DEV08-FR', 'Quelle procédure concerne le stock réfrigéré ?'],
].map(([id, text]) => ({
    id,
    language: id.endsWith('FR') ? 'FR' : 'EN',
    text,
    scored: false,
}));
