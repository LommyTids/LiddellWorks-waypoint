import XCTest
import Foundation
import SwiftData
import WayPointCore
@testable import WayPoint

@MainActor
final class WorkspaceStoreTests: XCTestCase {
    func testD1RoundTripPreservesLegacyWorkspaceAndIsolatesAccount() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let schema = Schema([WorkspaceEnvelope.self])
        let configuration = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)
        let container = try ModelContainer(for: schema, configurations: [configuration])
        let store = WorkspaceStore(container: container, d1Directory: directory)
        let account = Account(id: "test-account", username: "Tester")
        let legacy = LocalWorkspace(account: account, trips: [], mutations: [], lastRefresh: nil)
        try store.save(legacy)
        let state = D1Workspace(account: account, cursor: "test-signed-cursor")
        try store.saveD1(state, accountID: account.id)
        let reopened = WorkspaceStore(container: container, d1Directory: directory)
        XCTAssertEqual(try reopened.loadD1(accountID: account.id, as: D1Workspace.self), state)
        XCTAssertEqual(try reopened.load(accountID: account.id)?.account.id, account.id)
        XCTAssertNil(try reopened.loadD1(accountID: "different-account", as: D1Workspace.self))
        XCTAssertThrowsError(try reopened.saveD1(state, accountID: "different-account"))
    }

    func testLegacyLookupUpdateAndDeleteKeepOtherAccountsIntact() throws {
        let schema = Schema([WorkspaceEnvelope.self])
        let configuration = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)
        let container = try ModelContainer(for: schema, configurations: [configuration])
        let store = WorkspaceStore(container: container)
        for id in ["first", "second", "third"] {
            let account = Account(id: id, username: id)
            try store.save(LocalWorkspace(account: account, trips: [], mutations: [], lastRefresh: nil))
        }
        XCTAssertEqual(try store.load(accountID: "third")?.account.id, "third")
        XCTAssertNil(try store.load(accountID: "unknown"))
        let updated = LocalWorkspace(account: Account(id: "third", username: "Updated"),
                                     trips: [], mutations: [], lastRefresh: nil)
        try store.save(updated)
        XCTAssertEqual(try store.load(accountID: "third")?.account.username, "Updated")
        try store.delete(accountID: "third")
        XCTAssertNil(try store.load(accountID: "third"))
        for id in ["first", "second"] {
            XCTAssertEqual(try store.load(accountID: id)?.account.username, id)
        }
    }

    func testCorruptD1FileIsRetainedForRecovery() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let schema = Schema([WorkspaceEnvelope.self])
        let configuration = ModelConfiguration(schema: schema, isStoredInMemoryOnly: true)
        let container = try ModelContainer(for: schema, configurations: [configuration])
        let store = WorkspaceStore(container: container, d1Directory: directory)
        let account = Account(id: "test-account", username: "Tester")
        try store.saveD1(D1Workspace(account: account), accountID: account.id)
        let enumerator = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil)!
        let file = try XCTUnwrap(enumerator.allObjects.compactMap { $0 as? URL }.first { $0.pathExtension == "json" })
        let corrupt = Data("truncated workspace".utf8)
        try corrupt.write(to: file)
        XCTAssertThrowsError(try store.loadD1(accountID: account.id, as: D1Workspace.self))
        XCTAssertEqual(try Data(contentsOf: file), corrupt)
    }
}
