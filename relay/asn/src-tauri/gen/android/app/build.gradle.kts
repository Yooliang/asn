import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// 發行管道：play（預設，Google Play 版，不含自動更新與安裝權限）／sideload（官網下載的自行安裝版，帶自動更新）。
// 建置時用環境變數 ORG_GRADLE_PROJECT_asnDist=sideload 指定（同時 Rust 要帶 --features sideload）；見 docs/design/ANDROID.md
val asnDist = (findProperty("asnDist") as String?) ?: "play"
require(asnDist == "play" || asnDist == "sideload") { "asnDist 只能是 play 或 sideload" }

android {
    compileSdk = 36
    sourceSets.getByName("main").java.srcDir("src/$asnDist/java")
    namespace = "tw.yooliang.asn"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        manifestPlaceholders["installPermission"] = if (asnDist == "sideload") "android.permission.REQUEST_INSTALL_PACKAGES" else "android.permission.INTERNET"
        applicationId = "tw.yooliang.asn"
        minSdk = 26
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    // 查看電腦終端前的本人確認（生物辨識或螢幕鎖）。鎖死版本
    implementation("androidx.biometric:biometric:1.1.0")
    // 指紋掃 QR code（FingerprintScanActivity）：相機預覽與 QR 解碼。只用它的相機畫面元件，不用它內建的 CaptureActivity（清單裡移除）。版本鎖死
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    // 解碼核心明確升到 3.5.4（函式庫預設帶的版本較舊）。minSdk 26 高於 24，依函式庫說明可以這樣覆蓋；CI 會檢查最後解析出來是 3.5.4
    implementation("com.google.zxing:core:3.5.4")
    // 推播（#797，FCM）。服務帳戶金鑰絕不進 APK；google-services.json 只有公開的設定值，也不進 repo（見下方 apply 條件）
    implementation(platform("com.google.firebase:firebase-bom:34.0.0"))
    implementation("com.google.firebase:firebase-messaging")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))

// google-services 外掛只在 google-services.json 存在時才套用：沒放這個檔的建置（CI、一般開發者）照樣建得過，只是 Firebase 不啟動、推播不啟用。
// 這個檔放在建置機的 app/ 底下（比照簽章檔，不進 repo、不進 APK 以外的任何地方）；它只有公開的專案設定值，**不是**服務帳戶金鑰（金鑰只在後台的環境變數）
if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
} else {
    // 安靜跳過會在不知情時發出沒有推播的版本：在建置記錄印一行明顯的警告（CI 本來就沒有這個檔，照樣建得過）
    logger.warn("⚠ 沒有 app/google-services.json：這次建出的 App 不含推播（Firebase 不啟動，App 關著時收不到通知）")
}
