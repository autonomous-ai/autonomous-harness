import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// The Google Play upload key, read from OUTSIDE this repo — it is public, and the key and its
// passwords live in ~/.android-release/ on the release Mac the way the App Store Connect key lives in
// ~/.appstoreconnect/ (see mobile/RELEASE.md). HARNESS_ANDROID_SIGNING points elsewhere, for CI.
//
// ⚠️ Without it a release build falls back to the DEBUG key, so `flutter run --release` keeps working
// on every other machine. Play refuses a debug-signed bundle at upload, and
// scripts/release-android.sh refuses to build one in the first place.
val uploadKeyFile = file(
    System.getenv("HARNESS_ANDROID_SIGNING")
        ?: "${System.getProperty("user.home")}/.android-release/harness-upload.properties",
)
val uploadKey = Properties().apply {
    if (uploadKeyFile.exists()) uploadKeyFile.inputStream().use { load(it) }
}

android {
    namespace = "ai.autonomous.harness.android"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // ⚠️ Permanent: Play keys the app on this id, and it cannot change after the first upload.
        // Mirrors the iOS bundle id, ai.autonomous.harness.ios.
        applicationId = "ai.autonomous.harness.android"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        // Both from `version:` in pubspec.yaml — the same `+N` the iOS builds carry, which Play also
        // needs to rise with every upload.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (uploadKeyFile.exists()) {
            create("upload") {
                storeFile = file(uploadKey.getProperty("storeFile"))
                storePassword = uploadKey.getProperty("storePassword")
                keyAlias = uploadKey.getProperty("keyAlias")
                keyPassword = uploadKey.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.findByName("upload") ?: signingConfigs.getByName("debug")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
