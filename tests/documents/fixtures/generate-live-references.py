#!/usr/bin/env python3
"""Current Word references activate content; retained unused parts remain private source history."""
import sys
sys.dont_write_bytecode = True
import importlib.util
import json
import struct
from pathlib import Path
ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('fixture_live_reference_helpers', ROOT/'generate-fixtures.py')
f = importlib.util.module_from_spec(spec)
spec.loader.exec_module(f)
W=f.W_NS
R='http://schemas.openxmlformats.org/officeDocument/2006/relationships'

def p(text): return f'<w:p><w:r><w:t>{text}</w:t></w:r></w:p>'
def ref(role, id): return f'<w:{role}Reference w:type="default" r:id="{id}"/>'
def main(contents, section): return f'<w:document xmlns:w="{W}" xmlns:r="{R}"><w:body>{contents}<w:sectPr>{section}</w:sectPr></w:body></w:document>'
def note(role, id, text): return f'<w:{role} w:id="{id}">{p(text)}</w:{role}>'

deleted_refs='<w:del w:id="3"><w:r><w:footnoteReference w:id="3"/><w:endnoteReference w:id="3"/></w:r></w:del>'
references=f'<w:p><w:r><w:footnoteReference w:id="2"/><w:endnoteReference w:id="2"/></w:r>{deleted_refs}</w:p>'
historical=f'<w:p><w:pPr><w:pPrChange w:id="7"><w:pPr><w:sectPr>{ref("header","historicalHeader")}</w:sectPr></w:pPr></w:pPrChange></w:pPr><w:r><w:t>Current section remains visible.</w:t></w:r></w:p>'
deleted_section=f'<w:del w:id="4"><w:p><w:pPr><w:sectPr>{ref("header","deletedHeader")}</w:sectPr></w:pPr><w:r><w:delText>DELETED BODY SECRET</w:delText></w:r></w:p></w:del>'
contents=p('Current main text.')+references+historical+deleted_section
parts={
 'header1.xml':('header',f'<w:hdr xmlns:w="{W}">{p("Current header.")}<w:p><w:r><w:footnoteReference w:id="4"/></w:r></w:p></w:hdr>','currentHeader'),
 'header2.xml':('header',f'<w:hdr xmlns:w="{W}">{p("ORPHAN HEADER SECRET")}</w:hdr>','orphanHeader'),
 'header3.xml':('header',f'<w:hdr xmlns:w="{W}">{p("HISTORICAL HEADER SECRET")}</w:hdr>','historicalHeader'),
 'header4.xml':('header',f'<w:hdr xmlns:w="{W}">{p("DELETED HEADER REFERENCE SECRET")}</w:hdr>','deletedHeader'),
 'footer1.xml':('footer',f'<w:ftr xmlns:w="{W}">{p("Current footer.")}</w:ftr>','currentFooter'),
 'footer2.xml':('footer',f'<w:ftr xmlns:w="{W}">{p("ORPHAN FOOTER SECRET")}</w:ftr>','orphanFooter'),
 'footnotes.xml':('footnotes',f'<w:footnotes xmlns:w="{W}">{note("footnote",2,"Current footnote.")}{note("footnote",3,"DELETED FOOTNOTE REFERENCE SECRET")}{note("footnote",4,"Header footnote.")}{note("footnote",5,"ORPHAN FOOTNOTE SECRET")}</w:footnotes>','footnotes'),
 'endnotes.xml':('endnotes',f'<w:endnotes xmlns:w="{W}">{note("endnote",2,"Current endnote.")}{note("endnote",3,"DELETED ENDNOTE REFERENCE SECRET")}{note("endnote",5,"ORPHAN ENDNOTE SECRET")}</w:endnotes>','endnotes'),
}
types=f.CONTENT_TYPES.replace('</Types>',''.join(f'<Override PartName="/word/{name}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.{role}+xml"/>' for name,(role,xml,id) in parts.items())+'</Types>')
relations=f'<Relationships xmlns="{f.REL_NS}">'+''.join(f'<Relationship Id="{id}" Type="{R}/{role}" Target="{name}"/>' for name,(role,xml,id) in parts.items())+'</Relationships>'
def package(body, replacements=None):
    current={**parts,**(replacements or {})}
    return f.make_docx(body,types=types,extra=[('word/_rels/document.xml.rels',relations)]+[(f'word/{name}',xml) for name,(role,xml,id) in current.items()])
