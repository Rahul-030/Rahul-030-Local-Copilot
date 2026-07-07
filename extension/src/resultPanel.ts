import * as vscode from 'vscode';

export class ResultPanel {
  private static panel?: vscode.WebviewPanel;

  static show(title: string, content: string, extUri: vscode.Uri) {
    this.getPanel(title, extUri).webview.html = this.wrapHtml(title, this.renderMd(content));
  }

  static showDiff(title: string, original: string, updated: string, extUri: vscode.Uri, summary?: string) {
    const summaryHtml = summary
      ? `<div class="summary"><strong>Changes:</strong><br>${this.renderMd(summary)}</div>`
      : '';
    const html = `
      ${summaryHtml}
      <div class="diff-wrap">
        <div class="diff-col">
          <div class="diff-label">Original</div>
          <pre><code>${this.esc(original)}</code></pre>
        </div>
        <div class="diff-col">
          <div class="diff-label">Updated</div>
          <pre><code>${this.esc(updated)}</code></pre>
        </div>
      </div>
      <button onclick="copy()">Copy updated</button>`;
    this.getPanel(title, extUri).webview.html = this.wrapHtml(title, html,
      `<script>
        const updated = ${JSON.stringify(updated)};
        function copy(){navigator.clipboard.writeText(updated).then(()=>alert('Copied!'));}
      </script>`);
  }

  private static getPanel(title: string, extUri: vscode.Uri): vscode.WebviewPanel {
    if (this.panel) {
      this.panel.title = title;
      this.panel.reveal(vscode.ViewColumn.Beside);
      return this.panel;
    }
    this.panel = vscode.window.createWebviewPanel('devpilot.result', title, vscode.ViewColumn.Beside, { enableScripts: true });
    this.panel.onDidDispose(() => { this.panel = undefined; });
    return this.panel;
  }

  private static esc(s: string) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  private static renderMd(s: string): string {
    return this.esc(s)
      .replace(/\`\`\`[\w]*\n?([\s\S]*?)\`\`\`/g, (_,c) => `<pre><code>${c}</code></pre>`)
      .replace(/\`([^\`]+)\`/g, (_,c) => `<code>${c}</code>`)
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/^(#{1,3})\s+(.+)$/gm, (_,h,t) => `<h${h.length}>${t}</h${h.length}>`)
      .replace(/\n/g, '<br>');
  }

  private static wrapHtml(title: string, body: string, extra = ''): string {
    return /* html */`<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);
       color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:16px}
  h1{font-size:15px;margin-bottom:12px;color:var(--vscode-foreground)}
  h2,h3{font-size:13px;margin:10px 0 4px}
  pre{background:var(--vscode-textCodeBlock-background);padding:10px;border-radius:4px;
      overflow-x:auto;white-space:pre-wrap;font-size:12px;margin:6px 0}
  code{font-family:var(--vscode-editor-font-family);font-size:12px}
  .summary{background:var(--vscode-editor-inactiveSelectionBackground);padding:10px;
            border-radius:4px;margin-bottom:12px;font-size:12px}
  .diff-wrap{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .diff-col pre{height:70vh;overflow-y:auto}
  .diff-label{font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:4px}
  button{margin-top:10px;background:var(--vscode-button-background);
         color:var(--vscode-button-foreground);border:none;border-radius:4px;
         padding:6px 14px;cursor:pointer}
  button:hover{background:var(--vscode-button-hoverBackground)}
  strong{font-weight:600}
  br+br{display:none}
</style>
</head><body>
<h1>${this.esc(title)}</h1>
${body}
${extra}
</body></html>`;
  }
}