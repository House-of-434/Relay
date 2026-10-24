#!/usr/bin/env bash
set -euo pipefail

log="${RELAY_RESOURCE_LOG:-/var/log/relay-resources.tsv}"

exec 9>>"$log"
flock -n 9 || exit 0

if [ ! -s "$log" ]; then
  printf 'timestamp\tload1\tload5\tload15\tmem_total_mb\tmem_used_mb\tmem_available_mb\tswap_used_mb\tdisk_used\tdisk_avail_kb\tcontainer\tcpu_pct\tmem_usage\tmem_pct\tpids\trestarts\toom\n' >> "$log"
fi

timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
read -r load1 load5 load15 _ < /proc/loadavg
read -r mem_total mem_used mem_available < <(free -m | awk '/^Mem:/ {print $2, $3, $7}')
swap_used=$(free -m | awk '/^Swap:/ {print $3}')
read -r disk_used disk_avail < <(df -P / | awk 'NR==2 {print $5, $4}')

if ! docker stats --no-stream --format '{{.Name}}	{{.CPUPerc}}	{{.MemUsage}}	{{.MemPerc}}	{{.PIDs}}' 2>/dev/null | while IFS=$'\t' read -r name cpu mem pct pids; do
  [ -n "$name" ] || continue
  read -r restarts oom < <(docker inspect -f '{{.RestartCount}} {{.State.OOMKilled}}' "$name" 2>/dev/null || printf '0 false')
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$timestamp" "$load1" "$load5" "$load15" "$mem_total" "$mem_used" "$mem_available" "$swap_used" \
    "$disk_used" "$disk_avail" "$name" "$cpu" "$mem" "$pct" "$pids" "$restarts" "$oom"
done >> "$log"; then
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\tdocker-unavailable\t\t\t\t\t\t\n' \
    "$timestamp" "$load1" "$load5" "$load15" "$mem_total" "$mem_used" "$mem_available" "$swap_used" "$disk_used" "$disk_avail" >> "$log"
fi
