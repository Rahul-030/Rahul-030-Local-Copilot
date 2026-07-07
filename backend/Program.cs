#pragma warning disable SKEXP0070
using Microsoft.SemanticKernel;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Formatting;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

// ─────────────────────────────────────────────────────────────
//  STARTUP CHECKS
// ─────────────────────────────────────────────────────────────
await StartupChecks.EnsureOllamaReady();
//suitable with .net 8 

// ─────────────────────────────────────────────────────────────
//  BUILDER
// ─────────────────────────────────────────────────────────────
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddCors(o =>
    o.AddDefaultPolicy(p =>
        p.WithOrigins("http://localhost:*", "vscode-webview://*", "https://localhost:*")
         .SetIsOriginAllowed(_ => true)     // loopback dev only — restrict in prod
         .AllowAnyMethod()
         .AllowAnyHeader()));

builder.Services.AddSingleton(sp =>
{
    var kb = Kernel.CreateBuilder();
    kb.AddOllamaChatCompletion(
        modelId: "qwen2.5-coder:7b",
        endpoint: new Uri("http://localhost:11434"));
    return kb.Build();
});

// Simple in-memory conversation store (per-session-id)
builder.Services.AddSingleton<ConversationStore>();

var app = builder.Build();
app.UseCors();

// ─────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────

/// <summary>
/// Strips markdown fences. Handles ```csharp, ```cs, ```, ~~~, etc.
/// Does NOT strip if the ENTIRE response is a fence — returns inner content.
/// </summary>
static string StripFences(string raw)
{
    if (string.IsNullOrWhiteSpace(raw)) return raw;
    var s = raw.Trim();

    // Match opening fence + optional lang + newline
    var m = Regex.Match(s, @"^(`{3,}|~{3,})[a-zA-Z0-9]*\r?\n", RegexOptions.Singleline);
    if (!m.Success) return s;

    var fence = m.Groups[1].Value;
    var afterOpen = s[m.Length..];

    // Match closing fence at end
    var closePattern = $@"\r?\n{Regex.Escape(fence)}\s*$";
    var close = Regex.Match(afterOpen, closePattern, RegexOptions.Singleline);
    if (!close.Success) return afterOpen.TrimEnd(); // malformed — return what we have

    return afterOpen[..close.Index].Trim();
}

/// <summary>
/// Asks the kernel with a timeout. Throws TimeoutException on overrun.
/// </summary>
static async Task<string> AskKernel(Kernel kernel, string prompt, int timeoutSeconds = 120)
{
    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(timeoutSeconds));
    try
    {
        var result = await kernel.InvokePromptAsync(prompt, cancellationToken: cts.Token);
        return result.ToString();
    }
    catch (OperationCanceledException)
    {
        throw new TimeoutException($"Model did not respond within {timeoutSeconds}s. Try a shorter snippet.");
    }
}

static async Task<(int exitCode, string output, string errors)> RunProcess(
    string file, string args, string workingDir, int timeoutSeconds = 120)
{
    var psi = new ProcessStartInfo
    {
        FileName = file,
        Arguments = args,
        WorkingDirectory = workingDir,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        UseShellExecute = false,
        CreateNoWindow = true
    };

    using var process = new Process { StartInfo = psi };
    process.Start();

    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(timeoutSeconds));

    var outputTask = process.StandardOutput.ReadToEndAsync(cts.Token);
    var errorTask  = process.StandardError.ReadToEndAsync(cts.Token);

    try
    {
        await process.WaitForExitAsync(cts.Token);
    }
    catch (OperationCanceledException)
    {
        process.Kill(entireProcessTree: true);
        return (-1, "", $"Process timed out after {timeoutSeconds}s.");
    }

    return (process.ExitCode, await outputTask, await errorTask);
}

static List<BuildError> ParseBuildErrors(string combined)
{
    var results = new List<BuildError>();
    var regex = new Regex(
        @"(?m)^(?<file>[^\r\n]*?\.cs)\((?<line>\d+),(?<col>\d+)\):\s*(?<severity>error|warning)\s+(?<code>[^:\s]+):\s*(?<message>[^\r\n]+)",
        RegexOptions.IgnoreCase);

    foreach (Match m in regex.Matches(combined))
        results.Add(new BuildError(
            m.Groups["file"].Value.Trim(),
            int.TryParse(m.Groups["line"].Value, out var l) ? l : 0,
            int.TryParse(m.Groups["col"].Value,  out var c) ? c : 0,
            m.Groups["severity"].Value,
            m.Groups["code"].Value.Trim(),
            m.Groups["message"].Value.Trim()));

    return results;
}

