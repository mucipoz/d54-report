#!/usr/bin/env bash
set -euo pipefail

project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
: "${HOME:?Kullanıcı dizini belirlenemedi}"
rule=$(cat <<'RULE'
Kullanıcı projeyi D54 Report'a tarattır dediğinde `d54_scan_project` (`use_llm: false`) çağır, özeti sun; düzeltme istenirse önce `d54_fix_findings` (`mode: patch`, `severity: critical,high`) ile güvenli yama üret, onaysız ana koda dokunma.
RULE
)

# Use the configured npm prefix whenever possible, including a new writable prefix.
writable_directory() {
  local dir=$1
  while [[ ! -e "$dir" ]]; do dir=$(dirname -- "$dir"); done
  [[ -d "$dir" && -w "$dir" && -x "$dir" ]]
}

prefix=$(npm prefix --global)
if [[ "$prefix" == /usr || "$prefix" == /usr/local ]] &&
   { ! writable_directory "$prefix/bin" || ! writable_directory "$prefix/lib/node_modules"; }; then
  prefix="$HOME/.local"
  export npm_config_prefix="$prefix"
  printf 'Kullanıcı kurulum dizini: %s\n' "$prefix"
fi

(
  cd -- "$project_dir"
  npm install
  npm run build
  npm link
)

case ":$PATH:" in
  *":$prefix/bin:"*) ;;
  *)
    printf 'Yeni terminaller ve MCP istemcileri için PATH içine ekleyin: %s/bin\n' "$prefix"
    export PATH="$prefix/bin:$PATH"
    ;;
esac

# Register in the caller's project, using Claude's default local scope.
if command -v claude >/dev/null 2>&1; then
  if registration=$(claude mcp add d54-report -- d54-report-mcp 2>&1); then
    printf '%s\n' "$registration"
  elif details=$(NO_COLOR=1 claude mcp get d54-report 2>/dev/null) &&
       grep -Eq '^[[:space:]]*Command:[[:space:]]+d54-report-mcp[[:space:]]*$' <<<"$details"; then
    printf '%s\n' 'Claude MCP kaydı zaten mevcut.'
  else
    printf '%s\n' "$registration" >&2
    exit 1
  fi
fi

append_rule() (
  local file=$1 dir lock rc
  dir=$(dirname -- "$file")
  umask 077
  mkdir -p -- "$dir"
  if [[ -e "$file" || -L "$file" ]] && [[ ! -f "$file" ]]; then
    printf 'Talimat yolu normal bir dosya olmalıdır: %s\n' "$file" >&2
    exit 1
  fi
  exec 9>>"$file"
  if command -v flock >/dev/null 2>&1; then
    flock -x 9
  else
    lock="$file.d54-install.lock"
    mkdir -- "$lock" || { printf 'Talimat dosyası kilitlenemedi: %s\n' "$file" >&2; exit 1; }
    trap 'rmdir -- "$lock"' EXIT
    trap 'exit 1' HUP INT TERM
  fi
  if grep -Fq -- "$rule" "$file"; then return 0; else rc=$?; fi
  if [[ $rc != 1 ]]; then exit "$rc"; fi
  if [[ -s "$file" ]]; then printf '\n\n' >&9; fi
  printf '%s\n' "$rule" >&9
)

append_rule "$HOME/.claude/CLAUDE.md"
append_rule "$HOME/.codex/AGENTS.md"
printf '%s\n' 'D54 Report kuruldu. CLI: d54-report · MCP: d54-report-mcp'
