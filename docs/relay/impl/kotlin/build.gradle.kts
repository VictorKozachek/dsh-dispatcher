plugins {
    kotlin("jvm") version "2.3.21"
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("org.json:json:20240303")
    testImplementation(kotlin("test"))
    testImplementation("junit:junit:4.13.2")
}

kotlin {
    jvmToolchain(21)
}

tasks.test {
    useJUnit()
    testLogging {
        events("passed", "failed", "skipped")
        showStandardStreams = true
    }
}
