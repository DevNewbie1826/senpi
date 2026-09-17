import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "../src/config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { initTheme, type TerminalTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { InteractiveThemeController } from "../src/modes/interactive/theme/theme-controller.ts";

beforeEach(() => {
	// A controller seeds its terminal theme from the persisted detection hint, so each case has to
	// start without one or it inherits whatever the previous case detected.
	rmSync(join(getAgentDir(), "cache", "terminal-theme.json"), { force: true });
});

function createUi() {
	const queryTerminalBackgroundColor = vi.fn();
	const queryTerminalColorScheme = vi.fn();
	const setTerminalColorSchemeNotifications = vi.fn();
	let terminalColorSchemeListener: ((terminalTheme: TerminalTheme) => void) | undefined;
	const unsubscribeTerminalColorScheme = vi.fn();
	const ui = {
		invalidate: vi.fn(),
		requestRender: vi.fn(),
		setTerminalColorSchemeNotifications,
		onTerminalColorSchemeChange: vi.fn((listener: (terminalTheme: TerminalTheme) => void) => {
			terminalColorSchemeListener = listener;
			return unsubscribeTerminalColorScheme;
		}),
		queryTerminalBackgroundColor,
		queryTerminalColorScheme,
	} as unknown as TUI;
	return {
		ui,
		queryTerminalBackgroundColor,
		queryTerminalColorScheme,
		setTerminalColorSchemeNotifications,
		unsubscribeTerminalColorScheme,
		emitTerminalColorScheme: (terminalTheme: TerminalTheme) => terminalColorSchemeListener?.(terminalTheme),
	};
}

function createController(ui: TUI, getSettingsManager: () => SettingsManager, initialThemeSetting?: string) {
	return new InteractiveThemeController(ui, {
		getSettingsManager,
		showError: vi.fn(),
		onChanged: vi.fn(),
		initialThemeSetting,
	});
}

