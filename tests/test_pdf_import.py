"""Exercise the resource-limited worker with generated, non-private PDFs."""

import subprocess
import unittest
from unittest.mock import patch
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from app_fixture import isolated_app


class PdfImportTests(unittest.TestCase):
    def setUp(self):
        self.backend = self.enterContext(isolated_app())
        self.path = self.backend.BASE_DIR / "sample.pdf"

    def create_pdf(self, pages=1):
        writer = PdfWriter()
        for _ in range(pages):
            page = writer.add_blank_page(width=300, height=300)
            font = DictionaryObject({NameObject("/Type"): NameObject("/Font"),
                                     NameObject("/Subtype"): NameObject("/Type1"),
                                     NameObject("/BaseFont"): NameObject("/Helvetica")})
            page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})})
            stream = DecodedStreamObject()
            stream.set_data(b"BT /F1 12 Tf 20 200 Td (A small PDF for isolated testing.) Tj ET")
            page[NameObject("/Contents")] = stream
        with self.path.open("wb") as handle:
            writer.write(handle)

    def test_worker_extracts_text_and_keeps_title(self):
        self.create_pdf()
        result = self.backend.parse_pdf_book(self.path, "Sample")
        self.assertEqual(result["title"], "Sample")
        self.assertIn("A small PDF for isolated testing.", result["chapters"][0]["text"])

    def test_page_limit_is_enforced_inside_worker(self):
        self.create_pdf(2)
        with self.assertRaisesRegex(ValueError, "页数过多"):
            self.backend.reader_pdf.parse_book(self.path, "Sample", max_pages=1)

    def test_timeout_is_a_readable_failure(self):
        with patch.object(self.backend.reader_pdf.subprocess, "run", side_effect=subprocess.TimeoutExpired("worker", 90)):
            with self.assertRaisesRegex(ValueError, "解析超时"):
                self.backend.parse_pdf_book(self.path, "Sample")
