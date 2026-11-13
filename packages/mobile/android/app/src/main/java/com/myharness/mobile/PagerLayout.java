package com.myharness.mobile;

import android.content.Context;
import android.view.MotionEvent;
import android.view.View;
import android.widget.FrameLayout;

/**
 * The window's root. The built-in browser's web content lies above the app's page, so a finger on it never reaches the
 * page. A touch that starts on the left edge of the screen while the browser is shown is handed to the page instead:
 * that is where the swipe back to the chat begins.
 */
final class PagerLayout extends FrameLayout {
	interface Gate {
		boolean browserShown();
	}

	private View page;
	private Gate gate;
	private float edgePx;
	private boolean forwarding;

	PagerLayout(Context context) {
		super(context);
	}

	void attach(View page, Gate gate, float edgePx) {
		this.page = page;
		this.gate = gate;
		this.edgePx = edgePx;
	}

	@Override
	public boolean onInterceptTouchEvent(MotionEvent event) {
		if (event.getActionMasked() == MotionEvent.ACTION_DOWN) {
			forwarding = page != null && gate != null && gate.browserShown() && event.getX() < edgePx;
		}
		return forwarding;
	}

	@Override
	public boolean onTouchEvent(MotionEvent event) {
		if (!forwarding || page == null) return super.onTouchEvent(event);
		page.dispatchTouchEvent(event);
		int action = event.getActionMasked();
		if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) forwarding = false;
		return true;
	}
}
