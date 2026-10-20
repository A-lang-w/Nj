"""Read-only, opt-in DroidASC probe. This is not the default REA Android backend."""
import argparse
import hashlib
import importlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import struct
import sys
from types import SimpleNamespace
import zipfile


class ProbeError(Exception):
    def __init__(self, kind, message):
        super().__init__(message)
        self.kind = kind


def digest(stream):
    value = hashlib.sha256()
    for block in iter(lambda: stream.read(1024 * 1024), b''):
        value.update(block)
    return value.hexdigest()


def module_fingerprint():
    provenance = {'name': 'droidasc', 'version': None, 'python_executable': sys.executable,
                  'fingerprint_scope': 'Loaded droidasc/mutf8 module files at this snapshot; on-disk '
                                       'contents, not executed-byte identity, distribution version or '
                                       'a complete release/dependency tree.', 'modules': []}
    for name, module in sorted(tuple(sys.modules.items())):
        if name not in ('droidasc', 'mutf8') and not name.startswith(('droidasc.', 'mutf8.')):
            continue
        filename = getattr(module, '__file__', None)
        path, sha = None, None
        if filename is not None:
            path = Path(filename).resolve()
            with path.open('rb') as stream:
                sha = digest(stream)
        provenance['modules'].append({'name': name, 'path': str(path) if path else None, 'sha256': sha})
    return provenance


class Backend(SimpleNamespace):
    @property
    def provenance(self):
        return module_fingerprint()


def target_stat(info):
    return {'dev': str(info.st_dev), 'ino': str(info.st_ino), 'size': info.st_size,
            'mtime_ns': str(info.st_mtime_ns), 'ctime_ns': str(info.st_ctime_ns)}


def load_backend():
    names = ['droidasc.asc_client.apk.dex_reader', 'droidasc.asc_core.utils.tinydex',
             'droidasc.asc_core.findrefs.findrefs_manager']
    modules = [importlib.import_module(name) for name in names]
    return Backend(classes=modules[0].list_dex_classes, parse=modules[1].DEX.parse,
                   references=modules[2].FindRefManager)


def admit_dex(data):
    if len(data) < 112 or data[:4] != b'dex\n' or data[7:8] != b'\0':
        raise ProbeError('input', 'Invalid or truncated standard DEX magic/header.')
    if data[4:7] not in (b'035', b'037', b'038', b'039', b'040'):
        raise ProbeError('unsupported', 'Only standard DEX 035/037/038/039/040 is supported; '
                         '041 containers and other versions are not admitted.')
    size, header, endian = struct.unpack_from('<III', data, 32)
    if size != len(data) or header != 112 or endian != 0x12345678:
        raise ProbeError('input', 'DEX file_size/header_size/endian does not match the supported layout.')
    ranges = []
    for offset, width in ((56, 4), (64, 4), (72, 12), (80, 8), (88, 8), (96, 32), (104, 1), (44, 1)):
        count, start = struct.unpack_from('<II', data, offset)
        if (not count and start) or (count and (start < 112 or start + count * width > size
                                               or (offset != 44 and start % 4))):
            raise ProbeError('input', 'DEX table/data/link range lies outside its supported layout.')
        if count:
            ranges.append((start, start + count * width))
    ranges.sort()
    if any(left[1] > right[0] for left, right in zip(ranges, ranges[1:])):
        raise ProbeError('input', 'DEX table/data/link ranges overlap.')
    map_offset = struct.unpack_from('<I', data, 52)[0]
    if map_offset < 112 or map_offset % 4 or map_offset + 4 > size:
        raise ProbeError('input', 'DEX map_list header is outside the input.')
    map_count = struct.unpack_from('<I', data, map_offset)[0]
    if not map_count or map_offset + 4 + map_count * 12 > size:
        raise ProbeError('input', 'DEX map_list range is truncated or empty.')


def require_backend():
    try:
        return load_backend()
    except Exception as error:
        raise ProbeError('provider_unavailable', 'DroidASC is unavailable in caller-selected Python '
                         + sys.executable + '; supply a compatible reviewed installation/PYTHONPATH: '
                         + str(error)) from error


def availability():
    try:
        return {'complete': True, 'provider': require_backend().provenance, 'error': None}
    except ProbeError as error:
        return {'complete': False, 'provider': None,
                'error': {'kind': error.kind, 'message': str(error)}}


def encoded(value):
    return json.dumps(value, ensure_ascii=True, separators=(',', ':')).encode('utf-8')


