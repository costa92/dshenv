#!/usr/bin/env bash
# End-to-end test of dshenv's main chain against a real npm DSH in an isolated DSH_HOME:
# adopt -> manifest/lock/ownership -> plan -> apply -> verify on disk and in DSH -> runtime -> rollback -> remove,
# then scaffolds, Git sources, overlays, purge/gc, profile patches, a team remote and an external non-bundle plugin.
# Usage: scripts/e2e-dsh.sh <dsh-version> [work-dir]
set -uo pipefail

version="${1:?usage: scripts/e2e-dsh.sh <dsh-version> [work-dir]}"
work="${2:-$(mktemp -d)}"
# An npm plugin compatible with the DSH under test; a local tool plugin covers source updates.
pkg="${E2E_PLUGIN:-@nanmicoder/dsh-agent-teams}"
pkg_version="${E2E_PLUGIN_VERSION:-0.1.22}"
tool="e2e-tool"
root="$(cd "$(dirname "$0")/.." && pwd)"
dshenv=(node "$root/bin/dshenv.js")
failed=0
web_pid=""

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

# Evaluates a JS expression over the parsed JSON file; the step passes when it is truthy.
json_true() {
  node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(new Function("v","return ("+process.argv[2]+")")(v)?0:1)' "$1" "$2"
}

installed_version() {
  node -p 'require(process.argv[1]).version' "$DSH_HOME/profiles/web/node_modules/$1/package.json" 2>/dev/null
}

# The manifest alias dshenv gave a package, read from `list --json`.
alias_of() {
  "${run[@]}" plugins list --profile web --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).plugins.find(p=>p.package===process.argv[1]&&p.alias);console.log(r?r.alias:"")})' "$1"
}

stop_web() {
  if [ -n "$web_pid" ]; then
    kill "$web_pid" 2>/dev/null
    wait "$web_pid" 2>/dev/null
    web_pid=""
  fi
}

# web start leaves dsh web running on its own, so a run that ends before `web stop` stops it here.
stop_all() {
  stop_web
  if [ -n "${run+x}" ]; then
    DSH_HOME="$work/home" "${run[@]}" web stop --profile web >/dev/null 2>&1
  fi
}
trap stop_all EXIT

# Starts dsh web for the current DSH_HOME's web profile and sets url once it prints one.
start_web() {
  "$DSH_CLI" web --no-open --port 0 >"$1" 2>&1 &
  web_pid=$!
  url=""
  for _ in $(seq 1 60); do
    url="$(grep -o 'http://127\.0\.0\.1:[0-9]*/?token=[^[:space:]]*' "$1" | head -1)"
    [ -n "$url" ] && break
    sleep 1
  done
}

# DSH hot-reloads a change a moment after apply, so runtime is asked again until it agrees.
runtime_ok() {
  for _ in $(seq 1 30); do
    DSHENV_DSH_URL="$url" "${run[@]}" verify --profile web && return 0
    sleep 2
  done
  return 1
}

mkdir -p "$work/dsh" "$work/home"
echo "DSH $version, work dir $work"
if ! npm install --prefix "$work/dsh" --no-audit --no-fund "@deepseek-ai/dsh@$version" >"$work/npm.log" 2>&1; then
  echo "FAIL  npm install @deepseek-ai/dsh@$version (see $work/npm.log)"
  exit 1
fi
export DSH_HOME="$work/home"
export DSH_CLI="$work/dsh/node_modules/.bin/dsh"
unset DSHENV_OVERLAY DSHENV_DSH_URL
envctl="$DSH_HOME/envctl"

"${dshenv[@]}" doctor --json >"$work/doctor.json" 2>&1
case "$?" in
  0) allow=() ;;
  4) echo "WARN  version gate rejects $version; continuing with --allow-untested-dsh"; allow=(--allow-untested-dsh) ;;
  *) echo "FAIL  doctor"; sed 's/^/      /' "$work/doctor.json"; exit 1 ;;
