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
exports.api = void 0;
const vscode = __importStar(require("vscode"));
function base() {
    return vscode.workspace
        .getConfiguration('devpilot')
        .get('backendUrl', 'http://localhost:5050');
}
async function post(path, body) {
    const res = await fetch(`${base()}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000)
    });
    if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`DevPilot backend error [${res.status}]: ${text}`);
    }
    return res.json();
}
async function del(path) {
    const res = await fetch(`${base()}${path}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`DevPilot [${res.status}]: ${text}`);
    }
    return res.json();
}
exports.api = {
    health: () => fetch(`${base()}/health`, { signal: AbortSignal.timeout(5000) })
        .then(r => r.json()),
    ask: (question) => post('/ask', { Question: question }),
    explainCode: (code) => post('/explain-code', { Code: code }),
    generateDocs: (code) => post('/generate-docs', { Code: code }),
    generateTests: (code) => post('/generate-tests', { Code: code }),
    reviewCode: (code) => post('/review-code', { Code: code }),
    fixSnippet: (code, error) => post('/fix-snippet', { Code: code, Error: error }),
    refactor: (code, goal) => post('/refactor', { Code: code, Goal: goal }),
    completeCode: (prefix, suffix, contextHint) => post('/complete-code', {
        Prefix: prefix,
        Suffix: suffix,
        ContextHint: contextHint
    }),
    renameSymbol: (symbol, kind, code) => post('/rename-symbol', { Symbol: symbol, Kind: kind, Code: code }),
    fixBuildErrors: (projectPath) => post('/fix-build-errors', { ProjectPath: projectPath }),
    scanAndBuild: (projectPath) => post('/scan-and-build', { ProjectPath: projectPath }),
    newSession: async () => {
        const response = await post('/chat/new', {});
        return { sessionId: response.SessionId ?? response.sessionId };
    },
    deleteSession: (id) => del(`/chat/${id}`),
    chat: async (messages, sessionId) => {
        const response = await post('/chat', {
            Messages: messages.map(m => ({ Role: m.role, Content: m.content })),
            SessionId: sessionId
        });
        return {
            answer: response.Answer ?? response.answer ?? '',
            sessionId: response.SessionId ?? response.sessionId
        };
    }
};
//# sourceMappingURL=api.js.map