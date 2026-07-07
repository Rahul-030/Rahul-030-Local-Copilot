#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/extension"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  DevPilot Extension Installer"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if ! command -v node &>/dev/null; then
  echo "❌ Node.js not found. Install from https://nodejs.org"
  exit 1
fi
echo "📦 Installing packages..."
npm install --silent
echo "🔨 Compiling..."
npm run compile
echo "📦 Packaging..."
rm -f *.vsix
npm run package 2>&1 | grep -v "^(node:"
VSIX=$(ls *.vsix 2>/dev/null | head -1)
if [ -z "$VSIX" ]; then echo "❌ Packaging failed"; exit 1; fi
CODE_CMD=""
for c in "code" "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"; do
  if command -v "$c" &>/dev/null || [ -f "$c" ]; then CODE_CMD="$c"; break; fi
done
if [ -n "$CODE_CMD" ]; then
  "$CODE_CMD" --install-extension "$SCRIPT_DIR/extension/$VSIX" --force
  echo "✅ Installed! Restart VS Code (Cmd+Q then reopen)"
else
  echo ""
  echo "Install manually:"
  echo "  Cmd+Shift+P → 'Install from VSIX' → select: $SCRIPT_DIR/extension/$VSIX"
  echo ""
  echo "(To fix: Cmd+Shift+P → 'Shell Command: Install code command in PATH')"
fi