esac
run=("${dshenv[@]}" "${allow[@]}")

# 1. Adopt a plugin DSH installed on its own: capture, adopt, ownership, clean plan.
step "dsh installs $pkg@$pkg_version outside dshenv" 0 "$DSH_CLI" plugin --profile web add "$pkg@$pkg_version"
step "init" 0 "${run[@]}" init
step "plan leaves the unmanaged plugin alone" 0 "${run[@]}" plan
step "capture the profile" 0 "${run[@]}" capture --profile web --output "$work/capture.yaml"
step "adopt previews without --yes" 2 "${run[@]}" adopt "$work/capture.yaml"
step "adopt the capture" 0 "${run[@]}" adopt "$work/capture.yaml" --yes
step "adopt records ownership" 0 json_true "$envctl/state.json" "v.resources?.plugin?.web?.['$pkg']?.lockedVersion === '$pkg_version'"
step "plan clean after adopt" 0 "${run[@]}" plan
alias="$(alias_of "$pkg")"
step "manifest declares an alias for $pkg" 0 test -n "$alias"
step "dsh composes the adopted plugin" 0 bash -c '"$DSH_CLI" --profile web --dump-config | grep -q "$1"' _ "$pkg"

# 2. Install a local source: manifest -> plan -> apply -> lock digest; a source edit plans an update.
step "scaffold and declare a local tool plugin" 0 bash -c 'cd "$1" && "${@:2}" new tool '"$tool"' -p web' _ "$work" "${run[@]}"
tool_alias="$(alias_of "$tool")"
step "plan shows the install" 2 "${run[@]}" plan
step "apply install" 0 "${run[@]}" apply --yes
step "plan clean after install" 0 "${run[@]}" plan
step "lock records the local source digest" 0 json_true "$envctl/lock.json" "Boolean(v.profiles.web.plugins['$tool_alias']?.source?.digest)"
step "state takes ownership of the installed plugin" 0 json_true "$envctl/state.json" "Boolean(v.resources?.plugin?.web?.['$tool'])"
step "dsh composes the tool plugin" 0 bash -c '"$DSH_CLI" --profile web --dump-config | grep -q "$1"' _ "$tool"
echo "// e2e edit" >>"$work/$tool/index.js"
step "plan sees the source change as an update" 2 "${run[@]}" plan
step "apply update" 0 "${run[@]}" apply --yes
step "plan clean after update" 0 "${run[@]}" plan

# 3. Configure through a managed patch block.
step "declare config" 0 "${run[@]}" plugins config set "$alias" e2eMarker on --profile web --force
step "plan shows configure" 2 "${run[@]}" plan
step "apply configure" 0 "${run[@]}" apply --yes
step "patch file holds the managed block" 0 grep -q "# dshenv:begin profile=web plugin=$alias" "$DSH_HOME/profiles/web/cordis.patch.yml"
step "plan clean after configure" 0 "${run[@]}" plan

# 4. Drift: a change made behind dshenv's back is detected and repaired.
node -e 'const f=process.argv[1];const p=require(f);p.version="0.0.0-drift";require("fs").writeFileSync(f,JSON.stringify(p))' \
  "$DSH_HOME/profiles/web/node_modules/$pkg/package.json"
step "plan detects version drift" 2 "${run[@]}" plan
step "apply repairs the drift" 0 "${run[@]}" apply --yes
step "plan clean after repair" 0 "${run[@]}" plan
step "profile has $pkg@$pkg_version again" 0 test "$(installed_version "$pkg")" = "$pkg_version"

# 5. Runtime: the running dsh web reports the plugin loaded.
start_web "$work/web.log"
step "dsh web starts and prints its URL" 0 test -n "$url"
if [ -n "$url" ]; then
  step "runtime reports the plugin loaded" 0 runtime_ok
