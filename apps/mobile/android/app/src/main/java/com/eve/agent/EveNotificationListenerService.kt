package com.eve.agent

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import com.facebook.react.bridge.Arguments
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

class EveNotificationListenerService : NotificationListenerService() {
  override fun onNotificationPosted(sbn: StatusBarNotification) {
    val extras = sbn.notification.extras
    val payload = Arguments.createMap()
    val appName = try {
      packageManager.getApplicationLabel(packageManager.getApplicationInfo(sbn.packageName, 0)).toString()
    } catch (_: Exception) {
      sbn.packageName
    }
    payload.putString("id", sbn.key)
    payload.putString("packageName", sbn.packageName)
    payload.putString("appName", appName)
    payload.putString("title", extras.getCharSequence("android.title")?.toString() ?: "")
    payload.putString("body", extras.getCharSequence("android.text")?.toString() ?: "")
    payload.putDouble("postedAt", sbn.postTime.toDouble())
    EveNotificationListenerModule.emitNotification(payload)
    syncNotification(
      sbn.key,
      sbn.packageName,
      appName,
      extras.getCharSequence("android.title")?.toString() ?: "",
      extras.getCharSequence("android.text")?.toString() ?: "",
      sbn.postTime
    )
  }

  private fun syncNotification(id: String, packageName: String, appName: String, title: String, body: String, postedAt: Long) {
    val prefs = EveNotificationListenerModule.prefs(this)
    val apiUrl = prefs.getString("apiUrl", "") ?: ""
    val authToken = prefs.getString("authToken", "") ?: ""
    if (apiUrl.isBlank() || authToken.isBlank()) return

    Thread {
      try {
        val url = URL(apiUrl.trimEnd('/') + "/v1/device-notifications")
        val connection = url.openConnection() as HttpURLConnection
        connection.requestMethod = "POST"
        connection.setRequestProperty("Content-Type", "application/json")
        connection.setRequestProperty("Authorization", "Bearer " + authToken)
        connection.doOutput = true

        val json = JSONObject()
        json.put("id", id)
        json.put("packageName", packageName)
        json.put("appName", appName)
        json.put("title", title)
        json.put("body", body)
        json.put("postedAt", postedAt)

        OutputStreamWriter(connection.outputStream).use { writer ->
          writer.write(json.toString())
        }
        connection.inputStream.close()
        connection.disconnect()
      } catch (_: Exception) {
      }
    }.start()
  }
}
