#!/usr/bin/env bash
# Spike: validate the `accept` core on stock git 2.39.
#  - pre-probe with `git merge-tree --write-tree TARGET SNAPCOMMIT` (auto-base)
#  - dirt-only  : materialize the merged tree, staged (no cherry-pick)
#  - commits    : cherry-pick base..RUNHEAD onto current branch (preserve author/msg)
#  - tail       : 3-way apply the dirt delta on top, staged (piped, no temp file in-repo)
#  - conflict   : probe says no -> REVIVE, operator repo left untouched
# Bookkeeping (.base/.sntree/.runhead) lives OUTSIDE each repo so it never dirties it.
set -u
PASS=0; FAIL=0
ok(){ if [ "$1" = "$2" ]; then echo "    ✓ $3"; PASS=$((PASS+1)); else echo "    ✗ $3 — got [$1] want [$2]"; FAIL=$((FAIL+1)); fi; }

L(){ for i in 01 02 03 04 05 06 07 08 09 10 11 12; do echo "L$i"; done; }

setup_repo(){
  local d=$1; rm -rf "$d"; mkdir -p "$d"; cd "$d"
  git init -q -b main
  git config user.name Operator; git config user.email op@ex
  L > f.txt; git add -A; git commit -qm base
  git rev-parse HEAD > "${d}.base"
}

make_run(){
  local d=$1 n=$2 dirt=$3; cd "$d"; local BASE; BASE=$(cat "${d}.base")
  git worktree add -q --detach "$d/.wt" "$BASE"
  ( cd "$d/.wt"
    if [ "$n" -ge 1 ]; then sed -i '' 's/^L02$/L02-RUN/' f.txt
      GIT_AUTHOR_NAME=Bot GIT_AUTHOR_EMAIL=bot@swarm git commit -qam "[run] edit L02"; fi
    if [ "$n" -ge 2 ]; then sed -i '' 's/^L04$/L04-RUN/' f.txt
      GIT_AUTHOR_NAME=Bot GIT_AUTHOR_EMAIL=bot@swarm git commit -qam "[run] edit L04"; fi
    if [ "$dirt" = 1 ]; then sed -i '' 's/^L06$/L06-DIRT/' f.txt; fi
    git add -A; git write-tree > "${d}.sntree"; git rev-parse HEAD > "${d}.runhead" )
  local SNTREE RUNHEAD SNAPC
  SNTREE=$(cat "${d}.sntree"); RUNHEAD=$(cat "${d}.runhead")
  SNAPC=$(git commit-tree "$SNTREE" -p "$RUNHEAD" -m "swarm-snap")
  git update-ref refs/swarm/snap/run "$SNAPC"
  [ "$n" -ge 1 ] && git update-ref refs/swarm/heads/run "$RUNHEAD"
  git worktree remove --force "$d/.wt"
}

move_target(){ local d=$1 line=$2; cd "$d"; sed -i '' "s/^$line\$/$line-USER/" f.txt; git commit -qam "user moves $line"; }

accept(){
  local d=$1; local meta=$d; cd "$d" || return 9
  local BASE TARGET RUNHEAD SNAPC RUNTREE SNAPTREE SAVED
  BASE=$(cat "${meta}.base"); TARGET=$(git rev-parse HEAD); SAVED=$TARGET
  RUNHEAD=$(git rev-parse --verify -q refs/swarm/heads/run || echo "$BASE")
  SNAPC=$(git rev-parse refs/swarm/snap/run)
  RUNTREE=$(git rev-parse "$RUNHEAD^{tree}"); SNAPTREE=$(git rev-parse "$SNAPC^{tree}")

  # PRE-PROBE — in-memory, no mutation.
  if ! git merge-tree --write-tree "$TARGET" "$SNAPC" >/dev/null 2>&1; then echo "REVIVE"; return 3; fi

  if [ "$RUNHEAD" = "$BASE" ]; then
    local MT; MT=$(git merge-tree --write-tree "$TARGET" "$SNAPC")
    git read-tree "$MT"; git checkout-index -a -f
    echo "OK replayed=0 tail=yes"; return 0
  fi

  if ! git cherry-pick "$BASE..$RUNHEAD" >/dev/null 2>&1; then
    git cherry-pick --abort 2>/dev/null; git reset --hard "$SAVED" >/dev/null 2>&1
    echo "REVIVE"; return 4
  fi
  local n; n=$(git rev-list --count "$SAVED..HEAD")
  if [ "$SNAPTREE" != "$RUNTREE" ]; then
    if ! git diff --full-index --binary "$RUNTREE" "$SNAPTREE" | git apply --3way --index >/dev/null 2>&1; then
      git reset --hard "$SAVED" >/dev/null 2>&1; echo "REVIVE"; return 5
    fi
    echo "OK replayed=$n tail=yes"
  else
    echo "OK replayed=$n tail=no"
  fi
}

