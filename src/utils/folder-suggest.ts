import { AbstractInputSuggest, App, TFolder } from "obsidian";

// Folder picker for text inputs. Walks all folders in the vault, filters by
// substring match against the input value, sorts shorter paths first (so
// top-level matches surface above deep ones), and lets the user either pick
// from the dropdown or type a path that doesn't exist yet (which the
// caller's create/ensure-folder logic will scaffold on submit).
//
// Usage: new FolderSuggest(app, inputEl). Optionally `.onSelect((path) => …)`
// to react to selections beyond the auto-fill of the input value.

export class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(
		app: App,
		private readonly inputEl: HTMLInputElement,
	) {
		super(app, inputEl);
	}

	protected getSuggestions(query: string): TFolder[] {
		const q = query.toLowerCase();
		const folders = collectAllFolders(this.app);
		const filtered = q === "" ? folders : folders.filter((f) => f.path.toLowerCase().includes(q));
		// Sort by depth (shallower first), then alphabetically, so top-level
		// matches surface above buried ones with the same substring.
		return filtered.sort((a, b) => {
			const da = depth(a.path);
			const db = depth(b.path);
			if (da !== db) return da - db;
			return a.path.localeCompare(b.path);
		});
	}

	renderSuggestion(value: TFolder, el: HTMLElement): void {
		const path = value.path === "" ? "(vault root)" : value.path;
		el.setText(path);
	}

	selectSuggestion(value: TFolder, evt: MouseEvent | KeyboardEvent): void {
		this.inputEl.value = value.path;
		this.inputEl.dispatchEvent(new Event("input"));
		this.inputEl.dispatchEvent(new Event("change"));
		this.close();
		void evt;
	}
}

function collectAllFolders(app: App): TFolder[] {
	const out: TFolder[] = [];
	const root = app.vault.getRoot();
	const stack: TFolder[] = [root];
	while (stack.length > 0) {
		const f = stack.pop()!;
		// Skip the root itself in suggestions — empty path is confusing in a
		// "where to create" picker. Users who want vault root just leave the
		// field blank.
		if (f.path !== "") out.push(f);
		for (const child of f.children) {
			if (child instanceof TFolder) stack.push(child);
		}
	}
	return out;
}

function depth(path: string): number {
	if (path === "") return 0;
	return path.split("/").length;
}
