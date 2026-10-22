import type { Entry, ZipFile } from 'yauzl';
import {
    DocumentParserError,
    LIMITS,
    hasUsableText,
    validateExtraction,
    type StructuredExtraction,
} from './limits';
import { invalid } from './docx-xml';
import { openDocxArchive, readPart, verifyUnusedParts } from './docx-archive';
import { readPackageMetadata } from './docx-package';
import { readStyles, extractBody, type Style } from './docx-body';
import { createDocumentReferences } from './docx-references';
import { appendReferencedStories } from './docx-stories';

/** ZIP, XML and text have independent limits; all visible Word stories share one final source and storage budget. */
export async function parseDocx(
    bytes: Uint8Array
): Promise<StructuredExtraction> {
    if (
        bytes.length > LIMITS.inputBytes ||
        bytes.length < 4 ||
        bytes[0] !== 0x50 ||
        bytes[1] !== 0x4b
    )
        throw invalid();
    let zip: ZipFile | undefined;
    try {
        const archive = await openDocxArchive(bytes);
        zip = archive.zip;
        const entries = archive.entries;
        const budget = { bytes: 0, read: new Set<Entry>() };
        const { mainPart, stylesPart, stories } = await readPackageMetadata(
            zip,
            entries,
            budget
        );
        const styles = stylesPart
            ? readStyles(
                  await readPart(
                      zip,
                      entries.get(stylesPart)!,
                      LIMITS.metadataXmlBytes,
                      budget
                  )
              )
            : new Map<string, Style>();
        const references = createDocumentReferences();
        const result = extractBody(
            await readPart(
                zip,
                entries.get(mainPart)!,
                LIMITS.mainXmlBytes,
                budget
            ),
            styles,
            'body',
            1,
            references
        );
        await appendReferencedStories({
            zip,
            entries,
            budget,
            styles,
            stories,
            references,
            result,
        });
        if (!hasUsableText(result.text)) throw invalid();
        await verifyUnusedParts(zip, entries, budget);
        return validateExtraction(result);
    } catch (error) {
        if (error instanceof DocumentParserError) throw error;
        throw invalid();
    } finally {
        zip?.close();
    }
}
