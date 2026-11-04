"""Exercise archives entirely in temporary libraries, without model or network calls."""
import json
import fcntl
from pathlib import Path
import shutil
import unittest
from unittest.mock import patch
import zipfile

from app_fixture import isolated_app


class ReadingBackupTests(unittest.TestCase):
    def setUp(self):
        self.b = self.enterContext(isolated_app())
        self.enterContext(patch.object(self.b, "schedule_tts_cache_stats_refresh"))
        self.enterContext(patch.object(self.b, "invalidate_tts_cache_stats"))
        self.service = self.b.app.extensions["reading_backups"]
        self.book = {"id": "1" * 32, "title": "备份测试", "format": "txt", "stored_name": "source.txt",
                     "content_revision": "original-revision", "updated_at": 1,
                     "chapters": [{"index": 0, "title": "第一章", "text": "第一句。第二句。"}],
                     "progress": {"chapter": 0, "sentence": 1}}
        self.b.write_book_record(self.book)
        self.b.upsert_book_index(self.book)
        directory = self.b.book_dir(self.book["id"])
        (directory / "source.txt").write_text("第一句。第二句。")
        (directory / ".source-before-edit").write_text("修改前原文")
        (directory / "search-index.sqlite3").write_bytes(b"not-a-backup-file")
        self.b.write_json_atomic(directory / "bookmarks.json", [{"id": "bookmark", "chapter": 0, "sentence": 1,
                                    "quote": "第二句。", "content_revision": "original-revision"}])

    def archive(self, full=False):
        export = self.service.new("full" if full else "light")
        self.service.export(export, {self.book["id"]: ["source", "reading", "txt_backup"] + (["audio"] if full else [])})
        job = self.service.new("upload")
        shutil.copyfile(self.service.root / export["id"] / "backup.zip", self.service.root / job["id"] / "backup.zip")
        self.service.preview(job)
        return job

    def test_preview_changes_nothing_and_light_archive_excludes_private_and_derived_data(self):
        before = self.b.book_record_path(self.book["id"]).read_bytes()
        job = self.archive()
        self.assertEqual(self.b.book_record_path(self.book["id"]).read_bytes(), before)
        self.assertEqual(job["status"], "preview")
        self.assertTrue(job["books"][0]["current"])
        with zipfile.ZipFile(self.service.root / job["id"] / "backup.zip") as archive:
            names = archive.namelist()
            self.assertTrue(any(name.endswith(".source-before-edit") for name in names))
            self.assertFalse(any("sqlite" in name or "config" in name or "audio/" in name for name in names))

    def test_replace_requires_confirmation_and_unchanged_preview(self):
        job = self.archive()
        token = job["books"][0]["token"]
        with self.assertRaises(ValueError):
            self.service.restore(job, self.book["id"], token, False)
        summary = self.b.read_book_summary(self.book["id"])
        summary["progress"] = {"chapter": 0, "sentence": 0}
        self.b.write_book_progress(summary)
        with self.assertRaisesRegex(ValueError, "发生变化"):
            self.service.restore(job, self.book["id"], token, True)
        self.assertEqual(self.b.read_book_record(self.book["id"])["progress"]["sentence"], 0)

    def test_restore_preserves_bookmarks_and_invalidates_old_clients(self):
        job = self.archive()
        before_inode = (self.b.book_dir(self.book["id"]) / ".text-edit.lock").stat().st_ino
        self.service.restore(job, self.book["id"], job["books"][0]["token"], True)
        restored = self.b.read_book_record(self.book["id"])
        self.assertNotEqual(restored["content_revision"], "original-revision")
        self.assertEqual(restored["progress"]["sentence"], 1)
        directory = self.b.book_dir(self.book["id"])
        self.assertEqual((directory / ".source-before-edit").read_text(), "修改前原文")
        self.assertEqual(json.loads((directory / "bookmarks.json").read_text())[0]["content_revision"], restored["content_revision"])
        self.assertFalse((directory / "search-index.sqlite3").exists())
        self.assertEqual(self.b.reader_search.revision(directory), restored["content_revision"])
        self.assertEqual((directory / ".text-edit.lock").stat().st_ino, before_inode)

    def add_audio(self):
        self.b.ensure_private_directory(self.b.TTS_CACHE_DIR)
        row = {"book_id": self.book["id"], "chapter_index": 0, "chapter_hash": "a"*64,
               "sentence_index": 0, "sentence_text": "第一句。", "profile_key": "b"*64,
               "cache_key": "c"*64, "audio_format": "m4a", "size_bytes": 10, "created_at": 1}
        self.b.tts_cache_path(row["cache_key"], "m4a").write_bytes(b"test-audio")
        conn = self.b.open_tts_offline_db()
        with conn:
            conn.execute("INSERT INTO offline_tts_refs VALUES (?,?,?,?,?,?,?,?,?,?)", tuple(row.values()))
        conn.close()
        return row

    def test_full_backup_restores_fixed_audio_without_api_calls_and_keeps_shared_files(self):
        row = self.add_audio()
        job = self.archive(full=True)
        audio = self.b.tts_cache_path(row["cache_key"], "m4a")
        audio.unlink()
        shared = self.b.tts_cache_path("d"*64, "m4a")
        shared.write_bytes(b"another-book-audio")
        shutil.rmtree(self.b.book_dir(self.book["id"]))
        self.service.restore(job, self.book["id"], "", False)
        self.assertEqual(audio.read_bytes(), b"test-audio")
        self.assertEqual(shared.read_bytes(), b"another-book-audio")
        conn = self.b.open_tts_offline_db()
        try:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM offline_tts_refs").fetchone()[0], 1)
        finally:
            conn.close()
        self.assertEqual(self.b.read_book_record(self.book["id"])["title"], "备份测试")

    def test_restore_reuses_identical_audio_without_a_temporary_copy(self):
        row = self.add_audio()
        job = self.archive(full=True)
        original = self.service.extract
        def inspect(*args, **kwargs):
            original(*args, **kwargs)
            stage = args[3]
            temporary = stage / "audio" / (row["cache_key"] + ".m4a")
            live = self.b.tts_cache_path(row["cache_key"], "m4a")
            self.assertEqual(temporary.stat().st_ino, live.stat().st_ino)
        with patch.object(self.service, "extract", side_effect=inspect):
            self.service.restore(job, self.book["id"], job["books"][0]["token"], True)

    def test_light_restore_preserves_existing_fixed_audio(self):
        self.add_audio()
        job = self.archive()
        self.service.restore(job, self.book["id"], job["books"][0]["token"], True)
        conn = self.b.open_tts_offline_db()
        try:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM offline_tts_refs").fetchone()[0], 1)
        finally:
            conn.close()

    def test_restore_does_not_replace_a_book_while_search_index_is_building(self):
        job = self.archive()
        before = self.b.book_record_path(self.book["id"]).read_bytes()
        with (self.b.READER_DIR / "search-build.lock").open("a+b") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(ValueError, "索引正在建立"):
                self.service.restore(job, self.book["id"], job["books"][0]["token"], True)
        self.assertEqual(self.b.book_record_path(self.book["id"]).read_bytes(), before)

    def test_interrupted_directory_swap_recovers_original_on_start(self):
        job = self.archive()
        directory = self.service.root / job["id"]
        stage = directory / "restore"
        stage.mkdir()
        self.b.write_json_atomic(directory / "pending.json", {"book_id": self.book["id"], "existed": True, "refs": []})
        target = self.b.book_dir(self.book["id"])
        target.rename(stage / "previous")
        # Simulate the next service startup, without importing or changing real data.
        self.service.recover_interrupted()
        self.assertTrue((target / "book.json").exists())
        self.assertFalse((directory / "pending.json").exists())
        self.assertEqual(self.b.read_book_record(self.book["id"])["content_revision"], "original-revision")

    def test_failed_swap_rolls_back_book_and_audio_references(self):
        self.add_audio()
        job = self.archive(full=True)
        before = self.b.book_record_path(self.book["id"]).read_bytes()
        original = self.b.os.replace
        def fail(source, destination):
            if Path(source).name == self.book["id"] and "restore" in Path(source).parts:
                raise OSError("simulated disk failure")
            return original(source, destination)
        with patch("os.replace", side_effect=fail):
            with self.assertRaises(OSError):
                self.service.restore(job, self.book["id"], job["books"][0]["token"], True)
        self.assertEqual(self.b.book_record_path(self.book["id"]).read_bytes(), before)
        conn = self.b.open_tts_offline_db()
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM offline_tts_refs").fetchone()[0], 1)
        conn.close()

    def test_missing_source_can_be_repaired_from_backup(self):
        job = self.archive()
        source = self.b.book_dir(self.book["id"]) / "source.txt"
        for items in (["source"], ["source", "reading"]):
            with self.subTest(items=items):
                source.unlink()
                self.service.compare(job)
                self.service.restore(job, self.book["id"], job["books"][0]["token"], True, items)
                self.assertEqual(source.read_text(), "第一句。第二句。")

    def test_unfinished_restore_cannot_be_deleted_or_overwritten_before_rollback(self):
        job = self.archive()
        directory = self.service.root / job["id"]
        original = Path.unlink
        def fail_journal(path, *args, **kwargs):
            if path == directory / "pending.json":
                raise OSError("simulated journal I/O failure")
            return original(path, *args, **kwargs)
        with patch.object(Path, "unlink", fail_journal):
            with self.assertRaises(OSError):
                self.service.restore(job, self.book["id"], job["books"][0]["token"], True)
        old = directory / "restore" / "previous" / "book.json"
        self.assertTrue(old.is_file())
        for operation in (lambda: self.service.delete(job["id"]),
                          lambda: self.service.restore(job, self.book["id"], "", True),
                          lambda: self.service.new("selected")):
            with self.assertRaisesRegex(ValueError, "回滚"):
                operation()
        job["expires_at"] = 0
        self.service.cleanup()
        self.assertTrue(old.is_file())
        self.service.recover_interrupted()
        self.assertEqual(self.b.read_book_record(self.book["id"])["content_revision"], "original-revision")

    def test_export_limits_match_import_and_failed_comparison_does_not_undo_restore(self):
        for limit in ("MAX_ENTRIES", "JSON_BYTES"):
            job = self.service.new("selected")
            with patch.dict(self.service.export.__globals__, {limit: 1}):
                with self.assertRaises(ValueError):
                    self.service.export(job, {self.book["id"]: ["source", "reading"]})
            self.assertFalse((self.service.root / job["id"] / "backup.zip").exists())
            self.assertFalse((self.service.root / job["id"] / "snapshot").exists())
        job = self.archive()
        with patch.object(self.service, "compare", side_effect=OSError("comparison read failed")):
            self.service.restore(job, self.book["id"], job["books"][0]["token"], True)
        self.assertEqual(job["status"], "preview")
        self.assertTrue(job["comparison_warning"])
        self.assertIn("已恢复", job["message"])
        self.assertEqual(job["books"], [])
        self.assertNotEqual(self.b.read_book_record(self.book["id"])["content_revision"], "original-revision")
        self.service.compare(job)
        self.assertNotIn("comparison_warning", job)
        self.assertEqual(len(job["books"]), 1)

    def test_path_traversal_and_checksum_corruption_are_rejected(self):
        job = self.archive()
        path = self.service.root / job["id"] / "backup.zip"
        with zipfile.ZipFile(path, "a") as archive:
            archive.writestr("../outside.txt", "bad")
        with self.assertRaisesRegex(ValueError, "不安全路径"):
            self.service.preview(job)
        self.assertFalse((self.service.root / "outside.txt").exists())
        job = self.archive()
        path = self.service.root / job["id"] / "backup.zip"
        with zipfile.ZipFile(path) as archive:
            records = {name: archive.read(name) for name in archive.namelist()}
        manifest = json.loads(records["manifest.json"])
        manifest["files"][next(iter(manifest["files"]))]["sha256"] = "0"*64
        records["manifest.json"] = json.dumps(manifest).encode()
        with zipfile.ZipFile(path, "w") as archive:
            for name, value in records.items():
                archive.writestr(name, value)
        with self.assertRaisesRegex(ValueError, "校验失败"):
            self.service.preview(job)

    def test_chunk_upload_checks_auth_csrf_size_and_offset(self):
        self.b.app.testing = True
        client = self.b.app.test_client()
        with patch.object(self.b, "require_auth", return_value=False):
            self.assertEqual(client.get("/api/reader/backups/" + "1"*32).status_code, 401)
        with patch.object(self.b, "require_auth", return_value=True), patch.object(self.b, "csrf_token", return_value="test"):
            self.assertEqual(client.post("/api/reader/backups", json={"kind": "upload"}).status_code, 403)
            headers = {"X-CSRF-Token": "test"}
            response = client.post("/api/reader/backups", json={"kind": "upload"}, headers=headers)
            identity = response.json["id"]
            url = "/api/reader/backups/" + identity
            headers["X-Upload-Offset"] = "0"
            self.assertEqual(client.put(url, data=b"123", headers=headers).json["offset"], 3)
            self.assertEqual(client.put(url, data=b"123", headers=headers).status_code, 409)
            self.assertEqual(client.put(url, data=b"x"*(4*1024*1024+1), headers=headers).status_code, 413)

    def selected_archive(self, items):
        job = self.service.new('selected')
        self.service.export(job, {self.book['id']: items})
        self.service.preview(job)
        return job

    def test_each_backup_item_excludes_unselected_data(self):
        expected = {'source': 'source.txt', 'reading': 'book.json',
                    'txt_backup': '.source-before-edit', 'audio': 'audio-refs.json'}
        self.add_audio()
        for item, filename in expected.items():
            with self.subTest(item=item):
                job = self.selected_archive([item])
                with zipfile.ZipFile(self.service.root / job['id'] / 'backup.zip') as archive:
                    names = {Path(name).name for name in archive.namelist()}
                    self.assertIn(filename, names)
                    for other, excluded in expected.items():
                        if other != item:
                            self.assertNotIn(excluded, names)
                    self.assertEqual(job['books'][0]['items'], [item])

    def test_partial_restore_preserves_unselected_items(self):
        row = self.add_audio()
        job = self.selected_archive(['txt_backup'])
        directory = self.b.book_dir(self.book['id'])
        (directory / '.source-before-edit').write_text('新的原文备份')
        self.service.compare(job)
        original = self.b.read_book_record(self.book['id'])
        self.service.restore(job, self.book['id'], job['books'][0]['token'], True, ['txt_backup'])
        self.assertEqual((directory / '.source-before-edit').read_text(), '修改前原文')
        self.assertEqual(self.b.read_book_record(self.book['id']), original)
        self.assertEqual(self.service.current_refs(self.book['id'])[0]['cache_key'], row['cache_key'])
        self.assertEqual((directory / 'source.txt').read_text(), '第一句。第二句。')

    def test_audio_merge_deduplicates_and_preserves_other_sentences(self):
        row = self.add_audio()
        job = self.selected_archive(['audio'])
        other = {**row, 'sentence_index': 1, 'sentence_text': '第二句。', 'cache_key': 'd'*64}
        self.b.tts_cache_path(other['cache_key'], 'm4a').write_bytes(b'other-audio')
        conn = self.b.open_tts_offline_db()
        with conn:
            conn.execute('INSERT INTO offline_tts_refs VALUES (?,?,?,?,?,?,?,?,?,?)', tuple(other.values()))
        conn.close()
        self.service.compare(job)
        self.assertEqual(job['books'][0]['merge_issue'], '')
        self.service.restore(job, self.book['id'], job['books'][0]['token'], True, ['audio'])
        self.assertEqual(len(self.service.current_refs(self.book['id'])), 2)
        self.service.restore(job, self.book['id'], job['books'][0]['token'], True, ['audio'])
        self.assertEqual(len(self.service.current_refs(self.book['id'])), 2)

    def test_audio_conflict_requires_explicit_replace_and_changed_body_requires_matching_source(self):
        self.add_audio()
        job = self.selected_archive(['source', 'reading', 'audio'])
        conn = self.b.open_tts_offline_db()
        with conn:
            conn.execute("UPDATE offline_tts_refs SET chapter_hash=?", ('e'*64,))
        conn.close()
        self.service.compare(job)
        self.assertTrue(job['books'][0]['merge_issue'])
        with self.assertRaisesRegex(ValueError, '无法合并'):
            self.service.restore(job, self.book['id'], job['books'][0]['token'], True, ['audio'])
        self.service.restore(job, self.book['id'], job['books'][0]['token'], True, ['audio'], 'replace')
        self.assertEqual(self.service.current_refs(self.book['id'])[0]['chapter_hash'], 'a'*64)
        changed = self.b.read_book_record(self.book['id'])
        changed['chapters'][0]['text'] = '不同正文。'
        self.b.write_book_record(changed)
        self.service.compare(job)
        with self.assertRaisesRegex(ValueError, '不一致'):
            self.service.restore(job, self.book['id'], job['books'][0]['token'], True, ['audio'], 'replace')
        self.service.restore(job, self.book['id'], job['books'][0]['token'], True, ['source', 'reading', 'audio'], 'replace')
        self.assertEqual(self.b.read_book_record(self.book['id'])['chapters'][0]['text'], '第一句。第二句。')

    def test_source_only_can_restore_a_missing_book_without_other_records(self):
        job = self.selected_archive(['source'])
        shutil.rmtree(self.b.book_dir(self.book['id']))
        self.service.restore(job, self.book['id'], '', False, ['source'])
        book = self.b.read_book_record(self.book['id'])
        self.assertEqual(book['progress'], {'chapter': 0, 'sentence': 0})
        self.assertIn('第一句。', book['chapters'][0]['text'])
        self.assertFalse((self.b.book_dir(self.book['id']) / '.source-before-edit').exists())

    def test_server_files_survive_restart_and_expire_without_access_renewal(self):
        import time
        job = self.selected_archive(['source'])
        restarted = type(self.service)(self.b)
        self.assertEqual(restarted.list_jobs()[0]['id'], job['id'])
        expiry = restarted.get(job['id'])['expires_at']
        restarted.get(job['id'])
        self.assertEqual(restarted.get(job['id'])['expires_at'], expiry)
        with patch('time.time', return_value=expiry + 1):
            self.assertEqual(restarted.list_jobs(), [])
        self.assertFalse((self.service.root / job['id']).exists())

    def test_estimate_deduplicates_audio_and_never_calls_models(self):
        row = self.add_audio()
        other = {**row, 'sentence_index': 1}
        conn = self.b.open_tts_offline_db()
        with conn:
            conn.execute('INSERT INTO offline_tts_refs VALUES (?,?,?,?,?,?,?,?,?,?)', tuple(other.values()))
        conn.close()
        value = self.service.estimate({self.book['id']: ['audio']})
        self.assertEqual(value, 2048 + 10 + 2 * (len('第一句。'.encode()) + 450))

    def test_source_change_keeps_old_bookmark_as_stale_and_unpins_without_deleting_audio(self):
        row = self.add_audio()
        job = self.selected_archive(['source'])
        directory = self.b.book_dir(self.book['id'])
        (directory / 'source.txt').write_text('新的正文。')
        self.service.compare(job)
        self.service.restore(job, self.book['id'], job['books'][0]['token'], True, ['source'])
        current = self.b.read_book_record(self.book['id'])
        marks = json.loads((directory / 'bookmarks.json').read_text())
        self.assertNotEqual(current['content_revision'], marks[0]['content_revision'])
        self.assertEqual(marks[0]['quote'], '第二句。')
        self.assertEqual(self.service.current_refs(self.book['id']), [])
        self.assertTrue(self.b.tts_cache_path(row['cache_key'], 'm4a').exists())

    def test_legacy_archive_is_listed_after_restart_and_can_restore_selected_items(self):
        job = self.selected_archive(['source', 'reading', 'txt_backup'])
        path = self.service.root / job['id'] / 'backup.zip'
        with zipfile.ZipFile(path) as archive:
            records = {name: archive.read(name) for name in archive.namelist()}
        manifest = json.loads(records['manifest.json'])
        descriptor = f"books/{self.book['id']}/descriptor.json"
        del records[descriptor]
        del manifest['files'][descriptor]
        manifest['books'][0]['files'].remove(descriptor)
        manifest.update(format='trans-reading-1', kind='light')
        for key in ('items', 'source_sha256', 'layout_key'):
            manifest['books'][0].pop(key)
        records['manifest.json'] = json.dumps(manifest).encode()
        with zipfile.ZipFile(path, 'w') as archive:
            for name, data in records.items():
                archive.writestr(name, data)
        (path.parent / 'job.json').unlink()
        service = type(self.service)(self.b)
        loaded = service.get(job['id'])
        service.preview(loaded)
        self.assertIn('reading', loaded['books'][0]['items'])
        service.restore(loaded, self.book['id'], loaded['books'][0]['token'], True, ['reading'])
        self.assertEqual(self.b.read_book_record(self.book['id'])['progress']['sentence'], 1)
