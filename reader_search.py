"""On-demand, disk-backed book search; no network services or model calls."""
import fcntl
import json
import os
import sqlite3
import tempfile
import threading
import time
from pathlib import Path
from contextlib import closing

INDEX_VERSION = 2
PAGE_SIZE = 30


def revision(directory):
    try:
        return (directory / 'search-revision').read_text().strip()
    except FileNotFoundError:
        return 'original'


def index_revision(directory):
    return f'{INDEX_VERSION}:{revision(directory)}'


def ready(directory):
    path = directory / 'search.sqlite3'
    if not path.exists():
        return False
    try:
        with closing(sqlite3.connect(f'{path.as_uri()}?mode=ro', uri=True)) as db:
            row = db.execute('SELECT revision FROM metadata').fetchone()
            return bool(row and row[0] == index_revision(directory))
    except sqlite3.Error:
        return False


def write_status(path, data):
    # Unlike general book writers, never recreate a book deleted during indexing.
    fd, name = tempfile.mkstemp(prefix='.search-status-', dir=path.parent)
    temp = Path(name)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            json.dump(data, handle, ensure_ascii=False)
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def start_index(directory, root, load_book, paragraphs, logger):
    """Only one index builder per installation, even with multiple workers."""
    lock = (root / 'search-build.lock').open('a+b')
    os.chmod(lock.name, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        return
    if ready(directory):
        lock.close()
        return
    expected = index_revision(directory)
    status_path = directory / 'search-status.json'
    try:
        write_status(status_path, {'status': 'building', 'completed': 0, 'total': 0})
    except OSError:
        lock.close()
        raise

    def build():
        temp = None
        try:
            for abandoned in directory.glob('.search-*.sqlite3'):
                abandoned.unlink(missing_ok=True)
            book = load_book()
            if expected != f"{INDEX_VERSION}:{book.get('content_revision') or 'original'}":
                return
            chapters = book.get('chapters', [])
            fd, name = tempfile.mkstemp(prefix='.search-', suffix='.sqlite3', dir=directory)
            os.close(fd)
            temp = Path(name)
            with closing(sqlite3.connect(temp)) as db:
                db.execute('PRAGMA journal_mode=OFF')
                db.execute('PRAGMA cache_size=-2048')
                db.execute('CREATE TABLE metadata(revision TEXT, mode TEXT)')
                db.execute('CREATE TABLE passages(id INTEGER PRIMARY KEY, chapter INTEGER, title TEXT, text TEXT, folded TEXT, positions TEXT)')
                mode = 'plain'
                try:
                    db.execute("CREATE VIRTUAL TABLE terms USING fts5(folded, content='passages', content_rowid='id', tokenize='trigram')")
                    mode = 'trigram'
                except sqlite3.OperationalError:
                    pass  # Older SQLite still supports bounded, literal searches.
                last_status = 0
                for chapter_index, chapter in enumerate(chapters):
                    if index_revision(directory) != expected or not directory.exists():
                        return
                    sentence_index = 0
                    for sentences in paragraphs(book, chapter_index):
                        chunk, positions, unpublished = '', [], False
                        for sentence in sentences:
                            positions.append([len(chunk), sentence_index])
                            chunk += sentence
                            unpublished = True
                            sentence_index += 1
                            if len(chunk) >= 1200:
                                insert_passage(db, mode, chapter_index, chapter, chunk, positions)
                                # Overlap one sentence to keep phrases at block boundaries searchable.
                                chunk, positions = sentence, [[0, sentence_index - 1]]
                                unpublished = False
                        if chunk and unpublished:
                            insert_passage(db, mode, chapter_index, chapter, chunk, positions)
                    if time.monotonic() - last_status > .5:
                        write_status(status_path, {'status': 'building', 'completed': chapter_index + 1, 'total': len(chapters)})
                        last_status = time.monotonic()
                    time.sleep(.005)  # Yield between chapters; do not compete continuously with playback.
                db.execute('INSERT INTO metadata VALUES (?, ?)', (expected, mode))
                db.commit()
            if index_revision(directory) == expected and directory.exists():
                os.replace(temp, directory / 'search.sqlite3')
                temp = None
                write_status(status_path, {'status': 'ready', 'completed': len(chapters), 'total': len(chapters)})
        except Exception:
            logger.exception('book search index failed book=%s', directory.name)
            if directory.exists():
                write_status(status_path, {'status': 'error', 'error': '正文索引建立失败，请重试'})
        finally:
            if temp:
                temp.unlink(missing_ok=True)
            lock.close()

    try:
        threading.Thread(target=build, name='book-search-index', daemon=True).start()
    except Exception:
        lock.close()
        raise


def insert_passage(db, mode, chapter_index, chapter, text, positions):
    cursor = db.execute('INSERT INTO passages(chapter,title,text,folded,positions) VALUES(?,?,?,?,?)',
                        (chapter_index, chapter.get('title', ''), text, text.lower(), json.dumps(positions)))
    if mode == 'trigram':
        db.execute('INSERT INTO terms(rowid,folded) VALUES(?,?)', (cursor.lastrowid, text.lower()))


def search(directory, query, cursor=0):
    expected = index_revision(directory)
    path = directory / 'search.sqlite3'
    needle = query.lower()
    with closing(sqlite3.connect(f'{path.as_uri()}?mode=ro', uri=True)) as db:
        meta = db.execute('SELECT revision,mode FROM metadata').fetchone()
        if not meta or meta[0] != expected:
            return None
        # Bound pathological searches even on older SQLite without FTS5.
        deadline = time.monotonic() + 1.5
        db.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
        params = [max(0, cursor), needle]
        condition = 'p.id > ? AND instr(p.folded, ?) > 0'
        if meta[1] == 'trigram' and len(needle) >= 3:
            condition += ' AND p.id IN (SELECT rowid FROM terms WHERE terms MATCH ?)'
            params.append('"' + needle.replace('"', '""') + '"')
        rows = db.execute('SELECT p.id,p.chapter,p.title,p.text,p.positions FROM passages p WHERE '
                          + condition + ' ORDER BY p.id LIMIT ?', (*params, PAGE_SIZE + 1)).fetchall()
    results = []
    for row_id, chapter, title, text, positions in rows[:PAGE_SIZE]:
        folded = text.lower()
        offset = folded.find(needle)
        match_end = offset + len(needle)
        if len(folded) != len(text):
            folded_offset, source_start, source_end = 0, None, len(text)
            for index, char in enumerate(text):
                next_offset = folded_offset + len(char.lower())
                if source_start is None and next_offset > offset:
                    source_start = index
                if next_offset >= match_end:
                    source_end = index + 1
                    break
                folded_offset = next_offset
            offset, match_end = source_start or 0, source_end
        sentence = next((index for position, index in reversed(json.loads(positions)) if position <= offset), 0)
        start, end = max(0, offset - 45), min(len(text), match_end + 95)
        results.append({'id': row_id, 'chapter': chapter, 'title': title, 'sentence': sentence,
                        'snippet': ('…' if start else '') + text[start:end] + ('…' if end < len(text) else '')})
    if index_revision(directory) != expected:
        return None
    return {'status': 'ready', 'revision': expected, 'results': results,
            'next_cursor': rows[PAGE_SIZE - 1][0] if len(rows) > PAGE_SIZE else None}