fi
stop_web
step "verify --start starts its own dsh web and reports the plugin loaded" 0 "${run[@]}" verify --profile web --start
step "verify --start leaves no dsh web running" 0 bash -c "! pgrep -f -- '[-]-profile web --no-open --port 0' >/dev/null"
step "web start leaves dsh web running in the background" 0 "${run[@]}" web start --profile web
step "verify uses the dsh web that web start left running" 0 env -u DSHENV_DSH_URL "${run[@]}" verify --profile web
step "web status reports it running" 0 bash -c '"$@" web status | grep -q "^web  running  pid "' _ "${run[@]}"
step "web stop stops it" 0 "${run[@]}" web stop --profile web
step "web stop leaves no dsh web running" 0 bash -c "! pgrep -f -- '[-]-profile web --no-open --port 0' >/dev/null"

# 6. Rollback restores the manifest files; apply converges again.
step "rollback dry-run" 2 "${run[@]}" rollback --dry-run
step "rollback" 0 "${run[@]}" rollback --yes
step "apply after rollback" 0 "${run[@]}" apply --yes
step "plan clean after rollback" 0 "${run[@]}" plan

# 7. Remove: an owned plugin dropped from the manifest is uninstalled.
step "declare remove" 0 "${run[@]}" remove "$alias" --profile web
step "apply remove" 0 "${run[@]}" apply --yes
step "plan clean after remove" 0 "${run[@]}" plan
step "profile no longer has $pkg" 0 test -z "$(installed_version "$pkg")"
step "ownership released" 0 json_true "$envctl/state.json" "!v.resources?.plugin?.web?.['$pkg']"

# 8. Scaffolds: every package kind installs and composes; a loose skill needs no package.
for kind in skill agent mcp; do
  step "scaffold and declare a $kind package" 0 bash -c 'cd "$1" && "${@:3}" new "$2" "e2e-$2" -p web' _ "$work" "$kind" "${run[@]}"
done
step "scaffold a loose skill" 0 "${run[@]}" new skill e2e-loose --loose
step "loose skill written to DSH_HOME/skills" 0 test -f "$DSH_HOME/skills/e2e-loose/SKILL.md"
step "plan shows the scaffold installs" 2 "${run[@]}" plan
step "apply scaffold installs" 0 "${run[@]}" apply --yes
step "plan clean after scaffold installs" 0 "${run[@]}" plan
for kind in skill agent mcp; do
  step "dsh composes the $kind package" 0 bash -c '"$DSH_CLI" --profile web --dump-config | grep -q "$1"' _ "e2e-$kind"
done

# 9. Git source: clone into envctl/sources with the commit locked; an upstream commit pulled in plans an update.
git_origin="$work/git-origin"
git_pkg="e2e-git-tool"
commit_all() {
  git -C "$1" add -A && git -C "$1" -c user.name=e2e -c user.email=e2e@example.invalid -c commit.gpgsign=false commit -qm "$2"
}
step "scaffold the Git plugin repository" 0 "${run[@]}" new tool "$git_pkg" --dir "$git_origin"
step "commit the Git plugin repository" 0 bash -c 'git init -q --initial-branch=main "$1" && git -C "$1" add -A && git -C "$1" -c user.name=e2e -c user.email=e2e@example.invalid -c commit.gpgsign=false commit -qm init' _ "$git_origin"
step "source clone into the profile" 0 "${run[@]}" source clone "file://$git_origin" --profile web
git_alias="$(alias_of "$git_pkg")"
step "clone stored under envctl/sources" 0 test -d "$envctl/sources/web/$git_pkg/.git"
step "lock pins the cloned commit" 0 json_true "$envctl/lock.json" "v.profiles.web.plugins['$git_alias']?.source?.commit === '$(git -C "$git_origin" rev-parse HEAD)'"
step "apply Git source install" 0 "${run[@]}" apply --yes
step "plan clean after Git install" 0 "${run[@]}" plan
echo "// upstream change" >>"$git_origin/index.js"
commit_all "$git_origin" upstream
step "source sync fast-forwards the clone" 0 "${run[@]}" source sync --profile web --as "$git_alias" --ref main
step "lock follows the pulled commit" 0 json_true "$envctl/lock.json" "v.profiles.web.plugins['$git_alias']?.source?.commit === '$(git -C "$git_origin" rev-parse HEAD)'"
step "plan sees the pulled commit as an update" 2 "${run[@]}" plan
step "apply Git update" 0 "${run[@]}" apply --yes
step "plan clean after Git update" 0 "${run[@]}" plan

