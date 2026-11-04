"""Encrypted backups and selective configuration restores; no real services/data."""
import json
import os
import unittest
from unittest.mock import patch
import zipfile

from app_fixture import isolated_app


class ToolBackupTests(unittest.TestCase):
    def setUp(self):
        self.b = self.enterContext(isolated_app())
        self.b.app.testing = True
        self.service = self.b.app.extensions['reading_backups']
        self.pdf = self.b.app.extensions['pdf_tasks']
        self.enterContext(patch.object(self.pdf, 'ensure_worker'))
        self.enterContext(patch.object(self.b, 'schedule_tts_cache_stats_refresh'))
        self.enterContext(patch.object(self.b, 'prune_translation_cache'))
        self.password = 'backup-test-password-only'
        self.b.save_dotenv_values({'DEEPSEEK_API_KEY': 'translation-test-secret', 'MIMO_API_KEY': 'tts-test-secret'})
        self.pdf.initialize()
        self.pdf.save_config({'endpoint': 'http://127.0.0.1:30215', 'reuse_deepseek': False,
                              'api_key': 'pdf-independent-secret', 'service_token': 'upstream-secret'})

    def archive(self, tools, password=''):
        job = self.service.new('selected')
        self.service.export(job, {}, tools, password)
        self.service.preview(job, password)
        return job

    def row(self, job, tool):
        return next(row for row in job['tools'] if row['id'] == tool)

    def restore(self, job, tool, items, password=''):
        self.service.restore_tool(job, tool, items, self.row(job, tool)['token'], password)

    def test_credentials_require_encryption_and_never_leak_to_job_metadata(self):
        job = self.service.new('selected')
        with self.assertRaisesRegex(ValueError, '12'):
            self.service.export(job, {}, {'translation': ['credentials']})
        tools = {tool: ['settings', 'credentials'] for tool in ('translation', 'pdf', 'tts')}
        self.service.export(job, {}, tools, self.password)
        path = self.service.root / job['id'] / 'backup.zip'
        self.assertFalse(zipfile.is_zipfile(path))
        self.service.preview(job, self.password)
        self.service.persist(job)
        for raw in (path.read_bytes(), (path.parent / 'job.json').read_bytes(), json.dumps(self.service.public(job)).encode()):
            for secret in ('translation-test-secret', 'tts-test-secret', 'pdf-independent-secret', 'upstream-secret', self.password):
                self.assertNotIn(secret.encode(), raw)
        for entry in path.parent.iterdir():
            self.assertIn(entry.name, ('backup.zip', 'job.json'))
        fresh = type(self.service)(self.b)
        listed = fresh.list_jobs()[0]
        self.assertTrue(listed['encrypted'])
        with self.assertRaises(ValueError):
            fresh.preview(fresh.get(job['id']))
        fresh.preview(fresh.get(job['id']), self.password)
        # A complete archive must remain reachable if task metadata wasn't saved
        # before a restart, or the metadata file was lost. Never auto-decrypt it.
        metadata = path.parent / 'job.json'
        for state in ('interrupted', 'missing'):
            if state == 'interrupted':
                self.b.write_json_atomic(metadata, {'id':job['id'], 'kind':'selected', 'status':'working',
                    'created_at':job['created_at'], 'expires_at':job['expires_at']})
            else:
                metadata.unlink()
            recovered = type(self.service)(self.b)
            listed = recovered.list_jobs()[0]
            self.assertTrue(listed['encrypted'])
            self.assertGreater(listed['size'], 0)
            recovered.preview(recovered.get(job['id']), self.password)

    def test_wrong_password_tampering_and_plaintext_credentials_are_rejected(self):
        job = self.archive({'translation': ['credentials']}, self.password)
        original = self.b.load_config()
        with self.assertRaisesRegex(ValueError, '密码错误'):
            self.service.preview(job, 'wrong-backup-password')
        import backup_crypto
        path = self.service.root / job['id'] / 'backup.zip'
        with backup_crypto.read_archive(path, self.password) as archive:
            files = {n: archive.read(n) for n in archive.namelist()}
        damaged = bytearray(path.read_bytes()); damaged[-1] ^= 1; path.write_bytes(damaged)
        with self.assertRaisesRegex(ValueError, '密码错误'):
            self.service.preview(job, self.password)
        with zipfile.ZipFile(path, 'w') as archive:
            for name, value in files.items():
                archive.writestr(name, value)
        with self.assertRaisesRegex(ValueError, '必须加密'):
            self.service.preview(job)
        self.assertEqual(self.b.load_config(), original)

    def test_independent_keys_and_settings_only_restore_leave_other_values_alone(self):
        job = self.archive({tool: ['settings', 'credentials'] for tool in ('translation', 'pdf', 'tts')}, self.password)
        self.b.save_dotenv_values({'DEEPSEEK_API_KEY': 'new-translation-secret', 'MIMO_API_KEY': 'new-tts-secret'})
        self.pdf.save_config({'endpoint': 'http://127.0.0.1:30215', 'api_key': 'new-pdf-secret', 'qps': 7})
        self.service.compare(job, self.password)
        self.restore(job, 'pdf', ['settings'], self.password)
        self.assertEqual(self.pdf.config()['qps'], 2)
        self.assertEqual(self.pdf.config()['api_key'], 'new-pdf-secret')
        self.restore(job, 'pdf', ['credentials'], self.password)
        self.assertEqual(self.pdf.config()['api_key'], 'pdf-independent-secret')
        self.assertEqual(self.b.load_config()['deepseek']['api_key'], 'new-translation-secret')
        self.restore(job, 'translation', ['credentials'], self.password)
        self.assertEqual(self.b.load_config()['deepseek']['api_key'], 'translation-test-secret')
        self.assertEqual(self.b.load_config()['reader_tts']['api_key'], 'new-tts-secret')
        self.restore(job, 'tts', ['credentials'], self.password)
        self.assertEqual(self.b.load_config()['reader_tts']['api_key'], 'tts-test-secret')
        self.assertEqual(self.b.load_config()['app_password'], 'test-only-password-not-for-deployment')

    def test_plain_settings_only_backup_and_stale_preview(self):
        job = self.archive({'translation': ['settings']})
        path = self.service.root / job['id'] / 'backup.zip'
        with zipfile.ZipFile(path) as archive:
            data = json.loads(archive.read('tools.json'))
            self.assertNotIn('credentials', data['translation'])
            self.assertNotIn(b'translation-test-secret', archive.read('tools.json'))
        self.b.save_dotenv_values({'DEEPSEEK_MODEL': 'another-model'})
        with self.assertRaisesRegex(ValueError, '预览后发生变化'):
            self.restore(job, 'translation', ['settings'])
        self.service.compare(job)
        self.restore(job, 'translation', ['settings'])
        self.assertEqual(self.b.load_config()['deepseek']['model'], 'deepseek-flash')
        self.assertEqual(self.b.load_config()['deepseek']['api_key'], 'translation-test-secret')

    def test_address_changes_cannot_reuse_live_credentials_or_restore_while_pdf_busy(self):
        job = self.archive({'pdf': ['settings', 'credentials']}, self.password)
        self.pdf.save_config({'endpoint': 'http://127.0.0.2:30215'})
        self.service.compare(job, self.password)
        for items in (['settings'], ['credentials']):
            with self.assertRaisesRegex(ValueError, '服务地址'):
                self.restore(job, 'pdf', items, self.password)
        with patch.object(self.pdf, 'active_jobs', return_value=[{'status': 'running'}]):
            with self.assertRaisesRegex(ValueError, '等待 PDF'):
                self.restore(job, 'pdf', ['settings', 'credentials'], self.password)
        self.restore(job, 'pdf', ['settings', 'credentials'], self.password)
        self.assertEqual(self.pdf.config()['endpoint'], 'http://127.0.0.1:30215')

    def test_unselected_sections_and_failed_writes_preserve_current_configuration(self):
        cookie = 'api-platform_serviceToken=test-cookie; userId=test-user'
        self.b.save_mimo_balance_cookie(cookie)
        job = self.archive({'tts': ['settings', 'credentials']}, self.password)
        self.b.save_dotenv_values({'MIMO_API_KEY': 'replacement-key', 'MIMO_TTS_VOICE': '茉莉'})
        self.b.save_mimo_balance_cookie('')
        self.service.compare(job, self.password)
        before = self.b.load_config()
        env = (self.b.BASE_DIR / '.env').read_bytes()
        with patch.object(self.b, 'save_dotenv_values', side_effect=OSError('test write failure')):
            with self.assertRaises(OSError):
                self.restore(job, 'tts', ['settings', 'credentials'], self.password)
        self.assertEqual(self.b.load_config(), before)
        self.assertEqual((self.b.BASE_DIR / '.env').read_bytes(), env)
        self.restore(job, 'tts', ['settings', 'credentials'], self.password)
        self.assertEqual(self.b.load_config()['reader_tts']['voice_id'], '冰糖')
        self.assertIn('test-cookie', self.b.load_config()['reader_tts']['balance_cookie'])

    def test_api_rejects_unencrypted_secrets_and_requests_password_on_upload(self):
        self.enterContext(patch.object(self.b, 'require_auth', return_value=True))
        client = self.b.app.test_client()
        self.enterContext(patch.object(self.b, 'csrf_token', return_value='test-csrf'))
        headers = {'X-CSRF-Token': 'test-csrf'}
        response = client.post('/api/reader/backups', json={'kind':'selected', 'tools':[{'id':'tts','items':['credentials']}]}, headers=headers)
        self.assertEqual(response.status_code, 400)
        job = self.archive({'tts': ['credentials']}, self.password)
        response = client.post('/api/reader/backups/' + job['id'], json={'action':'preview'}, headers=headers)
        self.assertEqual(response.status_code, 400)
        self.assertTrue(response.json['password_required'])
        response = client.get('/api/reader/backups/' + job['id'] + '/download')
        self.assertIn('.transbak', response.headers['Content-Disposition'])
        response.close()
        # Exercise the route orchestration too, with deterministic synchronous jobs.
        run = lambda job, operation, *args: operation(job, *args)
        with patch.object(self.service, 'start', side_effect=run):
            response = client.post('/api/reader/backups', json={'kind':'selected', 'books':[],
                'tools':[{'id':'translation','items':['settings']} ]}, headers=headers)
            self.assertEqual(response.status_code, 202)
            self.assertEqual(response.json['status'], 'ready')
            uploaded = client.post('/api/reader/backups', json={'kind':'upload'}, headers=headers).json
            raw = (self.service.root / job['id'] / 'backup.zip').read_bytes()
            url = '/api/reader/backups/' + uploaded['id']
            self.assertEqual(client.put(url, data=raw, headers={**headers, 'X-Upload-Offset':'0'}).status_code, 200)
            self.assertTrue(client.get(url).json['encrypted'])
            self.assertTrue(client.post(url, json={'action':'preview'}, headers=headers).json['password_required'])
            response = client.post(url, json={'action':'preview','password':self.password}, headers=headers)
            self.assertEqual(response.json['status'], 'preview')

    def test_environment_rolls_back_even_if_disk_rollback_fails(self):
        job = self.archive({'translation': ['credentials']}, self.password)
        self.b.save_dotenv_values({'DEEPSEEK_API_KEY': 'current-secret'})
        self.service.compare(job, self.password)
        def fail_after_environment_update(values):
            os.environ.update(values)
            raise OSError('simulated full disk')
        write = self.b.write_private_text_atomic
        def fail_environment_rollback(path, text):
            if path.name == '.env':
                raise OSError('rollback also failed')
            return write(path, text)
        with patch.object(self.b, 'save_dotenv_values', side_effect=fail_after_environment_update), \
             patch.object(self.b, 'write_private_text_atomic', side_effect=fail_environment_rollback):
            with self.assertRaises(OSError):
                self.restore(job, 'translation', ['credentials'], self.password)
        self.assertEqual(os.environ['DEEPSEEK_API_KEY'], 'current-secret')

    def test_encrypted_reading_and_tool_projects_can_be_restored_independently(self):
        identity = '1' * 32
        book = {'id':identity, 'title':'组合备份', 'format':'txt', 'stored_name':'source.txt',
                'chapters':[{'index':0,'title':'第一章','text':'原始正文。'}], 'progress':{'chapter':0,'sentence':0}}
        self.b.write_book_record(book)
        self.b.upsert_book_index(book)
        source = self.b.book_dir(identity) / 'source.txt'
        source.write_text('原始正文。')
        job = self.service.new('selected')
        self.service.export(job, {identity:['source','reading']}, {'tts':['credentials']}, self.password)
        source.write_text('后来改动的正文。')
        self.service.preview(job, self.password)
        self.service.restore(job, identity, job['books'][0]['token'], True, ['source','reading'], password=self.password)
        self.assertEqual(source.read_text(), '原始正文。')
        self.b.save_dotenv_values({'MIMO_API_KEY':'later-key'})
        self.service.compare(job, self.password)
        self.restore(job, 'tts', ['credentials'], self.password)
        self.assertEqual(self.b.load_config()['reader_tts']['api_key'], 'tts-test-secret')
        self.assertEqual(source.read_text(), '原始正文。')


if __name__ == '__main__':
    unittest.main()
