import Foundation
import SwiftData
import CryptoKit
import WayPointCore

/// The app keeps one complete workspace per account. The payload preserves
/// legacy fields while the shared schema evolves; no CloudKit store is created.
@Model
final class WorkspaceEnvelope {
    @Attribute(.unique) var accountID: String
    var schemaVersion: Int
    var payload: Data

    init(accountID: String, payload: Data) {
        self.accountID = accountID
        self.schemaVersion = 1
        self.payload = payload
    }
}

enum WorkspaceStoreError: LocalizedError {
    case invalidAccount
    case unsupportedSchema
    case corruptWorkspace

    var errorDescription: String? {
        switch self {
        case .invalidAccount: return "The saved workspace does not belong to this account."
        case .unsupportedSchema: return "This workspace was saved by a different app version. Update WayPoint before opening it."
        case .corruptWorkspace: return "WayPoint could not read the saved workspace. Your saved data has been left in place."
        }
    }
}

@MainActor
final class WorkspaceStore {
    private let container: ModelContainer
    private let context: ModelContext
    private let d1Directory: URL?

    init() throws {
        d1Directory = nil
        let schema = Schema([WorkspaceEnvelope.self])
        let configuration = ModelConfiguration(
            "WayPointOffline", schema: schema,
            isStoredInMemoryOnly: false, groupContainer: .none, cloudKitDatabase: .none
        )
        container = try ModelContainer(for: schema, configurations: [configuration])
        context = ModelContext(container)
        context.autosaveEnabled = false
    }

    /// A separate in-memory container can be supplied by iOS integration tests.
    init(container: ModelContainer, d1Directory: URL? = nil) {
        self.d1Directory = d1Directory
        self.container = container
        context = ModelContext(container)
        context.autosaveEnabled = false
    }

    func load(accountID: String) throws -> LocalWorkspace? {
        guard !accountID.isEmpty else { throw WorkspaceStoreError.invalidAccount }
        guard let row = try envelope(accountID: accountID) else { return nil }
        guard row.schemaVersion == 1 else { throw WorkspaceStoreError.unsupportedSchema }
        let workspace: LocalWorkspace
        do {
            workspace = try JSONDecoder().decode(LocalWorkspace.self, from: row.payload)
        } catch {
            throw WorkspaceStoreError.corruptWorkspace
        }
        try validate(workspace, accountID: accountID)
        return workspace
    }

    func save(_ workspace: LocalWorkspace) throws {
        let accountID = workspace.account.id
        try validate(workspace, accountID: accountID)
        // Encode before changing managed state, so encoding failure cannot leave
        // an incomplete draft to be flushed by a subsequent save.
        let payload = try JSONEncoder().encode(workspace)
        do {
            if let row = try envelope(accountID: accountID) {
                guard row.schemaVersion == 1 else { throw WorkspaceStoreError.unsupportedSchema }
                row.payload = payload
            } else {
                context.insert(WorkspaceEnvelope(accountID: accountID, payload: payload))
            }
            try context.save()
        } catch {
            context.rollback()
            throw error
        }
    }

    func delete(accountID: String) throws {
        guard !accountID.isEmpty else { throw WorkspaceStoreError.invalidAccount }
        do {
            if let row = try envelope(accountID: accountID) {
                context.delete(row)
                try context.save()
            }
        } catch {
            context.rollback()
            throw error
        }
    }

    /// D1 snapshots and their mutation queues use a separate format and namespace.
    /// The original SwiftData workspace remains intact for legacy draft recovery.
    func loadD1<State: Decodable>(accountID: String, as type: State.Type) throws -> State? {
        let url = try d1URL(accountID: accountID)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let data = try Data(contentsOf: url)
        let envelope: D1DiskEnvelope
        do { envelope = try JSONDecoder().decode(D1DiskEnvelope.self, from: data) }
        catch { throw WorkspaceStoreError.corruptWorkspace }
        guard envelope.schemaVersion == 1 else { throw WorkspaceStoreError.unsupportedSchema }
        guard envelope.accountID == accountID,
              envelope.environmentID == WayPointAPI.environmentID else {
            throw WorkspaceStoreError.invalidAccount
        }
        do {
            let value = try JSONDecoder().decode(type, from: envelope.payload)
            if let workspace = value as? D1Workspace, workspace.account.id != accountID {
                throw WorkspaceStoreError.invalidAccount
            }
            return value
        }
        catch { throw WorkspaceStoreError.corruptWorkspace }
    }

    func saveD1<State: Encodable>(_ state: State, accountID: String) throws {
        let url = try d1URL(accountID: accountID)
        if let workspace = state as? D1Workspace, workspace.account.id != accountID {
            throw WorkspaceStoreError.invalidAccount
        }
        let payload = try JSONEncoder().encode(state)
        let envelope = D1DiskEnvelope(schemaVersion: 1, accountID: accountID,
                                      environmentID: WayPointAPI.environmentID, payload: payload)
        let data = try JSONEncoder().encode(envelope)
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutableDirectory = directory
        try mutableDirectory.setResourceValues(values)
        // One atomic document holds both cursor and queue; never advance the cursor
        // independently of its authorized records or acknowledge unsaved writes.
        try data.write(to: url, options: [.atomic, .completeFileProtection])
    }

    private func d1URL(accountID: String) throws -> URL {
        guard !accountID.isEmpty else { throw WorkspaceStoreError.invalidAccount }
        let root = try d1Directory ?? FileManager.default.url(for: .applicationSupportDirectory,
                                               in: .userDomainMask, appropriateFor: nil, create: true)
        let identity = SHA256.hash(data: Data(accountID.utf8)).map { String(format: "%02x", $0) }.joined()
        return root.appendingPathComponent("WayPointD1", isDirectory: true)
            .appendingPathComponent(WayPointAPI.environmentID, isDirectory: true)
            .appendingPathComponent(identity + ".json")
    }

    private func envelope(accountID: String) throws -> WorkspaceEnvelope? {
        var request = FetchDescriptor<WorkspaceEnvelope>(
            predicate: #Predicate { $0.accountID == accountID }
        )
        request.fetchLimit = 2
        let rows = try context.fetch(request)
        guard rows.count <= 1 else { throw WorkspaceStoreError.corruptWorkspace }
        return rows.first
    }

    private func validate(_ workspace: LocalWorkspace, accountID: String) throws {
        guard !accountID.isEmpty, workspace.account.id == accountID,
              workspace.mutations.allSatisfy({ $0.accountID == accountID }) else {
            throw WorkspaceStoreError.invalidAccount
        }
    }
}

private struct D1DiskEnvelope: Codable {
    let schemaVersion: Int
    let accountID: String
    let environmentID: String
    let payload: Data
}