# 10. Overlay: a per-machine plugin lives only in the overlay and leaves with it.
mkdir -p "$envctl/overlays"
printf 'apiVersion: dshenv-overlay/v1\nprofiles: {}\n' >"$envctl/overlays/mine.yaml"
step "overlay use" 0 "${run[@]}" overlay use mine
step "declare a plugin in the overlay" 0 bash -c 'cd "$1" && "${@:2}" new agent e2e-overlay -p web --layer overlay' _ "$work" "${run[@]}"
step "overlay file holds the plugin" 0 grep -q e2e-overlay "$envctl/overlays/mine.yaml"
step "base manifest does not" 1 grep -q e2e-overlay "$envctl/manifest.yaml"
step "overlay show" 0 "${run[@]}" overlay show
step "apply overlay install" 0 "${run[@]}" apply --yes
step "plan clean with the overlay" 0 "${run[@]}" plan
step "plan without the overlay wants it gone" 2 "${run[@]}" --no-overlay plan
step "overlay use --none" 0 "${run[@]}" overlay use --none
step "apply removes the overlay plugin" 0 "${run[@]}" apply --yes
step "plan clean without the overlay" 0 "${run[@]}" plan
# pnpm leaves the link: symlink in node_modules, so check what the profile declares and composes.
step "profile no longer declares the overlay plugin" 0 json_true "$DSH_HOME/profiles/web/package.json" "!v.dependencies?.['e2e-overlay'] && !v.dsh.profile.bundles.includes('e2e-overlay')"

# 11. Purge moves an owned plugin's clone into trash; gc empties expired trash.
step "purge dry-run" 2 "${run[@]}" purge "$git_alias" --profile web --dry-run
step "purge" 0 "${run[@]}" purge "$git_alias" --profile web --yes
step "clone moved out of envctl/sources" 1 test -e "$envctl/sources/web/$git_pkg"
step "declare remove of the purged plugin" 0 "${run[@]}" remove "$git_alias" --profile web
step "apply remove of the purged plugin" 0 "${run[@]}" apply --yes
step "plan clean after purge" 0 "${run[@]}" plan
step "gc dry-run" 2 "${run[@]}" gc --older-than 0 --dry-run
step "gc" 0 "${run[@]}" gc --older-than 0 --yes
step "trash emptied" 0 test -z "$(ls -A "$envctl/trash" 2>/dev/null)"

# 12. Profile patches: settings DSH wrote into cordis.patch.yml are pulled into the manifest, local paths into an overlay.
patch_file="$DSH_HOME/profiles/web/cordis.patch.yml"
mkdir -p "$work/skills"
# DSH turns a fresh profile's `[]` into a block sequence before it appends an entry.
sed -i '/^\[\]$/d' "$patch_file"
cat >>"$patch_file" <<EOF
- id: locale
  name: "@deepseek-ai/dsh-client-locale"
  config:
    preference: zh
- id: skill-filesystem
  config:
    customSkillDirs:
      - $work/skills