// ─────────────────────────────────────────────────────────────
//  HEALTH
// ─────────────────────────────────────────────────────────────
app.MapGet("/health", () => Results.Ok(new
{
    Status = "OK",
    Model  = "qwen2.5-coder:7b",
    Endpoints = new[]
    {
        "POST /ask", "POST /chat", "POST /explain-code", "POST /generate-docs",
        "POST /generate-tests", "POST /review-code", "POST /fix-snippet",
        "POST /refactor", "POST /complete-code", "POST /rename-symbol",
        "POST /explain-method", "POST /apply-fix", "POST /confirm-fix",
        "POST /build-project", "POST /fix-build-errors", "POST /scan-and-build",
        "POST /fix-with-context", "POST /confirm-file-fix", "POST /scan-project",
        "POST /chat/new", "DELETE /chat/{id}"
    }
}));

// ─────────────────────────────────────────────────────────────
//  /ask  — single question
// ─────────────────────────────────────────────────────────────
app.MapPost("/ask", async (AskRequest req, Kernel kernel) =>
{
    if (string.IsNullOrWhiteSpace(req.Question))
        return Results.BadRequest("Question cannot be empty.");
    try
    {
        var answer = await AskKernel(kernel, req.Question);
        return Results.Ok(new { Answer = answer });
    }
    catch (TimeoutException ex) { return Results.Problem(ex.Message, statusCode: 504); }
    catch (Exception ex) { return Results.Problem(ex.Message, statusCode: 502); }
});

// ─────────────────────────────────────────────────────────────
//  /chat/new — create a new conversation session
// ─────────────────────────────────────────────────────────────
app.MapPost("/chat/new", (ConversationStore store) =>
{
    var id = store.Create();
    return Results.Ok(new { SessionId = id });
});

// ─────────────────────────────────────────────────────────────
//  DELETE /chat/{id} — delete a session
// ─────────────────────────────────────────────────────────────
app.MapDelete("/chat/{id}", (string id, ConversationStore store) =>
{
    store.Delete(id);
    return Results.Ok(new { Deleted = id });
});

// ─────────────────────────────────────────────────────────────
//  /chat — multi-turn conversation with session history
// ─────────────────────────────────────────────────────────────
app.MapPost("/chat", async (ChatRequest req, Kernel kernel, ConversationStore store) =>
{
    if (req.Messages is null || req.Messages.Count == 0)
        return Results.BadRequest("Messages cannot be empty.");

    // Persist to session if ID provided
    if (!string.IsNullOrWhiteSpace(req.SessionId))
        store.Append(req.SessionId, req.Messages);

    var history = string.IsNullOrWhiteSpace(req.SessionId)
        ? req.Messages
        : store.Get(req.SessionId);

    var sb = new StringBuilder();
    sb.AppendLine("You are DevPilot, a Codex-style coding agent integrated into VS Code.");
    sb.AppendLine("Be concise, precise, and practical. Prefer actionable answers over long explanations.");
    sb.AppendLine("When asked to fix code, identify the cause briefly and include one complete replacement code block when useful.");
    sb.AppendLine("Preserve the user's language, framework, public APIs, formatting style, and file structure unless a change is required.");
    sb.AppendLine("If diagnostics are provided, treat them as the priority list and explain any assumptions.");
    sb.AppendLine();
    foreach (var m in history)
        sb.AppendLine($"{m.Role}: {m.Content}");
    sb.AppendLine("assistant:");

    try
    {
        var answer = await AskKernel(kernel, sb.ToString());
        var trimmed = answer.Trim();

        // Append assistant reply to session
        if (!string.IsNullOrWhiteSpace(req.SessionId))
            store.Append(req.SessionId, new List<ChatMessage>
                { new("assistant", trimmed) });

        return Results.Ok(new { Answer = trimmed, SessionId = req.SessionId });
    }
    catch (TimeoutException ex) { return Results.Problem(ex.Message, statusCode: 504); }
    catch (Exception ex)        { return Results.Problem(ex.Message, statusCode: 502); }
});

// ─────────────────────────────────────────────────────────────
//  /explain-code
// ─────────────────────────────────────────────────────────────
app.MapPost("/explain-code", async (CodeRequest req, Kernel kernel) =>
{
    if (string.IsNullOrWhiteSpace(req.Code))
        return Results.BadRequest("Code cannot be empty.");

    var prompt = $"""
You are a senior software developer. Explain the following code so a junior developer can understand it.
Cover: purpose, inputs/outputs, key logic, any side effects or gotchas.

Code:
{req.Code}

Explanation:
""";
    try
    {
        var explanation = await AskKernel(kernel, prompt);
        return Results.Ok(new { Explanation = explanation.Trim() });
    }
    catch (TimeoutException ex) { return Results.Problem(ex.Message, statusCode: 504); }
});

