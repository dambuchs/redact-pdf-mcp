"""Builds tagged.docx with Python's zipfile, an implementation independent of src/restore.ts.
Run: python3 test/fixtures/make-tagged-docx.py test/fixtures/tagged.docx"""
import io
import sys
import zipfile
ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>'
rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
docrels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>'
W='xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
doc = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document %s><w:body>'
  '<w:p><w:r><w:t xml:space="preserve">Summary: </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>[Person 1]</w:t></w:r><w:r><w:t xml:space="preserve"> sold the flat to [Org 1].</w:t></w:r></w:p>'
  '<w:p><w:r><w:t>Signed by [Per</w:t></w:r><w:r><w:t>son 1</w:t></w:r><w:r><w:t>] and [Seller] &amp; witnesses; see [Person 10].</w:t></w:r></w:p>'
  '<w:sectPr><w:headerReference w:type="default" r:id="rId9"/></w:sectPr></w:body></w:document>') % W
ftr = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr %s><w:p><w:r><w:t>Page footer, no tags</w:t></w:r></w:p></w:ftr>' % W
hdr = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr %s><w:p><w:r><w:t>Case of [Person 1]</w:t></w:r></w:p></w:hdr>' % W
png = bytes([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]) + b'\x00'*24
buf = io.BytesIO()
with zipfile.ZipFile(buf, 'w') as z:
    z.writestr('[Content_Types].xml', ct, compress_type=zipfile.ZIP_DEFLATED)
    z.writestr('_rels/.rels', rels, compress_type=zipfile.ZIP_DEFLATED)
    z.writestr('word/_rels/document.xml.rels', docrels, compress_type=zipfile.ZIP_DEFLATED)
    z.writestr('word/document.xml', doc, compress_type=zipfile.ZIP_DEFLATED)
    z.writestr('word/header1.xml', hdr, compress_type=zipfile.ZIP_DEFLATED)
    z.writestr('word/footer1.xml', ftr, compress_type=zipfile.ZIP_STORED)  # stored: a re-deflate would show
    z.writestr('word/media/image1.png', png, compress_type=zipfile.ZIP_STORED)
open(sys.argv[1],'wb').write(buf.getvalue())

