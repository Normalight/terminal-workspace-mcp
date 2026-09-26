import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fixture, workspaceRoot } from './helpers.mjs';

const exec = promisify(execFile);
test('incident diagnostics retain metric labels, bound audit windows and omit request contents', async () => {
  const f = await fixture();
  try {
    const { stdout } = await exec('python3', ['-B', '-c', `
import json, pathlib, runpy, sys
d=runpy.run_path(sys.argv[1]); root=pathlib.Path(sys.argv[2])
metric='sample{tunnel_id="tunnel_private123",tunnel_status_code="200",http_route="/v1/tunnels/tunnel_private123/response"} 2'
redacted=d['redact'](metric)
assert 'tunnel_private123' not in redacted
assert 'tunnel_id=' in redacted and 'tunnel_status_code="200"' in redacted
assert 'secret-token' not in d['redact']('Authorization: Bearer secret-token')
labels={'server_address':'example.test','http_request_method':'POST','http_route':'/response','http_response_status_code':'200'}
rows=[{'name':n,'labels':labels,'value':v} for n,v in [('http_client_request_duration_seconds_count',3),('http_client_request_duration_seconds_count',2),('http_client_request_body_size_bytes_count',5)]]
assert list(d['request_counts'](rows).values()) == [5]
assert list(d['request_counts'](rows[-1:]).values()) == [5]
base=root/'audit.jsonl'
def row(t,ms=0,**kwargs): return {'timestamp':t,'httpMethod':'POST','rpcMethod':'tools/call','statusCode':200,'durationMs':ms,**kwargs}
base.write_text(json.dumps(row('2026-09-26T15:00:00Z',body='private-command',authorization='private-token'))+'\\n')
pathlib.Path(str(base)+'.000000001').write_text('broken\\n'+json.dumps(row('2026-09-26T15:01:20Z',30000,command='private-command'))+'\\n'+json.dumps(row('2026-09-26T15:03:00Z'))+'\\n')
summary=d['audit_summary'](base,d['utc_time']('2026-09-26T23:00:10+08:00'),d['utc_time']('2026-09-26T15:01:00Z'))
assert summary['matchingRecords']==1 and summary['malformedLines']==1
assert summary['requests']=={'POST tools/call 200':1}
assert summary['retainedFrom']=='2026-09-26T15:00:00+00:00'
assert summary['recentMetadata'][0]['durationMs']==30000
assert 'private-' not in json.dumps(summary)
try: d['utc_time']('2026-09-26T15:00:00')
except ValueError: pass
else: raise AssertionError('ambiguous local time accepted')
print('ok')
`, path.join(workspaceRoot, 'mcp_server/scripts/diagnose_transport.py'), f.root], { env: f.env });
    assert.equal(stdout.trim(), 'ok');
  } finally { await f.cleanup(); }
});
