import type { Entry, ZipFile } from 'yauzl';
import { LIMITS } from './limits';
import { attr, invalid, parseXml } from './docx-xml';
import {
    hasControlCharacters,
    canonicalName,
    resolveTarget,
} from './docx-paths';
import { readPart, type XmlBudget } from './docx-archive';
import type { StoryKind } from './docx-body';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const MAIN_TYPE =
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const OFFICE_REL = new Set([
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
    'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument',
]);
const REL_PREFIXES = [
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/',
    'http://purl.oclc.org/ooxml/officeDocument/relationships/',
];
const STORY_KINDS = new Map<string, StoryKind>([
    ['header', 'header'],
    ['footer', 'footer'],
    ['footnotes', 'footnote'],
    ['endnotes', 'endnote'],
]);
function relationshipKind(type: string) {
    const prefix = REL_PREFIXES.find((candidate) => type.startsWith(candidate));
    return prefix ? type.slice(prefix.length) : undefined;
}
/** Hyperlink destinations remain inert; only bounded supported absolute URLs may be retained in the original package. */
function safeExternalHyperlink(type: string, target: string) {
    if (
        relationshipKind(type) !== 'hyperlink' ||
        target.length > 2048 ||
        hasControlCharacters(target) ||
        !/^(?:https?:\/\/|mailto:)/i.test(target)
    )
        return false;
    try {
        const value = new URL(target);
        return (
            ['http:', 'https:', 'mailto:'].includes(value.protocol) &&
            (value.protocol === 'mailto:'
                ? Boolean(value.pathname)
                : Boolean(value.hostname))
        );
    } catch {
        return false;
    }
}

/** Validate content types and every relationship; external hyperlinks stay inert and annotations stay private. */
export async function readPackageMetadata(
    zip: ZipFile,
    entries: Map<string, Entry>,
    budget: XmlBudget
) {
    const types = entries.get('[content_types].xml');
    const rootRels = entries.get('_rels/.rels');
    if (!types || !rootRels) throw invalid();
    const contentTypes = new Map<string, string>();
    let typesRoot = false;
    parseXml(await readPart(zip, types, LIMITS.metadataXmlBytes, budget), {
        open(tag, depth) {
            if (
                depth > 2 ||
                (depth === 2 && !['Override', 'Default'].includes(tag.local))
            )
                throw invalid();
            if (tag.uri !== CONTENT) throw invalid();
            if (!typesRoot) {
                if (tag.local !== 'Types') throw invalid();
                typesRoot = true;
            }
            if (tag.local === 'Override') {
                const name = attr(tag, 'PartName'),
                    type = attr(tag, 'ContentType');
                if (!name || !type || !name.startsWith('/')) throw invalid();
                const canonical = canonicalName(name.slice(1));
                if (contentTypes.has(canonical)) throw invalid();
                contentTypes.set(canonical, type);
            }
            const type = attr(tag, 'ContentType');
            if (type && /macroenabled|vba|activex|oleobject/i.test(type))
                throw invalid();
        },
    });
    const relationships = new Map<
        string,
        { id: string; type: string; target: string }[]
    >();
    for (const [name, entry] of entries) {
        if (!name.endsWith('.rels')) continue;
        const seen = new Set<string>();
        const retained: { id: string; type: string; target: string }[] = [];
        let relationshipsRoot = false;
        parseXml(await readPart(zip, entry, LIMITS.metadataXmlBytes, budget), {
            open(tag, depth) {
                if (
                    tag.uri !== REL ||
                    depth > 2 ||
                    (depth === 2 && tag.local !== 'Relationship')
                )
                    throw invalid();
                if (!relationshipsRoot) {
                    if (tag.local !== 'Relationships') throw invalid();
                    relationshipsRoot = true;
                }
                if (tag.local !== 'Relationship') return;
                const id = attr(tag, 'Id'),
                    type = attr(tag, 'Type'),
                    target = attr(tag, 'Target'),
                    mode = attr(tag, 'TargetMode');
                if (!id || !type || !target || seen.has(id)) throw invalid();
                seen.add(id);
                if (mode === 'External') {
                    if (!safeExternalHyperlink(type, target)) throw invalid();
                    return;
                }
                if (mode !== undefined && mode !== 'Internal') throw invalid();
                const resolved = resolveTarget(name, target);
                if (
                    !entries.has(resolved) ||
                    /^(?:altChunk|aFChunk|subDocument)$/.test(
                        relationshipKind(type) ?? ''
                    )
                )
                    throw invalid();
                retained.push({ id, type, target: resolved });
            },
        });
        const owner =
            name === '_rels/.rels'
                ? ''
                : name.replace(/(^|\/)_rels\//, '$1').replace(/\.rels$/, '');
        relationships.set(owner, retained);
    }
    const documentLinks =
        relationships.get('')?.filter((link) => OFFICE_REL.has(link.type)) ??
        [];
    if (documentLinks.length !== 1) throw invalid();
    const mainPart = documentLinks[0]!.target;
    if (contentTypes.get(mainPart) !== MAIN_TYPE) throw invalid();
    const mainLinks = relationships.get(mainPart) ?? [];
    const stylesLinks = mainLinks.filter(
        (link) => relationshipKind(link.type) === 'styles'
    );
    if (stylesLinks.length > 1) throw invalid();
    const stories: { id: string; target: string; role: StoryKind }[] = [];
    const rolesByTarget = new Map<string, StoryKind>();
    for (const link of mainLinks) {
        const role = STORY_KINDS.get(relationshipKind(link.type) ?? '');
        if (!role) continue; // Comments are annotations and deliberately excluded from extracted content.
        if (
            rolesByTarget.has(link.target) &&
            rolesByTarget.get(link.target) !== role
        )
            throw invalid();
        const typeName =
            role === 'footnote'
                ? 'footnotes'
                : role === 'endnote'
                  ? 'endnotes'
                  : role;
        if (
            contentTypes.get(link.target) !==
            `application/vnd.openxmlformats-officedocument.wordprocessingml.${typeName}+xml`
        )
            throw invalid();
        rolesByTarget.set(link.target, role);
        stories.push({ id: link.id, target: link.target, role });
    }
    return { mainPart, stylesPart: stylesLinks[0]?.target, stories };
}