afterEach(() => {
	initTheme("dark");
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe("InteractiveThemeController", () => {
	it("uses the initial theme without persisting it", async () => {
		const { ui, queryTerminalBackgroundColor } = createUi();
		const manager = SettingsManager.inMemory({ theme: "dark" });
		const setTheme = vi.spyOn(manager, "setTheme");
		const flush = vi.spyOn(manager, "flush");
		const controller = createController(ui, () => manager, "light");

		expect(theme.name).toBe("light");
		expect(controller.getThemeSelection()).toBe("light");
		await controller.applyFromSettings();

		expect(queryTerminalBackgroundColor).not.toHaveBeenCalled();
		expect(setTheme).not.toHaveBeenCalled();
		expect(flush).not.toHaveBeenCalled();
	});

	it("resolves a theme pair and follows terminal appearance changes", async () => {
		vi.stubEnv("COLORFGBG", "15;0");
		const { ui, queryTerminalColorScheme, setTerminalColorSchemeNotifications, emitTerminalColorScheme } = createUi();
		queryTerminalColorScheme.mockResolvedValue("light");
		const manager = SettingsManager.inMemory({ theme: "dark/light" });
		const controller = createController(ui, () => manager, "light/dark");

		expect(theme.name).toBe("dark");
		await controller.applyFromSettings();
		await controller.settleBackgroundDetection();
		expect(theme.name).toBe("light");
		expect(setTerminalColorSchemeNotifications).toHaveBeenCalledWith(true);

		emitTerminalColorScheme("dark");
		expect(theme.name).toBe("dark");
	});

	it("disables terminal appearance updates when disposed", async () => {
		const { ui, queryTerminalColorScheme, setTerminalColorSchemeNotifications, unsubscribeTerminalColorScheme } =
			createUi();
		queryTerminalColorScheme.mockResolvedValue("light");
		const manager = SettingsManager.inMemory({ theme: "light/dark" });
		const controller = createController(ui, () => manager);
		await controller.applyFromSettings();

		controller.dispose();

		expect(setTerminalColorSchemeNotifications).toHaveBeenLastCalledWith(false);
		expect(unsubscribeTerminalColorScheme).toHaveBeenCalledOnce();
	});

	it("detects the current terminal appearance when selecting a theme pair", async () => {
		vi.stubEnv("COLORFGBG", "");
		const { ui, queryTerminalColorScheme } = createUi();
		queryTerminalColorScheme.mockResolvedValue("light");
		const manager = SettingsManager.inMemory({ theme: "dark" });
		const controller = createController(ui, () => manager);

		expect(theme.name).toBe("dark");
		await controller.setThemeSetting("light/dark");
		await controller.settleBackgroundDetection();
		expect(theme.name).toBe("light");
		expect(queryTerminalColorScheme).toHaveBeenCalledOnce();
	});

	it("lets an explicit selection replace the initial theme", async () => {
		const { ui } = createUi();
		const firstManager = SettingsManager.inMemory({ theme: "dark" });
		const secondManager = SettingsManager.inMemory({ theme: "light" });
		let manager = firstManager;
		const controller = createController(ui, () => manager, "light");
		await controller.applyFromSettings();

		expect(controller.setThemeName("dark")).toEqual({ success: true });
		manager = secondManager;
		await controller.applyFromSettings();

		expect(controller.getThemeSelection()).toBe("dark");
		expect(theme.name).toBe("dark");
	});

	it("reloads theme settings when no initial theme was supplied", async () => {
		const { ui } = createUi();
		const firstManager = SettingsManager.inMemory({ theme: "dark" });
		const secondManager = SettingsManager.inMemory({ theme: "light" });
		let manager = firstManager;
		const controller = createController(ui, () => manager);
		await controller.applyFromSettings();

		firstManager.applyOverrides({ theme: "light" });
		await controller.applyFromSettings();
		expect(theme.name).toBe("light");

		secondManager.applyOverrides({ theme: "dark" });
		manager = secondManager;
		await controller.applyFromSettings();
		expect(theme.name).toBe("dark");
	});
});

function unansweredQuery<T>(timeoutMs: number): Promise<T | undefined> {
	return new Promise((resolve) => {
		setTimeout(() => resolve(undefined), timeoutMs);
	});
}

async function expectApplyFromSettingsDoesNotWait(apply: () => Promise<void>): Promise<void> {
	let settled = false;
	void apply().then(() => {
		settled = true;
	});
	await vi.advanceTimersByTimeAsync(0);
	expect(settled).toBe(true);
}

describe("InteractiveThemeController startup detection", () => {
	it("does not wait for an unanswered terminal background query", async () => {
		vi.useFakeTimers();
		vi.stubEnv("COLORFGBG", "");
		const { ui, queryTerminalBackgroundColor } = createUi();
		queryTerminalBackgroundColor.mockImplementation(({ timeoutMs }: { timeoutMs: number }) =>
			unansweredQuery(timeoutMs),
		);
		const manager = SettingsManager.inMemory({});
		const controller = createController(ui, () => manager);

		await expectApplyFromSettingsDoesNotWait(() => controller.applyFromSettings());

		expect(queryTerminalBackgroundColor).toHaveBeenCalledOnce();
		expect(theme.name).toBe("dark");
		expect(manager.getThemeSetting()).toBeUndefined();
		controller.dispose();
	});

	it("seeds the first frame from the persisted terminal theme instead of re-guessing", async () => {
		// Given: an auto theme, a terminal that never answers, and a remembered light background
		vi.useFakeTimers();
		vi.stubEnv("COLORFGBG", "");
		writeFileSync(
			join(
				mkdirSync(join(getAgentDir(), "cache"), { recursive: true }) ?? join(getAgentDir(), "cache"),
				"terminal-theme.json",
			),
			JSON.stringify({ terminalTheme: "light" }),
		);
		const { ui, queryTerminalBackgroundColor, queryTerminalColorScheme } = createUi();
		queryTerminalBackgroundColor.mockImplementation(({ timeoutMs }: { timeoutMs: number }) =>
			unansweredQuery(timeoutMs),
		);
		queryTerminalColorScheme.mockImplementation(({ timeoutMs }: { timeoutMs: number }) => unansweredQuery(timeoutMs));
		const manager = SettingsManager.inMemory({ theme: "light/dark" });
		const controller = createController(ui, () => manager);

		// When
		await expectApplyFromSettingsDoesNotWait(() => controller.applyFromSettings());

		// Then: the remembered background wins over the environment guess, so there is no repaint
		expect(theme.name).toBe("light");
		controller.dispose();
	});

	it("does not wait for an unanswered auto theme query", async () => {
		vi.useFakeTimers();
		vi.stubEnv("COLORFGBG", "");
		const { ui, queryTerminalBackgroundColor, queryTerminalColorScheme, setTerminalColorSchemeNotifications } =
			createUi();
		queryTerminalBackgroundColor.mockImplementation(({ timeoutMs }: { timeoutMs: number }) =>
			unansweredQuery(timeoutMs),
		);
		queryTerminalColorScheme.mockImplementation(({ timeoutMs }: { timeoutMs: number }) => unansweredQuery(timeoutMs));
		const manager = SettingsManager.inMemory({ theme: "light/dark" });
		const controller = createController(ui, () => manager);

		await expectApplyFromSettingsDoesNotWait(() => controller.applyFromSettings());

		expect(queryTerminalColorScheme).toHaveBeenCalledOnce();
		expect(setTerminalColorSchemeNotifications).toHaveBeenCalledWith(true);
		expect(theme.name).toBe("dark");
		controller.dispose();
	});

	it("applies a late high-confidence detection after startup has moved on", async () => {
		vi.useFakeTimers();
		vi.stubEnv("COLORFGBG", "");
		const { ui, queryTerminalBackgroundColor } = createUi();
		const background = Promise.withResolvers<{ r: number; g: number; b: number } | undefined>();
		queryTerminalBackgroundColor.mockImplementation(() => background.promise);
		const manager = SettingsManager.inMemory({});
		const setTheme = vi.spyOn(manager, "setTheme");
		const controller = createController(ui, () => manager);

		await expectApplyFromSettingsDoesNotWait(() => controller.applyFromSettings());
		expect(theme.name).toBe("dark");
		expect(setTheme).not.toHaveBeenCalled();

		background.resolve({ r: 250, g: 250, b: 250 });
		await controller.settleBackgroundDetection();

		expect(theme.name).toBe("light");
		expect(setTheme).toHaveBeenCalledWith("light");
		expect(manager.getThemeSetting()).toBe("light");
		controller.dispose();
	});
});
