# Synthetic restore originals

These small, artificial FR/EN originals exercise TXT, Markdown, text PDF and DOCX persistence. The two Markdown files represent successive versions of one document. The files contain no customer data or credentials. `manifest.json` records their original byte lengths and SHA-256 checksums.

Upload version 1 and the PDF/DOCX files into organization A, which uses its saved organization S3 credential. Upload the TXT file into organization B, which uses platform fallback storage. Share Markdown version 1 across two collections with different chunking strategies. After publication and source verification, stop only the owned worker and accept the Markdown version 2 replacement through the dashboard. Its fully uploaded original and pending extraction must survive the backup; version 1 remains the serving source until ordinary replay publishes version 2.

The PDF/DOCX files are deliberately small parser fixtures. The restore acceptance record must state which files actually extracted and which search/source/rebuild actions ran. Their existence alone proves neither a working parser nor a successful restore. Quality and 100,000-child load acceptance use separate fixtures and measurements.
