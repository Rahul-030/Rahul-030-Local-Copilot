import * as vscode from 'vscode';

function base(): string {
    return vscode.workspace
        .getConfiguration('devpilot')
        .get<string>('backendUrl', 'http://localhost:5050');
}

async function post<T>(path: string, body: object): Promise<T> {
    const res = await fetch(`${base()}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000)
    });

    if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`DevPilot backend error [${res.status}]: ${text}`);
    }

    return res.json() as Promise<T>;
}

async function del<T>(path: string): Promise<T> {
    const res = await fetch(`${base()}${path}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(10_000)
    });
    if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`DevPilot [${res.status}]: ${text}`);
    }
    return res.json() as Promise<T>;
}

export const api = {
    health: () =>
        fetch(`${base()}/health`, { signal: AbortSignal.timeout(5_000) })
            .then(r => r.json()),

    ask: (question: string) =>
        post<{ Answer: string }>('/ask', { Question: question }),

    explainCode: (code: string) =>
        post<{ Explanation: string }>('/explain-code', { Code: code }),

    generateDocs: (code: string) =>
        post<{ Documentation: string }>('/generate-docs', { Code: code }),

    generateTests: (code: string) =>
        post<{ Tests: string }>('/generate-tests', { Code: code }),

    reviewCode: (code: string) =>
        post<{ Review: string }>('/review-code', { Code: code }),

    fixSnippet: (code: string, error: string) =>
        post<{ FixedCode: string }>('/fix-snippet', { Code: code, Error: error }),

    refactor: (code: string, goal?: string) =>
        post<{
            OriginalCode: string;
            RefactoredCode: string;
            Summary: string;
        }>('/refactor', { Code: code, Goal: goal }),

    completeCode: (prefix: string, suffix?: string, contextHint?: string) =>
        post<{ Completion: string }>('/complete-code', {
            Prefix: prefix,
            Suffix: suffix,
            ContextHint: contextHint
        }),

    renameSymbol: (symbol: string, kind?: string, code?: string) =>
        post<{
            OriginalSymbol: string;
            Suggestions: string;
        }>('/rename-symbol', { Symbol: symbol, Kind: kind, Code: code }),

    fixBuildErrors: (projectPath: string) =>
        post<{
            Success: boolean;
            Analysis: string;
            ErrorsStructured: object[];
        }>('/fix-build-errors', { ProjectPath: projectPath }),

    scanAndBuild: (projectPath: string) =>
        post<any>('/scan-and-build', { ProjectPath: projectPath }),

    newSession: async () => {
        const response = await post<any>('/chat/new', {});
        return { sessionId: response.SessionId ?? response.sessionId };
    },

    deleteSession: (id: string) =>
        del<any>(`/chat/${id}`),

    chat: async (messages: { role: string; content: string }[], sessionId?: string) => {
        const response = await post<any>('/chat', {
            Messages: messages.map(m => ({ Role: m.role, Content: m.content })),
            SessionId: sessionId
        });
        return {
            answer: response.Answer ?? response.answer ?? '',
            sessionId: response.SessionId ?? response.sessionId
        };
    }
};
