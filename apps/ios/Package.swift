// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "WayPointCore",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [.library(name: "WayPointCore", targets: ["WayPointCore"])],
    targets: [
        .target(name: "WayPointCore"),
        .testTarget(name: "WayPointCoreTests", dependencies: ["WayPointCore"])
    ]
)
