// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "RelayCrypto",
    platforms: [.macOS(.v13)],
    targets: [
        .target(name: "RelayCrypto"),
        .testTarget(name: "RelayCryptoTests", dependencies: ["RelayCrypto"]),
    ]
)