def occurrences(backend, data, name, needle):
    dex = backend.parse(memoryview(data), name)
    query = {'string': needle}
    matched = backend.references(dex).find_ref(query, True)
    owners = query['string']
    if not isinstance(matched, list) or not isinstance(owners, list) or len(matched) != len(owners):
        raise ValueError('ASC returned mismatched reference/index arrays')
    counts = {}
    for string_index, owner in zip(matched, owners):
        if owner is None:
            continue
        if type(string_index) is not int or not 0 <= string_index < len(dex.strings):
            raise ValueError('ASC returned an invalid string index')
        for mid in owner if isinstance(owner, list) else [owner]:
            if type(mid) is not int or not 0 <= mid < len(dex.methods):
                raise ValueError('ASC returned an invalid method index')
            method = dex.methods[mid]
            proto = method.prototype
            descriptor = '(' + ''.join(t.descriptor for t in proto.parameters_type) + ')'
            descriptor += dex.get_type(proto.return_type_idx).descriptor
            key = (mid, string_index)
            occurrence = counts.get(key, 0)
            counts[key] = occurrence + 1
            yield {'class_descriptor': method.cls.fullname, 'method_name': str(method.name),
                   'method_descriptor': descriptor, 'method_index': mid,
                   'string_index': string_index, 'string': str(dex.strings[string_index]),
                   'query_occurrence': occurrence, 'offset': None}


