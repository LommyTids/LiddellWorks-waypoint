import Foundation

public enum D1EntityKind: String, Codable, CaseIterable, Sendable {
    case trip, destination, activity, transport, accommodation, companion, contact, expense
    var list: String { switch self { case .trip: return "trips"; case .destination: return "destinations"; case .activity: return "activities"; case .companion: return "companions"; case .contact: return "contacts"; case .expense: return "expenses"; default: return rawValue } }
}
public enum D1EntityOperation: String, Codable, Sendable { case upsert, delete }
public struct D1Permission: Codable, Equatable, Sendable {
    public let role: TripRole
    public let companionId: String
    public init(role: TripRole, companionId: String = "") { self.role = role; self.companionId = companionId }
}
public struct D1Entity: Codable, Equatable, Sendable {
    public let tripId: String
    public let kind: D1EntityKind
    public let recordId: String
    public let revision: Int
    public let operation: D1EntityOperation
    public let updatedAt: String
    public let data: [String: JSONValue]?
    public let permission: D1Permission?
    public var key: String { tripId + "|" + kind.rawValue + "|" + recordId }
    public init(tripId: String, kind: D1EntityKind, recordId: String, revision: Int, operation: D1EntityOperation = .upsert, updatedAt: String = "", data: [String: JSONValue]? = nil, permission: D1Permission? = nil) {
        self.tripId = tripId; self.kind = kind; self.recordId = recordId; self.revision = revision
        self.operation = operation; self.updatedAt = updatedAt; self.data = data; self.permission = permission
    }
}
public struct D1BootstrapPage: Codable, Equatable, Sendable {
    public let protocolVersion: Int
    public let entities: [D1Entity]
    public let complete: Bool
    public let nextCursor: String?
    public let syncCursor: String?
}
public struct D1ChangesPage: Codable, Equatable, Sendable {
    public let protocolVersion: Int
    public let entities: [D1Entity]
    public let hasMore: Bool
    public let cursor: String
}
public enum D1MutationOperation: String, Codable, Sendable { case create, update, delete }
/// Immutable once selected for submission. Retry this exact body and mutationId.
public struct D1Mutation: Codable, Equatable, Sendable {
    public let mutationId: String
    public let tripId: String
    public let kind: D1EntityKind
    public let recordId: String
    public let operation: D1MutationOperation
    public let baseRevision: Int
    public let data: [String: JSONValue]?
    public init(mutationId: String = UUID().uuidString, tripId: String, kind: D1EntityKind, recordId: String, operation: D1MutationOperation, baseRevision: Int, data: [String: JSONValue]? = nil) {
        self.mutationId = mutationId; self.tripId = tripId; self.kind = kind; self.recordId = recordId
        self.operation = operation; self.baseRevision = baseRevision; self.data = data
    }
    public var key: String { tripId + "|" + kind.rawValue + "|" + recordId }
}
public struct D1MutationRequest: Codable, Equatable, Sendable {
    public let protocolVersion: Int
    public let mutations: [D1Mutation]
    public init(mutations: [D1Mutation]) { self.protocolVersion = 1; self.mutations = mutations }
}
public struct D1ServerError: Codable, Equatable, Sendable {
    public let code: String
    public let message: String
    public let httpStatus: Int?
}
public struct D1MutationResult: Codable, Equatable, Sendable {
    public let mutationId: String?
    public let status: String
    public let tripId: String?
    public let kind: D1EntityKind?
    public let recordId: String?
    public let revision: Int?
    public let duplicate: Bool?
    public let error: D1ServerError?
}
public struct D1MutationResponse: Codable, Equatable, Sendable {
    public let protocolVersion: Int
    public let results: [D1MutationResult]
}
public enum D1OutboxStatus: String, Codable, Sendable { case queued, submitted, conflict, rejected, quarantined }
public struct D1OutboxEntry: Codable, Equatable, Identifiable, Sendable {
    public var id: UUID { UUID(uuidString: mutation.mutationId) ?? UUID(uuid: (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)) }
    public let accountID: String
    public var mutation: D1Mutation
    public var status: D1OutboxStatus
    public let createdAt: Date
    public var message: String?
    /// Optional for compatibility with caches created before revocation handling.
    public var isQuarantined: Bool? = nil
}
public enum D1SyncError: Error, LocalizedError {
    case invalidResponse, accountMismatch, submittedEdit, incompleteBootstrap, unresolvedConflict
    public var errorDescription: String? {
        switch self {
        case .invalidResponse: return "The sync response is inconsistent. Your saved data has been retained."
        case .accountMismatch: return "This offline cache belongs to another account."
        case .submittedEdit: return "This item is awaiting a sync receipt. Sync first, then save your next change. Your current input is still in the editor."
        case .incompleteBootstrap: return "The trip snapshot is incomplete. Retry sync to download all pages."
        case .unresolvedConflict: return "Review or discard the existing draft before editing this item again."
        }
    }
}

