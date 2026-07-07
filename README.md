# Local AI Copilot

A self-hosted AI coding assistant for Visual Studio Code that runs entirely on your local machine without relying on cloud-based AI services.

## Overview

Local AI Copilot is designed to provide code assistance while keeping all prompts and source code local. The extension uses a JavaScript-based VS Code frontend and a C# backend powered by Microsoft Semantic Kernel to orchestrate interactions with a locally hosted large language model through Ollama.

## Tech Stack

### Frontend
- JavaScript
- Visual Studio Code Extension API

### Backend
- C#
- .NET
- Microsoft Semantic Kernel

### AI Stack
- Ollama
- DeepSeek-Coder
- Local LLM Inference

## Features

- AI-powered code explanation
- Bug detection
- Code generation
- Context-aware coding assistance
- Fully offline execution
- No API keys required
- No token limits
- Privacy-focused local inference

## Architecture

```
VS Code Extension (JavaScript)
            │
            ▼
      C#/.NET Backend
            │
            ▼
Microsoft Semantic Kernel
            │
            ▼
         Ollama
            │
            ▼
     DeepSeek-Coder Model
```

## Workflow

1. User submits a prompt from VS Code.
2. The JavaScript extension sends the request to the C# backend.
3. Semantic Kernel prepares and orchestrates the prompt.
4. Ollama invokes the locally hosted DeepSeek-Coder model.
5. The generated response is returned to the VS Code extension.

## Benefits

- Runs completely offline
- No cloud dependency
- Faster local development workflow
- Secure handling of source code
- Easily extensible architecture

## Future Improvements

- Chat history
- Multi-file context support
- Code refactoring suggestions
- Unit test generation
- Streaming responses
- Support for additional local LLMs

## Author

**Rahul Semwal**
