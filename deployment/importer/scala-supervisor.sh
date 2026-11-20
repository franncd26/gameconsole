#!/bin/sh
set -u
export LC_ALL=C
# Only the Java child restarts. Go and Node are different, untouched services.
active=/tmp/importer-scala-active
good=/tmp/importer-scala-good
mkdir -p "$active" "$good"
cp /app/profiles/*.json "$good/"
cp "$good/"*.json "$active/"
child=''
stop_child() {
  rm -f /reload-status/loaded
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null || true
    n=0
    while kill -0 "$child" 2>/dev/null && [ "$n" -lt 25 ]; do sleep 0.2; n=$((n+1)); done
    kill -KILL "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
}
trap 'stop_child; exit 0' TERM INT
start_child() {
  SCALA_PROFILES_DIR="$active" java -XX:MaxRAMPercentage=70.0 -cp '/app/app.jar:/app/lib/*' gamestats.Main &
  child=$!
}
ready() {
  n=0
  while [ "$n" -lt 25 ]; do
    kill -0 "$child" 2>/dev/null || return 1
    wget -q -O /dev/null -T 1 "http://127.0.0.1:${SCALA_PORT:-9000}/health" && return 0
    sleep 1; n=$((n+1))
  done
  return 1
}
fingerprint() { (cd "$1" && sha256sum *.json 2>/dev/null) | sha256sum | cut -d ' ' -f 1; }
acknowledge() { fingerprint "$active" > /reload-status/loaded.tmp; mv /reload-status/loaded.tmp /reload-status/loaded; }
start_child
ready || { stop_child; exit 1; }
acknowledge
seen=''
while :; do
  current=$(fingerprint /shared-profiles)
  if [ "$current" != "$seen" ]; then
    seen=$current
    stop_child
    rm -f "$active/"*.json
    cp /shared-profiles/*.json "$active/" 2>/dev/null || true
    start_child
    if ready; then
      rm -f "$good/"*.json; cp "$active/"*.json "$good/"
      echo 'SCALA_PROFILE_SET_READY'
      acknowledge
    else
      echo 'SCALA_PROFILE_SET_REJECTED: restoring last healthy set' >&2
      stop_child; rm -f "$active/"*.json; cp "$good/"*.json "$active/"
      start_child; ready || { stop_child; exit 1; }
      acknowledge
    fi
  fi
  if ! kill -0 "$child" 2>/dev/null; then
    stop_child; rm -f "$active/"*.json; cp "$good/"*.json "$active/"
    start_child; ready || { stop_child; exit 1; }
    acknowledge
  fi
  sleep 1
done