// ─────────────────────────────────────────────────────────────
//  /generate-docs
// ─────────────────────────────────────────────────────────────
app.MapPost("/generate-docs", async (CodeRequest req, Kernel kernel) =>
{
    if (string.IsNullOrWhiteSpace(req.Code))
        return Results.BadRequest("Code cannot be empty.");

    var prompt = $"""
You are a senior software developer.
Generate documentation comments for this code in the correct format for its language:
- C# → XML doc comments (///)
- JavaScript/TypeScript → JSDoc (/** */)
- Python → Google-style docstrings
Return ONLY the documentation. Do not repeat or modify the original code.

Code:
{req.Code}
""";
    try
    {
        var docs = await AskKernel(kernel, prompt);
        return Results.Ok(new { Documentation = StripFences(docs) });
    }
    catch (TimeoutException ex) { return Results.Problem(ex.Message, statusCode: 504); }
});

// ─────────────────────────────────────────────────────────────
//  /generate-tests
// ─────────────────────────────────────────────────────────────
app.MapPost("/generate-tests", async (CodeRequest req, Kernel kernel) =>
{
    if (string.IsNullOrWhiteSpace(req.Code))
        return Results.BadRequest("Code cannot be empty.");

    var prompt = $"""
You are an expert test engineer.
Generate thorough unit tests for the following code.
Pick the correct framework: NUnit for C#, Jest for JavaScript/TypeScript, pytest for Python.
Tests must cover: happy path, boundary values, error/exception cases, null inputs.
Return ONLY the test code. No explanations. No markdown fences.

Code:
{req.Code}
""";
    try
    {
        var tests = await AskKernel(kernel, prompt);
        return Results.Ok(new { Tests = StripFences(tests) });
    }
    catch (TimeoutException ex) { return Results.Problem(ex.Message, statusCode: 504); }
});

// ─────────────────────────────────────────────────────────────
//  /review-code
// ─────────────────────────────────────────────────────────────
app.MapPost("/review-code", async (CodeRequest req, Kernel kernel) =>
{
    if (string.IsNullOrWhiteSpace(req.Code))
        return Results.BadRequest("Code cannot be empty.");

    var prompt = $"""
You are a senior code reviewer. Review this code for:
1. Bugs and logic errors
2. Security vulnerabilities (injection, null-deref, resource leaks, etc.)
3. Performance issues
4. Code smells and bad practices
5. Missing error handling

For each issue use this exact format:
SEVERITY: High | Medium | Low
LOCATION: <method/line>
PROBLEM: <what is wrong>
FIX: <exact suggestion>
---

Code:
{req.Code}
""";
    try
    {
        var review = await AskKernel(kernel, prompt);
        return Results.Ok(new { Review = review.Trim() });
    }
    catch (TimeoutException ex) { return Results.Problem(ex.Message, statusCode: 504); }
});

// ─────────────────────────────────────────────────────────────
//  /fix-snippet  — quick-fix for selected code (VS Code Quick Fix)
// ─────────────────────────────────────────────────────────────
app.MapPost("/fix-snippet", async (FixSnippetRequest req, Kernel kernel) =>
{
    if (string.IsNullOrWhiteSpace(req.Code))
        return Results.BadRequest("Code cannot be empty.");

    var errorPart = string.IsNullOrWhiteSpace(req.Error) ? "general issues" : req.Error;

    var prompt = $"""
You are a senior software developer fixing a code snippet.

ERROR: {errorPart}

Rules:
- Return ONLY the corrected code
- Preserve the original indentation exactly
- Do NOT add explanations
- Do NOT add markdown fences
- Add required imports/usings at the top if needed

Code to fix:
{req.Code}
""";
    try
    {
        var raw = await AskKernel(kernel, prompt);
        return Results.Ok(new { FixedCode = StripFences(raw) });
    }
    catch (TimeoutException ex) { return Results.Problem(ex.Message, statusCode: 504); }
});

