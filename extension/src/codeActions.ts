import * as vscode from 'vscode';

type Json = Record<string, unknown>;

interface BackendResponse extends Json {
    FixedCode?: string;
}

async function callBackend(endpoint: string, body: Json): Promise<BackendResponse> {
    const url = vscode.workspace.getConfiguration('devpilot')
        .get<string>('backendUrl') ?? 'http://localhost:5050';

    const res = await fetch(`${url}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000)
    });

    if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`Backend ${endpoint} failed (${res.status}): ${text}`);
    }

    return (await res.json()) as BackendResponse;
}

export function registerCodeActions(context: vscode.ExtensionContext) {

    // Quick Fix lightbulb
    const provider: vscode.CodeActionProvider = {
        provideCodeActions(_doc, _range, ctx) {
            return ctx.diagnostics.map(diag => {
                const short = diag.message.length > 60
                    ? diag.message.substring(0, 60) + '...'
                    : diag.message;
                const action = new vscode.CodeAction(
                    `DevPilot: Fix "${short}"`,
                    vscode.CodeActionKind.QuickFix
                );
                action.command = {
                    command: 'devpilot.fixDiagnostic',
                    title: 'Fix with DevPilot',
                    arguments: [_doc, diag]
                };
                action.diagnostics = [diag];
                action.isPreferred = true;
                return action;
            });
        }
    };

    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider(
            { pattern: '**' },
            provider,
            { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
        )
    );

    // Fix diagnostic command (lightbulb handler)
    context.subscriptions.push(
        vscode.commands.registerCommand(
            'devpilot.fixDiagnostic',
            async (document: vscode.TextDocument, diagnostic: vscode.Diagnostic) => {
                const line = diagnostic.range.start.line;
                const start = Math.max(0, line - 10);
                const end = Math.min(document.lineCount - 1, line + 10);
                const range = new vscode.Range(start, 0, end, document.lineAt(end).text.length);
                const code = document.getText(range);

                await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: 'DevPilot: fixing...', cancellable: false },
                    async () => {
                        try {
                            const result = await callBackend('/fix-snippet', {
                                Code: code,
                                Error: diagnostic.message
                            });
                            const fixed = result.FixedCode;
                            if (!fixed) { vscode.window.showWarningMessage('DevPilot: No fix returned.'); return; }
                            const edit = new vscode.WorkspaceEdit();
                            edit.replace(document.uri, range, fixed);
                            await vscode.workspace.applyEdit(edit);
                            vscode.window.showInformationMessage('DevPilot: Fix applied ✓');
                        } catch (e: any) {
                            vscode.window.showErrorMessage(`DevPilot: ${e.message}. Is the backend running?`);
                        }
                    }
                );
            }
        )
    );
}
