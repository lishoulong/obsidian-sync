import { App, Modal, Setting } from "obsidian";

export interface PairingTarget {
  workerOrigin: string;
  repository: string;
  branch: string;
}

export function confirmPairingTarget(app: App, target: PairingTarget): Promise<boolean> {
  return new Promise((resolve) => {
    new PairingTargetModal(app, target, resolve).open();
  });
}

export function confirmDeviceRevocation(app: App, deviceName: string): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmationModal(
      app,
      "Revoke mobile device?",
      `\"${deviceName}\" will immediately lose access to this Worker. Pair it again to restore access.`,
      "Revoke",
      resolve
    ).open();
  });
}

export function confirmCurrentDeviceDisconnect(app: App): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmationModal(
      app,
      "Disconnect this device?",
      "This device token will be revoked and the saved Worker URL and access token will be removed. Local notes are not deleted.",
      "Disconnect",
      resolve
    ).open();
  });
}

class PairingTargetModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly target: PairingTarget,
    private readonly resolveResult: (confirmed: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Connect this vault?");
    this.contentEl.createEl("p", {
      text: "Confirm the destination before VaultBridge saves the new device credential."
    });
    addDetail(this.contentEl, "Worker", this.target.workerOrigin);
    addDetail(this.contentEl, "Repository", this.target.repository);
    addDetail(this.contentEl, "Branch", this.target.branch);
    addModalActions(this.contentEl, "Connect", () => this.finish(true), () => this.finish(false));
  }

  onClose(): void {
    this.finish(false);
  }

  private finish(confirmed: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.close();
    this.resolveResult(confirmed);
  }
}

class ConfirmationModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly titleText: string,
    private readonly message: string,
    private readonly confirmText: string,
    private readonly resolveResult: (confirmed: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(this.titleText);
    this.contentEl.createEl("p", { text: this.message });
    addModalActions(this.contentEl, this.confirmText, () => this.finish(true), () => this.finish(false));
  }

  onClose(): void {
    this.finish(false);
  }

  private finish(confirmed: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.close();
    this.resolveResult(confirmed);
  }
}

function addDetail(container: HTMLElement, label: string, value: string): void {
  const row = container.createDiv();
  row.createEl("strong", { text: `${label}: ` });
  row.createSpan({ text: value || "Unknown" });
}

function addModalActions(
  container: HTMLElement,
  confirmText: string,
  confirm: () => void,
  cancel: () => void
): void {
  new Setting(container)
    .addButton((button) => button.setButtonText("Cancel").onClick(cancel))
    .addButton((button) => button.setCta().setButtonText(confirmText).onClick(confirm));
}
