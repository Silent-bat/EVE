const {
  createRunOncePlugin,
  withAndroidManifest,
  withDangerousMod,
  withMainApplication,
  withMainActivity,
} = require("@expo/config-plugins");
const fs = require("node:fs");
const path = require("node:path");

const packageName = "com.eve.agent";
const moduleDir = ["app", "src", "main", "java", "com", "eve", "agent"];

function withAndroidNotificationListener(config) {
  config = withMainApplication(config, (app) => {
    if (!app.modResults.contents.includes("import com.eve.agent.EveNotificationListenerPackage")) {
      app.modResults.contents = app.modResults.contents.replace(
        "import com.facebook.react.ReactPackage",
        "import com.facebook.react.ReactPackage\nimport com.eve.agent.EveNotificationListenerPackage",
      );
    }
    if (!app.modResults.contents.includes("EveNotificationListenerPackage()")) {
      app.modResults.contents = app.modResults.contents.replace(
        "PackageList(this).packages",
        "PackageList(this).packages.apply { add(EveNotificationListenerPackage()) }",
      );
    }
    return app;
  });

  config = withMainActivity(config, (activity) => {
    if (!activity.modResults.contents.includes("import com.eve.agent.EveNotificationListenerModule")) {
      activity.modResults.contents = activity.modResults.contents.replace(
        "import android.os.Bundle",
        "import android.os.Bundle\nimport com.eve.agent.EveNotificationListenerModule",
      );
    }
    if (!activity.modResults.contents.includes("emitPermissionStatus(this)")) {
      activity.modResults.contents = activity.modResults.contents.replace(
        /class MainActivity : ReactActivity\(\) \{/,
        "class MainActivity : ReactActivity() {\n  override fun onResume() {\n    super.onResume()\n    EveNotificationListenerModule.emitPermissionStatus(this)\n  }",
      );
    }
    return activity;
  });

  config = withAndroidManifest(config, (manifestConfig) => {
    const manifest = manifestConfig.modResults.manifest;
    const application = manifest.application?.[0];
    if (!application) return manifestConfig;

    application.service = application.service || [];
    if (
      !application.service.some(
        (service) => service.$?.["android:name"] === ".EveNotificationListenerService",
      )
    ) {
      application.service.push({
        $: {
          "android:name": ".EveNotificationListenerService",
          "android:label": "EVE notification access",
          "android:permission": "android.permission.BIND_NOTIFICATION_LISTENER_SERVICE",
          "android:exported": "true",
        },
        "intent-filter": [
          {
            action: [
              {
                $: {
                  "android:name": "android.service.notification.NotificationListenerService",
                },
              },
            ],
          },
        ],
      });
    }
    return manifestConfig;
  });

  config = withDangerousMod(config, [
    "android",
    (modConfig) => {
      const androidRoot = modConfig.modRequest.platformProjectRoot;
      const targetDir = path.join(androidRoot, ...moduleDir);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(targetDir, "EveNotificationListenerModule.kt"), moduleSource(), "utf8");
      fs.writeFileSync(path.join(targetDir, "EveNotificationListenerPackage.kt"), packageSource(), "utf8");
      fs.writeFileSync(path.join(targetDir, "EveNotificationListenerService.kt"), serviceSource(), "utf8");
      return modConfig;
    },
  ]);

  return config;
}

function moduleSource() {
  return `package ${packageName}

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
`;
}

function packageSource() {
  return `package ${packageName}

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class EveNotificationListenerPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
    return listOf(EveNotificationListenerModule(reactContext))
  }

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
    return emptyList()
  }
}
`;
}

function serviceSource() {
  return `package ${packageName}

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
`;
}

module.exports = createRunOncePlugin(
  withAndroidNotificationListener,
  "withAndroidNotificationListener",
  "1.0.0",
);