EOF
step "plan reports the entries DSH wrote" 0 bash -c '"$@" plan | grep -q "? \[web\] locale, skill-filesystem"' _ "${run[@]}"
step "plan reports the loose skill" 0 bash -c '"$@" plan | grep -q "? e2e-loose"' _ "${run[@]}"
step "pull dry-run" 2 "${run[@]}" pull --dry-run
step "pull previews without --yes" 2 "${run[@]}" pull
step "pull" 0 "${run[@]}" pull --yes
step "manifest declares the shared entry" 0 grep -q "preference: zh" "$envctl/manifest.yaml"
step "local overlay holds the machine-local entry" 0 grep -q "$work/skills" "$envctl/overlays/local.yaml"
step "envctl/skills holds the loose skill" 0 test -f "$envctl/skills/e2e-loose/SKILL.md"
step "plan clean after pull" 0 "${run[@]}" plan
step "dsh composes the pulled settings" 0 bash -c '"$DSH_CLI" --profile web --dump-config | grep -q "$1"' _ "$work/skills"
sed -i 's/preference: zh/preference: en/' "$patch_file"
step "plan sees the edit made in DSH" 2 bash -c 'out="$("$@" plan)"; code=$?; grep -q "edited in DSH" <<<"$out" || exit 99; exit "$code"' _ "${run[@]}"
step "pull the DSH edit" 0 "${run[@]}" pull --yes
step "manifest follows the DSH edit" 0 grep -q "preference: en" "$envctl/manifest.yaml"
step "plan clean after pulling the edit" 0 "${run[@]}" plan
sed -i 's/preference: en/preference: fr/' "$patch_file"
step "apply overwrites an edit made in DSH" 0 "${run[@]}" apply --yes
step "patch file back to the manifest" 0 grep -q "preference: en" "$patch_file"
step "plan clean after overwrite" 0 "${run[@]}" plan
echo "manifest edit" >>"$envctl/skills/e2e-loose/SKILL.md"
step "plan sees the skill changed in the manifest" 2 "${run[@]}" plan
step "apply copies the skill into DSH" 0 "${run[@]}" apply --yes
step "DSH has the manifest's skill" 0 grep -q "manifest edit" "$DSH_HOME/skills/e2e-loose/SKILL.md"
echo "dsh edit" >>"$DSH_HOME/skills/e2e-loose/SKILL.md"
step "pull the skill edited in DSH" 0 "${run[@]}" pull --yes
step "envctl/skills follows DSH" 0 grep -q "dsh edit" "$envctl/skills/e2e-loose/SKILL.md"
step "plan clean after the skill round trip" 0 "${run[@]}" plan

# 13. Team remote, in a fresh DSH_HOME: subscribe, apply, follow a team change, refuse local edits and rewrites.
export DSH_HOME="$work/team-home"
envctl="$DSH_HOME/envctl"
team="$work/team"
git init -q --bare --initial-branch=main "$team.git"
git init -q --initial-branch=main "$team"
mkdir -p "$team/envctl/skills/team-skill"
printf -- '---\nname: team-skill\ndescription: Shared by the team.\n---\n' >"$team/envctl/skills/team-skill/SKILL.md"
team_manifest() {
  printf 'apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n      teams:\n        package: "%s"\n        source: { type: npm, version: "%s" }\n%b' "$pkg" "$pkg_version" "$1" >"$team/envctl/manifest.yaml"
}
team_manifest ""
commit_all "$team" initial
git -C "$team" push -q "file://$team.git" HEAD:refs/heads/main
step "remote add refuses a URL with credentials" 3 "${run[@]}" remote add "https://user:secret@example.invalid/team.git"
step "remote add previews" 2 "${run[@]}" remote add "file://$team.git"
step "remote add --yes" 0 "${run[@]}" remote add "file://$team.git" --yes
step "remote show" 0 "${run[@]}" remote show
step "plan shows the team plugin" 2 "${run[@]}" plan
step "apply team plugin" 0 "${run[@]}" apply --yes
step "plan clean after team apply" 0 "${run[@]}" plan
step "profile has the team plugin" 0 test "$(installed_version "$pkg")" = "$pkg_version"
step "DSH has the team skill" 0 test -f "$DSH_HOME/skills/team-skill/SKILL.md"
team_manifest '        enabled: false\n'
commit_all "$team" "disable teams"
git -C "$team" push -q "file://$team.git" HEAD:refs/heads/main
step "remote sync previews the team change" 2 "${run[@]}" remote sync
step "remote sync --yes" 0 "${run[@]}" remote sync --yes
step "plan shows the disable" 2 "${run[@]}" plan
step "apply team change" 0 "${run[@]}" apply --yes
step "plan clean after sync" 0 "${run[@]}" plan
step "sync up to date" 0 "${run[@]}" sync
echo "# local edit" >>"$envctl/manifest.yaml"
step "sync refuses local edits to remote files" 3 "${run[@]}" sync
step "sync --discard-local-changes" 0 "${run[@]}" sync --discard-local-changes --yes
git -C "$team" -c user.name=e2e -c user.email=e2e@example.invalid -c commit.gpgsign=false commit -q --amend -m rewritten
git -C "$team" push -q -f "file://$team.git" HEAD:refs/heads/main
step "sync refuses rewritten history" 3 "${run[@]}" sync

