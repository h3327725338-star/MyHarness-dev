import { describe, expect, it } from "vitest";

const { clampView, fitScale, scaleLimits, wheelFactor, zoomAt } = await import(
	new URL("../web/js/lightbox-view.js", import.meta.url).href
);

describe("image viewer: size and position", () => {
	it("shows a large picture whole and never enlarges a small one", () => {
		// 3840 x 2160 in a 1600 x 1000 window: limited by the width that is left beside the margins.
		const large = fitScale(3840, 2160, 1600, 1000);
		expect(large).toBeCloseTo((1600 - 96) / 3840, 5);
		expect(3840 * large).toBeLessThanOrEqual(1600);
		expect(2160 * large).toBeLessThanOrEqual(1000);
		// A tall picture is limited by the height, with room for the bar under it.
		expect(fitScale(800, 4000, 1600, 1000)).toBeCloseTo((1000 - 124) / 4000, 5);
		// A small picture stays at its own pixels: stretched it would only blur.
		expect(fitScale(200, 100, 1600, 1000)).toBe(1);
	});

	it("zooms in far past the picture's own pixels and out to half of the whole view", () => {
		expect(scaleLimits(0.25)).toEqual({ min: 0.125, max: 8 });
		expect(scaleLimits(1)).toEqual({ min: 0.5, max: 8 });
	});

	it("keeps the point under the pointer where it is while zooming", () => {
		const view = { scale: 0.5, x: 0, y: 0 };
		const point = { x: 200, y: -100 };
		const zoomed = zoomAt(view, 1, point);
		// The picture point under the pointer before: (point - offset) / scale. It must be the same after.
		const before = { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale };
		const after = { x: (point.x - zoomed.x) / zoomed.scale, y: (point.y - zoomed.y) / zoomed.scale };
		expect(after.x).toBeCloseTo(before.x, 6);
		expect(after.y).toBeCloseTo(before.y, 6);
		// Zooming at the center moves nothing.
		expect(zoomAt({ scale: 1, x: 0, y: 0 }, 2)).toEqual({ scale: 2, x: 0, y: 0 });
		// And back again returns to where it was.
		const back = zoomAt(zoomed, 0.5, point);
		expect(back.x).toBeCloseTo(0, 6);
		expect(back.y).toBeCloseTo(0, 6);
	});

	it("lets the picture be moved, but never out of sight", () => {
		const size = { width: 1000, height: 500 };
		const far = clampView({ scale: 1, x: 99_999, y: -99_999 }, size, 1600, 1000);
		// A strip of 96 pixels stays in the window on each axis.
		expect(far.x).toBe(1600 / 2 + 500 - 96);
		expect(far.y).toBe(-(1000 / 2 + 250 - 96));
		expect(clampView({ scale: 1, x: 30, y: -20 }, size, 1600, 1000)).toEqual({ scale: 1, x: 30, y: -20 });
	});

	it("gives the same zoom for one wheel notch as for a touchpad's small steps adding up to it", () => {
		const notch = wheelFactor(-100);
		expect(notch).toBeGreaterThan(1);
		let steps = 1;
		for (let index = 0; index < 20; index += 1) steps *= wheelFactor(-5);
		expect(steps).toBeCloseTo(notch, 6);
		// Scrolling the other way zooms out by the same amount; a wheel that counts in lines is about 33 pixels a line.
		expect(wheelFactor(100) * notch).toBeCloseTo(1, 6);
		expect(wheelFactor(-3, 1)).toBeCloseTo(wheelFactor(-99), 6);
	});
});
