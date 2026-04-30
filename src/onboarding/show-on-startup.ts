import type FirstDraftPlugin from "../main";
import { openWelcomeModal } from "./welcome-modal";
import { openWhatsNewModal } from "./whats-new-modal";
import { releasesSince, RELEASE_NOTES, compareVersions } from "./release-notes";

// Decide which (if any) onboarding modal to show on plugin load, then
// stamp the current manifest version into settings so subsequent loads
// stay silent. Three branches:
//
//   - lastSeenVersion is null            → first install. Show welcome.
//   - newer release entries exist        → update with notes. Show what's new.
//   - lastSeenVersion === current        → silent.
//   - bumped to a version with no entry  → silent (patch convention).
//
// The version stamp is updated regardless of which branch fired, so a
// patch-only bump (no release entry) still suppresses the same release
// notes on the next load.

export async function maybeShowOnboardingModal(
	plugin: FirstDraftPlugin,
): Promise<void> {
	const currentVersion = plugin.manifest.version;
	const lastSeen = plugin.settings.global.lastSeenVersion;

	if (lastSeen === null) {
		openWelcomeModal(plugin.app, currentVersion);
	} else if (compareVersions(currentVersion, lastSeen) > 0) {
		const newReleases = releasesSince(lastSeen);
		if (newReleases.length > 0) {
			openWhatsNewModal(plugin.app, newReleases, currentVersion);
		}
	}

	// Stamp current version regardless — even a silent update should
	// commit the version bump so we don't replay older notes next time.
	if (lastSeen !== currentVersion) {
		plugin.settings.global.lastSeenVersion = currentVersion;
		await plugin.saveSettings();
	}
}

// Manually-triggered: always shows the welcome modal, ignoring version
// state. Wired to the "Show welcome" command.
export function showWelcomeManually(plugin: FirstDraftPlugin): void {
	openWelcomeModal(plugin.app, plugin.manifest.version);
}

// Manually-triggered: shows every release entry, newest first. Wired to
// the "Show what's new" command. Useful for users who dismissed the
// startup popup before reading it.
export function showWhatsNewManually(plugin: FirstDraftPlugin): void {
	openWhatsNewModal(plugin.app, [...RELEASE_NOTES], plugin.manifest.version);
}
