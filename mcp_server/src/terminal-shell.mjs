import { quote } from './runtime.mjs';

export function environmentScript(env) {
  return Object.entries(env).filter(([key, value]) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) && typeof value === 'string'
    && !key.startsWith('BOTMUX_') && !['TMUX', 'TMUX_PANE', 'MCP_AUTH_TOKEN', 'CONTROL_PLANE_API_KEY', 'MCP_RUNTIME_AUTH'].includes(key))
    .map(([key, value]) => `export ${key}=${quote(value)}`).join('\n') + '\n';
}

export function isolatedLaunch(environmentFile, args) {
  // The server may have been adopted from an older caller scope. Its global
  // environment must not leak into new shells or collectors. Preserve only
  // tmux's current pane identity before loading the explicit private snapshot.
  return `/usr/bin/env -i "TMUX=$TMUX" "TMUX_PANE=$TMUX_PANE" /bin/bash --noprofile --norc -c ${quote('. "$1"; shift; exec "$@"')} mcp-env ${[environmentFile, ...args].map(quote).join(' ')}`;
}

// Execution receipts use a separate path from the PTY collector. The collector
// still owns byte boundaries, so execution success cannot imply complete output.
export function shellRc({ directory, ready, token }) {
  return [
    `HISTFILE=${quote(directory + '/history')}`,
    "PS1='mcp:\\w\\$ '", 'unset PROMPT_COMMAND', 'set +o history',
    '__csy_dispatch() {',
    '  local __csy_target=$1 __csy_script=$2',
    '  /bin/mkdir -- "${__csy_target%.result.json}.claim" 2>/dev/null || return 125',
    '  __csy_result_file=$__csy_target',
    '  printf \'{"started":true}\\n\' > "${__csy_result_file%.result.json}.started.json.tmp"',
    '  /bin/mv -f -- "${__csy_result_file%.result.json}.started.json.tmp" "${__csy_result_file%.result.json}.started.json"',
    `  printf '\\033]777;${token};%s;0\\007' "\${__csy_result_file##*/}".start`,
    '  . "$__csy_script"', '}',
    '__csy_prompt() {', '  local __csy_code=$?',
    '  if [[ -n ${__csy_result_file-} ]]; then',
    '    printf \'{"exitCode":%d}\\n\' "$__csy_code" > "${__csy_result_file%.result.json}.executed.json.tmp"',
    '    /bin/mv -f -- "${__csy_result_file%.result.json}.executed.json.tmp" "${__csy_result_file%.result.json}.executed.json"',
    `    printf '\\033]777;${token};%s;%d\\007' "\${__csy_result_file##*/}" "$__csy_code"`,
    '    unset __csy_result_file', '  fi',
    `  printf ready > ${quote(ready)}`, '  __csy_at_prompt=1', '}', 'PROMPT_COMMAND=__csy_prompt',
    '__csy_debug() {',
    '  if [[ ${__csy_at_prompt-} == 1 && $BASH_COMMAND != __csy_prompt && ${FUNCNAME[1]-} != __csy_prompt ]]; then',
    '    __csy_at_prompt=0', `    command rm -f -- ${quote(ready)}`, '  fi', '}',
    "trap '__csy_debug' DEBUG", '',
  ].join('\n');
}