// ─────────────────────────────────────────────────────────────
//  /refactor  — refactor code for clarity/performance (NEW)
// ─────────────────────────────────────────────────────────────
app.MapPost("/refactor", async (RefactorRequest req, Kernel kernel) =>
{
    if (string.IsNullOrWhiteSpace(req.Code))
        return Results.BadRequest("Code cannot be empty.");

    var goalText = string.IsNullOrWhiteSpace(req.Goal)
        ? "improve readability, reduce duplication, and follow best practices"
        : req.Goal;

    var prompt = $"""
You are a senior software developer performing a code refactor.
Goal: {goalText}

Rules:
- Preserve the exact same behavior — no logic changes unless the goal says otherwise
- Apply SOLID principles where applicable
- Extract helper methods if a function is too long
- Use meaningful variable names
- Return ONLY the refactored code. No explanations. No markdown fences.

Code:
{req.Code}
""";
    try
    {
        var raw   = await AskKernel(kernel, prompt);
        var clean = StripFences(raw);

        // Generate a brief summary of changes
        var summaryPrompt = $"""
In 3-5 bullet points, describe the specific changes made between the original and refactored code.
Be concrete: "Extracted X into helper method Y", "Replaced null-check with pattern matching", etc.

Original:
{req.Code}

Refactored:
{clean}
""";
        var summary = await AskKernel(kernel, summaryPrompt);

        return Results.Ok(new
        {
            OriginalCode   = req.Code,
            RefactoredCode = clean,
            Summary        = summary.Trim()
        });
    }
    catch (TimeoutException ex) { return Results.Problem(ex.Message, statusCode: 504); }
});

// ─────────────────────────────────────────────────────────────
//  /complete-code — autocomplete / fill in the next block (NEW)
// ─────────────────────────────────────────────────────────────
app.MapPost("/complete-code", async (CompleteCodeRequest req, Kernel kernel) =>
{
    if (string.IsNullOrWhiteSpace(req.Prefix))
        return Results.BadRequest("Prefix cannot be empty.");

    var suffix = string.IsNullOrWhiteSpace(req.Suffix) ? "" : $"\n\n// Code that follows:\n{req.Suffix}";
    var context = string.IsNullOrWhiteSpace(req.ContextHint) ? "" : $"\nContext: {req.ContextHint}";

    var prompt = $"""
You are an expert code autocomplete engine (like GitHub Copilot).{context}
Complete the code at the <CURSOR> marker. Write only the missing code — nothing before the cursor.
Do NOT repeat the prefix. Do NOT add markdown fences. Do NOT add explanations.

Code before cursor:
{req.Prefix}
<CURSOR>{suffix}
""";
    try
    {
        var raw = await AskKernel(kernel, prompt);
        return Results.Ok(new { Completion = StripFences(raw).TrimStart() });
    }
    catch (TimeoutException ex) { return Results.Problem(ex.Message, statusCode: 504); }
});

// ─────────────────────────────────────────────────────────────
//  /rename-symbol — suggest better name for a variable/method (NEW)
// ─────────────────────────────────────────────────────────────
app.MapPost("/rename-symbol", async (RenameRequest req, Kernel kernel) =>
{
    if (string.IsNullOrWhiteSpace(req.Symbol))
        return Results.BadRequest("Symbol cannot be empty.");

    var codeCtx = string.IsNullOrWhiteSpace(req.Code) ? "" : $"\n\nContext code:\n{req.Code}";

    var prompt = $"""
You are a senior developer helping rename a code symbol for clarity.
Symbol to rename: {req.Symbol}
Symbol kind: {req.Kind ?? "unknown"} (e.g. variable, method, class, parameter){codeCtx}

Suggest 3 better names. For each one explain WHY it is clearer.
Format:
1. <name> — <reason>
2. <name> — <reason>
3. <name> — <reason>
""";
    try
    {
        var raw = await AskKernel(kernel, prompt);
        return Results.Ok(new
        {
            OriginalSymbol = req.Symbol,
            Suggestions    = raw.Trim()
        });
    }
    catch (TimeoutException ex) { return Results.Problem(ex.Message, statusCode: 504); }
});

