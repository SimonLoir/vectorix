import type { useTranslations } from 'next-intl';
import type { RagOutputs } from '../types';
type Source = RagOutputs['documents']['sourcePreview']['source'];
type Translator = ReturnType<typeof useTranslations<'rag'>>;

/** DOCX positions refer to document parts/paragraphs, never invented physical pages. */
export function sourcePosition(source: Source, tr: Translator) {
    if (source.kind === 'pdf-page')
        return tr('documents.sources.pdfPage', {
            page: source.page ?? source.index + 1,
        });
    if (source.kind === 'docx-paragraph') {
        const paragraph = source.paragraph ?? source.index + 1;
        if (
            source.part &&
            source.part !== 'body' &&
            source.partIndex !== undefined
        )
            return tr(`documents.sources.parts.${source.part}`, {
                part: source.partIndex,
                paragraph,
            });
        if (source.section !== undefined)
            return tr('documents.sources.docxSectionParagraph', {
                section: source.section,
                paragraph,
            });
        return tr('documents.sources.docxParagraph', { paragraph });
    }
    return tr('indexing.textSource');
}
