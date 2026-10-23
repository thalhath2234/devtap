#!/usr/bin/env bash
# Sends a mix of sample traffic through devtap (default proxy port 3689).
P=${1:-http://localhost:3689}
curl -s -o /dev/null --compressed "$P/api/users?page=2&sort=name"
curl -s -o /dev/null -X POST -H 'content-type: application/json' -H 'authorization: Bearer test-token' -H 'cookie: session=abc123; theme=dark' \
  -d '{"name":"Grace Hopper","roles":["admin","dev"],"meta":{"team":"navy","tags":[1,2,3]}}' "$P/api/users"
curl -s -o /dev/null -X POST -d 'not json' "$P/api/users"
curl -s -o /dev/null "$P/api/crash"
curl -s -o /dev/null "$P/api/slow"
curl -s -o /dev/null "$P/nope"
curl -s -o /dev/null "$P/events"
curl -s -o /dev/null "$P/"
node -e '
const ws = new WebSocket(process.argv[1].replace(/^http/, "ws") + "/ws?room=1");
ws.onopen = () => { ws.send(JSON.stringify({ hello: "world", n: 1 })); ws.send(JSON.stringify({ type: "chat", text: "second" })); setTimeout(() => ws.close(1000, "bye"), 300); };
ws.onclose = () => process.exit(0);
' "$P"