// ─────────────────────────────────────────────────────────────
//  /explain-method — explain a specific C# method by name
// ─────────────────────────────────────────────────────────────
app.MapPost("/explain-method", async (ExplainMethodRequest req, Kernel kernel) =>
{
    if (!File.Exists(req.FilePath))
        return Results.NotFound($"File not found: {req.FilePath}");

    var code   = await File.ReadAllTextAsync(req.FilePath);
    var root   = await CSharpSyntaxTree.ParseText(code).GetRootAsync();
    var method = root.DescendantNodes()
        .OfType<MethodDeclarationSyntax>()
        .FirstOrDefault(m => m.Identifier.Text.Equals(req.MethodName, StringComparison.OrdinalIgnoreCase));

    if (method is null)
        return Results.NotFound($"Method '{req.MethodName}' not found in {Path.GetFileName(req.FilePath)}.");

    var methodCode = method.ToFullString();

    var prompt = $"""
You are a senior .NET developer.
Explain the following C# method. Cover: purpose, parameters, return value, important logic, edge cases.

Method:
{methodCode}

Explanation:
""";
    try
    {
        var explanation = await AskKernel(kernel, prompt);
        return Results.Ok(new
        {
            Method      = req.MethodName,
            Code        = methodCode,
            Explanation = explanation.Trim()
        });
    }
    catch (TimeoutException ex) { return Results.Problem(ex.Message, statusCode: 504); }
});

// ─────────────────────────────────────────────────────────────
//  /apply-fix — suggest a fix for a C# method (no disk write yet)
// ─────────────────────────────────────────────────────────────
app.MapPost("/apply-fix", async (ApplyFixRequest req, Kernel kernel) =>
{
    if (!File.Exists(req.FilePath))
        return Results.NotFound($"File not found: {req.FilePath}");

    var code   = await File.ReadAllTextAsync(req.FilePath);
    var root   = await CSharpSyntaxTree.ParseText(code).GetRootAsync();
    var method = root.DescendantNodes()
        .OfType<MethodDeclarationSyntax>()
        .FirstOrDefault(m => m.Identifier.Text.Equals(req.MethodName, StringComparison.OrdinalIgnoreCase));

    if (method is null)
        return Results.NotFound($"Method '{req.MethodName}' not found.");

    var methodCode = method.ToFullString();

    var prompt = $"""
You are a senior .NET developer.
Fix the following C# method to resolve this issue:

ISSUE: {req.IssueDescription}

Rules:
- Return ONLY the corrected method
- No explanations, no markdown fences
- Keep the same method signature unless the bug IS in the signature
- Preserve all existing XML doc comments

Method:
{methodCode}
""";
    try
    {
        var raw           = await AskKernel(kernel, prompt);
        var suggestedCode = StripFences(raw);

        return Results.Ok(new
        {
            Method        = req.MethodName,
            OriginalCode  = methodCode,
            SuggestedCode = suggestedCode,
            RequiresApproval = true,
            Message = "Review the diff, then POST /confirm-fix to apply."
        });
    }
    catch (TimeoutException ex) { return Results.Problem(ex.Message, statusCode: 504); }
});

// ─────────────────────────────────────────────────────────────
//  /confirm-fix — write method fix to disk using Roslyn
// ─────────────────────────────────────────────────────────────
app.MapPost("/confirm-fix", async (ConfirmFixRequest req) =>
{
    if (!File.Exists(req.FilePath))
        return Results.NotFound($"File not found: {req.FilePath}");
    if (string.IsNullOrWhiteSpace(req.SuggestedCode))
        return Results.BadRequest("SuggestedCode cannot be empty.");

    var sourceCode   = await File.ReadAllTextAsync(req.FilePath);
    var originalRoot = await CSharpSyntaxTree.ParseText(sourceCode).GetRootAsync();

    var oldMethod = originalRoot.DescendantNodes()
        .OfType<MethodDeclarationSyntax>()
        .FirstOrDefault(m => m.Identifier.Text.Equals(req.MethodName, StringComparison.OrdinalIgnoreCase));

    if (oldMethod is null)
        return Results.NotFound($"Method '{req.MethodName}' not found.");

    // The model may wrap the method in a class — find it wherever it sits
    var suggestedRoot = await CSharpSyntaxTree.ParseText(req.SuggestedCode).GetRootAsync();
    var newMethod     = suggestedRoot.DescendantNodes()
        .OfType<MethodDeclarationSyntax>()
        .FirstOrDefault();

    // Fallback: if model returned ONLY a body, wrap and re-parse
    if (newMethod is null)
    {
        var wrapped = "class __Temp {\n" + req.SuggestedCode + "\n}";
        var wrapRoot = await CSharpSyntaxTree.ParseText(wrapped).GetRootAsync();
        newMethod    = wrapRoot.DescendantNodes().OfType<MethodDeclarationSyntax>().FirstOrDefault();
    }

    if (newMethod is null)
        return Results.BadRequest(
            "Could not parse a method from SuggestedCode. " +
            "Ensure /apply-fix SuggestedCode contains a valid method declaration.");

    var updatedRoot = originalRoot.ReplaceNode(oldMethod, newMethod);

    using var workspace = new AdhocWorkspace();
    var formattedRoot   = Formatter.Format(updatedRoot, workspace);

    File.Copy(req.FilePath, req.FilePath + ".bak", overwrite: true);
    await File.WriteAllTextAsync(req.FilePath, formattedRoot.ToFullString());

    return Results.Ok(new
    {
        Success = true,
        Backup  = req.FilePath + ".bak",
        Message = $"Method '{req.MethodName}' updated successfully."
    });
});

