import {
    createConnection,
    TextDocuments,
    ProposedFeatures,
    CompletionItemKind,
    TextDocumentSyncKind,
    type InitializeParams,
    type CompletionItem,
    type TextDocumentPositionParams,
    type InitializeResult,
    type Range,
    type Location,
    type WorkDoneProgressReporter,
} from "vscode-languageserver/node";

import { TextDocument } from "vscode-languageserver-textdocument";
import { findNodeAtOffset, parseTree, type Node } from "jsonc-parser";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

type FareModelDef = { fareModel: FareModel; uri: string; range: Range };
type FareModel = { code: string; version: string };
type FareModelRef = { key: string; uri: string; range: Range };

const defsByName = new Map<string, FareModelDef[]>();
const defsByUri = new Map<string, FareModelDef[]>();
const refsByName = new Map<string, FareModelRef[]>();
const refsByUri = new Map<string, FareModelRef[]>();

let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize((params: InitializeParams) => {
    const capabilities = params.capabilities;

    hasDiagnosticRelatedInformationCapability =
        !!capabilities.textDocument?.publishDiagnostics?.relatedInformation;

    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            definitionProvider: true,
            referencesProvider: true,
        },
    };
    return result;
});

connection.onInitialized(() => {});

connection.onDidChangeConfiguration((change) => {
    connection.languages.diagnostics.refresh();
});

documents.onDidClose((e) => {
    forgetDoc(e.document.uri);
});

const PROGRESS_THRESHOLD = 100_000;

documents.onDidChangeContent(async (change) => {
    const doc = change.document;
    if (doc.getText().length < PROGRESS_THRESHOLD) {
        index(doc);
        return;
    }

    const version = doc.version;
    const progress = await connection.window.createWorkDoneProgress();
    if (documents.get(doc.uri)?.version !== version) {
        progress.done();
        return;
    }

    progress.begin("Indexing", 0, doc.uri);
    try {
        index(doc, progress);
    } finally {
        progress.done();
    }
});

function forgetDoc(uri: string) {
    for (const def of defsByUri.get(uri) ?? []) {
        const arr = defsByName.get(def.fareModel.code);
        if (!arr) continue;
        const kept = arr.filter((d) => d.uri !== uri);
        if (kept.length) defsByName.set(def.fareModel.code, kept);
        else defsByName.delete(def.fareModel.code);
    }
    defsByUri.delete(uri);

    for (const ref of refsByUri.get(uri) ?? []) {
        const arr = refsByName.get(ref.key);
        if (!arr) continue;
        const kept = arr.filter((r) => r.uri !== uri);
        if (kept.length) refsByName.set(ref.key, kept);
        else refsByName.delete(ref.key);
    }
    refsByUri.delete(uri);
}

function index(
    textDocument: TextDocument,
    progress?: WorkDoneProgressReporter,
) {
    forgetDoc(textDocument.uri);

    const text = textDocument.getText();
    const root = parseTree(text);
    if (!root) return;

    let lastPct = 0;
    walk(root, (node) => {
        if (progress) {
            const pct = (node.offset / text.length) * 100;
            if (pct - lastPct >= 10) {
                lastPct = pct;
                progress.report(pct);
            }
        }

        if (node.type === "object") {
            const codeNode = propValueNode(node, "code");

            if (!codeNode || typeof codeNode.value !== "string") return;
            const fareModel: FareModel | null = parseCode(codeNode.value);

            if (fareModel === null) return;

            const def: FareModelDef = {
                fareModel: fareModel,
                uri: textDocument.uri,
                range: {
                    start: textDocument.positionAt(codeNode.offset),
                    end: textDocument.positionAt(
                        codeNode.offset + codeNode.length,
                    ),
                },
            };

            push(defsByName, fareModel.code, def);
            push(defsByUri, textDocument.uri, def);
            return;
        }

        if (
            node.type === "string" &&
            typeof node.value === "string" &&
            node.value.includes("@") &&
            !node.value.includes("?") &&
            !isCodeValue(node)
        ) {
            const target = enclosingCodeNode(node) ?? node;
            const ref: FareModelRef = {
                key: codeKey(node.value),
                uri: textDocument.uri,
                range: {
                    start: textDocument.positionAt(target.offset),
                    end: textDocument.positionAt(target.offset + target.length),
                },
            };

            push(refsByName, ref.key, ref);
            push(refsByUri, textDocument.uri, ref);
        }
    });
}

function enclosingCodeNode(node: Node): Node | undefined {
    for (let cur = node.parent; cur; cur = cur.parent) {
        if (cur.type !== "object") continue;
        const codeNode = propValueNode(cur, "code");
        if (
            codeNode &&
            typeof codeNode.value === "string" &&
            parseCode(codeNode.value)
        ) {
            return codeNode;
        }
    }
    return undefined;
}

function isCodeValue(node: Node): boolean {
    const p = node.parent;
    return p?.type === "property" && p.children?.[0]?.value === "code";
}

function parseCode(code: string): FareModel | null {
    const at = code?.indexOf("@");
    const questionMark = code?.indexOf("?");

    if (at < 1 || questionMark < 0) return null;

    return {
        code: code.slice(0, questionMark),
        version: code.slice(questionMark + 1),
    };
}

function propValueNode(obj: Node, key: string): Node | undefined {
    const p = obj.children?.find(
        (c) => c.type === "property" && c.children?.[0]?.value === key,
    );
    return p?.children?.[1];
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
    const a = m.get(k) ?? [];
    a.push(v);
    m.set(k, a);
}

function walk(node: Node, fn: (n: Node) => void) {
    fn(node);
    node.children?.forEach((c) => walk(c, fn));
}

connection.onDidChangeWatchedFiles((_change) => {
    connection.console.log("We received a file change event");
});

connection.onCompletion(
    (_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
        return [
            { label: "TypeScript", kind: CompletionItemKind.Text, data: 1 },
            { label: "JavaScript", kind: CompletionItemKind.Text, data: 2 },
        ];
    },
);

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

function codeKey(code: string): string {
    const q = code.indexOf("?");
    return q >= 0 ? code.slice(0, q) : code;
}

function refAtCursor(doc: TextDocument, offset: number): string | null {
    const root = parseTree(doc.getText());
    if (!root) return null;

    const node = findNodeAtOffset(root, offset, true);

    if (node?.type !== "string" || typeof node.value !== "string") return null;
    if (!node.value.includes("@")) return null;

    return codeKey(node.value);
}

connection.onDefinition(({ textDocument, position }) => {
    const doc = documents.get(textDocument.uri);
    if (!doc) return null;

    const key = refAtCursor(doc, doc.offsetAt(position));
    if (!key) return null;

    const defs = (defsByName.get(key) ?? [])
        .slice()
        .sort((a, b) =>
            a.fareModel.version.localeCompare(b.fareModel.version, undefined, {
                numeric: true,
            }),
        );
    return defs.map<Location>((d) => ({ uri: d.uri, range: d.range }));
});

connection.onReferences(({ textDocument, position }) => {
    const doc = documents.get(textDocument.uri);
    if (!doc) return null;

    const key = refAtCursor(doc, doc.offsetAt(position));
    if (!key) return null;

    return (refsByName.get(key) ?? []).map((r) => ({
        uri: r.uri,
        range: r.range,
    }));
});

documents.listen(connection);

connection.listen();
