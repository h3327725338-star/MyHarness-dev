package com.myharness.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * Keeps the app alive while a reply is being generated. The agent runs inside the app's page; without a foreground
 * service Android may stop the app shortly after the user switches away, which would cut the reply off. The service
 * does no work itself and ends as soon as the page says nothing is running any more.
 */
public final class RunService extends Service {
	static final String RUN_CHANNEL = "run";
	// "reply", not the "done" of the first versions: a channel keeps the importance it was made with, and that one was
	// made too low to show a banner when a reply ends.
	static final String DONE_CHANNEL = "reply";
	private static final int RUN_ID = 1;
	private static final String EXTRA_TITLE = "title";

	static void ensureChannels(Context context) {
		NotificationManager manager = context.getSystemService(NotificationManager.class);
		if (manager == null) return;
		NotificationChannel run = new NotificationChannel(RUN_CHANNEL, context.getString(R.string.run_channel), NotificationManager.IMPORTANCE_LOW);
		run.setShowBadge(false);
		manager.createNotificationChannel(run);
		manager.deleteNotificationChannel("done");
		manager.createNotificationChannel(new NotificationChannel(DONE_CHANNEL, context.getString(R.string.done_channel), NotificationManager.IMPORTANCE_HIGH));
	}

	static void start(Context context, String title) {
		Intent intent = new Intent(context, RunService.class);
		intent.putExtra(EXTRA_TITLE, title);
		try {
			context.startForegroundService(intent);
		} catch (RuntimeException refused) {
			// Android refuses to start it from the background; the reply then simply runs without it.
		}
	}

	static void stop(Context context) {
		context.stopService(new Intent(context, RunService.class));
	}

	static PendingIntent openApp(Context context) {
		Intent open = new Intent(context, MainActivity.class);
		open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
		return PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
	}

	@Override
	public int onStartCommand(Intent intent, int flags, int startId) {
		ensureChannels(this);
		String title = intent == null ? null : intent.getStringExtra(EXTRA_TITLE);
		Notification notification = new Notification.Builder(this, RUN_CHANNEL)
				.setSmallIcon(R.drawable.ic_stat_run)
				.setContentTitle(getString(R.string.run_title))
				.setContentText(title == null || title.isEmpty() ? null : title)
				.setOngoing(true)
				.setContentIntent(openApp(this))
				.build();
		try {
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
				startForeground(RUN_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
			} else {
				startForeground(RUN_ID, notification);
			}
		} catch (RuntimeException refused) {
			stopSelf();
		}
		return START_NOT_STICKY;
	}

	@Override
	public void onTimeout(int startId, int fgsType) {
		// Android limits how long this kind of service may run in a day.
		stopSelf();
	}

	@Override
	public IBinder onBind(Intent intent) {
		return null;
	}
}
