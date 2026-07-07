import * as vscode from 'vscode';

export function registerCompletionProvider(context: vscode.ExtensionContext) {
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    const provider: vscode.InlineCompletionItemProvider = {
        async provideInlineCompletionItems(document, position, _ctx, token) {
            const config = vscode.workspace.getConfiguration('devpilot');

            if (!config.get<boolean>('enableInlineCompletions')) return;

            const ollamaUrl   = config.get<string>('ollamaUrl') ?? 'http://localhost:11434';
            const model       = config.get<string>('model') ?? 'qwen2.5-coder:7b';
            const debounceMs  = config.get<number>('completionDebounceMs') ?? 500;
            const maxLines    = config.get<number>('maxContextLines') ?? 80;

            // ── Debounce ──────────────────────────────────────────────────────
            await new Promise<void>((resolve, reject) => {
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(resolve, debounceMs);
                token.onCancellationRequested(reject);
            }).catch(() => undefined);

            if (token.isCancellationRequested) return;

            // ── Build prefix context ──────────────────────────────────────────
            const startLine = Math.max(0, position.line - maxLines);
            const prefix    = document.getText(new vscode.Range(startLine, 0, position.line, position.character));

            // Don't trigger on blank lines or very short prefixes
            if (prefix.trim().length < 3) return;

            const prompt =
                `You are a code completion engine for ${document.languageId}. ` +
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
                            temperature: 0.1,   // low temp = more deterministic completions
                            stop: ['\n\n\n', '// ---', '/* ---']
                        }
                    }),
                    signal: AbortSignal.timeout(10_000)
                });

                if (token.isCancellationRequested) return;
                if (!response.ok) return;

                const data = await response.json() as { response?: string };
                let completion = (data.response ?? '').trimEnd();

                // Strip any markdown fences the model sneaks in
                completion = completion.replace(/^```[\w]*\r?\n?/, '').replace(/```\s*$/, '').trimEnd();

                if (!completion.trim()) return;

                return [new vscode.InlineCompletionItem(
                    completion,
                    new vscode.Range(position, position)
                )];
            } catch {
                // Silently swallow errors — completions are best-effort
                return;
            }
        }
    };

    context.subscriptions.push(
        vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider)
    );
}
