#!/usr/bin/env python3
"""Build deterministic synthetic originals only in an explicit empty private regeneration directory."""
import hashlib
import argparse
import os
import stat
import sys
sys.dont_write_bytecode = True
import importlib.util
import json
from pathlib import Path
import textwrap
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent
ROOT = next(parent for parent in HERE.parents if (parent / 'pnpm-workspace.yaml').is_file() and (parent / 'packages/documents/src/index.ts').is_file())
spec = importlib.util.spec_from_file_location('vectorix_fixture_builders', ROOT / 'tests/documents/fixtures/generate-fixtures.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
# Smaller regular text, fixed coordinates and no external font/render dependency.
def text_stream(lines):
    return b'BT /F1 10 Tf 48 780 Td 16 TL\n' + b'\n'.join((b'T* ' if index else b'') + helpers.pdf_literal(line) + b' Tj' for index, line in enumerate(lines)) + b'\nET\n'
helpers.text_stream = text_stream
FORMATS = ['txt', 'md', 'pdf', 'docx']
MEDIA = {'txt':'text/plain','md':'text/markdown','pdf':'application/pdf','docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}
FACTS = [
 ('F01', 'ORION-30 returns', 'Retours ORION-30', 'Opened devices: return within 30 days.', 'Appareils ouverts : retour dans les 30 jours.', 'A receipt is required.', 'Un reçu est obligatoire.'),
 ('F02', 'Renewal calendar', 'Calendrier de renouvellement', 'Confirm renewal before 15 May.', 'Confirmez le renouvellement avant le 15 mai.', 'Confirmation keeps the existing tariff.', 'La confirmation conserve le tarif actuel.'),
 ('F03', 'P1-ACK-15 support', 'Support P1-ACK-15', 'Critical P1 tickets: acknowledge within 15 minutes.', 'Ticket critique P1 : accusé de réception en 15 minutes.', 'Submit critical tickets through the support portal.', 'Déposez les tickets critiques sur le portail de support.'),
 ('F04', 'BK-14 backup procedure', 'Procédure de sauvegarde BK-14', 'Retain each backup for 14 days.', 'Conservez chaque sauvegarde pendant 14 jours.', 'The backup runs daily at 02:00 UTC.', 'La sauvegarde est quotidienne à 02:00 UTC.'),
 ('F05', 'FRT-75 standard delivery', 'Livraison standard FRT-75', 'Standard BE delivery is free from EUR75.', 'Livraison standard en BE gratuite dès 75 EUR.', 'This threshold applies to ordinary baskets.', 'Ce seuil concerne les paniers ordinaires.'),
 ('F06', 'Damaged equipment procedure', 'Procédure du matériel endommagé', 'Take damaged equipment to the North reception desk.', 'Déposez le matériel endommagé à la réception Nord.', 'Attach form EQ-7 to the damaged equipment.', 'Joignez le formulaire EQ-7 au matériel endommagé.'),
 ('F07', 'Travel claims procedure', 'Procédure des frais de voyage', 'File travel claims within 10 business days.', 'Déposez les frais de voyage sous 10 jours ouvrables.', 'The limit is EUR450 per trip.', 'Le plafond est de 450 EUR par déplacement.'),
 ('F08', 'COLD-26 food storage', 'Stockage alimentaire COLD-26', 'Keep food stock between 2 and 6 degrees C.', 'Gardez les aliments entre 2 et 6 degrés C.', 'Calibrate its sensor every 14 days.', 'Étalonnez son capteur tous les 14 jours.'),
]
DISTRACTORS = [
 ('D01','Archived ORION-30 policy','Ancienne politique ORION-30','Opened devices: return within 14 days.','Appareils ouverts : retour dans les 14 jours.','This edition applied in 2025.','Cette édition était applicable en 2025.'),
 ('D02','Standard P2 support','Support standard P2','Standard P2 tickets: acknowledge within one hour.','Ticket standard P2 : accusé de réception en une heure.','Acknowledgment is different from resolution.','Un accusé de réception ne signifie pas une résolution.'),
 ('D03','Contract delivery tariff','Tarif de livraison sous contrat','Contract BE delivery is free from EUR35.','Livraison sous contrat en BE gratuite dès 35 EUR.','This is a contract-only tariff.','Ce tarif est réservé aux contrats.'),
 ('D04','Non-food cold storage','Stockage froid non alimentaire','Keep non-food stock between 8 and 12 degrees C.','Gardez les produits non alimentaires entre 8 et 12 degrés C.','This zone does not hold food.','Cette zone ne contient pas d’aliments.'),
]
FILLER = {
 'EN': [
  'The coordinator records the applicable procedure in the local handbook. Staff check the scope of this edition before opening a case and keep the administrative record with the relevant team.',
  'This fictional procedure explains a limited operational task. The desk reviews supporting material, records the request and forwards any unresolved question through its normal internal workflow.',
  'Employees identify the appropriate category and retain the case reference. A supervisor checks that the team has selected the correct edition and that the information remains consistent.',
 ],
 'FR': [
  'La coordination consigne la procédure applicable dans le guide local. Le personnel vérifie la portée de cette édition avant de créer un dossier et conserve son suivi auprès de l’équipe concernée.',
  'Cette procédure fictive décrit une tâche opérationnelle limitée. Le service examine les éléments fournis, enregistre la demande et transmet les questions restantes selon son circuit interne habituel.',
  'Le personnel choisit la catégorie adaptée et conserve la référence du dossier. Une responsable vérifie que l’équipe utilise la bonne édition et que les informations restent cohérentes.',
 ]}
def build(output):
    sources=[]
    originals=output/'originals'
    originals.mkdir(parents=True, exist_ok=True)
    for kind, rows in [('CORE',FACTS),('DISTRACTOR',DISTRACTORS)]:
      for index, row in enumerate(rows):
       fact,en_title,fr_title,en_primary,fr_primary,en_secondary,fr_secondary=row
       for language in ['EN','FR']:
        french=language=='FR'
        extension=FORMATS[(index+(2 if french else 0))%4]
        title=fr_title if french else en_title
        primary=fr_primary if french else en_primary
        secondary=fr_secondary if french else en_secondary
        preface='Corpus M7c fictif. Aucune règle de ce document ne décrit une entreprise réelle.' if french else 'Artificial M7c corpus. No rule in this document describes a real business.'
        paragraphs=[title,preface,primary]
        if fact=='F03' and french:
            paragraphs.append('Repère Unicode contrôlé : café, cafe\u0301 et équipe 🧭. Les positions restent des unités UTF-16.')
        paragraphs += [FILLER[language][position%3] for position in range(15)]
        paragraphs += [secondary, 'Fin du document de référence.' if french else 'End of reference document.']
        key=f'm7c-{fact.lower()}-{language.lower()}-v1'
        path=originals/f'{key}.{extension}'
        if extension=='pdf':
            lines=[]
            for paragraph in paragraphs:
                lines += textwrap.wrap(paragraph, width=64, break_long_words=False, break_on_hyphens=False)
                lines.append('')
            pages=[lines[start:start+36] for start in range(0,len(lines),36)]
            content=helpers.build_pdf(pages,title=title)
        elif extension=='docx':
            body=''.join(f'<w:p>{"<w:pPr><w:pStyle w:val=\"Heading1\"/></w:pPr>" if pos==0 else ""}<w:r><w:t xml:space="preserve">{escape(paragraph)}</w:t></w:r></w:p>' for pos,paragraph in enumerate(paragraphs))
            document=f'<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="{helpers.W_NS}"><w:body>{body}<w:sectPr/></w:body></w:document>'
            content=helpers.make_docx(document)
        else:
            content=('\n\n'.join(('# '+paragraph if extension=='md' and pos==0 else paragraph) for pos,paragraph in enumerate(paragraphs))+'\n').encode('utf8')
        path.write_bytes(content)
        metadata={'region':'BE','policy_year':2026,'active':True,'effective_at':'2026-01-01T00:00:00.000Z','tier':'critical' if fact=='F03' else 'standard'}
        if fact=='D01': metadata.update(policy_year=2025,active=False,effective_at='2025-01-01T00:00:00.000Z')
        if fact=='D02': metadata['tier']='standard'
        if fact=='D03': metadata['tier']='contract'
        if fact=='D04': metadata['active']=False
        sources.append({'fixtureId':key,'kind':kind,'factFamily':fact,'language':language,'mediaType':MEDIA[extension],'fileName':path.name,'originalPath':f'originals/{path.name}','originalSha256':hashlib.sha256(content).hexdigest(),'originalBytes':len(content),'version':1,'metadata':metadata,'tags':['m7c-reference-v1',fact.lower()], 'anchors':{'primary':primary,'secondary':secondary}})
    manifest={'schemaVersion':1,'namespace':'vectorix-m7c-quality','status':'PREPARED_NOT_INDEXED','metadataFields':{'region':'STRING','policy_year':'NUMBER','active':'BOOLEAN','effective_at':'DATE','tier':'STRING'},'documents':sources}
    (output/'source-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    return manifest
if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-directory', required=True, type=Path)
    args=parser.parse_args()
    output=args.output_directory
    cache=ROOT/'node_modules/.cache/vectorix'
    info=output.lstat()
    if not (output.is_absolute() and output.resolve()==output and output.is_relative_to(cache)
            and output!=cache and stat.S_ISDIR(info.st_mode) and info.st_uid==os.getuid()
            and stat.S_IMODE(info.st_mode)==0o700 and not any(output.iterdir())):
        parser.error('Use a new empty private directory under node_modules/.cache/vectorix')
    manifest=build(output)
    print(json.dumps({'status':'PREPARED_NOT_INDEXED','sources':len(manifest['documents']),'providerCalls':0}))
