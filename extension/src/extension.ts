import * as vscode from 'vscode';
import { api } from './api';
import { ChatViewProvider } from './chatView';
import { ResultPanel } from './resultPanel';
import { registerCompletionProvider } from './completionProvider';
import { registerCodeActions } from './codeActions';

export function activate(ctx: vscode.ExtensionContext) {

    // ── Inline completions (ghost text) ───────────────────────────────────
    registerCompletionProvider(ctx);

    // ── Quick-Fix lightbulb ───────────────────────────────────────────────
    registerCodeActions(ctx);

    // ── Chat panel ────────────────────────────────────────────────────────
    const chatProvider = new ChatViewProvider(ctx);
    ctx.subscriptions.push(
        vscode.window.registerWebviewViewProvider('devpilot.chatView', chatProvider)
    );

    // ── Helpers ───────────────────────────────────────────────────────────
    function getCode(): { code: string; editor: vscode.TextEditor; range: vscode.Range } | undefined {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showErrorMessage('No active editor.'); return; }
        const sel = editor.selection;
        const range = sel.isEmpty
            ? new vscode.Range(
                new vscode.Position(0, 0),
                editor.document.positionAt(editor.document.getText().length)
            )
            : sel;
        const code = editor.document.getText(range);
        if (!code.trim()) { vscode.window.showErrorMessage('Nothing selected.'); return; }
        return { code, editor, range };
    }

    async function replaceRange(editor: vscode.TextEditor, range: vscode.Range, newCode: string) {
        await editor.edit(eb => eb.replace(range, newCode));
    }

    async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
        return vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `DevPilot: ${label}…`, cancellable: false },
            async () => {
                try { return await fn(); }
                catch (e: any) {
                    vscode.window.showErrorMessage(e.message ?? String(e));
                    return undefined;
                }
            }
        );
    }

    // ── Commands (IDs must exactly match package.json) ────────────────────

    // devpilot.explainCode
    ctx.subscriptions.push(vscode.commands.registerCommand('devpilot.explainCode', async () => {
        const c = getCode(); if (!c) return;
        const res = await run('Explaining', () => api.explainCode(c.code));
        if (res) ResultPanel.show('Explanation', res.Explanation, ctx.extensionUri);
    }));

    // devpilot.explain  (right-click menu alias)
    ctx.subscriptions.push(vscode.commands.registerCommand('devpilot.explain', async () => {
        vscode.commands.executeCommand('devpilot.explainCode');
    }));

    // devpilot.fixSnippet
    ctx.subscriptions.push(vscode.commands.registerCommand('devpilot.fixSnippet', async () => {
        const c = getCode(); if (!c) return;
        const error = await vscode.window.showInputBox({ prompt: 'Describe the error (optional)' }) ?? '';
        const res = await run('Fixing', () => api.fixSnippet(c.code, error));
        if (!res) return;
        const pick = await vscode.window.showQuickPick(['Apply fix', 'Show diff', 'Cancel'], { title: 'DevPilot Fix' });
        if (pick === 'Apply fix') {
            await replaceRange(c.editor, c.range, res.FixedCode);
        } else if (pick === 'Show diff') {
            ResultPanel.showDiff('Fix Diff', c.code, res.FixedCode, ctx.extensionUri);
        }
    }));

    // devpilot.fix (right-click menu alias)
    ctx.subscriptions.push(vscode.commands.registerCommand('devpilot.fix', async () => {
        vscode.commands.executeCommand('devpilot.fixSnippet');
    }));

    // devpilot.reviewCode
    ctx.subscriptions.push(vscode.commands.registerCommand('devpilot.reviewCode', async () => {
        const c = getCode(); if (!c) return;
        const res = await run('Reviewing', () => api.reviewCode(c.code));
        if (res) ResultPanel.show('Code Review', res.Review, ctx.extensionUri);
    }));

    // devpilot.generateTests
    ctx.subscriptions.push(vscode.commands.registerCommand('devpilot.generateTests', async () => {
        const c = getCode(); if (!c) return;
        const res = await run('Generating tests', () => api.generateTests(c.code));
        if (!res) return;
        const doc = await vscode.workspace.openTextDocument({ content: res.Tests, language: c.editor.document.languageId });
        vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    }));

    // devpilot.generateDocs
    ctx.subscriptions.push(vscode.commands.registerCommand('devpilot.generateDocs', async () => {
        const c = getCode(); if (!c) return;
        const res = await run('Generating docs', () => api.generateDocs(c.code));
        if (!res) return;
        const editor = c.editor;
        const line = editor.selection.start.line;
        await editor.edit(eb => eb.insert(new vscode.Position(line, 0), res.Documentation + '\n'));
    }));

    // devpilot.refactor
    ctx.subscriptions.push(vscode.commands.registerCommand('devpilot.refactor', async () => {
        const c = getCode(); if (!c) return;
        const goal = await vscode.window.showInputBox({ prompt: 'Refactor goal (optional)', placeHolder: 'e.g. reduce nesting, use LINQ' }) ?? '';
        const res = await run('Refactoring', () => api.refactor(c.code, goal || undefined));
        if (!res) return;
        ResultPanel.showDiff('Refactor', res.OriginalCode, res.RefactoredCode, ctx.extensionUri, res.Summary);
    }));

    // devpilot.completeCode
    ctx.subscriptions.push(vscode.commands.registerCommand('devpilot.completeCode', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const pos = editor.selection.active;
        const prefix = editor.document.getText(new vscode.Range(new vscode.Position(0, 0), pos));
        const suffix = editor.document.getText(new vscode.Range(pos, editor.document.positionAt(editor.document.getText().length)));
        const res = await run('Completing', () => api.completeCode(prefix, suffix));
        if (!res) return;
        await editor.edit(eb => eb.insert(pos, res.Completion));
    }));

    // devpilot.renameSymbol
    ctx.subscriptions.push(vscode.commands.registerCommand('devpilot.renameSymbol', async () => {
        const c = getCode(); if (!c) return;
        const symbol = c.editor.document.getText(c.editor.selection);
        if (!symbol.trim()) { vscode.window.showErrorMessage('Select the symbol to rename.'); return; }
        const kind = await vscode.window.showQuickPick(['variable', 'method', 'class', 'parameter'], { title: 'Symbol kind' });
        const res = await run('Suggesting names', () => api.renameSymbol(symbol, kind, c.code));
        if (res) ResultPanel.show(`Rename: ${symbol}`, res.Suggestions, ctx.extensionUri);
    }));

    // devpilot.fixBuildErrors
    ctx.subscriptions.push(vscode.commands.registerCommand('devpilot.fixBuildErrors', async () => {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders?.length) { vscode.window.showErrorMessage('No workspace folder open.'); return; }
        const projectPath = folders[0].uri.fsPath;
        const res = await run('Building & fixing', () => api.fixBuildErrors(projectPath));
        if (res) {
            if (res.Success) {
                vscode.window.showInformationMessage('DevPilot: Build succeeded — no errors!');
            } else {
                ResultPanel.show('Build Fix Analysis', res.Analysis, ctx.extensionUri);
            }
        }
    }));

    // devpilot.openChat
    ctx.subscriptions.push(vscode.commands.registerCommand('devpilot.openChat', () => {
        chatProvider.openPanel();
    }));

    // ── Backend health check ──────────────────────────────────────────────
    api.health().catch(() =>
        vscode.window.showWarningMessage(
            'DevPilot: Backend not reachable. Run ./start-backend.sh first.',
            'OK'
        )
    );
}

export function deactivate() {}
