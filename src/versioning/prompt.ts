import { App, Modal } from "obsidian";

// Single-line label prompt. Returns the entered label, or null on cancel.
// Used by snapshot commands to ask the user for a human-readable name.

export function promptForLabel(
	app: App,
	options: { title: string; placeholder?: string; defaultValue?: string },
): Promise<string | null> {
	return new Promise((resolve) => {
		new LabelPromptModal(app, options, resolve).open();
	});
}

class LabelPromptModal extends Modal {
	private input!: HTMLInputElement;
	private finished = false;

	constructor(
		app: App,
		private readonly options: { title: string; placeholder?: string; defaultValue?: string },
		private readonly done: (label: string | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.options.title });

		this.input = contentEl.createEl("input", {
			type: "text",
			cls: "firstdraft-prompt-input",
			attr: {
				placeholder: this.options.placeholder ?? "",
				value: this.options.defaultValue ?? "",
			},
		});
		this.input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.submit();
			}
		});
		setTimeout(() => {
			this.input.focus();
			this.input.select();
		}, 0);

		const buttons = contentEl.createDiv({ cls: "modal-button-container" });
		const cancel = buttons.createEl("button", { text: "Cancel" });
		cancel.addEventListener("click", () => this.cancel());
		const ok = buttons.createEl("button", { text: "Save", cls: "mod-cta" });
		ok.addEventListener("click", () => this.submit());
	}

	private submit(): void {
		const value = this.input.value.trim();
		if (value === "") {
			this.cancel();
			return;
		}
		this.finished = true;
		this.done(value);
		this.close();
	}

	private cancel(): void {
		this.finished = true;
		this.done(null);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.finished) this.done(null);
	}
}