def run(apk, operation, query, *, expected_sha256, max_apk_bytes, max_dex_bytes,
        max_output_bytes, cancelled=None):
    result = {'complete': False, 'input': {'path': str(apk), 'sha256': None},
              'operation': operation, 'query': query, 'provider': None,
              'coverage': {'root_dex_entries': 0, 'examined_entries': [], 'excluded_entries': 0,
                           'scope': 'Root ZIP DEX definitions; no embedded DEX, split merge or resources. '
                                    'string-refs covers const-string/jumbo code references only. '
                                    'query_occurrence is not an opcode offset; offset is unknown. '
                                    'Only standard DEX 035/037/038/039/040 headers/ranges are admitted; '
                                    'this is not a full DEX semantic verifier. File digest/stat '
                                    'are sampled at boundaries, not an immutable snapshot.'},
              'dexes': [], 'total_classes': 0 if operation == 'classes' else None, 'classes': [], 'occurrences': [], 'error': None}
    used = 0

    def checkpoint():
        if cancelled is not None and cancelled():
            raise KeyboardInterrupt

    def append(key, row):
        nonlocal used
        checkpoint()
        cost = len(encoded(row)) + bool(result[key])
        if used + cost > max_output_bytes:
            raise ProbeError('capacity', 'Successful evidence exceeds max-output-bytes; '
                             'failure diagnostics may exceed this limit. No complete result was truncated.')
        result[key].append(row)
        used += cost

    try:
        if operation not in ('classes', 'string-refs') or not isinstance(query, str):
            raise ProbeError('input', 'Choose classes or string-refs with a string query.')
        if not isinstance(expected_sha256, str) or re.fullmatch('[0-9a-fA-F]{64}', expected_sha256) is None:
            raise ProbeError('input', 'expected-sha256 must be a 64-digit hexadecimal digest.')
        if any(type(n) is not int or n <= 0 for n in (max_apk_bytes, max_dex_bytes, max_output_bytes)):
            raise ProbeError('input', 'All three caller-selected byte budgets must be positive integers.')
        if not isinstance(apk, (str, os.PathLike)):
            raise ProbeError('input', 'APK input must name a regular local file.')
        checkpoint()
        descriptor = os.open(apk, os.O_RDONLY | getattr(os, 'O_NONBLOCK', 0))
        with os.fdopen(descriptor, 'rb') as stream:
            info = os.fstat(stream.fileno())
            observed_stat = target_stat(info)
            result['input']['stat'] = observed_stat
            if not stat.S_ISREG(info.st_mode):
                raise ProbeError('input', 'APK input must be a regular local file.')
            if info.st_size > max_apk_bytes:
                raise ProbeError('capacity', 'APK exceeds max-apk-bytes before hashing or parsing.')
            result['input']['sha256'] = digest(stream)
            if os.fstat(stream.fileno()).st_size > max_apk_bytes:
                raise ProbeError('capacity', 'APK grew beyond max-apk-bytes while hashing.')
            if target_stat(os.fstat(stream.fileno())) != observed_stat:
                raise ProbeError('identity', 'APK file identity/metadata changed while hashing.')
            if result['input']['sha256'] != expected_sha256.lower():
                raise ProbeError('identity', 'APK SHA-256 does not match expected-sha256.')
            stream.seek(0)
            with zipfile.ZipFile(stream) as archive:
                selected, seen = [], set()
                for entry in archive.infolist():
                    checkpoint()
                    name = entry.filename
                    parts = name[:-1].split('/') if entry.is_dir() else name.split('/')
                    kind = stat.S_IFMT(entry.external_attr >> 16) if entry.create_system == 3 else 0
                    if name in seen or '\\' in name or any(p in ('', '.', '..') for p in parts):
                        raise ProbeError('input', 'Duplicate or ambiguous ZIP entry: ' + repr(name))
                    if kind not in (0, stat.S_IFDIR if entry.is_dir() else stat.S_IFREG):
                        raise ProbeError('input', 'Non-regular ZIP entry: ' + repr(name))
                    seen.add(name)
                    if '/' not in name and name.endswith('.dex'):
                        if entry.flag_bits & 1:
                            raise ProbeError('input', 'Encrypted DEX entries are unsupported.')
                        if entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                            raise ProbeError('unsupported', 'Only stored/Deflate APK DEX entries are supported.')
                        selected.append(entry)
                result['coverage']['root_dex_entries'] = len(selected)
                result['coverage']['excluded_entries'] = len(seen) - len(selected)
                if not selected:
                    raise ProbeError('input', 'No root ZIP DEX entries; raw DEX is not an APK input.')
                if sum(entry.file_size for entry in selected) > max_dex_bytes:
                    raise ProbeError('capacity', 'Total advertised DEX bytes exceed max-dex-bytes before decompression.')
                backend = require_backend()
                result['provider'] = backend.provenance
                used = len(encoded(result))
                if used > max_output_bytes:
                    raise ProbeError('capacity', 'Evidence envelope exceeds max-output-bytes.')
                for entry in selected:
                    checkpoint()
                    data = archive.read(entry)  # ZipFile verifies each selected entry's CRC.
                    admit_dex(data)
                    entry_sha = hashlib.sha256(data).hexdigest()
                    dex_index = len(result['dexes'])
                    append('dexes', {'entry': entry.filename, 'logical_name': entry.filename,
                                     'entry_sha256': entry_sha,
                                     'sha256': hashlib.sha256(data).hexdigest()})
                    if operation == 'classes':
                        for descriptor in backend.classes(data):
                            checkpoint()
                            if not isinstance(descriptor, str) or len(descriptor) < 3 or not (
                                    descriptor.startswith('L') and descriptor.endswith(';')):
                                raise ValueError('ASC returned an invalid class descriptor')
                            canonical_name = descriptor[1:-1].replace('/', '.')
                            result['total_classes'] += 1
                            if query in canonical_name:
                                append('classes', {'dex': dex_index, 'descriptor': descriptor,
                                                   'name': canonical_name})
                    else:
                        for row in occurrences(backend, data, entry.filename, query):
                            append('occurrences', {'dex': dex_index, **row})
                    append_coverage = entry.filename
                    used += len(encoded(append_coverage)) + bool(result['coverage']['examined_entries'])
                    if used > max_output_bytes:
                        raise ProbeError('capacity', 'Coverage exceeds max-output-bytes.')
                    result['coverage']['examined_entries'].append(append_coverage)
                    del data
            checkpoint()
            if target_stat(os.fstat(stream.fileno())) != observed_stat:
                raise ProbeError('identity', 'APK file identity/metadata changed during analysis.')
            stream.seek(0)
            if (digest(stream) != result['input']['sha256']
                    or target_stat(os.fstat(stream.fileno())) != observed_stat):
                raise ProbeError('identity', 'APK content changed during analysis.')
            checkpoint()
            result['provider'] = backend.provenance
            result['complete'] = True
            if len(encoded(result)) > max_output_bytes:
                result['complete'] = False
                raise ProbeError('capacity', 'Serialized result exceeds max-output-bytes.')
    except KeyboardInterrupt:
        result['error'] = {'kind': 'cancelled', 'message': 'Cancelled; retained evidence is partial.'}
    except ProbeError as error:
        result['error'] = {'kind': error.kind, 'message': str(error)}
    except (OSError, zipfile.BadZipFile, zipfile.LargeZipFile) as error:
        result['error'] = {'kind': 'input', 'message': str(error)}
    except Exception as error:
        result['error'] = {'kind': 'analysis', 'message': str(error)}
    if result['error'] is not None:
        result['complete'] = False
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apk', type=Path)
    parser.add_argument('--expected-sha256')
    parser.add_argument('--operation', required=True, choices=('probe', 'classes', 'string-refs'))
    parser.add_argument('--query-json', help='JSON-encoded literal substring; preserves option-like text, NUL and UTF-16 surrogates.')
    parser.add_argument('--max-apk-bytes', type=int)
    parser.add_argument('--max-dex-bytes', type=int,
                        help='Total advertised uncompressed root DEX bytes, checked before inflate.')
    parser.add_argument('--max-output-bytes', type=int,
                        help='Successful JSON evidence budget; failure diagnostics may exceed it.')
    args = parser.parse_args()

    def interrupt(_signum, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupt)
    if args.operation == 'probe':
        result = availability()
    else:
        arguments = vars(args)
        query_json = arguments.pop('query_json')
        try:
            arguments['query'] = None if query_json is None else json.loads(query_json)
            result = run(**arguments)
        except (json.JSONDecodeError, UnicodeError) as error:
            result = {'complete': False, 'provider': None,
                      'error': {'kind': 'input', 'message': 'Invalid query JSON: ' + str(error)}}
    print(encoded(result).decode('utf-8'))
    return 0 if result['complete'] else (130 if result['error']['kind'] == 'cancelled' else 1)


if __name__ == '__main__':
    sys.exit(main())
