import * as path from "path";
import type { ExtensionContext } from "vscode";
import { LanguageClient, TransportKind } from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export function activate(context: ExtensionContext) {
    const serverModule = context.asAbsolutePath(
        path.join("server", "mdls.cjs"),
    );

    client = new LanguageClient(
        "mdls",
        "mdls",
        { module: serverModule, transport: TransportKind.ipc },
        { documentSelector: [{ language: "json" }, { language: "jsonc" }] },
    );

    void client.start();
}

export function deactivate() {
    return client?.stop();
}
