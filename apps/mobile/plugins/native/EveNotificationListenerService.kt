package com.eve.agent

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import com.facebook.react.bridge.Arguments
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONObject

class EveNotificationListenerService : NotificationListenerService() {
  companion object {
    private const val TAG = "EveNotificationListener"
    private const val QUEUE_CAPACITY = 64
    private const val DROP_LOG_INTERVAL_MS = 60_000L
    private const val DRAIN_INTERVAL_SECONDS = 30L
  }

  private val queue = ThreadPoolExecutor(
    1,
    1,
    30L,
    TimeUnit.SECONDS,
    ArrayBlockingQueue(QUEUE_CAPACITY),
    // Never silently discard an already-queued notification. The catch below
    // removes the current dedupe key and records an explicit, observable drop.
    ThreadPoolExecutor.AbortPolicy(),
  )
  private val scheduler: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()
  private val submitted = ConcurrentHashMap.newKeySet<String>()
  private var droppedSinceLog = 0
  private var lastDropLogAt = 0L

  override fun onCreate() {
    super.onCreate()
    try {
      drainPending()
    } catch (_: Exception) {
      // A broken local queue must not stop Android from binding the listener.
    }
    scheduler.scheduleWithFixedDelay(
      {
        try {
          drainPending()
        } catch (_: Exception) {
          // Keep the periodic drain alive after a transient keystore or
          // preference failure; the next tick can recover without logging
          // notification contents.
        }
      },
      DRAIN_INTERVAL_SECONDS,
      DRAIN_INTERVAL_SECONDS,
      TimeUnit.SECONDS,
    )
  }

  override fun onNotificationPosted(sbn: StatusBarNotification) {
    try {
      handleNotification(sbn)
    } catch (_: Exception) {
      // A malformed parcel or keystore failure must not take down the system
      // listener; the next notification can still be processed.
    }
  }

  private fun handleNotification(sbn: StatusBarNotification) {
    // Notification access is global at the Android level. Apply EVE's own
    // package filter before reading extras or emitting to JS, so an app the
    // user did not select never enters memory, logs, or the upload queue.
    if (!EveNotificationListenerModule.isPackageAllowed(this, sbn.packageName)) return
    val extras = sbn.notification.extras
    val payload = Arguments.createMap()
    val appName = try {
      packageManager.getApplicationLabel(packageManager.getApplicationInfo(sbn.packageName, 0)).toString()
    } catch (_: Exception) {
      sbn.packageName
    }
    val id = sbn.key.take(160)
    val title = (extras.getCharSequence("android.title")?.toString() ?: "").take(240)
    val body = (extras.getCharSequence("android.text")?.toString() ?: "").take(2_000)
    if (title.isBlank() && body.isBlank()) return
    val boundedAppName = appName.take(120)
    payload.putString("id", id)
    payload.putString("packageName", sbn.packageName)
    payload.putString("appName", boundedAppName)
    payload.putString("title", title)
    payload.putString("body", body)
    payload.putDouble("postedAt", sbn.postTime.toDouble())
    EveNotificationListenerModule.emitNotification(payload)
    // Notification listeners can deliver the same key repeatedly while an app
    // updates its progress text. Keep one bounded in-flight job per event.
    val dedupeKey = "$id:${sbn.postTime}:$title:$body"
    if (!submitted.add(dedupeKey)) return
    if (submitted.size > 256) {
      submitted.iterator().let { if (it.hasNext()) submitted.remove(it.next()) }
    }
    val event = JSONObject()
      .put("id", id)
      .put("packageName", sbn.packageName.take(120))
      .put("appName", boundedAppName)
      .put("title", title)
      .put("body", body)
      .put("postedAt", sbn.postTime)
      .put("dedupeKey", dedupeKey)
    // Write before scheduling. If Android kills this service after the
    // callback returns, the next instance can drain the encrypted queue.
    val queued = EveNotificationListenerModule.enqueuePending(this, event)
    if (queued) schedule(event)
    else submitted.remove(dedupeKey)
  }

  private fun schedule(event: JSONObject) {
    val dedupeKey = event.optString("dedupeKey", "")
    if (dedupeKey.isBlank()) return
    try {
      queue.execute {
        try {
          processPending(event)
        } finally {
          submitted.remove(dedupeKey)
        }
      }
    } catch (_: RejectedExecutionException) {
      submitted.remove(dedupeKey)
      recordQueueDrop()
    } catch (_: Exception) {
      submitted.remove(dedupeKey)
    }
  }

  private fun drainPending() {
    val now = System.currentTimeMillis()
    EveNotificationListenerModule.pendingSnapshot(this).forEach { event ->
      if (!EveNotificationListenerModule.isPackageAllowed(this, event.optString("packageName", ""))) {
        EveNotificationListenerModule.removePending(this, event.optString("dedupeKey", ""))
        return@forEach
      }
      if (event.optLong("nextAttemptAt", 0L) > now) return@forEach
      val dedupeKey = event.optString("dedupeKey", "")
      if (dedupeKey.isNotEmpty() && submitted.add(dedupeKey)) schedule(event)
    }
  }

