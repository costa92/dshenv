#!/usr/bin/env bash
# Smoke-test dshenv against a given npm DSH version in an isolated DSH_HOME.
# Usage: scripts/smoke-dsh.sh <dsh-version> [work-dir]
# SMOKE_ALLOW_PLUGIN_EXEMPTION=true grants DSH's exact-version exemption when the plugin's peer range stops before this DSH.
set -uo pipefail

version="${1:?usage: scripts/smoke-dsh.sh <dsh-version> [work-dir]}"
work="${2:-$(mktemp -d)}"
plugin="${SMOKE_PLUGIN:-@nanmicoder/dsh-agent-teams@0.1.22}"
root="$(cd "$(dirname "$0")/.." && pwd)"
dshenv=(node "$root/bin/dshenv.js")
failed=0
# A step's own output goes to its log; fd 3 reaches the report directly.
exec 3>&1

step() {
  local name="$1" expected="$2"
  shift 2
  "$@" >"$work/last.log" 2>&1
  local code=$?
  if [ "$code" -eq "$expected" ]; then
    echo "PASS  $name"
  else
    echo "FAIL  $name (exit $code, expected $expected)"
    sed 's/^/      /' "$work/last.log"
    failed=1
  fi
}

mkdir -p "$work/dsh" "$work/home"
echo "DSH $version, work dir $work"
if ! npm install --prefix "$work/dsh" --no-audit --no-fund "@deepseek-ai/dsh@$version" >"$work/npm.log" 2>&1; then
  echo "FAIL  npm install @deepseek-ai/dsh@$version (see $work/npm.log)"
  exit 1
fi
export DSH_HOME="$work/home"
export DSH_CLI="$work/dsh/node_modules/.bin/dsh"
unset DSHENV_OVERLAY

# Exit 4 means the version gate rejects this version; the rest then runs with the override.
"${dshenv[@]}" doctor --json >"$work/doctor.json" 2>&1
gate=$?
allow=()
case "$gate" in
  0) echo "PASS  version gate accepts $version" ;;
  4) echo "WARN  version gate rejects $version; continuing with --allow-untested-dsh"; allow=(--allow-untested-dsh) ;;
  *) echo "FAIL  doctor (exit $gate)"; sed 's/^/      /' "$work/doctor.json"; exit 1 ;;
esac
run=("${dshenv[@]}" "${allow[@]}")

# DSH refuses a plugin whose peer range stops before it and prints the exact command that accepts the risk. Only that
# refusal is answered, in this throwaway DSH_HOME, so a new DSH is still smoke-tested before the plugin catches up.
apply_granting_exemption() {
  "${run[@]}" apply --yes >"$work/apply.log" 2>&1 && return 0
  local grant
  grant="$(grep -o 'dsh plugin --profile [^ ]* allow-version [^ ]* --dsh-version [^ ]* --accept-risk' "$work/apply.log" | head -1)"
  if [ "${SMOKE_ALLOW_PLUGIN_EXEMPTION:-false}" != true ] || [ -z "$grant" ]; then
    cat "$work/apply.log"
    return 1
  fi
  local args runtime="${grant##*--dsh-version }"
  read -r -a args <<<"${grant#dsh }"
  "$DSH_CLI" "${args[@]}" || return 1
  echo "WARN  $plugin does not declare DSH ${runtime%% *}; granted exact-version exemption for the smoke" >&3
  "${run[@]}" apply --yes
}

step "doctor reports capabilities" 0 "${run[@]}" doctor --json
cp "$work/last.log" "$work/doctor.json"
step "init" 0 "${run[@]}" init
step "declare $plugin" 0 "${run[@]}" install "$plugin" --profile web --as smoke
step "apply install" 0 apply_granting_exemption
step "plan clean after install" 0 "${run[@]}" plan
step "dsh loads the plugin layer" 0 bash -c '"$DSH_CLI" --profile web --dump-config | grep -q "${1%@*}"' _ "$plugin"
step "declare disable" 0 "${run[@]}" disable smoke --profile web
step "apply disable" 0 "${run[@]}" apply --yes
step "plan clean after disable" 0 "${run[@]}" plan
step "declare remove" 0 "${run[@]}" remove smoke --profile web
step "apply remove" 0 "${run[@]}" apply --yes
step "plan clean after remove" 0 "${run[@]}" plan

echo "capabilities:"
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).runtime;for(const [k,v] of Object.entries(r.capabilities))if(v?.status)console.log(`  ${k}: ${v.status}`)' "$work/doctor.json" 2>/dev/null \
  || echo "  (unreadable, see $work/doctor.json)"
exit "$failed"
