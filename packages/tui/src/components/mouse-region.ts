import {
	type Component,
	dispatchMouseEvent,
	type TuiMouseDispatchResult,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "../tui.ts";

export type MouseRegionHandler = (event: TuiMouseEvent) => TuiMouseEventResult | undefined;

/** Adds mouse handling to an existing component without changing its rendering. */
export class MouseRegion implements Component {
	private readonly child: Component;
	private readonly onMouse: MouseRegionHandler;

	constructor(child: Component, onMouse: MouseRegionHandler) {
		this.child = child;
		this.onMouse = onMouse;
	}

	render(width: number): string[] {
		return this.child.render(width);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | TuiMouseEventResult | undefined {
		const childResult = dispatchMouseEvent(this.child, event);
		if (childResult) return childResult;
		const ownResult = this.onMouse(event);
		// The region decorates a child that only renders, so it can never receive keys itself.
		// Marking the focus request transparent lets the renderer hand focus to the surrounding
		// component instead of parking it here, where every keystroke would be dropped.
		return ownResult?.focus ? { ...ownResult, focusTransparent: true } : ownResult;
	}

	invalidate(): void {
		this.child.invalidate();
	}
}
