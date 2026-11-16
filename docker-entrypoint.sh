#!/bin/sh
# 以 root 起再降到 app：平台挂载的数据卷（Railway、docker 命名卷首次创建）属主是 root，
# 直接以 app 起会连 app.db 和 logs 都建不出来。修完属主立刻降权，进程本身不以 root 跑。
set -e

if [ "$(id -u)" = "0" ]; then
  data_dir="${DATA_DIR:-/app/data}"
  mkdir -p "$data_dir"
  chown -R app:app "$data_dir"
  exec setpriv --reuid=app --regid=app --init-groups "$@"
fi

exec "$@"