// ─────────────────────────────────────────────────────────────
//  /build-project
// ─────────────────────────────────────────────────────────────
app.MapPost("/build-project", async (BuildRequest req) =>
{
    if (!Directory.Exists(req.ProjectPath))
        return Results.NotFound($"Path not found: {req.ProjectPath}");

    var (exitCode, output, errors) = await RunProcess("dotnet", "build", req.ProjectPath);
    return Results.Ok(new
    {
        Success  = exitCode == 0,
        ExitCode = exitCode,
        Output   = output,
        Errors   = errors
    });
});

// ─────────────────────────────────────────────────────────────
//  /fix-build-errors
// ─────────────────────────────────────────────────────────────
app.MapPost("/fix-build-errors", async (BuildRequest req, Kernel kernel) =>
{
    if (!Directory.Exists(req.ProjectPath))
        return Results.NotFound($"Path not found: {req.ProjectPath}");

    var (exitCode, output, errors) = await RunProcess("dotnet", "build", req.ProjectPath);
    if (exitCode == 0)
        return Results.Ok(new { Success = true, Message = "Build succeeded — no errors." });

    var combined   = output + "\n" + errors;
    var structured = ParseBuildErrors(combined);

    var prompt = $"""
You are a senior .NET developer. The build output below contains compiler errors.
For each error, give:
FILE: <filename>
LINE: <line number>
PROBLEM: <clear description>
FIX: <exact code change to make>
---

Build Output:
{combined}
""";
    try
    {
        var analysis = await AskKernel(kernel, prompt);
        return Results.Ok(new
        {
            Success          = false,
            RawOutput        = combined,
            Analysis         = analysis.Trim(),
            ErrorsStructured = structured
        });
    }
    catch (TimeoutException ex) { return Results.Problem(ex.Message, statusCode: 504); }
});

// ─────────────────────────────────────────────────────────────
//  /scan-and-build
// ─────────────────────────────────────────────────────────────
app.MapPost("/scan-and-build", async (BuildRequest req) =>
{
    if (!Directory.Exists(req.ProjectPath))
        return Results.NotFound($"Path not found: {req.ProjectPath}");

    var (exitCode, output, errors) = await RunProcess("dotnet", "build", req.ProjectPath);

    var csFiles = Directory.GetFiles(req.ProjectPath, "*.cs", SearchOption.AllDirectories)
        .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}")
                 && !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}"))
        .ToList();

    var fileContents = new Dictionary<string, string>();
    foreach (var file in csFiles.Take(10))
    {
        try { fileContents[Path.GetFileName(file)] = await File.ReadAllTextAsync(file); }
        catch { /* skip unreadable */ }
    }

    return Results.Ok(new
    {
        BuildSuccess     = exitCode == 0,
        Output           = output,
        Errors           = errors,
        ErrorsStructured = ParseBuildErrors(output + "\n" + errors),
        ProjectPath      = req.ProjectPath,
        FileCount        = csFiles.Count,
        Files            = fileContents,
        ExitCode         = exitCode
    });
});

// ─────────────────────────────────────────────────────────────
//  /fix-with-context
// ─────────────────────────────────────────────────────────────
app.MapPost("/fix-with-context", async (FixWithContextRequest req, Kernel kernel) =>
{
    if (string.IsNullOrWhiteSpace(req.FilePath))    return Results.BadRequest("FilePath is required.");
    if (string.IsNullOrWhiteSpace(req.FileContent)) return Results.BadRequest("FileContent is required.");

    var contextSection = req.ProjectFiles?.Count > 0
        ? string.Join("\n\n---\n\n",
            req.ProjectFiles.Select(kv => $"// File: {kv.Key}\n{kv.Value}"))
        : "(no additional project files provided)";

    var prompt = $"""
You are a senior software developer.
Fix the file below so that ALL listed build errors are resolved.

BUILD ERRORS:
{req.BuildErrors}

FILE TO FIX ({Path.GetFileName(req.FilePath)}):
{req.FileContent}

OTHER PROJECT FILES (for reference only — do NOT modify or return them):
{contextSection}

Rules:
- Return ONLY the complete corrected content of the target file
- Do NOT include markdown fences
- Preserve all logic that is not broken
- Add necessary using/import statements if they are missing
""";
    try
    {
        var raw = await AskKernel(kernel, prompt);
        return Results.Ok(new
        {
            SuggestedFix     = StripFences(raw),
            FixedFileName    = Path.GetFileName(req.FilePath),
            RequiresApproval = true,
            Message          = "Review then call /confirm-file-fix to write to disk."
        });
    }
    catch (TimeoutException ex) { return Results.Problem(ex.Message, statusCode: 504); }
});

