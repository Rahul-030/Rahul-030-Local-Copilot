import * as vscode from 'vscode';
import { api } from './api';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
}

type PanelMessage =
  | { type: 'send'; text: string }
  | { type: 'clear' }
  | { type: 'context' }
  | { type: 'diagnostics' }
  | { type: 'buildFix' }
  | { type: 'task'; task: string }
  | { type: 'applyLastCode' };

export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;
  private webview?: vscode.Webview;
  private history: Msg[] = [];
  private sessionId?: string;
  private lastAssistantMessage = '';

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    this.webview = view.webview;

    this.setupWebview(view.webview);
  }

  openPanel() {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside);
      this.webview = this.panel.webview;
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'devpilot.chatPanel',
      'DevPilot',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.webview = this.panel.webview;
    this.setupWebview(this.panel.webview);
    this.panel.onDidDispose(() => {
      if (this.webview === this.panel?.webview) {
        this.webview = this.view?.webview;
      }
      this.panel = undefined;
    });
  }

  private setupWebview(webview: vscode.Webview) {
    webview.options = {
      enableScripts: true
    };

    webview.html = this.html();

    webview.onDidReceiveMessage(async (msg: PanelMessage) => {
      switch (msg.type) {
        case 'send':
          await this.onSend(msg.text);
          break;

        case 'clear':
          await this.onClear();
          break;

        case 'context':
          await this.onContext();
          break;

        case 'diagnostics':
          await this.onDiagnostics();
          break;

        case 'buildFix':
          await vscode.commands.executeCommand('devpilot.fixBuildErrors');
          break;

        case 'task':
          await this.onTask(msg.task);
          break;

        case 'applyLastCode':
          await this.applyLastCode();
          break;
      }
    });
  }

  private async onSend(text: string) {
    console.log('DevPilot: onSend called', text);

    if (!text.trim()) {
      return;
    }

    if (!this.sessionId) {
      console.log('Creating new session...');

      try {
        const s = await api.newSession();

        console.log('Session:', s);

        this.sessionId = s.sessionId;
      } catch (err) {
        console.error('Session error:', err);

        this.push({
          type: 'append',
          role: 'assistant',
          content: `Session error: ${String(err)}`
        });

        return;
      }
    }

    this.history.push({
      role: 'user',
      content: text
    });

    this.push({
      type: 'append',
      role: 'user',
      content: text
    });

    this.push({
      type: 'thinking',
      label: 'Working'
    });

    try {
      console.log('Calling chat API...');

      const res = await api.chat([{ role: 'user', content: text }], this.sessionId);

      console.log('Chat response:', res);

      this.history.push({
        role: 'assistant',
        content: res.answer
      });

      this.lastAssistantMessage = res.answer;

      this.push({
        type: 'replaceThinking',
        role: 'assistant',
        content: res.answer
      });
    } catch (e) {
      console.error('Chat error:', e);

      this.push({
        type: 'replaceThinking',
        role: 'assistant',
        content: `Error: ${String(e)}`
      });
    }
  }

  private async onTask(task: string) {
    const context = this.getEditorContext();
    const prompt = context
      ? `${task} this code like a senior coding agent. Be concise. If code should change, return one complete replacement code block.\n\n${context}`
      : `${task} the current coding task. Ask for code only if you need it.`;

    await this.onSend(prompt);
  }

  private async onDiagnostics() {
    const context = await this.getWorkspaceContext();

    if (!context) {
      vscode.window.showWarningMessage('Open a workspace or file before asking DevPilot to fix project errors.');
      return;
    }

    await this.onSend(
      `Read this project context, find the errors across the whole project, and propose fixes. Use VS Code diagnostics as the priority list. If files should change, return a short explanation followed by complete replacement code blocks labeled with each file path.\n\n${context}`
    );
  }

  private async onClear() {
    if (this.sessionId) {
      await api.deleteSession(this.sessionId).catch(() => {});
      this.sessionId = undefined;
    }

    this.history = [];
    this.lastAssistantMessage = '';

    this.push({
      type: 'clear'
    });
  }

  private async onContext() {
    const context = this.getEditorContext();

    if (!context) {
      return;
    }

    const editor = vscode.window.activeTextEditor!;
    const selection = editor.selection;

    this.push({
      type: 'insertContext',
      content: context,
      label: selection.isEmpty
        ? `${editor.document.fileName.split(/[\\/]/).pop()}`
        : `${editor.document.fileName.split(/[\\/]/).pop()}:${selection.start.line + 1}`
    });
  }

  private async applyLastCode() {
    const appliedProjectFiles = await this.applyLabeledCodeBlocks();
    if (appliedProjectFiles > 0) {
      vscode.window.showInformationMessage(`DevPilot: Applied ${appliedProjectFiles} project file replacement${appliedProjectFiles === 1 ? '' : 's'}.`);
      return;
    }

    const editor = vscode.window.activeTextEditor;

    if (!editor) {
      vscode.window.showWarningMessage('Open a file before applying code.');
      return;
    }

    const code = this.extractLastCodeBlock(this.lastAssistantMessage);

    if (!code) {
      vscode.window.showWarningMessage('DevPilot: No code block found in the last answer.');
      return;
    }

    const selection = editor.selection;

    if (selection.isEmpty) {
      await editor.edit(eb => eb.insert(selection.active, code));
      vscode.window.showInformationMessage('DevPilot: Inserted last code block.');
      return;
    }

    await editor.edit(eb => eb.replace(selection, code));
    vscode.window.showInformationMessage('DevPilot: Applied last code block to selection.');
  }

  private async applyLabeledCodeBlocks(): Promise<number> {
    const blocks = this.extractLabeledCodeBlocks(this.lastAssistantMessage);
    if (!blocks.length) {
      return 0;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return 0;
    }

    const edit = new vscode.WorkspaceEdit();
    let replacements = 0;

    for (const block of blocks) {
      const uri = vscode.Uri.joinPath(workspaceFolder.uri, block.filePath);
      if (this.shouldSkipPath(uri.fsPath)) {
        continue;
      }

      const existing = await this.readDocumentText(uri);
      if (existing === undefined) {
        continue;
      }

      const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
      const range = document
        ? new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length))
        : new vscode.Range(new vscode.Position(0, 0), this.positionAtText(existing, existing.length));

      edit.replace(uri, range, block.code);
      replacements += 1;
    }

    if (replacements === 0) {
      return 0;
    }

    await vscode.workspace.applyEdit(edit);
    return replacements;
  }

  private positionAtText(text: string, offset: number): vscode.Position {
    const clippedOffset = Math.max(0, Math.min(offset, text.length));
    const prefix = text.slice(0, clippedOffset);
    const lines = prefix.split(/\r\n|\r|\n/);
    return new vscode.Position(lines.length - 1, lines[lines.length - 1].length);
  }

  private extractLastCodeBlock(markdown: string): string | undefined {
    const matches = [...markdown.matchAll(/```[\w.+-]*\r?\n([\s\S]*?)```/g)];
    const last = matches.length ? matches[matches.length - 1] : undefined;
    const code = last?.[1]?.trim();
    return code || undefined;
  }

  private extractLabeledCodeBlocks(markdown: string): { filePath: string; code: string }[] {
    const blocks: { filePath: string; code: string }[] = [];
    const pattern = /(?:^|\n)(?:File|Path):\s*([^\r\n`]+)\r?\n```[\w.+-]*\r?\n([\s\S]*?)```/g;

    for (const match of markdown.matchAll(pattern)) {
      const filePath = this.cleanRelativePath(match[1]);
      const code = match[2]?.trimEnd();

      if (filePath && code) {
        blocks.push({ filePath, code });
      }
    }

    return blocks;
  }

  private cleanRelativePath(rawPath: string): string | undefined {
    const cleaned = rawPath
      .trim()
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/^\.?[\\/]/, '')
      .replace(/\\/g, '/');

    if (!cleaned || cleaned.includes('..') || cleaned.startsWith('/')) {
      return undefined;
    }

    return cleaned;
  }

  private async getWorkspaceContext(): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders;

    if (!folders?.length) {
      return this.getEditorContext({ forceFullFile: true, includeDiagnostics: true });
    }

    const root = folders[0];
    const workspaceDiagnostics = this.getWorkspaceDiagnostics(root.uri);
    const diagnosticUris = new Set(workspaceDiagnostics.map(entry => entry.uri.toString()));

    const activeDocument = vscode.window.activeTextEditor?.document;
    if (activeDocument && this.isInsideWorkspace(activeDocument.uri, root.uri)) {
      diagnosticUris.add(activeDocument.uri.toString());
    }

    const sourceUris = await this.findProjectSourceFiles(root.uri);
    for (const uri of sourceUris) {
      if (diagnosticUris.size >= 14) {
        break;
      }
      diagnosticUris.add(uri.toString());
    }

    const uriByKey = new Map<string, vscode.Uri>();
    for (const entry of workspaceDiagnostics) {
      uriByKey.set(entry.uri.toString(), entry.uri);
    }
    if (activeDocument) {
      uriByKey.set(activeDocument.uri.toString(), activeDocument.uri);
    }
    for (const uri of sourceUris) {
      uriByKey.set(uri.toString(), uri);
    }

    const fileSections: string[] = [];
    let remainingChars = 140_000;

    for (const key of diagnosticUris) {
      if (fileSections.length >= 14 || remainingChars <= 0) {
        break;
      }

      const uri = uriByKey.get(key);
      if (!uri) {
        continue;
      }

      const content = await this.readDocumentText(uri);
      if (!content?.trim()) {
        continue;
      }

      const relativePath = vscode.workspace.asRelativePath(uri, false);
      const language = this.languageIdForUri(uri);
      const diagnostics = this.formatDiagnosticsForUri(uri, 16);
      const clipped = content.length > remainingChars
        ? content.slice(0, remainingChars) + '\n/* DevPilot: file clipped because project context is large */'
        : content;

      remainingChars -= clipped.length;
      fileSections.push([
        `File: ${relativePath}`,
        `Language: ${language}`,
        diagnostics,
        `\`\`\`${language}`,
        clipped,
        '```'
      ].filter(Boolean).join('\n'));
    }

    if (!fileSections.length) {
      return undefined;
    }

    const diagnosticSummary = workspaceDiagnostics.length
      ? workspaceDiagnostics.map(entry => {
          const relativePath = vscode.workspace.asRelativePath(entry.uri, false);
          const lines = entry.diagnostics.slice(0, 8).map((diagnostic, index) => {
            const severity = vscode.DiagnosticSeverity[diagnostic.severity] ?? 'Unknown';
            return `  ${index + 1}. ${severity} line ${diagnostic.range.start.line + 1}: ${diagnostic.message}`;
          });
          return `${relativePath}\n${lines.join('\n')}`;
        }).join('\n\n')
      : 'No VS Code diagnostics are currently reported. Inspect the project files for likely compile/runtime errors.';

    return [
      `Workspace: ${root.name}`,
      `Root: ${root.uri.fsPath}`,
      '',
      'Workspace diagnostics:',
      diagnosticSummary,
      '',
      'Project files:',
      fileSections.join('\n\n---\n\n')
    ].join('\n');
  }

  private getWorkspaceDiagnostics(rootUri: vscode.Uri): { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }[] {
    return vscode.languages.getDiagnostics()
      .filter(([uri, diagnostics]) =>
        diagnostics.length > 0 &&
        this.isInsideWorkspace(uri, rootUri) &&
        !this.shouldSkipPath(uri.fsPath)
      )
      .sort(([, a], [, b]) => {
        const aSeverity = Math.min(...a.map(diagnostic => diagnostic.severity));
        const bSeverity = Math.min(...b.map(diagnostic => diagnostic.severity));
        return aSeverity - bSeverity;
      })
      .slice(0, 20)
      .map(([uri, diagnostics]) => ({ uri, diagnostics }));
  }

  private async findProjectSourceFiles(rootUri: vscode.Uri): Promise<vscode.Uri[]> {
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(rootUri, '**/*'),
      new vscode.RelativePattern(rootUri, '**/{node_modules,bin,obj,out,dist,build,.git}/**'),
      80
    );

    return files
      .filter(uri => this.isUsefulSourceFile(uri.fsPath))
      .sort((a, b) => this.sourcePriority(a.fsPath) - this.sourcePriority(b.fsPath));
  }

  private async readDocumentText(uri: vscode.Uri): Promise<string | undefined> {
    const openDocument = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
    if (openDocument) {
      return openDocument.getText();
    }

    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return Buffer.from(bytes).toString('utf8');
    } catch {
      return undefined;
    }
  }

  private formatDiagnosticsForUri(uri: vscode.Uri, limit: number): string {
    const diagnostics = vscode.languages.getDiagnostics(uri);

    if (!diagnostics.length) {
      return 'Diagnostics: none reported by VS Code';
    }

    const lines = diagnostics.slice(0, limit).map((diagnostic, index) => {
      const severity = vscode.DiagnosticSeverity[diagnostic.severity] ?? 'Unknown';
      return `${index + 1}. ${severity} line ${diagnostic.range.start.line + 1}: ${diagnostic.message}`;
    });

    return `Diagnostics:\n${lines.join('\n')}`;
  }

  private isInsideWorkspace(uri: vscode.Uri, rootUri: vscode.Uri): boolean {
    return uri.scheme === 'file' && uri.fsPath.startsWith(rootUri.fsPath);
  }

  private isUsefulSourceFile(filePath: string): boolean {
    if (this.shouldSkipPath(filePath)) {
      return false;
    }

    return /\.(cs|csproj|ts|tsx|js|jsx|json|html|css|scss|py|java|go|rs|cpp|c|h|hpp|md|yml|yaml)$/i.test(filePath);
  }

  private shouldSkipPath(filePath: string): boolean {
    return /[\\/](node_modules|bin|obj|out|dist|build|\.git)[\\/]/.test(filePath);
  }

  private sourcePriority(filePath: string): number {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase();
    if (normalized.endsWith('/program.cs') || normalized.endsWith('/package.json')) {
      return 0;
    }
    if (/\.(csproj|sln|tsconfig\.json)$/.test(normalized)) {
      return 1;
    }
    if (/\.(cs|ts|tsx|js|jsx)$/.test(normalized)) {
      return 2;
    }
    return 3;
  }

  private languageIdForUri(uri: vscode.Uri): string {
    const openDocument = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
    if (openDocument) {
      return openDocument.languageId;
    }

    const filePath = uri.fsPath.toLowerCase();
    if (filePath.endsWith('.cs')) return 'csharp';
    if (filePath.endsWith('.csproj')) return 'xml';
    if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) return 'typescript';
    if (filePath.endsWith('.js') || filePath.endsWith('.jsx')) return 'javascript';
    if (filePath.endsWith('.json')) return 'json';
    if (filePath.endsWith('.html')) return 'html';
    if (filePath.endsWith('.css') || filePath.endsWith('.scss')) return 'css';
    if (filePath.endsWith('.py')) return 'python';
    if (filePath.endsWith('.md')) return 'markdown';
    if (filePath.endsWith('.yml') || filePath.endsWith('.yaml')) return 'yaml';
    return '';
  }

  private getEditorContext(options: { forceFullFile?: boolean; includeDiagnostics?: boolean } = {}): string | undefined {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
      return undefined;
    }

    const document = editor.document;
    const selection = editor.selection;
    const useSelection = !options.forceFullFile && !selection.isEmpty;
    const range = useSelection
      ? selection
      : new vscode.Range(
          new vscode.Position(0, 0),
          document.positionAt(document.getText().length)
        );
    const code = document.getText(range);

    if (!code.trim()) {
      return undefined;
    }

    const fileName = document.fileName.split(/[\\/]/).pop() ?? document.fileName;
    const diagnostics = options.includeDiagnostics
      ? this.formatDiagnosticsForUri(document.uri, 12)
      : '';
    const scope = useSelection
      ? `Selection: lines ${selection.start.line + 1}-${selection.end.line + 1}`
      : 'Scope: full file';

    return [
      `File: ${fileName}`,
      `Language: ${document.languageId}`,
      scope,
      diagnostics,
      `\`\`\`${document.languageId}`,
      code,
      '```'
    ].filter(Boolean).join('\n');
  }

  private push(msg: object) {
    this.webview?.postMessage(msg);
  }

  private html(): string {
    return `
<!DOCTYPE html>
<html>
<head>
<style>
* { box-sizing: border-box; }
body {
  margin: 0;
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
}
.shell {
  display: grid;
  grid-template-rows: auto 1fr auto;
  height: 100vh;
}
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--vscode-sideBar-border);
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-weight: 600;
}
.mark {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 5px;
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
  font-size: 12px;
}
.ghost-button,
.wide-button,
.task-button,
.send-button {
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 5px;
  color: var(--vscode-button-secondaryForeground);
  background: var(--vscode-button-secondaryBackground);
  cursor: pointer;
  font: inherit;
}
.ghost-button {
  min-width: 30px;
  height: 28px;
  padding: 0 8px;
}
.ghost-button:hover,
.wide-button:hover,
.task-button:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}
.taskbar {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  padding: 10px 12px 0;
}
.task-button {
  min-height: 30px;
  padding: 5px 8px;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.agent-strip {
  display: flex;
  gap: 6px;
  padding: 8px 12px 0;
}
.wide-button {
  min-width: 0;
  min-height: 30px;
  flex: 1;
  padding: 5px 8px;
}
#msgs {
  min-height: 0;
  overflow-y: auto;
  padding: 10px 12px 14px;
}
.msg {
  margin: 10px 0;
  line-height: 1.45;
}
.msg .meta {
  margin-bottom: 4px;
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
}
.bubble {
  padding: 9px 10px;
  border-radius: 7px;
  border: 1px solid var(--vscode-input-border, transparent);
  white-space: pre-wrap;
  word-break: break-word;
}
.bubble pre {
  margin: 8px 0 0;
  padding: 9px;
  overflow-x: auto;
  border-radius: 5px;
  color: var(--vscode-editor-foreground);
  background: var(--vscode-textCodeBlock-background);
  white-space: pre;
}
.bubble code {
  font-family: var(--vscode-editor-font-family);
  font-size: 12px;
}
.user .bubble {
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
  border-color: var(--vscode-button-background);
}
.assistant .bubble {
  background: var(--vscode-editorWidget-background);
  border-color: var(--vscode-editorWidget-border, var(--vscode-sideBar-border));
}
.composer {
  padding: 10px 12px 12px;
  border-top: 1px solid var(--vscode-sideBar-border);
  background: var(--vscode-sideBar-background);
}
.context-chip {
  display: none;
  align-items: center;
  width: 100%;
  min-height: 24px;
  margin-bottom: 7px;
  padding: 3px 8px;
  border-radius: 5px;
  color: var(--vscode-descriptionForeground);
  background: var(--vscode-badge-background);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
textarea {
  width: 100%;
  min-height: 74px;
  max-height: 220px;
  resize: vertical;
  padding: 8px 9px;
  border: 1px solid var(--vscode-input-border);
  border-radius: 6px;
  outline: none;
  color: var(--vscode-input-foreground);
  background: var(--vscode-input-background);
  font: inherit;
}
textarea:focus {
  border-color: var(--vscode-focusBorder);
}
.composer-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 7px;
}
.left-actions,
.right-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.send-button {
  min-width: 64px;
  height: 30px;
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
}
.send-button:hover {
  background: var(--vscode-button-hoverBackground);
}
</style>
</head>

<body>
<div class="shell">
  <header class="topbar">
    <div class="brand">
      <span class="mark">AI</span>
      <span>DevPilot</span>
    </div>
    <button class="ghost-button" id="clear" title="Clear chat">Clear</button>
  </header>

  <main>
    <div class="taskbar">
      <button class="task-button" data-task="Fix">Fix selection</button>
      <button class="task-button" data-task="Explain">Explain</button>
      <button class="task-button" data-task="Review">Review</button>
      <button class="task-button" data-task="Write tests for">Tests</button>
    </div>
    <div class="agent-strip">
      <button class="wide-button" id="buildFix">Build & Fix Error</button>
      <button class="wide-button" id="diagnostics">Scan project errors</button>
    </div>

    <div id="msgs">
      <div class="msg assistant">
        <div class="meta">DevPilot</div>
        <div class="bubble">I can inspect the whole workspace, use VS Code diagnostics, propose fixes, and apply the last code block back into your file.</div>
      </div>
    </div>
  </main>

  <section class="composer">
    <div id="contextChip" class="context-chip"></div>
    <textarea id="inp" rows="3" placeholder="Ask DevPilot to explain, fix, refactor, or generate code..."></textarea>
    <div class="composer-actions">
      <div class="left-actions">
        <button class="ghost-button" id="context" title="Add current file or selection">+</button>
        <button class="ghost-button" id="apply" title="Apply last code block to editor">Apply</button>
      </div>
      <div class="right-actions">
        <button class="send-button" id="send">Send</button>
      </div>
    </div>
  </section>
  </div>

<script>
const vscode = acquireVsCodeApi();

const msgs = document.getElementById('msgs');
const inp = document.getElementById('inp');
const contextChip = document.getElementById('contextChip');

function append(role, content) {
    const div = document.createElement('div');
    div.className = 'msg ' + role;

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = role === 'user' ? 'You' : 'DevPilot';

    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = renderMessage(content);

    div.appendChild(meta);
    div.appendChild(bubble);

    msgs.appendChild(div);

    msgs.scrollTop = msgs.scrollHeight;

    return div;
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function renderMessage(content) {
    const tick = String.fromCharCode(96);
    const fence = tick.repeat(3);
    const codeFencePattern = new RegExp(fence + '[\\\\w.+-]*\\\\r?\\\\n([\\\\s\\\\S]*?)' + fence, 'g');
    const inlineCodePattern = new RegExp(tick + '([^' + tick + ']+)' + tick, 'g');
    const parts = String(content).split(codeFencePattern);
    return parts.map((part, index) => {
        if (index % 2 === 1) {
            return '<pre><code>' + escapeHtml(part.trim()) + '</code></pre>';
        }
        return escapeHtml(part)
            .replace(inlineCodePattern, '<code>$1</code>')
            .replace(/\\n/g, '<br>');
    }).join('');
}

window.addEventListener('message', event => {
    const msg = event.data;

    if (msg.type === 'append') {
        append(msg.role, msg.content);
    }

    if (msg.type === 'thinking') {
        const node = append('assistant', msg.label || 'Working...');
        node.classList.add('thinking');
    }

    if (msg.type === 'replaceThinking') {
        const thinking = msgs.querySelector('.thinking');
        if (thinking) {
            thinking.remove();
        }
        append(msg.role, msg.content);
    }

    if (msg.type === 'clear') {
        msgs.innerHTML = '<div class="msg assistant"><div class="meta">DevPilot</div><div class="bubble">New chat started.</div></div>';
        contextChip.style.display = 'none';
        contextChip.textContent = '';
    }

    if (msg.type === 'insertContext') {
        inp.value = (inp.value ? inp.value + '\\n\\n' : '') + msg.content;
        contextChip.textContent = 'Context added: ' + (msg.label || 'current editor');
        contextChip.style.display = 'flex';
        inp.focus();
    }
});

function send() {
    const text = inp.value;
    if (!text.trim()) {
      return;
    }

    vscode.postMessage({
        type: 'send',
        text
    });

    inp.value = '';
    contextChip.style.display = 'none';
    contextChip.textContent = '';
}

document.getElementById('send').onclick = send;

inp.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        send();
    }
});

document.getElementById('context').onclick = () => {
    vscode.postMessage({
        type: 'context'
    });
};

document.getElementById('buildFix').onclick = () => {
    vscode.postMessage({
        type: 'buildFix'
    });
};

document.getElementById('diagnostics').onclick = () => {
    vscode.postMessage({
        type: 'diagnostics'
    });
};

document.getElementById('clear').onclick = () => {
    vscode.postMessage({
        type: 'clear'
    });
};

document.getElementById('apply').onclick = () => {
    vscode.postMessage({
        type: 'applyLastCode'
    });
};

document.querySelectorAll('[data-task]').forEach(button => {
    button.addEventListener('click', () => {
        vscode.postMessage({
            type: 'task',
            task: button.getAttribute('data-task')
        });
    });
});
</script>

</body>
</html>
`;
  }
}
