"""Protect book/cache/progress boundaries before changing progress synchronization."""

import unittest
from unittest.mock import patch

from app_fixture import isolated_app


class ReaderDataTests(unittest.TestCase):
    def setUp(self):
        self.backend = self.enterContext(isolated_app())
        self.book = {
            "id": "1" * 32, "title": "测试书籍", "format": "txt",
            "content_revision": "revision-1", "updated_at": 1,
            "chapters": [{"title": "第一章", "text": "第一句。第二句。"}],
            "progress": {"chapter": 0, "sentence": 0},
        }
        self.backend.write_book_record(self.book)

    def test_progress_write_does_not_rewrite_book(self):
        path = self.backend.book_record_path(self.book["id"])
        before = path.read_bytes()
        before_stat = path.stat()
        summary = self.backend.read_book_summary(self.book["id"])
        summary["progress"] = {"chapter": 0, "sentence": 1, "percent": 50}
        summary["updated_at"] = 2
        self.backend.write_book_progress(summary)
        self.assertEqual(self.backend.read_book_record(self.book["id"])["progress"], summary["progress"])
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual((path.stat().st_ino, path.stat().st_mtime_ns),
                         (before_stat.st_ino, before_stat.st_mtime_ns))

    def test_reparsed_book_does_not_apply_old_progress(self):
        summary = self.backend.read_book_summary(self.book["id"])
        summary["progress"] = {"chapter": 0, "sentence": 1}
        self.backend.write_book_progress(summary)
        self.book["content_revision"] = "revision-2"
        self.book["chapters"][0]["text"] = "重新解析后的正文。"
        self.backend.write_book_record(self.book)
        loaded = self.backend.read_book_record(self.book["id"])
        self.assertEqual(loaded["progress"], {"chapter": 0, "sentence": 0})
        self.assertEqual(loaded["chapters"][0]["text"], "重新解析后的正文。")

    def test_late_epub_parse_cannot_rewrite_restored_book(self):
        self.book.update(format="epub", stored_name="source.epub", chapters=[{"title": "原章节", "href": "chapter.xhtml"}])
        self.backend.write_book_record(self.book)
        old = self.backend.read_book_record(self.book["id"])
        def parse(*args):
            self.book.update(content_revision="restored", chapters=[{"title": "恢复后的章节", "href": "new.xhtml"}])
            self.backend.write_book_record(self.book)
            return {"text": "旧内容。", "images": [], "blocks": []}
        with patch.object(self.backend, "parse_epub_chapter_content", side_effect=parse):
            with self.assertRaisesRegex(ValueError, "书籍已更新"):
                self.backend.ensure_chapter_text(old, 0)
        self.assertEqual(self.backend.read_book_record(self.book["id"])["chapters"][0]["title"], "恢复后的章节")
        self.assertFalse(self.backend.book_chapter_cache_path(self.book["id"], 0).exists())

    def test_mutating_a_read_result_does_not_change_cached_book(self):
        loaded = self.backend.read_book_record(self.book["id"])
        loaded["chapters"][0]["text"] = "调用者修改的内容"
        loaded["progress"]["sentence"] = 1
        again = self.backend.read_book_record(self.book["id"])
        self.assertEqual(again["chapters"], self.book["chapters"])
        self.assertEqual(again["progress"], self.book["progress"])

    def test_statistics_get_never_starts_a_scan_even_without_a_snapshot(self):
        with self.backend.app.test_request_context(), \
                patch.object(self.backend, "require_auth", return_value=True), \
                patch.object(self.backend, "schedule_tts_cache_stats_refresh") as schedule:
            for _ in range(2):
                response = self.backend.api_reader_audio_statistics()
                self.assertFalse(response.get_json()["ready"])
            schedule.assert_not_called()

    def test_audio_update_builds_missing_shared_counts_once_and_empty_cache_is_zero(self):
        import copy
        settings = self.backend.load_config()["reader_tts"]
        book_id = self.book["id"]
        empty = {"content_revision": "revision-1", "chapter_count": 1,
                 "chapter_sentences": None, "source_stamp": None,
                 "_files": {"temporary": {}, "fixed": {}},
                 "_chapters": {}, "_coverage_unknown": False}
        with patch.object(self.backend, "schedule_tts_cache_stats_refresh") as schedule:
            result = self.backend.finish_book_audio_statistics({book_id: copy.deepcopy(empty)}, "p", settings)["books"][book_id]
            self.assertEqual(result["temporary"]["coverage_percent"], 0)
            self.assertEqual(result["fixed"]["coverage_percent"], 0)
            self.assertEqual(result["coverage_percent"], 0)
            self.assertFalse(self.backend.book_tts_sentence_index_path(book_id).exists())
            cached = copy.deepcopy(empty)
            cached["_files"]["temporary"] = {"p:audio": 100}
            cached["_chapters"] = {"0": {"hash": {"temporary": {0}, "fixed": set()}}}
            after = self.backend.finish_book_audio_statistics({book_id: copy.deepcopy(cached)}, "p", settings)["books"][book_id]
            self.assertTrue(after["coverage_verified"])
            self.assertGreater(after["total_sentences"], 0)
            self.assertEqual(after["temporary"]["coverage_percent"], round(100 / after["total_sentences"], 1))
            counts, stamp = self.backend.book_audio_sentence_counts(self.backend.book_summary(self.book), settings, after)
            self.assertEqual(sum(counts.values()), after["total_sentences"])
            cached.update(chapter_sentences=counts, source_stamp=stamp)
            index_path = self.backend.book_tts_sentence_index_path(book_id)
            index_before = (index_path.read_bytes(), index_path.stat().st_mtime_ns)
            with patch.object(self.backend, "ensure_tts_sentence_counts", side_effect=AssertionError("must reuse valid counts")):
                again = self.backend.finish_book_audio_statistics({book_id: cached}, "p", settings)["books"][book_id]
            self.assertEqual(again["temporary"], after["temporary"])
            self.assertEqual((index_path.read_bytes(), index_path.stat().st_mtime_ns), index_before)
            schedule.assert_not_called()

    def test_sentence_index_cannot_publish_after_book_deletion_or_reparse(self):
        import shutil
        settings = self.backend.load_config()["reader_tts"]
        book_id = self.book["id"]
        for action in ("delete", "reparse"):
            with self.subTest(action=action):
                self.backend.write_book_record(self.book)
                def changed_while_counting(*args, **kwargs):
                    if action == "delete":
                        shutil.rmtree(self.backend.book_dir(book_id))
                    else:
                        self.backend.write_book_record({**self.book, "content_revision": "new-revision"})
                    return {"sentences": [{"index": 0, "text": "旧正文。"}]}
                with patch.object(self.backend, "tts_offline_chapter_data", side_effect=changed_while_counting), \
                        patch.object(self.backend, "schedule_tts_cache_stats_refresh"):
                    with self.assertRaises((FileNotFoundError, ValueError)):
                        self.backend.ensure_tts_sentence_counts(self.book, settings, notify_statistics=False)
                self.assertFalse(self.backend.book_tts_sentence_index_path(book_id).exists())
                if action == "delete":
                    self.assertFalse(self.backend.book_dir(book_id).exists())

    def save_progress(self, writer, version, sequence, sentence):
        body = {"content_revision": "revision-1", "chapter": 0, "sentence": sentence,
                "progress_version": version, "progress_writer": writer, "progress_sequence": sequence}
        with self.backend.app.test_request_context(method="PUT", json=body), \
                patch.object(self.backend, "require_auth", return_value=True):
            response = self.backend.app.make_response(self.backend.api_book_progress(self.book["id"]))
            return response.status_code, response.get_json()

    def test_old_device_cannot_replace_newer_progress(self):
        status, result = self.save_progress("device-a-session", 0, 1, 1)
        self.assertEqual(status, 200)
        self.assertEqual(result["book"]["progress_version"], 1)
        status, result = self.save_progress("device-b-session", 0, 1, 0)
        self.assertEqual(status, 409)
        self.assertEqual(result["code"], "progress_conflict")
        self.assertEqual(self.backend.read_book_summary(self.book["id"])["progress"]["sentence"], 1)

    def test_reopened_device_can_intentionally_read_backwards(self):
        self.save_progress("device-a-session", 0, 1, 1)
        status, result = self.save_progress("device-b-session", 1, 1, 0)
        self.assertEqual(status, 200)
        self.assertEqual(result["book"]["progress"]["sentence"], 0)
        self.assertEqual(self.save_progress("device-a-session", 1, 2, 1)[0], 409)

    def test_reordered_requests_from_same_session_do_not_move_backwards(self):
        self.save_progress("device-a-session", 0, 1, 0)
        self.assertEqual(self.save_progress("device-a-session", 0, 3, 1)[0], 200)
        status, result = self.save_progress("device-a-session", 0, 2, 0)
        self.assertEqual(status, 200)
        self.assertTrue(result["stale"])
        self.assertEqual(result["book"]["progress"]["sentence"], 1)
        self.assertEqual(result["book"]["progress_version"], 2)
        self.assertEqual(self.backend.book_summary(self.backend.read_book_record(self.book["id"]))["progress_version"], 2)

    def bookmarks(self, method="GET", payload=None):
        with self.backend.app.test_request_context(method=method, json=payload), \
                patch.object(self.backend, "require_auth", return_value=True):
            response = self.backend.app.make_response(self.backend.api_book_bookmarks(self.book["id"]))
            return response.status_code, response.get_json()

    def test_bookmark_uses_server_text_and_deduplicates_position(self):
        payload = {"content_revision": "revision-1", "chapter": 0, "sentence": 1, "quote": "伪造的引用"}
        status, first = self.bookmarks("POST", payload)
        self.assertEqual(status, 200)
        self.assertFalse(first["duplicate"])
        status, result = self.bookmarks("POST", payload)
        self.assertEqual(status, 200)
        self.assertTrue(result["duplicate"])
        self.assertEqual(len(result["bookmarks"]), 1)
        self.assertEqual(result["bookmarks"][0]["quote"], "第二句。")
        self.assertFalse(result["bookmarks"][0]["stale"])
        self.bookmarks("DELETE", {"id": result["bookmarks"][0]["id"]})
        self.assertEqual(self.bookmarks()[1]["bookmarks"], [])

    def test_reparse_keeps_bookmark_excerpt_but_marks_position_stale(self):
        payload = {"content_revision": "revision-1", "chapter": 0, "sentence": 0}
        self.bookmarks("POST", payload)
        self.book["content_revision"] = "revision-2"
        self.backend.write_book_record(self.book)
        record = self.bookmarks()[1]["bookmarks"][0]
        self.assertTrue(record["stale"])
        self.assertEqual(record["quote"], "第一句。")
        self.assertEqual(self.bookmarks("POST", payload)[0], 409)


if __name__ == "__main__":
    unittest.main()