section=ref('header','currentHeader')+ref('footer','currentFooter')
(ROOT/'live-references.docx').write_bytes(package(main(contents,section)))
(ROOT/'missing-note-reference.docx').write_bytes(package(main(contents+'<w:p><w:r><w:footnoteReference w:id="99"/></w:r></w:p>',section)))
(ROOT/'missing-header-reference.docx').write_bytes(package(main(contents,ref('header','missingHeader'))))
(ROOT/'wrong-header-role.docx').write_bytes(package(main(contents,ref('header','currentFooter'))))
(ROOT/'ambiguous-header-reference.docx').write_bytes(package(main(contents,section+ref('header','orphanHeader'))))
corrupt=bytearray(package(main(contents,section)))
offset=f.central_header(corrupt,'word/header2.xml')
struct.pack_into('<I',corrupt,offset+16,0x12345678)
(ROOT/'orphan-crc-mismatch.docx').write_bytes(corrupt)
# Active IDs in note stories are unsupported rather than partially followed.
cross=f'<w:footnotes xmlns:w="{W}"><w:footnote w:id="2">{p("Current footnote.")}<w:p><w:r><w:endnoteReference w:id="2"/></w:r></w:p></w:footnote>{note("footnote",4,"Header footnote.")}</w:footnotes>'
(ROOT/'cross-note-reference.docx').write_bytes(package(main(contents,section),{'footnotes.xml':('footnotes',cross,'footnotes')}))
expected=json.loads((ROOT/'expected.json').read_text())
expected['live-references.docx']={'paragraphs':[
 {'paragraph':1,'section':1,'part':'body','partIndex':1,'text':'Current main text.'},
 {'paragraph':2,'section':1,'part':'body','partIndex':1,'text':''},
 {'paragraph':3,'section':1,'part':'body','partIndex':1,'text':'Current section remains visible.'},
 {'paragraph':1,'part':'endnote','partIndex':2,'text':'Current endnote.'},
 {'paragraph':1,'part':'footer','partIndex':3,'text':'Current footer.'},
 {'paragraph':1,'part':'footnote','partIndex':4,'text':'Current footnote.'},
 {'paragraph':2,'part':'footnote','partIndex':4,'text':'Header footnote.'},
 {'paragraph':1,'part':'header','partIndex':5,'text':'Current header.'},
 {'paragraph':2,'part':'header','partIndex':5,'text':''},
 ],'noTextSourceIndices':[1,8],'excludedText':['ORPHAN HEADER SECRET','ORPHAN FOOTER SECRET','HISTORICAL HEADER SECRET','DELETED HEADER REFERENCE SECRET','ORPHAN FOOTNOTE SECRET','ORPHAN ENDNOTE SECRET','DELETED FOOTNOTE REFERENCE SECRET','DELETED ENDNOTE REFERENCE SECRET','DELETED BODY SECRET']}
for name in ['missing-note-reference.docx','missing-header-reference.docx','wrong-header-role.docx','ambiguous-header-reference.docx','orphan-crc-mismatch.docx','cross-note-reference.docx']:
    expected[name]={'expectedError':'FILE_INVALID'}
(ROOT/'expected.json').write_text(json.dumps(expected,ensure_ascii=False,indent=2)+'\n')
print('Generated seven current-reference, orphan-history, missing/ambiguous-reference and unused-CRC fixtures')
