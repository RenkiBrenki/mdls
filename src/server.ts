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
} from "vscode-languageserver/node";

import { TextDocument } from "vscode-languageserver-textdocument";
import { findNodeAtOffset, parseTree, type Node } from "jsonc-parser";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

type FareModelDef = { fareModel: FareModel; uri: string; range: Range };
type FareModel = { code: string; version: string };

const defsByName = new Map<string, FareModelDef[]>();
const defsByUri = new Map<string, FareModelDef[]>();

let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize((params: InitializeParams) => {
    const capabilities = params.capabilities;

    hasDiagnosticRelatedInformationCapability = !!capabilities.textDocument?.publishDiagnostics?.relatedInformation;

    const result: InitializeResult = {
        capabilities: { textDocumentSync: TextDocumentSyncKind.Incremental, definitionProvider: true },
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

documents.onDidChangeContent((change) => {
    index(change.document);
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
}

function index(textDocument: TextDocument) {
    forgetDoc(textDocument.uri);

    const root = parseTree(textDocument.getText());
    if (!root) return;

    walk(root, (node) => {
        if (node.type !== "object") return;
        const codeNode = propValueNode(node, "code");

        if (!codeNode || typeof codeNode.value !== "string") return;
        const fareModel: FareModel | null = parseCode(codeNode.value);

        if (fareModel === null) return;

        const def: FareModelDef = {
            fareModel: fareModel,
            uri: textDocument.uri,
            range: rangeOf(textDocument, codeNode),
        };

        push(defsByName, fareModel.code, def);
        push(defsByUri, textDocument.uri, def);
    });
}

const rangeOf = (doc: TextDocument, n: Node): Range => ({
    start: doc.positionAt(n.offset),
    end: doc.positionAt(n.offset + n.length),
});

function parseCode(code: string): FareModel | null {
    const at = code?.indexOf("@");
    const questionMark = code?.indexOf("?");

    if (at < 1 || questionMark < 0) return null;

    return { code: code.slice(0, questionMark), version: code.slice(questionMark + 1) };
}

function propValueNode(obj: Node, key: string): Node | undefined {
    const p = obj.children?.find((c) => c.type === "property" && c.children?.[0]?.value === key);
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

connection.onCompletion((_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
    return [
        { label: "TypeScript", kind: CompletionItemKind.Text, data: 1 },
        { label: "JavaScript", kind: CompletionItemKind.Text, data: 2 },
    ];
});

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
        .sort((a, b) => a.fareModel.version.localeCompare(b.fareModel.version, undefined, { numeric: true }));
    return defs.map<Location>((d) => ({ uri: d.uri, range: d.range }));
});

documents.listen(connection);

connection.listen();
