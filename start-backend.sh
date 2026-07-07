#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/backend"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  DevPilot Backend"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if ! command -v dotnet &>/dev/null; then
  echo "❌ .NET SDK not found. Install from https://dotnet.microsoft.com/download/dotnet/8.0"
  exit 1
fi
if ! command -v ollama &>/dev/null; then
  echo "❌ Ollama not found. Install from https://ollama.com/download"
  exit 1
fi
if ! curl -s http://localhost:11434/api/tags &>/dev/null; then
  echo "🚀 Starting Ollama..."
  ollama serve &>/dev/null &
  sleep 3
fi
echo "✅ Ollama running"
echo "📦 Restoring packages..."
dotnet restore --verbosity quiet
echo "🚀 Starting backend on http://localhost:5050"
echo "   (keep this terminal open)"
echo ""
dotnet run
