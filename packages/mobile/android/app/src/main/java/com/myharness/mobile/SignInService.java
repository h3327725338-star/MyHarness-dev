package com.myharness.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * Keeps the app awake while a Google sign-in is finished in the browser. Google sends the browser back to the app's
 * loopback listener (OAuthLoopback), but meanwhile the browser is in front and the app in the background, where
 * Android freezes an app after a few seconds: the browser then reaches the listener and waits for an answer that never
 * comes. A foreground service keeps the app from being frozen. It does no work itself and ends when the sign-in does.
 */
public final class SignInService extends Service {
	private static final String CHANNEL = "signin";
	private static final int ID = 2;

	static void start(Context context) {
		try {
			context.startForegroundService(new Intent(context, SignInService.class));
		} catch (RuntimeException refused) {
			// Android refuses to start it from the background; the sign-in then works only if the app is not frozen.
		}
	}

	static void stop(Context context) {
		context.stopService(new Intent(context, SignInService.class));
	}

	@Override
	public int onStartCommand(Intent intent, int flags, int startId) {
		NotificationManager manager = getSystemService(NotificationManager.class);
		if (manager != null) {
			NotificationChannel channel = new NotificationChannel(CHANNEL, getString(R.string.signin_channel), NotificationManager.IMPORTANCE_LOW);
			channel.setShowBadge(false);
			manager.createNotificationChannel(channel);
		}
		Notification notification = new Notification.Builder(this, CHANNEL)
				.setSmallIcon(R.drawable.ic_stat_run)
				.setContentTitle(getString(R.string.signin_title))
				.setContentText(getString(R.string.signin_text))
				.setOngoing(true)
				.setContentIntent(RunService.openApp(this))
				.build();
		try {
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
				startForeground(ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
			} else {
				startForeground(ID, notification);
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
