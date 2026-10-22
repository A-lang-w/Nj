"""Verify paired SDK startup/analysis receipts and account for the whole task."""
import argparse
import hashlib
import importlib.util
import json
import statistics
from pathlib import Path

import tiktoken

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('root', type=Path)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
root = args.root
inputs = json.loads((root / 'measurement-inputs.json').read_text())
expected = inputs['runtime_bindings']
sha = lambda value: hashlib.sha256(value).hexdigest()
compact = lambda value: json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
encoding = tiktoken.get_encoding('cl100k_base')
count = lambda value: len(encoding.encode(value, disallowed_special=()))
for role in ['baseline', 'candidate']:
    assert expected[role]['git_revision'] == inputs[f'{role}_revision']
    assert expected[role]['source_diff_sha256'] == sha(b'')
    assert expected[role]['untracked_source_sha256'] == sha(b'[]')
assert expected['baseline']['root'] != expected['candidate']['root']
assert expected['baseline']['compiled_runtime_sha256'] != expected['candidate']['compiled_runtime_sha256']
spec = importlib.util.spec_from_file_location('catalog_costs', Path(__file__).with_name('mcp-input-catalog-costs.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
catalogs = {}
identities = {}
rows = []
for case in inputs['cases']:
    directory = root / case['case']
    report = json.loads((directory / 'report.json').read_text())
    assert report['status'] == 'passed' and report['cleanup_verified']
    assert report['runtime_binding_verified']
    assert report['runtime_binding'] == expected[case['role']]
    for key in ['role', 'cache', 'profile', 'phase']:
        assert report[key] == case[key]
    raw = (directory / 'catalog.json').read_bytes()
    digest = sha(raw)
    assert digest == report['catalog_sha256']
    profile = case['profile']
    if profile not in catalogs:
        catalog = json.loads(raw)
        definitions = [{key: tool[key] for key in ['name', 'description', 'inputSchema']} for tool in catalog['tools']]
        catalogs[profile] = {'sha256': digest, 'tool_count': len(catalog['tools']),
                             'input_catalog_tokens': count(compact(definitions)),
                             'raw_catalog_tokens': count(raw.decode()), 'raw_catalog_bytes': len(raw)}
    assert digest == catalogs[profile]['sha256'], 'Directory differs across roles or phases'
    transcript = json.loads((directory / 'transcript.json').read_text())
    server = json.loads((directory / 'server.json').read_text())
    tokens = {'question_and_recipe': count(inputs['questions'][case['phase']] + '\n' + inputs['recipes'][case['phase']]),
              'server_instructions': count(server.get('instructions') or ''),
              'input_catalog_once': catalogs[profile]['input_catalog_tokens'],
              'arguments': sum(count(compact({'name': call['name'], 'arguments': call['arguments']})) for call in transcript),
              'text_replies': sum(count(block['text']) for call in transcript for block in call['reply']['content'] if block['type'] == 'text')}
    requests = report['protocol_requests']
    assert requests['initialize'] == 1
    if case['phase'] == 'analysis':
        assert len(transcript) == 5 and requests['tools/call'] == 5 and requests['tools/list'] == 2
        assert report['artifact_sha256'] == inputs['artifacts'][case['artifact']]['sha256']
        identity = (report['parent_evidence_id'], report['parent_semantic_sha256'], sha(compact(report['answer']).encode()))
        assert identities.setdefault(case['artifact'], identity) == identity
        assert sum(call['is_error'] for call in report['calls']) == 1
    else:
        assert not transcript and requests.get('tools/call', 0) == 0
        assert requests['tools/list'] == 1 and requests['prompts/list'] == 1
        prompts = (directory / 'prompts.json').read_bytes()
        assert sha(prompts) == report['prompts_sha256']
        assert identities.setdefault('prompts', report['prompts_sha256']) == report['prompts_sha256']
        tokens['prompt_directory'] = count(prompts.decode())
    tokens['whole_task'] = sum(tokens.values())
    row = {**case, 'runtime_binding': report['runtime_binding'], 'runtime_audit_ms': report['runtime_audit_ms'],
           'catalog_sha256': digest, 'parent_evidence_id': report.get('parent_evidence_id'),
           'parent_semantic_sha256': report.get('parent_semantic_sha256'),
           'answer_sha256': sha(compact(report['answer']).encode()), 'tokens_estimated': tokens,
           'actual_model_usage': None, 'protocol_requests': requests, 'calls': report['calls'],
           **module.resource(directory),
           'receipt_sha256': {name: sha((directory / name).read_bytes()) for name in ['report.json', 'catalog.json', 'server.json', 'transcript.json']}}
    rows.append(row)
assert len(rows) == 72
summary = []
for phase in ['discovery', 'analysis']:
    for cache in ['cold', 'warm']:
        for profile in ['default', 'full']:
            for artifact in ([None] if phase == 'discovery' else ['ripgrep', 'zellij']):
                item = {'phase': phase, 'cache': cache, 'profile': profile, 'artifact': artifact}
                for role in ['baseline', 'candidate']:
                    selected = [row for row in rows if all(row[key] == value for key, value in item.items()) and row['role'] == role]
                    assert len(selected) == 3
                    item[role] = {metric: {'median': statistics.median(row[metric] for row in selected),
                                           'min': min(row[metric] for row in selected), 'max': max(row[metric] for row in selected)}
                                  for metric in ['wall_seconds', 'cpu_seconds', 'kernel_family_peak_bytes_including_page_cache']}
                    item[role]['tokens_estimated'] = [row['tokens_estimated']['whole_task'] for row in selected]
                summary.append(item)
result = {'status': 'passed', 'tokenizer': f'tiktoken=={tiktoken.__version__}/cl100k_base; estimates, not model usage',
          'context_scope': 'Question, explicit recipe, server instructions, one complete name/description/input-schema directory, every tool argument and text reply, plus prompt directory for discovery. Raw output-schema transport tokens are separate. SDK initialization framing, reasoning and actual model usage are unmeasured. The analysis task includes retained-read, rejection, export/oracle and post-materialization directory checks.',
          'cache_scope': 'Cold disables server Node compile cache. Warm enables a prepopulated role/profile-specific cache after one complete analysis priming run. Fresh server/client processes and HOME each trial. Driver compile cache disabled in both cohorts. Cache hit rate and OS page cache are unmeasured; source/runtime audits warm compiled-file pages before startup.',
          'resource_scope': 'Whole SDK driver, resource observer and owned REA process family. Includes before/after source-and-all-compiled-JS/JSON binding, SDK schema checks, extra validation calls, bundle export and independent oracle checking. Kernel cgroup peak includes file cache. Build/download/oracle preparation and cache priming excluded. Retained V8 heap and forced-GC diagnostics were not separately measured.',
          'measurement_inputs': inputs, 'catalogs': catalogs, 'summary': summary, 'records': rows,
          'warmup_receipts': {name: sha((root / name / 'report.json').read_bytes()) for name in [f'warmup-{profile}-{role}' for profile in ['default', 'full'] for role in ['baseline', 'candidate']]}}
args.output.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(summary, indent=2))
