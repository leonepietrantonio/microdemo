#!/bin/zsh
cd -- "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null; then
  print 'Node.js 22 or later is required. Install it from https://nodejs.org and reopen this file.'
  read '?Press Return to close.'
  exit 1
fi
if [[ ! -d node_modules/playwright ]]; then
  if ! npm ci; then
    print 'Could not install the Instagram browser dependency. Check your internet connection and retry.'
    read '?Press Return to close.'
    exit 1
  fi
fi
node server.mjs &
microdemo_pid=$!
for microdemo_attempt in {1..40}; do
  if curl --silent --fail 'http://127.0.0.1:4318/api/state' >/dev/null; then
    open 'http://127.0.0.1:4318'
    break
  fi
  if ! kill -0 "$microdemo_pid" 2>/dev/null; then
    read '?Press Return to close.'
    exit 1
  fi
  sleep 0.25
done
wait "$microdemo_pid"
