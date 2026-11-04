"""Small behavioral baseline; model calls are simulated and caches are temporary."""

import copy
from concurrent.futures import ThreadPoolExecutor
import threading
import hashlib
import json
import unittest
from unittest.mock import Mock, patch

from app_fixture import isolated_app


class TranslationTests(unittest.TestCase):
    def setUp(self):
        self.backend = self.enterContext(isolated_app())
        self.config = copy.deepcopy(self.backend.DEFAULT_CONFIG)
        self.config["deepseek"]["api_key"] = "test-only-api-key"

    def test_repeated_paragraphs_reuse_cache_and_preserve_layout(self):
        source = "  First paragraph.\n\nSecond paragraph.\nFirst paragraph.  "
        expected = "  第一段。\n\n第二段。\n第一段。  "
        reply = json.dumps({"translations": ["第一段。", "第二段。"]})
        with patch.object(self.backend, "deepseek_chat", return_value=reply) as model:
            self.assertEqual(self.backend.translate_deepseek(source, "en", "zh", self.config),
                             (expected, False))
            self.assertEqual(self.backend.translate_deepseek(source, "en", "zh", self.config),
                             (expected, True))
        self.assertEqual(model.call_count, 1)
        self.assertEqual(self.backend.translation_cache_entries(), 2)

    def test_changed_target_does_not_reuse_another_language(self):
        with patch.object(self.backend, "deepseek_chat", side_effect=["你好", "Bonjour"]) as model:
            self.assertEqual(self.backend.translate_deepseek("Hello", "en", "zh", self.config),
                             ("你好", False))
            self.assertEqual(self.backend.translate_deepseek("Hello", "en", "fr", self.config),
                             ("Bonjour", False))
        self.assertEqual(model.call_count, 2)

    def test_failed_upstream_is_not_cached(self):
        with patch.object(self.backend, "deepseek_chat", side_effect=RuntimeError("upstream failed")):
            with self.assertRaisesRegex(RuntimeError, "upstream failed"):
                self.backend.translate_deepseek("Hello", "en", "zh", self.config)
        self.assertEqual(self.backend.translation_cache_entries(), 0)
        with patch.object(self.backend, "deepseek_chat", return_value="你好") as model:
            self.assertEqual(self.backend.translate_deepseek("Hello", "en", "zh", self.config),
                             ("你好", False))
        model.assert_called_once()

    def test_incomplete_batch_is_not_assigned_to_wrong_paragraph(self):
        with patch.object(self.backend, "deepseek_chat", side_effect=[
            '{"translations":["不完整的批次"]}', "第一段。", "第二段。",
        ]):
            result, cached = self.backend.translate_deepseek("First\nSecond", "en", "zh", self.config)
        self.assertEqual(result, "第一段。\n第二段。")
        self.assertFalse(cached)

    def test_verified_response_can_be_cached(self):
        response = Mock()
        response.json.return_value = {"choices": [{"finish_reason": "stop", "message": {"content": "你好"}}]}
        with patch.object(self.backend.requests, "post", return_value=response) as model:
            self.assertEqual(self.backend.translate_deepseek("Hello", "en", "zh", self.config), ("你好", False))
            self.assertEqual(self.backend.translate_deepseek("Hello", "en", "zh", self.config), ("你好", True))
        model.assert_called_once()

    def test_unfinished_response_is_neither_cached_nor_retried(self):
        for reason in ("length", "content_filter", "insufficient_system_resource", "aborted", None):
            with self.subTest(reason=reason):
                response = Mock()
                response.json.return_value = {"choices": [{
                    "finish_reason": reason, "message": {"content": "这是一段残缺译文"},
                }]}
                with patch.object(self.backend.requests, "post", return_value=response) as model:
                    with self.assertRaises(RuntimeError):
                        self.backend.translate_deepseek("Hello", "en", "zh", self.config)
                model.assert_called_once()
                self.assertEqual(self.backend.translation_cache_entries(), 0)

    def test_malformed_response_does_not_become_translated_text(self):
        payloads = [None, {}, {"choices": []}, {"choices": [None]}]
        payloads.extend({"choices": [{"finish_reason": "stop", "message": {"content": value}}]}
                        for value in (None, [], {}, 123, " \n "))
        for payload in payloads:
            with self.subTest(payload=payload):
                response = Mock()
                response.json.return_value = payload
                with patch.object(self.backend.requests, "post", return_value=response):
                    with self.assertRaises(RuntimeError):
                        self.backend.translate_deepseek("Hello", "en", "zh", self.config)
                self.assertEqual(self.backend.translation_cache_entries(), 0)

    def test_batch_items_must_be_nonempty_text(self):
        for item in (123, True, None, {"text": "wrong type"}, ["wrong type"], " \n "):
            with self.subTest(item=item):
                self.assertIsNone(self.backend.parse_deepseek_translation_list(
                    json.dumps({"translations": ["第一段", item]}), 2))

    def test_invalid_large_batch_does_not_trigger_many_paid_retries(self):
        with patch.object(self.backend, "deepseek_chat", return_value='{"translations":[]}') as model:
            with self.assertRaisesRegex(RuntimeError, "段落格式不完整"):
                self.backend.translate_deepseek("One\nTwo\nThree\nFour", "en", "zh", self.config)
        model.assert_called_once()
        self.assertEqual(self.backend.translation_cache_entries(), 0)

    def test_completed_batch_is_reused_after_later_failure(self):
        with patch.object(self.backend, "DEEPSEEK_BATCH_MAX_SEGMENTS", 2):
            with patch.object(self.backend, "deepseek_chat", side_effect=[
                '{"translations":["一","二"]}', RuntimeError("upstream failed"),
            ]):
                with self.assertRaisesRegex(RuntimeError, "upstream failed"):
                    self.backend.translate_deepseek("One\nTwo\nThree", "en", "zh", self.config)
            with patch.object(self.backend, "deepseek_chat", return_value="三") as model:
                self.assertEqual(self.backend.translate_deepseek("One\nTwo\nThree", "en", "zh", self.config),
                                 ("一\n二\n三", False))
            model.assert_called_once()

    def test_bulk_cache_uses_one_write_transaction_and_handles_many_keys(self):
        values = {hashlib.sha256(str(i).encode()).hexdigest(): f"译文 {i}" for i in range(1100)}
        statements = []
        open_cache = self.backend.open_translation_cache

        def traced_connection():
            connection = open_cache()
            connection.set_trace_callback(statements.append)
            return connection

        with patch.object(self.backend, "open_translation_cache", side_effect=traced_connection) as connections:
            self.backend.set_cached_translations(values)
            self.assertEqual(connections.call_count, 1)
            self.assertEqual(statements.count("COMMIT"), 1)
            statements.clear()
            self.assertEqual(self.backend.get_cached_translations(values), values)
            self.assertEqual(connections.call_count, 2)
            self.assertEqual(statements.count("COMMIT"), 1)

    def test_concurrent_identical_requests_share_one_model_call(self):
        entered, joined, release = threading.Event(), threading.Event(), threading.Event()
        result_method = self.backend.Future.result
        def waiting_result(future, *args, **kwargs):
            joined.set()
            return result_method(future, *args, **kwargs)
        def model(*args):
            entered.set()
            if not release.wait(5):
                raise RuntimeError("test synchronization timed out")
            return "你好"
        with patch.object(self.backend, "deepseek_chat", side_effect=model) as call, \
                patch.object(self.backend.Future, "result", waiting_result), ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(self.backend.translate_deepseek, "Hello", "en", "zh", self.config)
            self.assertTrue(entered.wait(5))
            second = pool.submit(self.backend.translate_deepseek, "Hello", "en", "zh", self.config)
            try:
                self.assertTrue(joined.wait(5))
            finally:
                release.set()
            self.assertEqual(first.result(), second.result())
            call.assert_called_once()
        self.assertFalse(self.backend.TRANSLATION_PENDING)

    def test_bulk_cache_keeps_recently_used_entries(self):
        keys = [hashlib.sha256(str(i).encode()).hexdigest() for i in range(3)]
        with patch.object(self.backend, "translation_cache_limit", return_value=2):
            self.backend.set_cached_translations({keys[0]: "零", keys[1]: "一"})
            self.assertEqual(self.backend.get_cached_translations([keys[0]]), {keys[0]: "零"})
            self.backend.set_cached_translations({keys[2]: "二"})
        self.assertEqual(self.backend.get_cached_translations(keys), {keys[0]: "零", keys[2]: "二"})


if __name__ == "__main__":
    unittest.main()
