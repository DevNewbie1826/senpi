import type { TUI } from "@earendil-works/pi-tui";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import { readTerminalThemeHint, writeTerminalThemeHint } from "./terminal-theme-cache.ts";
import {
	detectTerminalBackgroundFromEnv,
	detectTerminalBackgroundTheme,
	detectTerminalThemeForAuto,
	initTheme,
	parseAutoThemeSetting,
	resolveThemeSetting,
	setTheme,
	setThemeInstance,
	type TerminalTheme,
	type Theme,
} from "./theme.ts";

type ThemeResult = { success: boolean; error?: string };
type AutoThemeSetting = NonNullable<ReturnType<typeof parseAutoThemeSetting>>;

export class InteractiveThemeController {
	private readonly ui: TUI;
	private readonly getSettingsManager: () => SettingsManager;
	private readonly showError: (message: string) => void;
	private readonly onChanged: () => void;
	private currentThemeSetting: string | undefined;
	private terminalTheme: TerminalTheme = readTerminalThemeHint() ?? detectTerminalBackgroundFromEnv().theme;
	private activeThemeName: string | undefined;
	private autoSyncEnabled = false;
	private terminalColorSchemeUnsubscribe: (() => void) | undefined;
	private detectionGeneration = 0;
	private detectionTask: Promise<void> = Promise.resolve();

	constructor(
		ui: TUI,
		options: {
			getSettingsManager: () => SettingsManager;
			showError: (message: string) => void;
			onChanged: () => void;
			initialThemeSetting?: string;
		},
	) {
		this.ui = ui;
		this.getSettingsManager = options.getSettingsManager;
		this.showError = options.showError;
		this.onChanged = options.onChanged;
		this.currentThemeSetting = options.initialThemeSetting;
		this.activeThemeName = resolveThemeSetting(
			this.currentThemeSetting ?? this.getSettingsManager().getThemeSetting(),
			this.terminalTheme,
		);
		initTheme(this.activeThemeName, true);
		this.bindTerminalColorSchemeListener();
	}

	rebindTui(): void {
		this.terminalColorSchemeUnsubscribe?.();
		this.bindTerminalColorSchemeListener();
		this.ui.setTerminalColorSchemeNotifications(this.autoSyncEnabled);
	}

	async applyFromSettings(): Promise<void> {
		const settingsManager = this.getSettingsManager();
		const themeSetting = this.currentThemeSetting ?? settingsManager.getThemeSetting();
		const autoTheme = parseAutoThemeSetting(themeSetting);
		const generation = ++this.detectionGeneration;

		if (autoTheme) {
			this.setAutoSync(true);
			this.applyThemeName(this.terminalTheme === "light" ? autoTheme.lightTheme : autoTheme.darkTheme, true);
			this.detectionTask = this.resolveAutoTheme(generation, autoTheme);
			return;
		}

		this.setAutoSync(false);
		if (themeSetting !== undefined) {
			this.applyThemeName(themeSetting, true);
			this.detectionTask = Promise.resolve();
			return;
		}

		this.applyThemeName(this.terminalTheme);
		this.detectionTask = this.resolveBackgroundTheme(generation, settingsManager);
	}

	settleBackgroundDetection(): Promise<void> {
		return this.detectionTask;
	}

	getThemeSelection(): string | undefined {
		return this.currentThemeSetting ?? this.getSettingsManager().getThemeSetting() ?? this.activeThemeName;
	}

	setThemeName(themeName: string, showError = false): ThemeResult {
		this.detectionGeneration += 1;
		this.detectionTask = Promise.resolve();
		this.setAutoSync(false);
		const result = this.applyThemeName(themeName, showError);
		if (result.success) {
			this.currentThemeSetting = themeName;
		}
		return result;
	}

	async setThemeSetting(themeSetting: string): Promise<void> {
		this.currentThemeSetting = themeSetting;
		await this.applyFromSettings();
	}

	setThemeInstance(themeInstance: Theme): ThemeResult {
		this.detectionGeneration += 1;
		this.detectionTask = Promise.resolve();
		this.setAutoSync(false);
		setThemeInstance(themeInstance);
		this.activeThemeName = "<in-memory>";
		this.notifyChanged();
		return { success: true };
	}

	preview(themeSettingOrName: string): void {
		const themeName = resolveThemeSetting(themeSettingOrName, this.terminalTheme) ?? this.activeThemeName;
		if (!themeName) return;
		if (setTheme(themeName, true).success) {
			this.ui.invalidate();
			this.ui.requestRender();
		}
	}

	disableAutoSync(): void {
		this.setAutoSync(false);
	}

	dispose(): void {
		this.detectionGeneration += 1;
		this.detectionTask = Promise.resolve();
		this.setAutoSync(false);
		this.terminalColorSchemeUnsubscribe?.();
		this.terminalColorSchemeUnsubscribe = undefined;
	}

	getTerminalTheme(): TerminalTheme {
		return this.terminalTheme;
	}

	private async resolveAutoTheme(generation: number, autoTheme: AutoThemeSetting): Promise<void> {
		try {
			const detected = await detectTerminalThemeForAuto({ ui: this.ui, timeoutMs: 100 });
			if (generation !== this.detectionGeneration) return;
			this.terminalTheme = detected;
			writeTerminalThemeHint(detected);
			this.applyThemeName(detected === "light" ? autoTheme.lightTheme : autoTheme.darkTheme, true);
		} catch {
			// OSC detection is best-effort and must not reject startup.
		}
	}

	private async resolveBackgroundTheme(generation: number, settingsManager: SettingsManager): Promise<void> {
		try {
			const detection = await detectTerminalBackgroundTheme({ ui: this.ui, timeoutMs: 100 });
			if (generation !== this.detectionGeneration) return;
			this.terminalTheme = detection.theme;
			writeTerminalThemeHint(detection.theme);
			if (!this.applyThemeName(detection.theme).success) return;
			if (detection.confidence === "high") {
				settingsManager.setTheme(detection.theme);
				await settingsManager.flush();
			}
		} catch {
			// OSC detection is best-effort and must not reject startup.
		}
	}

	private applyThemeName(themeName: string, showError = false): ThemeResult {
		const result = setTheme(themeName, true);
		this.activeThemeName = result.success ? themeName : "dark";
		this.notifyChanged();
		if (!result.success && showError) {
			this.showError(`Failed to load theme "${themeName}": ${result.error}\nFell back to dark theme.`);
		}
		return result;
	}

	private notifyChanged(): void {
		this.ui.invalidate();
		this.onChanged();
	}

	private setAutoSync(enabled: boolean): void {
		if (this.autoSyncEnabled === enabled) return;
		this.autoSyncEnabled = enabled;
		this.ui.setTerminalColorSchemeNotifications(enabled);
	}

	private bindTerminalColorSchemeListener(): void {
		this.terminalColorSchemeUnsubscribe = this.ui.onTerminalColorSchemeChange((terminalTheme) =>
			this.applyTerminalTheme(terminalTheme),
		);
	}

	private applyTerminalTheme(terminalTheme: TerminalTheme): void {
		if (!this.autoSyncEnabled) return;
		this.terminalTheme = terminalTheme;
		const autoTheme = parseAutoThemeSetting(this.currentThemeSetting ?? this.getSettingsManager().getThemeSetting());
		if (!autoTheme) {
			this.setAutoSync(false);
			return;
		}
		const themeName = terminalTheme === "light" ? autoTheme.lightTheme : autoTheme.darkTheme;
		if (themeName !== this.activeThemeName) {
			this.applyThemeName(themeName);
		}
	}
}
