import { App, Modal, Notice, Setting } from "obsidian";
import { PendingConflict } from "./types";

export class ConflictListModal extends Modal {
  private conflicts: PendingConflict[];

  constructor(app: App, conflicts: PendingConflict[]) {
    super(app);
    this.conflicts = conflicts;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "VaultBridge pending conflicts" });

    if (this.conflicts.length === 0) {
      contentEl.createEl("p", { text: "No pending sync conflicts. 🎉" });
      return;
    }

    contentEl.createEl("p", {
      text: "Merge what you need into the original note, delete the conflict copy, then sync again. A conflict is treated as resolved once its copies are gone."
    });

    for (const conflict of this.conflicts) {
      const setting = new Setting(contentEl)
        .setName(conflict.localPath)
        .setDesc(`Conflict recorded ${formatWhen(conflict.createdAt)} · remote ${conflict.remoteCommitSha.slice(0, 12)}`);

      setting.addButton((button) => button
        .setButtonText("Open note")
        .onClick(() => {
          void this.openPath(conflict.localPath);
        }));

      for (const copyPath of conflict.conflictPaths) {
        setting.addButton((button) => button
          .setButtonText("Open conflict copy")
          .onClick(() => {
            void this.openPath(copyPath);
          }));
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async openPath(path: string): Promise<void> {
    const file = this.app.vault.getFileByPath(path);
    if (!file) {
      new Notice(`${path} no longer exists.`);
      return;
    }
    this.close();
    await this.app.workspace.getLeaf(true).openFile(file);
  }
}

function formatWhen(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return "recently";
  return date.toLocaleString();
}
