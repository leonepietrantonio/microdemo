#!/bin/zsh
cd -- "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
codex_bin=$(command -v codex)
if [[ -z "$codex_bin" && -x '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex' ]]; then
  codex_bin='/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
fi
if [[ -z "$codex_bin" ]]; then
  print 'Install Codex CLI or set its path in config.json. See README.md.'
  read '?Press Return to close.'
  exit 1
fi
"$codex_bin" mcp add rainfrog --url https://mcp.rainfrog.ai/mcp
print 'If Rainfrog is already connected, the connection check in the dashboard is sufficient.'
read '?Press Return to close.'
