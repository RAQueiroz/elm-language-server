import { CancellationToken, Connection } from "vscode-languageserver";
import { OperationCanceledException } from "../cancellation";

/**
 * MultistepOperation taken from Typescript: https://github.com/microsoft/TypeScript/blob/79ffd03f8b73010fa03cef624e5f1770bc9c975b/src/server/session.ts#L166
 */

interface INextStep {
  immediate(action: () => void): void;
  delay(ms: number, action: () => void): void;
}

export class MultistepOperation implements INextStep {
  private timerHandle: NodeJS.Timeout | undefined;
  private immediateId: NodeJS.Immediate | undefined;
  private cancellationToken: CancellationToken | undefined;
  private done: (() => void) | undefined;

  constructor(private connection: Connection) {}

  public startNew(
    cancellationToken: CancellationToken,
    action: (next: INextStep) => void,
    done: () => void,
  ): void {
    this.complete();
    this.cancellationToken = cancellationToken;
    this.done = done;
    this.executeAction(action);
  }

  private complete(): void {
    if (this.done !== undefined) {
      this.done();
      this.cancellationToken = undefined;
      this.done = undefined;
    }
    this.setTimerHandle(undefined);
    this.setImmediateId(undefined);
  }

  public immediate(action: () => void): void {
    this.setImmediateId(
      setImmediate(() => {
        this.immediateId = undefined;
        this.executeAction(action);
      }),
    );
  }

  public delay(ms: number, action: () => void): void {
    this.setTimerHandle(
      setTimeout(() => {
        this.timerHandle = undefined;
        this.executeAction(action);
      }, ms),
    );
  }

  private executeAction(action: (next: INextStep) => void): void {
    let stop = false;
    try {
      if (this.cancellationToken?.isCancellationRequested) {
        stop = true;
      } else {
        action(this);
      }
    } catch (e) {
      stop = true;
      // ignore cancellation request
      if (!(e instanceof OperationCanceledException)) {
        this.connection.console.error(`${e} delayed processing of request`);
      }
    }
    if (stop || !this.hasPendingWork()) {
      this.complete();
    }
  }

  private setTimerHandle(timerHandle: NodeJS.Timeout | undefined): void {
    if (this.timerHandle !== undefined) {
      clearTimeout(this.timerHandle);
    }
    this.timerHandle = timerHandle;
  }

  private setImmediateId(immediateId: NodeJS.Immediate | undefined): void {
    if (this.immediateId !== undefined) {
      clearImmediate(this.immediateId);
    }
    this.immediateId = immediateId;
  }

  private hasPendingWork(): boolean {
    return !!this.timerHandle || !!this.immediateId;
  }
}
