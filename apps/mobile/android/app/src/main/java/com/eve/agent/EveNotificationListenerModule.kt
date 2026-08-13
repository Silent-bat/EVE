package com.eve.agent

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.provider.Settings
import android.text.TextUtils
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

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
    prefs(context).edit()
      .putString("apiUrl", apiUrl)
      .putString("authToken", authToken)
      .apply()
  }

  @ReactMethod
  fun addListener(eventName: String) {
  }

  @ReactMethod
  fun removeListeners(count: Int) {
  }

  companion object {
    private var reactContext: ReactApplicationContext? = null

    fun bind(context: ReactApplicationContext) {
      reactContext = context
    }

    fun prefs(context: Context): SharedPreferences {
      return context.getSharedPreferences("eve_notification_listener", Context.MODE_PRIVATE)
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
