import { container, injectable } from "tsyringe";
import {
  CancellationToken,
  CancellationTokenSource,
  Connection,
  Diagnostic,
  FileChangeType,
} from "vscode-languageserver";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import { IElmWorkspace } from "../../elmWorkspace";
import { GetDiagnosticsRequest } from "../../protocol";
import { Delayer } from "../../util/delayer";
import { ElmWorkspaceMatcher } from "../../util/elmWorkspaceMatcher";
import { MultistepOperation } from "../../util/multistepOperation";
import { IClientSettings } from "../../util/settings";
import { TextDocumentEvents } from "../../util/textDocumentEvents";
import { ASTProvider } from "../astProvider";
import { ElmLsDiagnostics } from "./elmLsDiagnostics";
import { ElmMakeDiagnostics } from "./elmMakeDiagnostics";
import { DiagnosticKind, FileDiagnostics } from "./fileDiagnostics";
import { TypeInferenceDiagnostics } from "./typeInferenceDiagnostics";

export interface IElmIssueRegion {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

export interface IElmIssue {
  tag: string;
  overview: string;
  subregion: string;
  details: string;
  region: IElmIssueRegion;
  type: string;
  file: string;
}

class PendingDiagnostics extends Map<string, number> {
  public getOrderedFiles(): string[] {
    return Array.from(this.entries())
      .sort((a, b) => a[1] - b[1])
      .map((a) => a[0]);
  }
}

interface IPendingRequest {
  token: CancellationTokenSource;
  files: string[];
}

@injectable()
export class DiagnosticsProvider {
  private elmMakeDiagnostics: ElmMakeDiagnostics;
  private typeInferenceDiagnostics: TypeInferenceDiagnostics;
  private elmLsDiagnostics: ElmLsDiagnostics;
  private currentDiagnostics: Map<string, FileDiagnostics>;
  private events: TextDocumentEvents;
  private connection: Connection;
  private clientSettings: IClientSettings;
  private workspaces: IElmWorkspace[];
  private elmWorkspaceMatcher: ElmWorkspaceMatcher<URI>;
  private documentEvents: TextDocumentEvents;

  private pendingRequest: IPendingRequest | undefined;
  private pendingDiagnostics: PendingDiagnostics;
  private diagnosticsDelayer: Delayer<any>;
  private diagnosticsOperation: MultistepOperation;
  private changeSeq = 0;

  constructor() {
    this.clientSettings = container.resolve("ClientSettings");

    this.elmMakeDiagnostics = container.resolve(ElmMakeDiagnostics);
    this.typeInferenceDiagnostics = container.resolve(TypeInferenceDiagnostics);
    this.elmLsDiagnostics = container.resolve(ElmLsDiagnostics);
    this.documentEvents = container.resolve(TextDocumentEvents);

    this.connection = container.resolve("Connection");
    this.events = container.resolve(TextDocumentEvents);
    this.elmWorkspaceMatcher = new ElmWorkspaceMatcher((uri) => uri);
    this.diagnosticsOperation = new MultistepOperation(this.connection);

    this.workspaces = container.resolve("ElmWorkspaces");

    const astProvider = container.resolve(ASTProvider);

    this.currentDiagnostics = new Map<string, FileDiagnostics>();
    this.pendingDiagnostics = new PendingDiagnostics();
    this.diagnosticsDelayer = new Delayer(300);

    this.events.on(
      "open",
      (d: { document: TextDocument }) =>
        void this.getElmMakeDiagnostics(d.document.uri),
    );
    this.events.on(
      "save",
      (d: { document: TextDocument }) =>
        void this.getElmMakeDiagnostics(d.document.uri),
    );

    this.connection.onDidChangeWatchedFiles((event) => {
      const newDeleteEvents = event.changes
        .filter((a) => a.type === FileChangeType.Deleted)
        .map((a) => a.uri);
      newDeleteEvents.forEach((uri) => {
        this.deleteDiagnostics(uri);
      });
    });

    const clientInitiatedDiagnostics =
      this.clientSettings.extendedCapabilities?.clientInitiatedDiagnostics ??
      false;

    if (clientInitiatedDiagnostics) {
      this.connection.onRequest(
        GetDiagnosticsRequest,
        (params, cancellationToken) =>
          this.getDiagnostics(params.files, params.delay, cancellationToken),
      );
    }

    this.connection.onDidChangeConfiguration((params) => {
      this.clientSettings = <IClientSettings>params.settings;

      if (this.clientSettings.disableElmLSDiagnostics) {
        this.currentDiagnostics.forEach((_, uri) =>
          this.updateDiagnostics(uri, DiagnosticKind.ElmLS, []),
        );
      } else {
        this.workspaces.forEach((workspace) => {
          workspace.getForest().treeMap.forEach((treeContainer) => {
            if (treeContainer.writeable) {
              this.updateDiagnostics(
                treeContainer.uri,
                DiagnosticKind.ElmLS,
                this.elmLsDiagnostics.createDiagnostics(
                  treeContainer,
                  workspace,
                ),
              );
            }
          });
        });
      }
    });

    if (!clientInitiatedDiagnostics) {
      this.requestAllDiagnostics();
    }

    astProvider.onTreeChange(({ treeContainer, declaration }) => {
      if (!clientInitiatedDiagnostics) {
        if (this.pendingRequest) {
          this.pendingRequest.token.cancel();
        }

        this.requestDiagnostics(treeContainer.uri);
      }
    });

    this.documentEvents.on("change", () => {
      this.change();
      this.typeInferenceDiagnostics.change();
    });
  }

  private requestDiagnostics(uri: string): void {
    this.pendingDiagnostics.set(uri, Date.now());
    this.triggerDiagnostics();
  }