// ─────────────────────────────────────────────────────────────
//  /confirm-file-fix — write whole-file fix to disk
// ─────────────────────────────────────────────────────────────
app.MapPost("/confirm-file-fix", async (ConfirmFileFix req) =>
{
    if (!File.Exists(req.FilePath))                   return Results.NotFound($"File not found: {req.FilePath}");
    if (string.IsNullOrWhiteSpace(req.NewContent))    return Results.BadRequest("NewContent cannot be empty.");

    File.Copy(req.FilePath, req.FilePath + ".bak", overwrite: true);
    await File.WriteAllTextAsync(req.FilePath, req.NewContent);

    return Results.Ok(new
    {
        Success = true,
        Backup  = req.FilePath + ".bak",
        Message = "File updated successfully."
    });
});

// ─────────────────────────────────────────────────────────────
//  /scan-project — list classes and methods
// ─────────────────────────────────────────────────────────────
app.MapPost("/scan-project", async (BuildRequest req) =>
{
    if (!Directory.Exists(req.ProjectPath))
        return Results.NotFound($"Path not found: {req.ProjectPath}");

    var files     = Directory.GetFiles(req.ProjectPath, "*.cs", SearchOption.AllDirectories)
        .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}")
                 && !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}"))
        .ToList();

    var summaries = new List<object>();
    foreach (var file in files)
    {
        try
        {
            var code = await File.ReadAllTextAsync(file);
            var root = await CSharpSyntaxTree.ParseText(code).GetRootAsync();
            summaries.Add(new
            {
                File    = file,
                Classes = root.DescendantNodes().OfType<ClassDeclarationSyntax>()
                              .Select(c => c.Identifier.Text).ToList(),
                Methods = root.DescendantNodes().OfType<MethodDeclarationSyntax>()
                              .Select(m => new
                              {
                                  Name       = m.Identifier.Text,
                                  ReturnType = m.ReturnType.ToString(),
                                  Parameters = m.ParameterList.Parameters
                                      .Select(p => $"{p.Type} {p.Identifier}").ToList(),
                                  Line       = m.GetLocation().GetLineSpan().StartLinePosition.Line + 1
                              }).ToList()
            });
        }
        catch { /* skip */ }
    }

    return Results.Ok(summaries);
});

app.Run("http://localhost:5050");

// ─────────────────────────────────────────────────────────────
//  CONVERSATION STORE
// ─────────────────────────────────────────────────────────────
public class ConversationStore
{
    private readonly ConcurrentDictionary<string, List<ChatMessage>> _sessions = new();

    public string Create()
    {
        var id = Guid.NewGuid().ToString("N")[..12];
        _sessions[id] = new List<ChatMessage>();
        return id;
    }

    public void Append(string id, IEnumerable<ChatMessage> msgs)
    {
        if (!_sessions.ContainsKey(id)) _sessions[id] = new List<ChatMessage>();
        _sessions[id].AddRange(msgs);
    }

    public List<ChatMessage> Get(string id) =>
        _sessions.TryGetValue(id, out var s) ? s : new List<ChatMessage>();

    public void Delete(string id) => _sessions.TryRemove(id, out _);
}

// ─────────────────────────────────────────────────────────────
//  RECORDS / MODELS
// ─────────────────────────────────────────────────────────────
public record AskRequest(string Question);
public record CodeRequest(string Code);
public record FixSnippetRequest(string Code, string Error);
public record RefactorRequest(string Code, string? Goal);
public record CompleteCodeRequest(string Prefix, string? Suffix, string? ContextHint);
public record RenameRequest(string Symbol, string? Kind, string? Code);
public record ExplainMethodRequest(string FilePath, string MethodName);
public record ApplyFixRequest(string FilePath, string MethodName, string IssueDescription);
public record ConfirmFixRequest(string FilePath, string MethodName, string SuggestedCode);
public record ConfirmFileFix(string FilePath, string NewContent);
public record BuildRequest(string ProjectPath);
public record FixWithContextRequest(
    string FilePath,
    string FileContent,
    string BuildErrors,
    Dictionary<string, string>? ProjectFiles);
