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
exports.registerCodeActions = registerCodeActions;
const vscode = __importStar(require("vscode"));
async function callBackend(endpoint, body) {
    const url = vscode.workspace.getConfiguration('devpilot')
        .get('backendUrl') ?? 'http://localhost:5050';
    const res = await fetch(`${url}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000)
    });
    if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`Backend ${endpoint} failed (${res.status}): ${text}`);
    }
    return (await res.json());
}
function registerCodeActions(context) {
    // Quick Fix lightbulb
    const provider = {
        provideCodeActions(_doc, _range, ctx) {
            return ctx.diagnostics.map(diag => {
                const short = diag.message.length > 60
                    ? diag.message.substring(0, 60) + '...'
                    : diag.message;
                const action = new vscode.CodeAction(`DevPilot: Fix "${short}"`, vscode.CodeActionKind.QuickFix);
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
    context.subscriptions.push(vscode.languages.registerCodeActionsProvider({ pattern: '**' }, provider, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }));
    // Fix diagnostic command (lightbulb handler)
    context.subscriptions.push(vscode.commands.registerCommand('devpilot.fixDiagnostic', async (document, diagnostic) => {
        const line = diagnostic.range.start.line;
        const start = Math.max(0, line - 10);
        const end = Math.min(document.lineCount - 1, line + 10);
        const range = new vscode.Range(start, 0, end, document.lineAt(end).text.length);
        const code = document.getText(range);
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'DevPilot: fixing...', cancellable: false }, async () => {
            try {
                const result = await callBackend('/fix-snippet', {
                    Code: code,
                    Error: diagnostic.message
                });
                const fixed = result.FixedCode;
                if (!fixed) {
                    vscode.window.showWarningMessage('DevPilot: No fix returned.');
                    return;
                }
                const edit = new vscode.WorkspaceEdit();
                edit.replace(document.uri, range, fixed);
                await vscode.workspace.applyEdit(edit);
                vscode.window.showInformationMessage('DevPilot: Fix applied ✓');
            }
            catch (e) {
                vscode.window.showErrorMessage(`DevPilot: ${e.message}. Is the backend running?`);
            }
        });
    }));
}
//# sourceMappingURL=codeActions.js.map