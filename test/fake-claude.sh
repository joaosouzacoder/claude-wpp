#!/usr/bin/env bash
if [ -n "$FAKE_ARGS_FILE" ]; then
  printf '%s\n' "$@" > "$FAKE_ARGS_FILE"
fi
case "$FAKE_MODE" in
  slow)
    sleep 0.4
    echo '{"result":"demorei","session_id":"sid-slow","is_error":false,"type":"result"}'
    ;;
  hang)
    sleep 30
    ;;
  garbage)
    echo 'isso nao e json'
    ;;
  claude_error)
    echo '{"result":"deu ruim","session_id":"sid-err","is_error":true,"type":"result"}'
    ;;
  crash)
    echo 'boom' >&2
    exit 3
    ;;
  *)
    echo '{"result":"pronto","session_id":"sid-ok","is_error":false,"type":"result"}'
    ;;
esac
