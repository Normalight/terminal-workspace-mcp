#!/usr/bin/env python3
"""Read-only MCP/Tunnel health snapshot; no credentials or raw RPC payloads."""
from pathlib import Path
import argparse, collections, datetime, json, re, subprocess, shutil, urllib.request, urllib.error
SOURCE_ROOT = Path(__file__).resolve().parents[2]

def redact(text):
    # Redact identifiers inside label values/URLs, not metric names such as
    # tunnel_status_code or tunnel_id. Replacing those destroys diagnostics.
    text = re.sub(r'(?<=["/])tunnel_[A-Za-z0-9_-]+', '<tunnel>', text)
    return re.sub(r'(Bearer\s+|sk-)[^\s"\']+', '<redacted>', text)

def utc_time(value):
    try:
        result = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if result.tzinfo is None: raise ValueError('timezone required')
        return result.astimezone(datetime.timezone.utc)
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValueError('use an ISO timestamp with Z or a timezone offset') from exc

def audit_summary(log, since=None, until=None, command_id=None):
    """Summarize retained metadata, including requests overlapping the window."""
    files = sorted([p for p in log.parent.glob(log.name + '*')
                    if p.name == log.name or re.fullmatch(re.escape(log.name) + r'\.\d{9}', p.name)])
    rows, events, statuses = [], collections.Counter(), collections.Counter()
    malformed = 0
    first = last = None
    fields = ['timestamp', 'event', 'requestId', 'httpMethod', 'rpcMethod', 'toolName', 'session',
              'statusCode', 'durationMs', 'requestBytes', 'responseBytes', 'responseFinished',
              'taskSessionId', 'commandId', 'taskStatus', 'executionStatus', 'outputStatus', 'nextAction',
              'exitCode', 'nextCursor', 'outputEndCursor', 'outputRead', 'outputGap', 'outputComplete',
              'outputTruncated', 'callKind', 'toolError', 'errorCode', 'toolDurationMs',
              'requestedWaitMs', 'effectiveWaitMs', 'waitLimited']
    for file in files:
        try:
            with file.open(errors='replace') as source:
                for line in source:
                    try:
                        row = json.loads(line)
                        end = utc_time(row['timestamp'])
                        duration = max(0, float(row.get('durationMs', 0)))
                        start = end - datetime.timedelta(milliseconds=duration)
                    except (ValueError, KeyError, TypeError, OverflowError):
                        malformed += 1; continue
                    first = min(first, end) if first else end
                    last = max(last, end) if last else end
                    if (since and end < since) or (until and start > until): continue
                    if row.get('event'): events[row['event']] += 1
                    if row.get('httpMethod'):
                        statuses[f"{row['httpMethod']} {row.get('rpcMethod') or '-'} {row.get('statusCode') or 'no_response'}"] += 1
                    rows.append({key: row[key] for key in fields if key in row})
        except FileNotFoundError:
            continue  # Retention can remove a segment during a snapshot.
    if command_id:
        ids = {r.get('requestId') for r in rows if r.get('commandId') == command_id}
        ids.discard(None)
        rows = [r for r in rows if r.get('commandId') == command_id or r.get('requestId') in ids]
        events = collections.Counter(r['event'] for r in rows if r.get('event'))
        statuses = collections.Counter(f"{r['httpMethod']} {r.get('rpcMethod') or '-'} {r.get('statusCode') or 'no_response'}" for r in rows if r.get('httpMethod'))
    calls = [r for r in rows if r.get('rpcMethod') == 'tools/call' and r.get('httpMethod')]
    results = [r for r in rows if r.get('event') == 'tool_result']
    return {'scope': 'retained HTTP metadata; HTTP 200 does not prove tool success or browser receipt',
            'commandId': command_id, 'toolResults': len(results),
            'resultActions': dict(collections.Counter(r.get('nextAction', 'unspecified') for r in results)),
            'since': since.isoformat() if since else None, 'until': until.isoformat() if until else None,
            'retainedFrom': first.isoformat() if first else None, 'retainedThrough': last.isoformat() if last else None,
            'files': len(files), 'malformedLines': malformed, 'matchingRecords': len(rows),
            'events': dict(events), 'requests': dict(statuses),
            'slowestToolRequests': sorted(calls, key=lambda r: r.get('durationMs', 0), reverse=True)[:10],
            'recentMetadata': rows[-100:], 'omittedMetadata': max(0, len(rows) - 100)}

