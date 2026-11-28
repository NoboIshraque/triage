// What every view on the phone has: a session to the laptop, the permission the
// laptop gave, and a status line.
import type { CompanionPermission } from '../../../app/src/vs/triage/common/companion/protocol.js';
import type { CompanionSession } from '../../../app/src/vs/triage/common/companion/session.js';

export interface ViewHost {
  readonly session: CompanionSession;
  permission(): CompanionPermission;
  status(text: string): void;
}

export interface PhoneView {
  readonly element: HTMLElement;
  open(): Promise<void>;
  /** A laptop event (event:document, event:sim.frame …). */
  onEvent(kind: string, body: Record<string, unknown>): void;
  dispose(): void;
}