public record ChatMessage(string Role, string Content);
public record ChatRequest(List<ChatMessage> Messages, string? SessionId);
public record BuildError(string File, int Line, int Column, string Severity, string Code, string Message);

// ─────────────────────────────────────────────────────────────
//  STARTUP CHECKS
// ─────────────────────────────────────────────────────────────
static class StartupChecks
{
    public static async Task EnsureOllamaReady()
    {
        // 1. Is ollama CLI installed?
        var (exitCode, _, _) = await RunQuiet("ollama", "--version");
        if (exitCode != 0)
        {
            Console.ForegroundColor = ConsoleColor.Red;
            Console.Error.WriteLine("ERROR: Ollama is not installed or not on PATH.");
            Console.Error.WriteLine("Download: https://ollama.com/download");
            Console.ResetColor();
            throw new InvalidOperationException("Ollama not found. See console for instructions.");
        }

        // 2. Is Ollama server running?
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        bool serverRunning;
        try
        {
            await http.GetStringAsync("http://localhost:11434/api/tags");
            serverRunning = true;
        }
        catch
        {
            serverRunning = false;
        }

        if (!serverRunning)
        {
            Console.ForegroundColor = ConsoleColor.Yellow;
            Console.WriteLine("Ollama server is not running — starting it now...");
            Console.ResetColor();

            Process.Start(new ProcessStartInfo
            {
                FileName        = "ollama",
                Arguments       = "serve",
                UseShellExecute = true,
                CreateNoWindow  = false
            });

            for (var i = 0; i < 10; i++)
            {
                await Task.Delay(1000);
                try
                {
                    await http.GetStringAsync("http://localhost:11434/api/tags");
                    Console.ForegroundColor = ConsoleColor.Green;
                    Console.WriteLine("Ollama server started successfully.");
                    Console.ResetColor();
                    serverRunning = true;
                    break;
                }
                catch { /* keep waiting */ }
            }

            if (!serverRunning)
                throw new InvalidOperationException(
                    "Could not start Ollama. Please run 'ollama serve' in a separate terminal.");
        }

        // 3. Is the model present?
        var tagsJson = await http.GetStringAsync("http://localhost:11434/api/tags");
        if (tagsJson.Contains("qwen2.5-coder:7b")) return;

        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine("Model qwen2.5-coder:7b is not installed.");
        Console.Write("Download now? (Y/N): ");
        Console.ResetColor();

        var answer = Console.ReadLine();
        if (!string.Equals(answer?.Trim(), "Y", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Model not available. Run: ollama pull qwen2.5-coder:7b");

        Console.WriteLine("Downloading qwen2.5-coder:7b — this may take a few minutes...");

        var pull = new Process
        {
            StartInfo = new ProcessStartInfo
            {
                FileName               = "ollama",
                Arguments              = "pull qwen2.5-coder:7b",
                RedirectStandardOutput = true,
                RedirectStandardError  = true,
                UseShellExecute        = false,
                CreateNoWindow         = true
            }
        };
        pull.OutputDataReceived += (_, e) => { if (e.Data != null) Console.WriteLine(e.Data); };
        pull.ErrorDataReceived  += (_, e) => { if (e.Data != null) Console.WriteLine(e.Data); };
        pull.Start();
        pull.BeginOutputReadLine();
        pull.BeginErrorReadLine();
        await pull.WaitForExitAsync();

        if (pull.ExitCode != 0)
            throw new InvalidOperationException(
                "Model download failed. Run manually: ollama pull qwen2.5-coder:7b");

        Console.ForegroundColor = ConsoleColor.Green;
        Console.WriteLine("Model ready. Starting DevPilot...");
        Console.ResetColor();
    }

    private static async Task<(int ExitCode, string Output, string Errors)> RunQuiet(string file, string args)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName               = file,
                Arguments              = args,
                RedirectStandardOutput = true,
                RedirectStandardError  = true,
                UseShellExecute        = false,
                CreateNoWindow         = true
            };
            using var p = new Process { StartInfo = psi };
            p.Start();
            var output = await p.StandardOutput.ReadToEndAsync();
            var errors = await p.StandardError.ReadToEndAsync();
            await p.WaitForExitAsync();
            return (p.ExitCode, output, errors);
        }
        catch
        {
            return (-1, string.Empty, string.Empty);
        }
    }
}
