package com.myharness.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Provider keys and the PC link key. Each value is encrypted with an AES-256-GCM key that lives in the Android
 * Keystore (it never leaves the device's secure hardware when there is one); only the ciphertext is written to the
 * app's private preferences.
 */
final class SecretStore {
	private static final String KEY_ALIAS = "myharness.secrets.v1";
	private static final String PREFS = "myharness.secrets";
	private final SharedPreferences prefs;

	SecretStore(Context context) {
		prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
	}

	private SecretKey key() throws Exception {
		KeyStore store = KeyStore.getInstance("AndroidKeyStore");
		store.load(null);
		if (store.containsAlias(KEY_ALIAS)) {
			return ((KeyStore.SecretKeyEntry) store.getEntry(KEY_ALIAS, null)).getSecretKey();
		}
		KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
		generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
				.setBlockModes(KeyProperties.BLOCK_MODE_GCM)
				.setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
				.setKeySize(256)
				.build());
		return generator.generateKey();
	}

	synchronized String get(String name) {
		String stored = prefs.getString(name, null);
		if (stored == null) return null;
		try {
			byte[] raw = Base64.decode(stored, Base64.NO_WRAP);
			if (raw.length < 13) return null;
			Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
			cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, raw, 0, 12));
			return new String(cipher.doFinal(raw, 12, raw.length - 12), StandardCharsets.UTF_8);
		} catch (Exception error) {
			// A value that cannot be read back (the keystore key was replaced) is treated as not set.
			return null;
		}
	}

	synchronized boolean set(String name, String value) {
		try {
			Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
			cipher.init(Cipher.ENCRYPT_MODE, key());
			byte[] iv = cipher.getIV();
			byte[] sealed = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
			byte[] raw = new byte[iv.length + sealed.length];
			System.arraycopy(iv, 0, raw, 0, iv.length);
			System.arraycopy(sealed, 0, raw, iv.length, sealed.length);
			return prefs.edit().putString(name, Base64.encodeToString(raw, Base64.NO_WRAP)).commit();
		} catch (Exception error) {
			return false;
		}
	}

	synchronized void delete(String name) {
		prefs.edit().remove(name).apply();
	}
}