R=$(mktemp -d)
clean(){ cd "$1"; git status --porcelain | wc -l | tr -d ' '; }

echo "A. dirt-only, target==base"
setup_repo "$R/a" >/dev/null; make_run "$R/a" 0 1 >/dev/null
ok "$(accept "$R/a")" "OK replayed=0 tail=yes" "result"
ok "$(cd "$R/a"; git rev-parse HEAD)" "$(cat "$R/a.base")" "branch NOT advanced (no commits)"
ok "$(cd "$R/a"; grep -c 'L06-DIRT' f.txt)" "1" "dirt in working tree"
ok "$(cd "$R/a"; git diff --cached --name-only)" "f.txt" "dirt is STAGED"

echo "B. dirt-only, target moved (non-conflict: user L11 vs dirt L06)"
setup_repo "$R/b" >/dev/null; make_run "$R/b" 0 1 >/dev/null; move_target "$R/b" L11 >/dev/null
ok "$(accept "$R/b")" "OK replayed=0 tail=yes" "result"
ok "$(cd "$R/b"; grep -c 'L06-DIRT' f.txt)" "1" "run dirt present"
ok "$(cd "$R/b"; grep -c 'L11-USER' f.txt)" "1" "user change preserved (3-way)"

echo "C. dirt-only, target moved CONFLICT (both touch L06)"
setup_repo "$R/c" >/dev/null; make_run "$R/c" 0 1 >/dev/null; move_target "$R/c" L06 >/dev/null
SAVED_C=$(cd "$R/c"; git rev-parse HEAD)
ok "$(accept "$R/c")" "REVIVE" "result"
ok "$(cd "$R/c"; git rev-parse HEAD)" "$SAVED_C" "HEAD untouched on revive"
ok "$(clean "$R/c")" "0" "working tree clean on revive"

echo "D. commits-only (2), target==base"
setup_repo "$R/d" >/dev/null; make_run "$R/d" 2 0 >/dev/null
ok "$(accept "$R/d")" "OK replayed=2 tail=no" "result"
ok "$(cd "$R/d"; grep -c 'L02-RUN' f.txt)" "1" "L02 commit landed"
ok "$(cd "$R/d"; grep -c 'L04-RUN' f.txt)" "1" "L04 commit landed"
ok "$(cd "$R/d"; git log -2 --format='%ae' | sort -u)" "bot@swarm" "author preserved (both replayed = bot)"
ok "$(clean "$R/d")" "0" "clean tree (no tail)"

echo "E. commits-only (2), target moved non-conflict (user L11)"
setup_repo "$R/e" >/dev/null; make_run "$R/e" 2 0 >/dev/null; move_target "$R/e" L11 >/dev/null
ok "$(accept "$R/e")" "OK replayed=2 tail=no" "result"
ok "$(cd "$R/e"; grep -c 'L02-RUN' f.txt)" "1" "run commit replayed onto moved target"
ok "$(cd "$R/e"; grep -c 'L11-USER' f.txt)" "1" "user move retained"
ok "$(cd "$R/e"; git log -1 --format='%ae')" "bot@swarm" "top replayed author = bot"

echo "F. commits(1)+dirt"
setup_repo "$R/f" >/dev/null; make_run "$R/f" 1 1 >/dev/null
ok "$(accept "$R/f")" "OK replayed=1 tail=yes" "result"
ok "$(cd "$R/f"; grep -c 'L02-RUN' f.txt)" "1" "commit landed (L02)"
ok "$(cd "$R/f"; grep -c 'L06-DIRT' f.txt)" "1" "tail dirt present (L06)"
ok "$(cd "$R/f"; git log -1 --format='%ae')" "bot@swarm" "replayed commit author = bot (tail not committed)"
ok "$(cd "$R/f"; git diff --cached --name-only)" "f.txt" "tail STAGED on top of replayed commit"

echo "G. commits(1), target moved CONFLICT (both touch L02)"
setup_repo "$R/g" >/dev/null; make_run "$R/g" 1 0 >/dev/null; move_target "$R/g" L02 >/dev/null
SAVED_G=$(cd "$R/g"; git rev-parse HEAD)
ok "$(accept "$R/g")" "REVIVE" "result"
ok "$(cd "$R/g"; git rev-parse HEAD)" "$SAVED_G" "HEAD untouched on revive"
ok "$(clean "$R/g")" "0" "working tree clean on revive"

echo ""
echo "=== $PASS passed, $FAIL failed ==="
rm -rf "$R" "$R"/*.base "$R"/*.sntree "$R"/*.runhead 2>/dev/null
exit $FAIL
