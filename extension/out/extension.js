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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const api_1 = require("./api");
const chatView_1 = require("./chatView");
const resultPanel_1 = require("./resultPanel");
const completionProvider_1 = require("./completionProvider");
const codeActions_1 = require("./codeActions");
function activate(ctx) {
    // ── Inline completions (ghost text) ───────────────────────────────────
    (0, completionProvider_1.registerCompletionProvider)(ctx);
    // ── Quick-Fix lightbulb ───────────────────────────────────────────────
    (0, codeActions_1.registerCodeActions)(ctx);
    // ── Chat panel ────────────────────────────────────────────────────────
    const chatProvider = new chatView_1.ChatViewProvider(ctx);
    ctx.subscriptions.push(vscode.window.registerWebviewViewProvider('devpilot.chatView', chatProvider));
    // ── Helpers ───────────────────────────────────────────────────────────
    function getCode() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor.');
            return;
        }
        const sel = editor.selection;
        const range = sel.isEmpty
            ? new vscode.Range(new vscode.Position(0, 0), editor.document.positionAt(editor.document.getText().length))
            : sel;
        const code = editor.document.getText(range);
        if (!code.trim()) {
            vscode.window.showErrorMessage('Nothing selected.');
            return;
        }
        return { code, editor, range };
    }
    async function replaceRange(editor, range, newCode) {
        await editor.edit(eb => eb.replace(range, newCode));
    }
    async function run(label, fn) {
        return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `DevPilot: ${label}…`, cancellable: false }, async () => {
            try {
                return await fn();
            }
            catch (e) {
                vscode.window.showErrorMessage(e.message ?? String(e));
                return undefined;
            }
        });
    }
    // ── Commands (IDs must exactly match package.json) ────────────────────
    // devpilot.explainCode
    ctx.subscriptions.push(vscode.commands.registerCommand('devpilot.explainCode', async () => {
        const c = getCode();
        if (!c)
            return;
        const res = await run('Explaining', () => api_1.api.explainCode(c.code));
        if (res)
            resultPanel_1.ResultPanel.show('Explanation', res.Explanation, ctx.extensionUri);
    }));
    // devpilot.explain  (right-click menu alias)
    ctx.subscriptions.push(vscode.commands.registerCommand('devpilot.explain', async () => {
        vscode.commands.executeCommand('devpilot.explainCode');
    }));
    // devpilot.fixSnippet
    ctx.subscriptions.push(vscode.commands.registerCommand('devpilot.fixSnippet', async () => {
        const c = getCode();
        if (!c)
            return;
        const error = await vscode.window.showInputBox({ prompt: 'Describe the error (optional)' }) ?? '';
        const res = await run('Fixing', () => api_1.api.fixSnippet(c.code, error));
        if (!res)
            return;
        const pick = await vscode.window.showQuickPick(['Apply fix', 'Show diff', 'Cancel'], { title: 'DevPilot Fix' });
        if (pick === 'Apply fix') {
            await replaceRange(c.editor, c.range, res.FixedCode);
        }
        else if (pick === 'Show diff') {
            resultPanel_1.ResultPanel.showDiff('Fix Diff', c.code, res.FixedCode, ctx.extensionUri);
        }
    }));
    // devpilot.fix (right-click menu alias)
    ctx.subscriptions.push(vscode.commands.registerCommand('devpilot.fix', async () => {
        vscode.commands.executeCommand('devpilot.fixSnippet');
    }));
    // devpilot.reviewCode
    ctx.subscriptions.push(vscode.commands.registerCommand('devpilot.reviewCode', async () => {
        const c = getCode();
        if (!c)
            return;
        const res = await run('Reviewing', () => api_1.api.reviewCode(c.code));
        if (res)
            resultPanel_1.ResultPanel.show('Code Review', res.Review, ctx.extensionUri);
    }));
    // devpilot.generateTests
    ctx.subscriptions.push(vscode.commands.registerCommand('devpilot.generateTests', async () => {
        const c = getCode();
        if (!c)
            return;
        const res = await run('Generating tests', () => api_1.api.generateTests(c.code));
        if (!res)
            return;
        const doc = await vscode.workspace.openTextDocument({ content: res.Tests, language: c.editor.document.languageId });
        vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    }));
    // devpilot.generateDocs
    ctx.subscriptions.push(vscode.commands.registerCommand('devpilot.generateDocs', async () => {
        const c = getCode();
        if (!c)
            return;
        const res = await run('Generating docs', () => api_1.api.generateDocs(c.code));
        if (!res)
            return;
        const editor = c.editor;
        const line = editor.selection.start.line;
        await editor.edit(eb => eb.insert(new vscode.Position(line, 0), res.Documentation + '\n'));
    }));
    // devpilot.refactor
    ctx.subscriptions.push(vscode.commands.registerCommand('devpilot.refactor', async () => {
        const c = getCode();
        if (!c)
            return;
        const goal = await vscode.window.showInputBox({ prompt: 'Refactor goal (optional)', placeHolder: 'e.g. reduce nesting, use LINQ' }) ?? '';
        const res = await run('Refactoring', () => api_1.api.refactor(c.code, goal || undefined));
        if (!res)
            return;
        resultPanel_1.ResultPanel.showDiff('Refactor', res.OriginalCode, res.RefactoredCode, ctx.extensionUri, res.Summary);
    }));
    // devpilot.completeCode
    ctx.subscriptions.push(vscode.commands.registerCommand('devpilot.completeCode', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
        const pos = editor.selection.active;
        const prefix = editor.document.getText(new vscode.Range(new vscode.Position(0, 0), pos));
        const suffix = editor.document.getText(new vscode.Range(pos, editor.document.positionAt(editor.document.getText().length)));
        const res = await run('Completing', () => api_1.api.completeCode(prefix, suffix));
        if (!res)
            return;
        await editor.edit(eb => eb.insert(pos, res.Completion));
    }));
    // devpilot.renameSymbol
    ctx.subscriptions.push(vscode.commands.registerCommand('devpilot.renameSymbol', async () => {
        const c = getCode();
        if (!c)
            return;
        const symbol = c.editor.document.getText(c.editor.selection);
        if (!symbol.trim()) {
            vscode.window.showErrorMessage('Select the symbol to rename.');
            return;
        }
        const kind = await vscode.window.showQuickPick(['variable', 'method', 'class', 'parameter'], { title: 'Symbol kind' });
        const res = await run('Suggesting names', () => api_1.api.renameSymbol(symbol, kind, c.code));
        if (res)
            resultPanel_1.ResultPanel.show(`Rename: ${symbol}`, res.Suggestions, ctx.extensionUri);
    }));
    // devpilot.fixBuildErrors
    ctx.subscriptions.push(vscode.commands.registerCommand('devpilot.fixBuildErrors', async () => {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders?.length) {
            vscode.window.showErrorMessage('No workspace folder open.');
            return;
        }
        const projectPath = folders[0].uri.fsPath;
        const res = await run('Building & fixing', () => api_1.api.fixBuildErrors(projectPath));
        if (res) {
            if (res.Success) {
                vscode.window.showInformationMessage('DevPilot: Build succeeded — no errors!');
            }
            else {
                resultPanel_1.ResultPanel.show('Build Fix Analysis', res.Analysis, ctx.extensionUri);
            }
        }
    }));
    // devpilot.openChat
    ctx.subscriptions.push(vscode.commands.registerCommand('devpilot.openChat', () => {
        chatProvider.openPanel();
    }));
    // ── Backend health check ──────────────────────────────────────────────
    api_1.api.health().catch(() => vscode.window.showWarningMessage('DevPilot: Backend not reachable. Run ./start-backend.sh first.', 'OK'));
}
function deactivate() { }
//# sourceMappingURL=extension.js.map