/// Server state and draft state remain distinct. Persist this entire value before
/// sending requests and after applying results; incomplete bootstraps stay outside it.
public struct D1Workspace: Codable, Equatable, Sendable {
    public var account: Account
    public private(set) var entities: [D1Entity]
    public private(set) var outbox: [D1OutboxEntry]
    public private(set) var cursor: String?
    public private(set) var lastRefresh: Date?
    public private(set) var presentationRevision: Int
    public init(account: Account, entities: [D1Entity] = [], outbox: [D1OutboxEntry] = [], cursor: String? = nil) {
        self.account = account; self.entities = entities; self.outbox = outbox; self.cursor = cursor
        self.lastRefresh = nil; self.presentationRevision = 0
    }
    public mutating func publishBootstrap(pages: [D1BootstrapPage], at date: Date = Date()) throws {
        try validateAccount()
        guard !pages.isEmpty, let last = pages.last, last.complete, let sync = last.syncCursor, !sync.isEmpty else { throw D1SyncError.incompleteBootstrap }
        for (index, page) in pages.enumerated() {
            guard page.protocolVersion == 1, page.complete == (index == pages.count - 1),
                  page.complete ? page.nextCursor == nil : (page.nextCursor?.isEmpty == false && page.syncCursor == nil) else { throw D1SyncError.invalidResponse }
        }
        let incoming = pages.flatMap(\.entities)
        try Self.validateEntities(incoming, bootstrap: true)
        let tripIDs = Set(incoming.filter { $0.kind == .trip }.map(\.tripId))
        guard incoming.allSatisfy({ tripIDs.contains($0.tripId) }) else { throw D1SyncError.invalidResponse }
        var next = self
        next.entities = incoming; next.cursor = sync; next.lastRefresh = date
        next.pruneUnauthorizedDrafts(); next.presentationRevision += 1
        self = next
    }
    public mutating func applyChanges(_ page: D1ChangesPage, at date: Date = Date()) throws {
        try validateAccount()
        guard cursor != nil, page.protocolVersion == 1, !page.cursor.isEmpty else { throw D1SyncError.invalidResponse }
        try Self.validateEntities(page.entities, bootstrap: false)
        var next = self
        for incoming in page.entities {
            if let index = next.entities.firstIndex(where: { $0.key == incoming.key }) {
                if incoming.revision < next.entities[index].revision { continue }
                next.entities[index] = incoming
            } else { next.entities.append(incoming) }
            if incoming.kind == .trip && incoming.operation == .delete {
                next.entities.removeAll { $0.tripId == incoming.tripId && $0.kind != .trip }
            }
        }
        next.cursor = page.cursor; next.lastRefresh = date
        next.pruneUnauthorizedDrafts(); next.presentationRevision += 1
        self = next
    }
    public mutating func invalidateAuthorization() {
        entities = []; cursor = nil; lastRefresh = nil; presentationRevision += 1
    }
    public func presentationTrips() throws -> [TripSnapshot] {
        try validateAccount()
        guard cursor != nil else { return [] }
        var visible = entities
        for entry in outbox where entry.status != .rejected && entry.status != .quarantined && entry.isQuarantined != true {
            let m = entry.mutation
            if m.kind == .trip && m.operation == .create && entry.status == .submitted && !entities.contains(where: { $0.key == m.key && $0.operation == .upsert }) { continue }
            if let remoteTrip = entities.first(where: { $0.kind == .trip && $0.tripId == m.tripId }) {
                if remoteTrip.operation == .delete || remoteTrip.permission?.role == .viewer { continue }
                if remoteTrip.permission?.role == .user && !canApplyScoped(m, permission: remoteTrip.permission!) { continue }
            }
            let old = visible.first { $0.key == m.key }
            if m.operation == .delete { visible.removeAll { $0.key == m.key }; continue }
            let entity = D1Entity(tripId: m.tripId, kind: m.kind, recordId: m.recordId,
                                  revision: old?.revision ?? 0, data: (old?.data ?? [:]).merging(m.data ?? [:]) { _, new in new },
                                  permission: old?.permission ?? (m.kind == .trip ? D1Permission(role: .superuser) : nil))
            visible.removeAll { $0.key == m.key }; visible.append(entity)
        }
        let trips: [JSONValue] = visible.filter { $0.kind == .trip && $0.operation == .upsert }.sorted { $0.tripId < $1.tripId }.map { trip in
            var data = trip.data ?? [:]
            data["tripId"] = .string(trip.tripId); data["revision"] = .number(Double(presentationRevision))
            data["myGrant"] = .object(["role": .string((trip.permission?.role ?? .viewer).rawValue), "companionId": .string(trip.permission?.companionId ?? "")])
            for kind in D1EntityKind.allCases where kind != .trip {
                data[kind.list] = .array(visible.filter { $0.tripId == trip.tripId && $0.kind == kind && $0.operation == .upsert }.sorted { $0.recordId < $1.recordId }.map { .object($0.data ?? [:]) })
            }
            return .object(data)
        }
        var result = try LegacyAdapter.decode(JSONEncoder().encode(JSONValue.object(["trips": .array(trips)])))
        for trip in result.indices {
            for index in result[trip].records.indices where result[trip].records[index].kind == .transport {
                result[trip].records[index].title = result[trip].records[index].raw["carrier"]?.text ?? ""
            }
        }
        return result
    }
    public func presentationWorkspace() throws -> LocalWorkspace {
        let trips = try presentationTrips()
        let drafts = outbox.compactMap { entry -> PendingMutation? in
            let kind = RecordKind(rawValue: entry.mutation.kind.rawValue) ?? .destination
            let m = entry.mutation
            let record = entry.isQuarantined == true || entry.status == .quarantined ? nil : trips.first { $0.id == m.tripId }?.records.first { $0.id == m.recordId && $0.kind == kind }
            return PendingMutation(id: entry.id, accountID: account.id, tripID: m.tripId, recordID: m.recordId, kind: kind,
                                   operation: m.operation == .delete ? .delete : .upsert, baseRevision: m.baseRevision,
                                   record: record, createdAt: entry.createdAt,
                                   status: entry.status == .conflict ? .conflict : entry.status == .rejected || entry.status == .quarantined || entry.isQuarantined == true ? .blocked : .queued,
                                   message: entry.message, isLocalCreation: m.operation == .create)
        }
        return LocalWorkspace(account: account, trips: trips, mutations: drafts, lastRefresh: lastRefresh)
    }
    public mutating func stage(_ record: ItineraryRecord) throws {
        // Reuse validated editor rules, while D1 conflict checks use each entity's revision.
        var presentation = try presentationWorkspace(); presentation.mutations = []; try presentation.stage(record)
        let kind = D1EntityKind(rawValue: record.kind.rawValue)!
        let key = record.tripID + "|" + kind.rawValue + "|" + record.id
        let old = entities.first { $0.key == key && $0.operation == .upsert }
        let patch = try D1RecordPatch.make(record, previous: old?.data)
        try enqueue(tripId: record.tripID, kind: kind, recordId: record.id, operation: old == nil ? .create : .update, revision: old?.revision ?? 0, data: patch)
    }
    public mutating func remove(_ record: ItineraryRecord) throws {
        var presentation = try presentationWorkspace(); presentation.mutations = []; try presentation.remove(record)
        let kind = D1EntityKind(rawValue: record.kind.rawValue)!
        let key = record.tripID + "|" + kind.rawValue + "|" + record.id
        if let index = outbox.firstIndex(where: { $0.mutation.key == key }), outbox[index].mutation.operation == .create, outbox[index].status == .queued {
            outbox.remove(at: index); presentationRevision += 1; return
        }
        guard let old = entities.first(where: { $0.key == key && $0.operation == .upsert }) else { throw LocalWorkspaceError.tripUnavailable }
        try enqueue(tripId: record.tripID, kind: kind, recordId: record.id, operation: .delete, revision: old.revision, data: nil)
    }
    @discardableResult public mutating func createTrip(name: String, startDate: String = "", endDate: String = "") throws -> String {
        try validateAccount()
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.count <= 1000 else { throw LocalWorkspaceError.invalidRecord("Enter a trip name (up to 1,000 characters).") }
        // Use editor date validation without inventing timezone conversions.
        var validator = LocalWorkspace(account: account, trips: [TripSnapshot(id: "validation", name: name, role: .superuser)])
        try validator.stage(ItineraryRecord(id: "validation", tripID: "validation", kind: .destination, title: name, start: startDate, end: endDate))
        let id = UUID().uuidString
        try enqueue(tripId: id, kind: .trip, recordId: id, operation: .create, revision: 0,
                    data: ["name": .string(name), "startDate": .string(startDate), "endDate": .string(endDate)])
        return id
    }
    /// Caller MUST save the updated workspace before sending the returned body.
    public mutating func submitNext() throws -> D1Mutation? {
        try validateAccount()
        guard cursor != nil else { throw D1SyncError.incompleteBootstrap }
        if let entry = outbox.first(where: { $0.status == .submitted && ($0.isQuarantined != true || ($0.mutation.kind == .trip && $0.mutation.operation == .create)) }) { return entry.mutation }
        return try submitQueued()
    }
    private mutating func submitQueued() throws -> D1Mutation? {
        for index in outbox.indices where outbox[index].status == .queued {
            let m = outbox[index].mutation
            if m.kind != .trip && outbox.contains(where: { $0.mutation.tripId == m.tripId && $0.mutation.kind == .trip && $0.mutation.operation == .create }) { continue }
            outbox[index].status = .submitted; return m
        }
        return nil
    }
    public mutating func apply(_ response: D1MutationResponse) throws {
        try validateAccount()
        guard response.protocolVersion == 1, !response.results.isEmpty else { throw D1SyncError.invalidResponse }
        var next = self
        var seen = Set<String>()
        for result in response.results {
            guard let id = result.mutationId, seen.insert(id).inserted,
                  let index = next.outbox.firstIndex(where: { $0.mutation.mutationId == id && $0.status == .submitted }) else { throw D1SyncError.invalidResponse }
            let m = next.outbox[index].mutation
            switch result.status {
            case "applied":
                guard result.tripId == m.tripId, result.kind == m.kind, result.recordId == m.recordId, let revision = result.revision, revision == m.baseRevision + 1 else { throw D1SyncError.invalidResponse }
                let old = next.entities.first { $0.key == m.key }
                // Do not overwrite a later server revision downloaded after a lost response.
                if (old?.revision ?? 0) < revision && next.outbox[index].isQuarantined != true {
                    let entity = D1Entity(tripId: m.tripId, kind: m.kind, recordId: m.recordId, revision: revision,
                                          operation: m.operation == .delete ? .delete : .upsert,
                                          data: m.operation == .delete ? nil : (old?.data ?? [:]).merging(m.data ?? [:]) { _, new in new },
                                          permission: old?.permission ?? (m.kind == .trip ? D1Permission(role: .superuser) : nil))
                    next.entities.removeAll { $0.key == m.key }; next.entities.append(entity)
                }
                next.outbox.remove(at: index)
            case "conflict", "rejected":
                guard let error = result.error else { throw D1SyncError.invalidResponse }
                next.outbox[index].status = result.status == "conflict" ? .conflict : .rejected
                next.outbox[index].message = error.message
            default: throw D1SyncError.invalidResponse
            }
        }
        next.pruneUnauthorizedDrafts()
        next.presentationRevision += 1; self = next
    }
    public mutating func discard(id: UUID) throws {
        guard let index = outbox.firstIndex(where: { $0.id == id }) else { return }
        guard outbox[index].status != .submitted || outbox[index].isQuarantined == true else { throw D1SyncError.submittedEdit }
        outbox.remove(at: index); presentationRevision += 1
    }
    /// Explicit user choice only: preserve the patch, assign a new mutation ID,
    /// and bind it to the latest record revision. Never used by automatic refresh.
    public mutating func reapply(id: UUID) throws {
        guard let index = outbox.firstIndex(where: { $0.id == id }), outbox[index].status == .conflict || outbox[index].status == .rejected || outbox[index].status == .quarantined else { throw D1SyncError.unresolvedConflict }
        let old = outbox[index].mutation
        let remote = entities.first(where: { $0.key == old.key && $0.operation == .upsert })
        guard let trip = entities.first(where: { $0.tripId == old.tripId && $0.kind == .trip && $0.operation == .upsert }), let permission = trip.permission, permission.role.canEdit else { throw LocalWorkspaceError.readOnly }
        if old.operation == .create && remote == nil {
            guard !entities.contains(where: { $0.key == old.key && $0.operation == .delete }) else { throw LocalWorkspaceError.invalidRecord("This identifier was deleted on the server. Create a new item instead of reusing it.") }
            guard permission.role == .superuser || permission.role == .admin else { throw LocalWorkspaceError.scopedPermission }
            outbox[index].mutation = D1Mutation(tripId: old.tripId, kind: old.kind, recordId: old.recordId, operation: .create, baseRevision: 0, data: old.data)
            outbox[index].status = .queued; outbox[index].isQuarantined = nil; outbox[index].message = nil; presentationRevision += 1
            return
        }
        guard let remote else { throw LocalWorkspaceError.tripUnavailable }
        if permission.role == .user {
            guard old.kind != .trip, old.operation != .delete, case .array(let tags)? = remote.data?["companions"], tags.contains(.string(permission.companionId)), old.data?["companions"] == nil || old.data?["companions"] == remote.data?["companions"] else { throw LocalWorkspaceError.scopedPermission }
        }
        outbox[index].mutation = D1Mutation(tripId: old.tripId, kind: old.kind, recordId: old.recordId, operation: old.operation == .create ? .update : old.operation, baseRevision: remote.revision, data: old.data)
        outbox[index].status = .queued; outbox[index].message = nil; outbox[index].isQuarantined = nil; presentationRevision += 1
    }
    private mutating func enqueue(tripId: String, kind: D1EntityKind, recordId: String, operation: D1MutationOperation, revision: Int, data: [String: JSONValue]?) throws {
        try validateAccount()
        let key = tripId + "|" + kind.rawValue + "|" + recordId
        if let index = outbox.firstIndex(where: { $0.mutation.key == key }) {
            guard outbox[index].status != .submitted else { throw D1SyncError.submittedEdit }
            guard outbox[index].status == .queued else { throw D1SyncError.unresolvedConflict }
            let old = outbox[index].mutation
            outbox[index].mutation = D1Mutation(mutationId: old.mutationId, tripId: tripId, kind: kind, recordId: recordId,
                                                operation: old.operation == .create ? .create : operation, baseRevision: old.baseRevision,
                                                data: operation == .delete ? nil : data)
        } else {
            outbox.append(D1OutboxEntry(accountID: account.id, mutation: D1Mutation(tripId: tripId, kind: kind, recordId: recordId, operation: operation, baseRevision: revision, data: data), status: .queued, createdAt: Date()))
        }
        presentationRevision += 1
    }
    private mutating func pruneUnauthorizedDrafts() {
        let pending = outbox
        for index in outbox.indices {
            let m = outbox[index].mutation
            let trip = entities.first { $0.kind == .trip && $0.tripId == m.tripId && $0.operation == .upsert }
            // A never-submitted local trip and its child drafts have not yet been
            // represented in a server snapshot; they remain valid offline work.
            let localTrip = pending.first { $0.mutation.kind == .trip && $0.mutation.operation == .create && $0.mutation.tripId == m.tripId && ($0.status == .queued || $0.status == .submitted) }
            let locallyCreated = trip == nil && localTrip != nil && !entities.contains { $0.kind == .trip && $0.tripId == m.tripId }
            let authorized: Bool
            // A lost trip-create receipt may be retried exactly even when no row
            // was ever committed; do not synthesize its permissions in the UI.
            if m.kind == .trip && m.operation == .create && outbox[index].status == .submitted {
                outbox[index].isQuarantined = trip == nil || trip?.permission?.role == .viewer || trip?.permission?.role == .user
                continue
            }
            else if locallyCreated { authorized = true }
            else if let permission = trip?.permission {
                authorized = permission.role == .superuser || permission.role == .admin || (permission.role == .user && canApplyScoped(m, permission: permission))
            } else { authorized = false }
            if !authorized {
                outbox[index].isQuarantined = true
                if outbox[index].status != .submitted { outbox[index].status = .quarantined }
                outbox[index].message = "This draft is retained privately, but current sharing permissions prevent displaying or syncing it."
                continue
            }
            // Only frozen submissions may resume automatically after permission
            // returns. Unsent quarantined drafts require explicit user review.
            if outbox[index].status == .submitted { outbox[index].isQuarantined = nil; continue }
            if outbox[index].status == .quarantined { continue }
            if m.operation != .create, let remote = entities.first(where: { $0.key == m.key }), remote.revision != m.baseRevision || remote.operation == .delete {
                outbox[index].status = .conflict; outbox[index].message = "This item changed on another device. Review both versions."
            }
        }
    }
    private func canApplyScoped(_ mutation: D1Mutation, permission: D1Permission) -> Bool {
        guard RecordKind(rawValue: mutation.kind.rawValue) != nil, mutation.operation == .update,
              let record = entities.first(where: { $0.key == mutation.key && $0.operation == .upsert }),
              case .array(let tags)? = record.data?["companions"], tags.contains(.string(permission.companionId)) else { return false }
        return mutation.data?["companions"] == nil || mutation.data?["companions"] == record.data?["companions"]
    }
    private func validateAccount() throws {
        guard !account.id.isEmpty, outbox.allSatisfy({ $0.accountID == account.id && UUID(uuidString: $0.mutation.mutationId) != nil }) else { throw D1SyncError.accountMismatch }
        guard Set(outbox.map { $0.mutation.key }).count == outbox.count else { throw D1SyncError.invalidResponse }
        try Self.validateEntities(entities, bootstrap: false)
        for entry in outbox {
            let m = entry.mutation
            guard JSONValue.string(m.tripId).identifier != nil, JSONValue.string(m.recordId).identifier != nil, m.baseRevision >= 0,
                  m.operation == .create ? m.baseRevision == 0 : m.baseRevision > 0,
                  m.kind != .trip || m.tripId == m.recordId, m.operation == .delete ? m.data == nil : m.data != nil else { throw D1SyncError.invalidResponse }
        }
    }
    private static func validateEntities(_ values: [D1Entity], bootstrap: Bool) throws {
        var keys = Set<String>()
        for entity in values {
            guard JSONValue.string(entity.tripId).identifier != nil, JSONValue.string(entity.recordId).identifier != nil,
                  entity.revision > 0, entity.revision <= 9_007_199_254_740_991,
                  entity.kind != .trip || entity.recordId == entity.tripId,
                  !bootstrap || (entity.operation == .upsert && keys.insert(entity.key).inserted),
                  entity.operation == .delete || entity.data != nil,
                  entity.kind != .trip || entity.operation == .delete || entity.permission != nil else { throw D1SyncError.invalidResponse }
            if entity.kind != .trip, entity.operation == .upsert {
                guard entity.data?[entity.kind.rawValue + "Id"]?.identifier == entity.recordId else { throw D1SyncError.invalidResponse }
            }
        }
    }
}
