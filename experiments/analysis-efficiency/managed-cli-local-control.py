"""Existing native code-composition control: save complete stdout, return selected facts."""
import argparse
import json
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('runtime', type=Path)
parser.add_argument('target', type=Path)
parser.add_argument('output', type=Path)
args = parser.parse_args()
args.output.mkdir()
node = 'node'
entry = str(args.runtime / 'scripts/rea.mjs')
help_result = subprocess.run([node, entry, 'inspect-managed-members', '--help'], check=True, capture_output=True, text=True)
(args.output / 'help.txt').write_text(help_result.stdout)
with (args.output / 'parent.json').open('w') as file:
    subprocess.run([node, entry, 'inspect-managed-members', str(args.target), '--type', 'Newtonsoft.Json.JsonConvert', '--json'], check=True, stdout=file)
parent = json.loads((args.output / 'parent.json').read_text())
data = parent['normalized_result']
answer = {'parent_evidence_id': parent['evidence_id'], 'artifact_sha256': data['artifact']['sha256'],
          'selection': data['selection'], 'source_coverage': data['coverage'],
          'total_methods': len(data['methods']), 'total_member_refs': len(data['member_refs']),
          'methods': data['methods'][:8], 'member_refs': data['member_refs'][:16],
          'limitation': 'MemberRef rows are assembly-wide; methods are selected-type rows. Page exhaustion is not an absence claim.'}
(args.output / 'answer.json').write_text(json.dumps(answer))
print(json.dumps(answer))
