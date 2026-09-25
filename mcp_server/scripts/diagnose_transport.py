#!/usr/bin/env python3
"""Read-only MCP/Tunnel health snapshot; no credentials or raw RPC payloads."""
from pathlib import Path
import argparse, collections, datetime, json, re, subprocess, shutil, urllib.request, urllib.error
SOURCE_ROOT = Path(__file__).resolve().parents[2]

def redact(text):
    text = re.sub(r'tunnel_[A-Za-z0-9_-]+', '<tunnel>', text)
    return re.sub(r'(Bearer\s+|sk-)[^\s"\']+', '<redacted>', text)

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

def snapshot(out, loaded):
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
        if name.startswith('http_client_request_body_size_bytes_') or name in ['commands_poll_cycles_total','commands_poll_errors_total','commands_poll_last_successful_timestamp_seconds','commands_queue_length','commands_queue_capacity','dispatcher_worker_pool_occupancy','dispatcher_worker_pool_capacity','process_start_time_seconds','process_resident_memory_bytes']:
            metrics.append({'name':name,'labels':labels,'value':float(value)})
    data['metrics'] = metrics
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
    counts={}
    for row in metrics:
        if row['name']=='http_client_request_body_size_bytes_count':
            l=row['labels']; key=' '.join([l.get('server_address',''),l.get('http_request_method',''),l.get('http_route',''),l.get('http_response_status_code','no_response_status')]);counts[key]=row['value']
    print(json.dumps({'timestamp_utc':stamp,'saved':str(out/f'{name}.json'),'health':{k:data[k] for k in ['mcp_health','tunnel_health','tunnel_ready']},'http_request_counts':counts},ensure_ascii=False))

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--config');parser.add_argument('--output')
    args=parser.parse_args()
    command=[shutil.which('node') or 'node',str(SOURCE_ROOT/'mcp_server/scripts/config.mjs'),'show']
    if args.config:command.extend(['--config',args.config])
    loaded=json.loads(subprocess.run(command,check=True,capture_output=True,text=True).stdout)
    snapshot(Path(args.output or Path(loaded['config']['workspaceRoot'])/'outputs/mcp-diagnostics'),loaded)
