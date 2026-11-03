// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "RelayClient",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "RelayKit", targets: ["RelayKit"]),
        .executable(name: "RelayApp", targets: ["RelayApp"]),
    ],
    targets: [
        .target(name: "RelayKit"),
        .executableTarget(name: "RelayApp", dependencies: ["RelayKit"]),
        .testTarget(name: "RelayKitTests", dependencies: ["RelayKit"]),
    ],
    swiftLanguageModes: [.v6]
)
