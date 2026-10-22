#!/usr/bin/env python3
"""Generate real safe-hyperlink and multi-story Word packages; all content is synthetic."""
import sys
sys.dont_write_bytecode = True
import importlib.util
import json
from pathlib import Path
ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('fixture_story_helpers', ROOT / 'generate-fixtures.py')
f = importlib.util.module_from_spec(spec)
spec.loader.exec_module(f)
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
W = f.W_NS

def paragraph(text):
    return f'<w:p><w:r><w:t>{text}</w:t></w:r></w:p>'

def main_body(contents, section=""):
    return f'<w:document xmlns:w="{W}" xmlns:r="{R[:-1]}"><w:body>{contents}<w:sectPr>{section}</w:sectPr></w:body></w:document>'

def relation(name, kind, target, mode=''):
    return f'<Relationship Id="{name}" Type="{R}{kind}" Target="{target}"{mode}/>'

def relations(content):
    return f'<Relationships xmlns="{f.REL_NS}">{content}</Relationships>'

hyperlink = main_body('<w:p><w:hyperlink r:id="http"><w:r><w:t>Open the English source.</w:t></w:r></w:hyperlink></w:p>' + paragraph('Lien français et adresse email.'))
links = relations(relation('http','hyperlink','http://127.0.0.1:1/never-dereference',' TargetMode="External"') + relation('https','hyperlink','https://example.invalid/never-dereference',' TargetMode="External"') + relation('mail','hyperlink','mailto:fixture@example.invalid',' TargetMode="External"'))
(ROOT/'hyperlinks.docx').write_bytes(f.make_docx(hyperlink, extra=[('word/_rels/document.xml.rels', links)]))

parts = {
    'header1.xml': ('header', f'<w:hdr xmlns:w="{W}">{paragraph("En-tête français.")}</w:hdr>'),
    'footer1.xml': ('footer', f'<w:ftr xmlns:w="{W}">{paragraph("English footer.")}</w:ftr>'),
    'footnotes.xml': ('footnotes', f'<w:footnotes xmlns:w="{W}"><w:footnote w:type="separator" w:id="-1">{paragraph("OMIT FOOTNOTE SEPARATOR")}</w:footnote><w:footnote w:id="2">{paragraph("Note de bas de page française.")}</w:footnote></w:footnotes>'),
    'endnotes.xml': ('endnotes', f'<w:endnotes xmlns:w="{W}"><w:endnote w:type="continuationSeparator" w:id="0">{paragraph("OMIT ENDNOTE SEPARATOR")}</w:endnote><w:endnote w:id="2">{paragraph("English endnote.")}</w:endnote></w:endnotes>'),
    'comments.xml': ('comments', f'<w:comments xmlns:w="{W}"><w:comment w:id="1">{paragraph("OMIT COMMENT ANNOTATION")}</w:comment></w:comments>'),
}
types = f.CONTENT_TYPES.replace('</Types>', ''.join(f'<Override PartName="/word/{name}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.{kind}+xml"/>' for name,(kind,xml) in parts.items())+'</Types>')
story_links = relations(''.join(relation(name,kind,name) for name,(kind,xml) in parts.items()))
body = main_body(paragraph('Main body — corps principal.') + '<w:p><w:r><w:footnoteReference w:id="2"/><w:endnoteReference w:id="2"/></w:r></w:p>', '<w:headerReference w:type="default" r:id="header1.xml"/><w:footerReference w:type="default" r:id="footer1.xml"/>')
(ROOT/'stories.docx').write_bytes(f.make_docx(body, types=types, extra=[('word/_rels/document.xml.rels',story_links)]+[(f'word/{name}',xml) for name,(kind,xml) in parts.items()]))

limit_body = main_body(paragraph('Body paragraph.')*3000, '<w:headerReference w:type="default" r:id="head"/>')
limit_header = f'<w:hdr xmlns:w="{W}">{paragraph("Header paragraph.")*2001}</w:hdr>'
limit_types = f.CONTENT_TYPES.replace('</Types>', '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>')
(ROOT/'story-paragraph-limit.docx').write_bytes(f.make_docx(limit_body, types=limit_types, extra=[('word/_rels/document.xml.rels',relations(relation('head','header','header1.xml'))),('word/header1.xml',limit_header)]))

# External non-hyperlink resources still fail closed and are never dereferenced.
external_image = relations(relation('image','image','https://example.invalid/private-image',' TargetMode="External"'))
(ROOT/'external-relationship.docx').write_bytes(f.make_docx(extra=[('word/_rels/document.xml.rels',external_image)]))

# A metadata title can contain an Encrypted line; the trusted trailing structural flag owns the decision.
(ROOT/'spoofed-encrypted-title.pdf').write_bytes(f.build_pdf([['Unencrypted metadata spoof regression.']], title='Valid title\nEncrypted: yes'))
expected = json.loads((ROOT/'expected.json').read_text())
expected['hyperlinks.docx'] = {'paragraphs':[{'paragraph':1,'section':1,'part':'body','partIndex':1,'text':'Open the English source.'},{'paragraph':2,'section':1,'part':'body','partIndex':1,'text':'Lien français et adresse email.'}], 'excludedText':['never-dereference','example.invalid','127.0.0.1']}
expected['stories.docx'] = {'paragraphs':[
    {'paragraph':1,'section':1,'part':'body','partIndex':1,'text':'Main body — corps principal.'},
    {'paragraph':2,'section':1,'part':'body','partIndex':1,'text':''},
    {'paragraph':1,'part':'endnote','partIndex':2,'text':'English endnote.'},
    {'paragraph':1,'part':'footer','partIndex':3,'text':'English footer.'},
    {'paragraph':1,'part':'footnote','partIndex':4,'text':'Note de bas de page française.'},
    {'paragraph':1,'part':'header','partIndex':5,'text':'En-tête français.'}], 'noTextSourceIndices':[1], 'excludedText':['OMIT FOOTNOTE','OMIT ENDNOTE','OMIT COMMENT']}
expected['story-paragraph-limit.docx'] = {'expectedError':'PARSER_LIMIT'}
expected['spoofed-encrypted-title.pdf'] = {'pages':['Unencrypted metadata spoof regression.']}
(ROOT/'expected.json').write_text(json.dumps(expected,ensure_ascii=False,indent=2)+'\n')
print('Generated safe hyperlinks, visible DOCX stories, combined paragraph limit and PDF metadata spoof fixtures')
