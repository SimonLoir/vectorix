/** Pure artificial text generator. No files, environment, services or model calls. */
export const FILE_NAME = 'm7c-semantic-boundary-128-v1.txt';
export const UNIT_COUNT = 128;
export const UNIT_TARGET_BYTES = 1824;
export const PROFILE = Object.freeze({
    targetTokens: 512,
    minTokens: 128,
    maxTokens: 768,
    overlapTokens: 64,
    parentMaxTokens: 2048,
});
export const PREPARATION_CONTRACT = Object.freeze({
    contextTokens: 2048,
    preset: 'EMBEDDING_GEMMA',
});
const SUBJECTS = [
    ['harbor maintenance', 'entretien du port', 'harbor', 'port'],
    ['botanical records', 'archives botaniques', 'garden', 'jardin'],
    ['mountain shelter', 'refuge de montagne', 'shelter', 'refuge'],
    ['community library', 'bibliothèque communale', 'library', 'bibliothèque'],
    ['river observation', 'observation du fleuve', 'river', 'fleuve'],
    ['rural workshop', 'atelier rural', 'workshop', 'atelier'],
    ['regional transport', 'transport régional', 'transport', 'transport'],
    ['coastal habitat', 'habitat côtier', 'coast', 'côte'],
    ['historic archive', 'archives historiques', 'archive', 'archives'],
    ['weather notebook', 'carnet météorologique', 'weather', 'météo'],
    ['neighborhood kitchen', 'cuisine de quartier', 'kitchen', 'cuisine'],
    ['forest nursery', 'pépinière forestière', 'forest', 'forêt'],
    ['museum collection', 'collection du musée', 'museum', 'musée'],
    ['canal operation', 'fonctionnement du canal', 'canal', 'canal'],
    [
        'village cooperative',
        'coopérative du village',
        'cooperative',
        'coopérative',
    ],
    [
        'public observatory',
        'observatoire public',
        'observatory',
        'observatoire',
    ],
];
const ENGLISH = [
    'the local team compares its handwritten register with the shared schedule before assigning the next inspection',
    'each observation records a distinct route a named material and a practical reason for preserving the original note',
    'a volunteer describes the changing light near the entrance while another checks the carefully marked storage area',
    'the fictional coordinator keeps a clear sequence of actions so a later reader can reconstruct the same ordinary activity',
    'weather conditions alter the order of work without changing the responsibilities recorded for the following group',
    'the small committee discusses maintenance access and the difference between a temporary arrangement and a lasting record',
    'these deliberately artificial details form varied prose for an interruption test and provide no factual operating advice',
    'a second notebook retains the reason for each decision while the public summary uses plain language and exact labels',
];
const FRENCH = [
    'le groupe local compare le registre manuscrit avec le calendrier partagé avant de choisir la prochaine inspection',
    'chaque observation décrit un parcours distinct une matière précise et une raison pratique de conserver la note originale',
    'une bénévole décrit la lumière près de l’entrée pendant qu’un collègue vérifie la zone de rangement clairement indiquée',
    'la coordination imaginaire conserve un ordre explicite afin de permettre une lecture attentive de cette activité ordinaire',
    'les conditions météorologiques changent l’ordre du travail sans modifier les responsabilités du groupe suivant',
    'le petit comité discute de l’entretien de l’accès et de la différence entre un arrangement provisoire et une archive durable',
    'ces détails volontairement artificiels composent un texte varié pour un test d’interruption et ne donnent aucun conseil réel',
    'un second carnet conserve les raisons de chaque décision tandis que le résumé public utilise des mots simples et des repères précis',
];
/** Exactly one delimiter-free paragraph per unit, separated only by a blank LF line. */
export function buildBlock(ordinal) {
    if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= UNIT_COUNT)
        throw new Error('FIXTURE_ORDINAL');
    const subject = SUBJECTS[ordinal % SUBJECTS.length],
        french = ordinal % 2 === 1,
        language = french ? 'FR' : 'EN',
        marker = String(ordinal + 1).padStart(3, '0'),
        title = french ? subject[1] : subject[0];
    let text = `ARTIFICIAL INTERRUPTION FIXTURE ${language} UNIT ${marker} — ${title} ; `;
    const phrases = french ? FRENCH : ENGLISH;
    for (let cycle = 0; cycle < 16; cycle++) {
        const sentence =
            phrases[(cycle + ordinal) % phrases.length] +
            (french
                ? ` ; repère ${subject[3]} parcours ${marker} phase ${cycle + 1}`
                : ` ; marker ${subject[2]} route ${marker} phase ${cycle + 1}`);
        for (const word of sentence.split(' ')) {
            const next = text + (text.endsWith(' ') ? '' : ' ') + word;
            if (Buffer.byteLength(next) > UNIT_TARGET_BYTES)
                return text.trimEnd();
            text = next;
        }
    }
    throw new Error('FIXTURE_SHORT_BLOCK');
}
export function buildSource() {
    return (
        Array.from({ length: UNIT_COUNT }, (_, ordinal) =>
            buildBlock(ordinal)
        ).join('\n\n') + '\n'
    );
}