  private fun processPending(event: JSONObject) {
    val dedupeKey = event.optString("dedupeKey", "")
    if (dedupeKey.isBlank()) return
    if (!EveNotificationListenerModule.isPackageAllowed(this, event.optString("packageName", ""))) {
      EveNotificationListenerModule.removePending(this, dedupeKey)
      return
    }
    // A logout/login or token rotation can happen while a worker is waiting
    // in the queue. Never send a preview captured under the previous owner.
    if (event.optString("owner", "") != EveNotificationListenerModule.configurationOwner(this)) {
      EveNotificationListenerModule.removePending(this, dedupeKey)
      return
    }
    when (syncNotification(event)) {
      SyncResult.DELIVERED,
      SyncResult.PERMANENT_FAILURE -> EveNotificationListenerModule.removePending(this, dedupeKey)
      SyncResult.TRANSIENT_FAILURE -> EveNotificationListenerModule.markPendingRetry(this, dedupeKey)
    }
  }

  private enum class SyncResult { DELIVERED, PERMANENT_FAILURE, TRANSIENT_FAILURE }

  /** Log queue pressure without writing notification contents to logcat. */
  @Synchronized
  private fun recordQueueDrop() {
    droppedSinceLog += 1
    val now = System.currentTimeMillis()
    if (now - lastDropLogAt >= DROP_LOG_INTERVAL_MS) {
      Log.w(TAG, "notification sync queue full; dropped $droppedSinceLog event(s)")
      droppedSinceLog = 0
      lastDropLogAt = now
    }
  }

  private fun syncNotification(event: JSONObject): SyncResult {
    val prefs = EveNotificationListenerModule.prefs(this)
    val apiUrl = prefs.getString("apiUrl", "") ?: ""
    val authToken = EveNotificationListenerModule.getSecret(this, "authToken")
    if (apiUrl.isBlank() || authToken.isBlank()) return SyncResult.TRANSIENT_FAILURE
    val owner = prefs.getString("configOwner", "") ?: ""
    if (owner.isBlank() || event.optString("owner", "") != owner ||
      EveNotificationListenerModule.tokenFingerprint(authToken) != owner) {
      return SyncResult.PERMANENT_FAILURE
    }
    val parsed = try { URL(apiUrl) } catch (_: Exception) { return SyncResult.PERMANENT_FAILURE }
    val allowedProtocol = parsed.protocol == "https" || (BuildConfig.DEBUG && parsed.protocol == "http")
    if (!allowedProtocol || parsed.userInfo != null || parsed.query != null || parsed.ref != null) {
      return SyncResult.PERMANENT_FAILURE
    }

    val json = JSONObject()
    json.put("id", event.optString("id", ""))
    json.put("packageName", event.optString("packageName", ""))
    json.put("appName", event.optString("appName", ""))
    json.put("title", event.optString("title", ""))
    json.put("body", event.optString("body", ""))
    json.put("postedAt", event.optLong("postedAt", System.currentTimeMillis()))
    val id = event.optString("id", "")

    repeat(2) { attempt ->
      var connection: HttpURLConnection? = null
      try {
        connection = (URL(apiUrl.trimEnd('/') + "/v1/device-notifications").openConnection() as HttpURLConnection).apply {
          requestMethod = "POST"
          connectTimeout = 5_000
          readTimeout = 5_000
          useCaches = false
          doOutput = true
          setRequestProperty("Content-Type", "application/json")
          setRequestProperty("Authorization", "Bearer $authToken")
          setRequestProperty("Idempotency-Key", id)
        }
        OutputStreamWriter(connection.outputStream, Charsets.UTF_8).use { writer -> writer.write(json.toString()) }
        val code = connection.responseCode
        (if (code in 200..299) connection.inputStream else connection.errorStream)?.close()
        if (code in 200..299) return SyncResult.DELIVERED
        // Validation/auth failures are not fixed by retrying the same private
        // payload.  408/425/429 are explicitly transient; retain everything
        // else in the encrypted queue for the next bounded backoff window.
        if (code in 400..499 && code !in setOf(408, 425, 429)) return SyncResult.PERMANENT_FAILURE
      } catch (_: Exception) {
        // Retry one transient/network failure below.
      } finally {
        connection?.disconnect()
      }
      if (attempt == 0) Thread.sleep(250)
    }
    return SyncResult.TRANSIENT_FAILURE
  }

  override fun onDestroy() {
    scheduler.shutdownNow()
    queue.shutdownNow()
    super.onDestroy()
  }
}
