#!/usr/bin/env bash
#
# Chaos harness for the resilience demo.
#
# Kills a CockroachDB node while continuously reading agent memory, and prints
# what happened to availability and latency across the failure. This is the
# claim the whole project rests on: an agent whose memory goes offline does not
# degrade gracefully, it stops -- so the memory must not go offline.
#
# Runs against the LOCAL 3-node cluster. CockroachDB Cloud Basic is serverless
# and has no nodes to kill, which is exactly why the local cluster exists.
#
#   ./chaos/kill-node.sh [node] [seconds-down]
#
set -euo pipefail

NODE="${1:-recall-roach2-1}"
DOWN_FOR="${2:-15}"
API="${RECALL_API:-http://localhost:8787}"

probe() {
  curl -s -m 5 "$API/api/health" 2>/dev/null || echo '{"ok":false,"latencyMs":-1,"liveNodes":0,"totalNodes":0}'
}

fmt() {
  node -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      try{
        const j=JSON.parse(d);
        const state = j.ok ? "SERVED" : "FAILED";
        console.log(`  ${new Date().toLocaleTimeString().padEnd(12)} ${state.padEnd(7)} ${String(j.latencyMs).padStart(4)}ms   nodes ${j.liveNodes}/${j.totalNodes}`);
      }catch{ console.log("  probe failed"); }
    });'
}

echo "chaos: killing $NODE for ${DOWN_FOR}s while reading memory continuously"
echo
echo "  TIME         RESULT  LATENCY  NODES"
echo "  ----------------------------------------"

for _ in $(seq 1 3); do probe | fmt; sleep 1; done

echo "  --- docker kill $NODE ---"
docker kill "$NODE" >/dev/null

for _ in $(seq 1 "$DOWN_FOR"); do probe | fmt; sleep 1; done

echo "  --- docker start $NODE ---"
docker start "$NODE" >/dev/null

for _ in $(seq 1 8); do probe | fmt; sleep 1; done

echo
echo "If every row above says SERVED, the memory layer survived a node loss"
echo "without the agent noticing."