  private requestAllDiagnostics(): void {
    this.workspaces.forEach((workspace) => {
      workspace.getForest().treeMap.forEach(({ uri, writeable }) => {
        if (writeable) {
          this.pendingDiagnostics.set(uri, Date.now());
        }
      });
    });

    this.triggerDiagnostics();
  }

  public interuptDiagnostics<T>(f: () => T): T {
    if (!this.pendingRequest) {
      return f();
    }

    this.pendingRequest.token.cancel();
    this.pendingRequest = undefined;
    const result = f();

    this.triggerDiagnostics();
    return result;
  }

  private triggerDiagnostics(delay = 200): void {
    const sendPendingDiagnostics = (): void => {
      const orderedFiles = this.pendingDiagnostics.getOrderedFiles();

      if (this.pendingRequest) {
        this.pendingRequest.token.cancel();

        this.pendingRequest.files.forEach((file) => {
          if (!orderedFiles.includes(file)) {
            orderedFiles.push(file);
          }
        });

        this.pendingRequest = undefined;
      }

      // Add all open files to request
      const openFiles = this.events.getManagedUris();
      openFiles.forEach((file) => {
        if (!orderedFiles.includes(file)) {
          orderedFiles.push(file);
        }
      });

      if (orderedFiles.length) {
        this.pendingRequest = {
          token: this.getDiagnosticsWithCancellation(orderedFiles, 0),
          files: orderedFiles,
        };
      }

      this.pendingDiagnostics.clear();
    };

    void this.diagnosticsDelayer.trigger(sendPendingDiagnostics, delay);
  }

  private updateDiagnostics(
    uri: string,
    kind: DiagnosticKind,
    diagnostics: Diagnostic[],
  ): void {
    let didUpdate = false;

    let fileDiagnostics = this.currentDiagnostics.get(uri);

    if (fileDiagnostics) {
      didUpdate = fileDiagnostics.update(kind, diagnostics);
    } else if (diagnostics.length > 0) {
      fileDiagnostics = new FileDiagnostics(uri);
      fileDiagnostics.update(kind, diagnostics);
      this.currentDiagnostics.set(uri, fileDiagnostics);
      didUpdate = true;
    }

    if (didUpdate) {
      const fileDiagnostics = this.currentDiagnostics.get(uri);
      this.connection.sendDiagnostics({
        uri,
        diagnostics: fileDiagnostics ? fileDiagnostics.get() : [],
      });
    }
  }

  private deleteDiagnostics(uri: string): void {
    this.currentDiagnostics.delete(uri);
    this.connection.sendDiagnostics({
      uri,
      diagnostics: [],
    });
  }

  private getDiagnosticsWithCancellation(
    files: string[],
    delay: number,
  ): CancellationTokenSource {
    const cancellationToken = new CancellationTokenSource();

    this.getDiagnostics(files, delay, cancellationToken.token);

    return cancellationToken;
  }

  private getDiagnostics(
    files: string[],
    delay: number,
    cancellationToken: CancellationToken,
  ): void {
    const followMs = Math.min(delay, 200);

    this.diagnosticsOperation.startNew(
      cancellationToken,
      (next) => {
        const seq = this.changeSeq;

        let index = 0;
        const goNext = (): void => {
          index++;
          if (files.length > index) {
            next.delay(followMs, checkOne);
          }
        };

        const checkOne = async (): Promise<void> => {
          if (this.changeSeq !== seq) {
            return;
          }

          const uri = files[index];
          const workspace = this.elmWorkspaceMatcher.getElmWorkspaceFor(
            URI.parse(uri),
          );

          const treeContainer = workspace.getForest().getByUri(uri);

          if (!treeContainer) {
            goNext();
            return;
          }

          this.updateDiagnostics(
            uri,
            DiagnosticKind.TypeInference,
            await this.typeInferenceDiagnostics.getDiagnosticsForFile(
              treeContainer,
              workspace,
              cancellationToken,
            ),
          );

          if (this.changeSeq !== seq) {
            return;
          }

          next.immediate(() => {
            this.updateDiagnostics(
              uri,
              DiagnosticKind.ElmLS,
              this.elmLsDiagnostics.createDiagnostics(treeContainer, workspace),
            );
            goNext();
          });
        };

        if (files.length > 0 && this.changeSeq === seq) {
          next.delay(delay, checkOne);
        }
      },
      () => {
        //
      },
    );
  }

  public async getElmMakeDiagnostics(uri: string): Promise<void> {
    const elmMakeDiagnostics = await this.elmMakeDiagnostics.createDiagnostics(
      URI.parse(uri),
    );

    this.resetDiagnostics(elmMakeDiagnostics, DiagnosticKind.ElmMake);

    elmMakeDiagnostics.forEach((diagnostics, diagnosticsUri) => {
      this.updateDiagnostics(
        diagnosticsUri,
        DiagnosticKind.ElmMake,
        diagnostics,
      );
    });

    this.currentDiagnostics.forEach((_, uri) => {
      if (!elmMakeDiagnostics.has(uri)) {
        this.updateDiagnostics(uri, DiagnosticKind.ElmMake, []);
      }
    });
  }

  private resetDiagnostics(
    diagnosticList: Map<string, Diagnostic[]>,
    diagnosticKind: DiagnosticKind,
  ): void {
    this.currentDiagnostics.forEach((fileDiagnostics, diagnosticsUri) => {
      if (
        !diagnosticList.has(diagnosticsUri) &&
        fileDiagnostics.getForKind(diagnosticKind).length > 0
      ) {
        diagnosticList.set(diagnosticsUri, []);
      }
    });
  }

  private change(): void {
    this.changeSeq++;
  }
}
