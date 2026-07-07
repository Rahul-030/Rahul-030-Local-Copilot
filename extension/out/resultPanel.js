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
exports.ResultPanel = void 0;
const vscode = __importStar(require("vscode"));
class ResultPanel {
    static show(title, content, extUri) {
        this.getPanel(title, extUri).webview.html = this.wrapHtml(title, this.renderMd(content));
    }
    static showDiff(title, original, updated, extUri, summary) {
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
        this.getPanel(title, extUri).webview.html = this.wrapHtml(title, html, `<script>
        const updated = ${JSON.stringify(updated)};
        function copy(){navigator.clipboard.writeText(updated).then(()=>alert('Copied!'));}
      </script>`);
    }
    static getPanel(title, extUri) {
        if (this.panel) {
            this.panel.title = title;
            this.panel.reveal(vscode.ViewColumn.Beside);
            return this.panel;
        }
        this.panel = vscode.window.createWebviewPanel('devpilot.result', title, vscode.ViewColumn.Beside, { enableScripts: true });
        this.panel.onDidDispose(() => { this.panel = undefined; });
        return this.panel;
    }
    static esc(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    static renderMd(s) {
        return this.esc(s)
            .replace(/\`\`\`[\w]*\n?([\s\S]*?)\`\`\`/g, (_, c) => `<pre><code>${c}</code></pre>`)
            .replace(/\`([^\`]+)\`/g, (_, c) => `<code>${c}</code>`)
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/^(#{1,3})\s+(.+)$/gm, (_, h, t) => `<h${h.length}>${t}</h${h.length}>`)
            .replace(/\n/g, '<br>');
    }
    static wrapHtml(title, body, extra = '') {
        return /* html */ `<!DOCTYPE html><html><head><meta charset="UTF-8">
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
exports.ResultPanel = ResultPanel;
//# sourceMappingURL=resultPanel.js.map