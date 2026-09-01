package com.eve.agent

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.provider.Settings
import android.text.TextUtils
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableType
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.nio.ByteBuffer
import java.net.URL
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONArray
import org.json.JSONObject

class EveNotificationListenerModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  override fun getName(): String = "EveNotificationListener"

  @ReactMethod
  fun isPermissionGranted(promise: Promise) {
    promise.resolve(isEnabled(context))
  }

  @ReactMethod
  fun openSettings() {
    val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(intent)
  }

  @ReactMethod
  fun configure(apiUrl: String, authToken: String) {
    val normalizedApiUrl = apiUrl.trim()
    val normalizedToken = authToken.trim()
    if (!isValidApiUrl(normalizedApiUrl) || normalizedToken.isBlank() || normalizedToken.length > MAX_AUTH_TOKEN_CHARS) {
      clearConfiguration()
      return
    }
    synchronized(pendingLock) {
      val owner = tokenFingerprint(normalizedToken)
      val previousOwner = prefs(context).getString("configOwner", "") ?: ""
      // A pending preview belongs to the session that captured it. If a shared
      // phone changes accounts, discard the old account's queue before binding
      // the new bearer so a retry can never upload to the wrong user.
      if (previousOwner.isNotEmpty() && previousOwner != owner) clearPending(context)
      // Commit the encrypted bearer before publishing its owner/API binding.
      // The listener can run in a separate process thread while this method is
      // returning; publishing the owner first could pair a new account with the
      // previous account's token for one request.
      if (!putSecretSync(context, "authToken", normalizedToken)) {
        clearConfiguration()
        return
      }
      prefs(context).edit().putString("apiUrl", normalizedApiUrl).putString("configOwner", owner).commit()
    }
  }

  @ReactMethod
  fun clearConfiguration() {
    synchronized(pendingLock) {
      // Keep the device-level package privacy choice across account switches;
      // only credentials, endpoint, and queued account data are disposable.
      prefs(context).edit()
        .remove("apiUrl")
        .remove("authToken")
        .remove("configOwner")
        .commit()
      clearPending(context)
    }
  }

  /**
   * Restrict capture to an explicit set of Android package names. An absent
   * allowlist preserves the existing opt-in behavior (the user still had to
   * grant notification access); once configured, an empty list intentionally
   * means capture nothing.
   */
  @ReactMethod
  fun setAllowedPackages(packages: ReadableArray) {
    val encoded = JSONArray()
    for (index in 0 until packages.size()) {
      if (packages.getType(index) != ReadableType.String) continue
      val packageName = packages.getString(index)?.trim() ?: continue
      if (PACKAGE_NAME_PATTERN.matches(packageName)) encoded.put(packageName)
    }
    if (putSecretSync(context, ALLOWLIST_KEY, encoded.toString())) {
      prefs(context).edit().remove("allowlistCorrupt").commit()
    }
  }

  @ReactMethod
  fun getAllowedPackages(promise: Promise) {
    if (!prefs(context).contains(ALLOWLIST_KEY)) {
      promise.resolve(null)
      return
    }
    promise.resolve(Arguments.makeNativeArray(readAllowedPackages(context)))
  }

  @ReactMethod
  fun addListener(eventName: String) {
  }

  @ReactMethod
  fun removeListeners(count: Int) {
  }

  companion object {
    private var reactContext: ReactApplicationContext? = null
    private val pendingLock = Any()

    fun bind(context: ReactApplicationContext) {
      reactContext = context
    }

    fun prefs(context: Context): SharedPreferences {
      return context.getSharedPreferences("eve_notification_listener", Context.MODE_PRIVATE)
    }

    private const val KEY_ALIAS = "eve.notification.listener.v1"
    private const val PENDING_KEY = "pendingNotifications"
    private const val ALLOWLIST_KEY = "allowedPackages"
    private const val MAX_PENDING = 128
    private const val MAX_API_URL_CHARS = 2_048
    private const val MAX_AUTH_TOKEN_CHARS = 4_096
    private const val PENDING_RETENTION_MS = 7L * 24L * 60L * 60L * 1000L
    private val PACKAGE_NAME_PATTERN = Regex("[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}")

    /** Validate the endpoint again inside the native boundary. */
    private fun isValidApiUrl(value: String): Boolean {
      if (value.isBlank() || value.length > MAX_API_URL_CHARS) return false
      return try {
        val parsed = URL(value)
        val allowedProtocol = parsed.protocol == "https" || (BuildConfig.DEBUG && parsed.protocol == "http")
        allowedProtocol && parsed.host.isNotBlank() && parsed.userInfo == null && parsed.query == null && parsed.ref == null
      } catch (_: Exception) {
        false
      }
    }

    /** Return a stable, non-reversible owner key for queue partitioning. */
    fun tokenFingerprint(token: String): String {
      val digest = MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.UTF_8))
      return Base64.encodeToString(digest, Base64.NO_WRAP or Base64.URL_SAFE)
    }

    /** Synchronous encrypted write used only for the small durable queue. */
    private fun putSecretSync(context: Context, name: String, value: String): Boolean {
      try {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        val packed = ByteBuffer.allocate(4 + cipher.iv.size + encrypted.size)
          .putInt(cipher.iv.size)
          .put(cipher.iv)
          .put(encrypted)
          .array()
        val committed = prefs(context).edit()
          .putString(name, Base64.encodeToString(packed, Base64.NO_WRAP))
          .commit()
        return committed
      } catch (_: Exception) {
        prefs(context).edit().remove(name).commit()
        return false
      }
    }

    fun getSecret(context: Context, name: String): String {
      val encoded = prefs(context).getString(name, null) ?: return ""
      return try {
        val packed = ByteBuffer.wrap(Base64.decode(encoded, Base64.DEFAULT))
        val ivLength = packed.int
        if (ivLength !in 12..16) return ""
        val iv = ByteArray(ivLength)
        packed.get(iv)
        val encrypted = ByteArray(packed.remaining())
        packed.get(encrypted)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
        String(cipher.doFinal(encrypted), Charsets.UTF_8)
      } catch (_: Exception) {
        // A corrupted/rotated keystore entry must fail closed, never fall back
        // to a plaintext token left by an older build.
        if (name == ALLOWLIST_KEY) {
          // Keep the marker key present so a corrupt allowlist cannot silently
          // become the permissive "no allowlist" state after recovery.
          prefs(context).edit().putBoolean("allowlistCorrupt", true).apply()
        } else {
          prefs(context).edit().remove(name).remove("legacyAuthToken").apply()
        }
        ""
      }
    }

    /**
     * Whether the package is currently selected. A missing allowlist is the
     * backwards-compatible state; a stored empty array is a deliberate deny.
     * EVE and Android's system UI are always excluded so the listener cannot
     * reflect its own push previews back into the captured inbox or persist
     * system-level status text that the user never selected.
     */
    fun isPackageAllowed(context: Context, packageName: String): Boolean {
      if (packageName == context.packageName || packageName == "android" || packageName == "com.android.systemui") {
        return false
      }
      if (prefs(context).getBoolean("allowlistCorrupt", false)) return false
      if (!prefs(context).contains(ALLOWLIST_KEY)) return true
      return readAllowedPackages(context).contains(packageName)
    }

    private fun readAllowedPackages(context: Context): List<String> {
      if (!prefs(context).contains(ALLOWLIST_KEY)) return emptyList()
      val encoded = getSecret(context, ALLOWLIST_KEY)
      return try {
        val json = JSONArray(encoded)
        buildList {
          for (index in 0 until json.length()) {
            val packageName = json.optString(index, "").trim()
            if (PACKAGE_NAME_PATTERN.matches(packageName)) add(packageName)
          }
        }.distinct()
      } catch (_: Exception) {
        // Corrupt encrypted preferences fail closed for privacy.
        emptyList()
      }
    }

    /** Return only queue entries bound to the currently configured account. */
    fun pendingSnapshot(context: Context): List<JSONObject> {
      synchronized(pendingLock) {
        val owner = prefs(context).getString("configOwner", "") ?: ""
        if (owner.isBlank()) return emptyList()
        val entries = prunePending(context)
        return entries.filter { it.optString("owner") == owner }
      }
    }

    fun configurationOwner(context: Context): String =
      prefs(context).getString("configOwner", "") ?: ""

    /** Add one encrypted queue entry, de-duping updates from Android. */
    fun enqueuePending(context: Context, event: JSONObject): Boolean {
      synchronized(pendingLock) {
        val owner = prefs(context).getString("configOwner", "") ?: ""
        if (owner.isBlank() || getSecret(context, "authToken").isBlank()) return false
        val dedupeKey = event.optString("dedupeKey", "")
        val entries = prunePending(context)
        if (entries.any { it.optString("dedupeKey") == dedupeKey && it.optString("owner") == owner }) {
          return false
        }
        event.put("owner", owner)
        event.put("queuedAt", System.currentTimeMillis())
        event.put("attempts", event.optInt("attempts", 0).coerceAtLeast(0))
        event.put("nextAttemptAt", event.optLong("nextAttemptAt", 0L).coerceAtLeast(0L))
        val owned = entries.filter { it.optString("owner") == owner }.toMutableList()
        while (owned.size >= MAX_PENDING) owned.removeAt(0)
        owned.add(event)
        val otherOwners = entries.filter { it.optString("owner") != owner }
        writePending(context, otherOwners + owned)
        return true
      }
    }

    /** Remove a queue entry after a successful or permanent response. */
    fun removePending(context: Context, dedupeKey: String) {
      synchronized(pendingLock) {
        val owner = prefs(context).getString("configOwner", "") ?: ""
        if (owner.isBlank()) return
        val remaining = prunePending(context).filter {
          it.optString("dedupeKey") != dedupeKey || it.optString("owner") != owner
        }
        writePending(context, remaining)
      }
    }

    /** Persist bounded backoff metadata after transient failure. */
    fun markPendingRetry(context: Context, dedupeKey: String) {
      synchronized(pendingLock) {
        val owner = prefs(context).getString("configOwner", "") ?: ""
        if (owner.isBlank()) return
        val entries = prunePending(context)
        for (entry in entries) {
          if (entry.optString("dedupeKey") != dedupeKey || entry.optString("owner") != owner) continue
          val attempts = (entry.optInt("attempts", 0) + 1).coerceAtMost(8)
          val delayMs = (1L shl attempts.coerceAtMost(6)) * 5_000L
          entry.put("attempts", attempts)
          entry.put("nextAttemptAt", System.currentTimeMillis() + delayMs)
        }
        writePending(context, entries)
      }
    }

    fun clearPending(context: Context) {
      synchronized(pendingLock) {
        prefs(context).edit().remove(PENDING_KEY).commit()
      }
    }

    private fun readPending(context: Context): MutableList<JSONObject> {
      val encoded = getSecret(context, PENDING_KEY)
      if (encoded.isBlank()) return mutableListOf()
      return try {
        val json = JSONArray(encoded)
        buildList {
          for (index in 0 until json.length()) {
            val item = json.optJSONObject(index) ?: continue
            if (item.length() > 0) add(item)
          }
        }.toMutableList()
      } catch (_: Exception) {
        // A corrupt queue should not block future capture or expose partial
        // plaintext; deleting it is the fail-closed recovery path.
        prefs(context).edit().remove(PENDING_KEY).commit()
        mutableListOf()
      }
    }

    /** Keep private previews bounded even when the API is unreachable for days. */
    private fun prunePending(context: Context): MutableList<JSONObject> {
      val cutoff = System.currentTimeMillis() - PENDING_RETENTION_MS
      val entries = readPending(context)
      val fresh = entries.filter { it.optLong("queuedAt", 0L) >= cutoff }.toMutableList()
      if (fresh.size != entries.size) writePending(context, fresh)
      return fresh
    }

    private fun writePending(context: Context, entries: List<JSONObject>) {
      val json = JSONArray()
      entries.takeLast(MAX_PENDING).forEach { json.put(it) }
      putSecretSync(context, PENDING_KEY, json.toString())
    }

    private fun getOrCreateKey(): SecretKey {
      val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
      if (!keyStore.containsAlias(KEY_ALIAS)) {
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
          KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
          )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setUserAuthenticationRequired(false)
            .build(),
        )
        generator.generateKey()
      }
      return keyStore.getKey(KEY_ALIAS, null) as SecretKey
    }

    fun emitPermissionStatus(context: Context) {
      val payload = Arguments.createMap()
      payload.putBoolean("enabled", isEnabled(context))
      reactContext
        ?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        ?.emit("EveNotificationPermissionChanged", payload)
    }

    fun emitNotification(payload: com.facebook.react.bridge.WritableMap) {
      reactContext
        ?.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        ?.emit("EveDeviceNotification", payload)
    }

    private fun isEnabled(context: Context): Boolean {
      val flat = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners")
      val target = ComponentName(context, EveNotificationListenerService::class.java).flattenToString()
      return !TextUtils.isEmpty(flat) && flat.split(":").any { it.equals(target, ignoreCase = true) }
    }
  }

  init {
    bind(context)
  }
}
