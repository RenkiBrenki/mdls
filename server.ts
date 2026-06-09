import {
        createConnection,
        TextDocuments,
        Diagnostic,
        DiagnosticSeverity,
        ProposedFeatures,
        InitializeParams,
        CompletionItem,
        CompletionItemKind,
        TextDocumentPositionParams,
        TextDocumentSyncKind,
        InitializeResult,
        DocumentDiagnosticReportKind,
        type DocumentDiagnosticReport,
} from "vscode-languageserver/node";

import { TextDocument } from "vscode-languageserver-textdocument";

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents = new TextDocuments(TextDocument);

type Def = { name: string; version: string; uri: string; range: Range };

const defsByName = new Map<string, Def[]>();
const defsByUri = new Map<string, Def[]>();

let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize((params: InitializeParams) => {
        const capabilities = params.capabilities;

        hasDiagnosticRelatedInformationCapability = !!(
                capabilities.textDocument &&
                capabilities.textDocument.publishDiagnostics &&
                capabilities.textDocument.publishDiagnostics.relatedInformation
        );

        const result: InitializeResult = {
                capabilities: {
                        textDocumentSync: TextDocumentSyncKind.Incremental,
                        // Tell the client that this server supports code completion.
                        completionProvider: { resolveProvider: true },
                        diagnosticProvider: {
                                interFileDependencies: false,
                                workspaceDiagnostics: false,
                        },
                },
        };
        return result;
});

connection.onInitialized(() => {});

// The example settings
interface ExampleSettings {
        maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: ExampleSettings = { maxNumberOfProblems: 1000 };

// Cache the settings of all open documents
const documentSettings = new Map<string, Thenable<ExampleSettings>>();

connection.onDidChangeConfiguration((change) => {
        // Refresh the diagnostics since the `maxNumberOfProblems` could have changed.
        // We could optimize things here and re-fetch the setting first can compare it
        // to the existing setting, but this is out of scope for this example.
        connection.languages.diagnostics.refresh();
});

function getDocumentSettings(resource: string): Thenable<ExampleSettings> {
        let result = documentSettings.get(resource);
        if (!result) {
                result = connection.workspace
                        .getConfiguration({
                                scopeUri: resource,
                                section: "languageServerExample",
                        })
                        .then((settings) => settings ?? defaultSettings);
                documentSettings.set(resource, result);
        }
        return result;
}

// Only keep settings for open documents
documents.onDidClose((e) => {
        documentSettings.delete(e.document.uri);
});

connection.languages.diagnostics.on(async (params) => {
        const document = documents.get(params.textDocument.uri);
        if (document !== undefined) {
                return {
                        kind: DocumentDiagnosticReportKind.Full,
                        items: await index(document),
                } satisfies DocumentDiagnosticReport;
        } else {
                // We don't know the document. We can either try to read it from disk
                // or we don't report problems for it.
                return {
                        kind: DocumentDiagnosticReportKind.Full,
                        items: [],
                } satisfies DocumentDiagnosticReport;
        }
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((change) => {
        index(change.document);
});

async function index(textDocument: TextDocument): Promise<Diagnostic[]> {
        const diagnostics: Diagnostic[] = [];

        const diagnostic: Diagnostic = {
                severity: DiagnosticSeverity.Warning,
                range: {
                        start: textDocument.positionAt(0),
                        end: textDocument.positionAt(3),
                },
                message: `wrong.`,
                source: "ex",
        };

        diagnostics.push(diagnostic);

        return diagnostics;
}

connection.onDidChangeWatchedFiles((_change) => {
        // Monitored files have change in VSCode
        connection.console.log("We received a file change event");
});

// This handler provides the initial list of the completion items.
connection.onCompletion(
        (
                _textDocumentPosition: TextDocumentPositionParams,
        ): CompletionItem[] => {
                // The pass parameter contains the position of the text document in
                // which code complete got requested. For the example we ignore this
                // info and always provide the same completion items.
                return [
                        {
                                label: "TypeScript",
                                kind: CompletionItemKind.Text,
                                data: 1,
                        },
                        {
                                label: "JavaScript",
                                kind: CompletionItemKind.Text,
                                data: 2,
                        },
                ];
        },
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
        if (item.data === 1) {
                item.detail = "TypeScript details";
                item.documentation = "TypeScript documentation";
        } else if (item.data === 2) {
                item.detail = "JavaScript details";
                item.documentation = "JavaScript documentation";
        }
        return item;
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
