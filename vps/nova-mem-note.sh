#!/bin/sh
# One line a minute (nova-mem.timer): time (UTC), Nova Bot's service memory with its cache (MB), the
# biggest workerd's own memory (MB) and the load; the last ~3 days kept, in /var/lib/nova/mem.log
m=$(( $(cat /sys/fs/cgroup/system.slice/nova.service/memory.current 2>/dev/null || echo 0) / 1048576 ))
w=$(ps -C workerd -o rss= | sort -n | tail -1)
echo "$(date -u +%FT%TZ) service=${m}MB workerd=$(( ${w:-0} / 1024 ))MB load=$(cut -d' ' -f1 /proc/loadavg)" >> /var/lib/nova/mem.log
tail -n 4500 /var/lib/nova/mem.log > /var/lib/nova/mem.log.tmp && mv /var/lib/nova/mem.log.tmp /var/lib/nova/mem.log
