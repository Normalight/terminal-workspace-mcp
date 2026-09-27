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
transport=root/'tunnel.stdout.log'
transport.write_text('\\n'.join(json.dumps(r) for r in [
 {'time':'2026-09-26T23:05:00.123456789+08:00','level':'WARN','msg':'dispatcher received MCP upstream error; posted error response to control plane','rpc_method':'initialize','status_code':502,'transport_error_kind':'connection_reset','upstream_response_received':False,'authorization':'private-token'},
 {'time':'2026-09-26T15:06:00Z','level':'WARN','msg':'private-command','error':'private-token'},
 {'time':'2026-09-26T15:07:00Z','level':'WARN','msg':'poll timed out; backing off'}
])+'\\n')
summary=d['tunnel_log_summary'](transport,until=d['utc_time']('2026-09-26T15:06:30Z'))
assert summary['matchingRecords']==2
assert summary['recentEvents'][0]['timestamp']=='2026-09-26T15:05:00.123456+00:00'
assert summary['recentEvents'][0]['transport_error_kind']=='connection_reset'
assert summary['recentEvents'][0]['upstream_response_received'] is False
assert summary['recentEvents'][1]['event']=='other_transport_warning'
assert 'private-' not in json.dumps(summary)
cid='cmd_'+'a'*36
base.write_text('\\n'.join(json.dumps(r) for r in [
 {'timestamp':'2026-09-26T15:04:00Z','event':'tool_started','requestId':'correlated','toolName':'execute_command'},
 {'timestamp':'2026-09-26T15:04:01Z','event':'http_aborted','requestId':'correlated','httpMethod':'POST','rpcMethod':'tools/call','responseFinished':False},
 {'timestamp':'2026-09-26T15:04:02Z','event':'tool_result','requestId':'correlated','commandId':cid,'nextAction':'done','taskStatus':'succeeded','command':'private-command','stdout':'private-output'},
 {'timestamp':'2026-09-26T15:04:03Z','event':'tool_result','requestId':'unrelated','commandId':'cmd_'+'b'*36,'nextAction':'poll'}
])+'\\n')
summary=d['audit_summary'](base,command_id=cid)
assert summary['matchingRecords']==3 and summary['toolResults']==1
assert summary['resultActions']=={'done':1}
assert {r['requestId'] for r in summary['recentMetadata']}=={'correlated'}
assert 'private-' not in json.dumps(summary)
try: d['utc_time']('2026-09-26T15:00:00')
except ValueError: pass
else: raise AssertionError('ambiguous local time accepted')
print('ok')
`, path.join(workspaceRoot, 'mcp_server/scripts/diagnose_transport.py'), f.root], { env: f.env });
    assert.equal(stdout.trim(), 'ok');
  } finally { await f.cleanup(); }
});
