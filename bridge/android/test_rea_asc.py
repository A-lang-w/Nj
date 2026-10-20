"""Wrapper-boundary tests only; doubles do not establish ASC correctness."""
from contextlib import contextmanager, redirect_stdout
import hashlib
import importlib.util
import os
import json
import io
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace as NS
import unittest
from unittest.mock import patch
import warnings
import zipfile

spec = importlib.util.spec_from_file_location('rea_asc', Path(__file__).with_name('rea_asc.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def wrapper_dex(marker=b''):
    data = bytearray(140) + marker
    data[:8] = b'dex\n035\0'
    struct.pack_into('<III', data, 32, len(data), 112, 0x12345678)
    struct.pack_into('<I', data, 52, 112)
    struct.pack_into('<II', data, 104, len(data) - 112, 112)
    struct.pack_into('<IHHIIHHII', data, 112, 2, 0, 0, 1, 0, 0x1000, 0, 1, 112)
    return bytes(data)


def fake_backend():
    def classes(data):
        if data.endswith(b'broken'):
            raise ValueError('malformed DEX')
        return ['Lx/Alpha;', 'Lx/Beta;']

    methods = [NS(cls=NS(fullname='Lx/Alpha;'), name='run',
                  prototype=NS(parameters_type=[], return_type_idx=0)),
               NS(cls=NS(fullname='Lx/Alpha;'), name='run',
                  prototype=NS(parameters_type=[NS(descriptor='I')], return_type_idx=0))]
    dex = NS(methods=methods, strings=['token|\nΩ'],
             get_type=lambda _: NS(descriptor='V'))

    class References:
        def __init__(self, _dex):
            pass

        def find_ref(self, query, mark):
            if query['string'] != 'token' or not mark:
                raise ValueError('incorrect upstream query')
            query['string'] = [0, [1, 0], None]
            return [0, 0, 0]

    return NS(classes=classes, parse=lambda data, name: dex, references=References,
              provenance={'name': 'test-double', 'version': None})


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.apk = Path(self.tmp.name) / 'sample.apk'
        self.archive([('classes.dex', b'first'), ('classes2.dex', b'second'),
                      ('assets/hidden.dex', b'not-covered')])
        self.backend = fake_backend()
        self.patch = patch.object(probe, 'load_backend', return_value=self.backend)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def archive(self, entries):
        with warnings.catch_warnings(), zipfile.ZipFile(self.apk, 'w') as archive:
            warnings.simplefilter('ignore', UserWarning)
            for name, data in entries:
                if data in (b'first', b'second', b'broken', b'a', b'b', b'target'):
                    data = wrapper_dex(data)
                archive.writestr(name, data)

    def run_probe(self, operation='classes', query='Alpha', **changes):
        options = dict(expected_sha256=hashlib.sha256(self.apk.read_bytes()).hexdigest(),
                       max_apk_bytes=100000, max_dex_bytes=1000, max_output_bytes=100000)
        options.update(changes)
        return probe.run(self.apk, operation, query, **options)

    def test_inventory_preserves_root_dex_identity_and_substring(self):
        result = self.run_probe()
        self.assertTrue(result['complete'], result)
        self.assertEqual([d['entry'] for d in result['dexes']], ['classes.dex', 'classes2.dex'])
        self.assertEqual([c['descriptor'] for c in result['classes']], ['Lx/Alpha;'] * 2)
        self.assertEqual([c['dex'] for c in result['classes']], [0, 1])
        self.assertEqual(result.get('total_classes'), 4)
        self.assertEqual(result['dexes'][0]['sha256'], hashlib.sha256(wrapper_dex(b'first')).hexdigest())

    def test_inventory_matches_canonical_dotted_names_without_aliasing(self):
        self.backend.classes = lambda _: ['Lfoo/bar$Inner;']
        result = self.run_probe(query='foo.bar$')
        self.assertEqual([c['name'] for c in result['classes']], ['foo.bar$Inner'] * 2)
        self.assertEqual(result['total_classes'], 2)
        self.assertEqual(self.run_probe(query='Lfoo/')['classes'], [])

    def test_availability_needs_no_apk_and_preserves_module_provenance(self):
        self.assertTrue(hasattr(probe, 'availability'), 'availability operation missing')
        result = probe.availability()
        self.assertTrue(result['complete'])
        self.assertEqual(result['provider'], self.backend.provenance)
        self.patch.stop()
        with patch.object(probe, 'load_backend', side_effect=ImportError('missing')):
            result = probe.availability()
            self.assertFalse(result['complete'])
            self.assertEqual(result['error']['kind'], 'provider_unavailable')

    def test_occurrences_preserve_overloads_shared_owners_and_raw_string(self):
        result = self.run_probe('string-refs', 'token')
        self.assertTrue(result['complete'], result)
        rows = result['occurrences'][:3]
        self.assertEqual([r['method_descriptor'] for r in rows], ['()V', '(I)V', '()V'])
        self.assertEqual([r['query_occurrence'] for r in rows], [0, 0, 1])
        self.assertEqual([r['method_index'] for r in rows], [0, 1, 0])
        self.assertTrue(all(r['string'] == 'token|\nΩ' and r['string_index'] == 0
                            and r['offset'] is None for r in rows))
        self.assertEqual(json.loads(json.dumps(result)), result)

    def test_digest_mismatch_fails_before_provider_use(self):
        self.backend.classes = lambda _: self.fail('provider called before hash verification')
        self.assertEqual(self.run_probe(expected_sha256='0' * 64)['error']['kind'], 'identity')

    def test_duplicate_or_nonregular_or_ambiguous_entry_is_rejected(self):
        link = zipfile.ZipInfo('classes.dex')
        link.create_system = 3
        link.external_attr = 0o120777 << 16
        for entries in [[('classes.dex', b'a'), ('classes.dex', b'b')],
                        [('../classes.dex', b'a')], [(link, b'target')]]:
            with self.subTest(entries=entries):
                self.archive(entries)
                result = self.run_probe()
                self.assertFalse(result['complete'])
                self.assertEqual(result['error']['kind'], 'input')

    def test_budgets_reject_before_dex_decode_and_do_not_truncate_success(self):
        self.backend.classes = lambda _: self.fail('DEX decoded over budget')
        for limits in [dict(max_apk_bytes=1), dict(max_dex_bytes=10), dict(max_output_bytes=1)]:
            result = self.run_probe(**limits)
            self.assertFalse(result['complete'])
            self.assertEqual(result['error']['kind'], 'capacity')

    def test_crc_failure_and_malformed_dex_are_incomplete(self):
        data = bytearray(self.apk.read_bytes())
        name_size, extra_size = struct.unpack_from('<HH', data, 26)
        data[30 + name_size + extra_size] ^= 1
        self.apk.write_bytes(data)
        result = self.run_probe()
        self.assertEqual(result['error']['kind'], 'input')
        self.archive([('classes.dex', b'first'), ('classes2.dex', b'broken')])
        result = self.run_probe()
        self.assertFalse(result['complete'])
        self.assertEqual(len(result['classes']), 1)
        self.assertEqual(result['error']['kind'], 'analysis')

    def test_cancellation_during_final_cleanup_never_returns_complete(self):
        original = os.fdopen

        @contextmanager
        def interrupted_cleanup(fd, mode):
            with original(fd, mode) as stream:
                yield stream
            raise KeyboardInterrupt

        with patch.object(probe.os, 'fdopen', interrupted_cleanup):
            result = self.run_probe()
        self.assertFalse(result['complete'])
        self.assertEqual(result['error']['kind'], 'cancelled')
        self.assertEqual(len(result['classes']), 2)

    def test_same_bytes_rewrite_and_restored_mtime_invalidates_target_observation(self):
        original = self.apk.read_bytes()
        before = self.apk.stat()
        classes = self.backend.classes

        def rewrite(data):
            time.sleep(0.002)
            self.apk.write_bytes(original)
            os.utime(self.apk, ns=(before.st_atime_ns, before.st_mtime_ns))
            return classes(data)

        self.backend.classes = rewrite
        result = self.run_probe()
        self.assertEqual(self.apk.read_bytes(), original)
        self.assertFalse(result['complete'])
        self.assertEqual(result['error']['kind'], 'identity')

    def test_rejects_malformed_empty_class_headers_and_unverified_041(self):
        original = wrapper_dex()
        wrong_size = bytearray(original)
        struct.pack_into('<I', wrong_size, 32, len(original) + 1)
        bad_range = bytearray(original)
        struct.pack_into('<II', bad_range, 56, 1, len(original))
        for data, kind in [(b'dex' + bytes(109), 'input'), (original[:-1], 'input'),
                           (wrong_size, 'input'), (bad_range, 'input'),
                           (b'dex\n041\0' + original[8:], 'unsupported')]:
            with self.subTest(kind=kind, data=bytes(data)[:8]):
                self.archive([('classes.dex', data)])
                result = self.run_probe()
                self.assertFalse(result['complete'])
                self.assertEqual(result['error']['kind'], kind)

    def test_cancelled_and_empty_scope_never_claim_complete(self):
        result = self.run_probe(cancelled=lambda: True)
        self.assertEqual(result['error']['kind'], 'cancelled')
        self.archive([('assets/only.dex', b'a')])
        self.assertEqual(self.run_probe()['error']['kind'], 'input')

    def test_provider_missing_and_malformed_parameters_are_diagnostic(self):
        self.patch.stop()
        with patch.object(probe, 'load_backend', side_effect=ImportError('droidasc missing')):
            self.assertEqual(self.run_probe()['error']['kind'], 'provider_unavailable')
        for options in [dict(max_dex_bytes=0), dict(expected_sha256='invalid')]:
            self.assertEqual(self.run_probe(**options)['error']['kind'], 'input')

    def test_help_needs_no_provider_or_target(self):
        command = [sys.executable, '-B', str(Path(__file__).with_name('rea_asc.py')), '--help']
        result = subprocess.run(command, text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--max-dex-bytes', result.stdout)

    def test_cli_json_query_preserves_option_like_empty_and_utf16_values(self):
        for query in ['--help', '-foo', '', 'a\x00b', '\ud800', '雨😀']:
            with self.subTest(query=repr(query)):
                result = {'complete': True, 'query': query, 'error': None}
                output = io.StringIO()
                with patch.object(sys, 'argv', ['rea_asc', '--operation', 'classes',
                                              '--query-json=' + json.dumps(query)]), \
                     patch.object(probe, 'run', return_value=result) as run, \
                     patch.object(probe.signal, 'signal'), redirect_stdout(output):
                    self.assertEqual(probe.main(), 0)
                    self.assertEqual(run.call_args.kwargs['query'], query)
                self.assertEqual(json.loads(output.getvalue())['query'], query)

    def test_cli_malformed_query_json_is_typed_input_not_a_traceback(self):
        output = io.StringIO()
        with patch.object(sys, 'argv', ['rea_asc', '--operation', 'classes', '--query-json=broken']), \
             patch.object(probe, 'run') as run, patch.object(probe.signal, 'signal'), redirect_stdout(output):
            self.assertEqual(probe.main(), 1)
            run.assert_not_called()
        self.assertEqual(json.loads(output.getvalue())['error']['kind'], 'input')


if __name__ == '__main__':
    unittest.main()
