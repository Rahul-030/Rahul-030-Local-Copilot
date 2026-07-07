"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerCompletionProvider = registerCompletionProvider;
const vscode = __importStar(require("vscode"));
function registerCompletionProvider(context) {
    let debounceTimer;
    const provider = {
        async provideInlineCompletionItems(document, position, _ctx, token) {
            const config = vscode.workspace.getConfiguration('devpilot');
            if (!config.get('enableInlineCompletions'))
                return;
            const ollamaUrl = config.get('ollamaUrl') ?? 'http://localhost:11434';
            const model = config.get('model') ?? 'qwen2.5-coder:7b';
            const debounceMs = config.get('completionDebounceMs') ?? 500;
            const maxLines = config.get('maxContextLines') ?? 80;
            // ── Debounce ──────────────────────────────────────────────────────
            await new Promise((resolve, reject) => {
                if (debounceTimer)
                    clearTimeout(debounceTimer);
                debounceTimer = setTimeout(resolve, debounceMs);
                token.onCancellationRequested(reject);
            }).catch(() => undefined);
            if (token.isCancellationRequested)
                return;
            // ── Build prefix context ──────────────────────────────────────────
            const startLine = Math.max(0, position.line - maxLines);
            const prefix = document.getText(new vscode.Range(startLine, 0, position.line, position.character));
            // Don't trigger on blank lines or very short prefixes
            if (prefix.trim().length < 3)
                return;
            const prompt = `You are a code completion engine for ${document.languageId}. ` +
                `Complete the code at the cursor. ` +
                `Rules: return ONLY the raw code to insert — no explanations, no markdown fences, ` +
                `no repeating text that is already written.\n\n` +
                prefix;
            try {
                const response = await fetch(`${ollamaUrl}/api/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model,
                        prompt,
                        stream: false,
                        options: {
                            num_predict: 100,
                            temperature: 0.1, // low temp = more deterministic completions
                            stop: ['\n\n\n', '// ---', '/* ---']
                        }
                    }),
                    signal: AbortSignal.timeout(10000)
                });
                if (token.isCancellationRequested)
                    return;
                if (!response.ok)
                    return;
                const data = await response.json();
                let completion = (data.response ?? '').trimEnd();
                // Strip any markdown fences the model sneaks in
                completion = completion.replace(/^```[\w]*\r?\n?/, '').replace(/```\s*$/, '').trimEnd();
                if (!completion.trim())
                    return;
                return [new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))];
            }
            catch {
                // Silently swallow errors — completions are best-effort
                return;
            }
        }
    };
    context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider));
}
//# sourceMappingURL=completionProvider.js.map