# 14. An external Git plugin that is not a DSH bundle, in a fresh DSH_HOME: DSH skips such a package in the
# bundle list, so dshenv mounts it through an insert row, in the same apply that installs it.
export DSH_HOME="$work/ext-home"
envctl="$DSH_HOME/envctl"
ext_url="${E2E_EXT_PLUGIN_URL:-https://github.com/Tieboyh/dsh-session-search.git}"
# A pinned commit keeps an upstream change from failing this run; the repository has no tags to clone instead.
ext_commit="${E2E_EXT_PLUGIN_COMMIT:-82990a0e980418cddb9f6f026150cd6831c621ac}"
ext_pkg="${E2E_EXT_PLUGIN:-@dsh-external/dsh-session-search}"
ext_origin="$work/ext-origin"
step "fetch the external plugin at its pinned commit" 0 bash -c 'git clone -q "$1" "$3" && git -C "$3" checkout -q -B main "$2"' _ "$ext_url" "$ext_commit" "$ext_origin"
step "init a fresh home" 0 "${run[@]}" init
step "source clone the external plugin" 0 "${run[@]}" source clone "file://$ext_origin" --profile web
ext_alias="$(alias_of "$ext_pkg")"
step "manifest declares an alias for $ext_pkg" 0 test -n "$ext_alias"
step "apply installs and mounts it in one run" 0 "${run[@]}" apply --yes
step "plan clean after the external install" 0 "${run[@]}" plan
step "not in the bundle list" 0 json_true "$DSH_HOME/profiles/web/package.json" "!v.dsh.profile.bundles.includes('$ext_pkg')"
step "mounted in cordis.patch.yml" 0 grep -q "plugin=@mount:$ext_alias" "$DSH_HOME/profiles/web/cordis.patch.yml"
step "DSH composes the mounted row" 0 bash -c '"$1" --profile web --dump-config 2>/dev/null | grep -qF "$2"' _ "$DSH_CLI" "$ext_pkg"
start_web "$work/ext-web.log"
step "dsh web starts for the external plugin" 0 test -n "$url"
if [ -n "$url" ]; then
  step "runtime reports the external plugin loaded" 0 runtime_ok
  step "disable the external plugin" 0 "${run[@]}" disable "$ext_alias" --profile web
  step "apply --verify sees the disable take effect" 0 env DSHENV_DSH_URL="$url" "${run[@]}" apply --yes --verify
  step "unmounted from cordis.patch.yml" 1 grep -q "plugin=@mount:$ext_alias" "$DSH_HOME/profiles/web/cordis.patch.yml"
  step "runtime reports it unloaded" 0 runtime_ok
  step "enable it again" 0 "${run[@]}" enable "$ext_alias" --profile web
  step "apply --verify sees the plugin load again" 0 env DSHENV_DSH_URL="$url" "${run[@]}" apply --yes --verify
  step "runtime reports it loaded again" 0 runtime_ok
fi
stop_web

exit "$failed"