def request_counts(metrics):
    # New tunnel versions report durations where older ones exposed body sizes.
    # Select one family to avoid counting the same HTTP request twice.
    duration = [r for r in metrics if r['name'] == 'http_client_request_duration_seconds_count']
    source = duration or [r for r in metrics if r['name'] == 'http_client_request_body_size_bytes_count']
    counts = collections.Counter()
    for row in source:
        labels = row['labels']
        key = ' '.join([labels.get('server_address', ''), labels.get('http_request_method', ''),
                        labels.get('http_route', ''), labels.get('http_response_status_code', 'no_response_status')])
        counts[key] += row['value']
    return dict(counts)

def tunnel_log_summary(log, since=None, until=None):
    """Retained transport failures can precede any origin HTTP audit entry."""
    messages = {
        'dispatcher received MCP upstream error; posted error response to control plane',
        'poll failed; backing off', 'poll timed out; backing off',
        'control-plane proxy closed long poll; lowering future poll timeout',
    }
    fields = ['level', 'rpc_method', 'status_code', 'failure_source',
              'transport_error_kind', 'upstream_response_received', 'tunnel_client_version']
    rows = []
    files = sorted(p for p in log.parent.glob(log.name + '*') if p.name == log.name or re.fullmatch(re.escape(log.name) + r'\.\d{9}', p.name))
    for file in files:
        try:
            with file.open(errors='replace') as source:
                for line in source:
                    try:
                        row = json.loads(line); time = utc_time(row['time'])
                    except (ValueError, KeyError, TypeError): continue
                    if row.get('level') not in ['WARN', 'ERROR'] or (since and time < since) or (until and time > until): continue
                    rows.append({'timestamp': time.isoformat(), 'event': row.get('msg') if row.get('msg') in messages else 'other_transport_warning',
                                 **{k: row[k] for k in fields if k in row}})
        except FileNotFoundError: continue
    rows.sort(key=lambda r: r['timestamp'])
    return {'scope': 'retained tunnel warnings/errors; separate from browser stream recovery', 'matchingRecords': len(rows), 'recentEvents': rows[-50:]}

def fetch(url):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(url, timeout=5) as res:
            body = res.read(2_000_001)
            if len(body) > 2_000_000: raise ValueError('health response exceeds diagnostic bound')
            return {'http_status': res.status, 'text': body.decode('utf-8', errors='replace')}
    except urllib.error.HTTPError as exc:
        return {'http_status': exc.code, 'text': ''}
    except Exception as exc:
        return {'error_type': type(exc).__name__, 'text': ''}

