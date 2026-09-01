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
const nativeTemplateDir = path.join(__dirname, "native");
const nativeSources = [
  "EveNotificationListenerModule.kt",
  "EveNotificationListenerPackage.kt",
  "EveNotificationListenerService.kt",
];

function withAndroidNotificationListener(config) {
  config = withMainApplication(config, (app) => {
    if (!app.modResults.contents.includes(`import ${packageName}.EveNotificationListenerPackage`)) {
      app.modResults.contents = app.modResults.contents.replace(
        "import com.facebook.react.ReactPackage",
        `import com.facebook.react.ReactPackage\nimport ${packageName}.EveNotificationListenerPackage`,
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
    if (!activity.modResults.contents.includes(`import ${packageName}.EveNotificationListenerModule`)) {
      activity.modResults.contents = activity.modResults.contents.replace(
        "import android.os.Bundle",
        `import android.os.Bundle\nimport ${packageName}.EveNotificationListenerModule`,
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
      for (const filename of nativeSources) {
        const source = path.join(nativeTemplateDir, filename);
        if (!fs.existsSync(source)) {
          throw new Error(`Missing native notification listener template: ${source}`);
        }
        fs.copyFileSync(source, path.join(targetDir, filename));
      }
      return modConfig;
    },
  ]);

  return config;
}

module.exports = createRunOncePlugin(
  withAndroidNotificationListener,
  "withAndroidNotificationListener",
  "1.1.0",
);