def snapshot(out, loaded, since=None, until=None, command_id=None):
    ROOT = Path(loaded['config']['workspaceRoot'])
    tunnel = loaded['config']['diagnostics']['tunnelUrl'].rstrip('/')
    out = out.resolve()
    if not out.is_relative_to(ROOT): raise ValueError('output must remain in workspace')
    out.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
    data = {'timestamp_utc': stamp, 'scope': 'cumulative since process start; not a per-incident timeline'}
    for key, url in [('mcp_health',loaded['healthOrigin']+'/healthz'),('tunnel_health',tunnel+'/healthz'),('tunnel_ready',tunnel+'/readyz')]:
        data[key] = fetch(url)
    response = fetch(tunnel+'/metrics'); text = redact(response['text'])
    metrics = []
    for line in text.splitlines():
        if not line or line.startswith('#'): continue
        m = re.match(r'^([^\s{]+)(?:\{(.*)\})?\s+([^\s]+)',line)
        if not m: continue
        name, labels, value = m.groups()
        if name.endswith('_bucket'): continue
        labels = dict(re.findall(r'([a-zA-Z_][a-zA-Z_0-9]*)="([^"]*)"', labels or ''))
        labels = {k:v for k,v in labels.items() if not k.startswith('otel_') and k != 'tunnel_id'}
        if name.startswith(('http_client_request_body_size_bytes_', 'http_client_request_duration_seconds_', 'command_end_to_end_latency_milliseconds_', 'commands_poll_latency_seconds_')) or name in ['commands_poll_cycles_total','commands_poll_errors_total','commands_poll_last_successful_timestamp_seconds','commands_queue_length','commands_queue_capacity','dispatcher_worker_pool_occupancy','dispatcher_worker_pool_capacity','process_start_time_seconds','process_resident_memory_bytes']:
            metrics.append({'name':name,'labels':labels,'value':float(value)})
    data['metrics'] = metrics
    data['httpAudit'] = audit_summary(Path(loaded['config']['paths']['audit']), since, until, command_id)
    data['tunnelEvents'] = tunnel_log_summary(Path(loaded['config']['paths']['service'])/'tunnel.stdout.log', since, until)
    log = Path(loaded['config']['paths']['service'])/'server.stderr.log'
    if log.is_file():
        lines=log.read_text(errors='replace').splitlines();events=[]
        for line in lines:
            if '[command-audit]' not in line:continue
            try: row=json.loads(line.split('[command-audit]',1)[1])
            except ValueError:continue
            events.append({k:row[k] for k in ['timestamp','tool','exitCode','signal','timedOut','outputLimitExceeded','durationMs'] if k in row})
        data['mcp_log']={'path':str(log.relative_to(ROOT)),'bytes':log.stat().st_size,'command_events':len(events),'other_line_count':sum(bool(x.strip()) and '[command-audit]' not in x for x in lines),'recent_command_metadata':events[-20:],'http_session_audit_available':Path(loaded['config']['paths']['audit']).is_file()}
    name=stamp.replace(':','').replace('+','_')
    (out/f'{name}.json').write_text(json.dumps(data,ensure_ascii=False,indent=2))
    (out/'latest.json').write_text(json.dumps(data,ensure_ascii=False,indent=2))
    (out/f'{name}.prom').write_text(text)
    print(json.dumps({'timestamp_utc':stamp,'saved':str(out/f'{name}.json'),'health':{k:data[k] for k in ['mcp_health','tunnel_health','tunnel_ready']},'http_request_counts':request_counts(metrics),
                      'audit_requests':data['httpAudit']['requests'],'audit_events':data['httpAudit']['events']},ensure_ascii=False))

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--config');parser.add_argument('--output')
    parser.add_argument('--since', type=utc_time, help='incident window start, ISO timestamp with timezone')
    parser.add_argument('--until', type=utc_time, help='incident window end; tunnel counters remain cumulative')
    parser.add_argument('--command-id', help='correlate one command and its HTTP request IDs')
    args=parser.parse_args()
    if args.command_id and not re.fullmatch(r'cmd_[a-f0-9-]{36}', args.command_id): parser.error('invalid --command-id')
    if args.since and args.until and args.since > args.until: parser.error('--since must not follow --until')
    command=[shutil.which('node') or 'node',str(SOURCE_ROOT/'mcp_server/scripts/config.mjs'),'show']
    if args.config:command.extend(['--config',args.config])
    loaded=json.loads(subprocess.run(command,check=True,capture_output=True,text=True).stdout)
    snapshot(Path(args.output or Path(loaded['config']['workspaceRoot'])/'outputs/mcp-diagnostics'),loaded,args.since,args.until,args.command_id)
